const repo = require("../repositories/order-repository");
async function state(id) {
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
  if (!r.ok) throw Error("Payment state unavailable");
  return (await r.json()).data;
}
async function release(id, paymentId, lockId) {
  const p = await state(paymentId);
  if (
    p.orderId !== id ||
    p.needsReview ||
    !["FAILED", "CANCELLED"].includes(p.state)
  )
    return false;
  return repo.withTransaction(async (c) => {
    const o = await repo.findScoped(
      id,
      { role: "CHU_CHUOI" },
      { lock: true, connection: c },
    );
    if (
      o.payment_status !== "UNPAID" ||
      o.payment_lock_id !== lockId ||
      (o.payment_lock_payment_id && o.payment_lock_payment_id !== paymentId)
    )
      return false;
    await c.execute(
      "UPDATE orders SET payment_lock_id=NULL,payment_lock_hash=NULL,payment_lock_payment_id=NULL WHERE id=?",
      [id],
    );
    return true;
  });
}
let working = false;
function start() {
  const timer = setInterval(async () => {
    if (working) return;
    working = true;
    try {
      const [rows] = await repo.pool.query(
        "SELECT id,payment_lock_id,payment_lock_payment_id FROM orders WHERE payment_status='UNPAID' AND payment_lock_payment_id IS NOT NULL LIMIT 50",
      );
      for (const o of rows)
        try {
          await release(o.id, o.payment_lock_payment_id, o.payment_lock_id);
        } catch {}
    } finally {
      working = false;
    }
  }, 5000);
  timer.unref();
  return timer;
}
module.exports = { release, start };
