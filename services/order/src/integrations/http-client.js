'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const HttpError = require('../domain/http-error');

async function requestJson(baseUrl, path, options = {}) {
  if (!baseUrl) throw new HttpError(503, 'DEPENDENCY_NOT_CONFIGURED', 'Required service dependency is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': config.internalServiceToken,
        'X-Request-Id': options.requestId || crypto.randomUUID(),
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = [404, 409, 422].includes(response.status) ? response.status : 502;
      throw new HttpError(status, body?.error?.code || 'DEPENDENCY_ERROR', body?.error?.message || 'A required service rejected the request', body?.error?.details || {});
    }
    return body.data || body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, error.name === 'AbortError' ? 'DEPENDENCY_TIMEOUT' : 'DEPENDENCY_UNAVAILABLE', 'A required service is unavailable; retry with the same Idempotency-Key');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { requestJson };
