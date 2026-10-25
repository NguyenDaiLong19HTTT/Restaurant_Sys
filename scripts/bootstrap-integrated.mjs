import mysql from "mysql2/promise";
import fs from "node:fs";
const c = await mysql.createConnection({
  host: "mysql",
  user: "root",
  password: fs.readFileSync("/run/secrets/root_password", "utf8").trim(),
});
try {
  for (const s of [
    "order",
    "identity",
    "menu",
    "payment",
    "reservation",
    "inventory",
    "staff",
    "schedule",
  ]) {
    const password = fs
      .readFileSync("/run/secrets/" + s + "_db", "utf8")
      .trim();
    await c.query(
      "CREATE DATABASE IF NOT EXISTS " +
        s +
        "_db CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
    );
    await c.query("CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?", [
      s + "_app",
      "%",
      password,
    ]);
    await c.query("GRANT ALL PRIVILEGES ON " + s + "_db.* TO ?@?", [
      s + "_app",
      "%",
    ]);
  }
  console.log("Schemas/users initialized safely");
} finally {
  await c.end();
}
