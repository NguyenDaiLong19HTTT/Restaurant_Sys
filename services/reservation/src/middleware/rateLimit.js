'use strict';

const { AppError } = require('../errors');

/**
 * Fixed-window limiter per client IP for the public booking form (00-QUY-UOC-CHUNG: the public
 * endpoint must be rate limited). In-memory is enough for one replica; several replicas would need
 * a shared store or a limit at the gateway.
 */
function rateLimit({ max, windowMs }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || 'unknown';
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      throw new AppError(429, 'TOO_MANY_REQUESTS', 'Bạn gửi quá nhiều yêu cầu đặt bàn, vui lòng thử lại sau ít phút', {
        retryAfterSeconds: retryAfter,
      });
    }
    next();
  };
}

module.exports = { rateLimit };
