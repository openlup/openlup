import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupabaseAddressCanonLookupPort } from "../../server/adapters/supabase/address-canon/addressCanonLookup.js";
import { PgGatewayClient } from "@openlup/platform/data";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const TABLES = ["address_canon_sources", "address_canon_localities", "address_canon_streets", "address_canon_postal_localities"];
const A = "16000000-0000-4000-8000-000000000001";
const B = "16000000-0000-4000-8000-000000000002";
const OLD = "16000000-0000-4000-8000-000000000003";
let container: PostgresContainer | undefined;
let owner: Pool;
let reader: Pool;

beforeAll(async () => {
  if (!(await dockerAvailable())) throw new Error("market directory: Docker unavailable; missing real PG proof");
  container = await runPostgresContainer({ name: `market-directory-${process.pid}-${randomUUID().slice(0, 8)}`, password: "fixture", database: "directory" });
  if (!(await waitForPostgresTcpReady(container.connectionString))) throw new Error("market directory PG readiness failed");
  owner = new Pool({ connectionString: container.connectionString });
  await owner.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE openlup_mcp_reader; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT null::uuid $$;
    CREATE TABLE public.admin_users(id uuid PRIMARY KEY);
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT SELECT ON admin_users TO authenticated;`);
  // Exact current directory object sections, with managed auth prerequisites.
  // This is selected-object proof, not a complete managed installation.
  const baseline = await readFile("supabase/migrations/00000000000000_platform_schema_baseline.sql", "utf8");
  const sections = baseline.split(/(?=^--\n-- Name: )/m).filter(section => (section.split("\n")[1] ?? "").includes("address_canon_"));
  expect(sections.length).toBeGreaterThan(20);
  for (const section of sections) await owner.query(section);
  const closure = await readFile("supabase/migrations/20261004123000_runtime_capability_rls_closure.sql", "utf8");
  const drops = closure.match(/^DROP POLICY admin_all_address_canon_.*;$/gm) ?? [];
  expect(drops).toHaveLength(3);
  for (const statement of drops) await owner.query(statement);
  await owner.query(`CREATE ROLE market_fixture LOGIN PASSWORD 'fixture' NOINHERIT NOSUPERUSER NOBYPASSRLS;
    GRANT anon, authenticated, service_role TO market_fixture WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
    INSERT INTO address_canon_sources(source_key,status,display_name,official_url,source_revision,source_updated_at) VALUES
      ('gus_teryt','active','Synthetic directory','https://example.invalid/directory','fixture-v1','2026-01-01T00:00:00Z'),
      ('poczta_pna','disabled_pending_license','Synthetic pending source','https://example.invalid/pending',null,null);
    INSERT INTO address_canon_localities(id,source_key,terc_code,simc_code,name,normalized_name,active) VALUES
      ('${A}','gus_teryt','01','01','Écho Port','echo port',true),
      ('${B}','gus_teryt','02','02','Echo Hills','echo hills',true),
      ('${OLD}','gus_teryt','03','03','Echo Old','echo old',false);
    INSERT INTO address_canon_postal_localities(postal_code,locality_id,source_key,confidence) VALUES
      ('00-001','${A}','gus_teryt','exact'),('00-001','${B}','gus_teryt','ambiguous'),('00-001','${OLD}','gus_teryt','partial');
    INSERT INTO address_canon_streets(id,source_key,locality_id,name,normalized_name,active) VALUES
      ('16000000-0000-4000-8000-000000000011','gus_teryt','${A}','Écho Road','echo road',true),
      ('16000000-0000-4000-8000-000000000012','gus_teryt','${A}','Echo Old Road','echo old road',false),
      ('16000000-0000-4000-8000-000000000013','gus_teryt','${B}','Other Road','other road',true);`);
  const connection = new URL(container.connectionString); connection.username = "market_fixture";
  reader = new Pool({ connectionString: connection.toString() });
}, 120_000);
afterAll(async () => {
  const closed = await Promise.allSettled([reader?.end(), owner?.end()]);
  await container?.remove();
  for (const result of closed) if (result.status === "rejected") throw result.reason;
});
async function asRole<T>(role: "authenticated" | "anon" | "service_role", run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await reader.connect();
  try { await client.query("BEGIN"); await client.query(`SET LOCAL ROLE ${role}`); return await run(client); }
  finally { await client.query("ROLLBACK"); client.release(); }
}
function adapter(client: PoolClient) { return createSupabaseAddressCanonLookupPort(new PgGatewayClient(client) as unknown as SupabaseClient); }

describe("market directory preservation on current managed objects", () => {
  it("keeps provenance/status and active-only restricted reads", async () => {
    const value = await asRole("authenticated", async c => ({
      who: (await c.query("SELECT current_user,session_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) elevated")).rows[0],
      localities: (await c.query("SELECT id FROM address_canon_localities ORDER BY id")).rows,
      streets: (await c.query("SELECT name FROM address_canon_streets ORDER BY name")).rows,
      pending: (await c.query("SELECT status FROM address_canon_sources WHERE source_key='poczta_pna'")).rows,
    }));
    expect(value.who).toEqual({ current_user: "authenticated", session_user: "market_fixture", elevated: false });
    expect(value.localities).toEqual([{ id: A }, { id: B }]);
    expect(value.streets.map(r => r.name).sort()).toEqual(["Other Road", "Écho Road"]);
    expect(value.pending).toEqual([{ status: "disabled_pending_license" }]);
    expect((await asRole("service_role", c => c.query("SELECT count(*)::int n FROM address_canon_localities"))).rows).toEqual([{ n: 3 }]);
  });
  it("denies anonymous reads and authenticated writes", async () => {
    for (const table of TABLES) {
      await expect(asRole("anon", c => c.query(`SELECT * FROM ${table}`))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole("authenticated", c => c.query(`UPDATE ${table} SET ${table.endsWith("sources") ? "status='active'" : "active=false"}`))).rejects.toMatchObject({ code: "42501" });
    }
    expect((await owner.query("SELECT status FROM address_canon_sources WHERE source_key='poczta_pna'")).rows).toEqual([{ status: "disabled_pending_license" }]);
  });
  it("performs postal adapter reads with full provenance and valid empty results", async () => {
    const result = await asRole("service_role", c => adapter(c).lookupPostalCode({ postalCode: "00-001", limit: 10 }));
    expect(result.candidates.map(c => c.localityId).sort()).toEqual([A, B]);
    expect(result.candidates.find(c => c.localityId === A)).toMatchObject({ name: "Écho Port", countryCode: "PL", postalCode: "00-001", confidence: "exact", resolutionLevel: "postal_code", sources: [{ sourceKind: "gus_teryt", status: "active", sourceRevision: "fixture-v1" }] });
    expect(result.sources).toEqual([expect.objectContaining({ sourceKind: "gus_teryt", officialUrl: "https://example.invalid/directory", sourceRevision: "fixture-v1", sourceUpdatedAt: expect.any(Date) })]);
    expect(new Date(result.sources[0]!.sourceUpdatedAt!).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const empty = await asRole("service_role", c => adapter(c).lookupPostalCode({ postalCode: "99-999", limit: 10 }));
    expect(empty.candidates).toEqual([]); expect(empty.sources).toEqual([]);
  });
  it("retains actual prefix, parent, limit and provenance predicates", async () => {
    // Managed .like mapping belongs to the adapter unit witness. This gateway
    // has no .like support; direct SQL makes no transport capability claim.
    await asRole("authenticated", async c => {
      const places = await c.query("SELECT id,source_key FROM address_canon_localities WHERE active=true AND normalized_name LIKE $1 LIMIT $2", ["echo%", 10]);
      expect(places.rows.map(r => r.id).sort()).toEqual([A, B]);
      const bounded = await c.query("SELECT id FROM address_canon_localities WHERE active=true AND normalized_name LIKE $1 LIMIT $2", ["echo%", 1]);
      expect(bounded.rows).toHaveLength(1); expect([A, B]).toContain(bounded.rows[0].id);
      const streets = await c.query("SELECT locality_id,name,source_key FROM address_canon_streets WHERE locality_id=$1 AND active=true AND normalized_name LIKE $2 LIMIT $3", [A, "echo%", 10]);
      expect(streets.rows).toEqual([{ locality_id: A, name: "Écho Road", source_key: "gus_teryt" }]);
      expect((await c.query("SELECT source_key,status,source_revision,source_updated_at FROM address_canon_sources WHERE source_key=ANY($1::text[])", [places.rows.map(r => r.source_key)])).rows).toEqual([{ source_key: "gus_teryt", status: "active", source_revision: "fixture-v1", source_updated_at: new Date("2026-01-01T00:00:00Z") }]);
      expect((await c.query("SELECT id FROM address_canon_localities WHERE active=true AND normalized_name LIKE $1 LIMIT $2", ["absent%", 10])).rows).toEqual([]);
    });
  });
  it("distinguishes probe failure from empty and restores after rollback", async () => {
    expect(await asRole("authenticated", c => adapter(c).probeDataAvailable())).toBe(true);
    await owner.query("REVOKE SELECT ON address_canon_localities FROM authenticated");
    try { await expect(asRole("authenticated", c => adapter(c).probeDataAvailable())).rejects.toMatchObject({ code: "42501" }); }
    finally { await owner.query("GRANT SELECT ON address_canon_localities TO authenticated"); }
    expect(await asRole("service_role", async c => { await c.query("UPDATE address_canon_localities SET active=false"); return adapter(c).probeDataAvailable(); })).toBe(false);
    expect(await asRole("authenticated", c => adapter(c).probeDataAvailable())).toBe(true);
  });
  it("refuses unsupported country and postal shapes without persisting a change", async () => {
    await expect(asRole("service_role", c => c.query("UPDATE address_canon_localities SET country_code='DE' WHERE id=$1", [A]))).rejects.toMatchObject({ code: "23514" });
    await expect(asRole("service_role", c => c.query("UPDATE address_canon_postal_localities SET postal_code='invalid' WHERE locality_id=$1", [A]))).rejects.toMatchObject({ code: "23514" });
    expect((await owner.query("SELECT country_code FROM address_canon_localities WHERE id=$1", [A])).rows).toEqual([{ country_code: "PL" }]);
  });
});
