const express = require("express"),
  { requireInternal } = require("../middleware/auth"),
  repo = require("../repositories/order-repository"),
  HttpError = require("../domain/http-error");
const router = express.Router();
router.use(requireInternal);
const conflict = () =>
  new HttpError(409, "ORDER_SNAPSHOT_CHANGED", "Order context changed");
async function context(id, c = repo.pool) {
  const o = await repo.getDetail(id, c);
  if (!o) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
  return o;
}
async function hash(o) {
  return (await import("../../../../packages/order-snapshot.mjs")).orderSnapshotHash(o);
}
async function payment(id) {
  const r = await fetch(
    process.env.PAYMENT_BASE_URL +
      "/internal/v1/payments/" +
      encodeURIComponent(id) +
      "/status",
    {
      headers: { "X-Service-Token": process.env.INTERNAL_SERVICE_TOKEN },
      signal: AbortSignal.timeout(2500),
    },
  );
  if (!r.ok)
    throw new HttpError(
      503,
      "PAYMENT_UNAVAILABLE",
      "Cannot verify previous payment",
    );
  return (await r.json()).data;
}
router.get("/payment-orders", async (req, res) => {
  if (!req.query.branchId || !req.query.tableId)
    throw new HttpError(422, "TABLE_REQUIRED", "branchId/tableId required");
  const [rows] = await repo.pool.execute(
    "SELECT id FROM orders WHERE branch_id=? AND table_id=? AND payment_status='UNPAID' AND status IN ('SUBMITTED','HANDED_OVER') ORDER BY created_at,id",
    [req.query.branchId, req.query.tableId],
  );
  res.json({ data: await Promise.all(rows.map((o) => context(o.id))) });
});
router.get("/table-orders", async (req, res) => {
  const [rows] = await repo.pool.execute(
    "SELECT id,status,payment_status FROM orders WHERE table_id=? AND payment_status='UNPAID' AND status<>'CANCELLED'",
    [req.query.tableId],
  );
  res.json({ data: rows });
});
router.get("/orders/:id/payment-context", async (req, res) =>
  res.json({ data: await context(req.params.id) }),
);
router.post("/orders/:id/payment-lock", async (req, res) => {
  const result = await repo.withTransaction(async (c) => {
    const o = await repo.findScoped(
      req.params.id,
      { role: "CHU_CHUOI" },
      { lock: true, connection: c },
    );
    const current = await context(o.id, c);
    if (
      current.tableId !== req.body.tableId ||
      current.paymentStatus !== "UNPAID" ||
      !["SUBMITTED", "HANDED_OVER"].includes(current.status) ||
      (await hash(current)) !== req.body.expectedSnapshotHash
    )
      throw conflict();
    const lock = req.body.lockId;
    if (!/^[a-f0-9-]{36}$/.test(req.body.paymentId || ""))
      throw new HttpError(
        422,
        "PAYMENT_ID_REQUIRED",
        "Payment attempt required",
      );
    if (
      typeof lock !== "string" ||
      lock.length > 128 ||
      req.get("Idempotency-Key") !== lock
    )
      throw new HttpError(422, "LOCK_REQUIRED", "Invalid lock");
    if (
      o.payment_lock_id &&
      (o.payment_lock_id !== lock ||
        (o.payment_lock_payment_id &&
          o.payment_lock_payment_id !== req.body.paymentId))
    ) {
      if (!req.body.replacesPaymentId) throw conflict();
      const prior = await payment(req.body.replacesPaymentId);
      if (
        prior.orderId !== o.id ||
        prior.needsReview ||
        (o.payment_lock_payment_id &&
          o.payment_lock_payment_id !== req.body.replacesPaymentId) ||
        !["FAILED", "CANCELLED"].includes(prior.state)
      )
        throw conflict();
    }
    await c.execute(
      "UPDATE orders SET payment_lock_id=?,payment_lock_hash=?,payment_lock_payment_id=? WHERE id=?",
      [lock, req.body.expectedSnapshotHash, req.body.paymentId, o.id],
    );
    return current;
  });
  res.json({ data: result });
});
router.post("/orders/:id/mark-paid", async (req, res) => {
  const {
    paymentId,
    branchId,
    tableId,
    totalVnd,
    discountVnd,
    expectedSnapshot,
    lockId,
  } = req.body;
  const p = await payment(paymentId);
  if (
    p.needsReview ||
    p.orderId !== req.params.id ||
    p.branchId !== branchId ||
    !["FINALIZING", "COMPLETED"].includes(p.state) ||
    p.totalVnd !== totalVnd
  )
    throw conflict();
  const ack = await repo.withTransaction(async (c) => {
    const o = await repo.findScoped(
      req.params.id,
      { role: "CHU_CHUOI" },
      { lock: true, connection: c },
    );
    if (o.paid_payment_id) {
      if (o.paid_payment_id !== paymentId) throw conflict();
      const a =
        typeof o.payment_ack === "string"
          ? JSON.parse(o.payment_ack)
          : o.payment_ack;
      if (
        a.branchId !== branchId ||
        a.tableId !== tableId ||
        a.totalVnd !== totalVnd
      )
        throw conflict();
      return a;
    }
    const current = await context(o.id, c);
    if (
      (o.payment_lock_payment_id && o.payment_lock_payment_id !== paymentId) ||
      o.payment_lock_id !== lockId ||
      o.payment_status !== "UNPAID" ||
      o.branch_id !== branchId ||
      o.table_id !== tableId ||
      current.version !== req.body.orderVersion ||
      (await hash(current)) !== (await hash(expectedSnapshot)) ||
      (await hash(current)) !== o.payment_lock_hash ||
      !Number.isSafeInteger(totalVnd) ||
      !Number.isSafeInteger(discountVnd) ||
      discountVnd < 0 ||
      totalVnd <= 0 ||
      totalVnd + discountVnd !== current.totalVnd
    )
      throw conflict();
    const result = {
      orderId: o.id,
      paymentId,
      branchId,
      tableId,
      totalVnd,
      paymentStatus: "PAID",
    };
    await c.execute(
      "UPDATE orders SET payment_status='PAID',paid_payment_id=?,payment_ack=? WHERE id=?",
      [paymentId, JSON.stringify(result), o.id],
    );
    return result;
  });
  res.json({ data: ack });
});
router.post("/orders/:id/payment-unlock", async (req, res) => {
  const released = await require("../services/payment-lock").release(
    req.params.id,
    req.body.paymentId,
    req.body.lockId,
  );
  res.json({ data: { released } });
});
module.exports = router;
