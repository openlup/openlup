import { createHash, randomUUID } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { expect } from "vitest";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";

export const storageTables = [
  "commerce_order_tax_snapshots",
  "commerce_order_line_sources",
  "commerce_order_delivery_buckets",
  "commerce_order_line_allocations",
  "commerce_order_tax_positions",
  "commerce_order_fee_lines",
] as const;
export const [snapshots, sources, buckets, allocations, positions, fees] = storageTables;
export const version = "commerce.order-money.v2";
export const quoteKey = "commerce_order_money_v2_snapshots_accepted_quote_key";
export const calculationKey = "commerce_order_money_v2_snapshots_calculation_key";
export const orderFk = "commerce_orders_money_snapshot_fkey";
export const itemFk = "commerce_order_items_money_source_fkey";
export const headerFk = "commerce_order_delivery_buckets_header_fkey";

const errorKeys = ["length", "name", "message", "severity", "code", "detail", "hint", "position",
  "internalPosition", "internalQuery", "where", "schema", "table", "column", "dataType",
  "constraint", "file", "line", "routine"].sort();

export function expectSqlError(error: unknown, code: string, message: string, constraint?: string) {
  expect(error).toBeInstanceOf(DatabaseError);
  expect(Object.getPrototypeOf(error)).toBe(DatabaseError.prototype);
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort()).toStrictEqual(errorKeys);
  expect(error).toMatchObject({ code, message, constraint });
}

export const foreignKeyMessage = (table: string, key: string) =>
  `insert or update on table "${table}" violates foreign key constraint "${key}"`;
export const checkMessage = (table: string, key: string) =>
  `new row for relation "${table}" violates check constraint "${key}"`;
export const uniqueMessage = (key: string) => `duplicate key value violates unique constraint "${key}"`;
export const rejected = (query: Promise<unknown>) => query.then(() => undefined, (error: unknown) => error);
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>, finish = "COMMIT"): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const value = await work(db);
    await db.query(finish);
    return value;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}

export function capture(pool: Pool, catalogueId: string, sourceId: string) {
  return captureConnectedNativeStore({
    sourceId, catalogueId, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { withSnapshot: work => transaction(pool, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return work({ query: (sql, values) => db.query(sql, values ? [...values] : undefined) });
    }) },
  });
}

type Queryable = Pool | PoolClient;
export async function insert(db: Queryable, table: string, row: Record<string, unknown>) {
  // All identifiers in these fixtures are authored constants. Values are bound.
  const columns = Object.keys(row);
  await db.query(`INSERT INTO public.${table} (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(row));
}

export const orderTable = "commerce_orders";
export const itemTable = "commerce_order_items";
export const bucketKey = "delivery";
export const lineKey = "article";
const hex = "a".repeat(64);

export async function seedSku(db: Queryable) {
  const id = randomUUID();
  const sku = `article-${id}`;
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Article')", [id, sku]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Article')", [id, sku]);
  const list = (await db.query<{ id: string }>(
    "INSERT INTO public.price_lists(name,region_code,currency) VALUES('Example','ZZ','XXX') RETURNING id")).rows[0]!.id;
  await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,mode) VALUES($1,$2,100,'one_time')", [list, id]);
  return { id, sku };
}

export async function seedPrivateFacts(db: PoolClient, sku: Awaited<ReturnType<typeof seedSku>>, erased = false) {
  const orderId = randomUUID(), calculationId = randomUUID(), quoteId = randomUUID(), adjustmentId = randomUUID();
  const at = (await db.query<{ at: string; until: string }>(
    "SELECT now()::text AS at, (now()+interval '1 day')::text AS until")).rows[0]!;
  const snapshot = {
    order_id: orderId, calculation_id: calculationId, accepted_quote_id: quoteId,
    destination_snapshot_ref: randomUUID(), accepted_quote_digest: hex, token_digest: hex,
    accepted_money_digest: hex, evidence_digest: hex, coverage_digest: hex,
    destination_digest: erased ? null : hex, destination_policy_revision: erased ? null : "policy",
    delivery_selection_ref: erased ? null : "selection", destination_erased: erased, acceptance_ref: "acceptance",
    price_list_ref: "list", price_context_digest: hex, price_evidence_ref: "price", class_map_revision: "class-map",
    catalogue_evidence_ref: "catalogue", limit_profile_ref: "limits", limit_channel_key: "channel",
    money_version: version, amount_basis: "exclusive", currency: "XXX", mode: "one_time", promotion_engine: "promotion-engine.v1",
    tax_date: at.at, evaluation_expires_at: at.until, limit_revision: 1, limit_min_minor: 0, limit_max_minor: 1000,
    net_total: 100, tax_total: 0, fee_total: 3, payable_minor: 103,
  };
  const component = { pre_discount_minor: 100, effective_minor: 100, net_minor: 100, tax_minor: 0 };
  const source = { order_id: orderId, sku_id: sku.id, line_key: lineKey, tax_class_key: "class",
    assignment_ref: "assignment", sku_code: sku.sku, mode: "one_time", source_ordinal: 1, source_rank: 1,
    quantity: 1, unit_basis_minor: 100, ...component };
  const header = { order_id: orderId, bucket_key: bucketKey, part_no: 0, bucket_rank: 1,
    tax_class_key: "class", assignment_ref: "assignment", cost_ref: "cost", kind: "shipping", cost_currency: "XXX",
    separately_stated: true, cost_amount_minor: 0, destination_erased: erased,
    carrier_ref: erased ? null : "carrier", service_ref: erased ? null : "service" };
  const part = { order_id: orderId, bucket_key: bucketKey, part_no: 1, source_ordinal: 1,
    pre_discount_minor: 1, effective_minor: 0, net_minor: 0, tax_minor: 0 };
  const allocation = { order_id: orderId, allocation_id: randomUUID(), adjustment_id: adjustmentId,
    line_key: lineKey, adjustment_ref: "discount", evidence_ref: "rule", sequence: 1,
    basis_reduction_minor: 1, net_reduction_minor: 0, tax_reduction_minor: 0,
    before_basis_minor: 100, before_net_minor: 100, before_tax_minor: 0,
    after_basis_minor: 99, after_net_minor: 100, after_tax_minor: 0 };
  const deliveryAllocation = { ...allocation, allocation_id: randomUUID(), line_key: null, bucket_key: bucketKey,
    part_no: 1, before_basis_minor: 1, before_net_minor: 0, after_basis_minor: 0, after_net_minor: 0 };
  const position = { order_id: orderId, position_ref: "position", line_key: lineKey, rule_ref: "rule",
    assignment_ref: "assignment", policy_revision: "policy", resolution_source_ref: "resolution",
    resolution_digest: hex, jurisdiction_ref: "district", taxability_reason: "registered",
    state_side: "final", level: "district", tax_kind: "sales", rate_decimal: "0",
    allocation_slot: 0, position_rank: 1, effective_from: at.at, taxable_minor: 100, tax_minor: 0 };
  const fee = { order_id: orderId, fee_key: "fee", jurisdiction_ref: "district", fee_kind: "processing",
    scope_kind: "delivery", bucket_key: bucketKey, bucket_part_no: 0, fee_rank: 1,
    refund_rule_ref: "refund", refund_rule_revision: "one", amount_minor: 3 };

  // Deferred links permit the order and source to precede the snapshot and a part to precede its header.
  // The incumbent deferred sum still runs on every order in this schema.
  await insert(db, orderTable, { id: orderId, money_version: version, currency_code: "XXX", total_amount_minor: 101 });
  await insert(db, sources, source);
  await insert(db, itemTable, { order_id: orderId, sku_id: sku.id, line_ordinal: 1, quantity: 1,
    unit_amount_minor: 100, line_amount_minor: 100, line_key: lineKey });
  await insert(db, "tax_calculations", { calculation_id: calculationId, state: "erased" });
  await insert(db, snapshots, snapshot);
  await insert(db, buckets, part);
  await insert(db, buckets, header);
  await insert(db, "commerce_order_adjustments", { id: adjustmentId, order_id: orderId, kind: "shipping_charge",
    scope: "shipping", amount_minor: 1 });
  await insert(db, allocations, allocation);
  await insert(db, allocations, deliveryAllocation);
  await insert(db, positions, position);
  await insert(db, positions, { ...position, state_side: "before", allocation_slot: 1, allocation_id: allocation.allocation_id });
  await insert(db, positions, { ...position, position_ref: "part-position", state_side: "after", allocation_slot: 1,
    allocation_id: deliveryAllocation.allocation_id, line_key: null, bucket_key: bucketKey, part_no: 1 });
  await insert(db, fees, fee);
  return { orderId, calculationId, quoteId, snapshot, source, header, part, allocation, deliveryAllocation, position, fee };
}
