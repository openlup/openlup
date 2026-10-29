import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";

const [connectionString, mode, marker] = process.argv.slice(2);
if (!connectionString || !mode || !marker || !["inside", "between"].includes(mode)) {
  throw new Error("released schema upgrade child arguments are invalid");
}

const pool = new Pool({ connectionString });
let begun = 0;
const observedPool = {
  async connect() {
    const client = await pool.connect();
    return {
      async query(sql: string, values?: unknown[]) {
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

await createPostgresMigrationRunner({ connectionString }, { poolFactory: () => observedPool }).apply();
throw new Error("released schema upgrade child unexpectedly completed");
