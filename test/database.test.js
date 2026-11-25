'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConfigurationError, createPool, databaseConfig } = require('../server/database');

const env = {
  HORIZONDB_HOST: 'example.ro.test.westus2.horizondb.azure.com',
  HORIZONDB_DATABASE: 'fieldguides',
  HORIZONDB_USER: 'guide-runtime',
  AZURE_CLIENT_ID: '12345678-1234-1234-1234-123456789abc',
  HORIZONDB_TOKEN_SCOPE: 'https://database.example/.default'
};

test('requires a HorizonDB host, explicit user-assigned identity, and Entra scope', () => {
  assert.equal(databaseConfig(env).user, 'guide-runtime');
  for (const changes of [
    { HORIZONDB_HOST: 'example.com' },
    { HORIZONDB_HOST: 'x..y.horizondb.azure.com' },
    { AZURE_CLIENT_ID: '' },
    { AZURE_CLIENT_ID: 'not-a-client-id' },
    { HORIZONDB_TOKEN_SCOPE: 'http://database.example/.default' },
    { HORIZONDB_TOKEN_SCOPE: 'https://database.example/not-a-scope' },
    { HORIZONDB_DATABASE: '' }
  ]) {
    assert.throws(() => databaseConfig({ ...env, ...changes }), ConfigurationError);
  }
});

test('obtains a usable token for each new physical connection and verifies TLS', async () => {
  const calls = [];
  const credential = {
    async getToken(scope) {
      calls.push(scope);
      return { token: `token-${calls.length}`, expiresOnTimestamp: Date.now() + 600000 };
    }
  };
  const pool = createPool(databaseConfig(env), credential);
  assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true });
  assert.equal(await pool.options.password(), 'token-1');
  assert.equal(await pool.options.password(), 'token-2');
  assert.deepEqual(calls, [env.HORIZONDB_TOKEN_SCOPE, env.HORIZONDB_TOKEN_SCOPE]);
  await pool.end();
});

test('refuses an expired or nearly expired identity token', async () => {
  const pool = createPool(databaseConfig(env), {
    async getToken() {
      return { token: 'stale', expiresOnTimestamp: Date.now() + 1000 };
    }
  });
  await assert.rejects(pool.options.password(), /usable database token/);
  await pool.end();
});
