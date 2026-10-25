import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
export async function seed() {
  if (process.env.SEED_DEMO !== "true") return;
  const pool = require("../services/identity/src/db.js"),
    { hashPassword } = require("../services/identity/src/auth.js"),
    password = fs.readFileSync("/run/secrets/login_password", "utf8").trim();
  const a = "11111111-1111-4111-8111-111111111111",
    b = "22222222-2222-4222-8222-222222222222";
  const definitions = [
    ["owner", "CHU_CHUOI", null],
    ["manager", "QUAN_LY_CHI_NHANH", a],
    ["server", "NHAN_VIEN_PHUC_VU", a],
    ["reception", "NHAN_VIEN_TIEP_NHAN", a],
    ["reception-b", "NHAN_VIEN_TIEP_NHAN", b],
    ["manager-b", "QUAN_LY_CHI_NHANH", b],
  ];
  for (let n = 0; n < definitions.length; n++) {
    const [username, role, branch] = definitions[n],
      id = "f0000000-0000-4000-8000-" + String(n + 1).padStart(12, "0");
    await pool.execute(
      "INSERT IGNORE INTO accounts(id,username,password_hash,employee_id,role,branch_id,status,must_change_password) VALUES (?,?,?,?,?,?,?,FALSE)",
      [
        id,
        username,
        await hashPassword(password),
        branch ? id : null,
        role,
        branch,
        "ACTIVE",
      ],
    );
  }
}
