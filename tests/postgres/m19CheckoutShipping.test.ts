import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { NativeCheckoutDraftRequest } from "@openlup/platform/commerce/server/native-checkout";
import { platformConsumerInstallArgs, assertConsumerIsolation } from "../../scripts/packages/platform-cold-consumer.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, scratch: string;
let owner: Pool, runtime: Pool, denied: Pool;
const pools: Pool[] = [];
let checkout: typeof import("@openlup/platform/commerce/server/native-checkout");
let invoicing: typeof import("@openlup/platform/invoicing");
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
const pool = (connectionString: string, options?: string) => { const db = new Pool({ connectionString, options }); pools.push(db); return db; };
const native = (db: Pool | PoolClient = runtime) => checkout.createPostgresNativeCheckoutPersistence(db);
const uuid = (result: { orderDraft: { orderId: string } }) => result.orderDraft.orderId.replace(/^order_/, "");

beforeAll(async () => {
  mkdirSync(".context/scratch", { recursive: true });
  scratch = mkdtempSync(join(tmpdir(), "g8-shipping-packed-"));
  const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8", timeout: 120_000 });
  const tarballs = ["packages/core", "packages/platform", "node_modules/zod"].map(directory => {
    const [packed] = JSON.parse(npm(["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", resolve(scratch)], resolve(directory)));
    return resolve(scratch, packed.filename);
  });
  const consumer = resolve(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
  npm(platformConsumerInstallArgs(tarballs), consumer);
  assertConsumerIsolation(consumer, process.cwd());
  const installed = createRequire(join(consumer, "package.json")).resolve;
  checkout = await import(pathToFileURL(installed("@openlup/platform/commerce/server/native-checkout")).href);
  invoicing = await import(pathToFileURL(installed("@openlup/platform/invoicing")).href);
  container = await runPostgresContainer({ name: `m19-g8-shipping-${process.pid}`, password: "synthetic-conformance" });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  owner = pool(container.connectionString);
  await owner.query(`CREATE ROLE g8_ship_runtime LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g8_ship_restore LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g8_ship_denied LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "g8_ship_runtime", restoreLogin: "g8_ship_restore" };
  const migration = pool(container.connectionString, qualifiedPostgresStartupOptions(selection));
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => migration });
  await runner.apply(); expect((await runner.status()).pending).toEqual([]);
  const login = (name: string) => { const url = new URL(container!.connectionString); url.username = name; url.password = "synthetic-only"; return url.toString(); };
  runtime = pool(login(selection.runtimeLogin)); denied = pool(login("g8_ship_denied"));
  console.info("G8 shipping runtime TimeZone", (await runtime.query("SHOW TimeZone")).rows[0].TimeZone);
  expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
}, postgresSetupTimeoutMs);
afterAll(async () => { try { await closePostgres(container, pools); } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); } }, postgresTeardownTimeoutMs);

async function client() {
  return (await runtime.query("INSERT INTO public.clients(email,acquisition_source,lifecycle_stage) VALUES($1,'direct','lead') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0].id as string;
}
async function promotion(global: number | null = null, customer: number | null = null, freeShipping = false) {
  const id = `promotion-${randomUUID()}`;
  const definition = { id, status: "active", name: "Configured benefit", code: null, trigger_type: "automatic", discount_type: freeShipping ? "free_shipping" : "fixed_amount", discount_value: freeShipping ? 0 : 91,
    applies_to_kind: "order_total", applies_to_payload: {}, stacking_rule: "exclusive", eligibility: {}, valid_from: "2020-01-01T00:00:00Z", valid_to: null,
    region_availability: ["ZZ"], redemption_limit_global: global, redemption_limit_per_customer: customer };
  await owner.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)", [id, definition]);
  return id;
}
async function request(options: { mode?: "one_time" | "subscription"; gross?: number; discount?: number; promotion?: string; fee?: number; threshold?: number; shippingDiscount?: number } = {}): Promise<NativeCheckoutDraftRequest> {
  const sku = `SKU-${randomUUID()}`, product = randomUUID(), list = randomUUID();
  const gross = options.gross ?? 1292, discount = options.discount ?? 91, shipping = options.fee ?? 217, shippingDiscount = options.shippingDiscount ?? 0;
  await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic product')", [product, sku.toLowerCase()]);
  await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Synthetic item',true)", [product, sku]);
  await owner.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Synthetic list','ZZ','XXX')", [list]);
  await owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,$3)", [list, product, gross]);
  const total = gross - discount + shipping - shippingDiscount;
  const discounts: NativeCheckoutDraftRequest["quoteSnapshot"]["quote"]["discounts"] = discount ? [{ promotionId: options.promotion!, appliesTo: "order_total" as const, amountOffMinor: discount, reasonCode: "configured" }] : [];
  if (shippingDiscount) discounts.push({ promotionId: options.promotion!, appliesTo: "shipping", amountOffMinor: shippingDiscount, reasonCode: "configured" });
  return { idempotencyKey: `checkout:${randomUUID()}`, quoteSnapshot: { contractVersion: "commerce.v0", quote: {
    currency: "XXX", taxIncluded: true, lines: [{ sku, productSlug: sku.toLowerCase(), quantity: 1, unitPriceGross: money(gross), lineSubtotalGross: money(gross),
      tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Synthetic tax", netAmount: money(gross), vatAmount: money(0), grossAmount: money(gross) } }],
    discounts, context: { mode: options.mode ?? "one_time", cadenceDays: 28, promoCodes: [], ...(options.threshold === undefined ? {} : {
      shippingTerms: { version: "shipping-threshold.v1", currency: "XXX", flatMinor: 217, freeThresholdMinor: options.threshold },
    }) }, subtotalGross: money(gross), discountTotalGross: money(discount), shippingGross: money(shipping), shippingDiscountGross: money(shippingDiscount),
    totalGross: money(total), netTotal: money(total), taxTotal: money(0),
  } } };
}

it.each([-1, 0, 1])("persists the configured threshold boundary %i after product discounts", async delta => {
  const id = await client(), promo = await promotion(), threshold = 1201;
  const input = await request({ gross: threshold + 91 + delta, promotion: promo, fee: delta < 0 ? 217 : 0, threshold });
  const first = await native().createOrderDraft(input, { clientId: id });
  const order = uuid(first), payable = threshold + delta;
  expect((await runtime.query("SELECT total_amount_minor::text AS amount FROM public.commerce_orders WHERE id=$1", [order])).rows)
    .toEqual([{ amount: String(payable + (delta < 0 ? 217 : 0)) }]);
  expect((await runtime.query("SELECT amount_minor::text AS amount FROM public.commerce_order_adjustments WHERE order_id=$1 AND kind='shipping_charge'", [order])).rows)
    .toEqual(delta < 0 ? [{ amount: "217" }] : []);
  expect((await runtime.query("SELECT sum(line_amount_minor)::text AS amount FROM public.commerce_order_items WHERE order_id=$1", [order])).rows).toEqual([{ amount: String(payable) }]);
  expect(await native().createOrderDraft(input, { clientId: id })).toEqual({ ...first, orderDraft: { ...first.orderDraft, replayed: true } });
});

it.each(["global", "customer"] as const)("serializes lane-2 %s capacity as the installed restricted runtime", async cap => {
  const first = await client(), second = cap === "global" ? await client() : first;
  const promo = await promotion(cap === "global" ? 1 : null, cap === "customer" ? 1 : null);
  const inputs = await Promise.all([request({ mode: "subscription", promotion: promo, fee: 0 }), request({ mode: "subscription", promotion: promo, fee: 0 })]);
  const firstDb = await runtime.connect(), secondDb = await runtime.connect();
  let pending: Promise<{ status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown }> | undefined;
  try {
    const firstPid = (await firstDb.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await firstDb.query("BEGIN; SET LOCAL TimeZone='Etc/GMT-9'");
    await native(firstDb).createOrderDraft(inputs[0], { clientId: first });
    await secondDb.query("SET TimeZone='Etc/GMT+5'");
    pending = native(secondDb).createOrderDraft(inputs[1], { clientId: second }).then(
      value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
    let blocked = false;
    const deadline = Date.now() + 2000;
    while (!blocked && Date.now() < deadline) {
      blocked = (await owner.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a
        WHERE a.usename='g8_ship_runtime' AND a.wait_event_type='Lock'
          AND pg_blocking_pids(a.pid) @> ARRAY[$1]::integer[]) AS blocked`, [firstPid])).rows[0].blocked;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await firstDb.query("COMMIT");
    const result = await pending;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toMatchObject({ name: "CommerceOrderDraftConflictError" });
  } finally {
    await firstDb.query("ROLLBACK");
    if (pending) await pending;
    await secondDb.query("RESET TimeZone");
    firstDb.release(); secondDb.release();
  }
  expect((await runtime.query("SELECT status,count(*)::int AS count FROM public.commerce_promotion_claims WHERE promotion_id=$1 GROUP BY status", [promo])).rows)
    .toEqual([{ status: "reserved", count: 1 }]);
  expect((await owner.query("SELECT e.transition FROM public.commerce_promotion_claim_events e JOIN public.commerce_promotion_claims c ON c.id=e.claim_id WHERE c.promotion_id=$1", [promo])).rows)
    .toEqual([{ transition: "reserved" }]);
  if (cap === "customer") {
    const other = await client();
    await native().createOrderDraft(await request({ mode: "subscription", promotion: promo, fee: 0 }), { clientId: other });
    expect((await runtime.query("SELECT count(*)::int AS count FROM public.commerce_promotion_claims WHERE promotion_id=$1", [promo])).rows).toEqual([{ count: 2 }]);
  }
});

it("keeps helper ownership, volatility, browser refusals and runtime definition UPDATE refusal", async () => {
  expect((await owner.query(`SELECT p.proowner::regrole::text AS owner,p.provolatile,p.prosecdef,p.proconfig
    FROM pg_proc p WHERE p.oid='public.commerce_promotion_lock_definition(text)'::regprocedure`)).rows)
    .toEqual([{ owner: "postgres", provolatile: "v", prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] }]);
  await expect(runtime.query("UPDATE public.commerce_promotion_definitions SET active=false")).rejects.toMatchObject({ code: "42501" });
  await expect(denied.query("SELECT public.commerce_promotion_lock_definition('missing')")).rejects.toMatchObject({ code: "42501" });
  for (const role of ["anon", "authenticated"]) {
    const db = await owner.connect();
    try { await db.query(`SET ROLE ${role}`); await expect(db.query("SELECT public.commerce_promotion_lock_definition('missing')")).rejects.toMatchObject({ code: "42501" }); }
    finally { await db.query("RESET ROLE"); db.release(); }
  }
  expect((await owner.query(`SELECT count(*)::int AS count FROM pg_proc p,aclexplode(p.proacl) a
    WHERE p.oid='public.commerce_promotion_lock_definition(text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'`)).rows).toEqual([{ count: 0 }]);
});

it("preserves missing-promotion SQL refusal and rolls back the whole draft", async () => {
  const input = await request({ promotion: "missing", fee: 0 }), q = input.quoteSnapshot.quote;
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started", currency: q.currency,
    taxIncluded: true, lines: q.lines, discounts: q.discounts, context: q.context, totals: { subtotalGross: q.subtotalGross, discountTotalGross: q.discountTotalGross,
      shippingGross: q.shippingGross, shippingDiscountGross: q.shippingDiscountGross, totalGross: q.totalGross, netTotal: q.netTotal, taxTotal: q.taxTotal } };
  await expect(runtime.query("SELECT public.commerce_create_promoted_order_draft_with_outbox($1,$2::jsonb,$3::jsonb,$4::uuid)",
    [input.idempotencyKey, JSON.stringify(input.quoteSnapshot), JSON.stringify(draft), await client()]))
    .rejects.toMatchObject({ code: "40001", message: "commerce_promotion_definition_not_active" });
  expect((await runtime.query("SELECT idempotency_key FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1", [input.idempotencyKey])).rows).toEqual([]);
});

it("replays across mixed session time zones without changing claims or delivery money", async () => {
  const input = await request({ promotion: await promotion(), fee: 217 }), id = await client(), db = await runtime.connect();
  try {
    await db.query("BEGIN; SET LOCAL TimeZone='Etc/GMT-9'");
    const first = await native(db).createOrderDraft(input, { clientId: id });
    await db.query("COMMIT; BEGIN; SET LOCAL TimeZone='Etc/GMT+5'");
    expect(await native(db).createOrderDraft(input, { clientId: id })).toEqual({ ...first, orderDraft: { ...first.orderDraft, replayed: true } });
    await db.query("COMMIT");
    expect((await runtime.query("SELECT count(*)::int AS count FROM public.commerce_promotion_claims WHERE order_id=$1", [uuid(first)])).rows).toEqual([{ count: 1 }]);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it.each([217, 0])("closes the local invoice with effective shipping %i as a separate line", async fee => {
  const input = await request({ gross: 1200, discount: 0, fee }), id = await client();
  const order = uuid(await native().createOrderDraft(input, { clientId: id }));
  const intent = (await runtime.query("SELECT public.commerce_open_settlement_intent($1,$2::uuid,'captured',$3::bigint,'XXX') AS result", [`intent:${order}`, order, 1200 + fee])).rows[0].result.settlement.id;
  await runtime.query("SELECT public.commerce_record_settlement($1,$2::uuid,'succeeded',$3,'{}'::jsonb,'2026-11-01T12:00:00.123456Z'::timestamptz)", [`settle:${order}`, intent, `capture:${order}`]);
  const store = invoicing.createPostgresInvoiceStore(runtime);
  const command = { requestKey: `invoice:${order}`, orderId: order, providerRef: "local-proof" };
  const result = await store.requestLocalDocument(command);
  expect(result).toMatchObject({ kind: "requested", replayed: false });
  if (result.kind !== "requested") throw new Error("Expected local document");
  const lines = (await runtime.query("SELECT description,total_gross_minor::text AS amount FROM public.accounting_document_positions WHERE document_id=$1 ORDER BY position_ordinal", [result.documentId])).rows;
  expect(lines).toEqual([{ description: "order position 1", amount: "1200" }, ...(fee ? [{ description: "delivery", amount: String(fee) }] : [])]);
  expect(lines.reduce((sum, line) => sum + Number(line.amount), 0)).toBe(1200 + fee);
  expect(await store.requestLocalDocument(command)).toMatchObject({ kind: "requested", replayed: true, documentId: result.documentId });
});


it.each(["product", "shipping"] as const)("preserves the deferred conservation refusal for a wrong %s amount", async kind => {
  const input = await request({ gross: 1200, discount: 0, fee: 0 });
  const order = uuid(await native().createOrderDraft(input, { clientId: await client() }));
  const db = await runtime.connect();
  try {
    await db.query("BEGIN");
    if (kind === "shipping") {
      await db.query("INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor) VALUES($1,'shipping_charge','shipping',1)", [order]);
      await db.query("UPDATE public.commerce_orders SET total_amount_minor=total_amount_minor WHERE id=$1", [order]);
    } else await db.query("UPDATE public.commerce_orders SET total_amount_minor=total_amount_minor+1 WHERE id=$1", [order]);
    await expect(db.query("COMMIT")).rejects.toMatchObject({ code: "23514", message: "commerce_order_line_sum_mismatch" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect((await runtime.query("SELECT total_amount_minor::int AS amount FROM public.commerce_orders WHERE id=$1", [order])).rows)
    .toEqual([{ amount: input.quoteSnapshot.quote.totalGross.amountMinor }]);
  expect((await runtime.query("SELECT count(*)::int AS count FROM public.commerce_order_adjustments WHERE order_id=$1", [order])).rows)
    .toEqual([{ count: 0 }]);
});


it("conserves a shipping-scoped benefit at the restricted draft boundary", async () => {
  const input = await request({ gross: 1200, discount: 0, fee: 217, shippingDiscount: 217, promotion: await promotion(null, null, true) });
  const id = await client(), first = await native().createOrderDraft(input, { clientId: id }), order = uuid(first);
  expect((await runtime.query("SELECT total_amount_minor::int AS amount FROM public.commerce_orders WHERE id=$1", [order])).rows).toEqual([{ amount: 1200 }]);
  expect((await runtime.query("SELECT sum(line_amount_minor)::int AS amount FROM public.commerce_order_items WHERE order_id=$1", [order])).rows).toEqual([{ amount: 1200 }]);
  expect((await runtime.query("SELECT kind,scope,amount_minor::int AS amount FROM public.commerce_order_adjustments WHERE order_id=$1 ORDER BY kind", [order])).rows)
    .toEqual([{ kind: "promotion_discount", scope: "shipping", amount: 217 }, { kind: "shipping_charge", scope: "shipping", amount: 217 }]);
  expect(await native().createOrderDraft(input, { clientId: id })).toEqual({ ...first, orderDraft: { ...first.orderDraft, replayed: true } });
});
