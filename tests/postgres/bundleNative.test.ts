/** Incumbent native subset only: no mounted parity or concurrency guarantee. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BUNDLE_MIGRATIONS, BundleCatalogReadError, createPostgresBundleCatalogStore } from "@openlup/platform/catalog";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, pool: Pool;
const actor = "c5000000-0000-4000-8000-000000000001";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const runner = () => createPostgresMigrationRunner({ connectionString: container!.connectionString }, { poolFactory: () => pool });
const executor = (db: Pool | PoolClient) => ({ query: (sql: string, values?: readonly unknown[]) => db.query(sql, values ? [...values] : undefined) });
const read = () => createPostgresBundleCatalogStore(executor(pool));
const components = [
  { sku: "UNIT-A", quantity: 2, is_addon: false, sort_order: 2 },
  { sku: "UNIT-B", quantity: 1, is_addon: true, sort_order: 1 },
];
const compose = async (code: string, value = components, mode = "commit", key: string | null = null, db: Pool | PoolClient = pool) =>
  (await db.query("SELECT public.admin_set_bundle_composition($1,$2,$3,$4,$5) AS result", [actor, code, JSON.stringify(value), mode, key])).rows[0].result;
const price = async (code: string, amount = 2001, mode = "commit", key: string | null = null) =>
  (await pool.query("SELECT public.admin_set_bundle_target_price($1,$2,'one_time',$3,'XXX','gross',$4,$5) AS result", [actor, code, amount, mode, key])).rows[0].result;
async function fixture(code: string) {
  await pool.query("SELECT public.admin_upsert_bundle_draft($1,$2,'Synthetic set','virtual')", [actor, code]);
  await compose(code);
  await price(code);
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for (const { tablename } of tables) {
    // Names come from the database catalogue, quoted as identifiers, never caller input.
    const name = '"' + String(tablename).replaceAll('"', '""') + '"';
    result[tablename] = (await pool.query(`SELECT to_jsonb(t) AS row FROM public.${name} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Bundle native proof requires real PostgreSQL");
  container = await runPostgresContainer({ name: `bundle-native-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Bundle PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  await runner().apply();
  const product = (await pool.query("INSERT INTO public.catalog_products(slug,name) VALUES ('synthetic-units','Synthetic units') RETURNING id")).rows[0].id;
  for (const sku of ["UNIT-A", "UNIT-B", "UNIT-U", "UNIT-Z", "UNIT-M"]) {
    await pool.query("INSERT INTO public.catalog_skus(product_id,sku,title,sellable_standalone) VALUES ($1,$2,$2,$3)", [product, sku, sku !== "UNIT-Z"]);
  }
  for (const currency of ["XXX", "YYY"]) {
    const list = (await pool.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES ('Synthetic list','ZZ',$1) RETURNING id", [currency])).rows[0].id;
    for (const [sku, amount] of currency === "XXX" ? [["UNIT-A", 1000], ["UNIT-B", 500]] as const : [["UNIT-M", 600]] as const)
      await pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) SELECT $1,id,$3 FROM public.catalog_skus WHERE sku=$2", [list, sku, amount]);
  }
}, 120_000);
afterAll(async () => { await pool?.end(); await container?.remove(); });

it("installs the full canonical chain, binds sparse 16/19 bytes and repeats without pending work", async () => {
  expect(BUNDLE_MIGRATIONS.map(unit => unit.position)).toEqual([16, 19]);
  for (const unit of BUNDLE_MIGRATIONS) {
    const bytes = readFileSync(unit.catalogPath);
    expect(unit.url.pathname.endsWith(`/sql/${unit.id}.sql`)).toBe(true);
    expect(readFileSync(unit.url)).toEqual(bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
    expect([manifest.baseline, ...manifest.forward][unit.position]).toEqual({ file: unit.catalogPath, sha256: unit.sha256 });
  }
  const history = (await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
  expect(history.map(({ catalog_path, sha256, position }) => ({ file: catalog_path, sha256, position }))).toEqual([manifest.baseline, ...manifest.forward].map((unit: { file: string; sha256: string }, position: number) => ({ ...unit, position })));
  expect((await pool.query("SELECT conname FROM pg_constraint WHERE conrelid IN ('public.catalog_bundles'::regclass,'public.catalog_bundle_components'::regclass,'public.catalog_bundle_prices'::regclass,'public.catalog_bundle_write_events'::regclass) AND NOT convalidated")).rows).toEqual([]);
  await runner().apply();
  expect((await runner().status()).pending).toEqual([]);
  expect((await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows).toEqual(history);
});
it("reads ordered complete composition, selected figures, feed and history without database writes", async () => {
  await fixture("READ-SET");
  await pool.query("SELECT public.admin_activate_bundle($1,'READ-SET')", [actor]);
  // The incumbent read retains an unpriced component; the writer refuses it after pricing.
  await pool.query("INSERT INTO public.catalog_bundle_components(bundle_id,catalog_sku_id,quantity,sort_order) SELECT b.id,s.id,1,3 FROM public.catalog_bundles b,public.catalog_skus s WHERE b.code='READ-SET' AND s.sku='UNIT-U'");
  await pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,min_qty,unit_price_minor,valid_from) SELECT price_list_id,variant_id,10,700,valid_from FROM public.price_entries WHERE variant_id=(SELECT id FROM public.catalog_skus WHERE sku='UNIT-A')");
  const initial = await snapshot();
  expect(await read().listBundles({ status: "active", query: "READ-", limit: 10, offset: 0 })).toMatchObject({ total: 1, bundles: [{ code: "READ-SET", componentCount: 3, hasActiveTargetPrice: true }] });
  const detail = await read().getBundle({ code: "READ-SET", currency: "XXX" });
  expect(detail).toMatchObject({ code: "READ-SET", resolvedCurrency: "XXX", compositionConstraint: null, prices: [{ targetPriceMinor: 2001, active: true }] });
  expect(detail!.components.map(({ sku, quantity, isAddon, referenceUnitPriceMinor }) => ({ sku, quantity, isAddon, referenceUnitPriceMinor }))).toEqual([
    { sku: "UNIT-B", quantity: 1, isAddon: true, referenceUnitPriceMinor: 500 },
    { sku: "UNIT-A", quantity: 2, isAddon: false, referenceUnitPriceMinor: 1000 },
    { sku: "UNIT-U", quantity: 1, isAddon: false, referenceUnitPriceMinor: null },
  ]);
  expect((await read().getBundle({ code: "READ-SET", mode: "one_time" }))!.components).toEqual(detail!.components);
  expect(await read().listActiveBundleCompositions({ currency: "XXX" })).toEqual([expect.objectContaining({ code: "READ-SET", targetPriceMinor: 2001, components: detail!.components })]);
  expect(await read().listActiveBundleCompositions({ currency: "YYY" })).toEqual([]);
  const history = await read().listBundleHistory({ code: "READ-SET", limit: 20, offset: 0 });
  expect(history.total).toBe(4);
  expect(history.events.map(event => event.action).sort()).toEqual(["bundle_activate", "bundle_composition_set", "bundle_draft_upsert", "bundle_target_price_set"]);
  for (const event of history.events) expect(event).toMatchObject({ actorKind: null, actorEmail: null, entityId: "READ-SET" });
  expect(await read().getBundle({ code: "ABSENT" })).toBeNull();
  // A real database permission failure is different from absence.
  await pool.query("CREATE ROLE bundle_read_denied NOLOGIN");
  const client = await pool.connect();
  try {
    await client.query("SET ROLE bundle_read_denied");
    await expect(createPostgresBundleCatalogStore(executor(client)).getBundle({ code: "ABSENT" })).rejects.toBeInstanceOf(BundleCatalogReadError);
  } finally { await client.query("RESET ROLE"); client.release(); }
  expect(await snapshot()).toEqual(initial);
});
it("replaces whole sets atomically, refuses invalid writes, preserves dry runs and appends price history", async () => {
  await fixture("WRITE-SET");
  const initial = await snapshot();
  for (const [value, code, message] of [
    [[], "P0001", "min_components"],
    [[components[0], components[0]], "P0001", "duplicate_component"],
    [[{ ...components[0], is_addon: true }], "P0001", "addon_only_composition"],
    [[{ ...components[0], sku: "ABSENT" }], "P0002", "component_not_found"],
    [[{ ...components[0], sku: "UNIT-Z" }], "P0001", "component_not_sellable"],
    [[{ ...components[0], sku: "UNIT-M" }], "P0001", "component_currency_mismatch"],
  ] as const) {
    await expect(compose("WRITE-SET", [...value])).rejects.toMatchObject({ code, message });
    expect(await snapshot()).toEqual(initial);
  }
  for (const [amount, message] of [[99999, "target_above_component_sum"], [0, "target_below_floor"]] as const)
    await expect(price("WRITE-SET", amount)).rejects.toMatchObject({ code: "P0001", message });
  expect(await compose("WRITE-SET", [components[0]], "dry_run")).toMatchObject({ dryRun: true, componentCount: 1 });
  expect(await price("WRITE-SET", 1800, "dry_run")).toMatchObject({ dryRun: true });
  expect(await snapshot()).toEqual(initial);
  // Failure after DELETE (table constraint during INSERT) rolls the entire statement back.
  await expect(compose("WRITE-SET", [{ ...components[0], quantity: 0 }])).rejects.toMatchObject({ code: "23514" });
  expect(await snapshot()).toEqual(initial);
  // An enclosing caller transaction also restores both composition and ledger.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await compose("WRITE-SET", [components[0]], "commit", null, client);
    await client.query("ROLLBACK");
  } finally { client.release(); }
  expect(await snapshot()).toEqual(initial);
  await compose("WRITE-SET", [components[0]]);
  expect((await read().getBundle({ code: "WRITE-SET" }))!.components.map(row => row.sku)).toEqual(["UNIT-A"]);
  await price("WRITE-SET", 1800);
  const prices = (await read().getBundle({ code: "WRITE-SET" }))!.prices;
  expect(prices).toHaveLength(2);
  expect(prices[0]).toMatchObject({ active: true, targetPriceMinor: 1800, validTo: null });
  expect(prices[1]).toMatchObject({ active: false, targetPriceMinor: 2001 });
  expect(prices[1].validTo).toEqual(prices[0].validFrom);
});
it("characterizes sequential same-key replay as incumbent recognition without duplicate ledger effects", async () => {
  await fixture("REPLAY-SET");
  expect(await compose("REPLAY-SET", [components[0]], "commit", "bundle-replay")).toEqual({ code: "REPLAY-SET", componentCount: 1, idempotent: false, dryRun: false });
  const initial = await snapshot();
  expect(await compose("REPLAY-SET", [components[0]], "commit", "bundle-replay")).toEqual({ code: "REPLAY-SET", idempotent: true, dryRun: false });
  // Recognition precedes payload/entity validation and is global across these routines.
  expect(await compose("ABSENT", [], "commit", "bundle-replay")).toEqual({ code: "ABSENT", idempotent: true, dryRun: false });
  expect(await price("ABSENT", 0, "commit", "bundle-replay")).toEqual({ code: "ABSENT", idempotent: true, dryRun: false });
  expect(await snapshot()).toEqual(initial);
  expect((await pool.query("SELECT count(*)::int AS count FROM public.catalog_bundle_write_events WHERE idempotency_key='bundle-replay'")).rows).toEqual([{ count: 1 }]);
});
it("denies ungranted access, requires invoker grants and characterizes the absence of a native actor-kind gate", async () => {
  await fixture("GRANT-SET");
  await pool.query("CREATE ROLE bundle_invoker NOLOGIN; CREATE ROLE bundle_acl_denied NOLOGIN");
  const client = await pool.connect();
  const activate = () => client.query("SELECT public.admin_activate_bundle($1,'GRANT-SET','commit',NULL,NULL,'machine')", [actor]);
  try {
    await client.query("SET ROLE bundle_invoker");
    for (const sql of ["SELECT * FROM public.catalog_bundles", "SELECT * FROM public.catalog_bundle_components", "SELECT * FROM public.catalog_bundle_prices", "SELECT * FROM public.catalog_bundle_write_events", "UPDATE public.catalog_bundles SET status='active'"])
      await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
    await expect(activate()).rejects.toMatchObject({ code: "42501" });
    await client.query("RESET ROLE");
    await client.query("GRANT EXECUTE ON FUNCTION public.admin_activate_bundle(uuid,text,text,text,text,text) TO bundle_invoker");
    await client.query("SET ROLE bundle_invoker");
    await expect(activate()).rejects.toMatchObject({ code: "42501" });
    await client.query("RESET ROLE");
    await client.query("GRANT SELECT ON public.catalog_bundles,public.catalog_bundle_components,public.catalog_bundle_prices TO bundle_invoker; GRANT UPDATE ON public.catalog_bundles TO bundle_invoker; GRANT INSERT ON public.catalog_bundle_write_events TO bundle_invoker");
    await client.query("SET ROLE bundle_invoker");
    // No actor registry or actor-kind argument: a non-null synthetic principal and
    // machine source are accepted. Human-only enforcement belongs to the handler.
    expect((await activate()).rows[0].admin_activate_bundle).toEqual({ code: "GRANT-SET", idempotent: false, dryRun: false });
    await expect(client.query("SELECT public.admin_deactivate_bundle($1,'GRANT-SET')", [actor])).rejects.toMatchObject({ code: "42501" });
    await client.query("RESET ROLE");
    const functions = (await client.query("SELECT proname,prosecdef,has_function_privilege('bundle_acl_denied',oid,'EXECUTE') AS public_execute FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('admin_upsert_bundle_draft','admin_set_bundle_composition','admin_set_bundle_target_price','admin_archive_bundle','admin_restore_bundle','admin_activate_bundle','admin_deactivate_bundle') ORDER BY proname")).rows;
    expect(functions).toHaveLength(7);
    for (const fn of functions) expect(fn).toMatchObject({ prosecdef: false, public_execute: false });
    expect((await client.query("SELECT principal_id,after_state->>'source' AS source FROM public.catalog_bundle_write_events WHERE bundle_code='GRANT-SET' AND action='bundle_activate'")).rows).toEqual([{ principal_id: actor, source: "machine" }]);
  } finally { await client.query("RESET ROLE"); client.release(); }
});
