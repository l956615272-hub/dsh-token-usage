/**
 * dsh-token-usage - host half.
 *
 * The host owns a UsageStore that scans every DSH home's session logs, keeps a
 * de-duplicated usage snapshot warm, and serves it over local HTTP so the
 * browser half (and the standalone report CLI) can render totals.
 *
 * Deliberately dependency-free: only node: builtins are imported, so the
 * plugin loads inside the Electron desktop shell whose profile node_modules
 * does not expose the @deepseek-ai kernel packages.
 */
import { UsageStore } from './core/store.js';
import { buildSummary } from './core/aggregate.js';
import { resolveDshHomes } from './core/paths.js';

export const name = 'dsh-token-usage';

/** The web server is the only hard dependency; the tool/command surfaces are optional. */
export const inject = ['webServer'];

const BASE = '/dsh-token-usage';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
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

  // Lifecycle: start() returns a disposer (clears the interval).
  ctx.effect(() => store.start(), 'dsh-token-usage: scanner');

  const buildPayload = (searchParams) => {
    const snapshot = store.getSnapshot();
    return buildSummary(snapshot.records, {
      timeZone: store.timeZone,
      range: searchParams.get('range') || 'all',
      from: searchParams.get('from'),
      to: searchParams.get('to'),
      groupBy: searchParams.get('groupBy') || 'day',
      coverage: {
        ...snapshot.meta,
        revision: snapshot.revision
      }
    });
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
