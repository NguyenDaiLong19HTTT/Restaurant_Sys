'use strict';

const app = require('./app');
const pool = require('./db/pool');
const { port } = require('./config');

require('./services/payment-lock').start();
const server = app.listen(port, () => console.log(`order-service listening on ${port}`));

async function shutdown(signal) {
  console.log(`order-service received ${signal}; shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
