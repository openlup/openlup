import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { createApplication } from "./app.mjs";

let config;
try { config = JSON.parse(readFileSync(0, "utf8")); }
catch { throw new Error("app_configuration_invalid"); }
const { databaseUrl, operatorToken, port = 3000 } = config ?? {};
if (typeof databaseUrl !== "string" || !databaseUrl.trim()
  || typeof operatorToken !== "string" || !/^[a-f0-9]{64}$/.test(operatorToken)
  || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("app_configuration_invalid");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const server = createApplication({ pool, operatorToken });
server.listen(port, "127.0.0.1", () => console.log("Own-stack API listening on loopback"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close(() => { void pool.end(); });
});
