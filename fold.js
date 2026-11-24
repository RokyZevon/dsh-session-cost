/**
 * Pure token-ledger fold for the `sessionCost` projection.
 *
 * The fold stores integer token counts per (model, tier) and nothing else:
 * prices live in the catalog and are applied only in `viewCost`, so a price
 * change never invalidates persisted state or needs a stateVersion bump.
 *
 * Attribution mirrors the durable log, not a mutable selection: every
 * `assistant/message` (or `assistant/attempt`) is charged to the model of the
 * latest preceding `request/header`, which is exactly how the harness itself
 * reconstructs the epoch header for a request.
 */

import { BEIJING_OFFSET_MINUTES, tierAt, tierSchedule } from './pricing.js';

const UNKNOWN_PROVIDER = 'unknown';
const UNKNOWN_MODEL = 'unknown';

function zeroBuckets() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The four billed buckets of one provider usage report.
 * A present-but-zero report is a real report: it must be able to replace an
 * earlier settlement for the same step (mirrors the token meter, which decides
 * "reported" by `usage !== undefined`, not by magnitude).
 * @param usage - provider usage record.
 * @returns the buckets, or null when the record is absent/malformed.
 */
function bucketsOf(usage) {
  if (typeof usage !== 'object' || usage === null) return null;
  return {
    input: count(usage.inputTokens),
    output: count(usage.outputTokens),
    cacheRead: count(usage.cacheReadTokens),
    cacheWrite: count(usage.cacheWriteTokens),
  };
}

/** Last raw `usage` chunk embedded in one assistant stream, if any. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record !== null && typeof record === 'object' && record.type === 'chunk' && record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage') {
      return record.chunk.usage;
    }
  }
  return undefined;
}

/**
 * The usage one durable assistant settlement reports, mirroring the token
 * meter: an assembled message carries it directly, a raw attempt in its stream.
 * @param event - a session event of type `assistant/message` or `assistant/attempt`.
 * @returns the provider usage record, or undefined when none was reported.
 */
function usageOf(event) {
  const data = event.data;
  if (data === null || typeof data !== 'object') return undefined;
  if (event.type === 'assistant/message' && data.usage !== undefined) return data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  return lastStreamUsage(data.stream);
}

function modelKey(provider, model) {
  return `${provider}/${model}`;
}

/** Add (or, with sign -1, remove) one settlement's buckets without mutating. */
function accumulate(models, key, tier, buckets, sign) {
  const previous = Object.hasOwn(models, key) ? models[key] : null;
  const entry = previous ?? { peak: zeroBuckets(), off: zeroBuckets() };
  const bucket = entry[tier];
  const next = {
    input: Math.max(0, bucket.input + sign * buckets.input),
    output: Math.max(0, bucket.output + sign * buckets.output),
    cacheRead: Math.max(0, bucket.cacheRead + sign * buckets.cacheRead),
    cacheWrite: Math.max(0, bucket.cacheWrite + sign * buckets.cacheWrite),
  };
  return { ...models, [key]: { ...entry, [tier]: next } };
}

/** Initial projection state: no model in force yet and no settlement accumulated. */
export function initState() {
  return { cur: null, tier: null, last: null, models: {} };
}

/**
 * Fold one committed session event into the token ledger.
 * Unhandled events return the same reference, so downstream publication stays free.
 * @param state - previous state.
 * @param event - committed session event.
 * @returns the next state.
 */
export function applyEvent(state, event) {
  switch (event.type) {
    case 'request/header': {
      const config = event.data?.header?.config;
      if (config === null || typeof config !== 'object') return state;
      if (typeof config.provider !== 'string' || typeof config.model !== 'string') return state;
      if (state.cur !== null && state.cur.provider === config.provider && state.cur.model === config.model) return state;
      return { ...state, cur: { provider: config.provider, model: config.model } };
    }
    case 'step/start': {
      // Store the resolved tier, not the raw timestamp: most step starts land in
      // the same tier and then change nothing downstream.
      const tier = tierAt(event.time);
      return state.tier === tier ? state : { ...state, tier };
    }
    case 'assistant/message':
    case 'assistant/attempt': {
      const usage = usageOf(event);
      if (usage === undefined) return state;
      const buckets = bucketsOf(usage);
      if (buckets === null) return state;
      const data = event.data ?? {};
      const turn = typeof data.turn === 'number' ? data.turn : -1;
      const step = typeof data.step === 'number' ? data.step : -1;
      const provider = state.cur === null ? UNKNOWN_PROVIDER : state.cur.provider;
      const model = state.cur === null ? UNKNOWN_MODEL : state.cur.model;
      const key = modelKey(provider, model);
      const tier = state.tier ?? tierAt(event.time);
      // One settlement per step replaces its predecessor (retried attempts and
      // repeated settlements must not accrue twice).
      let models = state.models;
      const previous = state.last;
      if (previous !== null && previous.turn === turn && previous.step === step) {
        models = accumulate(models, previous.key, previous.tier, previous.buckets, -1);
      }
      models = accumulate(models, key, tier, buckets, 1);
      return { ...state, models, last: { turn, step, key, tier, buckets } };
    }
    case 'llm/retry-started': {
      // Closing the replacement slot makes the retried attempt add to the total,
      // exactly like the token meter: every attempt is billed.
      const data = event.data;
      const previous = state.last;
      if (previous === null || data === null || typeof data !== 'object') return state;
      if (data.turn !== previous.turn || data.step !== previous.step) return state;
      return { ...state, last: null };
    }
    case 'compaction/summary': {
      const data = event.data;
      if (data === null || typeof data !== 'object') return state;
      const buckets = bucketsOf(data.usage);
      if (buckets === null) return state;
      const provider = typeof data.provider === 'string' && data.provider.length > 0 ? data.provider : UNKNOWN_PROVIDER;
      const model = typeof data.model === 'string' && data.model.length > 0 ? data.model : UNKNOWN_MODEL;
      return { ...state, models: accumulate(state.models, modelKey(provider, model), tierAt(event.time), buckets, 1) };
    }
    default:
      return state;
  }
}

function bucketCost(buckets, prices) {
  return {
    input: (buckets.input * prices.input) / 1e6,
    cacheRead: (buckets.cacheRead * prices.cacheRead) / 1e6,
    cacheWrite: (buckets.cacheWrite * prices.cacheWrite) / 1e6,
    output: (buckets.output * prices.output) / 1e6,
  };
}

function totalOf(buckets) {
  return buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output;
}

function sumCosts(left, right) {
  return {
    input: left.input + right.input,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    output: left.output + right.output,
  };
}

const BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output'];

/**
 * Turn the token ledger into money with the current price catalog.
 * Per-model detail carries money per tier and per bucket so the Client dialog
 * only formats; it never multiplies tokens by a price itself.
 * @param state - projection state.
 * @param catalog - price catalog (`priceOf`, `priceAsOf`, `rev`, `holidayCoverage`).
 * @returns the wire view consumed by the Client pill and dialog.
 */
export function viewCost(state, catalog) {
  const currencies = {};
  const models = [];
  const unpriced = [];
  for (const [key, entry] of Object.entries(state.models)) {
    const slash = key.indexOf('/');
    const provider = slash < 0 ? key : key.slice(0, slash);
    const model = slash < 0 ? '' : key.slice(slash + 1);
    const tokens = {
      input: entry.peak.input + entry.off.input,
      output: entry.peak.output + entry.off.output,
      cacheRead: entry.peak.cacheRead + entry.off.cacheRead,
      cacheWrite: entry.peak.cacheWrite + entry.off.cacheWrite,
    };
    if (totalOf(tokens) === 0) continue;
    const price = catalog.priceOf(provider, model);
    if (price === null) {
      unpriced.push({ key, tokens });
      continue;
    }
    const peakCost = bucketCost(entry.peak, price.peak);
    const offCost = bucketCost(entry.off, price.off);
    const costByBucket = sumCosts(peakCost, offCost);
    const cost = totalOf(costByBucket);
    currencies[price.currency] = (currencies[price.currency] ?? 0) + cost;
    models.push({
      key,
      currency: price.currency,
      cost,
      tiered: BUCKETS.some((field) => price.peak[field] !== price.off[field]),
      unit: {
        peak: { input: price.peak.input, cacheRead: price.peak.cacheRead, cacheWrite: price.peak.cacheWrite, output: price.peak.output },
        off: { input: price.off.input, cacheRead: price.off.cacheRead, cacheWrite: price.off.cacheWrite, output: price.off.output },
      },
      tokens,
      costByBucket,
      peak: { tokens: entry.peak, cost: peakCost },
      off: { tokens: entry.off, cost: offCost },
    });
  }
  // A partial total must never look complete: the Client marks it and names the
  // unpriced models in the tooltip and dialog.
  const priced = unpriced.length === 0 && models.length > 0 ? 'full' : models.length > 0 ? 'partial' : 'none';
  const coverage = typeof catalog.holidayCoverage === 'function' ? catalog.holidayCoverage() : { end: '', incomplete: false };
  return {
    v: 3,
    priced,
    currencies,
    models,
    unpriced,
    priceAsOf: catalog.priceAsOf(),
    catalogRev: catalog.rev(),
    holidayCoverage: { end: coverage.end, incomplete: coverage.incomplete === true },
    // Absolute instants only: the rule stays on the Host, the Client just picks
    // the entry whose `until` is still ahead and counts down to it.
    tierSchedule: { tzOffsetMinutes: BEIJING_OFFSET_MINUTES, upcoming: tierSchedule(Date.now(), 6) },
  };
}
