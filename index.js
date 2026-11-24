/**
 * Host half of the session-cost bundle.
 *
 * Registers one session projection unit (`sessionCost`) that folds durable
 * `request/header` + assistant usage into price-free integer token counts, and
 * serves the money through the unit's wire view using the runtime catalog.
 * The Client half only formats that value into the composer dock.
 */

import { applyEvent, initState, viewCost } from './fold.js';
import { catalog, refreshCatalog } from './catalog.js';

/** Cordis plugin name. */
export const name = 'session-cost';

/** The projection registry is required; without it this plugin stays inactive. */
export const inject = ['sessionProjections'];

const BUCKET_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];

function fail(what) {
  throw new Error(`session-cost: ${what}`);
}

function assertBuckets(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const field of BUCKET_FIELDS) {
    const count = value[field];
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) fail(`${label}.${field} must be a non-negative finite number`);
  }
}

function assertState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('state must be a plain object');
  if (value.cur !== null) {
    if (typeof value.cur !== 'object' || typeof value.cur.provider !== 'string' || typeof value.cur.model !== 'string') fail('state.cur must be null or {provider,model}');
  }
  if (value.tier !== null && value.tier !== 'peak' && value.tier !== 'off') fail('state.tier must be null, "peak" or "off"');
  const last = value.last;
  if (last !== null) {
    if (typeof last !== 'object') fail('state.last must be null or an object');
    if (!Number.isInteger(last.turn) || !Number.isInteger(last.step)) fail('state.last.turn/step must be integers');
    if (typeof last.key !== 'string') fail('state.last.key must be a string');
    if (last.tier !== 'peak' && last.tier !== 'off') fail('state.last.tier must be "peak" or "off"');
    assertBuckets(last.buckets, 'state.last.buckets');
  }
  const models = value.models;
  if (models === null || typeof models !== 'object' || Array.isArray(models)) fail('state.models must be an object');
  for (const [key, entry] of Object.entries(models)) {
    if (entry === null || typeof entry !== 'object') fail(`state.models["${key}"] must be an object`);
    assertBuckets(entry.peak, `state.models["${key}"].peak`);
    assertBuckets(entry.off, `state.models["${key}"].off`);
  }
  return value;
}

function assertView(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('view must be a plain object');
  if (value.v !== 3) fail('view.v must be 3');
  if (value.priced !== 'full' && value.priced !== 'partial' && value.priced !== 'none') fail('view.priced must be "full", "partial" or "none"');
  if (value.currencies === null || typeof value.currencies !== 'object' || Array.isArray(value.currencies)) fail('view.currencies must be an object');
  for (const [currency, amount] of Object.entries(value.currencies)) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) fail(`view.currencies.${currency} must be a non-negative finite number`);
  }
  if (!Array.isArray(value.models)) fail('view.models must be an array');
  for (const [position, model] of value.models.entries()) {
    const label = `view.models[${String(position)}]`;
    if (model === null || typeof model !== 'object') fail(`${label} must be an object`);
    if (typeof model.key !== 'string') fail(`${label}.key must be a string`);
    if (model.currency !== 'CNY' && model.currency !== 'USD') fail(`${label}.currency must be CNY or USD`);
    if (typeof model.cost !== 'number' || !Number.isFinite(model.cost) || model.cost < 0) fail(`${label}.cost must be a non-negative finite number`);
    if (typeof model.tiered !== 'boolean') fail(`${label}.tiered must be a boolean`);
    assertBuckets(model.tokens, `${label}.tokens`);
    if (model.unit === null || typeof model.unit !== 'object') fail(`${label}.unit must be an object`);
    assertBuckets(model.unit.peak, `${label}.unit.peak`);
    assertBuckets(model.unit.off, `${label}.unit.off`);
    assertBuckets(model.costByBucket, `${label}.costByBucket`);
    for (const tier of ['peak', 'off']) {
      const entry = model[tier];
      if (entry === null || typeof entry !== 'object') fail(`${label}.${tier} must be an object`);
      assertBuckets(entry.tokens, `${label}.${tier}.tokens`);
      assertBuckets(entry.cost, `${label}.${tier}.cost`);
    }
  }
  if (!Array.isArray(value.unpriced)) fail('view.unpriced must be an array');
  for (const [position, item] of value.unpriced.entries()) {
    if (item === null || typeof item !== 'object' || typeof item.key !== 'string') fail(`view.unpriced[${String(position)}] must be {key,tokens}`);
    assertBuckets(item.tokens, `view.unpriced[${String(position)}].tokens`);
  }
  if (value.priceAsOf === null || typeof value.priceAsOf !== 'object') fail('view.priceAsOf must be an object');
  if (typeof value.catalogRev !== 'number' || !Number.isFinite(value.catalogRev)) fail('view.catalogRev must be a finite number');
  if (value.holidayCoverage === null || typeof value.holidayCoverage !== 'object') fail('view.holidayCoverage must be an object');
  const schedule = value.tierSchedule;
  if (schedule === null || typeof schedule !== 'object') fail('view.tierSchedule must be an object');
  if (!Number.isFinite(schedule.tzOffsetMinutes)) fail('view.tierSchedule.tzOffsetMinutes must be a finite number');
  if (!Array.isArray(schedule.upcoming)) fail('view.tierSchedule.upcoming must be an array');
  for (const [position, entry] of schedule.upcoming.entries()) {
    const label = `view.tierSchedule.upcoming[${String(position)}]`;
    if (entry === null || typeof entry !== 'object') fail(`${label} must be an object`);
    if (entry.tier !== 'peak' && entry.tier !== 'off') fail(`${label}.tier must be "peak" or "off"`);
    if (!Number.isFinite(entry.until)) fail(`${label}.until must be a finite number`);
  }
  return value;
}

/**
 * The registry calls `parse` for persisted state rows and for wire values; both
 * are fail-closed boundaries here so one stale row is rejected instead of
 * throwing inside `wire.view` (which would break every key's cached read).
 */
const stateSchema = { parse: assertState };
const viewSchema = { parse: assertView };

/** Exposed so the offline self-check can prove real fold output passes the seam's schemas. */
export const __contract = { stateSchema, viewSchema };

/**
 * Register the projection unit and keep the price catalog fresh.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register({
    key: 'sessionCost',
    // 2: state carries the resolved tier instead of a raw step timestamp.
    stateVersion: 2,
    stateSchema,
    init: initState,
    apply: applyEvent,
    wire: {
      viewSchema,
      view: (state) => viewCost(state, catalog),
    },
  });

  // Background price refresh, owned by this plugin's fiber.
  ctx.effect(() => {
    let stopped = false;
    const warn = typeof ctx.logger?.warn === 'function' ? ctx.logger.warn.bind(ctx.logger) : undefined;
    const run = () => {
      if (stopped) return;
      refreshCatalog(warn).catch(() => {});
    };
    run();
    const timer = setInterval(run, 6 * 3600 * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });
}
