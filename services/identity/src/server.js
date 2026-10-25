"use strict";
const crypto = require("node:crypto");
const express = require("express");
const helmet = require("helmet");
const pool = require("./db");
const config = require("./config");
const {
  roles,
  hashPassword,
  verifyPassword,
  accessToken,
  refreshToken,
  digest,
} = require("./auth");

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  req.requestId = req.get("X-Request-Id") || crypto.randomUUID();
  res.set("X-Request-Id", req.requestId);
  next();
});
const fail = (res, status, code, message) =>
  res
    .status(status)
    .json({ error: { code, message }, requestId: res.get("X-Request-Id") });
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const accountView = (a) => ({
  id: a.id,
  employeeId: a.employee_id || null,
  role: a.role,
  branchId: a.branch_id || null,
  status: a.status,
  tokenVersion: Number(a.token_version),
  username: a.username,
  mustChangePassword: Boolean(a.must_change_password),
});
const bearer = (req) =>
  (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
function authenticate(req, res, next) {
  try {
    if (!config.publicKey)
      return fail(
        res,
        503,
        "AUTH_NOT_CONFIGURED",
        "Identity public key is not configured",
      );
    req.claims = require("jsonwebtoken").verify(bearer(req), config.publicKey, {
      algorithms: ["RS256"],
      issuer: config.issuer,
      audience: process.env.JWT_AUDIENCE,
    });
    if (
      req.claims.tokenUse !== "access" ||
      req.claims.sub !== req.claims.accountId ||
      !Number.isInteger(req.claims.tokenVersion) ||
      !req.claims.exp ||
      !req.claims.accountId
    )
      throw new Error("missing account");
    next();
  } catch {
    return fail(
      res,
      401,
      "UNAUTHENTICATED",
      "Access token is invalid or expired",
    );
  }
}
function internal(req, res, next) {
  const supplied = req.get("X-Service-Token") || "";
  if (
    !config.internalToken ||
    supplied.length !== config.internalToken.length ||
    !crypto.timingSafeEqual(
      Buffer.from(supplied),
      Buffer.from(config.internalToken),
    )
  )
    return fail(
      res,
      401,
      "INVALID_SERVICE_CREDENTIAL",
      "Valid internal service credentials are required",
    );
  next();
}
app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
app.get(
  "/health/ready",
  asyncRoute(async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  }),
);

app.post(
  "/api/v1/auth/login",
  require("express-rate-limit").rateLimit({ windowMs: 60000, limit: 30 }),
  asyncRoute(async (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!username || !password)
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Username and password are required",
      );
    try {
      const [rows] = await pool.execute(
        "SELECT * FROM accounts WHERE username=? LIMIT 1",
        [username],
      );
      const account = rows[0];
      if (
        !account ||
        account.status !== "ACTIVE" ||
        !(await verifyPassword(password, account.password_hash))
      )
        return fail(
          res,
          401,
          "INVALID_CREDENTIALS",
          "Tên đăng nhập hoặc mật khẩu không đúng",
        );
      const refresh = refreshToken();
      const id = crypto.randomUUID();
      const expires = new Date(Date.now() + config.refreshDays * 86400000);
      await pool.execute(
        "INSERT INTO refresh_tokens(id,account_id,token_hash,expires_at) VALUES(?,?,?,?)",
        [id, account.id, digest(refresh), expires],
      );
      res.json({
        data: {
          accessToken: accessToken(account),
          refreshToken: refresh,
          account: accountView(account),
        },
      });
    } catch {
      fail(res, 500, "LOGIN_FAILED", "Đăng nhập thất bại");
    }
  }),
);

app.post(
  "/api/v1/auth/refresh",
  asyncRoute(async (req, res) => {
    const token = String(req.body?.refreshToken || "");
    if (!token)
      return fail(res, 400, "VALIDATION_ERROR", "refreshToken is required");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT rt.id AS refresh_id,rt.account_id,rt.expires_at,rt.revoked_at,a.* FROM refresh_tokens rt JOIN accounts a ON a.id=rt.account_id WHERE rt.token_hash=? FOR UPDATE",
        [digest(token)],
      );
      const row = rows[0];
      if (
        !row ||
        row.revoked_at ||
        new Date(row.expires_at) <= new Date() ||
        row.status !== "ACTIVE"
      ) {
        await connection.rollback();
        return fail(
          res,
          401,
          "INVALID_REFRESH_TOKEN",
          "Refresh token is invalid or expired",
        );
      }
      const nextToken = refreshToken();
      const nextId = crypto.randomUUID();
      const expires = new Date(Date.now() + config.refreshDays * 86400000);
      await connection.execute(
        "UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?",
        [row.refresh_id],
      );
      await connection.execute(
        "INSERT INTO refresh_tokens(id,account_id,token_hash,expires_at) VALUES(?,?,?,?)",
        [nextId, row.account_id, digest(nextToken), expires],
      );
      await connection.commit();
      res.json({
        data: {
          accessToken: accessToken(row),
          refreshToken: nextToken,
          account: accountView(row),
        },
      });
    } catch {
      await connection.rollback();
      fail(res, 500, "REFRESH_FAILED", "Không thể làm mới phiên đăng nhập");
    } finally {
      connection.release();
    }
  }),
);

app.post(
  "/api/v1/auth/logout",
  asyncRoute(async (req, res) => {
    const token = String(req.body?.refreshToken || "");
    if (token)
      await pool.execute(
        "UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE token_hash=? AND revoked_at IS NULL",
        [digest(token)],
      );
    res.status(204).end();
  }),
);
app.get(
  "/api/v1/auth/me",
  authenticate,
  asyncRoute(async (req, res) => {
    const [rows] = await pool.execute("SELECT * FROM accounts WHERE id=?", [
      req.claims.accountId,
    ]);
    const account = rows[0];
    if (
      !account ||
      account.status !== "ACTIVE" ||
      Number(account.token_version) !== Number(req.claims.tokenVersion)
    )
      return fail(
        res,
        401,
        "ACCOUNT_DISABLED",
        "Tài khoản đã bị khóa hoặc phiên đã bị thu hồi",
      );
    res.json({ data: accountView(account) });
  }),
);
app.post(
  "/api/v1/auth/change-password",
  authenticate,
  asyncRoute(async (req, res) => {
    const current = String(req.body?.currentPassword || "");
    const next = String(req.body?.newPassword || "");
    if (next.length < 10 || next.length > 128)
      return fail(
        res,
        400,
        "WEAK_PASSWORD",
        "Mật khẩu mới cần có từ 10 đến 128 ký tự",
      );
    const [rows] = await pool.execute("SELECT * FROM accounts WHERE id=?", [
      req.claims.accountId,
    ]);
    const account = rows[0];
    if (
      !account ||
      account.status !== "ACTIVE" ||
      Number(account.token_version) !== Number(req.claims.tokenVersion)
    )
      return fail(res, 401, "ACCOUNT_DISABLED", "Tài khoản đã bị khóa");
    if (!(await verifyPassword(current, account.password_hash)))
      return fail(res, 401, "INVALID_PASSWORD", "Mật khẩu hiện tại không đúng");
    await pool.execute(
      "UPDATE accounts SET password_hash=?,must_change_password=FALSE,token_version=token_version+1 WHERE id=?",
      [await hashPassword(next), account.id],
    );
    await pool.execute(
      "UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE account_id=? AND revoked_at IS NULL",
      [account.id],
    );
    res.json({ data: { changed: true } });
  }),
);

app.post(
  "/internal/v1/accounts",
  internal,
  asyncRoute(async (req, res) => {
    const { employeeId, role, branchId, username } = req.body || {};
    if (
      !employeeId ||
      !roles.includes(role) ||
      role === "CHU_CHUOI" ||
      !branchId ||
      !/^[a-zA-Z0-9._-]{3,80}$/.test(username || "")
    )
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "employeeId, staff role, branchId and valid username are required",
      );
    const provisioningKey = req.get("Idempotency-Key") || "";
    if (!provisioningKey || provisioningKey.length > 128)
      return fail(
        res,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required",
      );
    const [prior] = await pool.execute(
      "SELECT * FROM accounts WHERE provisioning_key=? LIMIT 1",
      [provisioningKey],
    );
    if (prior.length) {
      const a = prior[0];
      if (
        a.employee_id !== employeeId ||
        a.role !== role ||
        a.branch_id !== branchId ||
        a.username !== username
      )
        return fail(
          res,
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with different account details",
        );
      const temporaryPassword = crypto
        .createHmac("sha256", config.internalToken)
        .update(`account:${provisioningKey}`)
        .digest("base64url")
        .slice(0, 32);
      return res
        .status(201)
        .json({ data: { account: accountView(a), temporaryPassword } });
    }
    const [exists] = await pool.execute(
      "SELECT id FROM accounts WHERE employee_id=? OR username=? LIMIT 1",
      [employeeId, username],
    );
    if (exists.length)
      return fail(
        res,
        409,
        "ACCOUNT_EXISTS",
        "Tài khoản hoặc nhân viên đã được liên kết",
      );
    const id = crypto.randomUUID();
    const temporaryPassword = crypto
      .createHmac("sha256", config.internalToken)
      .update(`account:${provisioningKey}`)
      .digest("base64url")
      .slice(0, 32);
    await pool.execute(
      "INSERT INTO accounts(id,username,password_hash,employee_id,provisioning_key,role,branch_id,status,must_change_password) VALUES(?,?,?,?,?,?,?,'PENDING',TRUE)",
      [
        id,
        username,
        await hashPassword(temporaryPassword),
        employeeId,
        provisioningKey,
        role,
        branchId,
      ],
    );
    res
      .status(201)
      .json({
        data: {
          account: { id, employeeId, role, branchId, status: "PENDING" },
          temporaryPassword,
        },
      });
  }),
);
app.post(
  "/internal/v1/accounts/:id/:action",
  internal,
  asyncRoute(async (req, res) => {
    const { id, action } = req.params;
    if (!["activate", "disable"].includes(action))
      return fail(res, 404, "NOT_FOUND", "Action not found");
    const active = action === "activate";
    const [result] = await pool.execute(
      "UPDATE accounts SET status=?,token_version=token_version+1 WHERE id=?",
      [active ? "ACTIVE" : "DISABLED", id],
    );
    if (!result.affectedRows)
      return fail(res, 404, "ACCOUNT_NOT_FOUND", "Không tìm thấy tài khoản");
    if (!active)
      await pool.execute(
        "UPDATE refresh_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE account_id=? AND revoked_at IS NULL",
        [id],
      );
    res.json({ data: { id, status: active ? "ACTIVE" : "DISABLED" } });
  }),
);
app.patch(
  "/internal/v1/accounts/:id/assignment",
  internal,
  asyncRoute(async (req, res) => {
    const { role, branchId } = req.body || {};
    if (!roles.includes(role) || role === "CHU_CHUOI" || !branchId)
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Staff role and branchId are required",
      );
    const [result] = await pool.execute(
      "UPDATE accounts SET role=?,branch_id=?,token_version=token_version+1 WHERE id=? AND employee_id IS NOT NULL",
      [role, branchId, req.params.id],
    );
    if (!result.affectedRows)
      return fail(
        res,
        404,
        "ACCOUNT_NOT_FOUND",
        "Không tìm thấy tài khoản nhân viên",
      );
    res.json({ data: { id: req.params.id, role, branchId } });
  }),
);
app.get(
  "/internal/v1/staff-accounts/:id",
  internal,
  asyncRoute(async (req, res) => {
    const [[a]] = await pool.execute(
      "SELECT * FROM accounts WHERE employee_id=?",
      [req.params.id],
    );
    if (!a) return fail(res, 404, "NOT_FOUND", "Account not found");
    res.json({ ...accountView(a), id: a.employee_id });
  }),
);
app.post(
  "/internal/v1/staff-accounts",
  internal,
  asyncRoute(async (req, res) => {
    const { id, email, password, branchId, role } = req.body || {};
    if (
      !id ||
      !branchId ||
      !["NHAN_VIEN_PHUC_VU", "NHAN_VIEN_TIEP_NHAN"].includes(role) ||
      typeof password !== "string" ||
      password.length < 12
    )
      return fail(res, 422, "INVALID_ACCOUNT", "Invalid staff account");
    const [[old]] = await pool.execute(
      "SELECT * FROM accounts WHERE employee_id=?",
      [id],
    );
    if (old) {
      if (
        old.username !== email ||
        old.role !== role ||
        old.branch_id !== branchId
      )
        return fail(res, 409, "ACCOUNT_CONFLICT", "Account differs");
      return res.json({ id, status: old.status });
    }
    await pool.execute(
      "INSERT INTO accounts(id,employee_id,username,password_hash,role,branch_id,status,must_change_password) VALUES(?,?,?,?,?,?,?,TRUE)",
      [id, id, email, await hashPassword(password), role, branchId, "ACTIVE"],
    );
    res.status(201).json({ id, status: "ACTIVE" });
  }),
);
app.patch(
  "/internal/v1/staff-accounts/:id",
  internal,
  asyncRoute(async (req, res) => {
    const [[a]] = await pool.execute(
      "SELECT * FROM accounts WHERE employee_id=?",
      [req.params.id],
    );
    if (!a) return fail(res, 404, "NOT_FOUND", "Account not found");
    const status = req.body.status === "INACTIVE" ? "DISABLED" : a.status;
    await pool.execute(
      "UPDATE accounts SET username=?,status=?,role=?,token_version=token_version+1 WHERE id=?",
      [
        req.body.email || a.username,
        status,
        ["NHAN_VIEN_PHUC_VU", "NHAN_VIEN_TIEP_NHAN"].includes(req.body.role)
          ? req.body.role
          : a.role,
        a.id,
      ],
    );
    res.json({ id: a.id, status });
  }),
);
app.delete(
  "/internal/v1/staff-accounts/:id",
  internal,
  asyncRoute(async (req, res) => {
    await pool.execute(
      "UPDATE accounts SET status='DISABLED',token_version=token_version+1 WHERE employee_id=?",
      [req.params.id],
    );
    res.status(204).end();
  }),
);
app.use((err, _req, res, _next) => {
  console.error("identity request failed");
  fail(res, 500, "INTERNAL_ERROR", "Lỗi hệ thống");
});

async function bootstrapOwner() {
  if (!config.bootstrapUsername || !config.bootstrapPassword) return;
  if (config.bootstrapPassword.length < 12)
    throw new Error("BOOTSTRAP_PASSWORD must contain at least 12 characters");
  const [found] = await pool.execute(
    "SELECT id FROM accounts WHERE role='CHU_CHUOI' LIMIT 1",
  );
  if (found.length) return;
  await pool.execute(
    "INSERT INTO accounts(id,username,password_hash,role,status,must_change_password) VALUES(?,?,?,'CHU_CHUOI','ACTIVE',TRUE)",
    [
      crypto.randomUUID(),
      config.bootstrapUsername,
      await hashPassword(config.bootstrapPassword),
    ],
  );
}
async function bootstrapLocalAccounts() {
  if (process.env.APP_ENV !== "development") return;
  const branchId = process.env.LOCAL_BRANCH_ID || "";
  const definitions = [
    {
      username: process.env.LOCAL_MANAGER_USERNAME,
      password: process.env.LOCAL_MANAGER_PASSWORD,
      role: "QUAN_LY_CHI_NHANH",
      employeeId: "22222222-2222-4222-8222-222222222221",
    },
    {
      username: process.env.LOCAL_STAFF_USERNAME,
      password: process.env.LOCAL_STAFF_PASSWORD,
      role: "NHAN_VIEN_PHUC_VU",
      employeeId: "22222222-2222-4222-8222-222222222222",
    },
  ];
  for (const item of definitions) {
    if (!item.username || !item.password)
      throw new Error(
        "Local development accounts require usernames and passwords",
      );
    if (item.password.length < 12)
      throw new Error(
        "Local development account passwords must contain at least 12 characters",
      );
    const [existing] = await pool.execute(
      "SELECT id,role,branch_id FROM accounts WHERE username=?",
      [item.username],
    );
    if (existing.length) {
      if (existing[0].role !== item.role || existing[0].branch_id !== branchId)
        throw new Error(
          `Existing local account ${item.username} has a different role or branch assignment`,
        );
      continue;
    }
    await pool.execute(
      "INSERT INTO accounts(id,username,password_hash,employee_id,role,branch_id,status,must_change_password) VALUES(?,?,?,?,?,? ,'ACTIVE',FALSE)",
      [
        crypto.randomUUID(),
        item.username,
        await hashPassword(item.password),
        item.employeeId,
        item.role,
        branchId,
      ],
    );
  }
}
async function start() {
  if (!config.privateKey || !config.publicKey)
    throw new Error("JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required (RS256)");
  await pool.query("SELECT 1");
  await bootstrapOwner();
  await bootstrapLocalAccounts();
  const server = app.listen(config.port, () =>
    console.log(`identity-service listening on ${config.port}`),
  );
  const stop = () =>
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
if (require.main === module)
  start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
module.exports = app;
