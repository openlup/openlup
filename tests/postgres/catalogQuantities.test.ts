import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { backfillCatalogNetContent } from "@openlup/platform/catalog";
import { createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const path = "db/platform/migrations/20261122110000_catalog_quantities.sql";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const containers: PostgresContainer[] = [], pools: Pool[] = [];
const ids = Array.from({ length: 4 }, () => randomUUID()).sort();
let owner: Pool, runtime: Pool, product: string;
const skus = async () => (await owner.query("SELECT to_jsonb(s)::text AS row FROM public.catalog_skus s ORDER BY id")).rows;
const agreements = async () => (await owner.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.subscriptions s) AS subscriptions,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.subscription_lines l) AS lines,
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.subscription_cycles c) AS cycles,
  (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.subscription_renewal_operations o) AS operations`)).rows;
let beforeAgreements: Awaited<ReturnType<typeof agreements>>;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Catalogue quantity witnesses require real PostgreSQL");
  const container = await runPostgresContainer({ name: `catalog-quantities-${process.pid}`, password: "synthetic-catalogue" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue PostgreSQL unavailable");
  const bootstrap = new Pool({ connectionString: container.connectionString }); pools.push(bootstrap);
  await bootstrap.query("CREATE ROLE catalog_install LOGIN SUPERUSER PASSWORD 'synthetic-catalogue'; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; ALTER DATABASE postgres OWNER TO catalog_install");
  const url = new URL(container.connectionString); url.username = "catalog_install";
  owner = new Pool({ connectionString: url.toString() }); pools.push(owner);
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    if (unit.file === path) break;
    await owner.query(readFileSync(unit.file, "utf8"));
  }
  product = (await owner.query("INSERT INTO public.catalog_products(slug,name) VALUES('quantity-item','Synthetic item') RETURNING id")).rows[0].id;
  for (const [index, grams] of [0, 100, 2147483647, 77].entries()) {
    await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,net_weight_g) VALUES($1,$2,$3,'Synthetic SKU',$4)",
      [ids[index], product, `QUANTITY-${index}`, grams]);
  }
  const client = (await owner.query("INSERT INTO public.clients(email) VALUES('quantity@example.invalid') RETURNING id")).rows[0].id;
  const subscription = (await owner.query("INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at) VALUES($1,28,clock_timestamp()+interval '28 days') RETURNING id", [client])).rows[0].id;
  await owner.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,2,0,137,'XXX')", [subscription, ids[1]]);
  beforeAgreements = await agreements();
  await owner.query(readFileSync(path, "utf8"));
  expect(await agreements()).toEqual(beforeAgreements);
  // No migration-time data backfill; existing content below must also survive the driver.
  expect((await owner.query("SELECT net_content_dimension FROM public.catalog_skus")).rows.every(row => row.net_content_dimension === null)).toBe(true);
  await owner.query("UPDATE public.catalog_skus SET net_content_dimension='count',net_content_unscaled=60,net_content_scale=0,net_content_unit='openlup:piece' WHERE id=$1", [ids[3]]);
  await owner.query("CREATE ROLE catalog_runtime LOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS PASSWORD 'synthetic-catalogue'; GRANT service_role TO catalog_runtime WITH INHERIT TRUE, SET TRUE");
  url.username = "catalog_runtime"; runtime = new Pool({ connectionString: url.toString() }); pools.push(runtime);
  await bootstrap.query("ALTER ROLE catalog_install NOSUPERUSER NOBYPASSRLS");
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

it("catalog_unknown_legacy_weight_is_not_zero_content", async () => {
  const existing = (await owner.query("SELECT to_jsonb(s)::text AS row FROM public.catalog_skus s WHERE id=$1", [ids[3]])).rows;
  const commerce = await owner.connect();
  try {
    await commerce.query("BEGIN");
    await commerce.query("SELECT id FROM public.catalog_skus WHERE id=$1 FOR KEY SHARE", [ids[1]]);
    let calls = 0;
    await expect(backfillCatalogNetContent({ query: async (text, values) => {
      if (++calls === 2) throw new Error("synthetic_install_interruption");
      return owner.query(text, values);
    } }, { batchSize: 1 })).rejects.toThrow("synthetic_install_interruption");
    expect((await owner.query("SELECT id,net_content_unscaled::text AS coefficient FROM public.catalog_skus WHERE id=ANY($1) ORDER BY id", [ids.slice(1, 3)])).rows)
      .toEqual([{ id: ids[1], coefficient: "100" }, { id: ids[2], coefficient: null }]);
  } finally { await commerce.query("ROLLBACK"); commerce.release(); }
  // Independent callers can overlap without acquiring exclusive catalogue key locks.
  await Promise.all([backfillCatalogNetContent(owner, { batchSize: 1 }), backfillCatalogNetContent(owner, { batchSize: 1 })]);
  expect((await owner.query(`SELECT id,net_weight_g,net_content_dimension,net_content_unscaled::text AS coefficient,
    net_content_scale,net_content_unit FROM public.catalog_skus WHERE id=ANY($1) ORDER BY id`, [ids.slice(0, 3)])).rows)
    .toEqual([
      { id: ids[0], net_weight_g: 0, net_content_dimension: null, coefficient: null, net_content_scale: null, net_content_unit: null },
      { id: ids[1], net_weight_g: 100, net_content_dimension: "mass", coefficient: "100", net_content_scale: 0, net_content_unit: "openlup:g" },
      { id: ids[2], net_weight_g: 2147483647, net_content_dimension: "mass", coefficient: "2147483647", net_content_scale: 0, net_content_unit: "openlup:g" },
    ]);
  expect((await owner.query("SELECT to_jsonb(s)::text AS row FROM public.catalog_skus s WHERE id=$1", [ids[3]])).rows).toEqual(existing);
  const completed = await skus();
  await backfillCatalogNetContent(owner, { batchSize: 1 });
  expect(await skus()).toEqual(completed);
  expect(await agreements()).toEqual(beforeAgreements);
});

it("catalog_gross_mass_is_not_inferred", async () => {
  await owner.query("UPDATE public.catalog_skus SET net_content_dimension='volume',net_content_unscaled=50,net_content_scale=0,net_content_unit='openlup:ml' WHERE id=$1", [ids[0]]);
  await backfillCatalogNetContent(owner, { batchSize: 2 });
  expect((await owner.query("SELECT gross_mass_dimension,gross_mass_unscaled,gross_mass_scale,gross_mass_unit FROM public.catalog_skus")).rows)
    .toEqual(ids.map(() => ({ gross_mass_dimension: null, gross_mass_unscaled: null, gross_mass_scale: null, gross_mass_unit: null })));
});

it("catalog_quantity_backfill_is_install_role_only", async () => {
  expect((await owner.query(`SELECT p.proowner=current_user::regrole AS owned,p.prosecdef,p.proconfig,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
    has_function_privilege('catalog_runtime',p.oid,'EXECUTE') AS runtime_execute
    FROM pg_proc p WHERE p.oid='public.catalog_net_content_backfill_batch(integer)'::regprocedure`)).rows)
    .toEqual([{ owned: true, prosecdef: false, proconfig: ["search_path=pg_catalog"], anon_execute: false,
      authenticated_execute: false, service_execute: false, runtime_execute: false }]);
  expect((await owner.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ rolsuper: false, rolbypassrls: false }]);
  await expect(backfillCatalogNetContent(runtime, { batchSize: 1 })).rejects.toMatchObject({ code: "42501" });
  for (const batchSize of [0, -1, 1.5, 2147483648]) await expect(backfillCatalogNetContent(owner, { batchSize })).rejects.toThrow("invalid_catalog_backfill_batch_size");
  for (const size of [null, 0, -1]) await expect(owner.query("SELECT public.catalog_net_content_backfill_batch($1)", [size])).rejects.toMatchObject({ code: "22023" });
});

const complete = ["mass", "123", 0, "example:custom-unit"];
const refusals = [
  ...Array.from({ length: 4 }, (_, missing) => ({ name: `partial group missing ${missing}`, value: complete.map((value, index) => index === missing ? null : value) })),
  { name: "zero", value: ["mass", "0", 0, "example:custom-unit"] },
  { name: "negative", value: ["mass", "-1", 0, "example:custom-unit"] },
  { name: "negative scale", value: ["mass", "1", -1, "example:custom-unit"] },
  { name: "scale above twelve", value: ["mass", "1", 13, "example:custom-unit"] },
  { name: "unknown dimension", value: ["length", "1", 0, "example:custom-unit"] },
];
for (const group of ["net_content", "gross_mass"]) {
  it.each([...refusals, ...(group === "gross_mass" ? ["volume", "count"].map(dimension => ({ name: `wrong gross dimension ${dimension}`, value: [dimension, "1", 0, "example:custom-unit"] })) : [])])(
    `catalog_quantity_check_refuses_${group}: $name`, async ({ value }) => {
      await expect(owner.query(`UPDATE public.catalog_skus SET ${group}_dimension=$1,${group}_unscaled=$2,${group}_scale=$3,${group}_unit=$4 WHERE id=$5`, [...value, ids[0]]))
        .rejects.toMatchObject({ code: "23514", constraint: `catalog_skus_${group}_check` });
    });
}

it("catalog_quantity_storage_preserves_decimal_strings_and_defers_unit_admission", async () => {
  const coefficient = "9".repeat(40);
  await owner.query("UPDATE public.catalog_skus SET net_content_dimension='volume',net_content_unscaled=$1,net_content_scale=12,net_content_unit='example:custom-volume',gross_mass_dimension='mass',gross_mass_unscaled=$1,gross_mass_scale=12,gross_mass_unit='example:custom-mass' WHERE id=$2", [coefficient, ids[0]]);
  expect((await owner.query("SELECT net_content_unscaled,gross_mass_unscaled FROM public.catalog_skus WHERE id=$1", [ids[0]])).rows)
    .toEqual([{ net_content_unscaled: coefficient, gross_mass_unscaled: coefficient }]);
  for (const group of ["net_content", "gross_mass"]) await expect(owner.query(`UPDATE public.catalog_skus SET ${group}_unscaled=$1 WHERE id=$2`, ["1".repeat(41), ids[0]]))
    .rejects.toMatchObject({ code: "22003" });
});

it("inventory_reserves_packs_not_contents", async () => {
  const skuId = randomUUID(), subscription = randomUUID(), source = randomUUID(), sku = `PACK-${skuId}`;
  const at = (await owner.query("SELECT clock_timestamp()::text AS at")).rows[0].at;
  const client = (await owner.query("INSERT INTO public.clients(email) VALUES($1) RETURNING id", [`${subscription}@example.invalid`])).rows[0].id;
  await owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)", [subscription, client, at]);
  await owner.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,net_content_dimension,net_content_unscaled,net_content_scale,net_content_unit,
    gross_mass_dimension,gross_mass_unscaled,gross_mass_scale,gross_mass_unit) VALUES($1,$2,$3,'Pack of sixty','count',60,0,'openlup:piece','mass',200,0,'openlup:g')`, [skuId, product, sku]);
  await owner.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES($1,$2,10,10,0,'sellable',$3::timestamptz,$3::timestamptz+interval '1 day','synthetic',$1,$4)`, [source, sku, at, "a".repeat(64)]);
  const snapshot = { contractVersion: "platform.subscription.renewal.v1", subscriptionId: subscription, scheduledAt: at, cycleNumber: 2,
    currency: "XXX", stockSourceKey: source, totalAmountMinor: 274, lines: [{ sku, quantity: 2 }] };
  const identity = (await owner.query("SELECT public.subscription_renewal_identity($1,$2) AS key", [subscription, at])).rows[0].key;
  const operation = (await owner.query("SELECT public.subscription_claim_due_renewal($1,$2,$3,'synthetic',300,$4) AS result", [identity, "b".repeat(64), snapshot, at])).rows[0].result;
  const input = { operationId: operation.operationId, claimToken: operation.claimToken, now: at, holdSeconds: 60 };
  const reservation = createPostgresRenewalReservationPort(owner);
  const before = await agreements();
  const held = await reservation.reserve(input);
  expect(held).toMatchObject({ status: "held", reserved: true, replayed: false });
  expect((await owner.query(`SELECT l.sku,l.quantity FROM public.fulfillment_inventory_reservation_lines l
    JOIN public.fulfillment_inventory_reservations r ON r.id=l.reservation_id WHERE r.renewal_operation_id=$1`, [input.operationId])).rows)
    .toEqual([{ sku, quantity: 2 }]);
  expect(await reservation.reserve(input)).toMatchObject({ reservationId: held.reservationId, replayed: true });
  expect(await agreements()).toEqual(before);
});
