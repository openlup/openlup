import type { NativeCustomerSubscriptionSnapshot, NativeCustomerNewsletterPreferences } from "@openlup/platform/account-support/contracts";
import type { CustomerSubscriptionControlResponse } from "../../src/domains/customers/subscriptionControlContracts.js";
import type { CustomerCommunicationPreferencesResponse } from "../../src/domains/communications/customerPreferencesContracts.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, expectTypeOf, it, vi } from "vitest";
import { renewal } from "./subscriptionNativeFixture.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { assertConsumerIsolation, platformConsumerInstallArgs } from "../../scripts/packages/platform-cold-consumer.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const principalId = "b1100000-0000-4000-8000-000000000001", clientId = "b1100000-0000-4000-8000-000000000002";
const otherPrincipal = "b1100000-0000-4000-8000-000000000003", otherClient = "b1100000-0000-4000-8000-000000000004";
const orderId = "b1100000-0000-4000-8000-000000000005", foreignOrder = "b1100000-0000-4000-8000-000000000006";
const subscriptionId = "b1100000-0000-4000-8000-000000000007", productId = "b1100000-0000-4000-8000-000000000008";
const skuId = "b1100000-0000-4000-8000-000000000009", shipmentId = "b1100000-0000-4000-8000-000000000010";
const replacementId = "b1100000-0000-4000-8000-000000000011";
const at = "2026-11-01T12:00:00.000Z", next = "2026-12-01T12:00:00.000Z";
const money = (amountMinor: number) => ({ amountMinor, currency: "EUR" });
const quote = { currency: "EUR", subtotalGross: money(1200), discountTotalGross: money(100),
  shippingGross: money(200), shippingDiscountGross: money(200), taxTotal: money(183), totalGross: money(1100),
  lines: [{ sku: "NEUTRAL-READ-1", productSlug: "neutral-read", quantity: 2,
    unitPriceGross: money(600), lineSubtotalGross: money(1200), tax: { vatRateBps: 2000 } }] };
const selection: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
  migrationLogin: "postgres", bootstrapLogin: "postgres", runtimeLogin: "account_read_runtime", restoreLogin: "account_read_restore" };
let container: PostgresContainer | undefined, admin: Pool, installer: Pool, runtime: Pool;
let scratch: string, consumer: string;
let native: typeof import("@openlup/platform/account-support");
let account: typeof import("@openlup/platform/account-support");
let data: typeof import("@openlup/platform/data");
const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: "pipe", timeout: 180_000 });
const executor = { async query(sql: string, values?: unknown[]) {
  const client = await runtime.connect();
  try { await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL ROLE service_role");
    const result = await client.query(sql, values); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
} };
const projection = {
  automaticHoldSource: "native.read.hold", automaticReleaseSource: "native.read.release", orderReference: (id: string) => `ORD-${id}`,
  presentation: { display: () => ({ title: "Captured item", variantName: null, productSlug: "neutral-read", displayLabel: null, accentColor: null }) },
  fulfillmentEvidence: ({ trackingRefs }: { trackingRefs: Record<string, unknown>[] }) => {
    const refs = trackingRefs.map(row => ({ providerKind: String(row.provider_kind), trackingNumber: String(row.provider_tracking_id),
      trackingUrl: row.tracking_url as string | null, carrierKind: row.carrier_kind as string | null,
      service: row.service as string | null, updatedAt: row.updated_at as string | null }));
    return { trackingReferences: refs, trackingNumbers: refs.map(row => row.trackingNumber), trackingNumber: refs[0]?.trackingNumber ?? null,
      trackingUrl: refs[0]?.trackingUrl ?? null, carrierKind: refs[0]?.carrierKind ?? null, service: refs[0]?.service ?? null, trackingTimeline: [] };
  },
};
function store(scope = { principalId, clientId }) {
  return native.createPostgresCustomerOrderHistoryReadStore(executor, { ...scope, readInvoiceSummaries: async () => new Map() });
}
function sources(scope = { principalId, clientId }) {
  return native.createPostgresAccountReadSources(executor, { ...scope, orders: store(scope), orderProjection: projection,
    now: () => at, additional: {
      readExtension: async () => ({ note: "host-owned" }), readAddresses: async () => [], readOrdererProfiles: async () => [],
      readPaymentPreferences: async () => [], readDeliveryPreferences: async () => [], readEvents: async () => [], readNextCharges: async () => new Map(),
    } });
}
async function state() {
  const tables = ["clients", "subscriptions", "subscription_lines", "commerce_orders", "commerce_order_items", "fulfillment_shipments", "subscription_events"];
  return Promise.all(tables.map(async table => (await admin.query(`SELECT to_jsonb(row) AS row FROM public.${table} row ORDER BY to_jsonb(row)::text`)).rows));
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("native account reads require Docker; mandatory qualified-v2 proof missing");
  scratch = mkdtempSync(join(tmpdir(), "native-account-packed-"));
  const tarballs = ["packages/core", "packages/platform", "node_modules/zod"].map(directory => {
    const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], resolve(directory)));
    return join(scratch, packed[0].filename);
  });
  consumer = join(scratch, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"type":"module","private":true}');
  npm(platformConsumerInstallArgs(tarballs), consumer);
  assertConsumerIsolation(consumer, process.cwd());
  const installedResolve = createRequire(join(consumer, "package.json")).resolve;
  native = await import(pathToFileURL(installedResolve("@openlup/platform/account-support")).href);
  account = await import(pathToFileURL(installedResolve("@openlup/platform/account-support")).href);
  data = await import(pathToFileURL(installedResolve("@openlup/platform/data")).href);
  writeFileSync(join(consumer, "native-account.ts"), `import * as native from '@openlup/platform/account-support';
    const db = {query: async (_sql: string, _values?: unknown[]) => ({rows: [] as Record<string,unknown>[]})};
    const scope = {principalId: '${principalId}', clientId: '${clientId}'};
    native.readPostgresCustomerAccountClient(db, scope);
    native.createPostgresCustomerOrderHistoryReadStore(db, {...scope, readInvoiceSummaries: async () => new Map()}).readPaidActivationGaps([]);
    const rpc = {rpc: async () => ({data: null, error: null})};
    native.createPostgresCustomerSubscriptionSnapshotPort(rpc).getSnapshot();
    native.createPostgresCustomerNewsletterPreferencesPort(rpc).withdrawNewsletter();
    export type Factory = typeof native.createPostgresAccountReadSources;`);
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({compilerOptions: {target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: []}, files: ["native-account.ts"]}));
  for (const mode of ["NodeNext", "Bundler"]) {
    execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--strict", "--noEmit", "--skipLibCheck", "false",
      "--target", "ES2022", "--module", mode === "Bundler" ? "ESNext" : "NodeNext", "--moduleResolution", mode,
      "-p", "tsconfig.json"], { cwd: consumer, stdio: "pipe" });
  }
  container = await runPostgresContainer({ name: `m19-g11-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("native account PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  for (const login of [selection.runtimeLogin, selection.restoreLogin!]) {
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD 'synthetic-account' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }
  const url = new URL(container.connectionString);
  url.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
  installer = new Pool({ connectionString: url.toString() });
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => installer });
  expect((await runner.apply()).applied.length).toBeGreaterThan(90);
  expect(await runner.apply()).toEqual({ applied: [] });
  url.search = ""; url.username = selection.runtimeLogin; url.password = "synthetic-account";
  runtime = new Pool({ connectionString: url.toString() });
  await admin.query("INSERT INTO public.clients(id,principal_id,email,lifecycle_stage) VALUES($1,$2,'account-a@example.invalid','customer'),($3,$4,'account-b@example.invalid','customer')", [clientId, principalId, otherClient, otherPrincipal]);
  await admin.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'neutral-read','Neutral item')", [productId]);
  await admin.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,'NEUTRAL-READ-1','Neutral item')", [skuId, productId]);
  await admin.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,composition_constraint) VALUES($1,$2,28,$3,$4)", [subscriptionId, clientId, next, { kind: "plan_days", value: 21 }]);
  await admin.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code) VALUES($1,$2,2,0,600,'EUR')", [subscriptionId, skuId]);
  await admin.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [subscriptionId]);
  const seed = await admin.connect();
  try {
    await seed.query("BEGIN");
    await seed.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,metadata) VALUES($1,$2,'paid','EUR',1100,$3),($4,$5,'paid','EUR',1100,$3)", [orderId, clientId, { quoteSnapshot: { quote } }, foreignOrder, otherClient]);
    await seed.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor,source_line_ordinal,catalog_unit_amount_minor,catalog_line_amount_minor,promotion_discount_allocated_minor,promotion_allocation_fingerprint) VALUES($1,$2,1,2,550,1100,1,600,1200,100,repeat('a',64)),($3,$2,1,2,550,1100,1,600,1200,100,repeat('a',64))", [orderId, skuId, foreignOrder]);
    await seed.query("COMMIT");
  } catch (error) { await seed.query("ROLLBACK"); throw error; } finally { seed.release(); }
  await admin.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('account-proof','simulator',true)");
  await admin.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key) VALUES($1,$2,'account-proof','simulator','account-proof-original')", [shipmentId, orderId]);
  await admin.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key,sequence_no,replaces_shipment_id,replacement_reason) VALUES($1,$2,'account-proof','simulator','account-proof-replacement',1,$3,'lost')", [replacementId, orderId, shipmentId]);
  await admin.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id) VALUES($1,'tracking','OLD-TRACK'),($2,'tracking','NEW-TRACK')", [shipmentId, replacementId]);
  await admin.query("INSERT INTO public.fulfillment_observations(event_key,shipment_id,observation,first_received_at,status_recorded) VALUES('account-read-observation',$1,$2,$3,true)", [replacementId, {
    fact: { canonicalStatus: "in_transit", occurredAt: at }, providerStatus: { primary: "shipped", subStatus: null },
    trackingRefs: [{ trackingNumber: "NEW-TRACK", carrierRef: "carrier-a", serviceRef: "standard", publicUrl: "https://tracking.example.invalid/NEW-TRACK" }],
  }, at]);
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [admin, installer, runtime].filter(Boolean)); if (scratch) rmSync(scratch, { recursive: true, force: true }); }, postgresTeardownTimeoutMs);

it("uses installed factories over restricted qualified-v2 role, preserves money, selects replacement tracking and replays without writes", async () => {
  expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  const before = await state();
  const owned = store();
  const result = await account.readCustomerOrderDetail(owned, clientId, orderId, projection);
  expect(result?.order).toMatchObject({ total: money(1100), subtotal: money(1200), discount: money(100), shipping: money(0), tax: money(183), trackingNumber: "NEW-TRACK", trackingUrl: "https://tracking.example.invalid/NEW-TRACK", carrierKind: "carrier-a" });
  expect(result?.order.lines[0]).toMatchObject({ quantity: 2, total: money(1200) });
  expect(await account.readCustomerOrderDetail(owned, clientId, orderId, projection)).toEqual(result);
  expect((await account.readCustomerOrderSummaries(owned, clientId, 20, projection)).orders).toHaveLength(1);
  expect(await state()).toEqual(before);
});
it("refuses foreign identities and companion-ID bypasses, including invoice callbacks", async () => {
  const before = await state(), foreignScope = store({ principalId, clientId: otherClient });
  expect(await foreignScope.readCustomerOrder(otherClient, foreignOrder)).toBeNull();
  expect(await store().readCustomerOrder(clientId, foreignOrder)).toBeNull();
  const invoices = vi.fn(async () => new Map());
  const owned = native.createPostgresCustomerOrderHistoryReadStore(executor, { principalId, clientId, readInvoiceSummaries: invoices });
  for (const read of [owned.readPaymentStatuses, owned.readTracking, owned.readFulfillmentOperations, owned.readStatusEvidence,
    owned.readReleasedProviderExceptionHolds]) expect((await read([foreignOrder])).size).toBe(0);
  expect(await owned.readOrderLines(foreignOrder)).toEqual([]);
  expect(await owned.readInvoiceSummaries([foreignOrder])).toEqual(new Map()); expect(invoices).not.toHaveBeenCalled();
  expect(await native.readPostgresCustomerAccountClient(executor, { principalId, clientId: otherClient })).toBeNull();
  expect(await state()).toEqual(before);
});
it("composes native subscriptions and identity while refusing missing profile/event sections", async () => {
  const before = await state(), source = sources();
  expect(await source.readSubscriptionRows(clientId, 50)).toMatchObject([{ id: subscriptionId, size_constraint: { kind: "plan_days", value: 21 } }]);
  expect((await source.readSubscriptionLines([subscriptionId])).get(subscriptionId)).toMatchObject([{ qty: 2, unitPrice: money(600), lineSubtotal: money(1200) }]);
  expect(await source.readSubscriptionBlockers([subscriptionId], new Map([[subscriptionId, next]]))).toEqual(new Map());
  expect(await source.readPauseWindows([subscriptionId])).toEqual(new Map());
  expect((await source.readPaymentEvidence([subscriptionId])).get(subscriptionId)?.healthState).toBe("healthy");
  expect(await source.readDeliveryAlignments(new Map([[subscriptionId, next]]))).toEqual(new Map());
  expect(await source.readActionStates([subscriptionId])).toEqual(new Map());
  const client = await native.readPostgresCustomerAccountClient(executor, { principalId, clientId });
  const snapshot = await account.readAccountSnapshot(source, { paymentMethodStatus: () => "missing", canUsePaymentMethodForRenewal: value => value === "usable",
    packageSummary: () => null, withNextCharge: recurring => ({ recurringPrice: recurring, nextCharge: null }) }, client!);
  expect(snapshot).toMatchObject({ profile: { clientId }, subscriptions: [{ subscriptionId, sizeConstraint: { kind: "plan_days", value: 21 }, recurringPrice: { totalGross: money(1200) } }], recentOrders: [{ orderId }] });
  const unbound = native.createPostgresAccountReadSources(executor, { principalId, clientId, orders: store(), orderProjection: projection,
    now: () => at, additional: { readExtension: async () => null, readNextCharges: async () => new Map() } });
  for (const [read, section] of [[unbound.readAddresses,"addresses"], [unbound.readOrdererProfiles,"billingProfiles"],
    [unbound.readPaymentPreferences,"paymentPreferences"], [unbound.readDeliveryPreferences,"deliveryPreferences"],
    [unbound.readEvents,"events"]] as const) await expect(read(clientId)).rejects.toMatchObject({ code: "host_binding_required", section });
  expect(await unbound.readSubscriptionRows(clientId, 50)).toMatchObject([{ id: subscriptionId }]);
  expect(client).toMatchObject({ id: clientId, email: "account-a@example.invalid" });
  expect(await state()).toEqual(before);
});
it("uses actor-scoped A129 and newsletter withdrawal, refuses cross-account selection and proves idempotent evaluator denial", async () => {
  // This cross-boundary file is checked by the required public tsconfig.tests project.
  expectTypeOf<NativeCustomerSubscriptionSnapshot>().toEqualTypeOf<CustomerSubscriptionControlResponse>();
  expectTypeOf<NativeCustomerNewsletterPreferences>().toEqualTypeOf<CustomerCommunicationPreferencesResponse>();
  const gateway = data.createPostgresDataGateway({ connectionString: "injected-owned-pool" }, { poolFactory: () => runtime });
  const asActor = <T>(principal: string, work: (rpc: Parameters<typeof native.createPostgresCustomerSubscriptionSnapshotPort>[0]) => Promise<T>) =>
    gateway.asActor({ sub: principal }, raw => work(raw as Parameters<typeof native.createPostgresCustomerSubscriptionSnapshotPort>[0]));
  expect(await asActor(principalId, rpc => native.createPostgresCustomerSubscriptionSnapshotPort(rpc).getSnapshot()))
    .toMatchObject({ subscriptions: [{ subscriptionId, lines: [{ quantity: 2 }] }] });
  expect(await asActor(otherPrincipal, rpc => native.createPostgresCustomerSubscriptionSnapshotPort(rpc).getSnapshot()))
    .toMatchObject({ subscriptions: [] });
  await asActor(principalId, rpc => rpc.rpc("customer_communication_preferences_set_as_actor", { p_marketing_newsletter_consent: true }));
  await expect(asActor(principalId, rpc => native.createPostgresCustomerNewsletterPreferencesPort(rpc).getPreferences()))
    .rejects.toMatchObject({ code: "host_binding_required", section: "newsletterConsent" });
  expect((await admin.query("SELECT * FROM public.communication_recipient_consents WHERE purpose='marketing_newsletter'")).rows).toEqual([]);
  await admin.query("INSERT INTO public.communication_recipient_consents(recipient_fingerprint,purpose,state) VALUES(encode(sha256(convert_to('account-a@example.invalid','UTF8')),'hex'),'marketing_newsletter','granted')");
  const first = await asActor(principalId, rpc => native.createPostgresCustomerNewsletterPreferencesPort(rpc).withdrawNewsletter());
  expect(first?.marketingNewsletter).toMatchObject({ granted: false, state: "denied" });
  const events = await admin.query("SELECT * FROM public.customer_communication_preference_events WHERE principal_id=$1", [principalId]);
  expect(await asActor(principalId, rpc => native.createPostgresCustomerNewsletterPreferencesPort(rpc).withdrawNewsletter())).toEqual(first);
  expect((await admin.query("SELECT * FROM public.customer_communication_preference_events WHERE principal_id=$1", [principalId])).rows).toEqual(events.rows);
  expect((await admin.query("SELECT state FROM public.communication_recipient_consents WHERE purpose='marketing_newsletter'")).rows).toEqual([{ state: "denied" }]);
  expect((await asActor(otherPrincipal, rpc => native.createPostgresCustomerNewsletterPreferencesPort(rpc).getPreferences()))?.marketingNewsletter.state).toBe("unknown");
  await admin.query("UPDATE public.communication_recipient_consents SET state='suppressed' WHERE purpose='marketing_newsletter'");
  await asActor(principalId, rpc => native.createPostgresCustomerNewsletterPreferencesPort(rpc).withdrawNewsletter());
  expect((await admin.query("SELECT state FROM public.communication_recipient_consents WHERE purpose='marketing_newsletter'")).rows).toEqual([{ state: "suppressed" }]);
  const browser = await runtime.connect();
  try {
    await browser.query("BEGIN"); await browser.query("SET LOCAL ROLE authenticated");
    await expect(browser.query("SELECT * FROM public.commerce_orders")).rejects.toMatchObject({ code: "42501" });
  } finally { await browser.query("ROLLBACK"); browser.release(); }
});

it("reads native pause, paid-cycle blocker, dunning priority/cause and current alignment without moving a schedule", async () => {
  const cycle = "b1100000-0000-4000-8000-000000000012";
  await admin.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3,'paid')", [cycle, subscriptionId, next]);
  await admin.query("INSERT INTO public.subscription_pause_windows(subscription_id,pause_preset,starts_at,ends_at,idempotency_key) VALUES($1,'2_weeks',$2,'2026-11-15T12:00:00Z','account-read-pause')", [subscriptionId, at]);
  const source = sources();
  expect((await source.readPauseWindows([subscriptionId])).get(subscriptionId)).toMatchObject({ pausePreset: "2_weeks" });
  expect((await source.readSubscriptionBlockers([subscriptionId], new Map([[subscriptionId,next]]))).get(subscriptionId)).toBe("cycle_locked");
  expect(await source.readSubscriptionBlockers([subscriptionId], new Map([[subscriptionId,"2026-12-01T12:00:00.000001Z"]]))).toEqual(new Map());
  expect(await source.readSubscriptionBlockers([subscriptionId], new Map([[subscriptionId,"2027-01-01T12:00:00Z"]]))).toEqual(new Map());
  await admin.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key,failure_class,next_retry_at) VALUES($1,$2,'account-read-dunning','sca_required',$3)", [subscriptionId, clientId, next]);
  expect((await source.readSubscriptionBlockers([subscriptionId], new Map([[subscriptionId,next]]))).get(subscriptionId)).toBe("payment_blocked");
  expect((await source.readActionStates([subscriptionId])).get(subscriptionId)).toMatchObject({ blockedReason: "payment_blocked", failureCause: "needs_confirmation", recoveryEligible: false });
  await admin.query("INSERT INTO public.subscription_delivery_alignment_cases(predecessor_order_id,subscription_id,predecessor_cycle_id,captured_mode,state,evidence_kind,aligned_next_cycle_at,aligned_at) VALUES($1,$2,$3,'auto_align','aligned','overdue_renewal',$4,$5)", [orderId,subscriptionId,cycle,next,at]);
  expect((await source.readDeliveryAlignments(new Map([[subscriptionId,next]]))).get(subscriptionId)).toEqual({state:"aligned"});
  expect(await source.readDeliveryAlignments(new Map([[subscriptionId,"2026-12-01T12:00:00.000001Z"]]))).toEqual(new Map());
  expect(await source.readDeliveryAlignments(new Map([[subscriptionId,"2027-01-01T12:00:00Z"]]))).toEqual(new Map());
  const before = await state();
  await source.readActionStates([subscriptionId]); await source.readDeliveryAlignments(new Map([[subscriptionId,next]]));
  expect(await state()).toEqual(before);
});

it("reads current stock-wait evidence and hides closed or superseded schedules", async () => {
  const f = await renewal(admin, 0);
  const actor = "b1100000-0000-4000-8000-000000000013";
  await admin.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.client,actor]);
  await admin.query("INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits) VALUES($1,$2,$3,$4,2,'waiting',$5,$5,$6,$7,'[]')", [f.subscription,f.client,f.operation,f.snapshot.scheduledAt,f.snapshot,f.fingerprint,f.identity]);
  const source = sources({ principalId: actor, clientId: f.client });
  expect((await source.readPaymentEvidence([f.subscription])).get(f.subscription)?.stockWaitState).toBe("waiting");
  await admin.query("UPDATE public.subscription_stock_wait_cases SET state='closed',closed_at=$2 WHERE subscription_id=$1", [f.subscription,at]);
  expect((await source.readPaymentEvidence([f.subscription])).get(f.subscription)?.stockWaitState).toBeNull();
  await admin.query("UPDATE public.subscription_stock_wait_cases SET state='waiting',closed_at=NULL WHERE subscription_id=$1", [f.subscription]);
  await admin.query("UPDATE public.subscriptions SET next_cycle_at='2027-01-01T12:00:00Z' WHERE id=$1", [f.subscription]);
  expect((await source.readPaymentEvidence([f.subscription])).get(f.subscription)?.stockWaitState).toBeNull();
});

it("keeps positive customer cancellation visibility and bounds rows before hiding system/operator history", async () => {
  const owner = "b1100000-0000-4000-8000-000000000030", actor = "b1100000-0000-4000-8000-000000000031";
  const ghost = "b1100000-0000-4000-8000-000000000032", customer = "b1100000-0000-4000-8000-000000000033";
  const active = "b1100000-0000-4000-8000-000000000034", operator = "b1100000-0000-4000-8000-000000000035";
  const historical = "b1100000-0000-4000-8000-000000000036";
  await admin.query("INSERT INTO public.clients(id,principal_id,email) VALUES($1,$2,'visibility@example.invalid')", [owner,actor]);
  await admin.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,status,started_at,ended_at,created_at) VALUES
    ($1,$6,28,'cancelled','2026-01-01',$7,'2026-10-05'),
    ($2,$6,28,'cancelled','2026-01-01',$7,'2026-10-04'),
    ($3,$6,28,'active','2026-01-01',NULL,'2026-10-01'),
    ($4,$6,28,'cancelled','2026-01-01',$7,'2026-10-03'),
    ($5,$6,28,'cancelled','2026-01-01',$7,'2026-10-02')`, [ghost,customer,active,operator,historical,owner,at]);
  await admin.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at) VALUES
    ($1,'subscription.customer_self_service.cancel','visibility-customer','{}',$4),
    ($2,'subscription.customer_self_service.cancel','visibility-operator','{"payload":{"actorKind":"operator"}}',$4),
    ($3,'subscription.customer_self_service.cancel','visibility-history','{"payload":{"actorKind":"customer"}}',$4::timestamptz-interval '1 second')`, [customer,operator,historical,at]);
  const source = sources({ principalId: actor, clientId: owner });
  const bounded = await source.readSubscriptionRows(owner, 2);
  expect(bounded.map(row => row.id)).toEqual([ghost,customer]);
  expect(bounded.filter(account.isCustomerVisibleSubscription).map(row => row.id)).toEqual([customer]);
  expect((await source.readSubscriptionRows(owner, 50)).filter(account.isCustomerVisibleSubscription).map(row => row.id)).toEqual([customer,active]);
});


it("shows recorded legacy summaries and owned paid-activation gaps without inventing a subscription", async () => {
  const legacy = "b1100000-0000-4000-8000-000000000040";
  const seed = await admin.connect();
  try {
    await seed.query("BEGIN");
    await seed.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'paid','EUR',1100)", [legacy,clientId]);
    await seed.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,1,2,550,1100)", [legacy,skuId]);
    await seed.query("COMMIT");
  } catch (error) { await seed.query("ROLLBACK"); throw error; } finally { seed.release(); }
  for (const [id, owner] of [[legacy,clientId],[foreignOrder,otherClient]]) {
    await admin.query("INSERT INTO public.subscription_activations(order_id,client_id,cadence_days,declare_idempotency_key) VALUES($1,$2,28,$3)", [id,owner,`account-gap-${id}`]);
    await admin.query("INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at) VALUES($1,'account-read','settled',1100,'EUR',$2,$3)", [id,`account-settled-${id}`,at]);
  }
  const before = await state(), owned = store();
  const summaries = await account.readCustomerOrderSummaries(owned, clientId, 20, projection);
  expect(summaries.orders.find(row => row.orderId === legacy)).toMatchObject({ total: money(1100), subscriptionId: null,
    paymentStatus: "succeeded" });
  const gaps = await owned.readPaidActivationGaps([legacy,foreignOrder]);
  expect([...gaps]).toEqual([[legacy, { orderId: legacy, paidAt: expect.any(String) }]]);
  expect(await sources().readPaidActivationGaps([legacy,foreignOrder])).toEqual(gaps);
  expect(await store({ principalId,clientId: otherClient }).readPaidActivationGaps([foreignOrder])).toEqual(new Map());
  expect(summaries.orders.some(row => row.orderId === foreignOrder)).toBe(false);
  expect(await store({ principalId, clientId: otherClient }).readCustomerOrders(otherClient, [], 20)).toEqual([]);
  const lines = await owned.readOrderLines(legacy);
  expect(lines).toMatchObject([{ quantity: 2, unit_price_cents: 550, total_cents: 1100 }]);
  expect(lines[0]).not.toHaveProperty("vat_rate_bps");
  await expect(account.readCustomerOrderDetail(owned,clientId,legacy,projection)).rejects.toThrow("native_account_order_money_unavailable");
  expect((await account.readCustomerOrderSummaries(owned,clientId,20,projection)).orders).toEqual(summaries.orders);
  expect(await state()).toEqual(before);
});
