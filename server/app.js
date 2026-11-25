'use strict';

const express = require('express');
const path = require('node:path');
const { createDatabase } = require('./database');
const { createSearchService } = require('./search');

function createApp(options = {}) {
  const app = express();
  const database = options.database || createDatabase(options.env);
  const searchService = options.searchService || createSearchService(database);
  let windowStart = Date.now();
  let requestsInWindow = 0;
  let inFlight = 0;

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    next();
  });

  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store').status(200).json({ status: 'ok' });
  });

  app.post('/api/search', express.json({ limit: '2kb', strict: true }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query || query.length > 180 || /[\u0000-\u001f\u007f]/.test(query)) {
      res.status(400).json({ error: 'Enter a search of 1-180 characters without control characters.' });
      return;
    }

    const now = Date.now();
    if (now - windowStart >= 60000) {
      windowStart = now;
      requestsInWindow = 0;
    }
    if (requestsInWindow >= 30 || inFlight >= 4) {
      res.set('Retry-After', '60').status(429).json({
        error: 'Search is busy. Please wait a moment and try again.'
      });
      return;
    }

    requestsInWindow += 1;
    inFlight += 1;
    try {
      const result = await searchService.search(query);
      const successes = [result.keyword, result.hybrid].filter((mode) => mode.status === 'ok').length;
      res.status(successes === 2 ? 200 : successes === 1 ? 207 : 503).json(result);
    } catch (error) {
      console.error('Search request failed:', error.code || error.name);
      res.status(503).json({ error: 'Search is temporarily unavailable. Please try again later.' });
    } finally {
      inFlight -= 1;
    }
  });

  app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'The search request is too large.' });
      return;
    }
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'The search request is not valid JSON.' });
      return;
    }
    console.error('Request failed:', error.code || error.name);
    res.status(500).json({ error: 'The request could not be completed.' });
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    fallthrough: true,
    maxAge: '1h'
  }));
  app.use((req, res) => res.status(404).send('Not found'));
  app.locals.close = () => database.close();
  return app;
}

module.exports = { createApp };
