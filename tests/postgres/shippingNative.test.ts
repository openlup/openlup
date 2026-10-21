import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { checkReadiness, createSchemaProbe, type ReadinessReport } from "@openlup/core/readiness";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { createM06ShippingReferenceBinding } from "../../server/runtime/public-reference/m06ShippingBinding.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const scratch = "/private/tmp/claude-501/m06-grant/";
const file = "db/platform/migrations/20261021120000_shipping_flat_rate_seed.sql";
const version = "20261021120000_shipping_flat_rate_seed";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const containers: PostgresContainer[] = [], pools: Pool[] = [];
const bindings: ReturnType<typeof createM06ShippingReferenceBinding>[] = [];
let prefix: string, beforeAcl: unknown, oldReadiness: ReadinessReport;
const runner = (pool: Pool, root = process.cwd()) => createPostgresMigrationRunner({ connectionString: "injected" }, { root, poolFactory: () => pool });
function binding(index: number, nativeRateReadiness?: ReadinessReport) {
  const result = createM06ShippingReferenceBinding({
    store: { dataKind: "postgres", nativeRateReadiness },
    nativeRate: { env: { connectionString: containers[index].connectionString } },
    version: "0.18.0", requiredSchema: { version, migration: file, objects: [] },
    rate: { authorizeAdmin: async () => ({ ok: true, userId: "f6000000-0000-4000-8000-000000000001", role: "admin", isMachineActor: false }) },
  });
  bindings.push(result); return result;
}
async function readiness(index: number) {
  const requiredSchema = binding(index).contributions[0].manifest.requiredSchema!;
  return checkReadiness({
    candidate: { artifact: "synthetic", configuration: "shipping", environment: "disposable", database: "synthetic", schema: version }, inventoryComplete: true,
    loadedPackages: [{ name: "@openlup/core", version: "0.18.0", kind: "kernel" }, { name: "@openlup/platform", version: "0.18.0", kind: "rail" }],
    contributions: [{ manifest: { name: "@openlup/platform", version: "0.18.0", kind: "rail", emits: [], handles: [], schedules: [], routes: [], env: [], requiredPorts: [], requiredSchema }, handlers: [], schedules: [], routes: [] }],
    bindings: { ports: {}, triggers: {}, routes: {}, env: {} }, vocabulary: [], exemptions: [],
    schemaProbe: createSchemaProbe(pools[index], async () => ({ database: "synthetic", version: (await pools[index].query("SELECT catalog_path FROM public.platform_schema_migrations ORDER BY position DESC LIMIT 1")).rows[0].catalog_path === file ? version : "position-70" })),
  });
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
  expect(manifest.forward).toHaveLength(71); expect(manifest.forward.at(-1).file).toBe(file);
  mkdirSync(scratch, { recursive: true }); prefix = mkdtempSync(join(scratch, "prefix-"));
  const previous = { ...manifest, forward: manifest.forward.slice(0, -1) };
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
}, 120_000);
afterAll(async () => {
  await Promise.all(bindings.map(value => value.close())); await Promise.all(pools.map(pool => pool.end()));
  await Promise.all(containers.map(container => container.remove())); if (prefix) rmSync(prefix, { recursive: true, force: true });
});
it("fresh full portable installation seeds and saves through the reference binding", async () => {
  expect((await pools[0].query("SELECT value_minor FROM public.commerce_settings WHERE key='shipping_flat_minor'")).rows).toEqual([{ value_minor: 0 }]);
  const ready = await readiness(0); expect(ready.state).toBe("ready");
  const selected = binding(0, ready); expect(selected.unsupported.flatRateSave).toBeNull();
  expect((await invoke(selected, "POST", { shippingFlatMinor: 725 })).status).toHaveBeenCalledWith(200);
  expect((await invoke(selected, "GET")).json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ shippingFlatMinor: 725 }) }));
});
it("upgrades the exact position-70 prefix without replacing an existing nonzero rate and replays the exact ledger", async () => {
  expect((await runner(pools[1]).apply()).applied).toEqual([file]);
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
  expect(oldReadiness.state).toBe("unsatisfied");
  const old = binding(1, oldReadiness);
  expect(old.readiness.reason).toBe("shipping_native_flat_rate_save_unsupported"); expect(old.handlers.rate).toBeNull();
  const selected = binding(1, await readiness(1)); expect(selected.readiness.ready).toBe(true);
  expect((await invoke(selected, "POST", { shippingFlatMinor: 900 })).status).toHaveBeenCalledWith(200);
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
  expect(await acl(pools[1])).toEqual(beforeAcl);
});
it("refuses a missing row by name and keeps unsupported audit failure nonblocking after a real save", async () => {
  const selected = binding(0, await readiness(0));
  const port = selected.store.shippingRateDataPort!;
  await expect(port.recordPromotionAudit({ actorId: "synthetic", actorEmail: null, action: "shipping_rate_change", promotionId: "shipping_flat_minor", newValue: { shippingFlatMinor: 100 } })).rejects.toThrow("shipping_native_flat_rate_audit_unsupported");
  await pools[0].query("DELETE FROM public.commerce_settings WHERE key='shipping_flat_minor'");
  await expect(port.setShippingFlatMinor(100)).rejects.toThrow("shipping_native_flat_rate_row_required");
  expect((await invoke(selected, "POST", { shippingFlatMinor: 100 })).status).toHaveBeenCalledWith(503);
  await pools[0].query(readFileSync(file, "utf8"));
  expect((await invoke(selected, "POST", { shippingFlatMinor: 100 })).status).toHaveBeenCalledWith(200);
  expect(await port.getShippingFlatMinor()).toBe(100);
});
