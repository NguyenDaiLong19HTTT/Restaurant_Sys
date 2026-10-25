import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const stack = JSON.parse(fs.readFileSync(".local/stack.json")),
  base = "http://127.0.0.1:" + stack.apiPort + "/api/v1",
  password = fs.readFileSync(".local/login-password", "utf8").trim(),
  facts = JSON.parse(fs.readFileSync("docs/integration/acceptance-facts.json")),
  T = "70000000-0000-4000-8000-000000000103",
  A = "11111111-1111-4111-8111-111111111111";
fs.writeFileSync('.local/fault-override.yaml', JSON.stringify({services:{'payment-service':{environment:{TABLE_BASE_URL:'http://table-fault-proxy:3000'}}}},null,2));
const compose = (args, fault = false) =>
  execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      stack.project,
      "--env-file",
      ".local/compose.env",
      "--file",
      "compose.yaml",
      ...(fault ? ["--file", ".local/fault-override.yaml"] : []),
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
let reception, server;
async function req(path, token, body, method = body ? "POST" : "GET", version) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      "Idempotency-Key": randomUUID(),
      ...(version ? { "If-Match": '"' + version + '"' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
async function api(...args) {
  const r = await req(...args);
  assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body?.error));
  return r.body?.data;
}
async function ready() {
  for (let n = 0; n < 35; n++) {
    try {
      if ((await req("/payments/config", reception)).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Payment did not become ready");
}
test("real order acknowledged, table transport fails: FINALIZING survives recreation, no premature invoice, retry once", async () => {
  reception = (
    await api("/auth/login", null, { username: "reception", password })
  ).accessToken;
  server = (await api("/auth/login", null, { username: "server", password }))
    .accessToken;
  compose([
    "--profile",
    "test",
    "up",
    "--build",
    "--no-deps",
    "-d",
    "table-fault-proxy",
  ]);
  try {
    compose(["up", "--no-deps", "-d", "--wait", "payment-service"], true);
    await ready();
    const armed = JSON.parse(
      compose([
        "exec",
        "-T",
        "order-service",
        "node",
        "tests/internal-call.mjs",
        "http://table-fault-proxy:3000",
        "/test/arm",
        "POST",
        "{}",
      ]),
    );
    assert.equal(armed.status, 200);
    let o = await api("/orders", server, {
      serviceType: "DINE_IN",
      branchId: A,
      tableId: T,
      items: [{ dishId: facts.dish.id, quantity: 2 }],
    });
    o = await api("/orders/" + o.id + "/submit", server, {}, "POST", o.version);
    const q = await api("/payments/quote", reception, {
      orderId: o.id,
      tableId: T,
      voucherCode: "GIAM10",
    });
    const p = await api("/payments", reception, {
      orderId: o.id,
      tableId: T,
      method: "CASH",
      expectedSnapshotHash: q.snapshotHash,
      voucherCode: "GIAM10",
    });
    const pending = await api("/payments/" + p.id + "/confirm", reception, {
      cashReceived: true,
    });
    assert.equal(pending.state, "FINALIZING");
    assert.equal((await api("/orders/" + o.id, server)).paymentStatus, "PAID");
    assert.equal(
      (await req("/payments/" + p.id + "/invoice", reception)).status,
      404,
    );
    const sql =
      "SELECT (SELECT COUNT(*) FROM invoices WHERE payment_id=?) invoiceCount,(SELECT COUNT(*) FROM revenue_entries WHERE payment_id=?) revenueCount,(SELECT COUNT(*) FROM voucher_uses WHERE payment_id=?) uses";
    const before = JSON.parse(
      compose([
        "exec",
        "-T",
        "payment-service",
        "node",
        "tests/own-db.mjs",
        sql,
        JSON.stringify([p.id, p.id, p.id]),
      ]),
    )[0];
    assert.deepEqual(before, { invoiceCount: 0, revenueCount: 0, uses: 0 });
    compose(
      [
        "up",
        "--no-deps",
        "--force-recreate",
        "-d",
        "--wait",
        "payment-service",
      ],
      true,
    );
    await ready();
    const done = await api("/payments/" + p.id + "/confirm", reception, {
      cashReceived: true,
    });
    assert.equal(done.state, "COMPLETED");
    const repeated = await api("/payments/" + p.id + "/confirm", reception, {
      cashReceived: true,
    });
    assert.equal(done.invoice.code, repeated.invoice.code);
    const after = JSON.parse(
      compose([
        "exec",
        "-T",
        "payment-service",
        "node",
        "tests/own-db.mjs",
        sql,
        JSON.stringify([p.id, p.id, p.id]),
      ]),
    )[0];
    assert.deepEqual(after, { invoiceCount: 1, revenueCount: 1, uses: 1 });
    fs.writeFileSync(
      "docs/integration/outage-result.json",
      JSON.stringify(
        {
          passed: true,
          checkedAt: new Date().toISOString(),
          paymentId: p.id,
          state: done.state,
          before,
          after,
          description:
            "HTTP fault proxy rejects first table acknowledgement only; order/table domain data and marks are served by actual owners. Payment recreated with durable outbox, then replayed safely.",
        },
        null,
        2,
      ),
    );
  } finally {
    compose(["up", "--no-deps", "-d", "--wait", "payment-service"]);
    compose(["--profile", "test", "stop", "table-fault-proxy"]);
  }
});
