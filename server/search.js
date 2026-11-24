'use strict';

const { performance } = require('node:perf_hooks');
const { ConfigurationError } = require('./database');

const TOP_K = 5;

const INDEX_SQL = `
  SELECT am.amname,
         ARRAY(
           SELECT attribute.attname
           FROM unnest(index_info.indkey) WITH ORDINALITY AS key(attnum, position)
           JOIN pg_attribute AS attribute
             ON attribute.attrelid = index_info.indrelid AND attribute.attnum = key.attnum
           WHERE key.position <= index_info.indnkeyatts
           ORDER BY key.position
         ) AS columns,
         ARRAY(
           SELECT opclass.opcname
           FROM unnest(index_info.indclass) WITH ORDINALITY AS key(opclass_oid, position)
           JOIN pg_opclass AS opclass ON opclass.oid = key.opclass_oid
           ORDER BY key.position
         ) AS opclasses
  FROM pg_index AS index_info
  JOIN pg_class AS source ON source.oid = index_info.indrelid
  JOIN pg_namespace AS namespace ON namespace.oid = source.relnamespace
  JOIN pg_class AS index_relation ON index_relation.oid = index_info.indexrelid
  JOIN pg_am AS am ON am.oid = index_relation.relam
  WHERE namespace.nspname = 'guide_finder'
    AND source.relname = 'guides'
    AND index_info.indisvalid
    AND index_info.indisready
`;

const SEARCH_SQL = `
  SELECT guide.id, guide.code, guide.title, guide.category, guide.summary,
         guide.steps, result.match_type, result.score
  FROM ai.search(
    query => $1::text,
    source_table => 'guide_finder.guides',
    search_type => $2::text,
    top_k => $3::integer,
    content_column => 'search_text',
    embedding_column => 'embedding',
    embedding_model => 'default-embedding',
    rerank => false
  ) AS result
  JOIN guide_finder.guides AS guide ON guide.ctid = result.ctid
  ORDER BY result.score DESC, guide.id
`;

function inspectIndexes(rows) {
  return {
    keyword: rows.some((row) =>
      row.amname === 'bm25' && row.columns?.length === 1 && row.columns[0] === 'search_text'),
    vector: rows.some((row) =>
      row.amname === 'diskann' && row.columns?.length === 1 &&
      row.columns[0] === 'embedding' && row.opclasses?.includes('vector_cosine_ops'))
  };
}

function failure(error, mode) {
  if (error instanceof ConfigurationError) {
    return {
      status: 'error',
      code: 'configuration',
      message: 'The database is not configured. Ask the sample operator to check the required settings.'
    };
  }
  const code = typeof error.code === 'string' ? error.code : error.name;
  console.error(`${mode} search failed:`, code);
  if (code === '28P01' || code === '28000' || code === '42501') {
    return {
      status: 'error',
      code: 'identity_or_permission',
      message: 'The database rejected the identity or its permissions. Ask the operator to check access.'
    };
  }
  return {
    status: 'error',
    code: 'unavailable',
    message: 'Search is temporarily unavailable. Ask the operator to check the database and model.'
  };
}

function missingIndex(kind) {
  return {
    status: 'error',
    code: 'missing_index',
    message: `The required ${kind} index is unavailable. Ask the operator to check the database setup.`
  };
}

async function runMode(pool, query, mode) {
  const start = performance.now();
  try {
    const result = await pool.query(SEARCH_SQL, [query, mode, TOP_K]);
    return {
      status: 'ok',
      elapsedMs: Math.round(performance.now() - start),
      results: result.rows.map((row) => ({
        id: row.id,
        code: row.code,
        title: row.title,
        category: row.category,
        summary: row.summary,
        steps: row.steps,
        matchType: row.match_type,
        score: row.score
      }))
    };
  } catch (error) {
    return failure(error, mode);
  }
}

function createSearchService(database) {
  return {
    async search(query) {
      let pool;
      let indexes;
      try {
        pool = database.getPool();
        const indexResult = await pool.query(INDEX_SQL);
        indexes = inspectIndexes(indexResult.rows);
      } catch (error) {
        const issue = failure(error, 'index inspection');
        return { keyword: issue, hybrid: issue };
      }

      const [keyword, hybrid] = await Promise.all([
        indexes.keyword ? runMode(pool, query, 'fulltext') : missingIndex('BM25 keyword'),
        indexes.keyword && indexes.vector
          ? runMode(pool, query, 'hybrid')
          : missingIndex(indexes.keyword ? 'DiskANN cosine vector' : 'BM25 keyword')
      ]);
      return { keyword, hybrid };
    }
  };
}

module.exports = { createSearchService, inspectIndexes, INDEX_SQL, SEARCH_SQL, TOP_K };
