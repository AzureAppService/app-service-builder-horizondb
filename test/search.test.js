'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSearchService, INDEX_SQL, SEARCH_SQL, TOP_K } = require('../server/search');

const indexes = [
  { amname: 'bm25', columns: ['search_text'], opclasses: ['text_ops'] },
  { amname: 'diskann', columns: ['embedding'], opclasses: ['vector_cosine_ops'] }
];

test('runs parameterized keyword and hybrid queries and preserves observed match types', async () => {
  const calls = [];
  const query = "DEMO-104'; DROP TABLE guide_finder.guides; --";
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql === INDEX_SQL) return { rows: indexes };
      return {
        rows: [{
          id: 'pool-wait',
          code: 'DEMO-104',
          title: 'Pool wait',
          category: 'Connections',
          summary: 'Synthetic summary',
          steps: ['Check sessions'],
          match_type: values[1] === 'hybrid' ? 'vector+fulltext' : 'fulltext',
          score: 0.42
        }]
      };
    }
  };
  const result = await createSearchService({ getPool: () => pool }).search(query);
  const searches = calls.filter((call) => call.sql === SEARCH_SQL);
  assert.deepEqual(searches.map((call) => call.values), [
    [query, 'fulltext', TOP_K], [query, 'hybrid', TOP_K]
  ]);
  assert.equal(result.keyword.results[0].matchType, 'fulltext');
  assert.equal(result.hybrid.results[0].matchType, 'vector+fulltext');
  assert.equal(SEARCH_SQL.includes(query), false);
});

test('does not present a hybrid fallback as a successful hybrid query', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return sql === INDEX_SQL ? { rows: [indexes[0]] } : { rows: [] };
    }
  };
  const result = await createSearchService({ getPool: () => pool }).search('a symptom');
  assert.equal(result.keyword.status, 'ok');
  assert.equal(result.hybrid.status, 'error');
  assert.equal(result.hybrid.code, 'missing_index');
  assert.equal(calls.filter((call) => call.sql === SEARCH_SQL).length, 1);
});

test('surfaces a model or identity failure without hiding successful keyword results', async () => {
  const pool = {
    async query(sql, values) {
      if (sql === INDEX_SQL) return { rows: indexes };
      if (values[1] === 'hybrid') {
        const error = new Error('sensitive database detail');
        error.code = '42501';
        throw error;
      }
      return { rows: [] };
    }
  };
  const result = await createSearchService({ getPool: () => pool }).search('a symptom');
  assert.equal(result.keyword.status, 'ok');
  assert.equal(result.hybrid.status, 'error');
  assert.equal(result.hybrid.code, 'identity_or_permission');
  assert.doesNotMatch(JSON.stringify(result), /sensitive database detail/);
});
