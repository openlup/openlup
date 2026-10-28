import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { checkReadiness, createSchemaProbe, type ReadinessReport, type SchemaObservation } from "@openlup/core/readiness";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { SHIPPING_MIGRATIONS } from "@openlup/platform/shipping";
import { createM06ShippingReferenceBinding } from "../../server/runtime/public-reference/m06ShippingBinding.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const file = "db/platform/migrations/20261021200000_shipping_flat_rate_seed.sql";
const version = "20261021200000_shipping_flat_rate_seed";
const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "legacy");
const seedIndex = manifest.forward.findIndex((entry: { file: string }) => entry.file === file);
const seed = SHIPPING_MIGRATIONS.find(entry => entry.id === version)!;
const containers: PostgresContainer[] = [], pools: Pool[] = [];
const bindings: ReturnType<typeof createM06ShippingReferenceBinding>[] = [];
type NativeReadiness = { nativeRateReadiness: ReadinessReport; nativeRateSchema: SchemaObservation };
let prefix: string, beforeAcl: unknown, afterSeedAcl: unknown, oldReadiness: NativeReadiness;
const runner = (pool: Pool, root = process.cwd()) => createPostgresMigrationRunner({ connectionString: "injected" }, { root, poolFactory: () => pool });
function binding(index: number, readiness?: NativeReadiness) {
  const result = createM06ShippingReferenceBinding({
    store: { dataKind: "postgres", ...readiness },
    nativeRate: { env: { connectionString: containers[index].connectionString } },
    version: "0.18.0", requiredSchema: { version, migration: file, objects: [{ kind: "table", name: "public.clients" }, { kind: "table", name: "public.commerce_settings" }] },
    rate: { authorizeAdmin: async () => ({ ok: true, userId: "f6000000-0000-4000-8000-000000000001", role: "admin", isMachineActor: false }) },
  });
  bindings.push(result); return result;
}
async function readiness(index: number, candidateSchema = version) {
  const host = binding(index);
  const requiredSchema = host.contributions[0].manifest.requiredSchema!;
  expect(requiredSchema.version).toBe(version); expect(requiredSchema.migration).toBe(file);
  expect(requiredSchema.objects.filter(object => object.name === "public.commerce_settings")).toHaveLength(1);
  const nativeRateSchema = (await host.observeNativeRateSchema())!;
  const schemaProbe = createSchemaProbe(pools[index], async () => ({ database: nativeRateSchema.database, version: nativeRateSchema.version }));
  const observation = await schemaProbe.observe(requiredSchema);
  expect(observation.objects).toContainEqual({ object: { kind: "table", name: "public.clients" }, present: true });
  const nativeRateReadiness = await checkReadiness({
    candidate: { artifact: "synthetic", configuration: "shipping", environment: "disposable", database: nativeRateSchema.database, schema: candidateSchema }, inventoryComplete: true,
    loadedPackages: [{ name: "@openlup/core", version: "0.18.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.18.0", kind: "rail" }],
    contributions: [{ manifest: { name: "@openlup/platform", version: "0.18.0", kind: "rail", emits: [], handles: [], schedules: [], routes: [], env: [], requiredPorts: [], requiredSchema }, handlers: [], schedules: [], routes: [] }],
    bindings: { ports: {}, triggers: {}, routes: {}, env: {} }, vocabulary: [], exemptions: [], schemaProbe,
  });
  return { nativeRateReadiness, nativeRateSchema };
}
async function acl(pool: Pool) {
  const client = await pool.connect();
  try {
    const projection = await readSelectedCatalogProjection(client);
    return { aclGrants: projection.aclGrants, defaultPrivileges: projection.defaultPrivileges, roleMemberships: projection.roleMemberships };
  } finally { client.release(); }
}
async function invoke(selected: ReturnType<typeof binding>, method: string, body?: unknown) {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  await selected.handlers.rate!({ method, body } as never, res as never); return res;
}
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Native shipping proof requires real PostgreSQL");
  expect(seedIndex).toBeGreaterThanOrEqual(0);
  prefix = mkdtempSync(join(tmpdir(), "shipping-prefix-"));
  const previous = { ...manifest, forward: manifest.forward.slice(0, seedIndex),
    objectInventorySha256: "59f08ac97163fe310fab0928027996a5dbb885d5161ddc7a709e82c2947fdded" };
  for (const entry of [previous.baseline, ...previous.forward]) {
    const target = join(prefix, entry.file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(entry.file));
  }
  mkdirSync(join(prefix, "config")); writeFileSync(join(prefix, "config/platform-migration-manifest.json"), JSON.stringify(previous));
  for (const name of ["fresh", "upgrade"]) {
    const container = await runPostgresContainer({ name: `m06-shipping-${name}-${process.pid}`, password: "synthetic-conformance" });
    containers.push(container);
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native shipping PostgreSQL unavailable");
    pools.push(new Pool({ connectionString: container.connectionString }));
  }
  await runner(pools[0]).apply(); await runner(pools[1], prefix).apply();
  await pools[1].query("INSERT INTO public.commerce_settings(key,value_minor) VALUES ('shipping_flat_minor',1234)");
  beforeAcl = await acl(pools[1]); oldReadiness = await readiness(1);
  // Compare the seed's own before/after pair, even when later forwards change ACLs.
  await pools[1].query(readFileSync(file, "utf8"));
  afterSeedAcl = await acl(pools[1]);
}, postgresSetupTimeoutMs);
afterAll(async () => {
  await closePostgres(containers, pools, bindings.map(value => () => value.close())); if (prefix) rmSync(prefix, { recursive: true, force: true });
}, postgresTeardownTimeoutMs);
it("fresh full portable installation seeds and saves through the reference binding", async () => {
  expect((await pools[0].query("SELECT value_minor FROM public.commerce_settings WHERE key='shipping_flat_minor'")).rows).toEqual([{ value_minor: 0 }]);
  expect({ file: seed.catalogPath, sha256: seed.sha256 }).toEqual(manifest.forward[seedIndex]);
  expect(seed.position).toBe(seedIndex + 1); expect(seed.url.pathname.endsWith(`/sql/${seed.id}.sql`)).toBe(true);
  expect(createHash("sha256").update(readFileSync(seed.url)).digest("hex")).toBe(seed.sha256);
  await pools[0].query("INSERT INTO public.commerce_settings(key,value_minor,value_text) VALUES ('configurator_offer_layout',42,'cards')");
  const sibling = (await pools[0].query("SELECT to_jsonb(t) AS row FROM public.commerce_settings t WHERE key='configurator_offer_layout'")).rows;
  const ready = await readiness(0); expect(ready.nativeRateReadiness.state).toBe("ready");
  const selected = binding(0, ready); expect(selected.unsupported.flatRateSave).toBeNull();
  expect((await invoke(selected, "POST", { shippingFlatMinor: 725 })).status).toHaveBeenCalledWith(200);
  expect((await invoke(selected, "GET")).json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ shippingFlatMinor: 725 }) }));
  expect((await pools[0].query("SELECT to_jsonb(t) AS row FROM public.commerce_settings t WHERE key='configurator_offer_layout'")).rows).toEqual(sibling);
});
it("upgrades the exact pre-seed prefix without replacing an existing nonzero rate and replays the exact ledger", async () => {
  expect((await runner(pools[1]).apply()).applied).toEqual(manifest.forward.slice(seedIndex).map((entry: { file: string }) => entry.file));
  expect((await pools[1].query("SELECT value_minor FROM public.commerce_settings WHERE key='shipping_flat_minor'")).rows).toEqual([{ value_minor: 1234 }]);
  expect((await runner(pools[1]).apply()).applied).toEqual([]);
  expect((await pools[1].query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows)
    .toEqual([manifest.baseline, ...manifest.forward].map((entry: { file: string; sha256: string }, position: number) => ({ catalog_path: entry.file, sha256: entry.sha256, position })));
  const client = await pools[1].connect();
  try {
    const payload = selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
    expect(createHash("sha256").update(payload).digest("hex")).toBe(manifest.objectInventorySha256);
  } finally { client.release(); }
});
it("retains the named binding refusal on the old prefix and enables only the observed forward", async () => {
  expect(oldReadiness.nativeRateReadiness.state).toBe("unknown");
  expect(oldReadiness.nativeRateSchema.version).toBeNull();
  const old = binding(1, oldReadiness);
  expect(old.readiness.reason).toBe("shipping_native_flat_rate_save_unsupported"); expect(old.handlers.rate).toBeNull();
  // A later ledger tail and whole-candidate schema label do not revoke this capability.
  const laterFile = "db/platform/migrations/20990101000000_later.sql";
  await pools[1].query("INSERT INTO public.platform_schema_migrations(position,catalog_path,sha256) SELECT max(position)+1,$1,repeat('a',64) FROM public.platform_schema_migrations", [laterFile]);
  try {
    const later = await readiness(1, "20990101000000_later");
    const selected = binding(1, later); expect(selected.readiness.ready).toBe(true);
    expect((await invoke(selected, "POST", { shippingFlatMinor: 900 })).status).toHaveBeenCalledWith(200);
    const unrelated = { ...later, nativeRateSchema: { ...later.nativeRateSchema, version: null } };
    unrelated.nativeRateReadiness = { ...later.nativeRateReadiness, candidate: { ...later.nativeRateReadiness.candidate, schema: version } };
    expect(binding(1, unrelated).readiness.reason).toBe("shipping_native_flat_rate_save_unsupported");
    await pools[1].query("UPDATE public.platform_schema_migrations SET sha256=repeat('b',64) WHERE catalog_path=$1", [file]);
    expect(binding(1, await readiness(1)).readiness.reason).toBe("shipping_native_flat_rate_save_unsupported");
  } finally {
    await pools[1].query("DELETE FROM public.platform_schema_migrations WHERE catalog_path=$1", [laterFile]);
    await pools[1].query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE catalog_path=$2", [seed.sha256, file]);
  }
});
it("denies commerce settings reads and updates to anon, authenticated and a PUBLIC-only principal", async () => {
  await pools[0].query("CREATE ROLE shipping_public_only NOLOGIN NOINHERIT");
  const client = await pools[0].connect();
  try {
    for (const role of ["anon", "authenticated", "shipping_public_only"]) {
      await client.query(`SET ROLE ${role}`);
      await expect(client.query("SELECT value_minor FROM public.commerce_settings WHERE key=$1", ["shipping_flat_minor"])).rejects.toMatchObject({ code: "42501" });
      await expect(client.query("UPDATE public.commerce_settings SET value_minor=$1 WHERE key=$2", [1, "shipping_flat_minor"])).rejects.toMatchObject({ code: "42501" });
      await client.query("RESET ROLE");
    }
  } finally { await client.query("RESET ROLE"); client.release(); await pools[0].query("DROP ROLE shipping_public_only"); }
});
it("leaves whole-catalog ACLs, default privileges and role memberships byte-identical across the seed forward", async () => {
  expect(afterSeedAcl).toEqual(beforeAcl);
});
it("refuses a missing row by name and keeps unsupported audit failure nonblocking after a real save", async () => {
  const selected = binding(0, await readiness(0));
  const port = selected.store.shippingRateDataPort!;
  await expect(port.recordPromotionAudit({ actorId: "synthetic", actorEmail: null, action: "shipping_rate_change", promotionId: "shipping_flat_minor", newValue: { shippingFlatMinor: 100 } })).rejects.toThrow("shipping_native_flat_rate_audit_unsupported");
  await pools[0].query("DELETE FROM public.commerce_settings WHERE key='shipping_flat_minor'");
  await expect(port.getShippingFlatMinor()).rejects.toThrow("shipping_native_flat_rate_row_required");
  await expect(port.setShippingFlatMinor(100)).rejects.toThrow("shipping_native_flat_rate_row_required");
  expect((await invoke(selected, "POST", { shippingFlatMinor: 100 })).status).toHaveBeenCalledWith(503);
  await pools[0].query(readFileSync(file, "utf8"));
  expect((await invoke(selected, "POST", { shippingFlatMinor: 100 })).status).toHaveBeenCalledWith(200);
  expect(await port.getShippingFlatMinor()).toBe(100);
});
