/**
 * Pricing policy for the session-cost display.
 *
 * Two authoritative sources, kept separate on purpose:
 *  - DeepSeek official (CN region): CNY per 1M tokens, peak/off-peak tiers.
 *    Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *  - Everything else: models.dev (USD per 1M tokens, single tier).
 *    Source: https://models.dev/api.json
 *
 * Prices never enter persisted projection state; this module is the only place
 * that turns token counts into money.
 */

/** CNY price table from the official Chinese pricing page, per 1M tokens. */
export const OFFICIAL_CNY = {
  'deepseek-flash': {
    peak: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
    off: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0 },
  },
  'deepseek-v4-pro': {
    peak: { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0 },
    off: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0 },
  },
};

/** Official footnote: legacy model names are served by, and billed as, FLASH. */
const OFFICIAL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4.1-flash-1017': 'deepseek-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
};

/** Date the bundled official table was read from the page (shown in the UI). */
export const PRICE_AS_OF_CNY = '2026-11-01';
/** Date the bundled models.dev snapshot was read (shown in the UI). */
export const PRICE_AS_OF_USD = '2026-11-01';

/**
 * Statutory holiday ranges (Beijing dates), inclusively. Peak pricing is
 * weekdays only, excluding these days entirely. Weekend days made workdays by
 * the 调休 arrangement stay weekends here, matching the official weekday rule.
 * Sources: 国务院办公厅关于2026年、2027年部分节假日安排的通知 (gov.cn).
 * Adding a future year's ranges cannot change an event that was already folded,
 * so it needs no stateVersion bump; bump only when a past date's range changes.
 */
const CN_HOLIDAY_RANGES_2026 = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

/** 国务院办公厅关于2027年部分节假日安排的通知 (2026-11-05). */
const CN_HOLIDAY_RANGES_2027 = [
  ['2027-01-01', '2027-01-03'],
  ['2027-02-05', '2027-02-13'],
  ['2027-04-03', '2027-04-05'],
  ['2027-05-01', '2027-05-05'],
  ['2027-06-09', '2027-06-09'],
  ['2027-09-15', '2027-09-15'],
  ['2027-10-01', '2027-10-07'],
];

const DAY_MS = 86400000;

function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

function expandRanges(ranges) {
  const days = new Set();
  for (const [start, end] of ranges) {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
      const date = new Date(ms);
      days.add(`${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`);
    }
  }
  return days;
}

export const CN_HOLIDAYS = expandRanges([...CN_HOLIDAY_RANGES_2026, ...CN_HOLIDAY_RANGES_2027]);
/** Beyond this date the holiday list has no coverage; peak detection degrades to weekdays. */
export const CN_HOLIDAY_COVERAGE_END = '2027-12-31';

/** Beijing wall-clock parts of one epoch-millisecond instant. */
function beijingParts(ms) {
  const date = new Date(ms + 8 * 3600000);
  return {
    weekday: date.getUTCDay(),
    minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
    dateKey: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
  };
}

/**
 * Whether one instant falls in DeepSeek's peak window.
 * Peak: Beijing time, Monday-Friday, 09:00-12:00 and 14:00-18:00, excluding
 * statutory holidays. Off-peak is half price and covers everything else,
 * weekends and holidays included.
 * @param ms - epoch milliseconds of the request start.
 * @returns peak tier when in a peak window, otherwise off.
 */
export function tierAt(ms) {
  if (!Number.isFinite(ms)) return 'off';
  const { weekday, minutes, dateKey } = beijingParts(ms);
  if (weekday === 0 || weekday === 6) return 'off';
  if (CN_HOLIDAYS.has(dateKey)) return 'off';
  if (minutes >= 540 && minutes < 720) return 'peak';
  if (minutes >= 840 && minutes < 1080) return 'peak';
  return 'off';
}

/** Whether a provider route is billed from the DeepSeek official CNY table. */
export function isOfficialFamily(provider) {
  return typeof provider === 'string' && /deepseek/i.test(provider);
}

/**
 * Resolve one model id against the official CNY table.
 * Only the table's own ids and the page's documented legacy aliases resolve;
 * any other id stays unpriced rather than borrowing a neighbour's price.
 * @param model - routed model id.
 * @returns the official price row, or null when the id is not priced.
 */
export function resolveOfficialRow(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  const id = model.toLowerCase();
  const aliased = Object.hasOwn(OFFICIAL_ALIASES, id) ? OFFICIAL_ALIASES[id] : id;
  return Object.hasOwn(OFFICIAL_CNY, aliased) ? OFFICIAL_CNY[aliased] : null;
}

/** How a routed provider id maps onto a models.dev provider id. */
const MODELS_DEV_PROVIDER_ALIAS = {
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek',
};

/**
 * Map one harness provider id to its models.dev key.
 * @param provider - provider id from the session's request header.
 * @returns the models.dev provider id to look up.
 */
export function modelsDevProvider(provider) {
  if (typeof provider !== 'string') return '';
  return MODELS_DEV_PROVIDER_ALIAS[provider] ?? provider;
}

/** Beijing offset from UTC, in minutes (no DST). */
export const BEIJING_OFFSET_MINUTES = 8 * 60;

/** Peak windows as Beijing minutes-of-day, half-open: [from, to). */
export const PEAK_WINDOW_MINUTES = [[540, 720], [840, 1080]];

/** Start of the Beijing calendar day containing `ms`. */
function beijingMidnight(ms) {
  const shifted = ms + BEIJING_OFFSET_MINUTES * 60000;
  return Math.floor(shifted / DAY_MS) * DAY_MS - BEIJING_OFFSET_MINUTES * 60000;
}

/**
 * Upcoming tier boundaries as absolute instants, so a Client can render "the
 * tier in force now" and a live countdown without re-implementing the rule:
 * each entry's `tier` holds until its `until` timestamp.
 * @param fromMs - instant to project from.
 * @param count - maximum entries to return.
 * @returns ordered `[{ tier, until }]`, empty when the horizon yields none.
 */
export function tierSchedule(fromMs, count = 6) {
  const start = Number.isFinite(fromMs) ? fromMs : Date.now();
  const midnight = beijingMidnight(start);
  const candidates = [];
  for (let day = 0; day <= 8; day += 1) {
    const base = midnight + day * DAY_MS;
    candidates.push(base);
    for (const [from, to] of PEAK_WINDOW_MINUTES) {
      candidates.push(base + from * 60000);
      candidates.push(base + to * 60000);
    }
  }
  candidates.sort((left, right) => left - right);
  const schedule = [];
  let tier = tierAt(start);
  for (const at of candidates) {
    if (at <= start) continue;
    const next = tierAt(at);
    if (next === tier) continue;
    schedule.push({ tier, until: at });
    tier = next;
    if (schedule.length >= count) break;
  }
  return schedule;
}
