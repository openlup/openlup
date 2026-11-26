import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isCatalogueMoneyV2RateDecimal } from "@openlup/core/pricing";
import { captureCompatiblePostgresRows, PostgresTransferError } from "@openlup/platform/portability";
import { commerceQuoteV2Schema, quoteDigest, type CommerceQuoteMoneyV2 } from "@openlup/platform/pricing";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutations, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import {
  allocations, buckets, calculationKey, capture, checkMessage, digest, expectSqlError, fees, foreignKeyMessage,
  headerFk, insert, itemFk, itemTable, lineKey, orderFk, orderTable, positions, quoteKey, rejected, seedPrivateFacts,
  seedSku, snapshots, sources, storageTables, transaction, uniqueMessage, version,
} from "./orderMoneyV2Storage.fixture.js";

const restoreFixture = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock(import("../../scripts/platform-migration-manifest.js"), async original => {
  const catalogue = await original();
  return {
    ...catalogue,
    readPlatformMigrationManifest: (root: string) => catalogue.readPlatformMigrationManifest(restoreFixture.root ?? root),
    readPlatformMigrations: (root: string) => catalogue.readPlatformMigrations(restoreFixture.root ?? root),
  };
});

vi.mock("../../server/adapters/postgres/connectedStoreDomains/index.js", async original => {
  const registry = await original<typeof import("../../server/adapters/postgres/connectedStoreDomains/index.js")>();
  // These relations were introduced by the renewal v3 forward after the storage boundary.
  const renewalV3Tables = new Set([
    "subscription_cycle_occurrences", "subscription_cycle_generations",
    "subscription_cycle_delivery_assignments", "subscription_cycle_delivery_evidence",
    "subscription_cycle_stock_holds", "subscription_cycle_tax_issuances", "subscription_cycle_tax_bindings",
    "subscription_cycle_cases", "subscription_cycle_preparations", "subscription_cycle_payment_attempts",
    "subscription_cycle_dispatch_grants", "subscription_cycle_calculation_rebinds",
  ]);
  return {
    ...registry,
    connectedStoreOwnedTables: registry.connectedStoreOwnedTables.filter(table => !renewalV3Tables.has(table)),
    connectedStoreRestoreOrder: registry.connectedStoreRestoreOrder.filter(table => !renewalV3Tables.has(table)),
  };
});

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Complete native catalogue required");
const unit = manifest.forward.find(entry => entry.file.endsWith("_order_money_v2_storage.sql"));
if (!unit) throw new Error("Order money storage forward missing");
const position = manifest.qualified.forward.indexOf(manifest.qualified.forward.find(entry => entry.file === unit.file)!);
const storageBoundary = structuredClone(manifest);
for (const plan of [storageBoundary, storageBoundary.qualified, storageBoundary.qualifiedAdmin]) {
  plan.forward = plan.forward.slice(0, plan.forward.findIndex(entry => entry.file === unit.file) + 1);
}
storageBoundary.qualified.objectInventorySha256.bootstrapMigrator.withRestore =
  "4f145336f360df45e2e00cc705582ea4c264f1c4658b8342e94efe2bf04520ab";
const precedingInventory = "f0fb77762e832f9ef629e5c9e4b87f5a07f6794d391150b739577cb836c93755";
const functions = [
  "public.commerce_order_assert_line_sum()",
  "public.catalog_order_line_sum_acceptance(uuid,uuid,public.commerce_orders,public.commerce_orders)",
  "public.catalog_order_acceptance_final(uuid)",
  "public.catalog_attach_order_acceptance(uuid,jsonb,text,jsonb)",
  "public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
];
const definitions = async (pool: Pool) => (await pool.query<{ definition: string; source: string }>(
  `SELECT pg_get_functiondef(p.oid) AS definition,p.prosrc AS source
   FROM unnest($1::text[]) WITH ORDINALITY AS named(signature,rank)
   JOIN pg_proc p ON p.oid=to_regprocedure(named.signature) ORDER BY named.rank`, [functions])).rows;

let store: AccountMutationsStore, sku: Awaited<ReturnType<typeof seedSku>>;
let live: Awaited<ReturnType<typeof seedPrivateFacts>>, erased: typeof live;
let lineSumAfterStorage: string;
let predecessorOrder: string, predecessorRows: Awaited<ReturnType<typeof priorOrderRows>>;
let priorSource: ConnectedNativeStoreCapture;
let applied: string[];

function priorOrderRows() {
  return captureCompatiblePostgresRows({
    sourceId: "prior-order-store", catalogueId: precedingInventory, tables: [orderTable, itemTable],
    maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
    source: { withSnapshot: work => transaction(store.owner, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return work({ query: (sql, values) => db.query(sql, values ? [...values] : undefined) });
    }) },
  });
}

async function nativeDraft(db: Pool) {
  const total = { currency: "XXX", amountMinor: 100 };
  const line = { sku: sku.sku, quantity: 1, unitPriceGross: total, lineSubtotalGross: total };
  const context = { mode: "one_time", promoCodes: [] };
  const quote = { contractVersion: "commerce.v0", quote: { currency: "XXX", context, lines: [line], totalGross: total } };
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft",
    paymentStatus: "not_started", currency: "XXX", context, lines: [line], totals: { totalGross: total } };
  const { rows } = await db.query<{ result: { orderDraft: { orderId: string; replayed: boolean } } }>(
    "SELECT public.commerce_create_order_draft_with_outbox($1,$2,$3,NULL) AS result", [randomUUID(), quote, draft]);
  expect(rows[0]!.result.orderDraft).toMatchObject({ replayed: false });
  return rows[0]!.result.orderDraft.orderId.slice("order_".length);
}

beforeAll(async () => {
  const predecessor = structuredClone(storageBoundary);
  for (const plan of [predecessor, predecessor.qualified, predecessor.qualifiedAdmin]) {
    const own = plan.forward.findIndex(entry => entry.file === unit.file);
    expect(own).toBeGreaterThan(0);
    plan.forward = plan.forward.slice(0, own);
  }
  predecessor.qualified.objectInventorySha256.bootstrapMigrator.withRestore = precedingInventory;
  await withPlatformCatalog(storageBoundary, async current => {
    store = await withPlatformCatalog(predecessor, root =>
      installAccountMutations("bootstrap", false, "order-storage-prefix", root, current));
    expect(store.inventory).toBe(precedingInventory);
    sku = await seedSku(store.owner);
    predecessorOrder = await nativeDraft(store.runtime);
    predecessorRows = await priorOrderRows();
    const beforeDefinitions = await definitions(store.owner);
    const sql = "SELECT catalog_path,sha256,position FROM public.platform_schema_migrations WHERE position=$1";
    expect((await store.owner.query(sql, [position + 1])).rows).toEqual([]);
    applied = (await store.runner.apply()).applied;
    const afterDefinitions = await definitions(store.owner);
    expect(afterDefinitions).toHaveLength(functions.length);
    expect(afterDefinitions).toStrictEqual(beforeDefinitions);
    lineSumAfterStorage = afterDefinitions[0]!.source;
  });
  priorSource = priorPacket(await capture(store.owner, store.inventory, "prior-order-store"));
  live = await transaction(store.owner, db => seedPrivateFacts(db, sku));
  erased = await transaction(store.owner, db => seedPrivateFacts(db, sku, true));
}, postgresSetupTimeoutMs);

afterAll(() => store?.close(), postgresTeardownTimeoutMs);

const v0Rows = (orderId: string) => store.owner.query(`SELECT o.money_version,i.line_key,o.total_amount_minor
  FROM public.commerce_orders o JOIN public.commerce_order_items i ON i.order_id=o.id WHERE o.id=$1`, [orderId]);

it("applies its own prefix, keeps the incumbent definitions, and stores nulls through the native draft writer", async () => {
  expect(applied).toEqual([unit.file]);
  expect((await store.owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations WHERE position=$1",
    [position + 1])).rows).toEqual([{ catalog_path: unit.file, sha256: unit.sha256, position: position + 1 }]);
  expect(createHash("sha256").update(readFileSync(unit.file)).digest("hex")).toBe(unit.sha256);
  const body = lineSumAfterStorage;
  const legacyBlock = body.slice(body.indexOf("  SELECT total_amount_minor"),
    body.lastIndexOf("\n\n  PERFORM public.catalog_order_line_sum_acceptance(v_order_id);") + 1);
  expect(Buffer.byteLength(legacyBlock)).toBe(939);
  expect(createHash("sha256").update(legacyBlock).digest("hex")).toBe("c1b997aff2e805edd7496b8714cdc66ad554c00c81766e88c6bf37fbd6fa2b5c");
  if (store.installation.generation === "legacy") throw new Error("Qualified runtime login required");
  expect((await store.runtime.query("SELECT session_user::text AS login")).rows).toEqual([{ login: store.installation.runtimeLogin }]);
  for (const id of [predecessorOrder, await nativeDraft(store.runtime)]) {
    expect((await v0Rows(id)).rows).toEqual([{ money_version: null, line_key: null, total_amount_minor: "100" }]);
  }
});

const refusedWrite = (pool: Pool, write: (db: PoolClient) => Promise<unknown>) =>
  rejected(transaction(pool, async db => { await write(db); }));

function expectForeignKey(error: unknown, table: string, key: string) {
  expectSqlError(error, "23503", foreignKeyMessage(table, key), key);
}

async function admitsWithConstraintDisabled(table: string, key: string, write: (db: PoolClient) => Promise<unknown>) {
  // Temporarily disabled the named constraint in a disposable database.
  await expect(transaction(store.migrator, async db => {
    await db.query(`ALTER TABLE public.${table} DROP CONSTRAINT ${key}`);
    await write(db);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  }, "ROLLBACK")).resolves.toBeUndefined();
}

const bareOrder = (db: PoolClient, id: string, moneyVersion: string | null) =>
  insert(db, orderTable, { id, money_version: moneyVersion });
const bareItem = (db: PoolClient, id: string, orderId: string, key: string | null) => insert(db, itemTable, {
  id, order_id: orderId, line_ordinal: 2, quantity: 1, unit_amount_minor: 0, line_amount_minor: 0, line_key: key,
});
const badPart = (db: PoolClient) => insert(db, buckets, { ...live.part, bucket_key: "orphan", part_no: 1 });
const count = async (table: string, key: string, value: string) =>
  (await store.owner.query<{ count: number }>(`SELECT count(*)::integer AS count FROM public.${table} WHERE ${key}=$1`, [value])).rows[0]!.count;

it("refuses runtime header-only and foreign-order item keys at commit with exact 23503 and no rows", async () => {
  const orderId = randomUUID(), itemId = randomUUID();
  expectForeignKey(await refusedWrite(store.runtime, db => bareOrder(db, orderId, version)), orderTable, orderFk);
  expect(await count(orderTable, "id", orderId)).toBe(0);
  expectForeignKey(await refusedWrite(store.runtime, db => bareItem(db, itemId, predecessorOrder, lineKey)), itemTable, itemFk);
  expect(await count(itemTable, "id", itemId)).toBe(0);

  // The incumbent runtime DML works with both keys omitted.
  await transaction(store.runtime, async db => {
    await insert(db, orderTable, { id: orderId });
    await insert(db, itemTable, { id: itemId, order_id: orderId, line_ordinal: 1,
      quantity: 1, unit_amount_minor: 0, line_amount_minor: 0 });
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  }, "ROLLBACK");
});

it("refuses an orphan part at commit and leaves zero orphan rows", async () => {
  expectForeignKey(await refusedWrite(store.owner, badPart), buckets, headerFk);
  expect(await count(buckets, "bucket_key", "orphan")).toBe(0);
});

it("makes quote and calculation consumption independently unique and reserves the complete cycle arm", async () => {
  const candidateOrder = randomUUID(), candidateCalculation = randomUUID(), distinctQuote = randomUUID();
  const write = (calculation: string, quote: string, patch: Record<string, unknown> = {}) => async (db: PoolClient) => {
    await bareOrder(db, candidateOrder, version);
    if (calculation === candidateCalculation) await insert(db, "tax_calculations", { calculation_id: calculation, state: "erased" });
    await insert(db, snapshots, { ...live.snapshot, order_id: candidateOrder, calculation_id: calculation, accepted_quote_id: quote, ...patch });
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  };
  expectSqlError(await refusedWrite(store.owner, write(candidateCalculation, live.quoteId)), "23505", uniqueMessage(quoteKey), quoteKey);
  expect(await count(orderTable, "id", candidateOrder)).toBe(0);
  expect(await count("tax_calculations", "calculation_id", candidateCalculation)).toBe(0);
  expectSqlError(await refusedWrite(store.owner, write(live.calculationId, distinctQuote)), "23505", uniqueMessage(calculationKey), calculationKey);
  expect(await count(orderTable, "id", candidateOrder)).toBe(0);
  const originCheck = "commerce_order_tax_snapshots_origin_check";
  for (const patch of [{ token_digest: null }, { cycle_binding_ref: randomUUID() }, { accepted_quote_id: null }]) {
    expectSqlError(await refusedWrite(store.owner, write(candidateCalculation, distinctQuote, patch)),
      "23514", checkMessage(snapshots, originCheck), originCheck);
  }
  await transaction(store.owner, write(candidateCalculation, distinctQuote), "ROLLBACK");
  await transaction(store.owner, write(candidateCalculation, distinctQuote, {
    accepted_quote_id: null, accepted_quote_digest: null, token_digest: null, acceptance_ref: null, cycle_binding_ref: randomUUID(),
  }), "ROLLBACK");
  await admitsWithConstraintDisabled(snapshots, quoteKey, write(candidateCalculation, live.quoteId));
  await admitsWithConstraintDisabled(snapshots, calculationKey, write(live.calculationId, distinctQuote));
  await admitsWithConstraintDisabled(snapshots, originCheck, write(candidateCalculation, distinctQuote, { token_digest: null }));
  expect((await store.owner.query(`SELECT accepted_quote_id,calculation_id FROM public.${snapshots} WHERE order_id=$1`, [live.orderId])).rows)
    .toEqual([{ accepted_quote_id: live.quoteId, calculation_id: live.calculationId }]);
});

it("requires the live and erased destination row shapes while preserving original money", async () => {
  const snapshotCheck = "commerce_order_tax_snapshots_destination_check";
  const bucketCheck = "commerce_order_delivery_buckets_destination_check";
  const defects = [
    [snapshots, live.orderId, "destination_digest=NULL", snapshotCheck],
    [snapshots, erased.orderId, "delivery_selection_ref='still-live'", snapshotCheck],
    [buckets, live.orderId, "carrier_ref=NULL", bucketCheck],
    [buckets, erased.orderId, "service_ref='still-live'", bucketCheck],
  ] as const;
  for (const [table, id, patch, key] of defects) {
    const filter = table === buckets ? " AND part_no=0" : "";
    const update = (db: Pool | PoolClient) => db.query(`UPDATE public.${table} SET ${patch} WHERE order_id=$1${filter}`, [id]);
    await admitsWithConstraintDisabled(table, key, update);
    expectSqlError(await rejected(update(store.owner)),
      "23514", checkMessage(table, key), key);
  }
  const rows = await store.owner.query(`SELECT s.destination_erased,s.destination_digest,s.destination_policy_revision,s.delivery_selection_ref,
       b.carrier_ref,b.service_ref,s.accepted_money_digest,s.payable_minor
    FROM public.${snapshots} s JOIN public.${buckets} b USING (order_id) WHERE b.part_no=0 ORDER BY s.destination_erased`);
  expect(rows.rows).toEqual([
    { destination_erased: false, destination_digest: live.snapshot.destination_digest, destination_policy_revision: "policy",
      delivery_selection_ref: "selection", carrier_ref: "carrier", service_ref: "service",
      accepted_money_digest: live.snapshot.accepted_money_digest, payable_minor: "103" },
    { destination_erased: true, destination_digest: null, destination_policy_revision: null,
      delivery_selection_ref: null, carrier_ref: null, service_ref: null,
      accepted_money_digest: erased.snapshot.accepted_money_digest, payable_minor: "103" },
  ]);
  for (const table of [positions, fees]) expect(await count(table, "order_id", erased.orderId)).toBe(table === positions ? 3 : 1);
});

it("rejects ambiguous targets and checks the exact allocation side on historical positions", async () => {
  const allocationCheck = "commerce_order_line_allocations_target_check";
  const positionCheck = "commerce_order_tax_positions_target_check";
  const partAllocationFk = "commerce_order_tax_positions_part_allocation_fkey";
  const putAllocation = (patch: Record<string, unknown>) => (db: PoolClient) =>
    insert(db, allocations, { ...live.allocation, allocation_id: randomUUID(), sequence: 2, ...patch });
  await admitsWithConstraintDisabled(allocations, allocationCheck, putAllocation({ line_key: null, bucket_key: live.part.bucket_key }));
  expectSqlError(await refusedWrite(store.owner, putAllocation({ bucket_key: live.part.bucket_key, part_no: 1 })),
    "23514", checkMessage(allocations, allocationCheck), allocationCheck);
  expectSqlError(await refusedWrite(store.owner, putAllocation({ line_key: null, bucket_key: live.part.bucket_key })),
    "23514", checkMessage(allocations, allocationCheck), allocationCheck);
  const incompletePosition = (db: PoolClient) => insert(db, positions,
    { ...live.position, position_ref: "incomplete", line_key: null, bucket_key: live.part.bucket_key });
  await admitsWithConstraintDisabled(positions, positionCheck, incompletePosition);
  expectSqlError(await refusedWrite(store.owner, incompletePosition), "23514", checkMessage(positions, positionCheck), positionCheck);
  const badAllocationTarget = (db: PoolClient) => insert(db, positions, {
    ...live.position, position_ref: "foreign-allocation", state_side: "after", allocation_slot: 1,
    allocation_id: live.allocation.allocation_id, line_key: null, bucket_key: live.part.bucket_key, part_no: 1,
  });
  await admitsWithConstraintDisabled(positions, partAllocationFk, badAllocationTarget);
  expectForeignKey(await refusedWrite(store.owner, badAllocationTarget), positions, partAllocationFk);
  expect(await count(positions, "position_ref", "foreign-allocation")).toBe(0);
});

it("denies private row DML and rejects undeclared columns from the real runtime login", async () => {
  const undeclared = ["payload", "address", "contact", "recipient", "phone", "email", "address_line_1",
    "address_line_2", "postal_code", "instructions", "credentials", "provider_response", "token"];
  for (const table of storageTables) {
    for (const sql of [`SELECT * FROM public.${table}`, `INSERT INTO public.${table} DEFAULT VALUES`,
      `UPDATE public.${table} SET order_id=$1 WHERE false`, `DELETE FROM public.${table} WHERE false`]) {
      expectSqlError(await rejected(store.runtime.query(sql, sql.includes("$1") ? [live.orderId] : [])),
        "42501", `permission denied for table ${table}`);
    }
    const rowsBefore = await count(table, "order_id", live.orderId);
    for (const column of undeclared) {
      expectSqlError(await rejected(store.runtime.query(`INSERT INTO public.${table} (${column}) VALUES ($1)`, ["synthetic"])),
        "42703", `column "${column}" of relation "${table}" does not exist`);
    }
    expect(await count(table, "order_id", live.orderId)).toBe(rowsBefore);
  }
});

it("probes the landed input validators at scalar length and encoding boundaries", () => {
  const hex = live.snapshot.accepted_money_digest;
  const money = {
    amountBasis: "exclusive", currency: "XXX", mode: "one_time", catalogueEvidenceRef: "catalogue",
    destination: { snapshotRef: randomUUID(), schemaVersion: 2, destinationDigest: hex, policyRevision: "policy" },
    coverageDigest: hex, deliverySelectionRef: "selection", promotion: { engine: "promotion-engine.v1", rankingRuleRef: "lowest_pre_tax.v1" },
    paymentLimits: { profileRef: "limits", channelKey: "checkout", revision: "1", currency: "XXX", minMinor: 0, maxMinor: 1000 },
    price: { priceListRef: "list", priceContextDigest: hex, priceEvidenceRef: "price", classMapRevision: "class" },
    taxEvidence: { kind: "tax_calculation", calculationId: live.calculationId, evidenceDigest: hex,
      taxDate: new Date(live.snapshot.tax_date).toISOString(), expiresAt: new Date(live.snapshot.evaluation_expires_at).toISOString() },
    lines: [{ lineKey: "line", sourceOrdinal: 1, sku: "article", quantity: 1, mode: "one_time", taxClassKey: "class",
      assignmentRef: "assignment", unitBasisMinor: 100, preDiscountMinor: 100, effectiveMinor: 100,
      netMinor: 100, taxMinor: 0, lineTotalMinor: 100, discountAllocations: [], taxPositions: [] }],
    deliveryBuckets: [], feeLines: [], netTotal: 100, taxTotal: 0, feeTotal: 0, payableMinor: 100,
  } satisfies CommerceQuoteMoneyV2;
  function sealQuote(body: CommerceQuoteMoneyV2) {
    const sealed = { ...body, quoteId: randomUUID(), status: "final", schemaVersion: 2, contractVersion: "commerce.v1",
      moneyDigest: quoteDigest("commerce.quote-money.v2", body) } as const;
    return { ...sealed, quoteDigest: quoteDigest("commerce.quote.v2", sealed) };
  }
  const quote = sealQuote(money);
  const withLineKey = (lineKey: string) => ({ ...money, lines: [{ ...money.lines[0]!, lineKey }, ...money.lines.slice(1)] });
  const withEvidenceRef = (catalogueEvidenceRef: string) => ({ ...money, catalogueEvidenceRef });
  // The landed line-key limit counts UTF-16 units. The general Zod
  // reference limit counts Unicode code points.
  for (const [edit, max, astral] of [[withLineKey, 128, 64], [withEvidenceRef, 256, 256]] as const) {
    for (const valid of ["x", "x".repeat(max), "😀".repeat(astral)]) {
      expect(commerceQuoteV2Schema.safeParse(sealQuote(edit(valid))).success).toBe(true);
    }
    for (const invalid of ["", "x".repeat(max + 1), "😀".repeat(astral) + "x"]) {
      expect(commerceQuoteV2Schema.safeParse(sealQuote(edit(invalid))).success).toBe(false);
    }
  }
  for (const invalid of ["x\0x", "\uD800"]) {
    expect(commerceQuoteV2Schema.safeParse({ ...quote, catalogueEvidenceRef: invalid }).error?.issues[0]?.path)
      .toEqual(["catalogueEvidenceRef"]);
  }
  for (const coverageDigest of ["a".repeat(63), "a".repeat(65), "A".repeat(64)]) {
    expect(commerceQuoteV2Schema.safeParse(sealQuote({ ...money, coverageDigest })).success).toBe(false);
  }
  for (const currency of ["XX", "XXXX", "XxX", "X0X"]) {
    expect(commerceQuoteV2Schema.safeParse(sealQuote({ ...money, currency })).success).toBe(false);
  }
  const id = "01234567-89ab-4cde-8012-3456789abcde";
  for (const snapshotRef of [id, id.toUpperCase(), id.replaceAll("-", "")]) {
    expect(commerceQuoteV2Schema.safeParse(sealQuote({ ...money, destination: { ...money.destination, snapshotRef } })).success)
      .toBe(snapshotRef === id);
  }
  expect(commerceQuoteV2Schema.safeParse(sealQuote({ ...money, taxEvidence: { ...money.taxEvidence,
    taxDate: money.taxEvidence.taxDate.replace(/\.\d{3}Z$/u, "Z") } })).success).toBe(false);
  expect(["0", "9007199254.740991", "9007199254.740992", "1.0000000", "01", "1.", "1\n"].map(isCatalogueMoneyV2RateDecimal))
    .toEqual([true, true, false, false, false, false, false]);
});

function priorPacket(current: ConnectedNativeStoreCapture): ConnectedNativeStoreCapture {
  const { sha256: _compatHash, ...compat } = current.compatible;
  const earlier = { ...compat, sourceId: predecessorRows.sourceId, catalogueId: predecessorRows.catalogueId,
    tables: compat.tables.map(row => predecessorRows.tables.find(previous => previous.table === row.table) ?? row) };
  const { sha256: _hash, ...body } = current;
  const prior = { ...body, compatible: { ...earlier, sha256: digest(earlier) },
    owned: current.owned.filter(row => !storageTables.some(name => name === row.table)) };
  return { ...prior, sha256: digest(prior) };
}

it("refuses the predecessor packet and restores the current six-table graph with row-text equality and replay", async () => {
  await withPlatformCatalog(storageBoundary, async root => {
    const target = await installAccountMutations("bootstrap", false, "order-storage-target", root);
    // The adapter must read the same exact-current catalogue as these storage-only fixtures.
    restoreFixture.root = root;
    try {
      if (target.installation.generation === "legacy") throw new Error("Qualified owner restore required");
      // Preserve the incumbent graph in the predecessor packet. Its order and item bytes came from the prior installation.
      const packet = await capture(store.owner, store.inventory, "current-order-store");
      expect(packet.owned.filter(row => storageTables.some(name => name === row.table)).map(row => [row.table, row.rows.length]))
        .toEqual(storageTables.map((name, index) => [name, [2, 2, 4, 4, 6, 2][index]]));
      const taxIndex = packet.owned.findIndex(row => row.table === "tax_calculations");
      expect(packet.owned.slice(taxIndex + 1, taxIndex + 7).map(row => row.table)).toEqual(storageTables);
      const freshTarget = await capture(target.migrator, target.inventory, "empty-target");
      const input = { owner: target.migrator, installation: target.installation, freshTarget };
      const remedy = "capture the source and restore it with the same OpenLup version on a pristine target of the same profile; upgrade the source within its installed profile first if it is older";
      const error = await rejected(restoreConnectedNativeStore({ ...input, packet: priorSource }));
      expect(Object.getPrototypeOf(error)).toBe(PostgresTransferError.prototype);
      expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort())
        .toStrictEqual(["code", "message", "name", "remedy", "table"]);
      expect(error).toMatchObject({ code: "schema_conflict", table: undefined, remedy,
        message: `postgres_transfer_schema_conflict (${remedy})` });
      expect((await capture(target.migrator, target.inventory, "post-refusal")).owned).toStrictEqual(freshTarget.owned);
      await expect(restoreConnectedNativeStore({ ...input, packet })).resolves.toMatchObject({ captureSha256: packet.sha256, replayed: false });
      await expect(restoreConnectedNativeStore({ ...input, packet })).resolves.toMatchObject({ captureSha256: packet.sha256, replayed: true });
      const restored = await capture(target.migrator, target.inventory, "restored-target");
      expect(restored.owned).toStrictEqual(packet.owned);
      expect(restored.compatible.tables).toStrictEqual(packet.compatible.tables);
    } finally {
      restoreFixture.root = undefined;
      await target.close();
    }
  });
}, postgresSetupTimeoutMs);

it("detects disabled dormancy and orphan constraints with the same failing writes", async () => {
  // Temporarily disabled each required FK in a disposable database.
  const mutations = [
    [orderTable, orderFk, store.runtime, (db: PoolClient) => bareOrder(db, randomUUID(), version)],
    [itemTable, itemFk, store.runtime, (db: PoolClient) => bareItem(db, randomUUID(), predecessorOrder, lineKey)],
    [buckets, headerFk, store.owner, badPart],
  ] as const;
  for (const [table, key, pool, write] of mutations) {
    const { rows } = await store.owner.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2", [table, key]);
    await store.migrator.query(`ALTER TABLE public.${table} DROP CONSTRAINT ${key}`);
    try {
      await expect(transaction(pool, async db => {
        await write(db);
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      }, "ROLLBACK")).resolves.toBeUndefined();
    } finally { await store.migrator.query(`ALTER TABLE public.${table} ADD CONSTRAINT ${key} ${rows[0]!.definition}`); }
  }
});
