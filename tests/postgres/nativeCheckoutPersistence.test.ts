import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { NativeCheckoutDraftRequest } from "@openlup/platform/commerce/server/native-checkout";
import { assertConsumerIsolation, assertExportInventory, platformConsumerInstallArgs } from "../../scripts/packages/platform-cold-consumer.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, scratch: string, consumer: string, runtimeUrl: string;
let owner: Pool, runtime: Pool, untrusted: Pool;
const pools: Pool[] = [];
let installed: typeof import("@openlup/platform/commerce/server/native-checkout");
const SKUS = ["NATIVE-CHECKOUT-A", "NATIVE-CHECKOUT-B"];
let clientId: string, otherClientId: string;
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
function quote(mode: "one_time" | "subscription" = "subscription", units = [200, 320]) {
  const lines = SKUS.map((sku, i) => {
    const quantity = i + 2, gross = units[i] * quantity, net = Math.round(gross / 1.2);
    return { sku, productSlug: sku.toLowerCase(), quantity, unitPriceGross: money(units[i]), lineSubtotalGross: money(gross),
      tax: { included: true as const, country: "ZZ", category: "standard", vatRateBps: 2000, legalBasis: "Synthetic test tax",
        netAmount: money(net), vatAmount: money(gross - net), grossAmount: money(gross) } };
  });
  const gross = lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0);
  const net = lines.reduce((sum, line) => sum + line.tax.netAmount.amountMinor, 0);
  return { contractVersion: "commerce.v0" as const, quote: { currency: "XXX", taxIncluded: true as const, lines, discounts: [],
    context: { mode, cadenceDays: mode === "subscription" ? 28 : null, promoCodes: [], hostFacts: { stages: ["quote", "draft"] } },
    subtotalGross: money(gross), discountTotalGross: money(0), shippingGross: money(0), shippingDiscountGross: money(0),
    totalGross: money(gross), netTotal: money(net), taxTotal: money(gross - net) } };
}
const request = (): NativeCheckoutDraftRequest => ({ idempotencyKey: `native-checkout:${randomUUID()}`, quoteSnapshot: quote() });
const port = () => installed.createPostgresNativeCheckoutPersistence(runtime);
const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: "pipe", timeout: 120_000 });
function pool(connectionString: string, options?: string) {
  const value = new Pool({ connectionString, options }); pools.push(value); return value;
}
async function effects() {
  const tables = ["commerce_orders", "commerce_order_items", "commerce_order_draft_receipts", "outbox_events", "commerce_settlement_intents", "payment_truth_events"];
  return Promise.all(tables.map(async table => ({ table,
    rows: (await owner.query(`SELECT to_jsonb(row) AS value,xmin::text AS version,ctid::text AS position FROM public.${table} row ORDER BY ctid`)).rows,
  })));
}
async function refusesWithoutWrite(action: () => Promise<unknown>, expected: Record<string, unknown>) {
  const before = await effects();
  await expect(action()).rejects.toMatchObject(expected);
  expect(await effects()).toEqual(before);
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Native checkout requires real PostgreSQL; missing Docker is missing proof");
  scratch = mkdtempSync(join(tmpdir(), "native-checkout-packed-"));
  const tarballs = ["packages/core", "packages/platform", "node_modules/zod"].map(directory => {
    const [packed] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], resolve(directory)));
    return join(scratch, packed.filename);
  });
  consumer = join(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
  npm(platformConsumerInstallArgs(tarballs), consumer);
  assertConsumerIsolation(consumer, process.cwd());
  expect(assertExportInventory(consumer)).toContain("commerce/server/native-checkout");
  const installedResolve = createRequire(join(consumer, "package.json")).resolve;
  installed = await import(pathToFileURL(installedResolve("@openlup/platform/commerce/server/native-checkout")).href);
  const peers = ["pg", "@types/pg", "@types/node"].map(name => `${name}@${JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version}`);
  npm(platformConsumerInstallArgs(peers, true), consumer);
  assertConsumerIsolation(consumer, process.cwd(), false);
  const program = `import { createPostgresNativeCheckoutPersistence, type NativeCheckoutQuery, type NativeCheckoutDraftRequest, type NativeCheckoutDraftResponse } from "@openlup/platform/commerce/server/native-checkout";
declare const db: NativeCheckoutQuery; declare const input: NativeCheckoutDraftRequest;
export const result: Promise<NativeCheckoutDraftResponse> = createPostgresNativeCheckoutPersistence(db).createOrderDraft(input, {clientId:null});
// @ts-expect-error browser return state is not a draft command
createPostgresNativeCheckoutPersistence(db).createOrderDraft({...input,paymentStatus:"paid"});`;
  writeFileSync(join(consumer, "consumer.mts"), program);
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  for (const mode of ["NodeNext", "Bundler"]) {
    const config = join(consumer, `tsconfig.${mode}.json`);
    writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode,
      strict: true, skipLibCheck: false, noEmit: true, types: ["node"], typeRoots: [join(consumer, "node_modules/@types")] }, files: ["consumer.mts"] }));
    execFileSync(process.execPath, [compiler, "--project", config], { cwd: consumer, stdio: "pipe", timeout: 120_000 });
  }
  container = await runPostgresContainer({ name: `native-checkout-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native checkout PostgreSQL TCP unavailable");
  owner = pool(container.connectionString);
  await owner.query(`CREATE ROLE checkout_runtime LOGIN PASSWORD 'synthetic-runtime' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE checkout_restore LOGIN PASSWORD 'synthetic-restore' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE checkout_untrusted LOGIN PASSWORD 'synthetic-untrusted' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "checkout_runtime", restoreLogin: "checkout_restore" };
  const migration = pool(container.connectionString, qualifiedPostgresStartupOptions(selection));
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => migration });
  await runner.apply(); expect((await runner.status()).pending).toEqual([]);
  const login = (name: string, password: string) => { const url = new URL(container!.connectionString); url.username = name; url.password = password; return url.toString(); };
  runtimeUrl = login("checkout_runtime", "synthetic-runtime"); runtime = pool(runtimeUrl);
  untrusted = pool(login("checkout_untrusted", "synthetic-untrusted"));
  expect((await runtime.query(`SELECT current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) bypassrls,pg_has_role(current_user,'service_role','USAGE') service`)).rows)
    .toEqual([{ current_user: "checkout_runtime", superuser: false, bypassrls: false, service: true }]);
  for (const sql of ["CREATE TABLE public.checkout_forbidden(id int)", "SET ROLE postgres"])
    await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
  // Install-time demo catalogue and prices are allowed fixtures, not journey writers.
  const list = (await owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Synthetic checkout','ZZ','XXX') RETURNING id")).rows[0].id;
  for (let i = 0; i < SKUS.length; i++) {
    const id = randomUUID();
    await owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic checkout')", [id, SKUS[i].toLowerCase()]);
    await owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Synthetic checkout',true)", [id, SKUS[i]]);
    await owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor) VALUES($1,$2,$3)", [list, id, [200, 320][i]]);
  }
  [clientId, otherClientId] = await Promise.all(["buyer", "other"].map(async label =>
    (await runtime.query("INSERT INTO public.clients(email,acquisition_source,lifecycle_stage) VALUES($1,'direct','lead') RETURNING id", [`${label}@checkout.example.invalid`])).rows[0].id));
}, postgresSetupTimeoutMs);

afterAll(async () => {
  try { await closePostgres(container, pools); }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}, postgresTeardownTimeoutMs);

it.each(["one_time", "subscription"] as const)("persists complete %s money and arrays, replays concurrently and recovers from a fresh process", async mode => {
  const input = { ...request(), quoteSnapshot: quote(mode) };
  const created = await Promise.all([port(), port(), port()].map(value => value.createOrderDraft(input, { clientId })));
  expect(created.filter(value => !value.orderDraft.replayed)).toHaveLength(1);
  const first = created.find(value => !value.orderDraft.replayed)!;
  expect(new Set(created.map(value => value.orderDraft.orderId)).size).toBe(1);
  const id = first.orderDraft.orderId.replace(/^order_/, "");
  const row = (await runtime.query("SELECT client_id,status,currency_code,total_amount_minor,metadata FROM public.commerce_orders WHERE id=$1", [id])).rows[0];
  expect(row).toMatchObject({ client_id: clientId, status: "pending_payment", currency_code: "XXX", total_amount_minor: "1360" });
  expect(row.metadata.quoteSnapshot).toEqual(input.quoteSnapshot);
  expect(row.metadata.orderDraftSnapshot).toEqual({ contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
    currency: "XXX", taxIncluded: true, lines: input.quoteSnapshot.quote.lines, discounts: [], context: input.quoteSnapshot.quote.context,
    totals: { subtotalGross: money(1360), discountTotalGross: money(0), shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(1360), netTotal: money(1133), taxTotal: money(227) } });
  expect((await runtime.query("SELECT line_ordinal,quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal", [id])).rows)
    .toEqual([{ line_ordinal: 1, quantity: 2, unit_amount_minor: "200", line_amount_minor: "400" }, { line_ordinal: 2, quantity: 3, unit_amount_minor: "320", line_amount_minor: "960" }]);
  const before = await effects();
  const replays = await Promise.all([port(), port(), port()].map(value => value.createOrderDraft(input, { clientId })));
  expect(replays).toEqual(Array(3).fill({ ...first, orderDraft: { ...first.orderDraft, replayed: true } }));
  expect(await effects()).toEqual(before);
  const script = join(consumer, "restart.mjs");
  writeFileSync(script, `import {Pool} from "pg";
import {readFileSync} from "node:fs";
import {createPostgresNativeCheckoutPersistence} from "@openlup/platform/commerce/server/native-checkout";
const input=JSON.parse(readFileSync(0,"utf8")),db=new Pool({connectionString:input.connectionString});
try { console.log(JSON.stringify(await createPostgresNativeCheckoutPersistence(db).createOrderDraft(input.request,{clientId:input.clientId}))); }
finally { await db.end(); }`);
  const replay = JSON.parse(execFileSync(process.execPath, [script], { cwd: consumer, input: JSON.stringify({ connectionString: runtimeUrl, request: input, clientId }), encoding: "utf8", timeout: 15_000 }));
  expect(replay).toEqual(replays[0]); expect(await effects()).toEqual(before);
  expect((await runtime.query("SELECT count(*)::int n FROM public.commerce_order_draft_receipts WHERE order_id=$1", [id])).rows).toEqual([{ n: 1 }]);
  expect((await runtime.query("SELECT count(*)::int n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order_draft.created'", [id])).rows).toEqual([{ n: 1 }]);
  expect((await runtime.query("SELECT count(*)::int n FROM public.commerce_settlement_intents")).rows).toEqual([{ n: 0 }]);
  expect((await runtime.query("SELECT count(*)::int n FROM public.payment_truth_events")).rows).toEqual([{ n: 0 }]);
  await refusesWithoutWrite(() => port().createOrderDraft({ ...input, quoteSnapshot: quote(mode, [201, 320]) }, { clientId }), { name: "CommerceOrderDraftConflictError", details: { code: "23505" } });
  await refusesWithoutWrite(() => port().createOrderDraft(input, { clientId: otherClientId }), { name: "CommerceOrderDraftConflictError", details: { code: "23505" } });
}, 30_000);

it("refuses catalogue drift and an unprivileged caller without partial effects", async () => {
  await refusesWithoutWrite(() => port().createOrderDraft({ ...request(), quoteSnapshot: quote("subscription", [201, 320]) }, { clientId }), { name: "CommerceOrderDraftPriceChangedError", details: { code: "22023" } });
  await refusesWithoutWrite(() => installed.createPostgresNativeCheckoutPersistence(untrusted).createOrderDraft(request(), { clientId }), { name: "CommerceOrderDraftPersistenceError", details: { code: "42501" } });
  await refusesWithoutWrite(() => port().createOrderDraft(request(), { clientId: randomUUID() }), { name: "CommerceOrderDraftPersistenceError", details: { code: "22023" } });
});

it("rejects malformed money, identity injection and browser-return payment fields", async () => {
  const input = request(), invalidMoney = structuredClone(input);
  invalidMoney.quoteSnapshot.quote.totalGross.amountMinor++;
  const invalidCurrency = structuredClone(input); invalidCurrency.quoteSnapshot.quote.lines[0].unitPriceGross.currency = "YYY";
  for (const changed of [invalidMoney, invalidCurrency, { ...input, paymentStatus: "paid" }, { ...input, clientId: otherClientId }, { ...input, idempotencyKey: "bad" }]) {
    await refusesWithoutWrite(() => port().createOrderDraft(changed, { clientId }), { name: "ZodError" });
  }
  for (const context of [{ mode: "unknown" }, { cadenceDays: 0 }, { promoCodes: [""] }]) {
    const changed = { ...input, quoteSnapshot: { ...input.quoteSnapshot, quote: { ...input.quoteSnapshot.quote,
      context: { ...input.quoteSnapshot.quote.context, ...context } } } } as NativeCheckoutDraftRequest;
    await refusesWithoutWrite(() => port().createOrderDraft(changed, { clientId }), { name: "ZodError" });
  }
  await refusesWithoutWrite(() => port().createOrderDraft(input, { clientId: "invalid-client" }), { name: "ZodError" });
});

it("retains the native zero-payable, shipping and line-discount refusals", async () => {
  await refusesWithoutWrite(() => port().createOrderDraft({ ...request(), quoteSnapshot: quote("subscription", [0, 0]) }, { clientId }), { name: "CommerceOrderDraftUnsupportedMoneyError", reason: "zero_payable_unsupported" });
  const shipping = request();
  shipping.quoteSnapshot.quote.shippingGross = money(120); shipping.quoteSnapshot.quote.totalGross.amountMinor += 120;
  shipping.quoteSnapshot.quote.netTotal.amountMinor += 100; shipping.quoteSnapshot.quote.taxTotal.amountMinor += 20;
  await refusesWithoutWrite(() => port().createOrderDraft(shipping, { clientId }), { name: "CommerceOrderDraftUnsupportedMoneyError", reason: "net_shipping_unsupported" });
  const discount = request();
  discount.quoteSnapshot.quote.discounts = [{ promotionId: "synthetic", appliesTo: "line", amountOffMinor: 100, reasonCode: "synthetic" }];
  discount.quoteSnapshot.quote.discountTotalGross = money(100); discount.quoteSnapshot.quote.totalGross.amountMinor -= 100;
  discount.quoteSnapshot.quote.netTotal.amountMinor -= 83; discount.quoteSnapshot.quote.taxTotal.amountMinor -= 17;
  await refusesWithoutWrite(() => port().createOrderDraft(discount, { clientId }), { name: "CommerceOrderDraftUnsupportedMoneyError", reason: "line_promotion_unsupported" });
});
