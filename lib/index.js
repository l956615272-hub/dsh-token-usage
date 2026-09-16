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
const QUOTA_VERSION = 2;
const QUOTA_UNITS = { '亿': 1e8, '万': 1e4, '个': 1 };

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

/** Coerce arbitrary input into a safe per-provider quota entry. */
function normalizeQuotaEntry(input) {
  const source = input && typeof input === 'object' ? input : {};
  const amount = Number(source.amount);
  const positive = Number.isFinite(amount) && amount > 0;
  return {
    // An entry with an amount is enabled unless it explicitly says otherwise,
    // which keeps older payloads (without an enabled field) working.
    enabled: source.enabled === undefined ? positive : source.enabled === true,
    amount: positive ? amount : 0,
    unit: Object.prototype.hasOwnProperty.call(QUOTA_UNITS, source.unit) ? source.unit : '亿',
    refreshDay: clampDay(source.refreshDay == null ? 1 : source.refreshDay),
    label: typeof source.label === 'string' ? source.label.slice(0, 60) : ''
  };
}

/**
 * Read the quota file. v2 is an object with a providers map keyed by provider
 * id; v1 was one top-level entry with no provider, returned here under the
 * __legacy sentinel so the caller can reassign it rather than drop it.
 */
function readQuotaMap(file) {
  const raw = readJsonFile(file, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers)) {
    const out = {};
    for (const [provider, entry] of Object.entries(raw.providers)) {
      if (typeof provider !== 'string' || provider.length === 0 || provider.length > 120) continue;
      out[provider] = normalizeQuotaEntry(entry);
    }
    return out;
  }
  if ('amount' in raw || 'refreshDay' in raw || 'unit' in raw) {
    return { __legacy: normalizeQuotaEntry(raw) };
  }
  return {};
}

/**
 * Best-effort read of the provider ids declared under llm-pi-ai.providers in
 * settings.yaml. A malformed or absent file simply yields no extra providers;
 * this never throws into the request path.
 */
function readConfiguredProviders(home) {
  try {
    const lines = readFileSync(join(home, 'settings.yaml'), 'utf8').split('\n');
    const out = [];
    let inLlm = false;
    let inProviders = false;
    for (const line of lines) {
      if (/^llm-pi-ai:\s*$/.test(line)) { inLlm = true; inProviders = false; continue; }
      if (/^[^\s]/.test(line)) { inLlm = false; inProviders = false; continue; }
      if (!inLlm) continue;
      if (/^ {2}providers:\s*$/.test(line)) { inProviders = true; continue; }
      if (!inProviders) continue;
      const match = /^ {4}([A-Za-z0-9._-]+):\s*$/.exec(line);
      if (match) { out.push(match[1]); continue; }
      if (/^ {2}\S/.test(line)) inProviders = false;
    }
    return out;
  } catch {
    return [];
  }
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

  const dshHome = process.env.DSH_HOME || homes[0] || join(homedir(), '.dsh');
  const dataDir = join(dshHome, 'dsh-token-usage');
  const quotaPath = join(dataDir, 'quota.json');
  const configuredProviders = readConfiguredProviders(dshHome);

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

  /** Per-provider quota: config, this cycle's spend, remaining and ratio. */
  const buildQuotaPayload = () => {
    const records = store.getSnapshot().records;
    const byProvider = new Map();
    const totals = new Map();
    for (const record of records) {
      const provider = record.provider || '(unknown)';
      let list = byProvider.get(provider);
      if (!list) { list = []; byProvider.set(provider, list); }
      list.push(record);
      totals.set(provider, (totals.get(provider) || 0) + (record.input || 0) + (record.output || 0) + (record.cacheRead || 0));
    }

    let quotaMap = readQuotaMap(quotaPath);
    // v1 migration: a single legacy config is reassigned to the busiest
    // provider as soon as usage data exists, instead of being dropped.
    if (quotaMap.__legacy && Object.keys(quotaMap).length === 1) {
      let top = null;
      let topTotal = -1;
      for (const [provider, total] of totals) {
        if (provider === '(unknown)') continue;
        if (total > topTotal) { top = provider; topTotal = total; }
      }
      if (top) {
        quotaMap = { [top]: quotaMap.__legacy };
        writeJsonAtomic(quotaPath, { version: QUOTA_VERSION, providers: quotaMap });
      } else {
        delete quotaMap.__legacy;
      }
    }
    delete quotaMap.__legacy;

    const known = new Set();
    for (const provider of byProvider.keys()) if (provider !== '(unknown)') known.add(provider);
    for (const provider of configuredProviders) known.add(provider);
    for (const provider of Object.keys(quotaMap)) known.add(provider);

    const providers = [];
    for (const provider of known) {
      const entry = quotaMap[provider] || normalizeQuotaEntry({});
      const providerRecords = byProvider.get(provider) || [];
      const item = {
        provider,
        label: entry.label || provider,
        enabled: entry.enabled,
        total: totals.get(provider) || 0,
        config: { amount: entry.amount, unit: entry.unit, refreshDay: entry.refreshDay, label: entry.label }
      };
      const quotaTokens = Math.round(entry.amount * (QUOTA_UNITS[entry.unit] || 1));
      if (quotaTokens > 0) {
        const range = resolveRange('cycle', { timeZone: store.timeZone, cycleDay: entry.refreshDay });
        const cycleTotals = summarize(filterRecords(providerRecords, range));
        item.configured = true;
        item.quotaTokens = quotaTokens;
        item.cycle = { fromDay: range.fromDay, toDay: range.toDay, cycleDay: range.cycleDay };
        item.used = cycleTotals.total;
        item.remaining = Math.max(0, quotaTokens - cycleTotals.total);
        item.percent = cycleTotals.total / quotaTokens;
        item.calls = cycleTotals.calls;
      } else {
        item.configured = false;
        item.quotaTokens = 0;
      }
      providers.push(item);
    }
    providers.sort((a, b) => b.total - a.total || (a.provider < b.provider ? -1 : 1));

    return {
      generatedAt: Date.now(),
      providers,
      configured: providers.some((item) => item.enabled && item.configured)
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
              const source = body && typeof body.providers === 'object' && body.providers ? body.providers : {};
              const next = {};
              for (const [provider, entry] of Object.entries(source)) {
                if (typeof provider !== 'string' || provider.length === 0 || provider.length > 120) continue;
                next[provider] = normalizeQuotaEntry(entry);
              }
              writeJsonAtomic(quotaPath, { version: QUOTA_VERSION, providers: next });
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
