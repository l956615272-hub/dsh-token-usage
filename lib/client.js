/**
 * dsh-token-usage - browser half.
 *
 * Registers a "Token 统计" page in Settings that reads the host aggregation
 * over /dsh-token-usage/summary. Hand-authored in the __ModuleLoader__ format;
 * the only runtime import is React from the platform module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const NUMBER = new Intl.NumberFormat('en-US');

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
      { id: '30d', label: '近 30 天' }
    ];

    const GROUPS = [
      { id: 'day', label: '按天' },
      { id: 'model', label: '按模型' },
      { id: 'project', label: '按项目' },
      { id: 'provider', label: '按 Provider' }
    ];

    const styles = {
      root: { padding: '4px 2px 28px', color: 'var(--dsh-text-primary, inherit)', fontSize: 13, lineHeight: 1.5 },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      title: { fontSize: 16, fontWeight: 600 },
      subtitle: { fontSize: 12, opacity: 0.65, marginTop: 2 },
      actions: { display: 'flex', gap: 8 },
      button: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
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
      chip: { fontSize: 12, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--dsh-border, rgba(128,128,128,0.3))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      chipActive: { background: 'var(--dsh-accent, #3b82f6)', borderColor: 'var(--dsh-accent, #3b82f6)', color: '#fff' },
      tableWrap: { marginTop: 14, maxHeight: 'min(58vh, 560px)', overflow: 'auto', overscrollBehavior: 'contain', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, rgba(30,30,32,0.98))' },
      table: { width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' },
      th: { position: 'sticky', top: 0, zIndex: 1, background: 'var(--dsw-alias-bg-layer-2, rgba(30,30,32,0.98))', boxShadow: 'inset 0 -1px 0 var(--dsw-alias-border-l1, rgba(128,128,128,0.25))', textAlign: 'left', fontSize: 11, fontWeight: 500, color: 'var(--dsw-alias-label-caption, rgba(170,170,170,0.95))', padding: '6px 8px', whiteSpace: 'nowrap' },
      thNum: { textAlign: 'right' },
      td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.14))', whiteSpace: 'nowrap' },
      tdName: { maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' },
      truncated: { fontSize: 11, opacity: 0.55, marginTop: 6 },
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

    function TokenUsageSection() {
      const [range, setRange] = React.useState('all');
      const [groupBy, setGroupBy] = React.useState('day');
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [rescanning, setRescanning] = React.useState(false);
      const mounted = React.useRef(true);

      const load = React.useCallback(() => {
        setLoading(true);
        return fetch('/dsh-token-usage/summary?range=' + encodeURIComponent(range) + '&groupBy=' + encodeURIComponent(groupBy), { cache: 'no-store' })
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
      }, [range, groupBy]);

      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);

      React.useEffect(() => { load(); }, [load]);

      React.useEffect(() => {
        const timer = setInterval(() => { load(); }, 30000);
        return () => clearInterval(timer);
      }, [load]);

      const rescan = () => {
        setRescanning(true);
        fetch('/dsh-token-usage/rescan', { method: 'POST' })
          .then(() => load())
          .catch(() => {})
          .finally(() => { if (mounted.current) setRescanning(false); });
      };

      const totals = data ? data.totals : null;
      const groups = data && Array.isArray(data.groups) ? data.groups : [];
      const coverage = data ? data.coverage : null;

      return h('div', { style: styles.root },
        h('div', { style: styles.header },
          h('div', null,
            h('div', { style: styles.title }, 'Token 消耗统计'),
            h('div', { style: styles.subtitle }, '本机全部 DSH 会话的历史累计 · 按 message id 去重')
          ),
          h('div', { style: styles.actions },
            h('button', { type: 'button', onClick: load, disabled: loading, style: styles.button }, loading ? '刷新中…' : '刷新'),
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
        h('div', { style: styles.row }, GROUPS.map((item) => chip(item.label, groupBy === item.id, () => setGroupBy(item.id)))),
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
          : null
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
