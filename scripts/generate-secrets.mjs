import fs from 'node:fs';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
const cfg = JSON.parse(fs.readFileSync(".local/stack.json"));
for (const key of [
  "order-db",
  "root-password",
  "identity-db",
  "menu-db",
  "payment-db",
  "reservation-db",
  "inventory-db",
  "staff-db",
  "schedule-db",
  "service-token",
  "login-password",
])
  if (!fs.existsSync(".local/" + key))
    fs.writeFileSync(".local/" + key, randomBytes(30).toString("base64url"));
if (!fs.existsSync(".local/jwt-private.pem")) {
  const k = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.writeFileSync(".local/jwt-private.pem", k.privateKey);
  fs.writeFileSync(".local/jwt-public.pem", k.publicKey);
}
if (!fs.existsSync(".local/vnpay.json"))
  fs.writeFileSync(".local/vnpay.json", JSON.stringify({ enabled: false }));
fs.writeFileSync(
  ".local/compose.env",
  "COMPOSE_PROJECT_NAME=" +
    cfg.project +
    "\nWEB_PORT=" +
    cfg.webPort +
    "\nAPI_PORT=" +
    cfg.apiPort +
    "\n",
);
console.log(
  "New isolated project " +
    cfg.project +
    "; web " +
    cfg.webPort +
    ", Gateway " +
    cfg.apiPort +
    "; secrets created without displaying values.",
);
