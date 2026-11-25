'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AzureCliCredential } = require('@azure/identity');
const { Client } = require('pg');
const { databaseConfig } = require('../server/database');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function identifier(value) {
  if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 63) {
    throw new Error('Database and role identifiers must be between 1 and 63 bytes.');
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function guideValues(guide) {
  const text = [guide.code, guide.title, guide.category, guide.summary, guide.signals, ...guide.steps].join(' ');
  return [guide.id, guide.code, guide.title, guide.category, guide.summary, guide.steps, text];
}

async function configureModelUsers(client, adminUser, runtimeRole) {
  const aliases = ['default-embedding', 'default-chat', 'default-reranker'];
  const models = await client.query(`
    SELECT alias, registry_type, status
    FROM model_registry.model_list_all()
    WHERE alias = ANY($1::text[])
  `, [aliases]);
  const unavailable = aliases.filter((alias) => !models.rows.some((model) =>
    model.alias === alias && model.registry_type === 'Managed Model' && model.status === 'registered'));
  if (unavailable.length) {
    throw new Error(`Managed models are not registered in this database: ${unavailable.join(', ')}.`);
  }
  await client.query('SELECT model_registry.model_user_set($1::text, $2::text[])', [
    'default-embedding', [adminUser, runtimeRole]
  ]);
  for (const model of ['default-chat', 'default-reranker']) {
    await client.query('SELECT model_registry.model_user_set($1::text, $2::text[])', [model, [adminUser]]);
  }
}

async function requireExistingRuntimeAccess(client, runtimeRole, includeEmbedding) {
  const access = await client.query(`
    SELECT has_database_privilege($1, current_database(), 'CONNECT') AS can_connect,
           has_schema_privilege($1, 'ai', 'USAGE') AS can_use_ai,
           has_function_privilege($1,
             'ai.search(text,text,text,integer,integer,text,text,text,text,boolean)', 'EXECUTE') AS can_search,
           CASE WHEN $2::boolean THEN has_function_privilege($1,
             'ai.embed(text,text,integer,integer,integer,integer)', 'EXECUTE') ELSE true END AS can_embed
  `, [runtimeRole, includeEmbedding]);
  const { can_connect, can_use_ai, can_search, can_embed } = access.rows[0];
  if (!can_connect || !can_use_ai || !can_search || !can_embed) {
    throw new Error('The runtime role needs existing database and AI function access in postgres; bootstrap will not grant it.');
  }
}

async function populateGuides(client, guides, phase) {
  if (phase === 'complete') {
    const existing = await client.query(`
      SELECT id, code, title, category, summary, steps, search_text,
             embedding IS NOT NULL AS embedded
      FROM guide_finder.guides
    `);
    const rows = new Map(existing.rows.map((row) => [row.id, row]));
    if (existing.rows.length !== guides.length || guides.some((guide) => {
      const row = rows.get(guide.id);
      return !row || row.embedded ||
        JSON.stringify([row.id, row.code, row.title, row.category, row.summary, row.steps, row.search_text]) !==
          JSON.stringify(guideValues(guide));
    })) {
      throw new Error('Embedding completion requires the unchanged, unembedded synthetic guide collection.');
    }
  } else {
    await client.query('CREATE SCHEMA guide_finder');
    await client.query('REVOKE ALL ON SCHEMA guide_finder FROM PUBLIC');
    await client.query(`
      CREATE TABLE guide_finder.guides (
        id text PRIMARY KEY,
        code text NOT NULL UNIQUE,
        title text NOT NULL,
        category text NOT NULL,
        summary text NOT NULL,
        steps text[] NOT NULL,
        search_text text NOT NULL,
        embedding vector(1536)
      )
    `);
    for (const guide of guides) {
      await client.query(`
        INSERT INTO guide_finder.guides (id, code, title, category, summary, steps, search_text)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, guideValues(guide));
    }
    await client.query(`
      CREATE INDEX guides_search_bm25 ON guide_finder.guides USING bm25 (search_text)
      WITH (text_config = 'english')
    `);
  }
  if (phase !== 'keyword') {
    for (const guide of guides) {
      await client.query(`
        UPDATE guide_finder.guides
        SET embedding = ai.embed(text => search_text, model => 'default-embedding',
          dimensions => 1536)::vector(1536)
        WHERE id = $1
      `, [guide.id]);
    }
    await client.query('ALTER TABLE guide_finder.guides ALTER COLUMN embedding SET NOT NULL');
    await client.query(`
      CREATE INDEX guides_embedding_diskann ON guide_finder.guides
      USING diskann (embedding vector_cosine_ops)
    `);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--keyword-only', '--complete-embeddings'].includes(args[0]))) {
    throw new Error('Use no option, --keyword-only, or --complete-embeddings.');
  }
  const phase = args[0] === '--keyword-only' ? 'keyword'
    : args[0] === '--complete-embeddings' ? 'complete' : 'all';
  const config = databaseConfig(process.env);
  const adminUser = required('HORIZONDB_ADMIN_USER');
  const runtimeRole = required('HORIZONDB_RUNTIME_ROLE');
  if (required('HORIZONDB_CONFIRM_DATABASE') !== config.database) {
    throw new Error('HORIZONDB_CONFIRM_DATABASE must exactly match the dedicated database name.');
  }
  if (config.user !== runtimeRole) {
    throw new Error('HORIZONDB_USER must match the mapped HORIZONDB_RUNTIME_ROLE.');
  }
  const databaseName = identifier(config.database);
  const roleName = identifier(runtimeRole);
  const credential = new AzureCliCredential();
  const client = new Client({
    host: config.host,
    port: 5432,
    database: config.database,
    user: adminUser,
    password: async () => {
      const token = await credential.getToken(config.scope, { abortSignal: AbortSignal.timeout(10000) });
      if (!token || token.expiresOnTimestamp <= Date.now() + 30000) {
        throw new Error('Azure CLI did not return a usable administrator token.');
      }
      return token.token;
    },
    ssl: { rejectUnauthorized: true },
    application_name: 'horizon-guide-bootstrap',
    connectionTimeoutMillis: 10000,
    statement_timeout: 90000
  });
  let connected = false;
  let inTransaction = false;
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN');
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('guide_finder.bootstrap'))");

    const schema = await client.query("SELECT to_regnamespace('guide_finder') IS NOT NULL AS exists");
    if (schema.rows[0].exists && phase !== 'complete') {
      throw new Error('The guide_finder schema already exists. Bootstrap will not overwrite it.');
    }
    if (!schema.rows[0].exists && phase === 'complete') {
      throw new Error('Run the keyword-only bootstrap before completing embeddings.');
    }

    const role = await client.query(`
      SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
             COALESCE(pg_has_role(oid, to_regrole('azure_pg_admin'), 'MEMBER'), false) AS is_admin
      FROM pg_roles WHERE rolname = $1
    `, [runtimeRole]);
    if (role.rowCount !== 1 || !role.rows[0].rolcanlogin) {
      throw new Error('The mapped managed-identity database login does not exist.');
    }
    if (role.rows[0].rolsuper || role.rows[0].rolcreatedb || role.rows[0].rolcreaterole ||
        role.rows[0].rolreplication || role.rows[0].is_admin) {
      throw new Error('The runtime database login has elevated privileges; use a least-privilege principal.');
    }

    const preload = await client.query("SHOW shared_preload_libraries");
    if (!preload.rows[0].shared_preload_libraries.split(',').some((item) => item.trim() === 'pg_textsearch')) {
      throw new Error('pg_textsearch must be preloaded in the pool parameter group before bootstrap.');
    }

    const extensions = ['vector', 'pg_textsearch', 'azure_ai'];
    if (phase !== 'keyword') extensions.push('pg_diskann');
    for (const extension of extensions) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    }
    const searchFunction = await client.query(`
      SELECT count(*)::integer AS count
      FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ai' AND p.proname = 'search'
    `);
    if (!searchFunction.rows[0].count) {
      throw new Error('This database does not expose ai.search; check the azure_ai version.');
    }
    if (config.database === 'postgres') {
      await requireExistingRuntimeAccess(client, runtimeRole, phase !== 'keyword');
    }
    if (phase !== 'keyword') {
      await configureModelUsers(client, adminUser, runtimeRole);
    }

    const guides = JSON.parse(fs.readFileSync(path.join(__dirname, 'guides.json'), 'utf8'));
    await populateGuides(client, guides, phase);
    await client.query(`GRANT USAGE ON SCHEMA guide_finder TO ${roleName}`);
    await client.query(`GRANT SELECT ON guide_finder.guides TO ${roleName}`);
    if (config.database !== 'postgres') {
      await client.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${roleName}`);
      await client.query(`GRANT USAGE ON SCHEMA ai TO ${roleName}`);
      await client.query(`
        GRANT EXECUTE ON FUNCTION ai.search(text, text, text, integer, integer, text, text, text, text, boolean)
        TO ${roleName}
      `);
      if (phase !== 'keyword') {
        await client.query(`
          GRANT EXECUTE ON FUNCTION ai.embed(text, text, integer, integer, integer, integer) TO ${roleName}
        `);
      }
    }

    const verification = await client.query(`
      SELECT count(*)::integer AS total, count(embedding)::integer AS embedded,
             min(vector_dims(embedding)) AS min_dimensions,
             max(vector_dims(embedding)) AS max_dimensions
      FROM guide_finder.guides
    `);
    const counts = verification.rows[0];
    if (counts.total !== guides.length ||
        (phase === 'keyword' ? counts.embedded !== 0 :
          counts.embedded !== guides.length || counts.min_dimensions !== 1536 || counts.max_dimensions !== 1536)) {
      throw new Error('Embedding verification did not match the synthetic guide collection.');
    }
    await client.query('COMMIT');
    inTransaction = false;
    console.log(`Installed ${counts.total} synthetic guides with ${phase === 'keyword' ? 'BM25 only; embeddings remain NULL' : 'BM25 and DiskANN indexes'}.`);
    console.log('Verify both retrieval modes and permissions using the attached runtime identity.');
  } catch (error) {
    if (connected && inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError.code || rollbackError.message);
      }
    }
    throw error;
  } finally {
    if (connected) await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Bootstrap failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { configureModelUsers, populateGuides, requireExistingRuntimeAccess };
