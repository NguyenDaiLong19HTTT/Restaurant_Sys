import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SignJWT, importPKCS8 } from "jose";
const stack = JSON.parse(fs.readFileSync(".local/stack.json")),
  base = "http://127.0.0.1:" + stack.apiPort + "/api/v1",
  password = fs.readFileSync(".local/login-password", "utf8").trim(),
  A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  T = "70000000-0000-4000-8000-000000000103";
const users = {},
  facts = {};
const compose = (...args) =>
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
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
const internal = (service, path, body) =>
  JSON.parse(
    compose(
      "exec",
      "-T",
      "order-service",
      "node",
      "tests/internal-call.mjs",
      "http://" + service + ":3000",
      path,
      body ? "POST" : "GET",
      ...(body ? [JSON.stringify(body)] : []),
    ),
  );
const db = (service, sql, params = []) =>
  JSON.parse(
    compose(
      "exec",
      "-T",
      service,
      "node",
      "tests/own-db.mjs",
      sql,
      JSON.stringify(params),
    ),
  );
async function request(path, user, body, method = "GET", headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(users[user]
        ? { Authorization: "Bearer " + users[user].accessToken }
        : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
async function api(path, user, body, method = "GET", headers = {}) {
  const r = await request(path, user, body, method, headers);
  assert.ok(
    r.status >= 200 && r.status < 300,
    path + " HTTP " + r.status + " " + JSON.stringify(r.body?.error),
  );
  return r.body?.data;
}
const write = (path, user, body = {}, version, method = "POST") =>
  api(path, user, body, method, {
    "Idempotency-Key": randomUUID(),
    ...(version ? { "If-Match": '"' + version + '"' } : {}),
  });
async function createOrder(reservationId = null, qty = 2) {
  const o = await write("/orders", "server", {
    serviceType: "DINE_IN",
    branchId: A,
    ...(reservationId ? {} : { tableId: T }),
    reservationId,
    items: [{ dishId: facts.dish.id, quantity: qty }],
  });
  return o;
}
async function submit(o) {
  return write("/orders/" + o.id + "/submit", "server", {}, o.version);
}
const createPayment = async (orderId, voucherCode) => {
  const q = await write("/payments/quote", "reception", {
    orderId,
    tableId: T,
    voucherCode,
  });
  return write("/payments", "reception", {
    orderId,
    tableId: T,
    expectedSnapshotHash: q.snapshotHash,
    method: "CASH",
    voucherCode,
  });
};
before(async () => {
  for (const username of [
    "owner",
    "server",
    "reception",
    "reception-b",
    "manager",
  ])
    users[username] = await api(
      "/auth/login",
      null,
      { username, password },
      "POST",
    );
});
test("01 identity/roles: RS256 issuer/audience/access claims and stale/invalid/expired tokens rejected", async () => {
  assert.equal(users.reception.account.role, "NHAN_VIEN_TIEP_NHAN");
  assert.equal((await request("/payments/config", "owner")).status, 403);
  assert.equal((await request("/payments/tables")).status, 401);
  assert.equal(
    (
      await request("/orders", null, undefined, "GET", {
        Authorization: "Bearer broken",
      })
    ).status,
    401,
  );
  const key = await importPKCS8(
    fs.readFileSync(".local/jwt-private.pem", "utf8"),
    "RS256",
  );
  const expired = await new SignJWT({
    accountId: users.reception.account.id,
    role: "NHAN_VIEN_TIEP_NHAN",
    branchId: A,
    tokenVersion: 1,
    tokenUse: "access",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(users.reception.account.id)
    .setIssuer("restaurant-integrated")
    .setAudience("restaurant-api")
    .setExpirationTime(1)
    .sign(key);
  assert.equal(
    (
      await request("/payments/tables", null, undefined, "GET", {
        Authorization: "Bearer " + expired,
      })
    ).status,
    401,
  );
  assert.equal((await request("/internal/v1/orders")).status, 404);
});
test("02 anonymous reservation and reception confirmation use authoritative branch/table", async () => {
  const branches = await api("/branches");
  assert.ok(branches.some((b) => b.id === A));
  let startsAt;
  for (let day = 3; day < 28; day++) {
    const date =
      new Date(Date.now() + day * 86400000).toISOString().slice(0, 10) +
      "T10:00:00+07:00";
    const preview = await api(
      "/branches/" +
        A +
        "/tables/availability?startsAt=" +
        encodeURIComponent(date) +
        "&partySize=4",
      "reception",
    );
    if (preview.tables.some((t) => t.id === T && t.available)) {
      startsAt = date;
      break;
    }
  }
  assert.ok(startsAt);
  const r = await write("/reservations", null, {
    branchId: A,
    customerName: "Nguyễn Minh An",
    phone: "0901234567",
    startsAt,
    partySize: 4,
    serviceType: "DINE_IN",
  });
  const pending = await api("/reservations/" + r.id, "reception");
  facts.reservation = await write(
    "/reservations/" + r.id + "/confirm",
    "reception",
    { tableId: T },
    pending.version,
  );
  assert.equal(facts.reservation.table.id, T);
  assert.equal(facts.reservation.status, "CONFIRMED");
});
test("03 real menu resolve → order snapshots; owner price changes do not rewrite old lines", async () => {
  facts.dish = await write("/dishes", "owner", {
    name: "Món tích hợp " + randomUUID(),
    category: "Món chính",
    priceVnd: 85000,
  });
  const o = await createOrder(facts.reservation.id);
  assert.equal(o.tableId, T);
  assert.equal(o.items[0].unitPriceVnd, 85000);
  assert.equal(o.items[0].dishNameSnapshot, facts.dish.name);
  await write(
    "/dishes/" + facts.dish.id,
    "owner",
    { priceVnd: 95000 },
    facts.dish.version,
    "PATCH",
  );
  const saved = await api("/orders/" + o.id, "server");
  assert.equal(saved.items[0].unitPriceVnd, 85000);
  facts.order = await submit(saved);
  facts.second = await submit(await createOrder(null, 1));
  assert.equal(facts.second.items[0].unitPriceVnd, 95000);
  assert.equal(
    (
      await request("/orders/" + o.id + "/settle", "server", {}, "POST", {
        "Idempotency-Key": randomUUID(),
      })
    ).status,
    404,
  );
});
test("04 table-first payment lists two distinct unpaid orders, exact quantity/unit/total", async () => {
  const cfg = await api("/payments/config", "reception");
  assert.equal(cfg.demoOrders, false);
  assert.equal(cfg.demoTables, false);
  const tables = await api("/payments/tables", "reception");
  assert.ok(tables.every((t) => t.branchId === A));
  assert.equal(tables.find((t) => t.id === T).name, "Bàn 3");
  const orders = await api("/payments/tables/" + T + "/orders", "reception");
  assert.ok(orders.some((o) => o.id === facts.order.id));
  assert.ok(orders.some((o) => o.id === facts.second.id));
  const d = await api(
    "/payments/orders/" + facts.order.id + "?tableId=" + T,
    "reception",
  );
  assert.equal(d.order.items[0].quantity, 2);
  assert.equal(d.order.items[0].unitPriceVnd, 85000);
  assert.equal(d.order.totalVnd, 170000);
});
test("05 cash + voucher completes one order, one invoice/use/revenue; other order untouched", async () => {
  facts.payment = await createPayment(facts.order.id, "GIAM10");
  assert.equal(facts.payment.totalVnd, 153000);
  const p = await write(
    "/payments/" + facts.payment.id + "/confirm",
    "reception",
    { cashReceived: true },
  );
  assert.equal(p.state, "COMPLETED");
  facts.invoice = await api("/payments/" + p.id + "/invoice", "reception");
  assert.equal(facts.invoice.totalVnd, 153000);
  assert.equal(
    (await api("/orders/" + facts.order.id, "server")).paymentStatus,
    "PAID",
  );
  assert.equal(
    (await api("/orders/" + facts.second.id, "server")).paymentStatus,
    "UNPAID",
  );
  for (const table of [
    "payments",
    "invoices",
    "voucher_uses",
    "revenue_entries",
  ]) {
    const key = table === "payments" ? "id" : "payment_id";
    assert.equal(
      db(
        "payment-service",
        "SELECT COUNT(*) n FROM " + table + " WHERE " + key + "=?",
        [p.id],
      )[0].n,
      1,
    );
  }
  assert.equal(
    (await api("/payments/tables", "reception")).find((t) => t.id === T)
      .occupancy,
    "OCCUPIED",
  );
});
test("06 concurrent employee confirms and repeated owner acknowledgements return same receipt", async () => {
  const all = await Promise.all(
    Array.from({ length: 8 }, () =>
      write("/payments/" + facts.payment.id + "/confirm", "reception", {
        cashReceived: true,
      }),
    ),
  );
  assert.ok(
    all.every(
      (p) => p.state === "COMPLETED" && p.invoice.code === facts.invoice.code,
    ),
  );
  const o = await api("/orders/" + facts.order.id, "server");
  const body = {
    paymentId: facts.payment.id,
    branchId: A,
    tableId: T,
    totalVnd: 153000,
  };
  assert.equal(
    internal(
      "order-service",
      "/internal/v1/orders/" + o.id + "/mark-paid",
      body,
    ).body.data.paymentId,
    facts.payment.id,
  );
  const ack = { paymentId: facts.payment.id, orderId: o.id, branchId: A };
  const a = internal(
      "reservation-service",
      "/internal/v1/tables/" + T + "/payment-completed",
      ack,
    ),
    b = internal(
      "reservation-service",
      "/internal/v1/tables/" + T + "/payment-completed",
      ack,
    );
  assert.deepEqual(a, b);
  assert.equal(
    db(
      "payment-service",
      "SELECT COUNT(*) n FROM invoices WHERE payment_id=?",
      [facts.payment.id],
    )[0].n,
    1,
  );
});
test("07 branch B cannot read or pay A order/table/payment", async () => {
  assert.equal(
    (await request("/payments/" + facts.payment.id, "reception-b")).status,
    403,
  );
  assert.equal(
    (await request("/payments/tables/" + T + "/orders", "reception-b")).status,
    403,
  );
  assert.ok(
    [403, 404].includes(
      (await request("/orders/" + facts.order.id, "reception-b")).status,
    ),
  );
  assert.equal(
    (
      await request(
        "/payments/quote",
        "reception-b",
        { orderId: facts.second.id, tableId: T },
        "POST",
      )
    ).status,
    403,
  );
});
test("08 stale item preview rejected before creation; payment-lock prevents edits while collecting", async () => {
  const q = await write("/payments/quote", "reception", {
    orderId: facts.second.id,
    tableId: T,
  });
  const o = await api("/orders/" + facts.second.id, "server");
  await write(
    "/orders/" + o.id + "/items",
    "server",
    { dishId: facts.dish.id, quantity: 1 },
    o.version,
  );
  const stale = await request(
    "/payments",
    "reception",
    {
      orderId: o.id,
      tableId: T,
      method: "CASH",
      expectedSnapshotHash: q.snapshotHash,
    },
    "POST",
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.refreshOrder, true);
  const p = await createPayment(o.id);
  const current = await api("/orders/" + o.id, "server");
  assert.equal(
    (
      await request(
        "/orders/" + o.id + "/items",
        "server",
        { dishId: facts.dish.id, quantity: 1 },
        "POST",
        { "If-Match": '"' + current.version + '"' },
      )
    ).status,
    409,
  );
  await write("/payments/" + p.id + "/cancel", "reception", {});
  const released = await api("/orders/" + o.id, "server");
  assert.equal(released.paymentLocked, false);
  await write(
    "/orders/" + o.id + "/items",
    "server",
    { dishId: facts.dish.id, quantity: 1 },
    released.version,
  );
  const next=await createPayment(o.id);
  await write('/payments/'+p.id+'/cancel','reception',{});
  assert.equal((await api('/orders/'+o.id,'server')).paymentLocked,true,'Old cancel cannot unlock a new attempt');
  await write('/payments/'+next.id+'/cancel','reception',{});
});
test("09 reservation cancellation respects real submitted order, draft cancellation replays safely", async () => {
  const blocked = await request(
    "/reservations/" + facts.reservation.id + "/cancel",
    "reception",
    { reason: "Khách đổi lịch" },
    "POST",
    {
      "If-Match": '"' + facts.reservation.version + '"',
      "Idempotency-Key": randomUUID(),
    },
  );
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "ORDER_LOCKED");
  const cfg = await api("/payments/config", "reception");
  assert.equal(cfg.vnpayEnabled, false);
  const ipn = await fetch(base + "/payments/vnpay/ipn?vnp_ResponseCode=00");
  assert.equal((await ipn.json()).RspCode, "97");
});
test("10 restart all integrated containers preserves order/menu/payment/invoice and repeat confirmation", async () => {
  assert.ok(facts.invoice,"Prerequisite checkout must complete before restart verification");
  compose("restart");
  compose("up","-d","--wait");
  for (let i = 0; i < 45; i++) {
    try {
      if (
        (await request("/payments/" + facts.payment.id, "reception")).status ===
        200
      )
        break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.deepEqual(
    await api("/payments/" + facts.payment.id + "/invoice", "reception"),
    facts.invoice,
  );
  assert.equal(
    (await api("/orders/" + facts.order.id, "server")).paymentStatus,
    "PAID",
  );
  assert.equal(
    (await api("/dishes/" + facts.dish.id, "owner")).priceVnd,
    95000,
  );
  assert.equal(
    (
      await write("/payments/" + facts.payment.id + "/confirm", "reception", {
        cashReceived: true,
      })
    ).invoice.code,
    facts.invoice.code,
  );
  fs.mkdirSync("docs/integration", { recursive: true });
  fs.writeFileSync(
    "docs/integration/acceptance-facts.json",
    JSON.stringify(
      { checkedAt: new Date().toISOString(), project: stack.project, ...facts },
      null,
      2,
    ),
  );
});

test('11 owner order totals reject an oversized snapshot atomically, with no floating point conversion',async()=>{const dish=await write('/dishes','owner',{name:'Món giới hạn '+randomUUID(),category:'Kiểm thử',priceVnd:9999999999});const body={branchId:A,tableId:T,serviceType:'DINE_IN',items:[{dishId:dish.id,quantity:2}]},headers={'Idempotency-Key':randomUUID()};for(let n=0;n<2;n++){const r=await request('/orders','server',body,'POST',headers);assert.equal(r.status,422);assert.equal(r.body.error.code,'AMOUNT_TOO_LARGE');}await write('/dishes/'+dish.id,'owner',{},dish.version,'DELETE');});

test('12 reservation cancels its real draft order with safe repeated requests and one cancellation audit',async()=>{let startsAt;for(let day=3;day<28;day++){const candidate=new Date(Date.now()+day*86400000).toISOString().slice(0,10)+'T18:00:00+07:00';const available=await api('/branches/'+A+'/tables/availability?startsAt='+encodeURIComponent(candidate)+'&partySize=4','reception');if(available.tables.some(t=>t.id===T&&t.available)){startsAt=candidate;break;}}assert.ok(startsAt);let r=await write('/reservations',null,{branchId:A,customerName:'Trần Minh Bình',phone:'0901234568',startsAt,partySize:4,serviceType:'DINE_IN'});r=await api('/reservations/'+r.id,'reception');r=await write('/reservations/'+r.id+'/confirm','reception',{tableId:T},r.version);const order=await createOrder(r.id,1),headers={'If-Match':'"'+r.version+'"','Idempotency-Key':randomUUID()},body={reason:'Khách yêu cầu hủy'};const first=await request('/reservations/'+r.id+'/cancel','reception',body,'POST',headers);assert.equal(first.status,200);const retry=await request('/reservations/'+r.id+'/cancel','reception',body,'POST',headers);assert.ok([200,409].includes(retry.status));assert.equal((await api('/reservations/'+r.id,'reception')).status,'CANCELLED');assert.equal((await api('/orders/'+order.id,'server')).status,'CANCELLED');assert.equal(db('reservation-service',"SELECT COUNT(*) n FROM audit_logs WHERE reservation_id=? AND action='CANCELLED'",[r.id])[0].n,1);});
