/**
 * Host wiring test: apply() registers the three routes and serves JSON without
 * needing the real kernel. The scanner runs against an empty temp home.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
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
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(chunk) { res.body = chunk || ''; }
  };
  return res;
}

test('host plugin registers summary/rescan/health routes and serves JSON', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-token-usage-host-'));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const { ctx, routes, disposers } = makeCtx();
  apply(ctx, { homes: [home], cache: false, scanIntervalMs: 3600000 });

  assert.equal(name, 'dsh-token-usage');
  assert.deepEqual(inject, ['webServer']);
  assert.ok(routes.has('exact:/dsh-token-usage/summary'));
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
