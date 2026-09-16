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
