const authenticate=require('../../../../packages/auth-bridge.cjs').authenticate;
'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized, forbidden } = require('../errors');
const { ROLES, PERMISSIONS, can, canAccessBranch } = require('../policy');

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

const isOwner = (user) => user.role === ROLES.OWNER;

function assertBranchScope(user, branchId) {
  if (canAccessBranch(user, branchId)) return;
  throw forbidden('BRANCH_SCOPE_FORBIDDEN', 'Bạn chỉ được thao tác dữ liệu của chi nhánh mình', { branchId });
}

function assertManagerOf(user, branchId) {
  if (user.role === ROLES.MANAGER && user.branchId === branchId) return;
  throw forbidden('BRANCH_SCOPE_FORBIDDEN', 'Chỉ quản lý của chi nhánh liên quan được thực hiện thao tác này', {
    branchId,
  });
}

module.exports = { ROLES, authenticate, requirePermission, isOwner, assertBranchScope, assertManagerOf };

module.exports.authenticate=require('../../../../packages/auth-bridge.cjs').authenticate;
