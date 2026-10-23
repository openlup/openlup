import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createInventoryContribution } from "@openlup/platform/composition";
import type { ActiveBundleComposition } from "@openlup/platform/catalog";
import { createM06InventoryReferenceBinding } from "../../../server/runtime/public-reference/m06InventoryBinding.js";
import { createPostgresMigrationRunner } from "../../../server/adapters/postgres/migrationRunner.js";
import { assertConsumerIsolation } from "../../../scripts/packages/platform-cold-consumer.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../../helpers/postgresContainer.js";

let installedResolve: (name: string) => string;
let scratch: string, container: PostgresContainer | undefined, pool: Pool;
let inventory: typeof import("@openlup/platform/inventory"), composition: typeof import("@openlup/platform/composition");
const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, stdio: "pipe", timeout: 120_000 }).toString();
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "m06-packed-"));
  const tarballs = ["packages/core", "packages/platform", "node_modules/zod"].map(directory => {
    const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], resolve(directory)));
    return join(scratch, packed[0].filename);
  });
  const consumer = join(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
  npm(["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--omit=optional", "--no-audit", "--no-fund", ...tarballs], consumer);
  assertConsumerIsolation(consumer, process.cwd());
  installedResolve = createRequire(join(consumer, "package.json")).resolve;
  inventory = await import(pathToFileURL(installedResolve("@openlup/platform/inventory")).href);
  composition = await import(pathToFileURL(installedResolve("@openlup/platform/composition")).href);
  if (!await dockerAvailable()) throw new Error("Installed inventory proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `inventory-consumer-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Installed inventory PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { poolFactory: () => pool }).apply();
  await pool.query(`INSERT INTO public.catalog_products(id,slug,name) VALUES ('f5000000-0000-4000-8000-000000000001','installed-stock','Fixture');
    INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES ('f5000000-0000-4000-8000-000000000002','f5000000-0000-4000-8000-000000000001','INSTALLED','Fixture');
    INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES ('fixture','INSTALLED',8,8,0,'sellable',now(),now()+interval '1 hour','fixture','installed-stock',repeat('a',64))`);
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, pool); if (scratch) rmSync(scratch, { recursive: true, force: true }); }, postgresTeardownTimeoutMs);

it("reads the actual native store from an isolated tarball with exact SQL projection identities", async () => {
  const bindings = inventory.createInventoryBindings({ dataKind: "postgres", executor: pool, provider: { stockMasterProvider: "fixture", providerSchema: z.literal("fixture") } });
  expect(bindings.readiness.ready).toBe(true);
  expect(await bindings.readPort!.listStock({ page: 1, pageSize: 10, includeZero: true })).toMatchObject({ contractVersion: "inventory.v0", stock: [{ sku: "INSTALLED", onHand: 8, reserved: 0, availableNow: 8 }], totalCount: 1 });
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of inventory.INVENTORY_MIGRATIONS) {
    const bytes = readFileSync(unit.url);
    expect(bytes).toEqual(readFileSync(unit.catalogPath));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
    expect([manifest.baseline, ...manifest.forward][unit.position]).toEqual({ file: unit.catalogPath, sha256: unit.sha256 });
    expect((await pool.query("SELECT sha256 FROM public.platform_schema_migrations WHERE position=$1", [unit.position])).rows).toEqual([{ sha256: unit.sha256 }]);
  }
  const declared = composition.createInventoryContribution({ version: "0.17.0", requiredSchema: { version: "complete", migration: "complete", objects: [] }, inventory: { listStock: bindings.readPort!.listStock }, routes: [] });
  expect(declared.ports["@openlup/platform/inventory:listStock"]).toBe(bindings.readPort!.listStock);
  expect(Object.keys(createInventoryContribution({ version: "0.17.0", requiredSchema: { version: "complete", migration: "complete", objects: [] }, inventory: { absent: null }, routes: [] }).ports)).toEqual([]);
});

it("composes installed normalized stock into catalog bundles and refuses the unsupported native reader", async () => {
  const native = inventory.createInventoryBindings({ dataKind: "postgres", executor: pool, provider: { stockMasterProvider: "fixture", providerSchema: z.literal("fixture") }, newPurchaseStockReadPort: { read: async () => { throw new Error("must_not_run"); } } });
  expect(native.newPurchaseStockReadPort).toBeNull();
  expect(native.unsupported.newPurchaseStockRead).toBe("inventory_native_new_purchase_stock_read_unsupported");
  await expect(native.mutationPort!.adjustStock({} as never)).rejects.toThrow("Direct stock is externally observed");
  const projected = inventory.createNewPurchaseStockAvailabilityPort({ readPort: { read: async () => new Map([["UNIT", { sku: "UNIT", catalogSkuId: null, source: "local", providerForSale: null, activeHolds: 0, safetyStock: 0, available: 12, stale: false, renewalDemand: 2, availableForNewPurchases: 10, excludedOrderHolds: 0 }]]) }, functionMissingFallback: null, functionMissingError: "missing", defaultLowStockThreshold: 1, defaultHorizonDays: 60, observe: { warn() {} }, deriveOfferAvailability: input => ({ ...input, status: "available", visibleInConfigurator: true, reasonCode: "stock_available" }) }, { mode: "new_purchase" });
  const reference = createM06InventoryReferenceBinding({ store: { dataKind: "supabase", createManagedStore: () => ({ readPort: native.readPort!, mutationPort: native.mutationPort! }), newPurchaseStockReadPort: { read: async () => new Map() } }, version: "0.17.0", requiredSchema: { version: "complete", migration: "complete", objects: [] }, bundleCatalogReadPort: {} as never,
    stock: { functionMissingFallback: null, functionMissingError: "missing", defaultLowStockThreshold: 1, defaultHorizonDays: 60, observe: { warn() {} } }, options: { mode: "new_purchase" } });
  expect(reference.stock).not.toBeNull();
  const compositions: ActiveBundleComposition[] = [{ code: "SET", title: "Fixture", fulfillmentMode: "manual", currency: "XTS", targetPriceMinor: 100, mode: "one_time", components: [{ sku: "UNIT", title: null, quantity: 2, isAddon: false, productSlug: "unit", variantId: "unit", sortOrder: 0, referenceUnitPriceMinor: 50 }] }];
  expect((await reference.availability!.describeCompositions(compositions))[0].availability).toMatchObject({ status: "unknown", sellableNow: null });
  await expect(reference.readPort!.forecastSubscriptions({ horizonDays: 60, protectionDays: 45 })).rejects.toThrow();
  // The installed catalog consumes the installed projection; the reader is an injected fixture, not native SQL.
  const catalog = await import(pathToFileURL(installedResolve("@openlup/platform/catalog")).href) as typeof import("@openlup/platform/catalog");
  const { deriveBundleAvailability } = catalog.createBundleAvailability({ offerAvailabilityStatusFor: value => value === null ? "unknown" : value > 0 ? "available" : "out_of_stock", offerAvailabilityReasonCode: status => status });
  const service = catalog.createBundleAvailabilityServices({ deriveBundleAvailability }).createBundleAvailabilityService({ bundleCatalogReadPort: {} as never, offerAvailabilityPort: projected });
  const rows = await service.describeCompositions(compositions);
  expect(rows[0].availability).toMatchObject({ sellableNow: 5, status: "available", limitingSku: "UNIT" });
});
