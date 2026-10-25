'use strict';

const fs = require('node:fs');

// Supports Docker secrets: NAME_FILE=/run/secrets/x takes precedence over NAME.
function readEnv(name, fallback) {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const publicKey = readEnv('JWT_PUBLIC_KEY');

module.exports = {
  port: Number(readEnv('PORT', 3004)),
  databaseUrl: readEnv('DATABASE_URL'),
  db: {
    host: readEnv('DB_HOST', 'localhost'),
    port: Number(readEnv('DB_PORT', 3306)),
    user: readEnv('DB_USER', 'reservation_user'),
    password: readEnv('DB_PASSWORD', ''),
    database: readEnv('DB_NAME', 'reservation_db'),
  },
  // Production: identity's public key (RS256). Dev/mock: shared HS256 secret.
  jwtPublicKey: publicKey ? publicKey.replace(/\\n/g, '\n') : undefined,
  jwtSecret: readEnv('JWT_SECRET'),
  jwtIssuer: readEnv('JWT_ISSUER'),
  jwtAudience: readEnv('JWT_AUDIENCE'),
  branchBaseUrl: readEnv('BRANCH_BASE_URL', 'http://localhost:3001'),
  orderBaseUrl: readEnv('ORDER_BASE_URL', 'http://localhost:3001'),
  internalServiceToken: readEnv('INTERNAL_SERVICE_TOKEN', ''),
  requestTimeoutMs: Number(readEnv('REQUEST_TIMEOUT_MS', 2500)),
  seedDemoData: readEnv('SEED_DEMO_DATA', 'false') === 'true',
  logLevel: readEnv('LOG_LEVEL', 'info'),

  // Booking rules. apps/web/src/modules/reservation/rules.js mirrors these defaults.
  booking: {
    durationMinutes: Number(readEnv('BOOKING_DURATION_MINUTES', 120)),
    // Local (Asia/Ho_Chi_Minh, UTC+7) window in which a booking may START.
    firstStart: readEnv('BOOKING_FIRST_START', '09:00'),
    lastStart: readEnv('BOOKING_LAST_START', '21:00'),
    minLeadMinutes: Number(readEnv('BOOKING_MIN_LEAD_MINUTES', 30)),
    maxAdvanceDays: Number(readEnv('BOOKING_MAX_ADVANCE_DAYS', 30)),
    maxPartySize: Number(readEnv('BOOKING_MAX_PARTY_SIZE', 20)),
  },
  // Public POST /reservations: requests per client IP per window.
  publicRateLimit: {
    max: Number(readEnv('PUBLIC_RATE_LIMIT_MAX', 30)),
    windowMs: Number(readEnv('PUBLIC_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000)),
  },
  // "simulator" records messages as SIMULATED; no real SMS provider is wired in v1.
  notificationAdapter: readEnv('NOTIFICATION_ADAPTER', 'simulator'),
  workerIntervalMs: Number(readEnv('WORKER_INTERVAL_MS', 5000)),
};
