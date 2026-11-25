'use strict';

const { ManagedIdentityCredential } = require('@azure/identity');
const { Pool } = require('pg');

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`${name} is required.`);
  }
  return value;
}

function databaseConfig(env) {
  const host = required(env, 'HORIZONDB_HOST').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.horizondb\.azure\.com$/.test(host) ||
      host.includes('..')) {
    throw new ConfigurationError('HORIZONDB_HOST must be an Azure HorizonDB hostname.');
  }

  const clientId = required(env, 'AZURE_CLIENT_ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    throw new ConfigurationError('AZURE_CLIENT_ID must be a managed identity client ID.');
  }

  const scope = required(env, 'HORIZONDB_TOKEN_SCOPE');
  let scopeUrl;
  try {
    scopeUrl = new URL(scope);
  } catch {
    throw new ConfigurationError('HORIZONDB_TOKEN_SCOPE must be an HTTPS Entra scope.');
  }
  if (scopeUrl.protocol !== 'https:' || !scopeUrl.pathname.endsWith('/.default') ||
      scopeUrl.username || scopeUrl.password || scopeUrl.search || scopeUrl.hash) {
    throw new ConfigurationError('HORIZONDB_TOKEN_SCOPE must be an HTTPS Entra .default scope.');
  }

  return {
    host,
    database: required(env, 'HORIZONDB_DATABASE'),
    user: required(env, 'HORIZONDB_USER'),
    clientId,
    scope
  };
}

function createPool(config, credential = new ManagedIdentityCredential({ clientId: config.clientId })) {
  const pool = new Pool({
    host: config.host,
    port: 5432,
    database: config.database,
    user: config.user,
    password: async () => {
      const accessToken = await credential.getToken(config.scope, {
        abortSignal: AbortSignal.timeout(8000)
      });
      if (!accessToken || accessToken.expiresOnTimestamp <= Date.now() + 30000) {
        throw new Error('Managed identity did not return a usable database token.');
      }
      return accessToken.token;
    },
    ssl: { rejectUnauthorized: true },
    application_name: 'horizon-guide-finder',
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    query_timeout: 17000,
    maxLifetimeSeconds: 900,
    max: 4
  });
  pool.on('error', (error) => {
    console.error('Idle database connection failed:', error.code || error.name);
  });
  return pool;
}

function createDatabase(env = process.env) {
  let pool;
  return {
    getPool() {
      if (!pool) {
        pool = createPool(databaseConfig(env));
      }
      return pool;
    },
    async close() {
      if (pool) {
        await pool.end();
      }
    }
  };
}

module.exports = { ConfigurationError, createDatabase, createPool, databaseConfig };
