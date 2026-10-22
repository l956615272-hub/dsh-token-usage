/**
 * Core engine tests.
 *
 * The live-ledger test is the important one: it replays the same discovery the
 * project validated by hand - message-id de-duplication reproduces the
 * dsh-usage ledger cell-for-cell for stable past days.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeZstdMultiFrame, frameSizeAt, splitZstdFrames } from '../lib/core/zstd.js';
import { listSessionFiles, mergeRecords, scanFile } from '../lib/core/scan.js';
import { buildSummary, resolveRange, summarize, zonedDayStart } from '../lib/core/aggregate.js';
import { resolveDshHomes } from '../lib/core/paths.js';

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function writeSession(path, lines) {
  writeFileSync(path, Buffer.concat(lines.map((line) => frame(line + '\n'))));
}

function usageEvent(id, time, provider, model, usage) {
  return JSON.stringify({
    type: 'assistant/message',
    seq: 2,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { id, source: { provider, model } },
      usage
    }
  });
}

test('decodes concatenated zstd frames (Node builtin only reads the first)', () => {
  const first = frame('{"type":"session"}\n');
  const second = frame('{"type":"assistant/message"}\n');
  const buf = Buffer.concat([first, second]);
  assert.equal(frameSizeAt(buf, 0), first.length, 'first frame boundary');
  assert.equal(frameSizeAt(buf, first.length), second.length, 'second frame boundary');
  assert.equal(splitZstdFrames(buf).length, 2);
  assert.equal(decodeZstdMultiFrame(buf), '{"type":"session"}\n{"type":"assistant/message"}\n');
});

test('resolves the start of a day in Asia/Shanghai', () => {
  assert.equal(zonedDayStart('2026-09-08', 'Asia/Shanghai'), 1788796800000);
  const range = resolveRange('today', { timeZone: 'Asia/Shanghai', now: Date.UTC(2026, 8, 8, 12, 0, 0) });
  assert.equal(range.fromDay, '2026-09-08');
  assert.equal(range.toMs - range.fromMs, 86400000);
});

test('summarize uses total = input + output + cacheRead', () => {
  const records = [
    { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, reasoning: 3, sessionId: 'a' },
    { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'b' }
  ];
  const totals = summarize(records);
  assert.equal(totals.total, 118);
  assert.equal(totals.input, 11);
  assert.equal(totals.reasoning, 3);
  assert.equal(totals.calls, 2);
  assert.equal(totals.sessions, 2);
});

test('mergeRecords de-duplicates by message id across copies', () => {
  const a = [{ key: 'm:1', input: 5 }, { key: 'm:2', input: 6 }];
  const b = [{ key: 'm:1', input: 5 }, { key: 'm:3', input: 7 }];
  const merged = mergeRecords([a, b]);
  assert.equal(merged.length, 3);
  assert.equal(merged.reduce((sum, record) => sum + record.input, 0), 18);
});

test('scanner extracts usage records and de-duplicates across v0/v3 copies', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-token-usage-'));
  const sessionDir = join(home, 'sessions', '--Users-d-Demo--', 'session-demo');
  mkdirSync(sessionDir, { recursive: true });
  const header = JSON.stringify({ type: 'session', version: 0, id: 'session-demo', createdAt: 1788796800000, cwd: '/Users/d/Demo' });
  const event = usageEvent('msg-1', 1788796900000, 'datagrand', 'deepseek-v4-pro', {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, totalTokens: 1120, reasoningTokens: 7
  });
  writeSession(join(sessionDir, 'session.jsonl.zstd'), [header, event]);
  writeSession(join(sessionDir, 'session.v3.jsonl.zstd'), [header, event]);

  const files = listSessionFiles([home]);
  assert.equal(files.length, 2, 'both copies are discovered');

  const merged = mergeRecords(files.map((file) => scanFile(file.path, file.workspace).records));
  assert.equal(merged.length, 1, 'duplicate message id collapses');
  const record = merged[0];
  assert.equal(record.provider, 'datagrand');
  assert.equal(record.model, 'deepseek-v4-pro');
  assert.equal(record.project, '/Users/d/Demo');
  assert.equal(record.projectLabel, 'Demo');
  assert.equal(record.reasoning, 7);

  const summary = buildSummary(merged, { timeZone: 'Asia/Shanghai', range: 'all', groupBy: 'model' });
  assert.equal(summary.totals.total, 1120);
  assert.equal(summary.groups[0].key, 'datagrand / deepseek-v4-pro');
});

test('custom range is one-sided aware and cycle lands on the refresh day', () => {
  const tz = 'Asia/Shanghai';
  const fromOnly = resolveRange('custom', { timeZone: tz, from: '2026-09-08' });
  assert.equal(fromOnly.fromDay, '2026-09-08');
  assert.equal(fromOnly.fromMs, zonedDayStart('2026-09-08', tz));
  assert.equal(fromOnly.toMs, null, 'from-only keeps an open upper bound (through now)');

  const toOnly = resolveRange('custom', { timeZone: tz, to: '2026-09-08' });
  assert.equal(toOnly.fromMs, null, 'to-only keeps an open lower bound (from the beginning)');
  assert.equal(toOnly.toMs, zonedDayStart('2026-09-09', tz), 'to-only includes the whole end day');

  const both = resolveRange('custom', { timeZone: tz, from: '2026-09-01', to: '2026-09-08' });
  assert.equal(both.fromMs, zonedDayStart('2026-09-01', tz));
  assert.equal(both.toMs, zonedDayStart('2026-09-09', tz));

  const midSeptember = Date.UTC(2026, 8, 11, 4, 0, 0); // 2026-09-11 12:00 Asia/Shanghai
  assert.equal(resolveRange('cycle', { timeZone: tz, cycleDay: 1, now: midSeptember }).fromDay, '2026-09-01');
  assert.equal(resolveRange('cycle', { timeZone: tz, cycleDay: 20, now: midSeptember }).fromDay, '2026-08-20');
  // A day-31 cycle clamps to the month length, so February starts on Jan 31.
  const midFebruary = Date.UTC(2026, 1, 15, 4, 0, 0);
  assert.equal(resolveRange('cycle', { timeZone: tz, cycleDay: 31, now: midFebruary }).fromDay, '2026-01-31');
});

test('stacked grouping breaks day buckets down by series', () => {
  const records = [
    { time: 1788796900000, provider: 'deepseek', model: 'glm-5.3', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'a' },   // 2026-09-08
    { time: 1788796900000, provider: 'deepseek', model: 'deepseek-v4', input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'a' },
    { time: 1788883300000, provider: 'kimi', model: 'kimi-k3', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'b' }        // 2026-09-09
  ];
  const summary = buildSummary(records, { timeZone: 'Asia/Shanghai', range: 'all', groupBy: 'day', series: 'model' });
  assert.equal(summary.series, 'model');
  assert.equal(summary.seriesOrder.length, 3);
  assert.equal(summary.seriesOrder[0].key, 'deepseek / deepseek-v4', 'series ranked by grand total desc');
  assert.equal(summary.groups.length, 2);
  const day1 = summary.groups[0];
  assert.equal(day1.key, '2026-09-08');
  assert.equal(day1.total, 165);
  assert.equal(day1.calls, 2);
  const byKey = new Map(day1.series.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get('deepseek / glm-5.3').total, 15);
  assert.equal(byKey.get('deepseek / deepseek-v4').total, 150);
  // Series totals never exceed the day total.
  assert.equal(day1.series.reduce((sum, entry) => sum + entry.total, 0), day1.total);

  const plain = buildSummary(records, { timeZone: 'Asia/Shanghai', range: 'all', groupBy: 'day' });
  assert.equal(plain.series, undefined);
  assert.equal(plain.seriesOrder, undefined);
  assert.equal(plain.groups[0].series, undefined, 'plain grouping keeps the flat shape');
});

test('time granularity buckets and the 1000-bucket guardrail coarsen', () => {
  const tz = 'Asia/Shanghai';
  const noon = Date.UTC(2026, 9, 8, 4, 30, 0); // 2026-10-08 12:30 Asia/Shanghai
  const records = [
    { time: noon, provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'a' },        // 12:30
    { time: noon + 45 * 60000, provider: 'p', model: 'm', input: 2, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'a' } // 13:15
  ];
  const hourly = buildSummary(records, { timeZone: tz, range: 'all', groupBy: 'hour' });
  assert.equal(hourly.groups.length, 2, '12:30 and 13:15 land in different hour buckets');
  assert.equal(hourly.groups[0].key, '2026-10-08 12:00');
  const byHalfHour = buildSummary(records, { timeZone: tz, range: 'all', groupBy: '30m' });
  assert.equal(byHalfHour.groups.length, 2);
  assert.equal(byHalfHour.groups[0].key, '2026-10-08 12:30');
  const quarter = buildSummary(records, { timeZone: tz, range: 'all', groupBy: '15m' });
  assert.equal(quarter.groups.length, 2);
  assert.equal(quarter.groups[0].key, '2026-10-08 12:30');

  // A 3-year window at 30m granularity is ~105k buckets: the guardrail coarsens.
  const longAgo = Date.UTC(2023, 0, 8, 4, 0, 0);
  const longRecords = [
    { time: longAgo, provider: 'p', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'x' },
    { time: noon, provider: 'p', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'x' }
  ];
  const coarsened = buildSummary(longRecords, { timeZone: tz, range: 'all', groupBy: '30m' });
  assert.equal(coarsened.requestedGroupBy, '30m');
  assert.equal(coarsened.groupBy, 'week', 'a ~3.75-year span coarsens past hour and day to week');
  const weekBucket = buildSummary(longRecords, { timeZone: tz, range: 'all', groupBy: 'week' });
  assert.ok(/^202\d-\d\d-\d\d$/.test(weekBucket.groups[0].key), 'week keys are Monday dates');
  assert.ok(weekBucket.groups.every((row, index) => index === 0 || weekBucket.groups[index - 1].key <= row.key), 'time buckets sort ascending');
});

test('fill inserts empty buckets and series totals stay consistent', () => {
  const tz = 'Asia/Shanghai';
  const day1 = Date.UTC(2026, 8, 1, 4, 0, 0); // 2026-09-01 12:00 Asia/Shanghai
  const records = [
    { time: day1, provider: 'p', model: 'm', input: 10, output: 5, cacheRead: 1, cacheWrite: 7, reasoning: 3, sessionId: 'a' },
    { time: day1 + 3 * 86400000, provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 2, reasoning: 1, sessionId: 'a' }
  ];
  const sparse = buildSummary(records, { timeZone: tz, range: 'all', groupBy: 'day' });
  assert.equal(sparse.groups.length, 2, 'plain grouping stays sparse');

  const filled = buildSummary(records, { timeZone: tz, range: 'all', groupBy: 'day', fill: true });
  assert.deepEqual(filled.groups.map((row) => row.key), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  assert.equal(filled.groups[1].total, 0);
  assert.equal(filled.groups[1].calls, 0);

  const stacked = buildSummary(records, { timeZone: tz, range: 'all', groupBy: 'day', series: 'model', fill: true });
  assert.equal(stacked.groups[1].total, 0);
  assert.deepEqual(stacked.groups[1].series, [], 'filled stacked rows carry an empty series array');
  const series = stacked.seriesOrder[0];
  assert.equal(series.cacheWrite, 9, 'seriesOrder accumulates cacheWrite');
  assert.equal(series.reasoning, 4, 'seriesOrder accumulates reasoning');
  assert.equal(series.calls, 2);

  // coarsen: false keeps the exact requested grouping for the table/report.
  const long = buildSummary([
    { time: Date.UTC(2023, 0, 8, 4, 0, 0), provider: 'p', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'x' },
    { time: day1, provider: 'p', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'x' }
  ], { timeZone: tz, range: 'all', groupBy: 'day', coarsen: false });
  assert.equal(long.groupBy, 'day');
  assert.equal(long.requestedGroupBy, undefined);

  // Unknown series dimensions are ignored, not collapsed into "(unknown)".
  const bogus = buildSummary(records, { timeZone: tz, range: 'all', groupBy: 'day', series: 'nope' });
  assert.equal(bogus.series, undefined);
  assert.equal(bogus.seriesOrder, undefined);
});

test('auto granularity follows the selected range', () => {
  const tz = 'Asia/Shanghai';
  const now = Date.UTC(2026, 9, 22, 4, 0, 0); // 2026-10-22 12:00 Asia/Shanghai
  const records = [
    { time: now - 3600000, provider: 'p', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'a' }
  ];
  const auto = (options) => buildSummary(records, { timeZone: tz, now, groupBy: 'auto', ...options });
  const custom = (from, to) => auto({ range: 'custom', from, to });

  assert.equal(auto({ range: 'today' }).groupBy, 'hour');
  assert.equal(auto({ range: '7d' }).groupBy, '3h');
  assert.equal(auto({ range: '30d' }).groupBy, 'day');
  assert.equal(custom('2026-10-21', '2026-10-22').groupBy, 'hour', 'two days stays hourly');
  assert.equal(custom('2026-10-20', '2026-10-22').groupBy, 'hour', 'three days stays hourly');
  assert.equal(custom('2026-10-15', '2026-10-22').groupBy, '6h');
  assert.equal(custom('2026-09-01', '2026-10-22').groupBy, 'day');
  assert.equal(custom('2025-09-18', '2026-10-22').groupBy, 'week');
  assert.equal(custom('2023-09-18', '2026-10-22').groupBy, 'month');
  assert.equal(auto({ range: '30d' }).requestedGroupBy, undefined, 'auto is not reported as coarsened');
});

test('3h/6h buckets, model family and filled sub-day buckets', () => {
  const tz = 'Asia/Shanghai';
  const noon = Date.UTC(2026, 9, 8, 4, 30, 0); // 2026-10-08 12:30 Asia/Shanghai
  const records = [
    { time: noon, provider: 'p', model: 'deepseek-v4-pro', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'a' },
    { time: noon + 10 * 60000, provider: 'p', model: 'deepseek/deepseek-v4.1-flash', input: 2, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'a' },
    { time: noon + 20 * 60000, provider: 'p', model: 'gpt-6-luna', input: 3, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'a' },
    { time: noon + 30 * 60000, provider: 'p', model: 'glm-5.3', input: 4, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessionId: 'a' }
  ];
  const three = buildSummary(records, { timeZone: tz, range: 'all', groupBy: '3h' });
  assert.deepEqual(three.groups.map((row) => row.key), ['2026-10-08 12:00']);
  const six = buildSummary(records, { timeZone: tz, range: 'all', groupBy: '6h' });
  assert.deepEqual(six.groups.map((row) => row.key), ['2026-10-08 12:00']);

  const family = buildSummary(records, { timeZone: tz, range: 'all', groupBy: 'hour', series: 'family' });
  assert.deepEqual(family.seriesOrder.map((item) => item.key).sort(), ['deepseek', 'glm', 'gpt']);
  assert.equal(family.groups.reduce((sum, row) => sum + row.total, 0), 10);
  assert.equal(family.seriesOrder.reduce((sum, item) => sum + item.total, 0), 10);

  // 12:30 -> 18:30 at 3h fills the 15:00 gap.
  const filled = buildSummary([records[0], { ...records[0], time: noon + 6 * 3600000 }], { timeZone: tz, range: 'all', groupBy: '3h', fill: true });
  assert.deepEqual(filled.groups.map((row) => row.key), ['2026-10-08 12:00', '2026-10-08 15:00', '2026-10-08 18:00']);
  assert.equal(filled.groups[1].total, 0);
});

test('live scan reproduces the dsh-usage ledger for stable days', (t) => {
  const home = process.env.HOME ? join(process.env.HOME, '.dsh') : null;
  const ledgerPath = home ? join(home, 'dsh-usage', 'usage-ledger.json') : null;
  if (!home || !existsSync(join(home, 'sessions')) || !ledgerPath || !existsSync(ledgerPath)) {
    t.skip('no DSH sessions or dsh-usage ledger on this machine');
    return;
  }
  const homes = resolveDshHomes();
  const files = listSessionFiles(homes);
  const records = mergeRecords(files.map((file) => scanFile(file.path, file.workspace).records));
  assert.ok(records.length > 0, 'records found');

  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const stableDays = ['2026-09-08', '2026-09-09', '2026-09-10'];
  let compared = 0;
  for (const day of stableDays) {
    const ledgerDay = ledger.days[day];
    if (!ledgerDay) continue;
    for (const [provider, models] of Object.entries(ledgerDay)) {
      for (const [model, expected] of Object.entries(models)) {
        const summary = buildSummary(records, {
          timeZone: 'Asia/Shanghai',
          range: 'custom',
          from: day,
          to: day,
          groupBy: 'model'
        });
        const row = summary.groups.find((group) => group.key === provider + ' / ' + model);
        assert.ok(row, day + ' ' + provider + '/' + model + ' missing from scan');
        assert.equal(row.input, expected.inputTokens, day + ' ' + model + ' input');
        assert.equal(row.output, expected.outputTokens, day + ' ' + model + ' output');
        assert.equal(row.cacheRead, expected.cacheReadTokens, day + ' ' + model + ' cacheRead');
        assert.equal(row.calls, expected.calls, day + ' ' + model + ' calls');
        compared += 1;
      }
    }
  }
  assert.ok(compared > 0, 'at least one ledger cell compared');
});
