'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../server/app');

async function start(t, searchService) {
  const app = createApp({
    searchService,
    database: { async close() {} }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

function request(base, body) {
  return fetch(`${base}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const ok = { status: 'ok', elapsedMs: 1, results: [] };
const failed = { status: 'error', code: 'unavailable', message: 'Unavailable.' };

test('health is independent of database readiness and invalid searches are rejected', async (t) => {
  let called = false;
  const base = await start(t, { async search() { called = true; return { keyword: ok, hybrid: ok }; } });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  for (const query of ['', ' ', 'x'.repeat(181), 'bad\u0000input']) {
    const response = await request(base, { query });
    assert.equal(response.status, 400);
  }
  assert.equal(called, false);
});

test('returns an explicit partial status when only one retrieval mode succeeds', async (t) => {
  const base = await start(t, { async search() { return { keyword: ok, hybrid: failed }; } });
  const response = await request(base, { query: 'DEMO-104' });
  assert.equal(response.status, 207);
  const body = await response.json();
  assert.equal(body.keyword.status, 'ok');
  assert.equal(body.hybrid.status, 'error');
});

test('returns an error when both retrieval modes are unavailable', async (t) => {
  const base = await start(t, { async search() { return { keyword: failed, hybrid: failed }; } });
  const response = await request(base, { query: 'DEMO-104' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).hybrid.status, 'error');
});

test('limits concurrent searches without queuing unbounded model work', async (t) => {
  let release;
  let started = 0;
  let allStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { allStarted = resolve; });
  const base = await start(t, {
    async search() {
      started += 1;
      if (started === 4) allStarted();
      await gate;
      return { keyword: ok, hybrid: ok };
    }
  });
  const pending = Array.from({ length: 4 }, () => request(base, { query: 'test' }));
  await ready;
  const excess = await request(base, { query: 'test' });
  assert.equal(excess.status, 429);
  release();
  assert.deepEqual((await Promise.all(pending)).map((response) => response.status), [200, 200, 200, 200]);
});
