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
    const [[lock]]=await c.query("SELECT GET_LOCK(?,60) acquired",[service+"_integrated_migrations"]);
    if(lock.acquired!==1)throw Error("Migration lock unavailable");
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
      // MySQL ALTER is atomic; recover if it committed before the ledger insert.
      const additions=[...sql.matchAll(/ADD COLUMN (\w+)/gi)].map(m=>m[1]);
      let alreadyApplied=false;
      if(service==='order' && /^ALTER TABLE orders /i.test(sql.trim()) && additions.length){
        const [columns]=await c.execute("SELECT column_name name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='orders'");
        const names=new Set(columns.map(r=>r.name)),existing=additions.filter(n=>names.has(n));
        if(existing.length && existing.length!==additions.length)throw Error('Partial order schema requires inspection');
        alreadyApplied=existing.length===additions.length;
      }
      if(!alreadyApplied)await c.query(sql);
      await c.execute("INSERT INTO integrated_migrations VALUES (?,?)", [
        id,
        sum,
      ]);
    }
  } finally {
    await c.end();
  }
}
