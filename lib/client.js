/**
 * dsh-token-usage - browser half.
 *
 * Registers a "Token 统计" page in Settings. It reads the host aggregation
 * over /dsh-token-usage/summary, supports a custom (one-sided or two-sided)
 * date window, and renders one quota row per provider from
 * /dsh-token-usage/quota. Hand-authored in the __ModuleLoader__ format; the
 * only runtime import is React from the platform module table.
 */
window.__ModuleLoader__.load({
  // Must equal the package name: the boot manifest keys this bundle's graph row
  // by package name, and the loader rejects a bundle that registers any other id.
  id: '@liuguangzhe/dsh-token-usage',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const NUMBER = new Intl.NumberFormat('en-US');
    const BORDER = '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))';
    const DIVIDER = '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))';
    const INPUT_BASE = { fontSize: 12, padding: '4px 6px', borderRadius: 6, border: BORDER, background: 'transparent', color: 'inherit', colorScheme: 'light dark' };
    const EMPTY_ENTRY = { enabled: false, amount: '', unit: '亿', refreshDay: '1', label: '' };

    function formatNumber(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '0';
      return NUMBER.format(value);
    }

    /** Compact Chinese-unit form for large token counts: 4.70 亿 / 1122.4 万. */
    function formatUnits(value) {
      const n = typeof value === 'number' && isFinite(value) ? value : 0;
      const abs = Math.abs(n);
      if (abs >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
      if (abs >= 1e4) {
        const wan = n / 1e4;
        // 9999.9万 would round up to 10000.0万; promote it to 1.00亿 instead.
        if (Math.abs(wan) >= 9999.95) return (n / 1e8).toFixed(2) + ' 亿';
        return wan.toFixed(1) + ' 万';
      }
      return NUMBER.format(n);
    }

    const RANGES = [
      { id: 'all', label: '全部' },
      { id: 'today', label: '今天' },
      { id: '7d', label: '近 7 天' },
      { id: '30d', label: '近 30 天' },
      { id: 'custom', label: '自定义日期' }
    ];

    /** Table grouping: unchanged from before the chart (the issue asked for an additive view). */
    const GROUPS = [
      { id: 'day', label: '按天' },
      { id: 'model', label: '按模型' },
      { id: 'project', label: '按项目' },
      { id: 'provider', label: '按 Provider' }
    ];

    /** Chart stack dimension. It drives the chart legend only; the table keeps its own GROUPS selector. */
    const DIMS = [
      { id: 'model', label: '模型' },
      { id: 'provider', label: '来源' },
      { id: 'project', label: '项目' },
      { id: 'token', label: 'Token 类型' }
    ];

    /** Token types keep fixed colors (input/output/cacheRead are the counted buckets). */
    const TOKEN_TYPE_COLORS = { input: '#3b82f6', output: '#22c55e', cacheRead: '#a855f7' };
    const TOKEN_TYPE_LABELS = { input: '输入', output: '输出', cacheRead: '缓存读取' };
    const TOKEN_TYPE_SERIES = ['input', 'output', 'cacheRead'];
    /** Extended palette: hash-picked base colors, with collision avoidance in seriesColorMap. */
    const SERIES_PALETTE = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#dc2626', '#0d9488', '#ca8a04', '#4f46e5', '#db2777', '#65a30d', '#0891b2', '#7c3aed'];
    /** Series beyond Top-N aggregate under this key. */
    const OTHER_SERIES_KEY = '__other__';
    const OTHER_SERIES_LABEL = '其他';
    const OTHER_SERIES_COLOR = '#94a3b8';
    const TREND_TOP_N = 8;
    const MAX_CHART_BUCKETS = 1000;

    /** Time-bucket granularity, finest to coarsest; 'auto' resolves from the selected range. */
    const GRANULARITIES = [
      { id: 'auto', label: '自动', minutes: 0 },
      { id: '5m', label: '5 分钟', minutes: 5 },
      { id: '15m', label: '15 分钟', minutes: 15 },
      { id: '30m', label: '30 分钟', minutes: 30 },
      { id: 'hour', label: '小时', minutes: 60 },
      { id: 'day', label: '天', minutes: 1440 },
      { id: 'week', label: '周', minutes: 10080 },
      { id: 'month', label: '月', minutes: 43830 }
    ];
    const GRAN_LABELS = {};
    const GRAN_MINUTES = {};
    for (const item of GRANULARITIES) {
      GRAN_LABELS[item.id] = item.label;
      GRAN_MINUTES[item.id] = item.minutes;
    }
    const MAX_BUCKETS = 1000;

    function granLabel(id) { return GRAN_LABELS[id] || id; }

    /** Resolve 'auto' into a concrete granularity from the selected range span. */
    function autoGranularity(range, from, to, coverage) {
      let days;
      if (range === 'today') days = 1;
      else if (range === '7d') days = 7;
      else if (range === '30d' || range === 'month') days = 31;
      else if (range === 'custom' && (from || to)) {
        const start = from || (coverage && coverage.firstDay) || null;
        const end = to || (coverage && coverage.lastDay) || null;
        days = start && end ? Math.max(1, (Date.parse(end) - Date.parse(start)) / 86400000 + 1) : 365;
      } else {
        const first = coverage && coverage.firstDay;
        const last = coverage && coverage.lastDay;
        days = first && last ? Math.max(1, (Date.parse(last) - Date.parse(first)) / 86400000 + 1) : 365;
      }
      if (days <= 1) return 'hour';
      // Up to a quarter of daily bars stays readable and matches the issue's
      // "daily trend" intent; weekly/monthly only for longer windows.
      if (days <= 90) return 'day';
      if (days <= 700) return 'week';
      return 'month';
    }

    function seriesColorIndex(name) {
      let hash = 5381;
      for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
      return hash % SERIES_PALETTE.length;
    }

    /**
     * Deterministic name→color mapping for the series currently on screen.
     * The hash keeps a series' base color stable across renders/ranges;
     * collisions are resolved in key order so two visible series never share
     * a swatch (8 series into 12 colors collides often otherwise).
     */
    function seriesColorMap(keys, stackBy) {
      const map = new Map();
      if (stackBy === 'token') {
        for (const key of keys) map.set(key, TOKEN_TYPE_COLORS[key] || OTHER_SERIES_COLOR);
        return map;
      }
      const used = new Set();
      for (const key of [...keys].sort()) {
        if (key === OTHER_SERIES_KEY) { map.set(key, OTHER_SERIES_COLOR); continue; }
        let index = seriesColorIndex(key);
        let guard = 0;
        while (used.has(index) && guard < SERIES_PALETTE.length) {
          index = (index + 1) % SERIES_PALETTE.length;
          guard += 1;
        }
        used.add(index);
        map.set(key, SERIES_PALETTE[index]);
      }
      return map;
    }

    function seriesLabel(key, stackBy) {
      if (stackBy === 'token') return TOKEN_TYPE_LABELS[key] || key;
      if (key === OTHER_SERIES_KEY) return OTHER_SERIES_LABEL;
      return key;
    }

    /**
     * Normalize a time-bucket row into stack segments for the chosen dimension.
     * token: from the row's own totals; others: from the server-side `series`
     * breakdown, aggregated to Top-N + "其他" by grand total.
     */
    function chartSegments(row, dim, topKeys, hasOther) {
      if (dim === 'token') {
        return TOKEN_TYPE_SERIES.map((key) => ({ key, total: row[key] || 0 }));
      }
      return (row.series || []).map((entry) => ({
        key: topKeys.indexOf(entry.key) >= 0 ? entry.key : (hasOther ? OTHER_SERIES_KEY : entry.key),
        total: entry.total
      }));
    }

    const styles = {
      root: { padding: '4px 2px 28px', color: 'var(--dsh-text-primary, inherit)', fontSize: 13, lineHeight: 1.5 },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      title: { fontSize: 16, fontWeight: 600 },
      subtitle: { fontSize: 12, opacity: 0.65, marginTop: 2 },
      actions: { display: 'flex', gap: 8 },
      button: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: BORDER, background: 'transparent', color: 'inherit', cursor: 'pointer' },
      error: { marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'rgba(220,60,60,0.12)', color: '#d05a5a', fontSize: 12 },
      muted: { marginTop: 16, opacity: 0.6 },
      cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 10, marginTop: 16 },
      card: { padding: '10px 12px', borderRadius: 8, minWidth: 0, overflow: 'hidden', border: '1px solid var(--dsh-border, rgba(128,128,128,0.28))', background: 'var(--dsh-surface-subtle, rgba(128,128,128,0.06))' },
      cardPrimary: { borderColor: 'var(--dsh-accent, rgba(80,140,255,0.6))' },
      cardLabel: { fontSize: 11, opacity: 0.6 },
      cardValue: { fontSize: 18, fontWeight: 600, marginTop: 2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      cardValuePrimary: { fontSize: 24 },
      cardExact: { fontSize: 10, opacity: 0.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      row: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 },
      rowLabel: { fontSize: 11, opacity: 0.55, alignSelf: 'center', marginRight: 2 },
      chip: { fontSize: 12, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--dsh-border, rgba(128,128,128,0.3))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      chipActive: { background: 'var(--dsh-accent, #3b82f6)', borderColor: 'var(--dsh-accent, #3b82f6)', color: '#fff' },
      dateRow: { display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginTop: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 },
      fieldLabel: { opacity: 0.6 },
      input: Object.assign({}, INPUT_BASE, { width: 110 }),
      inputSmall: Object.assign({}, INPUT_BASE, { width: 64 }),
      inputWide: Object.assign({}, INPUT_BASE, { width: 150 }),
      select: Object.assign({}, INPUT_BASE, { width: 62 }),
      selectWide: Object.assign({}, INPUT_BASE, { width: 240 }),
      dateInput: Object.assign({}, INPUT_BASE, { width: 140 }),
      hint: { fontSize: 11, opacity: 0.55, maxWidth: 380 },
      quota: { marginTop: 18, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28))', background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06))' },
      quotaHead: { display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' },
      quotaTitle: { fontSize: 13, fontWeight: 600 },
      quotaCycle: { fontSize: 11, opacity: 0.6 },
      quotaRow: { paddingTop: 10, marginTop: 10, borderTop: DIVIDER },
      quotaRowHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      quotaToggle: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 },
      quotaRowActions: { display: 'inline-flex', alignItems: 'baseline', gap: 10 },
      linkButton: { fontSize: 11, padding: '2px 4px', border: 'none', background: 'transparent', color: 'inherit', opacity: 0.6, cursor: 'pointer', textDecoration: 'underline' },
      quotaFields: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginTop: 10 },
      quotaAdd: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      quotaSummary: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, marginTop: 8, flexWrap: 'wrap' },
      quotaCol: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      quotaColRight: { alignItems: 'flex-end', textAlign: 'right' },
      quotaColLabel: { fontSize: 11, opacity: 0.6 },
      quotaColValue: { fontSize: 26, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 },
      quotaColValueSmall: { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 },
      quotaColExact: { fontSize: 10, opacity: 0.5, fontVariantNumeric: 'tabular-nums' },
      quotaMeter: { marginTop: 8, height: 8, borderRadius: 999, background: 'rgba(128,128,128,0.2)', overflow: 'hidden' },
      quotaMeterFill: { height: '100%', borderRadius: 999, transition: 'width 0.3s ease' },
      quotaStats: { display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 6, fontSize: 11, opacity: 0.7, flexWrap: 'wrap' },
      quotaHint: { marginTop: 6, fontSize: 11, opacity: 0.6 },
      quotaOk: { fontSize: 11, marginTop: 6, color: '#2e9e63' },
      quotaError: { fontSize: 11, marginTop: 6, color: '#d05a5a' },
      quotaForm: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: DIVIDER },
      tableWrap: { marginTop: 14, maxHeight: 'min(58vh, 560px)', overflow: 'auto', overscrollBehavior: 'contain', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, rgba(30,30,32,0.98))' },
      table: { width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' },
      th: { position: 'sticky', top: 0, zIndex: 1, background: 'var(--dsw-alias-bg-layer-2, rgba(30,30,32,0.98))', boxShadow: 'inset 0 -1px 0 var(--dsw-alias-border-l1, rgba(128,128,128,0.25))', textAlign: 'left', fontSize: 11, fontWeight: 500, color: 'var(--dsw-alias-label-caption, rgba(170,170,170,0.95))', padding: '6px 8px', whiteSpace: 'nowrap' },
      thNum: { textAlign: 'right' },
      td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.14))', whiteSpace: 'nowrap' },
      tdName: { maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' },
      truncated: { fontSize: 11, opacity: 0.55, marginTop: 6 },
      chart: { marginTop: 14, padding: '10px 12px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))', background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06))' },
      chartSvg: { display: 'block', width: '100%', height: 'auto' },
      chartLegend: { display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10, fontSize: 12, opacity: 0.9 },
      chartLegendItem: { display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chartSwatch: { width: 10, height: 10, borderRadius: 2, flex: '0 0 auto' },
      chartMore: { marginTop: 6, fontSize: 12, opacity: 0.55 },
      footer: { marginTop: 14, fontSize: 11, opacity: 0.55 }
    };

    function card(label, value, primary) {
      const compact = formatUnits(value);
      const exact = formatNumber(value);
      return h('div', { key: label, style: primary ? Object.assign({}, styles.card, styles.cardPrimary) : styles.card },
        h('div', { style: styles.cardLabel }, label),
        h('div', { title: exact, style: primary ? Object.assign({}, styles.cardValue, styles.cardValuePrimary) : styles.cardValue }, compact),
        compact === exact ? null : h('div', { style: styles.cardExact }, exact)
      );
    }

    function chip(label, active, onClick) {
      return h('button', { key: label, type: 'button', onClick, style: active ? Object.assign({}, styles.chip, styles.chipActive) : styles.chip }, label);
    }

    function field(label, control) {
      return h('label', { key: label, style: styles.field }, h('span', { style: styles.fieldLabel }, label), control);
    }

    function table(rows) {
      const head = h('tr', null,
        h('th', { style: styles.th }, '名称'),
        h('th', { style: Object.assign({}, styles.th, styles.thNum) }, '合计'),
        h('th', { style: Object.assign({}, styles.th, styles.thNum) }, '输入'),
        h('th', { style: Object.assign({}, styles.th, styles.thNum) }, '输出'),
        h('th', { style: Object.assign({}, styles.th, styles.thNum) }, '缓存读取'),
        h('th', { style: Object.assign({}, styles.th, styles.thNum) }, '调用')
      );
      const body = rows.slice(0, 200).map((row) => h('tr', { key: row.key },
        h('td', { style: Object.assign({}, styles.td, styles.tdName), title: row.key }, row.label),
        h('td', { style: Object.assign({}, styles.td, styles.thNum) }, formatNumber(row.total)),
        h('td', { style: Object.assign({}, styles.td, styles.thNum) }, formatNumber(row.input)),
        h('td', { style: Object.assign({}, styles.td, styles.thNum) }, formatNumber(row.output)),
        h('td', { style: Object.assign({}, styles.td, styles.thNum) }, formatNumber(row.cacheRead)),
        h('td', { style: Object.assign({}, styles.td, styles.thNum) }, formatNumber(row.calls))
      ));
      return h('div', { style: styles.tableWrap }, h('table', { style: styles.table }, h('thead', null, head), h('tbody', null, body)));
    }

    /**
     * Stacked bar trend chart, hand-drawn in SVG so the plugin stays
     * dependency-free. `rows` are time buckets; `seriesOrder` is the global
     * series ranking (grand total desc) from the server, unused for token.
     */
    function stackedChart(rows, dim, seriesOrder) {
      const shown = rows.slice(-MAX_CHART_BUCKETS);
      let topKeys = null;
      let hasOther = false;
      if (dim !== 'token') {
        const ranked = (seriesOrder || []).map((item) => item.key);
        topKeys = ranked.slice(0, TREND_TOP_N);
        hasOther = ranked.length > topKeys.length;
      }
      const keys = dim === 'token'
        ? TOKEN_TYPE_SERIES.slice()
        : (topKeys || []).concat(hasOther ? [OTHER_SERIES_KEY] : []);
      // Merge segments that collapsed onto __other__ within a bucket.
      const buckets = shown.map((row) => {
        const totals = new Map();
        for (const segment of chartSegments(row, dim, topKeys, hasOther)) {
          totals.set(segment.key, (totals.get(segment.key) || 0) + segment.total);
        }
        return { key: row.key, label: row.label, total: row.total, totals };
      });

      const width = 960;
      const height = 340;
      const padLeft = 76;
      const padRight = 20;
      const padTop = 16;
      const padBottom = 48;
      const plotW = width - padLeft - padRight;
      const plotH = height - padTop - padBottom;
      const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
      // 4 gridlines at "nice" round steps keeps the y labels readable.
      const step = Math.pow(10, Math.floor(Math.log10(max)));
      const niceMax = Math.ceil(max / step) * step;
      const yFor = (value) => padTop + plotH - (value / niceMax) * plotH;
      const gap = plotW / Math.max(1, buckets.length);
      // One-pixel bars keep dense windows (up to the 1000-bucket cap) from
      // turning into an overlapping solid block.
      const barW = Math.max(1, Math.min(40, gap - 1));
      const labelEvery = Math.max(1, Math.ceil(buckets.length / 10));
      const colorMap = seriesColorMap(keys, dim);

      const gridlines = [];
      for (let i = 0; i <= 4; i++) {
        const value = (niceMax / 4) * i;
        const y = yFor(value);
        gridlines.push(h('g', { key: 'grid' + i },
          h('line', { x1: padLeft, x2: width - padRight, y1: y, y2: y, stroke: 'rgba(128,128,128,0.22)', strokeWidth: 1 }),
          h('text', { x: padLeft - 10, y: y + 5, textAnchor: 'end', fontSize: 12, fill: 'currentColor', opacity: 0.65 }, formatUnits(value))
        ));
      }

      const bars = buckets.map((bucket, index) => {
        const x = padLeft + gap * index + (gap - barW) / 2;
        const segments = [];
        let cursor = bucket.total;
        // Draw from the top of the stack downwards in series order; tiny
        // segments stay hoverable because later rects start below them.
        for (const key of keys) {
          const value = bucket.totals.get(key) || 0;
          if (value <= 0) continue;
          const yTop = yFor(cursor);
          cursor -= value;
          const yBottom = yFor(cursor);
          segments.push(h('rect', {
            key,
            x, y: yTop, width: barW, height: Math.max(0, yBottom - yTop),
            fill: colorMap.get(key) || OTHER_SERIES_COLOR
          }));
        }
        const hover = bucket.label + ' 合计 ' + formatUnits(bucket.total) + '（' + formatNumber(bucket.total) + '）'
          + (keys.length > 0 ? '\n' + keys.filter((key) => (bucket.totals.get(key) || 0) > 0)
              .map((key) => seriesLabel(key, dim) + '：' + formatUnits(bucket.totals.get(key))).join('\n') : '');
        return h('g', { key: bucket.key },
          h('title', null, hover),
          segments,
          index % labelEvery === 0
            ? h('text', { x: padLeft + gap * index + gap / 2, y: height - padBottom + 22, textAnchor: 'middle', fontSize: 12, fill: 'currentColor', opacity: 0.65 }, bucket.label.length <= 7 ? bucket.label : bucket.label.slice(5))
            : null
        );
      });

      const legend = h('div', { style: styles.chartLegend },
        keys.map((key) => h('span', { key, style: styles.chartLegendItem, title: seriesLabel(key, dim) },
          h('span', { style: Object.assign({}, styles.chartSwatch, { background: colorMap.get(key) || OTHER_SERIES_COLOR }) }),
          seriesLabel(key, dim)
        ))
      );

      return h('div', { style: styles.chart },
        h('svg', { viewBox: '0 0 ' + width + ' ' + height, style: styles.chartSvg, role: 'img', 'aria-label': 'token 消耗堆叠柱状图' },
          gridlines,
          h('line', { x1: padLeft, x2: padLeft, y1: padTop, y2: padTop + plotH, stroke: 'rgba(128,128,128,0.4)', strokeWidth: 1 }),
          bars
        ),
        legend,
        rows.length > MAX_CHART_BUCKETS ? h('div', { style: styles.chartMore }, '图表仅显示最近 ' + MAX_CHART_BUCKETS + ' 个桶（共 ' + rows.length + ' 个），可缩小范围或调粗颗粒度') : null
      );
    }

    /** One quota row: provider toggle, optional progress, and its config fields. */
    function quotaRow(item, form, onChange, onRemove) {
      const enabled = !!form.enabled;
      const configured = !!(item.configured && enabled);
      const ratio = configured ? item.percent : 0;
      const over = configured && item.used > item.quotaTokens;
      const meterColor = over ? '#e05252' : ratio >= 0.9 ? '#e0a24a' : 'var(--dsw-alias-brand-primary, #3b82f6)';
      const title = item.label && item.label !== item.provider ? item.provider + '（' + item.label + '）' : item.provider;
      const cycleText = configured
        ? item.cycle.fromDay + ' ~ ' + item.cycle.toDay + ' · 每月 ' + item.config.refreshDay + ' 日刷新'
        : (item.total > 0 ? '累计已用 ' + formatUnits(item.total) : '暂无用量');
      return h('div', { key: item.provider, style: styles.quotaRow },
        h('div', { style: styles.quotaRowHead },
          h('label', { style: styles.quotaToggle },
            h('input', { type: 'checkbox', checked: enabled, onChange: (e) => onChange({ enabled: e.target.checked }) }),
            h('span', null, title)
          ),
          h('div', { style: styles.quotaRowActions },
            h('span', { style: styles.quotaCycle }, cycleText),
            onRemove ? h('button', { type: 'button', onClick: onRemove, style: styles.linkButton }, '移除') : null
          )
        ),
        configured
          ? h('div', null,
              h('div', { style: styles.quotaSummary },
                h('div', { style: styles.quotaCol },
                  h('div', { style: styles.quotaColLabel }, '本周期剩余'),
                  h('div', { style: styles.quotaColValue }, formatUnits(item.remaining)),
                  h('div', { style: styles.quotaColExact }, formatNumber(item.remaining))
                ),
                h('div', { style: Object.assign({}, styles.quotaCol, styles.quotaColRight) },
                  h('div', { style: styles.quotaColLabel }, '本月额度'),
                  h('div', { style: styles.quotaColValueSmall }, formatUnits(item.quotaTokens)),
                  h('div', { style: styles.quotaColExact }, formatNumber(item.quotaTokens))
                )
              ),
              h('div', { style: styles.quotaMeter },
                h('div', { style: Object.assign({}, styles.quotaMeterFill, { width: Math.min(100, ratio * 100).toFixed(1) + '%', background: meterColor }) })
              ),
              h('div', { style: styles.quotaStats },
                h('span', null, '进度 = 已用 ' + formatUnits(item.used) + '（' + (ratio * 100).toFixed(1) + '%）'),
                h('span', null, over ? '已超额 ' + formatUnits(item.used - item.quotaTokens) : '剩余 ' + ((1 - ratio) * 100).toFixed(1) + '%')
              )
            )
          : h('div', { style: styles.quotaHint }, enabled ? '填写额度后可查看本周期剩余。' : '未启用额度统计，仅记录用量。'),
        h('div', { style: styles.quotaFields },
          field('名称（可选）', h('input', { type: 'text', value: form.label, placeholder: item.provider, maxLength: 60, onChange: (e) => onChange({ label: e.target.value }), style: styles.inputWide })),
          field('本月额度', h('input', { type: 'number', min: '0', step: 'any', value: form.amount, placeholder: '20', onChange: (e) => onChange({ amount: e.target.value }), style: styles.input })),
          field('单位', h('select', { value: form.unit, onChange: (e) => onChange({ unit: e.target.value }), style: styles.select },
            h('option', { value: '亿' }, '亿'),
            h('option', { value: '万' }, '万'),
            h('option', { value: '个' }, '个')
          )),
          field('每月刷新日', h('input', { type: 'number', min: '1', max: '31', value: form.refreshDay, onChange: (e) => onChange({ refreshDay: e.target.value }), style: styles.inputSmall }))
        )
      );
    }

    function TokenUsageSection() {
      const [range, setRange] = React.useState('all');
      const [groupBy, setGroupBy] = React.useState('day');
      const [dim, setDim] = React.useState('model');
      const [gran, setGran] = React.useState('auto');
      const [showChart, setShowChart] = React.useState(true);
      const [from, setFrom] = React.useState('');
      const [to, setTo] = React.useState('');
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [chart, setChart] = React.useState(null);
      const [chartError, setChartError] = React.useState(null);
      const [rescanning, setRescanning] = React.useState(false);
      const [quota, setQuota] = React.useState(null);
      const [rows, setRows] = React.useState([]);
      const [available, setAvailable] = React.useState([]);
      const [pick, setPick] = React.useState('');
      const [quotaForm, setQuotaForm] = React.useState({});
      const [quotaReady, setQuotaReady] = React.useState(false);
      const [quotaDirty, setQuotaDirty] = React.useState(false);
      const [quotaError, setQuotaError] = React.useState('');
      const [quotaSaved, setQuotaSaved] = React.useState(false);
      const [savingQuota, setSavingQuota] = React.useState(false);
      const mounted = React.useRef(true);

      const coverageForGran = data ? data.coverage : null;
      const granDays = (() => {
        if (range === 'today') return 1;
        if (range === '7d') return 7;
        if (range === '30d' || range === 'month') return 31;
        if (range === 'custom' && (from || to)) {
          const start = from || (coverageForGran && coverageForGran.firstDay) || null;
          const end = to || (coverageForGran && coverageForGran.lastDay) || null;
          return start && end ? Math.max(1, (Date.parse(end) - Date.parse(start)) / 86400000 + 1) : 365;
        }
        const first = coverageForGran && coverageForGran.firstDay;
        const last = coverageForGran && coverageForGran.lastDay;
        return first && last ? Math.max(1, (Date.parse(last) - Date.parse(first)) / 86400000 + 1) : 365;
      })();
      const overCap = (minutes) => minutes > 0 && (granDays * 1440) / minutes > MAX_BUCKETS;

      // X axis = time granularity ('auto' derives from the range span); the
      // stack dimension is orthogonal. A fine granularity left over from a
      // shorter range falls back to 'auto' for this render as well as in the
      // sync effect below, so the request can never be silently coarsened.
      const activeGran = gran !== 'auto' && overCap(GRAN_MINUTES[gran]) ? 'auto' : gran;
      const effGran = activeGran === 'auto' ? autoGranularity(range, from, to, coverageForGran) : activeGran;

      const rangeParams = () => {
        if (range !== 'custom') return ['range=' + encodeURIComponent(range)];
        if (!from && !to) return ['range=all'];
        const params = ['range=custom'];
        if (from) params.push('from=' + encodeURIComponent(from));
        if (to) params.push('to=' + encodeURIComponent(to));
        return params;
      };

      // The table keeps its pre-chart behaviour: exact requested grouping
      // (coarsen=0), no series, no zero-filled buckets.
      const summaryUrl = React.useMemo(
        () => '/dsh-token-usage/summary?' + ['groupBy=' + encodeURIComponent(groupBy), 'coarsen=0'].concat(rangeParams()).join('&'),
        [groupBy, range, from, to]
      );

      // The chart is its own request: time buckets + stack series, with empty
      // buckets filled so real gaps are visible. Wait for the first table
      // response so 'auto' uses the real coverage span instead of guessing.
      const chartUrl = React.useMemo(() => {
        if (!showChart || !data) return null;
        const params = ['groupBy=' + encodeURIComponent(effGran), 'fill=1'];
        if (dim !== 'token') params.push('series=' + encodeURIComponent(dim));
        return '/dsh-token-usage/summary?' + params.concat(rangeParams()).join('&');
      }, [showChart, data, effGran, dim, range, from, to]);

      const load = React.useCallback(() => {
        setLoading(true);
        return fetch(summaryUrl, { cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (!mounted.current) return;
            if (payload && payload.ok) { setData(payload.data); setError(null); }
            else setError('响应格式不正确');
          })
          .catch((err) => { if (mounted.current) setError(err && err.message ? err.message : String(err)); })
          .finally(() => { if (mounted.current) setLoading(false); });
      }, [summaryUrl]);

      const loadChart = React.useCallback(() => {
        if (!chartUrl) return Promise.resolve();
        setChartError(null);
        return fetch(chartUrl, { cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (!mounted.current) return;
            if (payload && payload.ok) { setChart({ url: chartUrl, data: payload.data }); setChartError(null); }
            else setChartError('响应格式不正确');
          })
          .catch((err) => { if (mounted.current) setChartError(err && err.message ? err.message : String(err)); });
      }, [chartUrl]);

      const loadAll = () => { load(); loadChart(); };

      const loadQuota = React.useCallback(() => {
        return fetch('/dsh-token-usage/quota', { cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => { if (mounted.current && payload && payload.ok) setQuota(payload.data); })
          .catch(() => {});
      }, []);

      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);

      React.useEffect(() => { load(); }, [load]);
      React.useEffect(() => { loadChart(); }, [loadChart]);
      React.useEffect(() => { loadQuota(); }, [loadQuota]);

      // Keep the picker state honest when the range/coverage grows past a
      // previously selected fine granularity.
      React.useEffect(() => {
        if (gran !== 'auto' && overCap(GRAN_MINUTES[gran])) setGran('auto');
      }, [gran, granDays]);

      React.useEffect(() => {
        if (!quota || quotaDirty) return;
        setRows(Array.isArray(quota.providers) ? quota.providers : []);
        setAvailable(Array.isArray(quota.available) ? quota.available : []);
        if (!quotaReady) {
          const form = {};
          for (const item of (quota.providers || [])) {
            const config = item.config || {};
            form[item.provider] = {
              enabled: !!item.enabled,
              amount: config.amount > 0 ? String(config.amount) : '',
              unit: config.unit || '亿',
              refreshDay: String(config.refreshDay || 1),
              label: config.label || ''
            };
          }
          setQuotaForm(form);
          setQuotaReady(true);
        }
      }, [quota, quotaReady, quotaDirty]);

      React.useEffect(() => {
        const timer = setInterval(() => { load(); loadChart(); loadQuota(); }, 30000);
        return () => clearInterval(timer);
      }, [load, loadChart, loadQuota]);

      const rescan = () => {
        setRescanning(true);
        fetch('/dsh-token-usage/rescan', { method: 'POST' })
          .then(() => { loadAll(); loadQuota(); })
          .catch(() => {})
          .finally(() => { if (mounted.current) setRescanning(false); });
      };

      const entryOf = (provider) => quotaForm[provider] || EMPTY_ENTRY;

      const addProvider = (provider) => {
        const picked = available.find((item) => item.provider === provider);
        setAvailable(available.filter((item) => item.provider !== provider));
        setRows(rows.concat([{ provider, label: provider, enabled: false, configured: false, total: picked ? picked.total : 0, config: {} }]));
        setQuotaForm(Object.assign({}, quotaForm, { [provider]: Object.assign({}, EMPTY_ENTRY) }));
        setQuotaDirty(true);
        setQuotaSaved(false);
        setQuotaError('');
      };

      const removeProvider = (provider) => {
        const item = rows.find((row) => row.provider === provider);
        setRows(rows.filter((row) => row.provider !== provider));
        if (item) setAvailable(available.concat([{ provider, total: item.total || 0 }]));
        const next = Object.assign({}, quotaForm);
        delete next[provider];
        setQuotaForm(next);
        setQuotaDirty(true);
        setQuotaSaved(false);
        setQuotaError('');
      };

      const editQuotaProvider = (provider, patch) => {
        setQuotaDirty(true);
        setQuotaSaved(false);
        setQuotaError('');
        const next = Object.assign({}, entryOf(provider), patch);
        // Ticking 启用 on an empty row seeds a real, saveable default so the
        // first save is not a silent no-op.
        if (patch.enabled === true && !next.amount) next.amount = '20';
        setQuotaForm(Object.assign({}, quotaForm, { [provider]: next }));
      };

      const saveQuota = () => {
        const payload = {};
        for (const item of rows) {
          const form = entryOf(item.provider);
          const amount = Number(form.amount);
          const refreshDay = Math.round(Number(form.refreshDay));
          if (form.enabled) {
            if (!Number.isFinite(amount) || amount <= 0) {
              setQuotaSaved(false);
              setQuotaError('已启用的接入方需要填写大于 0 的额度（' + item.provider + '）');
              return;
            }
            if (!Number.isFinite(refreshDay) || refreshDay < 1 || refreshDay > 31) {
              setQuotaSaved(false);
              setQuotaError('刷新日需在 1–31 之间（' + item.provider + '）');
              return;
            }
          }
          payload[item.provider] = {
            enabled: !!form.enabled,
            amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
            unit: form.unit,
            refreshDay: Number.isFinite(refreshDay) && refreshDay >= 1 ? refreshDay : 1,
            label: form.label
          };
        }
        setQuotaError('');
        setSavingQuota(true);
        fetch('/dsh-token-usage/quota', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ providers: payload })
        })
          .then((response) => response.json())
          .then((result) => {
            if (!mounted.current) return;
            if (result && result.ok) {
              setQuota(result.data);
              setQuotaSaved(true);
              setQuotaDirty(false);
            } else {
              setQuotaError('保存失败，请重试');
            }
          })
          .catch(() => { if (mounted.current) setQuotaError('保存失败，请重试'); })
          .finally(() => { if (mounted.current) setSavingQuota(false); });
      };

      const totals = data ? data.totals : null;
      const groups = data && Array.isArray(data.groups) ? data.groups : [];
      const coverage = data ? data.coverage : null;
      // Chart data is bound to the URL it came from, so changing the dimension
      // or granularity never renders the previous request's series.
      const chartData = chart && chart.url === chartUrl ? chart.data : null;

      const quotaPanel = h('div', { style: styles.quota },
        h('div', { style: styles.quotaHead },
          h('div', { style: styles.quotaTitle }, '额度统计'),
          h('div', { style: styles.quotaCycle }, '只列出已配置额度的接入方；其余用「添加接入方」挑选。关闭开关的接入方只统计用量')
        ),
        !quota
          ? h('div', { style: styles.quotaHint }, '正在加载额度配置…')
          : (rows.length > 0
              ? h('div', null, rows.map((item) => quotaRow(
                  item,
                  entryOf(item.provider),
                  (patch) => editQuotaProvider(item.provider, patch),
                  () => removeProvider(item.provider)
                )))
              : h('div', { style: styles.quotaHint }, '还没有配置任何接入方。用下方「添加接入方」加上要单独统计额度的网关。')),
        h('div', { style: styles.quotaForm },
          available.length > 0
            ? h('div', { style: styles.quotaAdd },
                h('select', { value: pick, onChange: (e) => setPick(e.target.value), style: styles.selectWide },
                  h('option', { value: '' }, '＋ 添加接入方…'),
                  available.map((item) => h('option', { key: item.provider, value: item.provider },
                    item.provider + (item.label && item.label !== item.provider ? '（' + item.label + '）' : '') + (item.total > 0 ? ' · 累计 ' + formatUnits(item.total) : '') + (item.lastDay ? ' · 最后 ' + item.lastDay : '')
                  ))
                ),
                h('button', { type: 'button', disabled: !pick, onClick: () => { if (pick) { addProvider(pick); setPick(''); } }, style: styles.button }, '添加')
              )
            : null,
          h('button', { type: 'button', onClick: saveQuota, disabled: savingQuota, style: styles.button }, savingQuota ? '保存中…' : '保存额度配置'),
          quotaError ? h('div', { style: styles.quotaError }, quotaError) : null,
          quotaSaved && !quotaError ? h('div', { style: styles.quotaOk }, '已保存') : null
        )
      );

      return h('div', { style: styles.root },
        h('div', { style: styles.header },
          h('div', null,
            h('div', { style: styles.title }, 'Token 消耗统计'),
            h('div', { style: styles.subtitle }, '本机全部 DSH 会话的历史累计 · 按 message id 去重')
          ),
          h('div', { style: styles.actions },
            h('button', { type: 'button', onClick: loadAll, disabled: loading, style: styles.button }, loading ? '刷新中…' : '刷新'),
            h('button', { type: 'button', onClick: rescan, disabled: rescanning, style: styles.button }, rescanning ? '扫描中…' : '重新扫描')
          )
        ),
        error ? h('div', { style: styles.error }, '读取失败：' + error) : null,
        totals
          ? h('div', { style: styles.cards },
              card('合计 total', totals.total, true),
              card('非缓存输入', totals.input),
              card('输出', totals.output),
              card('缓存读取', totals.cacheRead),
              card('调用次数', totals.calls)
            )
          : h('div', { style: styles.muted }, loading ? '正在统计…' : '暂无数据'),
        h('div', { style: styles.row }, RANGES.map((item) => chip(item.label, range === item.id, () => setRange(item.id)))),
        range === 'custom'
          ? h('div', { style: styles.dateRow },
              field('起始日期', h('input', { type: 'date', value: from, onChange: (e) => setFrom(e.target.value), style: styles.dateInput })),
              field('截止日期', h('input', { type: 'date', value: to, onChange: (e) => setTo(e.target.value), style: styles.dateInput })),
              h('div', { style: styles.hint }, '只填起始 = 起始日至今；只填截止 = 截止日之前全部；都填 = 该区间。留空则等同「全部」。')
            )
          : null,
        h('div', { style: styles.row },
          h('span', { style: styles.rowLabel }, '图表拆分'),
          DIMS.map((item) => chip(item.label, dim === item.id, () => setDim(item.id))),
          chip(showChart ? '隐藏图表' : '显示图表', false, () => setShowChart(!showChart))
        ),
        showChart
          ? h('div', { style: styles.row },
              GRANULARITIES.map((item) => {
                const capped = overCap(item.minutes);
                const selected = activeGran === item.id;
                return h('button', {
                  key: item.id, type: 'button', disabled: capped,
                  title: capped ? '超出 ' + MAX_BUCKETS + ' 桶上限，请选择更粗的颗粒度或缩小范围' : null,
                  onClick: () => setGran(item.id),
                  style: Object.assign({}, selected ? Object.assign({}, styles.chip, styles.chipActive) : styles.chip, capped ? { opacity: 0.35, cursor: 'not-allowed' } : null)
                }, item.label);
              }),
              h('span', { style: styles.hint },
                '颗粒度：' + granLabel(chartData ? chartData.groupBy : effGran)
                + (chartData && chartData.requestedGroupBy ? '（已自动放粗，原请求 ' + granLabel(chartData.requestedGroupBy) + '）' : '')
              )
            )
          : null,
        showChart
          ? (chartData && chartData.groups.length > 0
              ? stackedChart(chartData.groups, dim, chartData.seriesOrder)
              : h('div', { style: styles.hint }, chartError ? '图表加载失败：' + chartError : (chartData ? '暂无图表数据' : '图表加载中…')))
          : null,
        h('div', { style: styles.row },
          h('span', { style: styles.rowLabel }, '表格分组'),
          GROUPS.map((item) => chip(item.label, groupBy === item.id, () => setGroupBy(item.id)))
        ),
        groups.length > 0 ? table(groups) : null,
        groups.length > 200 ? h('div', { style: styles.truncated }, '表格仅显示前 200 行（共 ' + groups.length + ' 行）') : null,
        coverage
          ? h('div', { style: styles.footer },
              '数据覆盖 ' + (coverage.firstDay || '—') + ' ~ ' + (coverage.lastDay || '—') +
              ' · ' + formatNumber(coverage.records) + ' 条调用' +
              ' · ' + formatNumber(coverage.sessions) + ' 个会话' +
              ' · ' + formatNumber(coverage.files) + ' 个文件' +
              (coverage.fromCache ? ' · 缓存快照' : '') +
              ' · 更新于 ' + new Date(data.generatedAt).toLocaleTimeString()
            )
          : null,
        quotaPanel
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'token-usage',
        order: 60,
        label: () => 'Token 统计'
      }, TokenUsageSection));
    }

    return { name: 'dsh-token-usage', inject: ['slots'], apply };
  }
});
