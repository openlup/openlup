import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient, QueryConfig } from "pg";
import type { PgQueryExecutor } from "@openlup/platform/data";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { createPostgresPrivacyStore, createPostgresPrivacyUnitOfWork, createPrivacyEraseHandler } from "@openlup/platform/identity";
import { erasureReceiptSchema } from "@openlup/platform/identity/contracts";
import { PostgresTransferError } from "@openlup/platform/portability";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readPlatformMigrationManifest, sha256, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { composeNativePrivacy } from "../../server/runtime/auth/privacyBinding.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { createAccountMutationsTemplate, installAccountMutationsBeforeForward, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { deferred, destinationContext, testServicePin } from "./destinationDocumentFixture.js";
import { awaitReceiptWait, backendPid, receiptClient } from "./destinationReceiptFixture.js";
import { prepareReceipt, receipts, writeReceipt } from "./orderDraftReceiptsV2.fixture.js";
import { issue, write, type Evidence } from "./orderMoneyV2Guards.fixture.js";
import { allocations, buckets, capture, expectSqlError, fees, insert, itemTable, orderTable, positions, rejected, seedSku,
  snapshots, sources, storageTables, transaction } from "./orderMoneyV2Storage.fixture.js";

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Expected complete native catalogue");
const unit = manifest.forward.find(entry => entry.file.endsWith("_order_money_v2_child_guards.sql"));
if (!unit) throw new Error("Expected order money child guard forward");
const position = manifest.qualified.forward.findIndex(entry => entry.file === unit.file);
const assertion = "public.commerce_order_money_v2_assert(uuid,boolean,boolean,jsonb,jsonb)";
const bodyReader = "public.commerce_order_money_v2_live_body(uuid)";
const memo = "public.commerce_order_money_v2_check_state(uuid,boolean,text,text)";
const lineSum = "public.commerce_order_assert_line_sum()";
const destinationEraser = "public.commerce_destination_v2_erase(uuid)";
const adjustments = "commerce_order_adjustments";
const message = "commerce_order_money_v2_mismatch";
const immutable = "Keep the accepted facts and use the owning order lifecycle operation.";
const replayOriginal = "Replay the original accepted document and its digest.";
const recoverEvidence = "Recover the original accepted evidence through its owner and retry with its original binding.";
const moneyObligations = [
  { owner: "destination-documents", resource: "commerce.order-money-destination-pins", disposition: "erase",
    reasonCode: "PRIVATE_DESTINATION_DOCUMENT_EVIDENCE", remote: false },
  { owner: "destination-documents", resource: "commerce.order-money-retained-facts", disposition: "retain",
    reasonCode: "ACCEPTED_ORDER_MONEY_RECORD", remote: false },
];
const predecessorDefinitions = async (db: Pool) => (await db.query(
  "SELECT oid::regprocedure::text AS name, pg_get_functiondef(oid), proacl FROM pg_proc WHERE oid = ANY($1::regprocedure[]) ORDER BY proname",
  [[assertion, bodyReader, memo, lineSum, destinationEraser]])).rows;
let store: AccountMutationsStore;
let sku: Awaited<ReturnType<typeof seedSku>>;
let applied: string[];
let priorDefinitions: Awaited<ReturnType<typeof predecessorDefinitions>>;

beforeAll(async () => {
  store = await installAccountMutationsBeforeForward(manifest, unit.file, "bootstrap", "order-child-guards-prefix");
  priorDefinitions = await predecessorDefinitions(store.owner);
  applied = (await store.runner.apply()).applied;
  sku = await seedSku(store.owner);
}, postgresSetupTimeoutMs);

afterAll(() => store?.close(), postgresTeardownTimeoutMs);

async function mismatch(run: Promise<unknown>, column: string, hint = replayOriginal) {
  const error = await rejected(run);
  expectSqlError(error, "23514", message);
  expect(error).toMatchObject({ column, hint, detail: undefined });
}

it("applies the child guards first and preserves the installed assertion, reader, memo and line-sum trigger function", async () => {
  expect(applied.slice(0, 1)).toEqual([unit.file]);
  expect(sha256(readFileSync(unit.file, "utf8"))).toBe(unit.sha256);
  expect((await store.owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations WHERE position=$1",
    [position + 1])).rows).toEqual([{ catalog_path: unit.file, sha256: unit.sha256, position: position + 1 }]);
  expect(priorDefinitions).toHaveLength(5);
  const installedDefinitions = await predecessorDefinitions(store.owner);
  const eraser = installedDefinitions.find(row => row.name.endsWith("commerce_destination_v2_erase(uuid)"))!;
  const installed: string = eraser.pg_get_functiondef;
  const unchangedPrefix = "  GET DIAGNOSTICS v_count = ROW_COUNT;\n";
  const unchangedSuffix = "  RETURN v_count;\n";
  const addedAt = installed.indexOf(unchangedPrefix) + unchangedPrefix.length;
  const addedUntil = installed.indexOf(unchangedSuffix, addedAt);
  expect(installed.indexOf(unchangedPrefix)).toBeGreaterThan(0);
  expect(addedUntil).toBeGreaterThan(addedAt);
  eraser.pg_get_functiondef = installed.slice(0, addedAt) + installed.slice(addedUntil);
  expect(installedDefinitions).toStrictEqual(priorDefinitions);
  const signature = "public.commerce_order_money_v2_child_guard()";
  expect((await store.runtime.query("SELECT session_user::text AS login, has_function_privilege($1,'EXECUTE') AS execute",
    [signature])).rows).toEqual([{ login: store.installation.generation === "qualified-v2" ? store.installation.runtimeLogin : "", execute: false }]);
});

function fullEvidence(db: AccountMutationsStore, variant: typeof sku,
  { multiple = false, context }: { multiple?: boolean; context?: Awaited<ReturnType<typeof destinationContext>> } = {}) {
  const count = multiple ? 2 : 1;
  const promotions = Array.from({ length: count }, () => ({ id: "offer-" + randomUUID(), lineKey: "article" }));
  return issue(db, variant, false, body => {
    const source = body.lines[0]!;
    const state = (basis: number) => ({
      basisMinor: basis, netMinor: basis, taxMinor: 0,
      taxPositions: [{ ...source.taxPositions[0]!, taxableMinor: basis }],
    });
    const paid = 100 - count;
    const after = state(paid);
    const first = {
      ...source, lineKey: "article", preDiscountMinor: 100, effectiveMinor: paid, netMinor: paid, lineTotalMinor: paid,
      taxPositions: after.taxPositions,
      discountAllocations: promotions.map(({ id }, index) => ({
        allocationId: randomUUID(), adjustmentRef: id, sequence: index + 1, source: "legacy_promotion" as const,
        basisReductionMinor: 1, netReductionMinor: 1, taxReductionMinor: 0, evidenceRef: "b".repeat(64),
        before: state(100 - index), after: state(99 - index),
      })),
    };
    const netTotal = paid + (count - 1) * 100 + count * 2;
    return {
      ...body,
      lines: multiple ? [first, { ...source, lineKey: "article-2", sourceOrdinal: 2, taxPositions: [] }] : [first],
      deliveryBuckets: Array.from({ length: count }, (_, index) => ({
        bucketKey: index === 0 ? "handling" : "handling-2", kind: "handling",
        carrierRef: testServicePin.carrierRef, serviceRef: testServicePin.serviceRef, taxClassKey: "class-a",
        assignmentRef: "assignment-a", cost: { ref: "cost", currency: "XXX", amountMinor: 2 },
        separatelyStated: false, parts: [{ preDiscountMinor: 2, effectiveMinor: 2, netMinor: 2, taxMinor: 0,
          lineTotalMinor: 2, taxPositions: [], discountAllocations: [] }],
      })),
      feeLines: Array.from({ length: count }, (_, index) => ({
        feeKey: index === 0 ? "fee" : "fee-2", jurisdictionRef: "district", feeKind: "service", amountMinor: 3,
        scope: { kind: "order" }, refundRule: { ref: "rule", revision: "1" },
      })),
      netTotal, feeTotal: count * 3, payableMinor: netTotal + count * 3,
    };
  }, { promotions, context });
}

const guardName = (table: string) => `trg_${table}_money_v2`;
const writeOrder = (db: AccountMutationsStore, evidence: Evidence, variant: typeof sku, options?: Parameters<typeof write>[3]) =>
  transaction(db.owner, client => write(client, evidence, variant, options));

async function withoutGuard(table: string, trigger: string, sql: (db: PoolClient) => Promise<unknown>) {
  // Temporarily disabled this deferred trigger in a disposable database transaction.
  await transaction(store.owner, async db => {
    await db.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${trigger}`);
    await sql(db);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  }, "ROLLBACK");
}

it("refuses standalone child rewrites, deletion and moves at commit and leaves the six original row-text sets intact", async () => {
  const evidence = await fullEvidence(store, sku);
  const { id } = await writeOrder(store, evidence, sku);
  const { id: other } = await writeOrder(store, await fullEvidence(store, sku), sku);
  const before = await capture(store.owner, store.inventory, "child-guard-before");
  const updates = [
    [snapshots, "accepted_money_digest=repeat('c',64)", "/taxEvidence", immutable],
    [snapshots, "destination_snapshot_ref=gen_random_uuid()", "/taxEvidence", immutable],
    [sources, "assignment_ref='different-assignment'", "/lines", immutable],
    [buckets, "net_minor=net_minor+1", "/deliveryBuckets", immutable],
    [allocations, "evidence_ref=repeat('d',64)", "/discountAllocations", immutable],
    [positions, "rule_ref='different-rule'", "/taxEvidence", immutable],
    [fees, "fee_kind='different-service'", "/feeLines", immutable],
  ] as const;
  for (const [table, assignment, field, hint] of updates) {
    const filter = table === buckets ? " AND part_no>0" : "";
    const mutate = (db: PoolClient) => db.query(`UPDATE public.${table} SET ${assignment} WHERE order_id=$1${filter}`, [id]);
    await withoutGuard(table, guardName(table), mutate);
    await mismatch(transaction(store.owner, mutate), field, hint);
  }
  const deleteFee = (db: PoolClient) => db.query(`DELETE FROM public.${fees} WHERE order_id=$1`, [id]);
  await withoutGuard(fees, guardName(fees), deleteFee);
  await mismatch(transaction(store.owner, deleteFee), "/feeLines", immutable);
  const moveFee = (db: PoolClient) => db.query(
    `UPDATE public.${fees} SET order_id=$2,fee_key='moved-fee',fee_rank=2 WHERE order_id=$1`, [id, other]);
  await withoutGuard(fees, guardName(fees), moveFee);
  await mismatch(transaction(store.owner, moveFee), "/payableMinor");
  expect(moneyRows(await capture(store.owner, store.inventory, "child-guard-after"))).toStrictEqual(moneyRows(before));
});

it("refuses a late private fact and a standalone adjustment INSERT from the qualified runtime", async () => {
  const evidence = await issue(store, sku, false);
  const { id } = await writeOrder(store, evidence, sku);
  const lateFee = (db: PoolClient) => insert(db, fees, {
    order_id: id, fee_key: "late-fee", fee_rank: 1, fee_kind: "service", jurisdiction_ref: "district",
    amount_minor: 0, scope_kind: "order", refund_rule_ref: "rule", refund_rule_revision: "1",
  });
  await withoutGuard(fees, guardName(fees), lateFee);
  await mismatch(transaction(store.owner, lateFee), "/acceptedMoneyDigest");
  const lateFeeAfterFlush = async (db: PoolClient) => {
    await db.query(`UPDATE public.${snapshots} SET destination_erased=destination_erased WHERE order_id=$1`, [id]);
    await db.query(`SET CONSTRAINTS ${guardName(snapshots)} IMMEDIATE`);
    await lateFee(db);
  };
  await withoutGuard(fees, guardName(fees), lateFeeAfterFlush);
  await mismatch(transaction(store.owner, lateFeeAfterFlush), "/acceptedMoneyDigest");
  const lateAdjustment = (db: PoolClient) => insert(db, adjustments, {
    order_id: id, kind: "shipping_charge", scope: "shipping", amount_minor: 1,
  });
  await withoutGuard(adjustments, guardName(adjustments), lateAdjustment);
  await mismatch(transaction(store.runtime, lateAdjustment), "/deliveryBuckets");

  const actor = await operator(store.owner);
  const erased = receipt(await erasure(store, actor)(evidence.clientId, randomUUID()), "ERASED");
  await provedErasure(store, evidence, id, erased.erasureId);
  // The retained assertion alone would accept a zero-value fee after erasure.
  await withoutGuard(fees, guardName(fees), lateFee);
  await mismatch(transaction(store.owner, lateFee), "/feeLines", immutable);
  await mismatch(transaction(store.migrator, async db => {
    await db.query(`LOCK TABLE public.${orderTable}, public.identity_privacy_erasures, public.${snapshots}, public.${sources},
      public.${buckets}, public.${allocations}, public.${positions}, public.${fees} IN SHARE ROW EXCLUSIVE MODE`);
    // Even under the restore locks, the marker cannot claim a previously committed order.
    await db.query(`UPDATE public.${orderTable} SET updated_at=updated_at WHERE id=$1`, [id]);
    await db.query("SELECT public.commerce_order_money_v2_mark_restore_orders($1::uuid[])", [[id]]);
    expect((await db.query("SELECT order_id FROM public.commerce_order_money_v2_restore_marks WHERE order_id=$1", [id])).rows).toEqual([]);
    await lateFee(db);
  }), "/feeLines", immutable);
  await mismatch(transaction(store.runtime, lateAdjustment), "/discountAllocations", immutable);
  for (const table of [fees, adjustments]) {
    expect((await store.owner.query(`SELECT 1 FROM public.${table} WHERE order_id=$1`, [id])).rows).toEqual([]);
  }
});

it("uses the incumbent deferred order and item routes to refuse invalid v2 writes", async () => {
  const evidence = await issue(store, sku, false);
  const { id } = await writeOrder(store, evidence, sku);
  const header = (db: PoolClient) => db.query("UPDATE public.commerce_orders SET money_version=NULL WHERE id=$1", [id]);
  const extraItem = (db: PoolClient) => insert(db, itemTable, {
    order_id: id, sku_id: sku.id, line_key: evidence.quote.lines[0]!.lineKey, line_ordinal: 200,
    quantity: 1, unit_amount_minor: 100, line_amount_minor: 100,
  });
  await withoutGuard(orderTable, "trg_commerce_orders_line_sum", header);
  await withoutGuard(itemTable, "trg_commerce_order_items_line_sum", extraItem);
  await mismatch(transaction(store.runtime, header), "/moneyVersion", immutable);
  await mismatch(transaction(store.runtime, extraItem), "/lines");
  await store.runtime.query("UPDATE public.commerce_orders SET status='pending_payment' WHERE id=$1", [id]);
  expect((await store.owner.query(`SELECT money_version,(SELECT count(*)::int FROM public.${itemTable}
    WHERE order_id=$1) AS items FROM public.${orderTable} WHERE id=$1`, [id])).rows)
    .toEqual([{ money_version: "commerce.order-money.v2", items: 1 }]);
});

const moneyRows = (packet: Awaited<ReturnType<typeof capture>>) =>
  packet.owned.filter(({ table }) => storageTables.some(relation => table === relation));

const copyColumns: Partial<Record<string, string[]>> = {
  [snapshots]: ["destination_digest", "destination_policy_revision", "delivery_selection_ref"],
  [buckets]: ["carrier_ref", "service_ref"],
};

function scrubbedMoney(rows: ReturnType<typeof moneyRows>) {
  return rows.map(({ table, rows }) => {
    const copies = copyColumns[table];
    if (!copies) return rows;
    return rows.map(text => {
      const row = JSON.parse(text);
      if (table === buckets && row.part_no !== 0) return row;
      return { ...row, ...Object.fromEntries(copies.map(key => [key, null])), destination_erased: true };
    });
  });
}

async function operator(db: Pool) {
  const id = randomUUID();
  await insert(db, "platform_human_principals", { principal_id: id, email: `${id}@example.invalid` });
  await db.query(`INSERT INTO public.platform_human_memberships
    (principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    VALUES($1,'admin','active','legacy',clock_timestamp())`, [id]);
  return id;
}

function erasure(target: AccountMutationsStore, principalId: string,
  hooks: {
    start?: (pid: number) => void;
    prepared?: () => Promise<void>;
    omitMoneyDispositions?: boolean;
    releaseSavepoint?: boolean;
  } = {}) {
  const sqlStore = createPostgresPrivacyStore();
  const operations = composeNativePrivacy({
    store: {
      ...sqlStore,
      async prepareErasure(db) {
        await sqlStore.prepareErasure(db);
        await hooks.prepared?.();
      },
      async saveReceipt(db, subject, actor, key, receipt, dispositions) {
        const records = hooks.omitMoneyDispositions ? dispositions.map(disposition => ({
          ...disposition, obligations: disposition.obligations.filter(({ resource }) => !resource.startsWith("commerce.order-money-")),
        })) : dispositions;
        await sqlStore.saveReceipt(db, subject, actor, key, receipt, records);
      },
    },
    unitOfWork: hooks.start || hooks.releaseSavepoint ? { run: <T>(work: (db: PgQueryExecutor) => Promise<T>) =>
      transaction(target.runtime, async db => {
        if (hooks.start) hooks.start(await backendPid(db));
        if (hooks.releaseSavepoint) await db.query("SAVEPOINT mounted_erasure");
        const result = await work(db);
        if (hooks.releaseSavepoint) await db.query("RELEASE SAVEPOINT mounted_erasure");
        return result;
      }) } : createPostgresPrivacyUnitOfWork({ connectionString: "" }, { pool: target.runtime }),
  }).operations;
  const handler = createPrivacyEraseHandler({
    operations, authorizeAdmin: async () => ({ ok: true, role: "admin", principalId, isMachineActor: false }),
  });
  return async (contactId: string, idempotencyKey: string) => {
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const request = { method: "POST", body: { subject: { kind: "contact", contactId }, idempotencyKey } } as HttpRequest;
    await handler(request, res as unknown as HttpResponse);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    return { status: res.status.mock.calls[0]?.[0], response: res.json.mock.calls[0]?.[0] };
  };
}

function receipt(result: Awaited<ReturnType<ReturnType<typeof erasure>>>, outcome: "ERASED" | "ALREADY_ERASED") {
  expect(result).toMatchObject({ status: 200, response: { ok: true } });
  const data = erasureReceiptSchema.parse(result.response.data);
  expect(data.outcome).toBe(outcome);
  return data;
}

async function provedErasure(db: AccountMutationsStore, evidence: Evidence, orderId: string, erasureId: string) {
  const { rows } = await db.owner.query(`SELECT o.total_amount_minor,s.calculation_id,s.accepted_money_digest,s.destination_snapshot_ref,
    d.document_text,d.document_digest,d.binding,d.owner_scope,d.scope_ref,d.evidence_disposition,
    b.selection,b.service,t.state,t.identity,t.pin,t.outcome_text,t.snapshot_ref AS tax_destination,
    r.contributor_versions->>'destination-documents' AS version,r.dispositions,
    public.commerce_order_money_v2_live_body(o.id) AS body
    FROM public.commerce_orders o JOIN public.${snapshots} s ON s.order_id=o.id
    JOIN public.tax_calculations t ON t.calculation_id=s.calculation_id
    JOIN public.commerce_destination_v2_order_bindings b ON b.order_id=o.id
    JOIN public.commerce_destination_v2_documents d ON d.snapshot_ref=b.snapshot_ref
    JOIN public.identity_privacy_erasures r ON r.client_id=o.client_id
    WHERE o.id=$1 AND r.erasure_id=$2`, [orderId, erasureId]);
  expect(rows).toEqual([{
    total_amount_minor: String(evidence.quote.payableMinor), calculation_id: evidence.quote.taxEvidence.calculationId,
    accepted_money_digest: evidence.quote.moneyDigest, destination_snapshot_ref: evidence.quote.destination.snapshotRef,
    document_text: null, document_digest: null, binding: null, owner_scope: null, scope_ref: null, evidence_disposition: "erased",
    selection: null, service: null, state: "erased", identity: null, pin: null, outcome_text: null, tax_destination: null,
    version: "commerce.destination-documents.v1", dispositions: expect.arrayContaining([{
      contributorId: "destination-documents", version: "commerce.destination-documents.v1",
      obligations: expect.arrayContaining(moneyObligations),
    }]), body: null,
  }]);
  expect((await db.owner.query(`SELECT dialect,owner_scope,request_key,outcome,evidence_disposition
    FROM public.commerce_destination_v2_receipts WHERE client_id=$1`, [evidence.clientId])).rows)
    .toEqual([{ dialect: null, owner_scope: null, request_key: null, outcome: null, evidence_disposition: "erased" }]);
}

async function restoreInputs(target: AccountMutationsStore, packet: Awaited<ReturnType<typeof capture>>) {
  if (target.installation.generation === "legacy") throw new Error("Qualified restore owner required");
  return { owner: target.migrator, installation: target.installation, packet,
    freshTarget: await capture(target.migrator, target.inventory, "pristine-order-money-target") };
}

async function refusesUnlistedGuard(input: Awaited<ReturnType<typeof restoreInputs>>) {
  const owner = {
    async connect() {
      const db = await input.owner.connect();
      // Temporarily added an unlisted trigger inside a disposable restore transaction,
      // after inventory attestation so the assertion reaches the independent name check.
      const query = db.query.bind(db);
      return {
        query: async (sql: string | QueryConfig, values?: unknown[]) => {
          if (typeof sql !== "string") return query(sql);
          if (sql.includes("t.tgname AS name")) await query(
            `CREATE CONSTRAINT TRIGGER fixture_unlisted_guard AFTER INSERT ON public.${fees}
             DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commerce_order_money_v2_child_guard()`);
          return query(sql, values);
        },
        release: (destroy?: boolean) => db.release(destroy),
      };
    },
  } as unknown as Pool;
  const error = await rejected(restoreConnectedNativeStore({ ...input, owner }));
  expect(Object.getPrototypeOf(error)).toBe(PostgresTransferError.prototype);
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort())
    .toStrictEqual(["code", "message", "name", "table"]);
  expect(error).toMatchObject({ code: "insert_trigger_requires_owner", table: fees,
    message: `postgres_transfer_insert_trigger_requires_owner:${fees}` });
}

it.each([
  { mode: "the default top-level transaction", releaseSavepoint: false },
  { mode: "a released savepoint", releaseSavepoint: true },
])("erases each delivery header and both owner receipts in $mode", async ({ releaseSavepoint }) => {
  const [actor, context] = await Promise.all([operator(store.owner), destinationContext(store.owner)]);
  const evidence = await fullEvidence(store, sku, { multiple: true, context });
  const other = await issue(store, sku, false, undefined, { context: { ...context, scopeRef: randomUUID() } });
  const firstReceipt = await prepareReceipt(store, sku, randomUUID(), evidence);
  const secondReceipt = await prepareReceipt(store, sku, randomUUID(), other);
  const [orderId, otherId] = await transaction(store.owner, async db => [
    await writeReceipt(db, firstReceipt.input, evidence, sku),
    await writeReceipt(db, secondReceipt.input, other, sku),
  ] as const);

  const readRows = async (table: string) => (await store.owner.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(c) AS row FROM public.${table} c WHERE order_id=$1 ORDER BY to_jsonb(c)::text`, [orderId])).rows.map(({ row }) => row);
  const unchangedTables = [itemTable, adjustments, sources, allocations, positions, fees];
  const retained = await Promise.all(unchangedTables.map(readRows));
  expect(retained.every(rows => rows.length >= 2)).toBe(true);
  const delivery = await readRows(buckets);
  expect(delivery.filter(row => row.part_no === 0).map(row => row.bucket_key).sort()).toEqual(["handling", "handling-2"]);
  expect(delivery.filter(row => row.part_no === 1)).toHaveLength(2);

  const erase = erasure(store, actor, { releaseSavepoint });
  const key = randomUUID();
  const accepted = receipt(await erase(evidence.clientId, key), "ERASED");
  expect((await store.owner.query("SELECT erasure_id FROM public.identity_privacy_erasures WHERE client_id=$1",
    [evidence.clientId])).rows).toStrictEqual([{ erasure_id: accepted.erasureId }]);
  expect((await store.owner.query(`SELECT order_id FROM public.${snapshots} WHERE order_id=ANY($1::uuid[])
    AND destination_erased ORDER BY order_id`, [[orderId, otherId]])).rows.map(row => row.order_id))
    .toEqual([orderId, otherId].sort());
  expect((await store.owner.query(`SELECT order_id FROM public.${receipts} WHERE order_id=ANY($1::uuid[])
    AND principal_ref IS NULL AND customer_or_session_ref IS NULL ORDER BY order_id`, [[orderId, otherId]])).rows.map(row => row.order_id))
    .toEqual([orderId, otherId].sort());
  const erasedDelivery = await readRows(buckets);
  expect(erasedDelivery).toEqual(expect.arrayContaining(delivery.map(row => row.part_no === 0
    ? { ...row, carrier_ref: null, service_ref: null, destination_erased: true } : row)));
  expect(erasedDelivery).toHaveLength(delivery.length);
  expect(await Promise.all(unchangedTables.map(readRows))).toStrictEqual(retained);
  for (const table of ["commerce_order_money_v2_redaction_marks", "commerce_order_draft_receipt_erasure_marks"]) {
    expect((await store.owner.query(`SELECT order_id FROM public.${table} WHERE order_id=ANY($1::uuid[])`, [[orderId, otherId]])).rows).toEqual([]);
  }
  expect(receipt(await erase(evidence.clientId, key), "ALREADY_ERASED").erasureId).toBe(accepted.erasureId);
});

it("order_money_survives_erasure_and_restore", async () => {
  const template = await createAccountMutationsTemplate("bootstrap", "money-erasure-restore", undefined, undefined, { isolatedCluster: true });
  try {
    const [source, erasedTarget, liveTarget] = await Promise.all([
      template.clone("money-privacy-source"), template.clone("money-erased-target"), template.clone("money-live-target"),
    ]);
    const [variant, principalId] = await Promise.all([seedSku(source.owner), operator(source.owner)]);
    const evidence = await fullEvidence(source, variant);
    const otherEvidence = await issue(source, variant, false);
    const other = await writeOrder(source, otherEvidence, variant);
    const writer = await source.owner.connect();
    const started = deferred<number>();
    const key = randomUUID();
    const runErase = erasure(source, principalId, { start: started.resolve });
    let firstErase: ReturnType<typeof runErase> | undefined;
    let orderId: string;
    try {
      await writer.query("BEGIN");
      ({ id: orderId } = await write(writer, evidence, variant));
      firstErase = runErase(evidence.clientId, key);
      void firstErase.catch(started.reject);
      await awaitReceiptWait(source.owner, await started.promise, "relation", "ShareRowExclusiveLock");
      await writer.query("COMMIT");
    } finally { await writer.query("ROLLBACK"); writer.release(); }
    const erased = receipt(await firstErase!, "ERASED");
    expect(erased.obligations).toEqual(expect.arrayContaining(moneyObligations));
    expect(receipt(await runErase(evidence.clientId, key), "ALREADY_ERASED").erasureId).toBe(erased.erasureId);
    await provedErasure(source, evidence, orderId, erased.erasureId);
    const erasedPacket = await capture(source.owner, source.inventory, "erased-order-money");
    const erasedInput = await restoreInputs(erasedTarget, erasedPacket);
    await refusesUnlistedGuard(erasedInput);
    await expect(restoreConnectedNativeStore(erasedInput)).resolves.toMatchObject({ replayed: false, captureSha256: erasedPacket.sha256 });
    await expect(restoreConnectedNativeStore(erasedInput)).resolves.toMatchObject({ replayed: true });
    expect(moneyRows(await capture(erasedTarget.migrator, erasedTarget.inventory, "erased-target-money")))
      .toStrictEqual(moneyRows(erasedPacket));
    await provedErasure(erasedTarget, evidence, orderId, erased.erasureId);
    expect(receipt(await erasure(erasedTarget, principalId)(evidence.clientId, key), "ALREADY_ERASED").erasureId)
      .toBe(erased.erasureId);

    // Reuse an isolated source for capture-first and compare every money row
    // both before and after independent erasure of the same accepted order.
    const liveSource = await template.clone("money-live-source");
    const [liveVariant, liveActor] = await Promise.all([seedSku(liveSource.owner), operator(liveSource.owner)]);
    const liveEvidence = await fullEvidence(liveSource, liveVariant);
    const { id: liveId } = await writeOrder(liveSource, liveEvidence, liveVariant);
    const withoutBuckets = await issue(liveSource, liveVariant, false);
    const { id: noBuckets } = await writeOrder(liveSource, withoutBuckets, liveVariant);
    const { quoteId: _id, status: _status, schemaVersion: _schema, contractVersion: _contract,
      moneyDigest: _money, quoteDigest: _quote, ...acceptedBody } = liveEvidence.quote;
    expect((await liveSource.owner.query("SELECT public.commerce_order_money_v2_live_body($1) AS body", [liveId])).rows)
      .toEqual([{ body: acceptedBody }]);
    const live = await capture(liveSource.owner, liveSource.inventory, "live-order-money");
    expect(moneyRows(live).every(({ rows }) => rows.length > 0)).toBe(true);
    const liveInput = await restoreInputs(liveTarget, live);
    await expect(restoreConnectedNativeStore(liveInput)).resolves.toMatchObject({ replayed: false });
    expect(moneyRows(await capture(liveTarget.migrator, liveTarget.inventory, "live-target-money"))).toStrictEqual(moneyRows(live));
    expect((await liveTarget.owner.query("SELECT public.commerce_order_money_v2_live_body($1) AS body", [liveId])).rows)
      .toEqual([{ body: acceptedBody }]);
    const liveKey = randomUUID();
    const [sourceReceipt, targetReceipt] = await Promise.all([liveSource, liveTarget].map(async db =>
      receipt(await erasure(db, liveActor, { releaseSavepoint: true })(liveEvidence.clientId, liveKey), "ERASED")));
    await provedErasure(liveSource, liveEvidence, liveId, sourceReceipt!.erasureId);
    await provedErasure(liveTarget, liveEvidence, liveId, targetReceipt!.erasureId);
    expect(receipt(await erasure(liveTarget, liveActor)(liveEvidence.clientId, liveKey), "ALREADY_ERASED").erasureId)
      .toBe(targetReceipt!.erasureId);

    const sourceAfter = moneyRows(await capture(liveSource.owner, liveSource.inventory, "redacted-source"));
    const targetAfter = moneyRows(await capture(liveTarget.migrator, liveTarget.inventory, "redacted-target"));
    expect(targetAfter).toStrictEqual(sourceAfter);
    const liveRows = moneyRows(live);
    const expected = scrubbedMoney(liveRows.map(entry => ({
      ...entry, rows: entry.rows.filter(text => JSON.parse(text).order_id === liveId),
    })));
    const changed = sourceAfter.map(({ rows }) => rows.filter(text => JSON.parse(text).order_id === liveId).map(text => JSON.parse(text)));
    expect(changed).toEqual(expected.map(rows => expect.arrayContaining(rows.map(row => typeof row === "string" ? JSON.parse(row) : row))));
    expect(changed.map(rows => rows.length)).toEqual(expected.map(rows => rows.length));
    expect((await source.owner.query(`SELECT destination_erased FROM public.${snapshots} WHERE order_id=$1`, [other.id])).rows)
      .toEqual([{ destination_erased: false }]);
    const noBucketReceipt = receipt(await erasure(liveSource, liveActor)(withoutBuckets.clientId, randomUUID()), "ERASED");
    await provedErasure(liveSource, withoutBuckets, noBuckets, noBucketReceipt.erasureId);
    expect((await liveSource.owner.query(`SELECT 1 FROM public.${buckets} WHERE order_id=$1`, [noBuckets])).rows).toEqual([]);
  } finally { await template.close(); }
}, postgresSetupTimeoutMs);

it("leaves the erased-first writer without usable evidence and preserves no-order historical receipts", async () => {
  const evidence = await issue(store, sku, false);
  const actor = await operator(store.owner);
  const prepared = deferred<void>(), resume = deferred<void>();
  const erase = erasure(store, actor, { prepared: () => { prepared.resolve(); return resume.promise; } });
  const key = randomUUID(), id = randomUUID();
  const earlier = erase(evidence.clientId, key);
  void earlier.then(result => {
    if (result.status !== 200) prepared.reject(new Error("Erasure refused before the writer started"));
  }, prepared.reject);
  const writer = await store.owner.connect();
  try {
    await prepared.promise;
    await writer.query("BEGIN");
    const pid = await backendPid(writer);
    const later = write(writer, evidence, sku, { orderId: id }).then(() => writer.query("COMMIT"));
    void later.catch(() => undefined);
    await awaitReceiptWait(store.owner, pid, "relation", "ShareLock");
    resume.resolve();
    const erased = receipt(await earlier, "ERASED");
    await mismatch(later, "/taxEvidence", recoverEvidence);
    expect((await store.owner.query("SELECT 1 FROM public.commerce_orders WHERE id=$1", [id])).rows).toEqual([]);

    // A historically complete receipt predates the additional obligations. The
    // contributor version and identity still qualify for replay without money rows.
    await store.owner.query(`UPDATE public.identity_privacy_erasures SET
      dispositions=(SELECT jsonb_agg(CASE WHEN d->>'contributorId'='destination-documents'
        THEN jsonb_set(d,'{obligations}',(SELECT jsonb_agg(o) FROM jsonb_array_elements(d->'obligations') o
          WHERE o->>'resource' NOT LIKE 'commerce.order-money-%')) ELSE d END) FROM jsonb_array_elements(dispositions) d),
      retained_obligations=(SELECT jsonb_agg(o) FROM jsonb_array_elements(retained_obligations) o
        WHERE o->>'resource' NOT LIKE 'commerce.order-money-%') WHERE erasure_id=$1`, [erased.erasureId]);
    const historical = receipt(await erasure(store, actor)(evidence.clientId, key), "ALREADY_ERASED");
    expect(historical.erasureId).toBe(erased.erasureId);
    expect(historical.obligations.every(obligation => !obligation.resource.startsWith("commerce.order-money-"))).toBe(true);
  } finally {
    resume.resolve();
    await writer.query("ROLLBACK");
    writer.release();
    await earlier;
  }
});

it("refuses mixed marker arms, old receipts and redaction that changes any retained column", async () => {
  const evidence = await fullEvidence(store, sku);
  await mismatch(writeOrder(store, evidence, sku, { bucketErased: true }), "/deliveryBuckets");
  await mismatch(writeOrder(store, evidence, sku, { erased: true, bucketErased: false }), "/taxEvidence", recoverEvidence);
  const { id } = await writeOrder(store, evidence, sku);
  const actor = await operator(store.owner);
  const key = randomUUID();
  const before = moneyRows(await capture(store.owner, store.inventory, "before-refused-erasure"));
  // Temporarily disabled the named receipt binding in a disposable database.
  const omitted = await erasure(store, actor, { omitMoneyDispositions: true })(evidence.clientId, key);
  expect(omitted).toMatchObject({ status: 503, response: { ok: false,
    error: { details: { privacyCode: "PRIVACY_ASSESSMENT_UNAVAILABLE" } } } });
  expect((await store.owner.query("SELECT 1 FROM public.identity_privacy_erasures WHERE idempotency_key=$1", [key])).rows)
    .toEqual([]);
  expect(moneyRows(await capture(store.owner, store.inventory, "after-refused-erasure"))).toStrictEqual(before);

  const changed = (db: PoolClient) => db.query(`UPDATE public.${snapshots} SET destination_erased=true,
    destination_digest=NULL,destination_policy_revision=NULL,delivery_selection_ref=NULL,accepted_money_digest=repeat('e',64)
    WHERE order_id=$1`, [id]);
  await withoutGuard(snapshots, guardName(snapshots), changed);
  await mismatch(transaction(store.owner, changed), "/taxEvidence", immutable);
  const valid = receipt(await erasure(store, actor)(evidence.clientId, key), "ERASED");
  await provedErasure(store, evidence, id, valid.erasureId);
  await mismatch(store.owner.query(`UPDATE public.${snapshots} SET accepted_money_digest=repeat('e',64) WHERE order_id=$1`, [id]),
    "/taxEvidence", immutable);
  await mismatch(store.owner.query(`UPDATE public.${snapshots} SET destination_snapshot_ref=gen_random_uuid() WHERE order_id=$1`, [id]),
    "/taxEvidence", immutable);
});

it("refuses borrowed, pending, corrupted and legacy-sealed evidence at the installed boundary", async () => {
  const borrowed = await issue(store, sku, false);
  await mismatch(writeOrder(store, borrowed, sku, { clientId: await receiptClient(store.owner) }), "/taxEvidence", recoverEvidence);
  for (const options of [{ pending: true }, { legacySeal: true }]) {
    await mismatch(writeOrder(store, await issue(store, sku, false, undefined, options), sku), "/taxEvidence", recoverEvidence);
  }
  const corrupted = await issue(store, sku, false);
  // Temporarily disabled the calculation storage guard in a disposable database transaction.
  await mismatch(transaction(store.owner, async db => {
    await db.query("ALTER TABLE public.tax_calculations DISABLE TRIGGER tax_calculation_guard");
    await db.query("UPDATE public.tax_calculations SET outcome_text=outcome_text||' ' WHERE calculation_id=$1",
      [corrupted.quote.taxEvidence.calculationId]);
    await write(db, corrupted, sku);
  }), "/taxEvidence", recoverEvidence);
});
