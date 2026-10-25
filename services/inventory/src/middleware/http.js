'use strict';

const { AppError } = require('../errors');

// Bodies on write methods must be JSON; otherwise express.json() silently ignores them.
function requireJson(req, _res, next) {
  if (!['POST', 'PATCH', 'PUT'].includes(req.method)) return next();
  const hasBody = Number(req.get('content-length') || 0) > 0 || Boolean(req.get('transfer-encoding'));
  if (hasBody && !req.is('application/json')) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Body phải có Content-Type: application/json');
  }
  next();
}

function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
}

module.exports = { requireJson, securityHeaders };
