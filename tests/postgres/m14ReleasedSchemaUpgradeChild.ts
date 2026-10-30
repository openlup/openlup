import { existsSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { checkServerIdentity } from "node:tls";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";

const [mode, marker] = process.argv.slice(2);
if (!mode || !marker || !["inside", "between"].includes(mode)) {
  throw new Error("released schema upgrade child arguments are invalid");
}

let payload = "";
for await (const chunk of process.stdin) payload += String(chunk);
const { database, installation } = JSON.parse(payload);
const { connectionString } = database;
if (typeof connectionString !== "string") throw new Error("database input unavailable");
// JSON transport carries CA/verification settings; reconstruct the hostname check
// because functions cannot cross stdin and pg otherwise omits IP hosts in TLS.
if (database.ssl && typeof database.ssl === "object") {
  database.ssl.checkServerIdentity = (_host: string, certificate: Parameters<typeof checkServerIdentity>[1]) =>
    checkServerIdentity(new URL(connectionString).hostname, certificate);
}
const pool = new Pool(database);
let begun = 0;
const observedPool = {
  async connect() {
    const client = await pool.connect();
    return {
      async query(sql: string, values?: unknown[]) {
        // Restricted admission inspects catalogue definitions first. Holding
        // the source-table lock earlier can block that inspection itself.
        if (installation && mode === "inside" && typeof sql === "string" && sql.includes("CREATE TABLE public.invoicing_cutover")) {
          writeFileSync(marker, "admitted-before-backfill");
          while (!existsSync(`${marker}.release`)) await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (mode === "between" && sql === "BEGIN" && ++begun === 2) {
          writeFileSync(marker, "after-first-commit");
          await new Promise<never>(() => {});
        }
        return client.query(sql, values);
      },
      release: client.release.bind(client),
    };
  },
} as unknown as Pool;

await createPostgresMigrationRunner({ connectionString }, { installation, poolFactory: () => observedPool }).apply();
throw new Error("released schema upgrade child unexpectedly completed");
