'use strict';

const fs = require('node:fs');

function readPublicKey() {
  if (process.env.JWT_PUBLIC_KEY) return process.env.JWT_PUBLIC_KEY;
  if (process.env.JWT_PUBLIC_KEY_PATH) return fs.readFileSync(process.env.JWT_PUBLIC_KEY_PATH, 'utf8');
  return '';
}

module.exports = {
  port: Number(process.env.PORT || 3006),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 3000),
  jwtPublicKey: readPublicKey(),
  jwtAlgorithms: (process.env.JWT_ALGORITHMS || 'RS256').split(',').map((value) => value.trim()),
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN || '',
  reservationBaseUrl: process.env.RESERVATION_BASE_URL || '',
  menuBaseUrl: process.env.MENU_BASE_URL || '',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'order_db',
    user: process.env.DB_USER || 'order_user',
    password: process.env.DB_PASSWORD || ''
  }
};
