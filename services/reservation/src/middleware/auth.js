const authenticate=require('../../../../packages/auth-bridge.cjs').authenticate;
'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized, forbidden } = require('../errors');
const { ROLES, PERMISSIONS, can, inBranch } = require('../policy');

const ALL_ROLES = new Set(Object.values(ROLES));


function requirePermission(permission) {
  if (!PERMISSIONS[permission]) throw new Error(`Unknown permission ${permission}`);
  return (req, _res, next) => {
    if (!can(req.user, permission)) {
      throw forbidden('ROLE_FORBIDDEN', 'Vai trò của bạn không được phép thực hiện thao tác này', {
        permission,
        requiredRoles: PERMISSIONS[permission],
      });
    }
    next();
  };
}

function assertBranchScope(user, branchId) {
  if (inBranch(user, branchId)) return;
  throw forbidden('BRANCH_SCOPE_FORBIDDEN', 'Bạn chỉ được thao tác đơn đặt bàn của chi nhánh mình', { branchId });
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// /internal/v1/** is reachable only on the Docker network and only with the shared service token.
function requireInternalToken(req, _res, next) {
  if (!config.internalServiceToken || !sameSecret(req.get('x-service-token') || '', config.internalServiceToken)) {
    throw unauthorized('Thiếu xác thực service-to-service');
  }
  next();
}

module.exports = { ROLES, authenticate, requirePermission, assertBranchScope, requireInternalToken };

module.exports.authenticate=require('../../../../packages/auth-bridge.cjs').authenticate;
