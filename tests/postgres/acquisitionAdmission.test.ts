import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import ts from "typescript";
import type { CreateQuoteRequest } from "@openlup/platform/pricing";
import { acquisitionFixture, configured, policy } from "./acquisitionAdmissionFixture.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

let f: Awaited<ReturnType<typeof acquisitionFixture>>;
beforeAll(async () => { f = await acquisitionFixture(); }, postgresSetupTimeoutMs);
afterAll(async () => { if (f) await f.close(); }, postgresTeardownTimeoutMs);
async function refused(action: () => Promise<unknown>, expected: object) {
  const before = await f.effects();
  await expect(action()).rejects.toMatchObject(expected);
  expect(await f.effects()).toEqual(before);
}

it("uses the installed restricted runtime, full packaged catalogue and definition lock without definition UPDATE", async () => {
  expect((await f.runtime.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
    .toEqual([{ current_user: "acquisition_runtime", session_user: "acquisition_runtime", rolsuper: false, rolbypassrls: false }]);
  expect((await f.owner.query("SELECT catalog_path FROM public.platform_schema_migrations WHERE catalog_path LIKE '%20261101231000%'")).rows).toHaveLength(1);
  await expect(f.runtime.query("UPDATE public.commerce_promotion_definitions SET active=false")).rejects.toMatchObject({ code: "42501" });
  expect((await f.runtime.query(`SELECT has_function_privilege('anon','public.commerce_promotion_lock_definition(text)','EXECUTE') AS anon,
    has_function_privilege('authenticated','public.commerce_promotion_lock_definition(text)','EXECUTE') AS browser`)).rows).toEqual([{ anon: false, browser: false }]);
});

it("preserves exact-first preview, normalized aliases, unrelated identities and bounded escaped fallback", async () => {
  const key = `person${randomUUID()}`, domain = "example.invalid";
  const base = await f.client(`${key}@${domain}`), alias = await f.client(`${key}+exact@${domain}`, "2026-02-01T00:00:00Z");
  expect(await f.eligibility().resolve(null)).toEqual({ clientId: null, source: "anonymous", matchKind: null });
  expect(await f.eligibility().resolve(`  ${key.toUpperCase()}+EXACT@${domain.toUpperCase()}  `))
    .toEqual({ clientId: alias, source: "resolved_client", matchKind: "exact" });
  expect(await f.eligibility().resolve(`${key}+new@${domain}`)).toEqual({ clientId: base, source: "resolved_client", matchKind: "plus_normalized" });
  for (const email of [`${key}+new@unrelated.invalid`, `other${key}@${domain}`])
    expect(await f.eligibility().resolve(email)).toEqual({ clientId: null, source: "anonymous", matchKind: null });
  const escaped = `literal_${randomUUID()}`, escapedId = await f.client(`${escaped}@${domain}`);
  expect(await f.eligibility().resolve(`${escaped}+tag@${domain}`)).toMatchObject({ clientId: escapedId, matchKind: "plus_normalized" });
  const bounded = `bounded${randomUUID()}`;
  for (let i = 0; i < 25; i++) await f.client(`${bounded}other${i}@${domain}`);
  await f.client(`${bounded}@${domain}`, "2026-03-01T00:00:00Z");
  expect(await f.eligibility().resolve(`${bounded}+tag@${domain}`)).toMatchObject({ clientId: null, matchKind: null });
  expect((await f.runtime.query("SELECT email FROM public.clients WHERE id=$1", [alias])).rows).toEqual([{ email: `${key}+exact@${domain}` }]);
});

it("fails closed by name on quote and checkout without capability, with zero durable effects", async () => {
  const id = await f.promotion(), clientId = await f.client();
  type CapableRequest = CreateQuoteRequest & { acquisitionCapability?: string };
  const acquisition = { financialPolicy: policy, capability: (request: CreateQuoteRequest) => (request as CapableRequest).acquisitionCapability };
  const legacy = f.promotions.createQuotePromoDiscounts({ promotionCustomerSemantic: () => undefined, acquisition });
  const v2 = f.promotions.createQuotePromotionV2({ promotionCustomerSemantic: () => undefined, minimumProductPayableMinor: 1,
    evaluateOrderTotalDiscounts: legacy.evaluateOrderTotalDiscounts, acquisition });
  const automatic = f.promotions.createQuoteAutomaticPromotions<CapableRequest>({ resolveEmailEligibility: () => true,
    evaluateOrderTotalDiscounts: legacy.evaluateOrderTotalDiscounts, evaluateAutomaticPromotionV2: v2.evaluateAutomaticPromotionV2,
    legacyPromotionDataPort: v2.legacyPromotionDataPort, acquisition });
  const before = await f.effects();
  for (const capability of [undefined, "unsupported"]) {
    const request = await f.request(id);
    request.quoteSnapshot.quote.context.acquisitionCapability = capability;
    await refused(() => f.port().createOrderDraft(request, { clientId }), { reason: "acquisition_terms_capability_required" });
    await expect(automatic.resolveAutomaticQuotePromotions({ promoDataPort: f.promotions.createPostgresCommercePromoDataPort(f.runtime),
      request: { mode: "subscription", promoCodes: [], lines: [], acquisitionCapability: capability },
      options: { clientId, pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" } },
      regionCode: "ZZ", atTime: new Date().toISOString(), referenceProductMinor: 1000, subtotalGrossMinor: 1000, shippingGrossMinor: 0 }))
      .rejects.toMatchObject({ reason: "acquisition_terms_capability_required" });
  }
  const incompatible = await f.request(id);
  incompatible.quoteSnapshot.quote.context.pricingPolicy = { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v1" };
  await refused(() => f.port().createOrderDraft(incompatible, { clientId }), { reason: "acquisition_terms_v2_required" });
  expect(await f.effects()).toEqual(before);
});

it("refuses equal-money changed second promises, source revisions, omitted grants and paused definitions", async () => {
  const id = await f.promotion(), clientId = await f.client(), input = await f.request(id);
  await f.owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}','1300') WHERE promotion_id=$1", [id]);
  await refused(() => f.port().createOrderDraft(input, { clientId }), { message: "acquisition_terms_changed" });
  await f.owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set($2::jsonb,'{applies_to_payload,acquisitionTerms,revision}','\"demo-revised\"') WHERE promotion_id=$1", [id, configured(id)]);
  await refused(() => f.port().createOrderDraft(input, { clientId }), { message: "acquisition_terms_changed" });
  await f.owner.query("UPDATE public.commerce_promotion_definitions SET definition=$2 WHERE promotion_id=$1", [id, configured(id)]);
  await refused(() => f.port().createOrderDraft(awaitRequestWithoutOffer(), { clientId }), { message: "acquisition_terms_changed" });
  function awaitRequestWithoutOffer() {
    const copy = structuredClone(input); delete copy.quoteSnapshot.quote.context.acquisitionTerms; copy.quoteSnapshot.quote.discounts = []; return copy;
  }
  await f.owner.query("UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id=$1", [id]);
  await refused(() => f.port().createOrderDraft(input, { clientId }), { reason: "acquisition_terms_not_effective" });
});

it("retains paid-family ordinary admission for a new alias, rejects stale grant/marker, and matches uppercase UUIDs", async () => {
  const id = await f.promotion(), key = `paid${randomUUID()}`, base = await f.client(`${key}@example.invalid`);
  const subscription = randomUUID(), cycle = randomUUID();
  await f.owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,clock_timestamp())", [subscription, base]);
  await f.owner.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at) VALUES($1,$2,clock_timestamp())", [cycle, subscription]);
  const paid = await f.owner.connect();
  try {
    await paid.query("BEGIN");
    const order = randomUUID();
    await paid.query("INSERT INTO public.commerce_orders(id,client_id,status,subscription_cycle_id,currency_code,total_amount_minor) VALUES($1,$2,'paid',$3,'XXX',1000)", [order, base, cycle]);
    await paid.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,1000,1000)", [order]);
    await paid.query("COMMIT");
  } finally { await paid.query("ROLLBACK"); paid.release(); }
  const alias = await f.client(`${key}+new@example.invalid`, "2026-01-01T00:00:00Z", "ab127300-abcd-4123-8123-000000000007");
  expect(await f.eligibility().resolve(`${key}+new@example.invalid`)).toMatchObject({ clientId: alias, matchKind: "exact" });
  expect(await f.eligibility().hasPaidSubscription(alias.toUpperCase())).toBe(true);
  expect(await f.eligibility().hasPaidSubscription((await f.client()).toUpperCase())).toBe(false);
  const input = await f.request(id, false);
  delete input.quoteSnapshot.quote.context.acquisitionCapability;
  delete input.quoteSnapshot.quote.context.pricingPolicy;
  const result = await f.port().createOrderDraft(input, { clientId: alias.toUpperCase() });
  expect((await f.runtime.query("SELECT client_id::text FROM public.commerce_orders WHERE id=$1::uuid", [result.orderDraft.orderId.slice(6)])).rows).toEqual([{ client_id: alias }]);
  const stale = await f.request(id); stale.quoteSnapshot.quote.context.acquisitionTerms = { ...configured(id).applies_to_payload.acquisitionTerms as object, revision: "stale" };
  await refused(() => f.port().createOrderDraft(stale, { clientId: alias.toUpperCase() }), { message: "acquisition_terms_changed" });
  for (const semantic of [false, true]) {
    const grant = await f.request(id);
    delete grant.quoteSnapshot.quote.context.acquisitionTerms;
    if (semantic) grant.quoteSnapshot.quote.discounts[0] = { ...grant.quoteSnapshot.quote.discounts[0],
      promotionId: "retired-acquisition", reasonCode: "configured_acquisition" };
    await refused(() => f.port().createOrderDraft(grant, { clientId: alias.toUpperCase() }), { message: "acquisition_terms_changed" });
  }
  const marker = await f.request(id, false); marker.quoteSnapshot.quote.context.starterPack = { delivery2: { discountBps: 350 } };
  await refused(() => f.port().createOrderDraft(marker, { clientId: alias }), { message: "acquisition_terms_changed" });
});

it("rolls back the complete graph when persistence refuses stale catalogue money after admission", async () => {
  const id = await f.promotion(), clientId = await f.client(), input = await f.request(id), quote = input.quoteSnapshot.quote;
  quote.lines[0].unitPriceGross.amountMinor++;
  quote.lines[0].lineSubtotalGross.amountMinor++;
  quote.lines[0].tax.grossAmount.amountMinor++;
  quote.lines[0].tax.netAmount.amountMinor++;
  quote.subtotalGross.amountMinor++; quote.totalGross.amountMinor++; quote.netTotal.amountMinor++;
  await refused(() => f.port().createOrderDraft(input, { clientId }), { name: "CommerceOrderDraftPriceChangedError" });
});

async function blockedBy(pid: number | null, waiter: number | null = null) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await f.owner.query("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE wait_event_type='Lock' AND ($2::integer IS NULL OR pid=$2) AND ($1::integer IS NULL OR pg_blocking_pids(pid) @> ARRAY[$1]::integer[])) AS blocked", [pid, waiter])).rows[0].blocked) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

it("holds the definition row lock through the actual draft and commit on one runtime connection", async () => {
  const id = await f.promotion(), clientId = await f.client(), input = await f.request(id);
  let writer: Promise<unknown> | undefined, holderPid = 0;
  let retry: Promise<{ value: unknown } | { error: unknown }> | undefined, retryPid = 0;
  let connected: () => void = () => undefined;
  const retryConnected = new Promise<void>(resolve => { connected = resolve; });
  const retryPort = f.checkout.createPostgresAcquisitionCheckoutPersistence({ async connect() {
    const db = await f.runtime.connect(); retryPid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    connected(); return db;
  } }, { regionCode: "ZZ", financialPolicy: policy, isAcquisitionDiscount: () => false });
  const observed: string[] = [];
  const port = f.checkout.createPostgresAcquisitionCheckoutPersistence({ async connect() {
    const db = await f.runtime.connect(); holderPid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { release: () => db.release(), async query(sql, values) {
      observed.push(sql);
      const result = await db.query(sql, values);
      if (sql.includes("commerce_create_promoted_order_draft_with_outbox")) {
        writer = f.owner.query("UPDATE public.commerce_promotion_definitions SET active=false WHERE promotion_id=$1", [id]);
        expect(await blockedBy(holderPid)).toBe(true);
        retry = retryPort.createOrderDraft(input, { clientId }).then(value => ({ value }), error => ({ error }));
        await retryConnected;
        expect(await blockedBy(null, retryPid)).toBe(true);
      }
      return result;
    } };
  } }, { regionCode: "ZZ", financialPolicy: policy, isAcquisitionDiscount: () => false });
  const result = await port.createOrderDraft(input, { clientId });
  await writer;
  expect(await retry).toMatchObject({ value: { orderDraft: { orderId: result.orderDraft.orderId, replayed: true } } });
  expect(observed.at(-1)).toBe("COMMIT");
  expect(result.orderDraft.replayed).toBe(false);
  // Replay precedes current offer checks, including after a process-equivalent new factory.
  expect(await f.port().createOrderDraft({ ...input, idempotencyKey: ` ${input.idempotencyKey} ` }, { clientId: clientId.toUpperCase() }))
    .toMatchObject({ orderDraft: { orderId: result.orderDraft.orderId, replayed: true } });
  const restart = join(f.consumer, "restart.mjs");
  writeFileSync(restart, `import {readFileSync} from 'node:fs'; import {Pool} from 'pg';
import {createPostgresAcquisitionCheckoutPersistence} from '@openlup/platform/commerce/server/native-checkout';
const input=JSON.parse(readFileSync(0,'utf8')),db=new Pool({connectionString:input.url});
try {console.log(JSON.stringify(await createPostgresAcquisitionCheckoutPersistence(db,{regionCode:'ZZ',financialPolicy:{},isAcquisitionDiscount:()=>false}).createOrderDraft(input.request,{clientId:input.clientId})));}
finally {await db.end();}`);
  const replay = JSON.parse(execFileSync(process.execPath, [restart], { cwd: f.consumer, encoding: "utf8", timeout: 15_000,
    input: JSON.stringify({ url: f.runtimeUrl, request: input, clientId: clientId.toUpperCase() }) }));
  expect(replay).toMatchObject({ orderDraft: { orderId: result.orderDraft.orderId, replayed: true } });
  const changed = structuredClone(input); changed.quoteSnapshot.quote.context.cadenceDays = 42;
  await refused(() => f.port().createOrderDraft(changed, { clientId }), { name: "CommerceOrderDraftConflictError" });
});

it("waits behind an updating owner connection, then refuses the stale promise without a partial graph", async () => {
  const id = await f.promotion(), clientId = await f.client(), input = await f.request(id), owner = await f.owner.connect();
  let pending: Promise<unknown> | undefined;
  const before = await f.effects();
  try {
    await owner.query("BEGIN");
    const pid = (await owner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("UPDATE public.commerce_promotion_definitions SET definition=jsonb_set(definition,'{applies_to_payload,acquisitionTerms,delivery2DiscountBps}','1400') WHERE promotion_id=$1", [id]);
    pending = f.port().createOrderDraft(input, { clientId }).then(value => ({ value }), error => ({ error }));
    expect(await blockedBy(pid)).toBe(true);
    await owner.query("COMMIT");
    expect(await pending).toMatchObject({ error: { message: "acquisition_terms_changed" } });
    expect(await f.effects()).toEqual(before);
  } finally { await owner.query("ROLLBACK"); owner.release(); if (pending) await pending; }
});

it("keeps acquisition draft callers behind the adapter and the starter's direct quote free of acquisition evidence", () => {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : /\.tsx?$/.test(path) && !/\.(test|spec)\./.test(path) ? [path] : [];
  });
  const callers: { path: string; factory: string; owner: string | undefined }[] = [];
  for (const path of ["api", "mcp", "server", "src", "examples", "packages/core/src", "packages/outbox/src", "packages/platform/src"].flatMap(walk)) {
    const text = readFileSync(path, "utf8");
    if (!/createPostgresNativeCheckoutPersistence|createPostgresCommerceOrderJourneyPorts/.test(text)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const factory = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
        if (factory === "createPostgresNativeCheckoutPersistence" || factory === "createPostgresCommerceOrderJourneyPorts") {
          let parent: ts.Node | undefined = node.parent;
          while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
          callers.push({ path, factory, owner: parent && ts.isFunctionDeclaration(parent) ? parent.name?.text : undefined });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const ordinary = "examples/neutral-store/host/purchase-composition.ts";
  expect(callers).toEqual([{ path: ordinary, factory: "createPostgresNativeCheckoutPersistence", owner: "composePurchaseCapabilities" },
    { path: "packages/platform/src/commerce/server/native-checkout/index.ts",
    factory: "createPostgresNativeCheckoutPersistence", owner: "createPostgresAcquisitionCheckoutPersistence" }]);
  const source = ts.createSourceFile(ordinary, readFileSync(ordinary, "utf8"), ts.ScriptTarget.Latest, true);
  let snapshot: ts.VariableDeclaration | undefined;
  let references = 0;
  const inspect = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "quoteSnapshot") references++;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "quoteSnapshot") snapshot = node;
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  expect(references).toBe(2); // Declaration and the direct draft argument; no mutation or replacement.
  expect(snapshot && ts.getCombinedNodeFlags(snapshot.parent) & ts.NodeFlags.Const).toBeTruthy();
  const property = (expression: ts.Expression | undefined, name: string): ts.Expression => {
    if (!expression || !ts.isObjectLiteralExpression(expression)) throw new Error("Expected a literal quote");
    const entry = expression.properties.find(entry => ts.isPropertyAssignment(entry) && entry.name.getText(source) === name);
    if (!entry || !ts.isPropertyAssignment(entry)) throw new Error("Expected a literal quote property");
    return entry.initializer;
  };
  const keys = (expression: ts.Expression): string[] => {
    if (!ts.isObjectLiteralExpression(expression)) throw new Error("Expected a literal context");
    return expression.properties.flatMap(entry => ts.isSpreadAssignment(entry) ? keys(entry.expression) : [entry.name!.getText(source)]);
  };
  const quote = property(snapshot?.initializer, "quote"), discounts = property(quote, "discounts");
  expect(ts.isArrayLiteralExpression(discounts) && discounts.elements.length === 0).toBe(true);
  expect(keys(property(quote, "context"))).toEqual(["mode", "cadenceDays", "promoCodes", "starterRequest"]);
});
