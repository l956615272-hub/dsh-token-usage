/**
 * Host wiring tests. DSH_HOME is redirected into a temp directory so cache and
 * quota files are never written to the developer's own home. Per-provider
 * quota isolation is proved with synthetic provider ids that cannot collide
 * with the machine's real usage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function writeSession(path, lines) {
  writeFileSync(path, Buffer.concat(lines.map((line) => frame(line + '\n'))));
}

function usageEvent(id, time, provider, model, input, output, cacheRead) {
  return JSON.stringify({
    type: 'assistant/message',
    seq: 2,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { id, source: { provider, model } },
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, totalTokens: input + output + cacheRead }
    }
  });
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

function seedTwoProviders(home) {
  const dir = join(home, 'sessions', '--test--', 'session-test');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const header = JSON.stringify({ type: 'session', version: 0, id: 'session-test', createdAt: now, cwd: '/tmp/test' });
  writeSession(join(dir, 'session.jsonl.zstd'), [
    header,
    usageEvent('msg-a', now, 'testprov-a', 'model-x', 1000, 200, 800),
    usageEvent('msg-b', now, 'testprov-b', 'model-y', 50, 10, 40)
  ]);
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

    const cycle = makeRes();
    summaryRoute.handler({ method: 'GET', url: '/dsh-token-usage/summary?range=cycle&cycleDay=1&groupBy=day' }, cycle);
    assert.equal(JSON.parse(cycle.body).data.range.kind, 'cycle');

    for (const dispose of disposers) dispose();
  });
});

test('quota is isolated per provider and honours the enable switch', async () => {
  await withTempHome(async (home) => {
    seedTwoProviders(home);
    const { ctx, routes, disposers } = makeCtx();
    apply(ctx, { homes: [home], cache: false, scanIntervalMs: 3600000 });
    const quotaRoute = routes.get('exact:/dsh-token-usage/quota');

    const initial = makeRes();
    quotaRoute.handler({ method: 'GET', url: '/dsh-token-usage/quota' }, initial);
    assert.equal(initial.statusCode, 200);
    const before = JSON.parse(initial.body).data;
    const providerA = before.providers.find((item) => item.provider === 'testprov-a');
    const providerB = before.providers.find((item) => item.provider === 'testprov-b');
    assert.ok(providerA && providerB, 'both synthetic providers discovered');
    assert.equal(providerA.total, 2000);
    assert.equal(providerA.configured, false);
    assert.equal(providerA.enabled, false);

    // Only testprov-a gets a quota; testprov-b stays switched off.
    const saved = makeRes();
    quotaRoute.handler(makeReq('POST', '/dsh-token-usage/quota', {
      providers: {
        'testprov-a': { enabled: true, amount: 1, unit: '亿', refreshDay: 1, label: '网关 A' },
        'testprov-b': { enabled: false, amount: 0, unit: '亿', refreshDay: 1, label: '' }
      }
    }), saved);
    await saved.done;
    const after = JSON.parse(saved.body).data;

    const a = after.providers.find((item) => item.provider === 'testprov-a');
    const b = after.providers.find((item) => item.provider === 'testprov-b');
    assert.equal(a.enabled, true);
    assert.equal(a.configured, true);
    assert.equal(a.label, '网关 A');
    assert.equal(a.quotaTokens, 1e8);
    // testprov-a's cycle spend is only its own 2000, not the whole machine's.
    assert.equal(a.used, 2000);
    assert.equal(a.remaining, 1e8 - 2000);
    assert.equal(a.percent, 2000 / 1e8);
    assert.equal(b.enabled, false);
    assert.equal(b.configured, false);
    assert.equal(after.configured, true);

    // The file is v2 and lives under the redirected DSH_HOME.
    const file = join(home, 'dsh-token-usage', 'quota.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(stored.version, 2);
    assert.equal(stored.providers['testprov-a'].amount, 1);
    assert.equal(stored.providers['testprov-a'].enabled, true);
    assert.equal(stored.providers['testprov-b'].enabled, false);

    for (const dispose of disposers) dispose();
  });
});

test('legacy single-quota config migrates to the busiest provider', async () => {
  await withTempHome(async (home) => {
    seedTwoProviders(home);
    mkdirSync(join(home, 'dsh-token-usage'), { recursive: true });
    writeFileSync(join(home, 'dsh-token-usage', 'quota.json'), JSON.stringify({ amount: 20, unit: '亿', refreshDay: 1, label: '旧配置' }));
    const { ctx, routes, disposers } = makeCtx();
    apply(ctx, { homes: [home], cache: false, scanIntervalMs: 3600000 });
    const quotaRoute = routes.get('exact:/dsh-token-usage/quota');
    const res = makeRes();
    quotaRoute.handler({ method: 'GET', url: '/dsh-token-usage/quota' }, res);
    const data = JSON.parse(res.body).data;
    const stored = JSON.parse(readFileSync(join(home, 'dsh-token-usage', 'quota.json'), 'utf8'));
    assert.equal(stored.version, 2, 'migrated file is v2');
    const migrated = Object.keys(stored.providers || {});
    assert.equal(migrated.length, 1, 'exactly one provider receives the legacy config');
    assert.equal(stored.providers[migrated[0]].label, '旧配置');
    assert.equal(stored.providers[migrated[0]].amount, 20);
    // The real machine data is merged with the synthetic home, so assert the
    // relationship (busiest provider) rather than a concrete provider name.
    const busiest = data.providers.reduce((best, item) => (best === null || item.total > best.total ? item : best), null);
    assert.equal(migrated[0], busiest.provider);
    assert.equal(busiest.label, '旧配置');
    assert.equal(busiest.quotaTokens, 2e9);
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
