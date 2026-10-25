'use strict';

const config = require('./config');
const logger = require('./logger');
const app = require('./app');
const { pool } = require('./db');
const { runMigrations } = require('./migrate');
const notifications = require('./services/notifications');
const reservations = require('./services/reservations');

const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'ER_ACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR',
]);

async function migrateWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await runMigrations();
      return;
    } catch (err) {
      if (!CONNECTION_ERRORS.has(err.code) || attempt >= 30) throw err;
      logger.warn('database not ready, retrying', { attempt, code: err.code });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// Outbox delivery + retry of cancellations waiting on order-service. A run finishes before the next starts.
function startWorker() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await notifications.dispatchPending();
      await reservations.reconcileCancellations();
    } catch (err) {
      logger.warn('background worker error', { err: err.message });
    } finally {
      running = false;
    }
  }, config.workerIntervalMs);
  timer.unref();
  return timer;
}

async function start() {
  if (!config.jwtPublicKey && !config.jwtSecret) {
    throw new Error('JWT_PUBLIC_KEY or JWT_SECRET must be configured');
  }
  await migrateWithRetry();

  const server = app.listen(config.port, () => logger.info('reservation-service listening', { port: config.port }));
  const worker = startWorker();

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    clearInterval(worker);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  logger.error('startup failed', { err: err.message, code: err.code });
  process.exit(1);
});
