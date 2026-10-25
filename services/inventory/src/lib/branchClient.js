'use strict';

const config = require('../config');
const logger = require('../logger');
const { notFound, unprocessable, unavailable } = require('../errors');

const CACHE_TTL_MS = 15_000;
const cache = new Map();

// GET /internal/v1/branches/{id} on branch-service -> { id, status, acceptsReservations } | null
async function fetchBranch(branchId, requestId) {
  const url = `${config.branchBaseUrl}/internal/v1/branches/${encodeURIComponent(branchId)}`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'X-Request-Id': requestId,
          'X-Service-Token': config.internalServiceToken,
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`branch-service HTTP ${res.status}`);
      const body = await res.json();
      return body.data;
    } catch (err) {
      lastError = err;
    }
  }
  logger.warn('branch-service unavailable', { requestId, err: lastError.message });
  throw unavailable('BRANCH_SERVICE_UNAVAILABLE', 'Không kiểm tra được thông tin chi nhánh, vui lòng thử lại sau');
}

async function getBranch(branchId, requestId) {
  const hit = cache.get(branchId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fetchBranch(branchId, requestId);
  cache.set(branchId, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

async function assertActiveBranch(branchId, requestId) {
  const branch = await getBranch(branchId, requestId);
  if (!branch) throw notFound('BRANCH_NOT_FOUND', 'Chi nhánh không tồn tại', { branchId });
  if (branch.status !== 'ACTIVE') {
    throw unprocessable('BRANCH_INACTIVE', 'Chi nhánh đang ngừng hoạt động', { branchId });
  }
  return branch;
}

module.exports = { getBranch, assertActiveBranch };
