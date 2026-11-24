#!/usr/bin/env node
/**
 * Offline self-check for the session-cost fold. It lives in the package
 * directory but is excluded by package.json "files", so it is never distributed.
 * Replays a real session log through fold.js and asserts the pricing math,
 * the peak/off-peak split, retry replacement, and model switch attribution.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = process.env.DSH_SESSION_COST_BUNDLE ?? path.resolve(here, '..');
const { applyEvent, initState, viewCost } = await import(path.join(bundle, 'fold.js'));
const { catalog } = await import(path.join(bundle, 'catalog.js'));
const { __contract } = await import(path.join(bundle, 'index.js'));
const { tierAt } = await import(path.join(bundle, 'pricing.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail === undefined ? '' : ` :: ${detail}`}`);
  }
}
function near(actual, expected, tolerance = 1e-9) {
  return Math.abs(actual - expected) <= tolerance;
}

/** Independent whole-log token totals, mirroring the token meter's semantics. */
function independentTotals(events) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let last = null;
  const bucketsOf = (usage) => {
    if (usage === null || typeof usage !== 'object') return null;
    const b = {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
    };
    return b.input + b.output + b.cacheRead + b.cacheWrite === 0 ? null : b;
  };
  const subtract = (b) => {
    totals.input -= b.input; totals.output -= b.output; totals.cacheRead -= b.cacheRead; totals.cacheWrite -= b.cacheWrite;
  };
  const add = (b) => {
    totals.input += b.input; totals.output += b.output; totals.cacheRead += b.cacheRead; totals.cacheWrite += b.cacheWrite;
  };
  for (const event of events) {
    if (event.type === 'llm/retry-started' && last !== null && last.turn === event.data?.turn && last.step === event.data?.step) {
      last = null;
      continue;
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    let usage = event.data?.usage;
    if (usage === undefined) {
      const stream = event.data?.stream;
      if (Array.isArray(stream)) {
        for (let index = stream.length - 1; index >= 0; index -= 1) {
          const record = stream[index];
          if (record?.type === 'chunk' && record.chunk?.type === 'usage') { usage = record.chunk.usage; break; }
        }
      }
    }
    const b = bucketsOf(usage);
    if (b === null) continue;
    const turn = event.data?.turn;
    const step = event.data?.step;
    if (last !== null && last.turn === turn && last.step === step) subtract(last.buckets);
    add(b);
    last = { turn, step, buckets: b };
  }
  return totals;
}

function loadEvents(file) {
  const text = file.endsWith('.zstd')
    ? execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
    : fs.readFileSync(file, 'utf8');
  return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

/** Synthetic cases that a real log may not contain. */
function syntheticChecks() {
  const peak = Date.parse('2026-11-02T02:30:00Z');   // Monday 10:30 Beijing
  const off = Date.parse('2026-11-01T02:30:00Z');    // Sunday
  const usage = (input, output, read = 0, write = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write });

  // 0. The embedded holiday table covers 2027, not just 2026.
  check('holidays: 2027 New Year weekday is off-peak', tierAt(Date.parse('2027-01-01T02:30:00Z')) === 'off');
  check('holidays: 2027 Spring Festival weekday is off-peak', tierAt(Date.parse('2027-02-08T02:30:00Z')) === 'off');
  check('holidays: an ordinary 2027 weekday is peak', tierAt(Date.parse('2027-01-04T02:30:00Z')) === 'peak');

  // 1. Retry counts every attempt (retry-started closes the replacement slot).
  let state = initState();
  const retryEvents = [
    { type: 'request/header', time: peak, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    { type: 'step/start', time: peak, data: { turn: 1, step: 1 } },
    { type: 'assistant/attempt', time: peak, data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: usage(1000000, 0) } }] } },
    { type: 'llm/retry-started', time: peak, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: peak, data: { turn: 1, step: 1, usage: usage(1000000, 0), stream: [] } },
  ];
  for (const event of retryEvents) state = applyEvent(state, event);
  let view = viewCost(state, catalog);
  // 2M input tokens at peak flash (2 CNY/M) = 4 CNY
  check('retry: every attempt is billed', near(view.currencies.CNY, 4), JSON.stringify(view.currencies));

  // 2. Two settlements for one step without a retry replace each other.
  state = initState();
  state = applyEvent(state, { type: 'request/header', time: off, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } });
  state = applyEvent(state, { type: 'step/start', time: off, data: { turn: 2, step: 1 } });
  state = applyEvent(state, { type: 'assistant/message', time: off, data: { turn: 2, step: 1, usage: usage(1000000, 0), stream: [] } });
  state = applyEvent(state, { type: 'assistant/message', time: off, data: { turn: 2, step: 1, usage: usage(1000000, 500000), stream: [] } });
  view = viewCost(state, catalog);
  check('replacement: one settlement per step', near(view.currencies.CNY, 1 + 2), JSON.stringify(view.currencies));

  // 3. A model switch mid-session prices each segment with its own model.
  state = initState();
  state = applyEvent(state, { type: 'request/header', time: peak, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } });
  state = applyEvent(state, { type: 'step/start', time: peak, data: { turn: 3, step: 1 } });
  state = applyEvent(state, { type: 'assistant/message', time: peak, data: { turn: 3, step: 1, usage: usage(1000000, 0), stream: [] } });
  state = applyEvent(state, { type: 'request/header', time: peak, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } } });
  state = applyEvent(state, { type: 'step/start', time: peak, data: { turn: 3, step: 2 } });
  state = applyEvent(state, { type: 'assistant/message', time: peak, data: { turn: 3, step: 2, usage: usage(1000000, 0), stream: [] } });
  view = viewCost(state, catalog);
  check('model switch: own price per segment', near(view.currencies.CNY, 2 + 9), JSON.stringify(view.currencies));
  check('model switch: two priced models listed', view.models.length === 2, String(view.models.length));
  check('view: per-tier money adds up to the model total', view.models.every((m) => Math.abs((m.peak.cost.input + m.peak.cost.output + m.peak.cost.cacheRead + m.peak.cost.cacheWrite + m.off.cost.input + m.off.cost.output + m.off.cost.cacheRead + m.off.cost.cacheWrite) - m.cost) < 1e-12), JSON.stringify(view.models.map((m) => [m.cost, m.peak.cost, m.off.cost])));
  check('view: official models are tiered, unknown are not priced', view.models.every((m) => m.tiered === true), JSON.stringify(view.models.map((m) => m.tiered)));
  check('view: every priced model carries unit prices', view.models.every((m) => m.unit && m.unit.peak.input >= 0 && m.unit.off.input >= 0), JSON.stringify(view.models.map((m) => m.unit)));
  check('view: tier schedule starts in force now and only moves forward',
    Array.isArray(view.tierSchedule.upcoming)
    && view.tierSchedule.upcoming.length > 0
    && view.tierSchedule.upcoming.every((entry, index, list) => (entry.tier === 'peak' || entry.tier === 'off') && Number.isFinite(entry.until) && (index === 0 || entry.until > list[index - 1].until)),
    JSON.stringify(view.tierSchedule));

  // 4. Compaction summary is billed with its own route, not as a step.
  state = initState();
  state = applyEvent(state, { type: 'compaction/summary', time: off, data: { provider: 'deepseek-official', model: 'deepseek-flash', usage: usage(1000000, 0) } });
  view = viewCost(state, catalog);
  check('compaction: billed separately', near(view.currencies.CNY, 1), JSON.stringify(view.currencies));

  // 5. An unpriced model reports tokens but no money.
  state = initState();
  state = applyEvent(state, { type: 'request/header', time: off, data: { header: { config: { provider: 'zzz-gateway', model: 'nope-model' } } } });
  state = applyEvent(state, { type: 'step/start', time: off, data: { turn: 5, step: 1 } });
  state = applyEvent(state, { type: 'assistant/message', time: off, data: { turn: 5, step: 1, usage: usage(1234, 56), stream: [] } });
  view = viewCost(state, catalog);
  check('unpriced: no invented money', view.priced === 'none' && view.unpriced.length === 1, JSON.stringify(view));

  // 6. A partial total is marked, never presented as complete.
  state = initState();
  state = applyEvent(state, { type: 'request/header', time: off, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } });
  state = applyEvent(state, { type: 'step/start', time: off, data: { turn: 6, step: 1 } });
  state = applyEvent(state, { type: 'assistant/message', time: off, data: { turn: 6, step: 1, usage: usage(1000000, 0), stream: [] } });
  state = applyEvent(state, { type: 'request/header', time: off, data: { header: { config: { provider: 'some-gateway', model: 'mystery-llm' } } } });
  state = applyEvent(state, { type: 'step/start', time: off, data: { turn: 6, step: 2 } });
  state = applyEvent(state, { type: 'assistant/message', time: off, data: { turn: 6, step: 2, usage: usage(5000000, 5000000), stream: [] } });
  view = viewCost(state, catalog);
  check('partial: total is flagged partial, not complete', view.priced === 'partial' && near(view.currencies.CNY, 1) && view.unpriced.length === 1, JSON.stringify({ priced: view.priced, currencies: view.currencies, unpriced: view.unpriced }));

  // 7. A zero usage report is a report: it replaces the earlier settlement.
  state = initState();
  state = applyEvent(state, { type: 'request/header', time: off, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } });
  state = applyEvent(state, { type: 'step/start', time: off, data: { turn: 7, step: 1 } });
  state = applyEvent(state, { type: 'assistant/attempt', time: off, data: { turn: 7, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: usage(100, 10) } }] } });
  state = applyEvent(state, { type: 'assistant/message', time: off, data: { turn: 7, step: 1, usage: usage(0, 0), stream: [] } });
  view = viewCost(state, catalog);
  check('zero usage: replaces the earlier settlement', view.priced === 'none' && Object.keys(view.currencies).length === 0, JSON.stringify(view));
}

syntheticChecks();

const target = process.argv[2];
if (target === undefined) {
  console.log('\n(no session log given; synthetic checks only)');
} else {
  const events = loadEvents(target);
  console.log(`\nsession log: ${target} (${String(events.length)} lines)`);
  let state = initState();
  for (const event of events) {
    if (event.type === undefined) continue;
    state = applyEvent(state, event);
  }
  const view = viewCost(state, catalog);
  const independent = independentTotals(events);
  const folded = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of Object.values(state.models)) {
    for (const tier of ['peak', 'off']) {
      folded.input += entry[tier].input; folded.output += entry[tier].output;
      folded.cacheRead += entry[tier].cacheRead; folded.cacheWrite += entry[tier].cacheWrite;
    }
  }
  // The seam's own fail-closed boundaries must accept real fold output.
  let schemaOk = true;
  try {
    __contract.stateSchema.parse(state);
    __contract.viewSchema.parse(view);
  } catch (error) {
    schemaOk = false;
    console.log('  schema rejection:', String(error));
  }
  check('contract: state and wire view pass the projection schemas', schemaOk);
  // ... and a stale/foreign row is rejected instead of reaching wire.view.
  let rejected = 0;
  for (const bad of [null, {}, { models: null }, { cur: null, tier: null, last: null, models: { k: { peak: {}, off: {} } } }]) {
    try { __contract.stateSchema.parse(bad); } catch { rejected += 1; }
  }
  check('contract: malformed cached state is rejected', rejected === 4, String(rejected));

  check('replay: fold totals equal an independent token fold',
    folded.input === independent.input && folded.output === independent.output
    && folded.cacheRead === independent.cacheRead && folded.cacheWrite === independent.cacheWrite,
    JSON.stringify({ folded, independent }));
  console.log('  folded tokens :', JSON.stringify(folded));
  console.log('  currencies    :', JSON.stringify(view.currencies));
  console.log('  priceAsOf     :', JSON.stringify(view.priceAsOf));
  for (const model of view.models) {
    console.log(`  ${model.key}  ${model.currency} ${model.cost.toFixed(6)}  tokens=${JSON.stringify(model.tokens)}  peak=${JSON.stringify(model.peak?.tokens)}  off=${JSON.stringify(model.off?.tokens)}  tiered=${String(model.tiered)}`);
  }
  for (const item of view.unpriced) console.log(`  UNPRICED ${item.key} tokens=${JSON.stringify(item.tokens)}`);
}

process.exit(failures === 0 ? 0 : 1);
