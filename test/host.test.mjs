/**
 * Host wiring test: apply() registers its routes and serves JSON without the
 * real kernel. DSH_HOME is redirected into a temp directory so the quota file
 * is never written to the developer's own home. The scanner still also sees
 * the real ~/.dsh (resolveDshHomes always adds it), so tests assert shapes and
 * windows rather than absolute totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name, inject } from '../lib/index.js';

function makeCtx() {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (factory) => {
      const disposer = factory();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    webServer: {
      register: (route) => {
        const key = route.kind + ':' + route.path;
        routes.set(key, route);
        return () => routes.delete(key);
      }
    }
  };
  return { ctx, routes, disposers };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    done: null,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(chunk) {
      res.body = chunk || '';
      if (res._resolve) res._resolve();
    }
  };
  res.done = new Promise((resolve) => { res._resolve = resolve; });
  return res;
}

function makeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-token-usage-host-'));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

test('host plugin registers summary/quota/rescan/health and serves JSON', async () => {
  await withTempHome(async (home) => {
    const { ctx, routes, disposers } = makeCtx();
    apply(ctx, { homes: [home], cache: false, scanIntervalMs: 3600000 });

    assert.equal(name, 'dsh-token-usage');
    assert.deepEqual(inject, ['webServer']);
    assert.ok(routes.has('exact:/dsh-token-usage/summary'));
    assert.ok(routes.has('exact:/dsh-token-usage/quota'));
    assert.ok(routes.has('exact:/dsh-token-usage/rescan'));
    assert.ok(routes.has('exact:/dsh-token-usage/health'));

    const summaryRoute = routes.get('exact:/dsh-token-usage/summary');
    const res = makeRes();
    summaryRoute.handler({ method: 'GET', url: '/dsh-token-usage/summary?range=all&groupBy=day' }, res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.ok(payload.data.totals && typeof payload.data.totals.total === 'number');
    assert.equal(payload.data.totals.total, payload.data.totals.input + payload.data.totals.output + payload.data.totals.cacheRead);
    assert.equal(res.headers['cache-control'], 'no-store');

    const rejected = makeRes();
    summaryRoute.handler({ method: 'DELETE', url: '/dsh-token-usage/summary' }, rejected);
    assert.equal(rejected.statusCode, 405);

    for (const dispose of disposers) dispose();
  });
});

test('summary infers a custom one-sided window from from/to', async () => {
  await withTempHome(async (home) => {
    const { ctx, routes, disposers } = makeCtx();
    apply(ctx, { homes: [home], cache: false, scanIntervalMs: 3600000 });
    const summaryRoute = routes.get('exact:/dsh-token-usage/summary');

    const fromOnly = makeRes();
    summaryRoute.handler({ method: 'GET', url: '/dsh-token-usage/summary?from=2026-09-08&groupBy=day' }, fromOnly);
    const a = JSON.parse(fromOnly.body).data;
    assert.equal(a.range.kind, 'custom');
    assert.equal(a.range.fromDay, '2026-09-08');
    assert.equal(a.range.toMs, null);

    const toOnly = makeRes();
    summaryRoute.handler({ method: 'GET', url: '/dsh-token-usage/summary?to=2026-09-08&groupBy=day' }, toOnly);
    const b = JSON.parse(toOnly.body).data;
    assert.equal(b.range.kind, 'custom');
    assert.equal(b.range.fromMs, null);
    assert.equal(b.range.toDay, '2026-09-08');

    const both = makeRes();
    summaryRoute.handler({ method: 'GET', url: '/dsh-token-usage/summary?from=2026-09-01&to=2026-09-08&groupBy=day' }, both);
    const c = JSON.parse(both.body).data;
    assert.equal(c.range.fromDay, '2026-09-01');
    assert.equal(c.range.toDay, '2026-09-08');

    const cycle = makeRes();
    summaryRoute.handler({ method: 'GET', url: '/dsh-token-usage/summary?range=cycle&cycleDay=1&groupBy=day' }, cycle);
    const d = JSON.parse(cycle.body).data;
    assert.equal(d.range.kind, 'cycle');
    assert.equal(d.range.cycleDay, 1);

    for (const dispose of disposers) dispose();
  });
});

test('quota route persists config and returns the current cycle', async () => {
  await withTempHome(async (home) => {
    const { ctx, routes, disposers } = makeCtx();
    apply(ctx, { homes: [home], cache: false, scanIntervalMs: 3600000 });
    const quotaRoute = routes.get('exact:/dsh-token-usage/quota');

    const initial = makeRes();
    quotaRoute.handler({ method: 'GET', url: '/dsh-token-usage/quota' }, initial);
    assert.equal(initial.statusCode, 200);
    assert.equal(JSON.parse(initial.body).data.configured, false);

    const saved = makeRes();
    quotaRoute.handler(makeReq('POST', '/dsh-token-usage/quota', { amount: 20, unit: '亿', refreshDay: 1, label: '公司网关' }), saved);
    await saved.done;
    const data = JSON.parse(saved.body).data;
    assert.equal(data.configured, true);
    assert.equal(data.quotaTokens, 2e9);
    assert.equal(data.config.label, '公司网关');
    assert.equal(data.config.refreshDay, 1);
    assert.equal(data.cycle.cycleDay, 1);
    assert.match(data.cycle.fromDay, /^\d{4}-\d{2}-01$/);
    assert.ok(data.used >= 0);
    assert.equal(data.remaining, Math.max(0, data.quotaTokens - data.used));
    assert.ok(data.percent >= 0);

    // The config file lives under the redirected DSH_HOME, not the real one.
    const file = join(home, 'dsh-token-usage', 'quota.json');
    assert.ok(existsSync(file), 'quota.json written');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).amount, 20);

    // Bad input is coerced, not stored raw.
    const clamped = makeRes();
    quotaRoute.handler(makeReq('POST', '/dsh-token-usage/quota', { amount: -5, unit: 'bogus', refreshDay: 99 }), clamped);
    await clamped.done;
    const coerced = JSON.parse(clamped.body).data;
    assert.equal(coerced.config.amount, 0);
    assert.equal(coerced.config.unit, '亿');
    assert.equal(coerced.config.refreshDay, 31);
    assert.equal(coerced.configured, false);

    for (const dispose of disposers) dispose();
  });
});

test('client bundle exports a settings.section contribution', async () => {
  const registered = [];
  const spec = await new Promise((resolve) => {
    globalThis.window = {
      __ModuleLoader__: {
        load: (value) => resolve(value)
      }
    };
    return import('../lib/client.js').then(() => {});
  });
  const fakeReact = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }) };
  const moduleValue = spec.factory((request) => {
    if (request === 'react') return fakeReact;
    throw new Error('unexpected import: ' + request);
  });
  assert.equal(moduleValue.name, 'dsh-token-usage');
  assert.deepEqual(moduleValue.inject, ['slots']);

  const ctx = {
    slots: {
      inject: (slotName, callback) => { registered.push({ slotName, result: callback() }); },
      register: (entry, component) => { registered.push({ entry, component }); return () => {}; }
    }
  };
  moduleValue.apply(ctx);
  const contribution = registered.find((item) => item.entry);
  const injected = registered.find((item) => item.slotName);
  assert.equal(injected.slotName, 'settings.section');
  assert.equal(contribution.entry.id, 'token-usage');
  assert.equal(typeof contribution.entry.label(), 'string');
  assert.equal(typeof contribution.component, 'function');
  delete globalThis.window;
});
