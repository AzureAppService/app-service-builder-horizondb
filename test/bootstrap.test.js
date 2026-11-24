'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { populateGuides } = require('../db/bootstrap');
const guides = require('../db/guides.json');

function existingRows() {
  return guides.map((guide) => ({
    id: guide.id, code: guide.code, title: guide.title, category: guide.category,
    summary: guide.summary, steps: guide.steps, embedded: false,
    search_text: [guide.code, guide.title, guide.category, guide.summary, guide.signals, ...guide.steps].join(' ')
  }));
}

test('keyword bootstrap seeds text and BM25 without calling models or faking vectors', async () => {
  const calls = [];
  await populateGuides({ query: async (sql, values) => { calls.push({ sql, values }); } }, guides, 'keyword');
  const inserts = calls.filter((call) => /INSERT INTO/.test(call.sql));
  assert.equal(inserts.length, guides.length);
  assert.deepEqual(inserts[0].values.slice(0, 6), [
    guides[0].id, guides[0].code, guides[0].title, guides[0].category, guides[0].summary, guides[0].steps
  ]);
  assert.ok(calls.some((call) => /USING bm25/.test(call.sql)));
  assert.ok(calls.every((call) => !/ai\.embed|diskann|SET NOT NULL/.test(call.sql)));
  assert.ok(inserts.every((call) => !/embedding/.test(call.sql)));
});

test('embedding completion refuses modified, incomplete or already embedded guides before model calls', async () => {
  for (const rows of [
    existingRows().slice(1),
    existingRows().map((row, i) => i ? row : { ...row, summary: 'Modified' }),
    existingRows().map((row, i) => i ? row : { ...row, embedded: true })
  ]) {
    let calls = 0;
    await assert.rejects(populateGuides({ query: async () => {
      calls++;
      return { rows };
    } }, guides, 'complete'), /unchanged, unembedded/);
    assert.equal(calls, 1);
  }
});

test('completion generates real vectors for every guide and installs DiskANN without reseeding text', async () => {
  const calls = [];
  await populateGuides({ query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: existingRows() };
  } }, guides, 'complete');
  const embeddings = calls.filter((call) => /ai\.embed/.test(call.sql));
  assert.deepEqual(embeddings.map((call) => call.values[0]), guides.map((guide) => guide.id));
  assert.ok(calls.some((call) => /embedding SET NOT NULL/.test(call.sql)));
  assert.ok(calls.some((call) => /USING diskann/.test(call.sql)));
  assert.ok(calls.every((call) => !/INSERT INTO|CREATE TABLE|CREATE SCHEMA|USING bm25/.test(call.sql)));
});

test('the original all-in-one setup still creates both indexes and embeds every inserted guide', async () => {
  const calls = [];
  await populateGuides({ query: async (sql, values) => { calls.push({ sql, values }); } }, guides, 'all');
  assert.equal(calls.filter((call) => /INSERT INTO/.test(call.sql)).length, guides.length);
  assert.equal(calls.filter((call) => /ai\.embed/.test(call.sql)).length, guides.length);
  assert.ok(calls.some((call) => /USING bm25/.test(call.sql)));
  assert.ok(calls.some((call) => /USING diskann/.test(call.sql)));
});
