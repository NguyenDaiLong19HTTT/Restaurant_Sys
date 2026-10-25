import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { weekOf, canRegister } from "../services/schedule/week.js";
const stack = JSON.parse(fs.readFileSync(".local/stack.json")),
  base = "http://127.0.0.1:" + stack.apiPort + "/api/v1",
  password = fs.readFileSync(".local/login-password", "utf8").trim(),
  A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  tokens = {};
async function request(
  path,
  role,
  body,
  method = body ? "POST" : "GET",
  headers = {},
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(tokens[role] ? { Authorization: "Bearer " + tokens[role] } : {}),
      "Idempotency-Key": randomUUID(),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
async function api(...a) {
  const r = await request(...a);
  assert.ok(
    r.status >= 200 && r.status < 300,
    a[0] + " " + r.status + " " + JSON.stringify(r.body?.error),
  );
  return r.body?.data;
}
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
before(async () => {
  for (const username of [
    "manager",
    "manager-b",
    "owner",
    "server",
    "reception",
  ])
    tokens[username] = (
      await api("/auth/login", null, { username, password })
    ).accessToken;
});
test("staff provisions shared identity, position change revokes old token, disable rejects all old sessions", async () => {
  const n = String(Date.now()).slice(-8),
    pass = randomUUID() + "aA!",
    employee = await api("/staff/branches/" + A + "/employees", "manager", {
      fullName: "Nguyễn Minh Anh",
      dateOfBirth: "1999-01-01",
      gender: "OTHER",
      citizenId: "9999" + n,
      phone: "09" + n,
      email: "integration-" + randomUUID() + "@example.invalid",
      address: "Địa chỉ kiểm thử",
      positionId: "10000000-0000-0000-0000-000000000002",
      startDate: "2026-01-01",
      initialPassword: pass,
    });
  assert.ok(!employee.temporaryPassword);
  let account = await api("/auth/login", null, {
    username: employee.username,
    password: pass,
  });
  assert.equal(account.account.role, "NHAN_VIEN_TIEP_NHAN");
  tokens.new = account.accessToken;
  assert.equal((await request("/payments/config", "new")).status, 200);
  await api(
    "/staff/branches/" + A + "/employees/" + employee.id,
    "manager",
    { confirm: true, positionId: "10000000-0000-0000-0000-000000000001" },
    "PATCH",
  );
  assert.equal((await request("/payments/config", "new")).status, 401);
  account = await api("/auth/login", null, {
    username: employee.username,
    password: pass,
  });
  assert.equal(account.account.role, "NHAN_VIEN_PHUC_VU");
  tokens.new = account.accessToken;
  await api(
    "/staff/branches/" + A + "/employees/" + employee.id,
    "manager",
    { confirm: true },
    "DELETE",
  );
  assert.equal((await request("/dishes", "new")).status, 401);
  assert.equal(
    (
      await request("/auth/login", null, {
        username: employee.username,
        password: pass,
      })
    ).status,
    401,
  );
});
test("schedule uses staff API profiles and correct shared role/employee identity", async () => {
  const suffix=String(Date.now()).slice(-8),initialPassword=randomUUID()+'Aa!';
  const fixture=await api('/staff/branches/'+A+'/employees','manager',{fullName:'Nhân viên Kiểm thử lịch',dateOfBirth:'1999-01-01',gender:'OTHER',citizenId:'8888'+suffix,phone:'08'+suffix,email:'schedule-'+randomUUID()+'@example.invalid',address:'Dữ liệu kiểm thử tích hợp',positionId:'10000000-0000-0000-0000-000000000001',startDate:'2026-01-01',initialPassword});
  tokens.scheduleFixture=(await api('/auth/login',null,{username:fixture.username,password:initialPassword})).accessToken;
  const start = new Date(weekOf(new Date()) + 7 * 86400000 + 2 * 3600000),
    end = new Date(start.getTime() + 4 * 3600000);
  const shift = await api("/schedule/branches/" + A + "/shifts", "manager", {
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    requiredCount: 17,
  });
  const rows = await api("/schedule/branches/" + A + "/shifts", "reception");
  assert.ok(rows.some((s) => s.id === shift.id));
  if (canRegister(start)) {
    const r = await api(
      "/schedule/shifts/" + shift.id + "/registrations",
      "scheduleFixture",
      {},
    );
    await api(
      "/schedule/branches/" +
        A +
        "/shifts/" +
        shift.id +
        "/registrations/" +
        r.id,
      "manager",
      { decision: "APPROVED" },
      "PATCH",
    );
    const regs = await api(
      "/schedule/branches/" + A + "/shifts/" + shift.id + "/registrations",
      "manager",
    );
    assert.ok(
      regs.some(
        (s) => s.id === r.id && s.status === "APPROVED" && s.employee_name,
      ),
    );
  }
  const direct=await api('/schedule/branches/'+A+'/shifts','manager',{startsAt:new Date(start.getTime()+5*3600000).toISOString(),endsAt:new Date(end.getTime()+5*3600000).toISOString(),requiredCount:17});
  const assigned=await api('/schedule/branches/'+A+'/shifts/'+direct.id+'/assignments','manager',{employeeId:fixture.id});
  assert.equal(assigned.status,'APPROVED');
  const detail=await api('/schedule/branches/'+A+'/shifts/'+direct.id+'/detail','manager');
  assert.ok(detail.assignedEmployees.some(e=>e.employeeId===fixture.id));
  await api('/schedule/branches/'+A+'/shifts/'+direct.id+'/assignments/'+assigned.id,'manager',{},'DELETE');
  assert.equal(
    (await request("/schedule/branches/" + B + "/shifts", "server")).status,
    403,
  );
});
test("inventory validates real branch owner, approve/export/import writes stock movement once", async () => {
  const ingredients = await api("/ingredients", "manager"),
    ingredient = ingredients[0],
    r = await api("/transfer-requests", "manager", {
      branchId: A,
      reason: "Tích hợp kho " + randomUUID(),
      items: [{ ingredientId: ingredient.id, quantity: "0.1" }],
    });
  const eligible = await api(
    "/transfer-requests/" + r.id + "/eligible-branches",
    "owner",
  );
  const supplier = eligible.branches.find(
    (b) => b.branchId === B && b.eligible,
  );
  assert.ok(supplier);
  const warehouse = supplier.warehouses.find((w) => w.eligible);
  const approved = await api(
    "/transfer-requests/" + r.id + "/approve",
    "owner",
    { supplierBranchId: B, warehouseId: warehouse.warehouseId },
    "POST",
    { "If-Match": '"' + r.version + '"' },
  );
  const exports = await api(
      "/export-slips?branchId=" + B + "&limit=100",
      "manager-b",
    ),
    exported = exports.find((x) => x.requestId === r.id);
  assert.ok(exported);
  const headers = {
    "If-Match": '"' + exported.version + '"',
    "Idempotency-Key": randomUUID(),
  };
  await api(
    "/export-slips/" + exported.id + "/confirm",
    "manager-b",
    {},
    "POST",
    headers,
  );
  await api(
    "/export-slips/" + exported.id + "/confirm",
    "manager-b",
    {},
    "POST",
    headers,
  );
  const imports = await api(
      "/import-slips?branchId=" + A + "&limit=100",
      "manager",
    ),
    incoming = imports.find((x) => x.requestId === r.id),
    stock = await api("/branches/" + A + "/stock", "manager");
  const ih = {
    "If-Match": '"' + incoming.version + '"',
    "Idempotency-Key": randomUUID(),
  };
  await api(
    "/import-slips/" + incoming.id + "/confirm",
    "manager",
    { warehouseId: stock.warehouses[0].id },
    "POST",
    ih,
  );
  await api(
    "/import-slips/" + incoming.id + "/confirm",
    "manager",
    { warehouseId: stock.warehouses[0].id },
    "POST",
    ih,
  );
  for (const id of [exported.id, incoming.id])
    assert.equal(
      db(
        "inventory-service",
        "SELECT COUNT(*) n FROM stock_movements WHERE source_id=?",
        [id],
      )[0].n,
      1,
    );
  assert.equal((await request("/ingredients", "reception")).status, 403);
});
test("schema credentials cannot read another service database", () => {
  for (const s of [
    "identity",
    "order",
    "payment",
    "reservation",
    "inventory",
    "staff",
    "schedule",
  ]) {
    let denied = false;
    try {
      db(s + "-service", "SELECT id FROM menu_db.dishes LIMIT 1");
    } catch (e) {
      denied =
        JSON.parse(e.stdout.toString()).error === "ER_TABLEACCESS_DENIED_ERROR";
    }
    assert.equal(denied, true, s);
  }
  let denied = false;
  try {
    db("menu-service", "SELECT id FROM payment_db.payments LIMIT 1");
  } catch (e) {
    denied =
      JSON.parse(e.stdout.toString()).error === "ER_TABLEACCESS_DENIED_ERROR";
  }
  assert.equal(denied, true);
});
