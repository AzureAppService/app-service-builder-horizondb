'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const app = createApp();
const server = app.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`Guide finder listening on port ${port}.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(async () => {
      try {
        await app.locals.close();
        process.exitCode = 0;
      } catch (error) {
        console.error('Database shutdown failed:', error.code || error.name);
        process.exitCode = 1;
      }
    });
  });
}
