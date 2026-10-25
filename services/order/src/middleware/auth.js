const authenticate =
  require("../../../../packages/auth-bridge.cjs").authenticate;
("use strict");

const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const HttpError = require("../domain/http-error");
const config = require("../config");

const roles = new Set([
  "CHU_CHUOI",
  "QUAN_LY_CHI_NHANH",
  "NHAN_VIEN_TIEP_NHAN",
  "NHAN_VIEN_PHUC_VU",
]);

function requireRole(...allowed) {
  return (req, _res, next) =>
    req.user && allowed.includes(req.user.role)
      ? next()
      : next(
          new HttpError(
            403,
            "FORBIDDEN",
            "You do not have permission for this operation",
          ),
        );
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireInternal(req, _res, next) {
  const supplied = req.get("X-Service-Token") || "";
  if (
    !config.internalServiceToken ||
    !supplied ||
    !timingSafeEqual(supplied, config.internalServiceToken)
  ) {
    return next(
      new HttpError(
        401,
        "INVALID_SERVICE_CREDENTIAL",
        "Valid internal service credentials are required",
      ),
    );
  }
  next();
}

function resolveBranchScope(user, requestedBranchId) {
  if (user.role === "CHU_CHUOI") return requestedBranchId || null;
  if (!user.branchId)
    throw new HttpError(
      403,
      "BRANCH_SCOPE_MISSING",
      "User has no assigned branch",
    );
  if (requestedBranchId && requestedBranchId !== user.branchId) {
    throw new HttpError(
      403,
      "BRANCH_FORBIDDEN",
      "User cannot access another branch",
    );
  }
  return user.branchId;
}

module.exports = {
  authenticate,
  requireRole,
  requireInternal,
  resolveBranchScope,
};

module.exports.authenticate =
  require("../../../../packages/auth-bridge.cjs").authenticate;
