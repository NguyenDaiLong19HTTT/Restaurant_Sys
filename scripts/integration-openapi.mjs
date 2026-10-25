import fs from "node:fs";
const spec = {
  openapi: "3.0.3",
  info: {
    title: "Restaurant Integrated Gateway and Owner Contracts",
    version: "1.0.0",
    description:
      "Public paths use Gateway /api/v1. Internal paths are Docker-only owner URLs; never exposed by Gateway. See docs/integration/CONTRACTS.md for ownership, version/hash and idempotency semantics.",
  },
  servers: [{ url: "http://localhost:19081" }],
  security: [{ bearerAuth: [] }],
  paths: {},
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "RS256 JWT" },
      serviceAuth: { type: "apiKey", in: "header", name: "X-Service-Token" },
    },
    schemas: {},
  },
};
for (const [doc, tag] of [
  ["menu", "menu"],
  ["payment", "payment"],
]) {
  const source = JSON.parse(
    fs.readFileSync("packages/contracts/" + doc + ".openapi.json"),
  );
  Object.assign(spec.components.securitySchemes, source.components.securitySchemes||{});
  for (const p of Object.keys(source.paths)) {
    const item = JSON.parse(
      JSON.stringify(source.paths[p]).replaceAll(
        "#/components/",
        "./" + doc + ".openapi.json#/components/",
      ),
    );
    if (p.startsWith("/internal/"))
      item.servers = [{ url: "http://" + doc + "-service:3000" }];
    spec.paths[p] = item;
  }
}
const sources = [
  ["identity", "services/identity/src/server.js", ""],
  ["order", "services/order/src/routes/order-routes.js", "/api/v1/orders"],
  [
    "order",
    "services/order/src/routes/internal-order-routes.js",
    "/internal/v1",
  ],
  ["order", "services/order/src/routes/payment-routes.js", "/internal/v1"],
  ["reservation", "services/reservation/src/routes/reservations.js", "/api/v1"],
  [
    "reservation",
    "services/reservation/src/routes/internal.js",
    "/internal/v1",
  ],
  ["reservation", "services/reservation/src/routes/integration.js", ""],
  ["inventory", "services/inventory/src/routes/inventory.js", "/api/v1"],
  ["staff", "services/staff/app.js", "/api/v1/staff"],
  ["schedule", "services/schedule/app.js", "/api/v1/schedule"],
];
for (const [owner, file, prefix] of sources) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(
    /(?:router|server|app|publicRouter|staffRouter)\.(get|post|patch|delete)\(\s*['"]([^'"]+)['"]/g,
  )) {
    const [_, method, raw] = match;
    let route = raw.startsWith("/internal/") ? raw : prefix + raw;
    if (route.endsWith("/")) route = route.slice(0, -1);
    if (route.startsWith("/health") || route === "/ready" || !route) continue;
    route = route.replace(/:([a-zA-Z0-9]+)/g, "{$1}");
    const internal = route.startsWith("/internal/"),
      publicRoute =
        (method === "post" &&
          [
            "/api/v1/reservations",
            "/api/v1/auth/login",
            "/api/v1/auth/refresh",
            "/api/v1/auth/logout",
          ].includes(route)) ||
        (method === "get" && route === "/api/v1/branches");
    const operation = {
      tags: [owner],
      summary: method.toUpperCase() + " " + route,
      "x-owner-service": owner,
      security: internal
        ? [{ serviceAuth: [] }]
        : publicRoute
          ? []
          : [{ bearerAuth: [] }],
      parameters: [...route.matchAll(/\{([^}]+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      responses: {
        200: { description: "Successful owner response; data envelope" },
        400: { description: "Invalid request or missing precondition" },
        401: {
          description:
            "Invalid/expired/stale JWT or invalid service credential",
        },
        403: { description: "Role or branch scope denied" },
        409: { description: "Version/hash/state/idempotency conflict" },
        503: {
          description:
            "Dependency unknown/unavailable; do not infer payment failure",
        },
      },
    };
    if (["post", "patch"].includes(method))
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      };
    if (internal) {
      operation.servers = [{ url: "http://" + owner + "-service:3000" }];
      operation["x-internal-only"] = true;
    }
    spec.paths[route] ||= {};
    spec.paths[route][method] = operation;
  }
}
const schemas = spec.components.schemas;
const uuid = { type: "string", format: "uuid" },
  vnd = {
    type: "integer",
    format: "int64",
    minimum: 0,
    description: "Integer VND, never floating point",
  };
schemas.OrderLine = {
  type: "object",
  required: ["id", "dishId", "dishNameSnapshot", "quantity", "unitPriceVnd"],
  properties: {
    id: uuid,
    dishId: uuid,
    dishNameSnapshot: { type: "string" },
    quantity: { type: "integer", minimum: 1 },
    unitPriceVnd: vnd,
    lineTotalVnd: vnd,
  },
};
schemas.OrderContext = {
  type: "object",
  required: [
    "id",
    "branchId",
    "tableId",
    "version",
    "status",
    "paymentStatus",
    "items",
  ],
  properties: {
    id: uuid,
    code: { type: "string" },
    branchId: uuid,
    tableId: uuid,
    reservationId: { ...uuid, nullable: true },
    version: { type: "integer", minimum: 1 },
    status: {
      type: "string",
      enum: ["DRAFT", "SUBMITTED", "HANDED_OVER", "CANCELLED"],
    },
    paymentStatus: { type: "string", enum: ["UNPAID", "PAID"] },
    paidPaymentId: { ...uuid, nullable: true },
    totalVnd: vnd,
    items: { type: "array", items: { $ref: "#/components/schemas/OrderLine" } },
  },
};
schemas.PaymentLock = {
  type: "object",
  required: ["paymentId", "tableId", "expectedSnapshotHash", "lockId"],
  properties: {
    tableId: uuid,
    expectedSnapshotHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    lockId: { type: "string", maxLength: 128 },
    replacesPaymentId: uuid,
  },
};
schemas.PaymentLock.properties.paymentId=uuid;
schemas.MarkPaid = {
  type: "object",
  required: [
    "paymentId",
    "lockId",
    "branchId",
    "tableId",
    "expectedSnapshot",
    "orderVersion",
    "totalVnd",
    "discountVnd",
    "method",
  ],
  properties: {
    paymentId: uuid,
    lockId: { type: "string" },
    branchId: uuid,
    tableId: uuid,
    expectedSnapshot: { $ref: "#/components/schemas/OrderContext" },
    orderVersion: { type: "integer" },
    totalVnd: vnd,
    discountVnd: vnd,
    method: { type: "string", enum: ["CASH", "VNPAY"] },
  },
};
schemas.TablePaymentCompleted = {
  type: "object",
  required: ["paymentId", "orderId", "branchId"],
  properties: { paymentId: uuid, orderId: uuid, branchId: uuid },
};
for (const [p, s] of [
  ["/internal/v1/orders/{id}/payment-lock", "PaymentLock"],
  ["/internal/v1/orders/{id}/mark-paid", "MarkPaid"],
  ["/internal/v1/tables/{id}/payment-completed", "TablePaymentCompleted"],
])
  spec.paths[p].post.requestBody.content["application/json"].schema = {
    $ref: "#/components/schemas/" + s,
  };
spec.paths["/internal/v1/payments/{id}/status"] = {
  get: {
    tags: ["payment"],
    summary: "Verify payment owner state before order acknowledgement",
    security: [{ serviceAuth: [] }],
    servers: [{ url: "http://payment-service:3000" }],
    "x-internal-only": true,
    parameters: [{ name: "id", in: "path", required: true, schema: uuid }],
    responses: {
      200: { description: "data {id,orderId,branchId,state,totalVnd}" },
      401: { description: "Service credential required" },
      404: { description: "Payment unknown, do not mark paid" },
    },
  },
};
fs.writeFileSync(
  "packages/contracts/integration.openapi.json",
  JSON.stringify(spec, null, 2),
);
console.log(
  "OpenAPI route index generated: " + Object.keys(spec.paths).length + " paths",
);
