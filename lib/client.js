/**
 * dsh-token-usage - browser half.
 *
 * Registers a "Token 统计" page in Settings. It reads the host aggregation
 * over /dsh-token-usage/summary, supports a custom (one-sided or two-sided)
 * date window, and renders the monthly quota cycle from /dsh-token-usage/quota.
 * Hand-authored in the __ModuleLoader__ format; the only runtime import is
 * React from the platform module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const NUMBER = new Intl.NumberFormat('en-US');
    const BORDER = '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))';
    const INPUT_BASE = { fontSize: 12, padding: '4px 6px', borderRadius: 6, border: BORDER, background: 'transparent', color: 'inherit', colorScheme: 'light dark' };

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
      chip: { fontSize: 12, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--dsh-border, rgba(128,128,128,0.3))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      chipActive: { background: 'var(--dsh-accent, #3b82f6)', borderColor: 'var(--dsh-accent, #3b82f6)', color: '#fff' },
      dateRow: { display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginTop: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 },
      fieldLabel: { opacity: 0.6 },
      input: Object.assign({}, INPUT_BASE, { width: 116 }),
      inputSmall: Object.assign({}, INPUT_BASE, { width: 64 }),
      inputWide: Object.assign({}, INPUT_BASE, { width: 150 }),
      select: Object.assign({}, INPUT_BASE, { width: 62 }),
      dateInput: Object.assign({}, INPUT_BASE, { width: 140 }),
      hint: { fontSize: 11, opacity: 0.55, maxWidth: 380 },
      quota: { marginTop: 18, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28))', background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06))' },
      quotaHead: { display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' },
      quotaTitle: { fontSize: 13, fontWeight: 600 },
      quotaCycle: { fontSize: 11, opacity: 0.6 },
      quotaSummary: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, marginTop: 10, flexWrap: 'wrap' },
      quotaCol: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      quotaColRight: { alignItems: 'flex-end', textAlign: 'right' },
      quotaColLabel: { fontSize: 11, opacity: 0.6 },
      quotaColValue: { fontSize: 26, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 },
      quotaColValueSmall: { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 },
      quotaColExact: { fontSize: 10, opacity: 0.5, fontVariantNumeric: 'tabular-nums' },
      quotaMeter: { marginTop: 8, height: 8, borderRadius: 999, background: 'rgba(128,128,128,0.2)', overflow: 'hidden' },
      quotaMeterFill: { height: '100%', borderRadius: 999, transition: 'width 0.3s ease' },
      quotaStats: { display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 6, fontSize: 11, opacity: 0.7, flexWrap: 'wrap' },
      quotaHint: { marginTop: 8, fontSize: 11, opacity: 0.6 },
      quotaOk: { fontSize: 11, marginTop: 6, color: '#2e9e63' },
      quotaError: { fontSize: 11, marginTop: 6, color: '#d05a5a' },
      quotaForm: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))' },
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

    function TokenUsageSection() {
      const [range, setRange] = React.useState('all');
      const [groupBy, setGroupBy] = React.useState('day');
      const [from, setFrom] = React.useState('');
      const [to, setTo] = React.useState('');
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [rescanning, setRescanning] = React.useState(false);
      const [quota, setQuota] = React.useState(null);
      const [quotaForm, setQuotaForm] = React.useState({ amount: '', unit: '亿', refreshDay: '1', label: '' });
      const [quotaReady, setQuotaReady] = React.useState(false);
      const [quotaDirty, setQuotaDirty] = React.useState(false);
      const [quotaError, setQuotaError] = React.useState('');
      const [quotaSaved, setQuotaSaved] = React.useState(false);
      const [savingQuota, setSavingQuota] = React.useState(false);
      const mounted = React.useRef(true);

      const summaryUrl = React.useCallback(() => {
        const params = ['groupBy=' + encodeURIComponent(groupBy)];
        if (range !== 'custom') {
          params.push('range=' + encodeURIComponent(range));
        } else if (!from && !to) {
          params.push('range=all');
        } else {
          params.push('range=custom');
          if (from) params.push('from=' + encodeURIComponent(from));
          if (to) params.push('to=' + encodeURIComponent(to));
        }
        return '/dsh-token-usage/summary?' + params.join('&');
      }, [range, groupBy, from, to]);

      const load = React.useCallback(() => {
        setLoading(true);
        return fetch(summaryUrl(), { cache: 'no-store' })
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
      React.useEffect(() => { loadQuota(); }, [loadQuota]);

      React.useEffect(() => {
        if (!quotaReady && !quotaDirty && quota && quota.config) {
          setQuotaForm({
            // Seed with a real, saveable default: an empty field (whose only
            // hint was a placeholder) made the first save a silent no-op.
            amount: quota.config.amount > 0 ? String(quota.config.amount) : '20',
            unit: quota.config.unit || '亿',
            refreshDay: String(quota.config.refreshDay || 1),
            label: quota.config.label || ''
          });
          setQuotaReady(true);
        }
      }, [quota, quotaReady, quotaDirty]);

      React.useEffect(() => {
        const timer = setInterval(() => { load(); loadQuota(); }, 30000);
        return () => clearInterval(timer);
      }, [load, loadQuota]);

      const rescan = () => {
        setRescanning(true);
        fetch('/dsh-token-usage/rescan', { method: 'POST' })
          .then(() => { load(); loadQuota(); })
          .catch(() => {})
          .finally(() => { if (mounted.current) setRescanning(false); });
      };

      const saveQuota = () => {
        const amount = Number(quotaForm.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          setQuotaSaved(false);
          setQuotaError('请先填写大于 0 的本月额度');
          return;
        }
        const refreshDay = Math.round(Number(quotaForm.refreshDay));
        if (!Number.isFinite(refreshDay) || refreshDay < 1 || refreshDay > 31) {
          setQuotaSaved(false);
          setQuotaError('刷新日需在 1–31 之间');
          return;
        }
        setQuotaError('');
        setSavingQuota(true);
        fetch('/dsh-token-usage/quota', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amount, unit: quotaForm.unit, refreshDay, label: quotaForm.label })
        })
          .then((response) => response.json())
          .then((payload) => {
            if (!mounted.current) return;
            if (payload && payload.ok) {
              setQuota(payload.data);
              setQuotaSaved(true);
              setQuotaDirty(false);
            } else {
              setQuotaError('保存失败，请重试');
            }
          })
          .catch(() => { if (mounted.current) setQuotaError('保存失败，请重试'); })
          .finally(() => { if (mounted.current) setSavingQuota(false); });
      };

      const editQuota = (patch) => {
        setQuotaDirty(true);
        setQuotaSaved(false);
        setQuotaError('');
        setQuotaForm(Object.assign({}, quotaForm, patch));
      };

      const totals = data ? data.totals : null;
      const groups = data && Array.isArray(data.groups) ? data.groups : [];
      const coverage = data ? data.coverage : null;
      const configured = !!(quota && quota.configured);
      const ratio = configured ? quota.percent : 0;
      const meterColor = ratio >= 1 ? '#e05252' : ratio >= 0.9 ? '#e0a24a' : 'var(--dsw-alias-brand-primary, #3b82f6)';
      const quotaLabel = quotaForm.label && quotaForm.label.trim() ? quotaForm.label.trim() : '本月额度';

      const quotaPanel = h('div', { style: styles.quota },
        h('div', { style: styles.quotaHead },
          h('div', { style: styles.quotaTitle }, quotaLabel),
          h('div', { style: styles.quotaCycle },
            configured
              ? (quota.cycle.fromDay || '—') + ' ~ ' + (quota.cycle.toDay || '—') + ' · 每月 ' + quota.config.refreshDay + ' 日刷新'
              : '未配置'
          )
        ),
        configured
          ? h('div', null,
              h('div', { style: styles.quotaSummary },
                h('div', { style: styles.quotaCol },
                  h('div', { style: styles.quotaColLabel }, '本周期剩余'),
                  h('div', { style: styles.quotaColValue }, formatUnits(quota.remaining)),
                  h('div', { style: styles.quotaColExact }, formatNumber(quota.remaining))
                ),
                h('div', { style: Object.assign({}, styles.quotaCol, styles.quotaColRight) },
                  h('div', { style: styles.quotaColLabel }, '本月额度'),
                  h('div', { style: styles.quotaColValueSmall }, formatUnits(quota.quotaTokens)),
                  h('div', { style: styles.quotaColExact }, formatNumber(quota.quotaTokens))
                )
              ),
              h('div', { style: styles.quotaMeter },
                h('div', { style: Object.assign({}, styles.quotaMeterFill, { width: Math.min(100, ratio * 100).toFixed(1) + '%', background: meterColor }) })
              ),
              h('div', { style: styles.quotaStats },
                h('span', null, '进度 = 已用 ' + formatUnits(quota.used) + '（' + (ratio * 100).toFixed(1) + '%）'),
                h('span', null, quota.used > quota.quotaTokens
                  ? '已超额 ' + formatUnits(quota.used - quota.quotaTokens)
                  : '剩余 ' + ((1 - ratio) * 100).toFixed(1) + '%')
              ),
              quota.used > quota.quotaTokens
                ? h('div', { style: styles.error }, '本周期已超出额度 ' + formatUnits(quota.used - quota.quotaTokens))
                : null
            )
          : h('div', { style: styles.quotaHint }, '填写本月额度后，这里会显示本周期剩余。额度默认预填 20 亿，请按你的实际额度修改后保存；配置只保存在本机（$DSH_HOME/dsh-token-usage/quota.json），不会上传。'),
        h('div', { style: styles.quotaForm },
          field('本月额度', h('input', { type: 'number', min: '0', step: 'any', value: quotaForm.amount, placeholder: '20', onChange: (e) => editQuota({ amount: e.target.value }), style: styles.input })),
          field('单位', h('select', { value: quotaForm.unit, onChange: (e) => editQuota({ unit: e.target.value }), style: styles.select },
            h('option', { value: '亿' }, '亿'),
            h('option', { value: '万' }, '万'),
            h('option', { value: '个' }, '个')
          )),
          field('每月刷新日', h('input', { type: 'number', min: '1', max: '31', value: quotaForm.refreshDay, onChange: (e) => editQuota({ refreshDay: e.target.value }), style: styles.inputSmall })),
          field('名称（可选）', h('input', { type: 'text', value: quotaForm.label, placeholder: '如：公司网关', maxLength: 60, onChange: (e) => editQuota({ label: e.target.value }), style: styles.inputWide })),
          h('button', { type: 'button', onClick: saveQuota, disabled: savingQuota, style: styles.button }, savingQuota ? '保存中…' : '保存额度'),
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
        range === 'custom'
          ? h('div', { style: styles.dateRow },
              field('起始日期', h('input', { type: 'date', value: from, onChange: (e) => setFrom(e.target.value), style: styles.dateInput })),
              field('截止日期', h('input', { type: 'date', value: to, onChange: (e) => setTo(e.target.value), style: styles.dateInput })),
              h('div', { style: styles.hint }, '只填起始 = 起始日至今；只填截止 = 截止日之前全部；都填 = 该区间。留空则等同「全部」。')
            )
          : null,
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
