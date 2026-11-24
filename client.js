/**
 * Browser half of the session-cost bundle.
 *
 * Adds one money pill to `conversation.composer.dock`, after the shipped
 * activity (order 0) and usage (order 1) pills. Like those pills it is a button
 * opening a trigger-anchored dialog (portal + viewport-clamped placement,
 * Escape/outside-click close). Money arrives already computed from the Host
 * projection; this module only formats it.
 */

window.__ModuleLoader__.load({
  id: '@rokyzevon/dsh-session-cost',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const NS = 'dsh-session-cost';

    /** Panel margin kept inside the viewport (same as the shipped dialog). */
    const PANEL_MARGIN = 12;
    /** Distance between the trigger's top edge and the panel's bottom. */
    const PANEL_GAP = 8;
    /** Unplaced panel: hidden but laid out so the clamp can measure it. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    const CSS = [
      '.dsc-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.dsc-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
      '.dsc-pill svg{flex:none;width:14px;height:14px}',
      'button.dsc-pill:hover,button.dsc-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dsc-label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dsc-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}',
      '.dsc-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
      '.dsc-titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
      '.dsc-titleLabel svg{flex:none;width:14px;height:14px}',
      '.dsc-titleValue{font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsc-titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.dsc-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
      '.dsc-details dt,.dsc-details dd{min-width:0;margin:0}',
      '.dsc-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}',
      '.dsc-group+.dsc-group{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:10px;padding-top:10px}',
      '.dsc-groupTitle{color:var(--dsw-alias-label-secondary);justify-content:space-between;gap:12px;margin-bottom:6px;display:flex;overflow-wrap:anywhere}',
      '.dsc-groupAmount{font-variant-numeric:tabular-nums;flex:none}',
      '.dsc-note{color:var(--dsw-alias-label-tertiary);margin-top:10px;overflow-wrap:anywhere}',
      '.dsc-status{align-items:center;gap:8px;margin-bottom:10px;display:flex;flex-wrap:wrap}',
      '.dsc-badge{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);padding:0 6px;font-variant-numeric:tabular-nums}',
      '.dsc-statusText{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dsc-unit{margin-top:8px}',
      '.dsc-unitTitle{color:var(--dsw-alias-label-tertiary);margin-bottom:4px}',
      '.dsc-unitRow{display:flex;gap:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dsc-unitTier{flex:none;min-width:44px}',
      '.dsc-unitActive{color:var(--dsw-alias-label-primary)}',
    ].join('\n');

    /** Coin/¥ mark: the pill's own artwork, sized to the host pills' 14px icons. */
    function CostIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('circle', { cx: 8, cy: 8, r: 6.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M8 4.2v1.1M8 10.7v1.1M10.1 6.4c-.4-.6-1.1-1-1.9-1-1.1 0-1.8.6-1.8 1.4 0 .8.6 1.2 1.5 1.4l1 .2c.8.2 1.4.5 1.4 1.4 0 .8-.8 1.5-1.9 1.5-.9 0-1.6-.4-2-1.1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }));
    }

    /**
     * Format one currency slice; null when it has nothing to show.
     * Small amounts keep significant digits so a real spend never renders as a
     * zero-looking value.
     * @param amount - money in that currency.
     * @param symbol - currency marker.
     * @returns display text or null.
     */
    function moneyText(amount, symbol) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
      const digits = amount < 0.01 ? 6 : amount < 1 ? 4 : 2;
      return `${symbol}${trimFixed(amount, digits)}`;
    }

    /** Exact money for the dialog title: 6 decimals, trailing zeros kept off. */
    function moneyExact(amount, symbol) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
      const fixed = trimFixed(amount, 6);
      return fixed.includes('.') ? `${symbol}${fixed}` : `${symbol}${fixed}.00`;
    }

    function trimFixed(amount, digits) {
      const fixed = amount.toFixed(digits);
      const [whole, fraction] = fixed.split('.');
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const trimmed = fraction === undefined ? '' : fraction.replace(/0+$/, '');
      return trimmed.length === 0 ? grouped : `${grouped}.${trimmed}`;
    }

    /** Compact token count: 517 / 12.2K / 1.2M. */
    function tokenText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0';
      if (value < 1000) return String(Math.round(value));
      if (value < 1e6) return `${Math.round((value / 1e3) * 10) / 10}K`;
      return `${Math.round((value / 1e6) * 10) / 10}M`;
    }

    function sumOf(object) {
      if (object === null || typeof object !== 'object') return 0;
      let total = 0;
      for (const field of ['input', 'cacheRead', 'cacheWrite', 'output']) {
        if (typeof object[field] === 'number') total += object[field];
      }
      return total;
    }

    /** CNY and USD are kept apart on purpose: no exchange rate is invented. */
    function currencyParts(currencies) {
      if (currencies === null || typeof currencies !== 'object') return [];
      const parts = [];
      const cny = moneyText(currencies.CNY, '¥');
      if (cny !== null) parts.push({ currency: 'CNY', amount: currencies.CNY, text: cny });
      const usd = moneyText(currencies.USD, '$');
      if (usd !== null) parts.push({ currency: 'USD', amount: currencies.USD, text: usd });
      return parts;
    }

    function totalText(currencies) {
      const parts = currencyParts(currencies);
      return parts.length === 0 ? null : parts.map((part) => part.text).join(' + ');
    }

    function exactTotalText(currencies, t) {
      const parts = [];
      const cny = moneyExact(currencies?.CNY, '¥');
      if (cny !== null) parts.push(cny);
      const usd = moneyExact(currencies?.USD, '$');
      if (usd !== null) parts.push(usd);
      return parts.length === 0 ? (typeof t === 'function' ? t('cost.dialog.none') : '') : parts.join(' + ');
    }

    /** Tooltip: price vintage, unpriced models, holiday-coverage gap. */
    function titleOf(cost, t) {
      if (typeof t !== 'function') return undefined;
      const asOf = cost.priceAsOf ?? {};
      const parts = [t('cost.title', { cny: String(asOf.CNY ?? '?'), usd: String(asOf.USD ?? '?') })];
      const unpriced = Array.isArray(cost.unpriced) ? cost.unpriced : [];
      if (unpriced.length > 0) {
        parts.push(t('cost.partial', { count: String(unpriced.length) }));
        const names = unpriced.slice(0, 4).map((item) => String(item.key ?? '')).filter((name) => name.length > 0);
        if (names.length > 0) parts.push(names.join(', '));
      }
      if (cost.holidayCoverage?.incomplete === true) parts.push(t('cost.holiday', { end: String(cost.holidayCoverage.end ?? '') }));
      return parts.join(' · ');
    }

    /**
     * Trigger-anchored placement: measure the hidden panel, prefer above the
     * trigger, clamp into the viewport. Recomputes on resize/scroll.
     * @param open - whether the panel is mounted.
     * @returns `{ rootRef, panelRef, pos }`; spread `pos ?? MEASURE_STYLE`.
     */
    function useAnchored(open) {
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const [pos, setPos] = React.useState(null);
      React.useLayoutEffect(() => {
        if (!open) {
          setPos(null);
          return undefined;
        }
        const place = () => {
          const anchor = rootRef.current;
          const panel = panelRef.current;
          if (anchor === null || panel === null) return;
          const a = anchor.getBoundingClientRect();
          const p = panel.getBoundingClientRect();
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          const left = Math.min(
            Math.max(a.left + a.width / 2 - p.width / 2, PANEL_MARGIN),
            Math.max(PANEL_MARGIN, viewportWidth - p.width - PANEL_MARGIN),
          );
          let top = a.top - p.height - PANEL_GAP;
          if (top < PANEL_MARGIN) top = Math.min(a.bottom + PANEL_GAP, Math.max(PANEL_MARGIN, viewportHeight - p.height - PANEL_MARGIN));
          setPos({ left, top });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [open]);
      return { rootRef, panelRef, pos };
    }

    /** Escape and outside-pointer close, matching the shipped stats dialog. */
    function useDismiss(open, setOpen, rootRef, panelRef) {
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (rootRef.current?.contains(target) === true) return;
          if (panelRef.current?.contains(target) === true) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open, setOpen, rootRef, panelRef]);
    }

    /** Ticking clock (1s) while the dialog is open, for the live tier countdown. */
    function useNow(active) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!active) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [active]);
      return now;
    }

    /**
     * Tier in force now, read from the Host's absolute schedule: the first entry
     * whose `until` is still ahead is the current one.
     * @returns `{ tier, until }` or null when no schedule covers this instant.
     */
    function currentTier(tierSchedule, now) {
      const upcoming = tierSchedule !== null && typeof tierSchedule === 'object' && Array.isArray(tierSchedule.upcoming) ? tierSchedule.upcoming : [];
      for (const entry of upcoming) {
        if (entry === null || typeof entry !== 'object') continue;
        if (typeof entry.until !== 'number' || entry.until <= now) continue;
        return { tier: entry.tier, until: entry.until };
      }
      return null;
    }

    /** h:mm:ss above an hour, m:ss below. */
    function formatCountdown(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const pad = (value) => (value < 10 ? `0${value}` : String(value));
      return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${String(minutes)}:${pad(seconds)}`;
    }

    function symbolOf(currency) {
      return currency === 'CNY' ? '¥' : '$';
    }

    /** One line of per-1M-token prices: 输入 ¥2 · 缓存读 ¥0.04 · 输出 ¥8. */
    function priceLine(unit, t) {
      if (unit === null || typeof unit !== 'object') return '';
      const symbol = symbolOf(unit.currency);
      const fields = [
        ['cost.dialog.priceInput', 'input'],
        ['cost.dialog.priceCacheRead', 'cacheRead'],
        ['cost.dialog.priceCacheWrite', 'cacheWrite'],
        ['cost.dialog.priceOutput', 'output'],
      ];
      const parts = [];
      for (const [label, field] of fields) {
        const price = unit[field];
        if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) continue;
        if (field === 'cacheWrite' && price === 0) continue;
        parts.push(`${t(label)} ${symbol}${trimFixed(price, 4)}`);
      }
      return parts.join(' · ');
    }

    function unitBlock(model, current, t) {
      const unit = model.unit;
      if (unit === null || typeof unit !== 'object') return null;
      const currency = model.currency;
      const rows = [];
      if (model.tiered === true) {
        for (const [tierKey, label] of [['peak', 'cost.dialog.unitPeak'], ['off', 'cost.dialog.unitOff']]) {
          const priced = unit[tierKey];
          if (priced === null || typeof priced !== 'object') continue;
          const active = current !== null && current.tier === tierKey;
          rows.push(h('div', { key: tierKey, className: active ? 'dsc-unitRow dsc-unitActive' : 'dsc-unitRow' },
            h('span', { className: 'dsc-unitTier' }, t(label)),
            h('span', null, priceLine({ ...priced, currency }, t))));
        }
      } else {
        const priced = unit.peak ?? unit.off;
        if (priced !== null && typeof priced === 'object') {
          rows.push(h('div', { key: 'single', className: 'dsc-unitRow' }, h('span', null, priceLine({ ...priced, currency }, t))));
        }
      }
      if (rows.length === 0) return null;
      return h('div', { className: 'dsc-unit' },
        h('div', { className: 'dsc-unitTitle' }, t('cost.dialog.unit')),
        rows);
    }

    function modelDetail(model, t, tFn) {
      const rows = [];
      const fields = [
        ['cost.dialog.input', 'input'],
        ['cost.dialog.cacheRead', 'cacheRead'],
        ['cost.dialog.cacheWrite', 'cacheWrite'],
        ['cost.dialog.output', 'output'],
      ];
      for (const [label, field] of fields) {
        const tokens = typeof model.tokens?.[field] === 'number' ? model.tokens[field] : 0;
        if (tokens === 0) continue;
        const money = typeof model.costByBucket?.[field] === 'number' ? tFn(model.costByBucket[field], model.currency) : null;
        rows.push(h('dt', { key: `${model.key}:${field}:l` }, t(label)));
        rows.push(h('dd', { key: `${model.key}:${field}:v` }, money === null ? tokenText(tokens) : `${tokenText(tokens)} · ${money}`));
      }
      if (model.tiered === true) {
        for (const [label, tier] of [['cost.dialog.peak', 'peak'], ['cost.dialog.off', 'off']]) {
          const tierValue = model[tier];
          const tokens = sumOf(tierValue?.tokens);
          if (tokens === 0) continue;
          const cost = sumOf(tierValue?.cost);
          rows.push(h('dt', { key: `${model.key}:${tier}:l` }, t(label)));
          rows.push(h('dd', { key: `${model.key}:${tier}:v` }, cost > 0 ? `${tokenText(tokens)} · ${tFn(cost, model.currency)}` : tokenText(tokens)));
        }
      }
      return rows;
    }

    function dialogBody(cost, t, now) {
      const tFn = (amount, currency) => (currency === 'CNY' ? moneyExact(amount, '¥') : moneyExact(amount, '$'));
      const models = Array.isArray(cost.models) ? cost.models : [];
      const unpriced = Array.isArray(cost.unpriced) ? cost.unpriced : [];
      const current = currentTier(cost.tierSchedule, now);
      const tieredModels = models.filter((model) => model.tiered === true);
      const blocks = [];
      // Current price tier plus a live countdown to the next switch; the rule
      // itself stays on the Host and arrives as absolute instants.
      if (tieredModels.length > 0 && current !== null) {
        blocks.push(h('div', { key: 'status', className: 'dsc-status' },
          h('span', { className: 'dsc-badge' }, t(current.tier === 'peak' ? 'cost.dialog.peakShort' : 'cost.dialog.offShort')),
          h('span', { className: 'dsc-statusText' }, `${t(current.tier === 'peak' ? 'cost.dialog.nextOff' : 'cost.dialog.nextPeak')} ${formatCountdown(current.until - now)}`)));
      }
      if (models.length === 0 && unpriced.length === 0) {
        blocks.push(h('div', { key: 'empty', className: 'dsc-note' }, t('cost.dialog.empty')));
      }
      const grouped = models.length > 1;
      for (const model of models) {
        const rows = modelDetail(model, t, tFn);
        if (rows.length === 0) continue;
        blocks.push(h('div', { key: model.key, className: 'dsc-group' },
          grouped
            ? h('div', { className: 'dsc-groupTitle' },
              h('span', null, model.key),
              h('span', { className: 'dsc-groupAmount' }, tFn(model.cost, model.currency) ?? ''))
            : null,
          h('dl', { className: 'dsc-details' }, rows),
          unitBlock(model, current, t),
        ));
      }
      const footer = [];
      if (unpriced.length > 0) {
        footer.push(h('dt', { key: 'unpriced:l' }, t('cost.dialog.unpriced')));
        footer.push(h('dd', { key: 'unpriced:v' }, unpriced.map((item) => `${item.key} (${tokenText(sumOf(item.tokens))} tok)`).join(', ')));
      }
      if (cost.holidayCoverage?.incomplete === true) {
        footer.push(h('dt', { key: 'coverage:l' }, t('cost.dialog.coverage')));
        footer.push(h('dd', { key: 'coverage:v' }, t('cost.holiday', { end: String(cost.holidayCoverage.end ?? '') })));
      }
      if (footer.length > 0) blocks.push(h('div', { key: 'footer', className: 'dsc-group' }, h('dl', { className: 'dsc-details' }, footer)));
      return blocks;
    }

    function CostPill(props) {
      const useProjection = props.useProjection;
      const t = props.t;
      const cost = typeof useProjection === 'function' ? useProjection('sessionCost') : undefined;
      const [open, setOpen] = React.useState(false);
      const { rootRef, panelRef, pos } = useAnchored(open);
      useDismiss(open, setOpen, rootRef, panelRef);
      const now = useNow(open);
      if (cost === undefined || cost === null) return null;
      const status = cost.priced;
      if (status !== 'full' && status !== 'partial' && status !== 'none') return null;
      // `none` still shows a marker: spend exists but nothing could be priced,
      // and silence would read as "free".
      const text = status === 'none' ? '?' : totalText(cost.currencies);
      if (text === null) return null;
      const label = status === 'partial' ? `${text}*` : text;
      const ariaLabel = typeof t === 'function' ? t('cost.aria', { total: text }) : text;
      const panel = open
        ? ReactDOM.createPortal(
          h('div', {
            ref: panelRef,
            className: 'dsc-panel',
            role: 'dialog',
            'aria-label': typeof t === 'function' ? t('cost.dialog.title') : 'session cost',
            style: pos ?? MEASURE_STYLE,
          },
          h('div', { className: 'dsc-title' },
            h('span', { className: 'dsc-titleLabel' }, h(CostIcon), typeof t === 'function' ? t('cost.dialog.title') : 'session cost'),
            h('span', { className: 'dsc-titleValue' }, exactTotalText(cost.currencies, t))),
          h('div', { className: 'dsc-titleRule', 'aria-hidden': true }),
          dialogBody(cost, typeof t === 'function' ? t : (key) => key, now)),
          document.body)
        : null;
      return h('span', { className: 'dsc-anchor', ref: rootRef, 'data-composer-stat': 'cost' },
        h('button', {
          type: 'button',
          className: 'dsc-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': ariaLabel,
          title: titleOf(cost, t),
          onClick: () => setOpen(!open),
        },
        h(CostIcon),
        h('span', { className: 'dsc-label' }, label)),
        panel);
    }

    /**
     * Contain any render failure to this one dock cell: an exception inside a
     * slot entry otherwise blanks the entry and surfaces as "slot entry crashed".
     */
    class CostBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    function CostCell(props) {
      return h(CostBoundary, null, h(CostPill, props));
    }

    const ZH = {
      'cost.title': '本会话花费（估算；价目 CNY {cny} / USD {usd}）',
      'cost.partial': '另有 {count} 个模型没有价目，金额未计入',
      'cost.holiday': '节假日表仅覆盖到 {end}，之后按工作日/周末估算',
      'cost.aria': '本会话花费 {total}，打开明细',
      'cost.dialog.title': '本会话花费',
      'cost.dialog.model': '模型',
      'cost.dialog.input': '未缓存输入',
      'cost.dialog.cacheRead': '缓存读取',
      'cost.dialog.cacheWrite': '缓存写入',
      'cost.dialog.output': '输出',
      'cost.dialog.peak': '高峰时段',
      'cost.dialog.off': '空闲时段',
      'cost.dialog.unpriced': '未定价',
      'cost.dialog.coverage': '节假日表',
      'cost.dialog.empty': '本会话还没有可计价的用量。',
      'cost.dialog.none': '—',
      'cost.dialog.peakShort': '高峰价',
      'cost.dialog.offShort': '空闲价',
      'cost.dialog.nextPeak': '距高峰',
      'cost.dialog.nextOff': '距空闲',
      'cost.dialog.unit': '单价（每百万 tokens）',
      'cost.dialog.unitPeak': '高峰',
      'cost.dialog.unitOff': '空闲',
      'cost.dialog.priceInput': '输入',
      'cost.dialog.priceCacheRead': '缓存读',
      'cost.dialog.priceCacheWrite': '缓存写',
      'cost.dialog.priceOutput': '输出',
    };
    const EN = {
      'cost.title': 'Session spend (estimate; prices CNY {cny} / USD {usd})',
      'cost.partial': '{count} model(s) have no price yet and are not in the total',
      'cost.holiday': 'Holiday table covers through {end}; later dates use weekday/weekend only',
      'cost.aria': 'Session spend {total}; open details',
      'cost.dialog.title': 'Session spend',
      'cost.dialog.model': 'Model',
      'cost.dialog.input': 'Uncached input',
      'cost.dialog.cacheRead': 'Cache read',
      'cost.dialog.cacheWrite': 'Cache write',
      'cost.dialog.output': 'Output',
      'cost.dialog.peak': 'Peak window',
      'cost.dialog.off': 'Off-peak',
      'cost.dialog.unpriced': 'Unpriced',
      'cost.dialog.coverage': 'Holiday table',
      'cost.dialog.empty': 'No priced usage in this session yet.',
      'cost.dialog.none': '—',
      'cost.dialog.peakShort': 'Peak rate',
      'cost.dialog.offShort': 'Off-peak rate',
      'cost.dialog.nextPeak': 'until peak',
      'cost.dialog.nextOff': 'until off-peak',
      'cost.dialog.unit': 'Unit price (per 1M tokens)',
      'cost.dialog.unitPeak': 'Peak',
      'cost.dialog.unitOff': 'Off-peak',
      'cost.dialog.priceInput': 'input',
      'cost.dialog.priceCacheRead': 'cache read',
      'cost.dialog.priceCacheWrite': 'cache write',
      'cost.dialog.priceOutput': 'output',
    };

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Locale registration is an effect: the disposers must run on unload or
        // a reload throws "already has locale" and the whole Client half fails.
        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', ZH);
          const disposeEn = ctx.locale.register(NS, 'en', EN);
          return () => {
            if (typeof disposeZh === 'function') disposeZh();
            if (typeof disposeEn === 'function') disposeEn();
          };
        });
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = '@rokyzevon/dsh-session-cost';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        });
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'session-cost', order: 2, locale: NS },
          CostCell,
        ));
      },
    };
  },
});
