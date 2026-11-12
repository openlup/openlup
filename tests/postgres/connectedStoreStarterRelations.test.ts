import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryConfig } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PostgresTransferError } from "@openlup/platform/portability";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
const at = "2026-09-01T00:00:00Z", closedAt = "2026-10-01T00:00:00Z";
const carried = ["catalog_sku_identifiers", "subscription_price_policy_revisions", "commerce_promotion_definitions"] as const;
const list = randomUUID(), skus = [randomUUID(), randomUUID()];
let source: JourneyInstallation, empty: JourneyInstallation, target: JourneyInstallation;
let packet: ConnectedNativeStoreCapture, emptyPacket: ConnectedNativeStoreCapture, freshTarget: ConnectedNativeStoreCapture;
let targetNumber = 0;

async function parents(store: JourneyInstallation) {
  for (const [index, sku] of skus.entries()) {
    await store.owner.query(`INSERT INTO public.catalog_products(id,slug,name,created_at,updated_at)
      VALUES($1,$2,'Synthetic product',$3,$3)`, [sku, `synthetic-product-${index}`, at]);
    await store.owner.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,created_at,updated_at)
      VALUES($1,$1,$2,'Synthetic SKU',$3,$3)`, [sku, `SYNTHETIC-${index}`, at]);
  }
  await store.owner.query(`INSERT INTO public.price_lists(id,name,region_code,currency,valid_from,created_at,updated_at)
    VALUES($1,'Synthetic prices','ZZ','XXX',$2,$2,$2)`, [list, at]);
}

beforeAll(async () => {
  source = await resources.installation("starter-source");
  empty = await resources.installation("starter-empty");
  await parents(source); await parents(empty);
  for (const [index, sku] of skus.entries()) await source.owner.query(`INSERT INTO public.catalog_sku_identifiers
    (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary,created_at)
    VALUES($1,'synthetic','gtin',$2,'unit',1,true,$3)`, [sku, `000000000000${index}`, at]);
  const first = randomUUID();
  await source.owner.query(`INSERT INTO public.subscription_price_policy_revisions
    (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,
      rounding_rule,effective_from,digest,created_at)
    VALUES($1,$2,'ZZ','XXX','D2C',1,500,10,'FLOOR_TO_QUANTUM',$3,$4,$3)`, [first, list, at, "a".repeat(64)]);
  await source.owner.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2 WHERE id=$1", [first, closedAt]);
  await source.owner.query(`INSERT INTO public.subscription_price_policy_revisions
    (price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,
      rounding_rule,effective_from,digest,created_at)
    VALUES($1,'ZZ','XXX','D2C',2,600,10,'FLOOR_TO_QUANTUM',$2,$3,$2)`, [list, closedAt, "b".repeat(64)]);
  for (const active of [true, false]) await source.owner.query(`INSERT INTO public.commerce_promotion_definitions
    (promotion_id,definition,active,created_at,updated_at)
    VALUES($1,pg_catalog.jsonb_build_object('id',$1::text,'status',$2::text,'trigger_type','automatic',
      'discount_type','percentage','applies_to_kind','order_total','stacking_rule','exclusive',
      'eligibility','{}'::jsonb,'applies_to_payload','{"amount":9007199254740993}'::jsonb,
      'region_availability','["ZZ"]'::jsonb),$3,$4,$4)`,
  [active ? "synthetic-active" : "synthetic-paused", active ? "active" : "paused", active, at]);
  // Definitions have no FK parent. Their incoming adjustment reference supplies
  // the missing-definition counterexample without inventing a parent contract.
  const clientId = randomUUID(), orderId = randomUUID(), db = await source.owner.connect();
  try {
    await db.query("BEGIN");
    await db.query("INSERT INTO public.clients(id,email,created_at,updated_at) VALUES($1,'synthetic@example.invalid',$2,$2)", [clientId, at]);
    await db.query(`INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,created_at,updated_at)
      VALUES($1,$2,'pending_payment','XXX',190,$3,$3)`, [orderId, clientId, at]);
    await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,sku_id,quantity,unit_amount_minor,line_amount_minor,created_at)
      VALUES($1,1,$2,2,95,190,$3)`, [orderId, skus[0], at]);
    await db.query(`INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint,created_at)
      SELECT $1,'promotion_discount','order_total',10,promotion_id,definition_fingerprint,$2
      FROM public.commerce_promotion_definitions WHERE promotion_id='synthetic-active'`, [orderId, at]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  packet = await captureStoreJourney(source.owner, "starter-relations-source");
  emptyPacket = await captureStoreJourney(empty.owner, "starter-relations-empty");
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  target = await resources.installation(`starter-target-${++targetNumber}`);
  freshTarget = await captureStoreJourney(target.owner, "starter-relations-target");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const restore = (captured = packet, owner = target.owner) => restoreConnectedNativeStore({
  owner, installation: journeySelection, packet: captured, freshTarget,
});

function observedOwner(observe: (sql: string, query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<void>,
  onError: (error: unknown) => void = () => undefined): Pool {
  return { async connect() {
    const client = await target.owner.connect();
    return { async query(sql: string | QueryConfig, values?: unknown[]) {
      const text = typeof sql === "string" ? sql : sql.text;
      await observe(text, statement => client.query(statement));
      try { return typeof sql === "string" ? await client.query(sql, values) : await client.query(sql); }
      catch (error) { onError(error); throw error; }
    }, release: (destroy?: boolean) => client.release(destroy) };
  } } as unknown as Pool;
}

// Each case bound is about 4x its slowest hosted run, rounded up to 5 s.
// Container installation keeps its separate deadline; cases never retry.
for (const table of carried) {
  it(`carries ${table} byte-exactly and replays without changing rows`, async () => {
    const before = await journeyCensus(source.owner);
    expect(before[table]).toHaveLength(2);
    expect(packet.owned.find(value => value.table === table)?.rows).toEqual(before[table]);
    const isolations: unknown[] = [];
    const owner = observedOwner(async (sql, query) => {
      if (sql.startsWith('INSERT INTO public."subscription_price_policy_revisions"')) {
        isolations.push((await query("SHOW transaction_isolation")).rows[0].transaction_isolation);
      }
    });
    expect(await restore(packet, owner)).toMatchObject({ replayed: false });
    expect(isolations).toEqual(["read committed", "read committed"]);
    expect(await journeyCensus(target.owner)).toEqual(before);
    expect(await restore()).toMatchObject({ replayed: true });
    expect(await journeyCensus(target.owner)).toEqual(before);
  }, 105_000);

  it(`refuses a broken ${table} reference in a distinct target and rolls back`, async () => {
    const pristine = await journeyCensus(target.owner);
    expect(packet.observation.cluster).not.toBe(freshTarget.observation.cluster);
    const corrupted = structuredClone(packet);
    const child = table === "commerce_promotion_definitions" ? "commerce_order_adjustments" : table;
    const field = table === "catalog_sku_identifiers" ? "catalog_sku_id"
      : table === "subscription_price_policy_revisions" ? "price_list_id" : "promotion_id";
    const missing = table === "commerce_promotion_definitions" ? "synthetic-missing" : randomUUID();
    const relation = corrupted.owned.find(value => value.table === child)!;
    const row = relation.rows[0], original = (JSON.parse(row) as Record<string, unknown>)[field];
    relation.rows[0] = row.replace(`"${field}": "${original}"`, `"${field}": "${missing}"`);
    expect(relation.rows[0]).not.toBe(row);
    const { sha256: _old, ...body } = corrupted;
    corrupted.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    let referenceError: unknown;
    const owner = observedOwner(async () => undefined, error => { referenceError = error; });
    await expect(restore(corrupted, owner)).rejects.toBeInstanceOf(PostgresTransferError);
    expect(referenceError).toMatchObject({ code: "23503", constraint: table === "catalog_sku_identifiers"
      ? "catalog_sku_identifiers_catalog_sku_id_fkey" : table === "subscription_price_policy_revisions"
        ? "subscription_price_policy_revisions_price_list_context_fkey" : "commerce_order_adjustments_promotion_id_fkey" });
    expect(await journeyCensus(target.owner)).toEqual(pristine);
  }, 70_000);

  it(`restores a store without ${table} unchanged`, async () => {
    const before = await journeyCensus(empty.owner);
    expect(before[table]).toEqual([]);
    expect(emptyPacket.owned.find(value => value.table === table)?.rows).toEqual([]);
    expect(await restore(emptyPacket)).toMatchObject({ replayed: false });
    expect(await journeyCensus(target.owner)).toEqual(before);
    expect(await restore(emptyPacket)).toMatchObject({ replayed: true });
    expect(await journeyCensus(target.owner)).toEqual(before);
  }, 105_000);
}
