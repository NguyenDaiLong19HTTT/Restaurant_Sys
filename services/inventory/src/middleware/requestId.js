'use strict';

const crypto = require('node:crypto');
const logger = require('../logger');

module.exports = function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);

  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/health')) return;
    logger.info('request', {
      requestId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
      accountId: req.user?.accountId,
    });
  });
  next();
};
