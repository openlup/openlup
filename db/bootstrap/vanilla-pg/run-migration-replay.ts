// W10 migration-replay driver (Platform Portability).
// Invoked by migration-replay-conformance.sh inside a docker-spun postgres:16. Runs the vanilla-PG
// MigrationRunner against DATABASE_URL, asserting that the set the runner selects applies cleanly
// (status -> apply -> status shows nothing pending), then closes the pool. Exits non-zero on any
// failure so the shell wrapper fails honestly.
//
// ⚠️ THE SET IS THE RUNNER'S, NOT THIS FILE'S. `createPostgresMigrationRunner` reads the public
// platform manifest, so what replays here is `db/platform/migrations`. This driver applies no
// bootstrap prelude and no part of the 442-file history the publication flattens away; this header
// once named both, and that was a false pass. The counts printed below are of the manifest-bound
// set alone.

import { createPostgresMigrationRunner } from "../../../server/adapters/postgres/migrationRunner.js";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const runner = createPostgresMigrationRunner({ connectionString });

  const before = await runner.status();
  console.log(`[replay] pending before apply: ${before.pending.length}`);

  const { applied } = await runner.apply();
  console.log(`[replay] applied: ${applied.length}`);

  const after = await runner.status();
  console.log(`[replay] pending after apply: ${after.pending.length}, applied total: ${after.applied.length}`);

  if (after.pending.length !== 0) {
    throw new Error(`migration replay incomplete: ${after.pending.length} still pending`);
  }
  console.log("[replay] OK — nothing pending after apply");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[replay] FAILED:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
