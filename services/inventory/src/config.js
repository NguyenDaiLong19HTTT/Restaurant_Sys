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
  port: Number(readEnv('PORT', 3007)),
  databaseUrl: readEnv('DATABASE_URL'),
  db: {
    host: readEnv('DB_HOST', 'localhost'),
    port: Number(readEnv('DB_PORT', 3306)),
    user: readEnv('DB_USER', 'inventory_user'),
    password: readEnv('DB_PASSWORD', ''),
    database: readEnv('DB_NAME', 'inventory_db'),
  },
  // Production: identity's public key (RS256). Dev/mock: shared HS256 secret.
  jwtPublicKey: publicKey ? publicKey.replace(/\\n/g, '\n') : undefined,
  jwtSecret: readEnv('JWT_SECRET'),
  // Optional: when set, tokens must carry matching iss / aud claims.
  jwtIssuer: readEnv('JWT_ISSUER'),
  jwtAudience: readEnv('JWT_AUDIENCE'),
  branchBaseUrl: readEnv('BRANCH_BASE_URL', 'http://localhost:3001'),
  internalServiceToken: readEnv('INTERNAL_SERVICE_TOKEN', ''),
  requestTimeoutMs: Number(readEnv('REQUEST_TIMEOUT_MS', 2500)),
  seedDemoData: readEnv('SEED_DEMO_DATA', 'false') === 'true',
  logLevel: readEnv('LOG_LEVEL', 'info'),
};
