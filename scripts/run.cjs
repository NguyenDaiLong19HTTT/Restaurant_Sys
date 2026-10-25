const fs = require("node:fs");
for (const [key, value] of Object.entries(process.env)) {
  if (key.endsWith("_FILE")) {
    const k = key.slice(0, -5);
    if (!["JWT_PUBLIC_KEY", "JWT_PRIVATE_KEY", "VNPAY_CONFIG"].includes(k))
      process.env[k] = fs.readFileSync(value, "utf8").trim();
  }
}
process.env.JWT_PUBLIC_KEY_PATH = process.env.JWT_PUBLIC_KEY_FILE;
process.env.JWT_PRIVATE_KEY_PATH = process.env.JWT_PRIVATE_KEY_FILE;
const name = process.argv[2];
(async () => {
  if (["identity", "order", "staff", "schedule"].includes(name))
    await (await import("./service-migrate.mjs")).run(name);
  if (name === "identity") {
    await (await import("./identity-seed.mjs")).seed();
    require("../services/identity/src/server.js");
    const app = require("../services/identity/src/server.js");
    app.listen(3000, () => console.log("identity ready"));
  } else if (name === "order") require("../services/order/src/server.js");
  else if (["reservation", "inventory"].includes(name))
    require("../services/" + name + "/src/index.js");
  else {
    if (name === "staff" && process.env.SEED_DEMO === "true") {
      const mysql = require("mysql2/promise"),
        c = await mysql.createConnection({
          host: process.env.DB_HOST,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: "staff_db",
          multipleStatements: true,
        });
      await c.query(
        fs.readFileSync("services/staff/seeds/001-local.sql", "utf8"),
      );
      await c.end();
    }
    await import("../services/" + name + "/app.js");
  }
})().catch(() => {
  console.error("Service startup failed: " + name);
  process.exit(1);
});
