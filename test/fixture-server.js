'use strict';

const { createApp } = require('../server/app');
const guides = require('../db/guides.json');

const searchService = {
  async search(query) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (query === 'fixture-error') {
      return {
        keyword: { status: 'error', message: 'Simulated keyword error.' },
        hybrid: { status: 'error', message: 'Simulated hybrid error.' }
      };
    }
    if (query === 'fixture-empty') {
      return {
        keyword: { status: 'ok', elapsedMs: 12, results: [] },
        hybrid: { status: 'ok', elapsedMs: 22, results: [] }
      };
    }
    const selected = guides.filter((guide) =>
      `${guide.code} ${guide.title} ${guide.signals}`.toLowerCase().includes(query.toLowerCase()));
    const sample = selected.length ? selected : [guides[0], guides[6], guides[3]];
    const format = (guide, matchType, score) => ({
      id: guide.id,
      code: guide.code,
      title: guide.title,
      category: guide.category,
      summary: guide.summary,
      steps: guide.steps,
      matchType,
      score
    });
    return {
      keyword: { status: 'ok', elapsedMs: 12, results: sample.map((guide) => format(guide, 'fulltext', 1.24)) },
      hybrid: { status: 'ok', elapsedMs: 88, results: sample.map((guide) => format(guide, 'vector+fulltext', 0.031)) }
    };
  }
};

const app = createApp({ searchService, database: { async close() {} } });
const port = Number(process.env.PORT || 4189);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Visual fixture only, not a HorizonDB connection: http://127.0.0.1:${port}`);
});
process.once('SIGTERM', () => server.close());
