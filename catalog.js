/**
 * Runtime price catalog.
 *
 * Bootstraps synchronously (bundled models.dev snapshot + official CNY table,
 * then the on-disk cache from a previous run) so any projection view always
 * has prices to apply, then refreshes in the background from the two
 * authoritative sources and rewrites the cache atomically.
 *
 * The fold never sees prices; only `viewCost` does, which is what keeps price
 * changes out of persisted projection state.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OFFICIAL_CNY,
  PRICE_AS_OF_CNY,
  PRICE_AS_OF_USD,
  CN_HOLIDAY_COVERAGE_END,
  isOfficialFamily,
  modelsDevProvider,
  resolveOfficialRow,
} from './pricing.js';

const OFFICIAL_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 25000;

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh');
}

function cacheFile() {
  return path.join(dshHome(), 'cache', 'session-cost', 'catalog.json');
}

/** One validated official CNY table, or null when the shape is not trustworthy. */
function sanitizeOfficial(value) {
  if (value === null || typeof value !== 'object') return null;
  const result = {};
  const numeric = (buckets) =>
    buckets !== null && typeof buckets === 'object'
    && ['input', 'output', 'cacheRead', 'cacheWrite'].every((field) => Number.isFinite(buckets[field]) && buckets[field] >= 0);
  for (const [model, entry] of Object.entries(value)) {
    if (entry === null || typeof entry !== 'object') return null;
    if (!numeric(entry.peak) || !numeric(entry.off)) return null;
    result[model] = {
      peak: { input: entry.peak.input, output: entry.peak.output, cacheRead: entry.peak.cacheRead, cacheWrite: entry.peak.cacheWrite },
      off: { input: entry.off.input, output: entry.off.output, cacheRead: entry.off.cacheRead, cacheWrite: entry.off.cacheWrite },
    };
  }
  return Object.keys(result).length === 0 ? null : result;
}

/** One validated already-reduced table (`{provider:{model:{input,output,cache_read,cache_write}}}`), or null. */
function sanitizeReduced(value) {
  if (value === null || typeof value !== 'object') return null;
  const result = {};
  let count = 0;
  for (const [providerId, table] of Object.entries(value)) {
    if (table === null || typeof table !== 'object') return null;
    const models = {};
    for (const [modelId, cost] of Object.entries(table)) {
      if (cost === null || typeof cost !== 'object') return null;
      if (!Number.isFinite(cost.input) || !Number.isFinite(cost.output)) return null;
      models[modelId] = {
        input: cost.input,
        output: cost.output,
        cache_read: Number.isFinite(cost.cache_read) ? cost.cache_read : 0,
        cache_write: Number.isFinite(cost.cache_write) ? cost.cache_write : 0,
      };
      count += 1;
    }
    result[providerId] = models;
  }
  return count > 0 ? result : null;
}

/** Reduce one models.dev payload into the compact price table used at view time. */
function reduceModelsDev(body) {
  if (body === null || typeof body !== 'object') return null;
  const result = {};
  let count = 0;
  for (const [providerId, provider] of Object.entries(body)) {
    const models = provider?.models;
    if (models === null || typeof models !== 'object') continue;
    const table = {};
    for (const [modelId, model] of Object.entries(models)) {
      if (model?.status === 'deprecated') continue;
      const cost = model?.cost;
      if (cost === null || typeof cost !== 'object') continue;
      if (!Number.isFinite(cost.input) || !Number.isFinite(cost.output)) continue;
      table[modelId] = {
        input: cost.input,
        output: cost.output,
        cache_read: Number.isFinite(cost.cache_read) ? cost.cache_read : 0,
        cache_write: Number.isFinite(cost.cache_write) ? cost.cache_write : 0,
      };
      count += 1;
    }
    if (Object.keys(table).length > 0) result[providerId] = table;
  }
  return count > 0 ? result : null;
}

function stripTags(cell) {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function parsePrice(cell) {
  const match = /([0-9]+(?:\.[0-9]+)?)/.exec(cell ?? '');
  return match === null ? null : Number(match[1]);
}

function todayInBeijing() {
  const now = new Date(Date.now() + 8 * 3600000);
  const pad = (value) => (value < 10 ? `0${value}` : String(value));
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

function buildOfficialRows(rows, modelIds) {
  const tiers = modelIds.map(() => ({
    peak: { input: null, output: null, cacheRead: null, cacheWrite: 0 },
    off: { input: null, output: null, cacheRead: null, cacheWrite: 0 },
  }));
  // The page renders one metric over two rows (off-peak, then peak), with the
  // metric label only on the first of the pair, so it is carried forward.
  let field = null;
  for (const cells of rows) {
    const tierIndex = cells.findIndex((cell) => cell === '空闲时段' || cell === '高峰时段');
    if (tierIndex < 0) continue;
    for (let index = 0; index < tierIndex; index += 1) {
      const cell = cells[index];
      if (cell.includes('缓存未命中')) field = 'input';
      else if (cell.includes('缓存命中')) field = 'cacheRead';
      else if (cell.includes('输出')) field = 'output';
    }
    if (field === null) return null;
    const tierKey = cells[tierIndex] === '高峰时段' ? 'peak' : 'off';
    const prices = cells.slice(tierIndex + 1);
    if (prices.length !== modelIds.length) return null;
    for (let index = 0; index < modelIds.length; index += 1) {
      const price = parsePrice(prices[index]);
      if (price === null) return null;
      tiers[index][tierKey][field] = price;
    }
  }
  const result = {};
  for (let index = 0; index < modelIds.length; index += 1) {
    const entry = tiers[index];
    for (const tier of ['peak', 'off']) {
      const bucket = entry[tier];
      if (!Number.isFinite(bucket.input) || !Number.isFinite(bucket.output) || !Number.isFinite(bucket.cacheRead)) return null;
    }
    // Official footnote: off-peak is half of peak. Refuse a table that disagrees.
    if (Math.abs(entry.off.input * 2 - entry.peak.input) > 1e-9) return null;
    if (Math.abs(entry.off.output * 2 - entry.peak.output) > 1e-9) return null;
    if (Math.abs(entry.off.cacheRead * 2 - entry.peak.cacheRead) > 1e-9) return null;
    result[modelIds[index]] = { peak: entry.peak, off: entry.off };
  }
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * Parse the official Chinese pricing table into the internal CNY shape.
 * Fails closed (returns null) on any structural surprise, so a redesigned page
 * keeps the last known table instead of inventing numbers.
 * @param html - the pricing page document.
 * @returns `{ rows, asOf }` or null.
 */
export function parseOfficialPricing(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const table of tables) {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((row) =>
      [...row[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => stripTags(cell[1])),
    );
    const header = rows.find((cells) => cells[0] === '模型');
    if (header === undefined) continue;
    const modelIds = header
      .slice(1)
      .map((cell) => cell.replace(/\([0-9]+\)/g, '').trim())
      .filter((cell) => cell.length > 0);
    if (modelIds.length === 0) continue;
    const built = buildOfficialRows(rows, modelIds);
    if (built === null) continue;
    return { rows: built, asOf: todayInBeijing() };
  }
  return null;
}

function readSeed() {
  try {
    const url = new URL('./seed-prices.json', import.meta.url);
    return sanitizeReduced(JSON.parse(fs.readFileSync(url, 'utf8'))) ?? {};
  } catch {
    return {};
  }
}

const state = {
  official: OFFICIAL_CNY,
  modelsDev: {},
  asOf: { CNY: PRICE_AS_OF_CNY, USD: PRICE_AS_OF_USD },
  fetchedAt: 0,
  rev: 0,
  source: 'seed',
};

// Synchronous bootstrap: seed first, then a fresher on-disk cache if present.
state.modelsDev = readSeed();
try {
  const cached = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  const official = sanitizeOfficial(cached?.official);
  const modelsDev = sanitizeReduced(cached?.modelsDev);
  if (official !== null) {
    state.official = official;
    state.source = 'cache';
  }
  if (modelsDev !== null) {
    state.modelsDev = modelsDev;
    state.source = 'cache';
  }
  if (typeof cached?.asOf?.CNY === 'string') state.asOf.CNY = cached.asOf.CNY;
  if (typeof cached?.asOf?.USD === 'string') state.asOf.USD = cached.asOf.USD;
  if (Number.isFinite(cached?.fetchedAt)) state.fetchedAt = cached.fetchedAt;
} catch {
  // No usable cache: the seed stays in force.
}

const SNAPSHOT_SUFFIX = /-(?:[0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$/;

/**
 * Models.dev table lookup with no fuzzy binding: an id either matches a key
 * exactly (after case folding, basename extraction, or dropping ONE trailing
 * snapshot suffix) or it stays unpriced. A wrong price is worse than no price.
 * @param table - one provider's `{modelId: cost}` table.
 * @param model - routed model id.
 * @returns the cost row, or null.
 */
function findModelsDevModel(table, model) {
  if (table === null || typeof table !== 'object') return null;
  const stripped = model.replace(SNAPSHOT_SUFFIX, '');
  const candidates = [model, model.toLowerCase(), model.split('/').pop(), stripped, stripped.toLowerCase(), stripped.split('/').pop()];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && Object.hasOwn(table, candidate)) return table[candidate];
  }
  return null;
}

function toBucketRow(cost) {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: Number.isFinite(cost.cache_read) ? cost.cache_read : 0,
    cacheWrite: Number.isFinite(cost.cache_write) ? cost.cache_write : 0,
  };
}

/** Price catalog facade consumed by `viewCost`. */
export const catalog = {
  /**
   * Price one routed model.
   * @param provider - provider id from the request header.
   * @param model - model id from the request header.
   * @returns `{ currency, peak, off }`, or null when no price is known.
   */
  priceOf(provider, model) {
    if (isOfficialFamily(provider)) {
      const row = resolveOfficialRow(model);
      return row === null ? null : { currency: 'CNY', peak: row.peak, off: row.off };
    }
    const providerId = modelsDevProvider(provider);
    const table = state.modelsDev[providerId] ?? state.modelsDev[provider] ?? null;
    const found = findModelsDevModel(table, model);
    if (found === null) return null;
    const row = toBucketRow(found);
    return { currency: 'USD', peak: row, off: row };
  },
  priceAsOf() {
    return { CNY: state.asOf.CNY, USD: state.asOf.USD };
  },
  /**
   * Whether the embedded statutory-holiday list still covers today's date.
   * Past that date peak detection silently treats every weekday as peak, so the
   * view reports it instead of pretending to be exact.
   * @returns `{ end, incomplete }`.
   */
  holidayCoverage() {
    const end = CN_HOLIDAY_COVERAGE_END;
    const endMs = Date.parse(`${end}T23:59:59+08:00`);
    return { end, incomplete: !Number.isFinite(endMs) || Date.now() > endMs };
  },
  rev() {
    return state.rev;
  },
  status() {
    return {
      source: state.source,
      fetchedAt: state.fetchedAt,
      rev: state.rev,
      officialModels: Object.keys(state.official).length,
      modelsDevProviders: Object.keys(state.modelsDev).length,
    };
  },
};

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'text/html,application/json' },
  });
  if (!response.ok) throw new Error(`${url} responded ${String(response.status)}`);
  return await response.text();
}

async function refreshOfficial() {
  const parsed = parseOfficialPricing(await fetchText(OFFICIAL_URL));
  if (parsed === null) throw new Error('official pricing page did not match the expected table');
  return parsed;
}

async function refreshModelsDev() {
  const rows = reduceModelsDev(JSON.parse(await fetchText(MODELS_DEV_URL)));
  if (rows === null) throw new Error('models.dev payload had no priced models');
  return { rows, asOf: todayInBeijing() };
}

function persist() {
  try {
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ fetchedAt: state.fetchedAt, asOf: state.asOf, official: state.official, modelsDev: state.modelsDev }));
    fs.renameSync(temporary, file);
  } catch {
    // A read-only home only costs the next start one network round trip.
  }
}

/**
 * Refresh both price sources in the background; failures keep the last known table.
 * @param warn - optional logger for one-line diagnostics.
 * @returns whether anything was updated.
 */
export async function refreshCatalog(warn) {
  if (Date.now() - state.fetchedAt < CACHE_TTL_MS) return false;
  const [official, modelsDev] = await Promise.allSettled([refreshOfficial(), refreshModelsDev()]);
  let changed = false;
  if (official.status === 'fulfilled') {
    state.official = official.value.rows;
    state.asOf.CNY = official.value.asOf;
    changed = true;
  } else if (typeof warn === 'function') {
    warn(`session-cost: official CNY price refresh failed: ${String(official.reason)}`);
  }
  if (modelsDev.status === 'fulfilled') {
    state.modelsDev = modelsDev.value.rows;
    state.asOf.USD = modelsDev.value.asOf;
    changed = true;
  } else if (typeof warn === 'function') {
    warn(`session-cost: models.dev price refresh failed: ${String(modelsDev.reason)}`);
  }
  if (!changed) return false;
  state.fetchedAt = Date.now();
  state.rev += 1;
  state.source = 'network';
  persist();
  return true;
}
