#!/usr/bin/env node
/**
 * Standalone token report - no DSH process required.
 *
 *   node scripts/report.mjs                       # Markdown, all time
 *   node scripts/report.mjs --range 30d           # last 30 days
 *   node scripts/report.mjs --from 2026-08-01 --to 2026-08-31
 *   node scripts/report.mjs --json                # machine-readable
 *   node scripts/report.mjs --group day,model     # choose breakdowns
 */
import { listSessionFiles, mergeRecords, scanFile } from '../lib/core/scan.js';
import { buildSummary, coverageOf } from '../lib/core/aggregate.js';
import { resolveDshHomes } from '../lib/core/paths.js';

function parseArgs(argv) {
  const args = { groups: null, range: 'all', from: null, to: null, tz: 'Asia/Shanghai', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--range' && next) { args.range = next; i += 1; }
    else if (token === '--from' && next) { args.from = next; i += 1; }
    else if (token === '--to' && next) { args.to = next; i += 1; }
    else if (token === '--tz' && next) { args.tz = next; i += 1; }
    else if (token === '--group' && next) { args.groups = next.split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (token === '--json') { args.json = true; }
    else if (token === '--help' || token === '-h') { args.help = true; }
  }
  if (args.from || args.to) args.range = 'custom';
  return args;
}

function scanAll(homes) {
  const files = listSessionFiles(homes);
  const lists = [];
  let failures = 0;
  for (const file of files) {
    try { lists.push(scanFile(file.path, file.workspace).records); }
    catch (error) { failures += 1; process.stderr.write('warn: cannot read ' + file.path + ': ' + (error && error.message) + '\n'); }
  }
  return { files, records: mergeRecords(lists), failures };
}

const NUMBER = new Intl.NumberFormat('en-US');
function fmt(value) { return NUMBER.format(Math.round(value || 0)); }

function table(headers, rows) {
  const out = [];
  out.push('| ' + headers.join(' | ') + ' |');
  out.push('|' + headers.map((header) => (header === '名称' ? '---' : '---:')).join('|') + '|');
  for (const row of rows) out.push('| ' + row.join(' | ') + ' |');
  return out.join('\n');
}

function renderMarkdown(args, summary, coverage) {
  const lines = [];
  lines.push('# DSH Token 消耗统计');
  lines.push('');
  lines.push('- 生成时间：' + new Date(summary.generatedAt).toLocaleString('zh-CN', { timeZone: args.tz }));
  lines.push('- 统计范围：' + summary.range.label);
  lines.push('- 数据覆盖：' + (coverage.firstDay || '—') + ' ~ ' + (coverage.lastDay || '—') + '（' + fmt(coverage.records) + ' 条调用 / ' + fmt(coverage.sessions) + ' 个会话）');
  lines.push('- 口径：total = 非缓存输入 + 输出 + 缓存读取；reasoning 已含在输出内，不重复计');
  lines.push('');
  lines.push('## 总计');
  lines.push('');
  lines.push('| 指标 | Tokens |');
  lines.push('|---|---:|');
  lines.push('| 非缓存输入 inputTokens | ' + fmt(summary.totals.input) + ' |');
  lines.push('| 输出 outputTokens | ' + fmt(summary.totals.output) + ' |');
  lines.push('| 缓存读取 cacheReadTokens | ' + fmt(summary.totals.cacheRead) + ' |');
  lines.push('| **合计 totalTokens** | **' + fmt(summary.totals.total) + '** |');
  lines.push('| LLM 调用次数 | ' + fmt(summary.totals.calls) + ' |');
  lines.push('| 涉及会话数 | ' + fmt(summary.totals.sessions) + ' |');
  lines.push('');
  const dimensions = args.groups && args.groups.length > 0 ? args.groups : ['day', 'model', 'provider', 'project'];
  const titles = { day: '按天', model: '按模型', provider: '按 Provider', project: '按项目', session: '按会话' };
  for (const dimension of dimensions) {
    const rows = summary.breakdowns[dimension];
    if (!rows || rows.length === 0) continue;
    lines.push('## ' + (titles[dimension] || dimension));
    lines.push('');
    const rendered = rows.map((row) => [row.label, fmt(row.total), fmt(row.input), fmt(row.output), fmt(row.cacheRead), fmt(row.calls)]);
    lines.push(table(['名称', '合计', '输入', '输出', '缓存读取', '调用'], rendered));
    lines.push('');
  }
  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write('Usage: node scripts/report.mjs [--range all|today|7d|30d] [--from YYYY-MM-DD --to YYYY-MM-DD] [--group day,model,provider,project] [--tz Asia/Shanghai] [--json]\n');
  process.exit(0);
}

const homes = resolveDshHomes();
const started = Date.now();
const { files, records, failures } = scanAll(homes);
const coverage = Object.assign(coverageOf(records, args.tz), {
  files: files.length,
  homes,
  scanMs: Date.now() - started,
  failures
});

if (args.json) {
  const dimensions = args.groups && args.groups.length > 0 ? args.groups : ['day', 'model', 'provider', 'project'];
  const breakdowns = {};
  for (const dimension of dimensions) {
    breakdowns[dimension] = buildSummary(records, { timeZone: args.tz, range: args.range, from: args.from, to: args.to, groupBy: dimension }).groups;
  }
  const summary = buildSummary(records, { timeZone: args.tz, range: args.range, from: args.from, to: args.to, groupBy: 'day' });
  process.stdout.write(JSON.stringify({ generatedAt: summary.generatedAt, range: summary.range, totals: summary.totals, coverage, breakdowns }, null, 2) + '\n');
} else {
  const dimensions = args.groups && args.groups.length > 0 ? args.groups : ['day', 'model', 'provider', 'project'];
  const summary = buildSummary(records, { timeZone: args.tz, range: args.range, from: args.from, to: args.to, groupBy: 'day' });
  const breakdowns = {};
  for (const dimension of dimensions) {
    breakdowns[dimension] = buildSummary(records, { timeZone: args.tz, range: args.range, from: args.from, to: args.to, groupBy: dimension }).groups;
  }
  summary.breakdowns = breakdowns;
  process.stdout.write(renderMarkdown(args, summary, coverage) + '\n');
}
