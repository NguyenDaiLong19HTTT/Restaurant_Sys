'use strict';
const fs = require('node:fs');
const read = (inline, path) => process.env[inline] || (process.env[path] ? fs.readFileSync(process.env[path], 'utf8') : '');
module.exports = {
  port: Number(process.env.PORT || 3001), issuer: process.env.JWT_ISSUER || 'restaurant-identity',
  privateKey: read('JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY_PATH'), publicKey: read('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_PATH'),
  accessTtl: process.env.ACCESS_TOKEN_TTL || '15m', refreshDays: Number(process.env.REFRESH_TOKEN_DAYS || 14),
  internalToken: process.env.INTERNAL_SERVICE_TOKEN || '', bootstrapUsername: process.env.BOOTSTRAP_USERNAME || '', bootstrapPassword: process.env.BOOTSTRAP_PASSWORD || '',
  db: { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME || 'identity_db', user: process.env.DB_USER || 'identity_user', password: process.env.DB_PASSWORD || '' }
};
