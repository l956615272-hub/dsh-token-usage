/**
 * dsh-token-usage - host half.
 *
 * The host owns a UsageStore that scans every DSH home's session logs, keeps a
 * de-duplicated usage snapshot warm, and serves it over local HTTP so the
 * browser half (and the standalone report CLI) can render totals.
 *
 * It also owns the monthly-quota configuration (a small JSON file under
 * $DSH_HOME/dsh-token-usage) and computes the current quota cycle's spend, so
 * the browser half only renders numbers.
 *
 * Deliberately dependency-free: only node: builtins are imported, so the
 * plugin loads inside the Electron desktop shell whose profile node_modules
 * does not expose the @deepseek-ai kernel packages.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSummary, clampDay, filterRecords, resolveRange, summarize } from './core/aggregate.js';
import { resolveDshHomes } from './core/paths.js';
import { UsageStore } from './core/store.js';

export const name = 'dsh-token-usage';

/** The web server is the only hard dependency; the tool/command surfaces are optional. */
export const inject = ['webServer'];

const BASE = '/dsh-token-usage';
const QUOTA_UNITS = { '亿': 1e8, '万': 1e4, '个': 1 };
const DEFAULT_QUOTA = { amount: 0, unit: '亿', refreshDay: 1, label: '' };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/** Read a JSON request body with a hard size cap (never trust the client). */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.length > 0 ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic JSON write: temp file in the same directory, then rename. */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, file);
}

/** Coerce arbitrary input into a safe quota config. */
function normalizeQuota(input) {
  const source = input && typeof input === 'object' ? input : {};
  const amount = Number(source.amount);
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
    unit: Object.prototype.hasOwnProperty.call(QUOTA_UNITS, source.unit) ? source.unit : DEFAULT_QUOTA.unit,
    refreshDay: clampDay(source.refreshDay == null ? DEFAULT_QUOTA.refreshDay : source.refreshDay),
    label: typeof source.label === 'string' ? source.label.slice(0, 60) : ''
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ homes?: string[], timeZone?: string, scanIntervalMs?: number, cache?: boolean, cachePath?: string }} [config]
 */
export function apply(ctx, config) {
  const options = config || {};
  const homes = resolveDshHomes(options.homes);
  const logger = ctx.logger || console;
  const store = new UsageStore({
    homes,
    timeZone: options.timeZone || 'Asia/Shanghai',
    scanIntervalMs: typeof options.scanIntervalMs === 'number' ? options.scanIntervalMs : 60000,
    cache: options.cache !== false,
    cachePath: options.cachePath,
    logger
  });

  const info = (message) => {
    try {
      if (logger && typeof logger.info === 'function') logger.info(message);
      else if (logger && typeof logger.log === 'function') logger.log(message);
    } catch { /* logging must never break the plugin */ }
  };

  info('[dsh-token-usage] scanning ' + homes.length + ' DSH home(s): ' + homes.join(', '));

  const dataDir = join(process.env.DSH_HOME || homes[0] || join(homedir(), '.dsh'), 'dsh-token-usage');
  const quotaPath = join(dataDir, 'quota.json');

  // Lifecycle: start() returns a disposer (clears the interval).
  ctx.effect(() => store.start(), 'dsh-token-usage: scanner');

  /**
   * Summary for one request. A range may be named explicitly, or inferred from
   * from/to (custom) so the client can pass either form.
   */
  const buildPayload = (searchParams) => {
    const snapshot = store.getSnapshot();
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const explicitRange = searchParams.get('range');
    const rangeKind = explicitRange || ((from || to) ? 'custom' : 'all');
    const cycleDayRaw = Number(searchParams.get('cycleDay'));
    return buildSummary(snapshot.records, {
      timeZone: store.timeZone,
      range: rangeKind,
      from,
      to,
      cycleDay: Number.isFinite(cycleDayRaw) && cycleDayRaw > 0 ? cycleDayRaw : undefined,
      groupBy: searchParams.get('groupBy') || 'day',
      coverage: {
        ...snapshot.meta,
        revision: snapshot.revision
      }
    });
  };

  /** Current quota cycle: config, spend in cycle, remaining and ratio. */
  const buildQuotaPayload = () => {
    const quotaConfig = normalizeQuota(readJsonFile(quotaPath, DEFAULT_QUOTA));
    const quotaTokens = Math.round(quotaConfig.amount * (QUOTA_UNITS[quotaConfig.unit] || 1));
    if (!(quotaTokens > 0)) {
      return { configured: false, config: quotaConfig, quotaTokens: 0, generatedAt: Date.now() };
    }
    const snapshot = store.getSnapshot();
    const range = resolveRange('cycle', { timeZone: store.timeZone, cycleDay: quotaConfig.refreshDay });
    const totals = summarize(filterRecords(snapshot.records, range));
    const used = totals.total;
    const remaining = Math.max(0, quotaTokens - used);
    return {
      configured: true,
      config: quotaConfig,
      quotaTokens,
      cycle: {
        fromDay: range.fromDay,
        toDay: range.toDay,
        fromMs: range.fromMs,
        toMs: range.toMs,
        cycleDay: range.cycleDay
      },
      used,
      remaining,
      percent: used / quotaTokens,
      calls: totals.calls,
      generatedAt: Date.now()
    };
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + '/summary',
    handler: (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
          return;
        }
        const url = new URL(req.url || BASE + '/summary', 'http://localhost');
        sendJson(res, 200, { ok: true, data: buildPayload(url.searchParams) });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'internal', message: error && error.message });
      }
    }
  }), 'dsh-token-usage: route summary');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + '/quota',
    handler: (req, res) => {
      try {
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, { ok: true, data: buildQuotaPayload() });
          return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          readJsonBody(req, 64 * 1024)
            .then((body) => {
              writeJsonAtomic(quotaPath, normalizeQuota(body));
              sendJson(res, 200, { ok: true, data: buildQuotaPayload() });
            })
            .catch((error) => sendJson(res, 400, { ok: false, error: 'invalid-body', message: error && error.message }));
          return;
        }
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'internal', message: error && error.message });
      }
    }
  }), 'dsh-token-usage: route quota');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + '/rescan',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      store.refresh()
        .then(() => sendJson(res, 200, { ok: true }))
        .catch((error) => sendJson(res, 500, { ok: false, error: 'internal', message: error && error.message }));
    }
  }), 'dsh-token-usage: route rescan');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + '/health',
    handler: (req, res) => {
      const snapshot = store.getSnapshot();
      sendJson(res, 200, { ok: true, data: { revision: snapshot.revision, meta: snapshot.meta } });
    }
  }), 'dsh-token-usage: route health');
}
