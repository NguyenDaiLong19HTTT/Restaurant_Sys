'use strict';

const HttpError = require('../domain/http-error');

module.exports = function errorHandler(err, req, res, _next) {
  const known = err instanceof HttpError;
  const status = known ? err.status : (err.status === 400 ? 400 : 500);
  if (!known) console.error(JSON.stringify({ level: 'error', requestId: req.requestId, message: err.message }));
  res.status(status).json({
    error: {
      code: known ? err.code : 'INTERNAL_ERROR',
      message: known ? err.message : 'An unexpected error occurred',
      details: known ? err.details : {}
    },
    requestId: req.requestId
  });
};
