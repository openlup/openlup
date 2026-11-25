import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { PoolClient } from "pg";
import { CATALOG_DRAFT_MAX_BYTES } from "@openlup/platform/catalog/contracts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { flatTestTimeoutMs } from "../../scripts/ci-vitest-duration-keys.js";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutations, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { issue, type Evidence, write } from "./orderMoneyV2Guards.fixture.js";
import {
  calculationKey, checkMessage, expectSqlError, fees, foreignKeyMessage, insert, itemFk, itemTable, orderFk, orderTable, positions, quoteKey,
  rejected, seedSku, snapshots, sources, transaction, uniqueMessage, version,
} from "./orderMoneyV2Storage.fixture.js";

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Expected native catalogue");
const unit = manifest.forward.find(entry => entry.file.endsWith("_order_money_v2_assert.sql"));
if (!unit) throw new Error("Expected order money assertion forward");
const position = manifest.qualified.forward.findIndex(entry => entry.file === unit.file);
const prefixInventory = "6ffc2de73b50852f70c99fb1529521d753e2859a7d1f6e8f618a4aae33f967fb";
const routine = "public.commerce_order_money_v2_assert(uuid,boolean,boolean,jsonb,jsonb)";
const checkState = "public.commerce_order_money_v2_check_state(uuid,boolean,text,text)";
const evidenceRemedy = "Recover the original accepted evidence through its owner and retry with its original binding.";
const liveBody = "public.commerce_order_money_v2_live_body";
const path = "db/platform/migrations/20261125010000_catalog_purchase_admission.sql";
const message = "commerce_order_money_v2_mismatch";
const restoreTables = ["commerce_order_tax_snapshots", "commerce_order_line_sources", "commerce_order_delivery_buckets",
  "commerce_order_line_allocations", "commerce_order_tax_positions", "commerce_order_fee_lines", "identity_privacy_erasures"];
let store: AccountMutationsStore;
let sku: Awaited<ReturnType<typeof seedSku>>;
let applied: string[];

const writeChecked = (evidence: Evidence, options?: Parameters<typeof write>[3]) =>
  transaction(store.owner, db => write(db, evidence, sku, options));

async function expectMismatch(result: Promise<unknown>, field: string, hint?: string) {
  const error = await rejected(result);
  expectSqlError(error, "23514", message);
  expect(error).toMatchObject({ column: field, detail: undefined, ...(hint === undefined ? {} : { hint }) });
}

async function mutateRoutine(db: PoolClient, signature: string, edits: readonly (readonly [string, string])[]) {
  let source = (await db.query<{ sql: string }>("SELECT pg_get_functiondef($1::regprocedure) AS sql", [signature])).rows[0]!.sql;
  for (const [before, after] of edits) {
    expect(source).toContain(before);
    source = source.replace(before, after);
  }
  await db.query(source);
}

async function queueHeaderCheck(db: PoolClient, id: string) {
  await db.query("UPDATE public.commerce_orders SET updated_at=now() WHERE id=$1", [id]);
  await db.query("SET CONSTRAINTS trg_commerce_orders_line_sum IMMEDIATE");
}

async function defs() {
  return (await store.owner.query<{ source: string }>(`SELECT pg_get_functiondef(p.oid) as source
    FROM pg_proc p WHERE p.oid IN ('public.catalog_order_acceptance_final(uuid)'::regprocedure,
    'public.catalog_order_line_sum_acceptance(uuid,uuid,public.commerce_orders,public.commerce_orders)'::regprocedure,
    'public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)'::regprocedure) ORDER BY p.proname`)).rows;
}
let predecessorDefinitions: Awaited<ReturnType<typeof defs>>;

beforeAll(async () => {
  const prefix = structuredClone(manifest);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
    const index = plan.forward.findIndex(entry => entry.file === unit.file);
    plan.forward = plan.forward.slice(0, index);
  }
  prefix.qualified.objectInventorySha256.bootstrapMigrator.withRestore = prefixInventory;
  await withPlatformCatalog(prefix, async root => {
    store = await installAccountMutations("bootstrap", false, "order-guards-prefix", root);
    predecessorDefinitions = await defs();
    sku = await seedSku(store.owner);
    applied = (await store.runner.apply()).applied;
  });
}, postgresSetupTimeoutMs);

afterAll(() => store?.close(), postgresTeardownTimeoutMs);

it("applies its own forward and preserves the other checkout definitions", async () => {
  expect(applied.slice(0, 1)).toEqual([unit.file]);
  expect((await store.owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations WHERE position=$1",
    [position + 1])).rows).toEqual([{ catalog_path: unit.file, sha256: unit.sha256, position: position + 1 }]);
  expect(await defs()).toStrictEqual(predecessorDefinitions);
});

it("order_money_legacy_block_byte_identity", async () => {
  const { rows: [row] } = await store.owner.query<{ prosrc: string }>(
    "SELECT prosrc FROM pg_proc WHERE oid='public.commerce_order_assert_line_sum()'::regprocedure");
  const block = row!.prosrc.slice(row!.prosrc.indexOf("  SELECT total_amount_minor"),
    row!.prosrc.lastIndexOf("\n\n  PERFORM public.catalog_order_line_sum_acceptance(v_order_id);") + 1);
  expect(Buffer.from(block)).toEqual(Buffer.from(readFileSync(path, "utf8").split("\n").slice(931, 955).join("\n") + "\n"));
  expect(Buffer.byteLength(block)).toBe(939);
  expect(createHash("sha256").update(block).digest("hex")).toBe("c1b997aff2e805edd7496b8714cdc66ad554c00c81766e88c6bf37fbd6fa2b5c");

  const amount = { currency: "XXX", amountMinor: 100 };
  const line = { sku: sku.sku, quantity: 1, unitPriceGross: amount, lineSubtotalGross: amount };
  const context = { mode: "one_time", promoCodes: [] };
  const quote = { contractVersion: "commerce.v0", quote: { currency: "XXX", context, lines: [line], totalGross: amount } };
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft",
    paymentStatus: "not_started", currency: "XXX", context, lines: [line], totals: { totalGross: amount } };
  const { rows: [response] } = await store.runtime.query<{ value: { orderDraft: { orderId: string } } }>(
    "SELECT public.commerce_create_order_draft_with_outbox($1,$2,$3,NULL) AS value", [randomUUID(), quote, draft]);
  const id = response!.value.orderDraft.orderId.slice("order_".length);
  expect((await store.runtime.query(`SELECT o.money_version,i.line_key FROM public.commerce_orders o
    JOIN public.commerce_order_items i ON i.order_id=o.id WHERE o.id=$1`, [id])).rows)
    .toEqual([{ money_version: null, line_key: null }]);
  expectSqlError(await rejected(store.runtime.query("UPDATE public.commerce_orders SET total_amount_minor=101 WHERE id=$1", [id])),
    "23514", "commerce_order_line_sum_mismatch");
});

it("runs the legacy sum on queued keyed item images and refuses a stored key on a balanced legacy order", async () => {
  const order = randomUUID();
  await insert(store.runtime, orderTable, { id: order, currency_code: "XXX", total_amount_minor: 0 });
  const writeKey = async (db: PoolClient, queuedOnly: boolean) => {
    const id = randomUUID(), amount = queuedOnly ? 1 : 0;
    await insert(db, itemTable, { id, order_id: order, sku_id: sku.id, line_ordinal: 1,
      quantity: 1, unit_amount_minor: amount, line_amount_minor: amount, line_key: "pending-key" });
    if (queuedOnly) await db.query("UPDATE public.commerce_order_items SET line_key=NULL WHERE id=$1", [id]);
    // Isolate the order guard from the independently deferred item foreign key.
    await db.query("SET CONSTRAINTS trg_commerce_order_items_line_sum IMMEDIATE");
  };
  expectSqlError(await rejected(transaction(store.owner, db => writeKey(db, true), "ROLLBACK")),
    "23514", "commerce_order_line_sum_mismatch");
  await expectMismatch(transaction(store.runtime, db => writeKey(db, false), "ROLLBACK"), "/lines");

  // Temporarily disabled the legacy branch for keyed images in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, "public.commerce_order_assert_line_sum()", [
      ["IF v_event_marker OR", "IF v_keyed_item OR v_event_marker OR"],
      ["ELSIF TG_OP<>'INSERT' AND", "ELSIF (v_version IS NOT NULL OR v_other_version IS NOT NULL) AND TG_OP<>'INSERT' AND"],
    ]);
    await writeKey(db, true);
  }, "ROLLBACK");
  // Temporarily disabled legacy key validation in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [
      ["SELECT FROM public.commerce_order_items WHERE order_id=p_order_id AND line_key IS NOT NULL", "SELECT WHERE false"],
    ]);
    await writeKey(db, false);
  }, "ROLLBACK");
});

it("reconstructs the accepted money digest for the owner and refuses direct runtime access", async () => {
  const evidence = await issue(store, sku, false);
  const { id } = await writeChecked(evidence);
  const { rows } = await store.owner.query(`
    SELECT accepted_money_digest AS accepted,
      encode(sha256(convert_to(public.catalog_publication_canonical(
        jsonb_build_array('commerce.quote-money.v2',${liveBody}(order_id)),0),'UTF8')),'hex') AS replayed
    FROM public.commerce_order_tax_snapshots WHERE order_id=$1`, [id]);
  expect(rows).toEqual([{ accepted: evidence.quote.moneyDigest, replayed: evidence.quote.moneyDigest }]);
  expectSqlError(await rejected(store.runtime.query(`SELECT ${liveBody}($1)`, [id])), "42501",
    "permission denied for function commerce_order_money_v2_live_body");
});

it("uses trigger depth to fence a direct call against an inconsistent order", async () => {
  const { id } = await writeChecked(await issue(store, sku, false));
  const direct = `SELECT ${routine.split("(")[0]}($1,false,false)`;
  const changePayable = (db: PoolClient) =>
    db.query("UPDATE public.commerce_orders SET total_amount_minor=total_amount_minor+1 WHERE id=$1", [id]);
  await transaction(store.runtime, async db => {
    await changePayable(db);
    await expect(db.query(direct, [id])).resolves.toBeDefined();
    await expectMismatch(db.query("SET CONSTRAINTS trg_commerce_orders_line_sum IMMEDIATE"), "/payableMinor");
  }, "ROLLBACK");
  // Temporarily disabled the trigger-depth gate in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [["IF pg_trigger_depth() = 0 THEN RETURN; END IF;", ""]]);
    await db.query("SET LOCAL ROLE service_role");
    await changePayable(db);
    await expectMismatch(db.query(direct, [id]), "/payableMinor");
  }, "ROLLBACK");
});

it.each([true, false])("checks a fresh composition seal and commits valid money with inclusive=%s", async inclusive => {
  const evidence = await issue(store, sku, inclusive);
  const { id, itemIds } = await writeChecked(evidence);
  await expect(store.runtime.query("UPDATE public.commerce_orders SET updated_at=now() WHERE id=$1", [id])).resolves.toBeDefined();
  await expectMismatch(store.runtime.query("UPDATE public.commerce_orders SET money_version=NULL WHERE id=$1", [id]), "/moneyVersion");
  await expectMismatch(store.runtime.query("UPDATE public.commerce_orders SET total_amount_minor=101 WHERE id=$1", [id]), "/payableMinor");
  await expectMismatch(store.runtime.query("UPDATE public.commerce_orders SET currency_code='ZZZ' WHERE id=$1", [id]), "/payableMinor");
  await expectMismatch(transaction(store.runtime, db => insert(db, itemTable, {
    order_id: id, sku_id: sku.id, line_ordinal: 2, quantity: 1, unit_amount_minor: 0, line_amount_minor: 0,
  })), "/lines");
  await expectMismatch(transaction(store.runtime, db => insert(db, itemTable, {
    order_id: id, sku_id: sku.id, line_ordinal: 2, quantity: 1, unit_amount_minor: 0, line_amount_minor: 0,
    line_key: evidence.quote.lines[0]!.lineKey,
  })), "/lines");
  await expectMismatch(store.runtime.query("DELETE FROM public.commerce_order_items WHERE id=$1", [itemIds[0]]), "/lines");
  await expect(store.runtime.query("SELECT 1 FROM public.commerce_order_tax_snapshots")).rejects.toMatchObject({ code: "42501" });
});

it("preserves the named foreign-key refusals at runtime", async () => {
  const bad = randomUUID();
  expectSqlError(await rejected(transaction(store.runtime, db => insert(db, orderTable, {
    id: bad, money_version: version, currency_code: "XXX", total_amount_minor: 100,
  }))), "23503", foreignKeyMessage(orderTable, orderFk), orderFk);
  const { id } = await writeChecked(await issue(store, sku, false));
  expectSqlError(await rejected(transaction(store.runtime, db => insert(db, itemTable, {
    order_id: id, sku_id: sku.id, line_ordinal: 2, quantity: 1, unit_amount_minor: 0, line_amount_minor: 0, line_key: "missing",
  }))), "23503", foreignKeyMessage(itemTable, itemFk), itemFk);
});

it.each([true, false])("checks fresh evidence when the snapshot is inserted first=%s", async snapshotFirst => {
  const evidence = await issue(store, sku, false);
  const first = snapshotFirst ? "trg_commerce_order_items_line_sum" : "trg_commerce_orders_line_sum";
  const second = snapshotFirst ? "trg_commerce_orders_line_sum" : "trg_commerce_order_items_line_sum";
  const flush = async (db: PoolClient, snapshot?: Record<string, unknown>) => {
    await write(db, evidence, sku, { snapshotFirst, snapshot });
    await db.query(`SET CONSTRAINTS ${first} IMMEDIATE`);
    await db.query(`SET CONSTRAINTS ${second} IMMEDIATE`);
  };
  await expectMismatch(transaction(store.owner, db => flush(db, { accepted_quote_id: randomUUID() })),
    "/taxEvidence", evidenceRemedy);
  await transaction(store.owner, db => flush(db));
});

it.each(["header", "item"])("refuses an absent snapshot when the %s constraint fires before the foreign key", async event => {
  const evidence = await issue(store, sku, false);
  const id = randomUUID();
  const flushWithoutSnapshot = (db: PoolClient, snapshot?: Record<string, unknown>) =>
    write(db, evidence, sku, { orderId: id, snapshot, beforeSnapshot: async () => {
      if (event === "item") await insert(db, itemTable, {
        order_id: id, sku_id: sku.id, line_ordinal: 2, quantity: 1, unit_amount_minor: 0, line_amount_minor: 0,
        line_key: evidence.quote.lines[0]!.lineKey,
      });
      const name = event === "header" ? "trg_commerce_orders_line_sum" : "trg_commerce_order_items_line_sum";
      await db.query(`SET CONSTRAINTS ${name} IMMEDIATE`);
      if (event === "item") {
        await db.query("SET CONSTRAINTS trg_commerce_order_items_line_sum DEFERRED");
        await db.query("DELETE FROM public.commerce_order_items WHERE order_id=$1", [id]);
      }
    } });
  const error = await rejected(transaction(store.owner, flushWithoutSnapshot));
  expectSqlError(error, "23503", foreignKeyMessage(orderTable, orderFk), orderFk);
  expect(error).toMatchObject({ schema: "public", table: orderTable });
  expect((await store.owner.query("SELECT FROM public.commerce_orders WHERE id=$1", [id])).rowCount).toBe(0);
  // Temporarily disabled the missing-snapshot refusal in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [["IF snapshot.order_id IS NULL THEN", "IF snapshot.order_id IS NULL THEN RETURN; ELSIF false THEN"]]);
    await flushWithoutSnapshot(db, event === "header" ? { accepted_quote_id: randomUUID() } : undefined);
    if (event === "header") await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  }, "ROLLBACK");
});

it("checks an unchanged projection once and rechecks after a constraint flush, including private writes", async () => {
  const evidence = await issue(store, sku, false);
  const exercise = async (db: PoolClient, expectedCalls: string, checkLaterWrite: boolean) => {
    await db.query("CREATE TEMP SEQUENCE money_body_calls");
    await mutateRoutine(db, `${liveBody}(uuid)`, [["  WITH snapshot AS (", `  WITH calls AS (
      SELECT nextval('pg_temp.money_body_calls')
    ), snapshot AS (`], [
      "FROM public.commerce_order_tax_snapshots WHERE", "FROM calls CROSS JOIN public.commerce_order_tax_snapshots WHERE",
    ]]);
    const { id } = await write(db, evidence, sku);
    await db.query("SET CONSTRAINTS trg_commerce_order_items_line_sum IMMEDIATE");
    await db.query("SET CONSTRAINTS trg_commerce_orders_line_sum IMMEDIATE");
    expect((await db.query("SELECT last_value::text AS calls, is_called FROM pg_temp.money_body_calls")).rows)
      .toEqual([{ calls: expectedCalls, is_called: true }]);
    await db.query("SET CONSTRAINTS trg_commerce_orders_line_sum DEFERRED");
    await db.query("UPDATE public.commerce_orders SET updated_at=now() WHERE id=$1", [id]);
    await db.query(`UPDATE public.${sources} SET assignment_ref='changed' WHERE order_id=$1`, [id]);
    const flush = db.query("SET CONSTRAINTS trg_commerce_orders_line_sum IMMEDIATE");
    if (checkLaterWrite) await expectMismatch(flush, "/acceptedMoneyDigest");
    else await flush;
  };
  await transaction(store.owner, db => exercise(db, "1", true), "ROLLBACK");
  // Temporarily disabled duplicate skipping in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, checkState, [["check_projection := last_stamp IS DISTINCT FROM p_stamp;", "check_projection := true;"]]);
    await exercise(db, "2", true);
  }, "ROLLBACK");
  // Temporarily disabled invalidation after the first check in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, checkState, [["check_projection := last_stamp IS DISTINCT FROM p_stamp;", "check_projection := last_stamp IS NULL;"]]);
    await exercise(db, "1", false);
  }, "ROLLBACK");
});

it("keeps fresh seal checks after a successful header flush", async () => {
  const evidence = await issue(store, sku, false);
  const alterAfterFlush = async (db: PoolClient) => {
    const { id } = await write(db, evidence, sku);
    await db.query("SET CONSTRAINTS trg_commerce_orders_line_sum IMMEDIATE");
    await db.query(`UPDATE public.${snapshots} SET accepted_quote_id=$2 WHERE order_id=$1`, [id, randomUUID()]);
    await db.query("SET CONSTRAINTS trg_commerce_order_items_line_sum IMMEDIATE");
  };
  await expectMismatch(transaction(store.owner, alterAfterFlush), "/taxEvidence", evidenceRemedy);
  // Temporarily disabled remembered freshness in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, checkState, [["fresh := p_fresh OR coalesce(was_fresh,false);", "fresh := p_fresh;"]]);
    await alterAfterFlush(db);
  }, "ROLLBACK");
});

it("refuses both sides of a move across legacy and versioned orders", async () => {
  const evidence = await issue(store, sku, false);
  const v2 = await writeChecked(evidence);
  const legacy = randomUUID(), item = randomUUID();
  await transaction(store.owner, async db => {
    await insert(db, orderTable, { id: legacy, currency_code: "XXX", total_amount_minor: 0 });
    await insert(db, itemTable, { id: item, order_id: legacy, sku_id: sku.id, line_ordinal: 2, quantity: 1,
      unit_amount_minor: 0, line_amount_minor: 0 });
  });
  await expectMismatch(store.owner.query("UPDATE public.commerce_order_items SET order_id=$2,line_key=NULL WHERE id=$1", [v2.itemIds[0], legacy]), "/lines");
  await expectMismatch(store.owner.query("UPDATE public.commerce_order_items SET order_id=$2,line_key=$3 WHERE id=$1", [item, v2.id, evidence.quote.lines[0]!.lineKey]), "/lines");
  await expectMismatch(store.owner.query("DELETE FROM public.commerce_order_items WHERE id=$1", [v2.itemIds[0]]), "/lines");
  expect((await store.owner.query("SELECT id,order_id FROM public.commerce_order_items WHERE id=ANY($1::uuid[]) ORDER BY id",
    [[item,v2.itemIds[0]]])).rows).toEqual([{ id: item, order_id: legacy }, { id: v2.itemIds[0], order_id: v2.id }]
      .sort((a,b) => a.id.localeCompare(b.id)));
});

it("refuses reserved cycle, borrowed evidence, wrong SKU, and equal-payable substitutions", async () => {
  const evidence = await issue(store, sku, false);
  const other = await seedSku(store.owner);
  await expectMismatch(writeChecked(evidence, { snapshot: { accepted_quote_id: null, accepted_quote_digest: null,
    token_digest: null, acceptance_ref: null, cycle_binding_ref: randomUUID() } }), "/cycleBindingRef");
  const alien = (await store.owner.query<{ id: string }>("INSERT INTO public.clients(email) VALUES ($1) RETURNING id",
    [randomUUID() + "@example.invalid"])).rows[0]!.id;
  await expectMismatch(writeChecked(evidence, { clientId: alien }), "/taxEvidence");
  await expectMismatch(writeChecked(evidence, { source: { sku_id: other.id }, item: { sku_id: other.id } }), "/lines");
  await expectMismatch(writeChecked(evidence, { source: { assignment_ref: "alternate" } }), "/acceptedMoneyDigest");
  await expect(writeChecked(evidence)).resolves.toBeDefined();
});

it("requires a final composition and independently enforces consumption keys", async () => {
  const pendingEvidence = await issue(store, sku, false, undefined, { pending: true });
  await expectMismatch(writeChecked(pendingEvidence), "/taxEvidence");
  const legacyEvidence = await issue(store, sku, true, undefined, { legacySeal: true });
  await expectMismatch(writeChecked(legacyEvidence), "/taxEvidence");

  const original = await issue(store, sku, false);
  await writeChecked(original);
  const distinct = await issue(store, sku, false);
  const byQuote = await rejected(writeChecked(distinct, { snapshot: { accepted_quote_id: original.quote.quoteId } }));
  expectSqlError(byQuote, "23505", uniqueMessage(quoteKey), quoteKey);
  const byCalculation = await rejected(writeChecked(distinct, { snapshot: { calculation_id: original.quote.taxEvidence.calculationId } }));
  expectSqlError(byCalculation, "23505", uniqueMessage(calculationKey), calculationKey);
  await expect(writeChecked(distinct)).resolves.toBeDefined();
});

it.each([
  ["accepted_quote_id", "OR verified_quote->'quoteId' IS DISTINCT FROM to_jsonb(snapshot.accepted_quote_id)", randomUUID()],
  ["accepted_quote_digest", "OR verified_quote->>'quoteDigest' IS DISTINCT FROM snapshot.accepted_quote_digest", "0".repeat(64)],
])("independently verifies the sealed %s", async (key, comparison, changedValue) => {
  const evidence = await issue(store, sku, false);
  const changed = { snapshot: { [key]: changedValue } };
  await expectMismatch(writeChecked(evidence, changed), "/taxEvidence", evidenceRemedy);
  // Temporarily disabled just this quote comparison in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [[comparison, ""]]);
    await write(db, evidence, sku, changed);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  }, "ROLLBACK");
  await writeChecked(evidence);
});

it.each([
  ["principalRef", randomUUID()],
  ["installationRef", "other-installation"],
])("compares the destination and terminal evaluation %s", async (coordinate, different) => {
  const evidence = await issue(store, sku, false);
  const tryMismatch = async (db: PoolClient) => {
    // Edit a fixture row at its owner boundary while retaining a verifiable evaluation.
    await db.query("ALTER TABLE public.tax_calculations DISABLE TRIGGER tax_calculation_guard");
    await db.query(`UPDATE public.tax_calculations t SET
      identity=jsonb_set(t.identity,ARRAY[$2],to_jsonb($3::text)),
      locator=public.tax_calculation_hash_v1('evaluation-key',jsonb_set(t.identity,ARRAY[$2],to_jsonb($3::text)))
      WHERE calculation_id=$1`, [evidence.quote.taxEvidence.calculationId, coordinate, different]);
    expect((await db.query(`SELECT public.tax_calculation_terminal_v1(t)#>>'{outcome,quote,quoteId}' AS id
      FROM public.tax_calculations t WHERE calculation_id=$1`, [evidence.quote.taxEvidence.calculationId])).rows)
      .toEqual([{ id: evidence.quote.quoteId }]);
    await write(db, evidence, sku);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  };
  await expectMismatch(transaction(store.owner, tryMismatch), "/taxEvidence", evidenceRemedy);
  // Temporarily disabled just this owner comparison in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [[`AND d.owner_scope->>'${coordinate}'=calculation.identity->>'${coordinate}'`, ""]]);
    await tryMismatch(db);
  }, "ROLLBACK");
  await writeChecked(evidence);
});

it("refuses an otherwise matching terminal quote with a corrupted seal digest", async () => {
  const evidence = await issue(store, sku, false);
  const corrupt = async (db: PoolClient) => {
    await db.query("ALTER TABLE public.tax_calculations DISABLE TRIGGER tax_calculation_guard");
    await db.query("UPDATE public.tax_calculations SET outcome_digest=$2 WHERE calculation_id=$1",
      [evidence.quote.taxEvidence.calculationId, "0".repeat(64)]);
    expect((await db.query(`SELECT state, pin ? 'composition' AS composed, identity->>'clientId' AS client,
        public.tax_calculation_terminal_v1(t) IS NULL AS invalid
      FROM public.tax_calculations t WHERE calculation_id=$1`, [evidence.quote.taxEvidence.calculationId])).rows)
      .toEqual([{ state: "terminal", composed: true, client: evidence.clientId, invalid: true }]);
    await write(db, evidence, sku);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  };
  await expectMismatch(transaction(store.owner, corrupt), "/taxEvidence", evidenceRemedy);
  // Temporarily disabled terminal seal verification in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [[`public.tax_calculation_terminal_v1(calculation)#>'{outcome,quote}'`,
      `(calculation.outcome_text::jsonb)->1#>'{outcome,quote}'`]]);
    await corrupt(db);
  }, "ROLLBACK");
  await writeChecked(evidence);
});

async function eraseEvidence(db: PoolClient, clientId: string) {
  await db.query("LOCK TABLE public.identity_privacy_erasures IN SHARE ROW EXCLUSIVE MODE");
  await db.query("SELECT public.commerce_destination_v2_erase($1)", [clientId]);
  await db.query("SELECT public.tax_calculation_erase_v1($1)", [clientId]);
}

async function recordErasure(db: PoolClient, clientId: string) {
  const actor = randomUUID();
  await insert(db, "platform_human_principals", { principal_id: actor, email: `${actor}@example.invalid` });
  await db.query(`INSERT INTO public.identity_privacy_erasures
    (erasure_id,idempotency_key,client_id,actor_principal_id,contract_version,completed_at,
      contributor_versions,dispositions,retained_obligations)
    VALUES(gen_random_uuid(),gen_random_uuid(),$1,$2,'identity.erasure.v1',clock_timestamp(),$3,$4,'[]')`,
  [clientId, actor, { "destination-documents": "commerce.destination-documents.v1", "tax-calculations": "platform.tax-calculations.v1" },
    JSON.stringify([{ contributorId: "destination-documents", version: "commerce.destination-documents.v1", obligations: [
      { owner: "destination-documents", resource: "commerce.order-money-destination-pins", disposition: "erase", remote: false },
      { owner: "destination-documents", resource: "commerce.order-money-retained-facts", disposition: "retain", remote: false },
    ] }])]);
}

it("allows only the named, same-transaction erasure with immutable accepted facts", async () => {
  const evidence = await issue(store, sku, false);
  const { id } = await writeChecked(evidence);
  // Supply the queued row images via a disposable witness trigger. The
  // assertion forward has no storage-trigger registration.
  const attempt = (substituteDigest: boolean) => transaction(store.owner, async db => {
    await db.query(`CREATE FUNCTION public.fixture_check_redaction() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        PERFORM public.commerce_order_money_v2_assert(NEW.order_id,false,false,to_jsonb(OLD),to_jsonb(NEW));
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER fixture_check_redaction AFTER UPDATE ON public.commerce_order_tax_snapshots
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fixture_check_redaction()`);
    await eraseEvidence(db, evidence.clientId);
    await recordErasure(db, evidence.clientId);
    await db.query(`UPDATE public.commerce_order_tax_snapshots SET destination_erased=true,
      destination_digest=NULL,destination_policy_revision=NULL,delivery_selection_ref=NULL,
      accepted_money_digest=CASE WHEN $2::boolean THEN repeat('b',64) ELSE accepted_money_digest END WHERE order_id=$1`,
    [id, substituteDigest]);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  }, "ROLLBACK");
  await expectMismatch(attempt(true), "/taxEvidence");
  await expect(attempt(false)).resolves.toBeUndefined();
});

async function ownerRestore(db: PoolClient, tables = restoreTables) {
  await db.query("LOCK TABLE " + tables.map(table => "public." + table).join(",") + " IN SHARE ROW EXCLUSIVE MODE");
}

it("honors the owner restore fence, skips live provenance at restore, and checks the retained digest", async () => {
  const evidence = await issue(store, sku, false);
  await expect(transaction(store.owner, async db => {
    await ownerRestore(db);
    await write(db, evidence, sku);
  })).resolves.toBeUndefined();
  const erasedFresh = await issue(store, sku, false);
  await expectMismatch(writeChecked(erasedFresh, { erased: true }), "/taxEvidence", evidenceRemedy);
  // Temporarily disabled the recovery remedy in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [[
      "COLUMN='/taxEvidence', HINT=evidence_remedy;\n  END IF;\n  IF snapshot.destination_erased",
      "COLUMN='/taxEvidence', HINT=remedy;\n  END IF;\n  IF snapshot.destination_erased",
    ]]);
    await write(db, erasedFresh, sku, { erased: true });
    const error = await rejected(db.query("SET CONSTRAINTS ALL IMMEDIATE"));
    expectSqlError(error, "23514", message);
    expect(error).toMatchObject({ column: "/taxEvidence", hint: "Replay the original accepted document and its digest." });
  }, "ROLLBACK");
});

it("split_items_map_to_source retains a one-cent tax reduction and the unpromoted source", async () => {
  const promotion = "offer-" + randomUUID();
  const evidence = await issue(store, sku, true, body => {
    const source = body.lines[0]!;
    const position = source.taxPositions[0]!;
    const before = { basisMinor: 200, netMinor: 199, taxMinor: 1,
      taxPositions: [{ ...position, taxableMinor: 199, taxMinor: 1 }] };
    const after = { basisMinor: 199, netMinor: 199, taxMinor: 0,
      taxPositions: [{ ...position, taxableMinor: 199, taxMinor: 0 }] };
    return { ...body, lines: [{
      ...source, lineKey: "source-z", quantity: 2, unitBasisMinor: 100, sourceOrdinal: 1,
      preDiscountMinor: 200, effectiveMinor: 199, netMinor: 199, taxMinor: 0, lineTotalMinor: 199,
      taxPositions: after.taxPositions,
      discountAllocations: [{ allocationId: randomUUID(), adjustmentRef: promotion, sequence: 1, source: "legacy_promotion",
        basisReductionMinor: 1, netReductionMinor: 0, taxReductionMinor: 1, evidenceRef: "b".repeat(64), before, after }],
    }, {
      ...source, lineKey: "source-a", sourceOrdinal: 3, taxPositions: [{ ...position, positionRef: "second-position" }],
    }], netTotal: 299, payableMinor: 299 };
  }, { promotions: [{ id: promotion, lineKey: "source-z" }] });
  await expectMismatch(writeChecked(evidence, { item: { promotion_allocation_fingerprint: null } }), "/lines");
  await expectMismatch(writeChecked(evidence, { item: { source_line_ordinal: 3 } }), "/lines");
  await expectMismatch(writeChecked(evidence, { source: { source_rank: 2 } }), "/lines");
  // Temporarily disabled per-item positional fingerprint presence in a disposable database transaction.
  await transaction(store.owner, async db => {
    const source = (await db.query<{ sql: string }>("SELECT pg_get_functiondef($1::regprocedure) AS sql", [routine])).rows[0]!.sql;
    const mutant = source.replace("AND i.promotion_allocation_fingerprint IS NOT NULL END", "END");
    expect(mutant).not.toBe(source);
    await db.query(mutant);
    await write(db, evidence, sku, { item: { promotion_allocation_fingerprint: null } });
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  }, "ROLLBACK");
  const { id } = await writeChecked(evidence);
  expect((await store.owner.query(`SELECT line_ordinal,source_line_ordinal,line_key,promotion_allocation_fingerprint
    FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal`, [id])).rows).toMatchObject([
    { line_ordinal: 1, source_line_ordinal: 1, line_key: "source-z", promotion_allocation_fingerprint: "a".repeat(64) },
    { line_ordinal: 2, source_line_ordinal: 1, line_key: "source-z", promotion_allocation_fingerprint: "a".repeat(64) },
    { line_ordinal: 3, source_line_ordinal: null, line_key: "source-a", promotion_allocation_fingerprint: null },
  ]);
});

it("requires the same-order tombstone and receipt on the erased restore arm", async () => {
  const evidence = await issue(store, sku, false, body => ({
    ...body,
    deliveryBuckets: [{ bucketKey: "handling", kind: "handling", carrierRef: "carrier", serviceRef: "service",
      taxClassKey: "class-a", assignmentRef: "assignment-a", cost: { ref: "fee", currency: "XXX", amountMinor: 0 },
      separatelyStated: true, parts: [{ preDiscountMinor: 0, effectiveMinor: 0, netMinor: 0, taxMinor: 0,
        lineTotalMinor: 0, taxPositions: [], discountAllocations: [] }] }],
  }));
  await expectMismatch(transaction(store.owner, async db => {
    await ownerRestore(db);
    await write(db, evidence, sku, { bucketErased: true });
  }), "/deliveryBuckets");
  await transaction(store.owner, db => eraseEvidence(db, evidence.clientId));
  await expectMismatch(transaction(store.owner, async db => {
    await ownerRestore(db);
    await write(db, evidence, sku, { erased: true });
  }), "/taxEvidence");
  await transaction(store.owner, db => recordErasure(db, evidence.clientId));
  await expectMismatch(transaction(store.owner, async db => {
    await ownerRestore(db);
    await write(db, evidence, sku, { erased: true, bucketErased: false });
  }), "/deliveryBuckets");
  const id = randomUUID();
  const restore = async (db: PoolClient, tables: string[]) => {
    await ownerRestore(db, tables);
    await write(db, evidence, sku, { orderId: id, erased: true });
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  };
  const partialLocks = restoreTables.filter(table => table !== fees);
  await expectMismatch(transaction(store.owner, db => restore(db, partialLocks)), "/taxEvidence");
  // Temporarily disabled the fee relation's restore lock requirement in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [[
      ",'public.commerce_order_fee_lines'::regclass))=6", "))=5",
    ]]);
    await restore(db, partialLocks);
  }, "ROLLBACK");
  await transaction(store.owner, db => restore(db, restoreTables));
  await expect(store.runtime.query("UPDATE public.commerce_orders SET updated_at=now() WHERE id=$1", [id])).resolves.toBeDefined();
});

it("refuses a shipping-scoped discount moved to a handling bucket on erased restore", async () => {
  const promotion = { id: `offer-${randomUUID()}`, bucketKey: "shipping" };
  const evidence = await issue(store, sku, false, body => {
    const before = { basisMinor: 2, netMinor: 2, taxMinor: 0, taxPositions: [] };
    const after = { ...before, basisMinor: 1, netMinor: 1 };
    return {
      ...body, netTotal: 101, payableMinor: 101,
      deliveryBuckets: [{
        bucketKey: promotion.bucketKey, kind: "shipping", carrierRef: "carrier", serviceRef: "service",
        taxClassKey: "class-a", assignmentRef: "assignment-a", cost: { ref: "cost", currency: "XXX", amountMinor: 2 },
        separatelyStated: true, parts: [{
          preDiscountMinor: 2, effectiveMinor: 1, netMinor: 1, taxMinor: 0, lineTotalMinor: 1, taxPositions: [],
          discountAllocations: [{ allocationId: randomUUID(), adjustmentRef: promotion.id, evidenceRef: "b".repeat(64),
            sequence: 1, source: "legacy_promotion", basisReductionMinor: 1, netReductionMinor: 1,
            taxReductionMinor: 0, before, after }],
        }],
      }],
    };
  }, { promotions: [promotion] });
  await transaction(store.owner, db => eraseEvidence(db, evidence.clientId));
  await transaction(store.owner, db => recordErasure(db, evidence.clientId));
  const handling: Evidence = { ...evidence, quote: { ...evidence.quote,
    deliveryBuckets: [{ ...evidence.quote.deliveryBuckets[0]!, kind: "handling" }] } };
  const restore = async (db: PoolClient, input: Evidence) => {
    await ownerRestore(db);
    await write(db, input, sku, { erased: true });
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  };
  await expectMismatch(transaction(store.owner, db => restore(db, handling)), "/discountAllocations");
  // Temporarily disabled the shipping bucket kind check in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [["OR (j.scope='shipping' AND h.kind IS DISTINCT FROM 'shipping')", ""]]);
    await restore(db, handling);
  }, "ROLLBACK");
  await transaction(store.owner, db => restore(db, evidence));
});

it("reports the fee collection pointer when a fee key exceeds its UTF-16 bound", async () => {
  const evidence = await issue(store, sku, false, body => ({ ...body, payableMinor: 101, feeTotal: 1, feeLines: [{
    feeKey: "fee", jurisdictionRef: "region", feeKind: "service", amountMinor: 1,
    scope: { kind: "order" }, refundRule: { ref: "rule", revision: "1" },
  }] }));
  const { id } = await writeChecked(evidence);
  const changeFee = async (db: PoolClient) => {
    await db.query("UPDATE public.commerce_order_fee_lines SET fee_key=$2 WHERE order_id=$1", [id, "😀".repeat(65)]);
    await queueHeaderCheck(db, id);
  };
  await expectMismatch(transaction(store.owner, changeFee), "/feeLines");
  // Temporarily disabled fee key validation in a disposable database transaction.
  await transaction(store.owner, async db => {
    await mutateRoutine(db, routine, [["OR NOT public.catalog_publication_text_valid(to_jsonb(fee_key),128,false)", ""]]);
    await expectMismatch(changeFee(db), "/acceptedMoneyDigest");
  }, "ROLLBACK");
});

it("checks rate and timestamp boundaries over typed SQL rows", async () => {
  const rateLimit = "9007199254.740991";
  const evidence = await issue(store, sku, false, body => {
    const line = body.lines[0]!, position = line.taxPositions[0]!, from = position.resolution.effective.from;
    const effective = { from, until: new Date(Date.parse(from) + 1).toISOString() };
    return { ...body, lines: [{ ...line, taxPositions: [{
      ...position, rateDecimal: rateLimit, resolution: { ...position.resolution, effective },
    }] }] };
  });
  const { id } = await writeChecked(evidence);
  const probes = [
    [positions, "rate_decimal='01'", "WHEN p.rate_decimal COLLATE", "WHEN false AND p.rate_decimal COLLATE"],
    [positions, "rate_decimal='0.0000001'", "WHEN p.rate_decimal COLLATE", "WHEN false AND p.rate_decimal COLLATE"],
    [positions, "rate_decimal='9007199254.740992'", "p.rate_decimal::numeric*1000000>9007199254740991", "false"],
    [positions, "effective_from=effective_from+interval '1 microsecond'", "OR at <> date_trunc('milliseconds',at)", ""],
    [positions, "effective_until=effective_from", "OR p.effective_until<=p.effective_from", ""],
    [snapshots, "tax_date=tax_date+interval '1 microsecond'", "OR at <> date_trunc('milliseconds',at)", ""],
    [snapshots, "tax_date=evaluation_expires_at", "OR snapshot.tax_date >= snapshot.evaluation_expires_at", ""],
  ] as const;
  for (const [table, change, check, disabled] of probes) {
    const alter = async (db: PoolClient) => {
      await db.query(`UPDATE public.${table} SET ${change} WHERE order_id=$1`, [id]);
      await queueHeaderCheck(db, id);
    };
    await expectMismatch(transaction(store.owner, alter), "/taxEvidence");
    // Temporarily disabled the matching typed check and digest backstop in a disposable database transaction.
    await transaction(store.owner, async db => {
      await mutateRoutine(db, routine, [
        [check, disabled],
        ...(check.startsWith("OR at") && table === positions ? [[check, disabled] as const] : []),
        ["IF NOT snapshot.destination_erased AND snapshot.accepted_money_digest", "IF false AND snapshot.accepted_money_digest"],
      ]);
      await alter(db);
    }, "ROLLBACK");
  }
});

async function timeCommit(evidence: Evidence, basis: string, maximumMs = flatTestTimeoutMs(false, true)) {
  let commitStarted = 0;
  await transaction(store.owner, async db => {
    await write(db, evidence, sku);
    commitStarted = performance.now();
  });
  const elapsed = performance.now() - commitStarted;
  console.info(`Bounded order commit (${basis}) took ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThan(maximumMs);
}

const boundedHandling = (): Evidence["quote"]["deliveryBuckets"] => Array.from({ length: 256 }, (_, index) => ({
  bucketKey: `handling-${index}`, kind: "handling", carrierRef: "carrier", serviceRef: "service",
  taxClassKey: "class-a", assignmentRef: "assignment-a", cost: { ref: "fee", currency: "XXX", amountMinor: 0 },
  separatelyStated: false, parts: [{ preDiscountMinor: 0, effectiveMinor: 0, netMinor: 0, taxMinor: 0,
    lineTotalMinor: 0, taxPositions: [], discountAllocations: [] }],
}));

const boundedFees = (): Evidence["quote"]["feeLines"] => Array.from({ length: 256 }, (_, index) => ({
  feeKey: `fee-${index}`, jurisdictionRef: "region", feeKind: "service", amountMinor: 1,
  scope: { kind: "order" }, refundRule: { ref: "rule", revision: "1" },
}));

it("matches supplementary Unicode boundaries and records the bounded exclusive commit", async () => {
  const promotions = Array.from({ length: 20 }, () => ({ id: `offer-${randomUUID()}`, lineKey: "source-2" }));
  const state = (amount: number) => ({ basisMinor: amount, netMinor: amount, taxMinor: 0, taxPositions: [] });
  const evidence = await issue(store, sku, false, body => ({
    ...body, catalogueEvidenceRef: "😀".repeat(256),
    lines: Array.from({ length: 50 }, (_, index) => ({
      ...body.lines[0]!, lineKey: index ? `source-${index}` : "😀".repeat(64), sourceOrdinal: index + 1,
      unitBasisMinor: index === 2 ? 21 : 1, preDiscountMinor: index === 2 ? 21 : 1,
      effectiveMinor: 1, netMinor: 1, lineTotalMinor: 1,
      taxPositions: index === 0 ? Array.from({ length: 32 }, (_, position) => ({
        ...body.lines[0]!.taxPositions[0]!, positionRef: `position-${position}`, taxableMinor: 1,
      })) : [],
      discountAllocations: index === 2 ? promotions.map(({ id }, slot) => ({
        allocationId: randomUUID(), adjustmentRef: id, sequence: slot + 1, source: "legacy_promotion" as const,
        basisReductionMinor: 1, netReductionMinor: 1, taxReductionMinor: 0, evidenceRef: "b".repeat(64),
        before: state(21 - slot), after: state(20 - slot),
      })) : [],
    })),
    deliveryBuckets: boundedHandling(),
    feeLines: boundedFees(),
    netTotal: 50, feeTotal: 256, payableMinor: 306,
  }), { promotions });
  await timeCommit(evidence, "exclusive");

  const control = await issue(store, sku, false);
  await expectMismatch(writeChecked(control, { source: { line_key: "😀".repeat(65) }, item: { line_key: "😀".repeat(65) } }), "/lines");
  await expect(transaction(store.owner, db => write(db, control, sku, { snapshot: {
    catalogue_evidence_ref: "😀".repeat(257),
  } }))).rejects.toMatchObject({ code: "23514", table: snapshots });
}, postgresSetupTimeoutMs);

it("times a combined commit with allocation-state positions near both wire caps", async () => {
  const lineKey = "dense-source";
  const promotions = Array.from({ length: 20 }, () => ({ id: `offer-${randomUUID()}`, lineKey }));
  const positionCount = 32 * (promotions.length * 2 + 1);
  const sealWireCap = 1_048_576;
  const evidence = await issue(store, sku, false, body => {
    const line = body.lines[0]!, position = line.taxPositions[0]!;
    const sized = (refBytes: number) => {
      const state = (amount: number) => ({
        basisMinor: amount, netMinor: amount, taxMinor: 0,
        taxPositions: Array.from({ length: 32 }, (_, index) => ({
          ...position, positionRef: `dense-position-${index}`, taxableMinor: amount,
          providerLineRef: "p".repeat(Math.min(256, refBytes - 1)),
          resolution: { ...position.resolution, sourceRef: "s".repeat(Math.max(1, refBytes - 256)) },
        })),
      });
      return {
        ...body, deliveryBuckets: boundedHandling(), feeLines: boundedFees(), netTotal: 50, feeTotal: 256, payableMinor: 306,
        lines: [{ ...line, lineKey, unitBasisMinor: 21, preDiscountMinor: 21, effectiveMinor: 1, netMinor: 1,
          lineTotalMinor: 1, taxPositions: state(1).taxPositions,
          discountAllocations: promotions.map(({ id }, slot) => ({
            allocationId: randomUUID(), adjustmentRef: id, sequence: slot + 1, source: "legacy_promotion" as const,
            basisReductionMinor: 1, netReductionMinor: 1, taxReductionMinor: 0, evidenceRef: "b".repeat(64),
            before: state(21 - slot), after: state(20 - slot),
          })),
        }, ...Array.from({ length: 49 }, (_, index) => ({
          ...line, lineKey: `source-${index + 2}`, sourceOrdinal: index + 2, unitBasisMinor: 1,
          preDiscountMinor: 1, effectiveMinor: 1, netMinor: 1, lineTotalMinor: 1, taxPositions: [], discountAllocations: [],
        }))],
      };
    };
    // Reserve bytes for the quote and seal envelope, then fill the repeated references.
    const room = Math.min(CATALOG_DRAFT_MAX_BYTES, sealWireCap) - 8_192 - Buffer.byteLength(JSON.stringify(sized(2)));
    const refBytes = 2 + Math.floor(room / positionCount);
    expect(refBytes).toBeGreaterThanOrEqual(2);
    expect(refBytes).toBeLessThanOrEqual(512);
    return sized(refBytes);
  }, { promotions });
  const quoteBytes = Buffer.byteLength(JSON.stringify(evidence.quote));
  const { rows: [seal] } = await store.owner.query<{ bytes: number }>(
    "SELECT octet_length(outcome_text) AS bytes FROM public.tax_calculations WHERE calculation_id=$1",
    [evidence.quote.taxEvidence.calculationId]);
  expect(quoteBytes).toBeGreaterThan(CATALOG_DRAFT_MAX_BYTES * 0.99);
  expect(quoteBytes).toBeLessThanOrEqual(CATALOG_DRAFT_MAX_BYTES);
  expect(seal!.bytes).toBeGreaterThan(sealWireCap * 0.99);
  expect(seal!.bytes).toBeLessThanOrEqual(sealWireCap);
  expect(evidence.quote.lines).toHaveLength(50);
  console.info(`Combined order fixture: 50 items and sources, ${promotions.length} allocations, ${positionCount} positions, ${quoteBytes} quote bytes, ${seal!.bytes} seal bytes`);
  await timeCommit(evidence, "combined wire", 10_000);
}, postgresSetupTimeoutMs);

it("records the bounded inclusive commit with fifty apportioned shipping parts", async () => {
  const evidence = await issue(store, sku, true, body => {
    const source = body.lines[0]!;
    const position = source.taxPositions[0]!;
    const component = (index: number, kind: string) => ({
      sourceOrdinal: index + 1, preDiscountMinor: 1, effectiveMinor: 1, netMinor: 1, taxMinor: 0, lineTotalMinor: 1,
      taxPositions: [{ ...position, positionRef: `${kind}-${index}`, taxableMinor: 1 }], discountAllocations: [],
    });
    return {
      ...body, lines: Array.from({ length: 50 }, (_, index) => ({
        ...source, ...component(index, "item"), lineKey: `item-${index}`, unitBasisMinor: 1,
      })),
      deliveryBuckets: [{
        bucketKey: "shipping", kind: "shipping", carrierRef: "carrier", serviceRef: "service",
        taxClassKey: "class-a", assignmentRef: "assignment-a", cost: { ref: "cost", currency: "XXX", amountMinor: 50 },
        separatelyStated: true, parts: Array.from({ length: 50 }, (_, index) => component(index, "shipping")),
      }],
      netTotal: 100, payableMinor: 100,
    };
  });
  await timeCommit(evidence, "inclusive");
}, postgresSetupTimeoutMs);

it("keeps the installed source and snapshot scalar bounds at their edges", async () => {
  const evidence = await issue(store, sku, false, body => ({
    ...body, netTotal: 99, payableMinor: 99,
    lines: [{ ...body.lines[0]!, quantity: 99, unitBasisMinor: 1, preDiscountMinor: 99,
      effectiveMinor: 99, netMinor: 99, lineTotalMinor: 99, taxPositions: [] }],
  }));
  const invalid = [
    [sources, "quantity", 0], [sources, "quantity", 100], [sources, "source_rank", 0],
    [sources, "source_rank", 51], [sources, "unit_basis_minor", -1], [sources, "unit_basis_minor", 2147483648],
    [snapshots, "payable_minor", 0], [snapshots, "payable_minor", 2147483648],
    [snapshots, "net_total", -1], [snapshots, "net_total", "9007199254740992"],
  ] as const;
  for (const [table, column, value] of invalid) {
    const key = `${table}_${column}_check`;
    const options = table === sources ? { source: { [column]: value } } : { snapshot: { [column]: value } };
    expectSqlError(await rejected(writeChecked(evidence, options)), "23514", checkMessage(table, key), key);
  }
  await expect(writeChecked(evidence)).resolves.toBeDefined();
});

it("detects removing the header mutation and digest checks in a disposable transaction", async () => {
  const evidence = await issue(store, sku, false);
  const { id } = await writeChecked(evidence);
  const definition = async (db: PoolClient, signature: string) => (await db.query<{ sql: string }>(
    "SELECT pg_get_functiondef($1::regprocedure) AS sql", [signature])).rows[0]!.sql;
  // Temporarily disabled the marker-change refusal in a disposable database transaction.
  await transaction(store.owner, async db => {
    const source = await definition(db, "public.commerce_order_assert_line_sum()");
    const mutated = source.replace("IF TG_OP='UPDATE' AND (OLD.id,OLD.client_id,OLD.money_version)", "IF false AND (OLD.id,OLD.client_id,OLD.money_version)")
      .replace("v_event_marker OR v_version IS NOT NULL OR v_other_version IS NOT NULL", "v_version IS NOT NULL");
    expect(mutated).not.toBe(source);
    await db.query(mutated);
    await db.query("UPDATE public.commerce_orders SET money_version=NULL WHERE id=$1", [id]);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  }, "ROLLBACK");

  // Temporarily disabled the accepted digest comparison in a disposable database transaction.
  const fresh = await issue(store, sku, false);
  await transaction(store.owner, async db => {
    const source = await definition(db, routine);
    const mutated = source.replace("IF NOT snapshot.destination_erased AND snapshot.accepted_money_digest", "IF false AND snapshot.accepted_money_digest");
    expect(mutated).not.toBe(source);
    await db.query(mutated);
    await write(db, fresh, sku, { source: { assignment_ref: "alternate" } });
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  }, "ROLLBACK");
});
