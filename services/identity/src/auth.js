"use strict";
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const jwt = require("jsonwebtoken");
const config = require("./config");
const roles = [
  "CHU_CHUOI",
  "QUAN_LY_CHI_NHANH",
  "NHAN_VIEN_TIEP_NHAN",
  "NHAN_VIEN_PHUC_VU",
];
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, salt, expected] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const actual = await scrypt(
      password,
      Buffer.from(salt, "base64"),
      Buffer.from(expected, "base64").length,
      { N: Number(n), r: Number(r), p: Number(p) },
    );
    return (
      actual.length === Buffer.from(expected, "base64").length &&
      crypto.timingSafeEqual(actual, Buffer.from(expected, "base64"))
    );
  } catch {
    return false;
  }
}
function accessToken(account) {
  const claims = {
    accountId: account.id,
    role: account.role,
    tokenVersion: Number(account.token_version),
    tokenUse: "access",
  };
  if (account.branch_id) claims.branchId = account.branch_id;
  if (account.employee_id) claims.employeeId = account.employee_id;
  return jwt.sign(claims, config.privateKey, {
    algorithm: "RS256",
    expiresIn: config.accessTtl,
    issuer: config.issuer,
    audience: process.env.JWT_AUDIENCE,
    subject: account.id,
  });
}
function refreshToken() {
  return crypto.randomBytes(48).toString("base64url");
}
function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
module.exports = {
  roles,
  hashPassword,
  verifyPassword,
  accessToken,
  refreshToken,
  digest,
};
