import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixture, graph, insertGraph, installPublicationActors } from "./catalogPublicationFixture.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from "../helpers/postgresContainer.js";

let pool: Pool;
let container: PostgresContainer;

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-governed-roster-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Governed roster proof needs PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  const { baseline, forward } = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as
    { baseline: { file: string }; forward: { file: string }[] };
  for (const { file } of [baseline, ...forward]) await pool.query(readFileSync(file, "utf8"));
  await installPublicationActors(pool);
}, postgresSetupTimeoutMs);

afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

it("commits a governed publication with 2,000 SKUs", async () => {
  const count = 2_000;
  const data = fixture();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const issue = await graph(db, data, null, true, { lifecycle: "draft" });
    issue.product.axes = ["finish"];
    await insertGraph(db, issue, { extraSkuCount: count - 1 });
    const started = performance.now();
    await db.query("COMMIT");
    console.info(`Governed publication COMMIT (${count} SKUs): ${(performance.now() - started).toFixed(0)} ms`);
    const saved = await db.query(`SELECT h.publication_id,p.issued_count,p.canonical_state::jsonb->'schemaVersion' AS dialect
      FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON p.id=h.publication_id
      WHERE h.product_id=$1`, [data.productId]);
    expect(saved.rows).toEqual([{ publication_id: issue.issueId, issued_count: count, dialect: 3 }]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
}, 600_000);
