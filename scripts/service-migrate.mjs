import mysql from "mysql2/promise";
import fs from "node:fs";
import { createHash } from "node:crypto";
export async function run(service) {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });
  try {
    await c.query(
      "CREATE TABLE IF NOT EXISTS integrated_migrations(id VARCHAR(100) PRIMARY KEY,checksum CHAR(64) NOT NULL)",
    );
    for (const id of fs
      .readdirSync("services/" + service + "/migrations")
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const sql = fs.readFileSync(
          "services/" + service + "/migrations/" + id,
          "utf8",
        ),
        sum = createHash("sha256").update(sql).digest("hex");
      const [[old]] = await c.execute(
        "SELECT checksum FROM integrated_migrations WHERE id=?",
        [id],
      );
      if (old) {
        if (old.checksum !== sum) throw Error("Migration changed");
        continue;
      }
      await c.query(sql);
      await c.execute("INSERT INTO integrated_migrations VALUES (?,?)", [
        id,
        sum,
      ]);
    }
  } finally {
    await c.end();
  }
}
