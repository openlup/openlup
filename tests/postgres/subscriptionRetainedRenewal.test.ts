import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, expect, it, vi } from "vitest";
import { api, purchase, admin, at, days, deps, executor, facts, inventory, now, rpc, runtime, transaction, checkout, destinations, fulfillment, identity, payments, runtimeUrl, captureStore, withRestoredStore } from "./subscriptionPublicRenewalFixture.js";
import { allPublicRows } from "./subscriptionStockWaitCases.js";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import type { RenewalRetainedTerms } from "@openlup/platform/subscriptions/contracts";

const terms = (discount = 51): RenewalRetainedTerms => ({ version: "native.renewal-terms.v1",
  shippingTerms: { version: "shipping-threshold.v1", currency: "XXX", flatMinor: 37, freeThresholdMinor: 150 },
  minimumPayableMinor: 23, normalCadenceDays: [21, 30, 45],
  linePricing: [{ sku: "G7-REFILL", quantity: 2, unitAmountMinor: 100, isAddon: false,
    quoteLine: { unitPriceGross: { amountMinor: 100 }, lineSubtotalGross: { amountMinor: 200 },
      pricingComponents: [{ componentType: "base_unit", amountMinor: 200 }] } }],
  starterPack: { schemaVersion: "1", starterIntervalDays: 28, basisTemplateVersion: 777,
    delivery2: { discountBps: 2500, discountMinor: discount, basisSubtotalMinor: 200 },
    graduation: { cadenceDays: 30, sizeConstraint: { kind: "configured" }, lines: [{ sku: "G7-REFILL", qty: 3,
      sortOrder: 0, isAddon: false, quoteLine: { unitPriceGross: { amountMinor: 100 }, lineSubtotalGross: { amountMinor: 300 } } }] } } });
async function active(retained = terms(), options: { addon?: boolean | number; shipping?: number; authorizedAt?: string } = {}) {
  const addonQuantity = typeof options.addon === "number" ? options.addon : 1;
  const p = options.addon ? await addonPurchase(addonQuantity) : await purchase();
  const input = { ...facts, shippingAmountMinor: options.shipping ?? 0,
    lines: [...facts.lines, ...(options.addon ? [{ lineOrdinal: 2, sku: "SYNTHETIC-ADDON", quantity: addonQuantity, unitAmountMinor: 40 }] : [])],
    unattendedChargeAuthorizedAt: options.authorizedAt ?? "2026-01-01T00:00:00.123456Z", renewalTerms: retained };
  const result = await api.activateNativePurchaseWithRenewal(executor, { ...p, orderId: p.orderId.toUpperCase(), facts: input });
  expect(result.renewalAttachment).toBe("complete");
  return { ...p, subscriptionId: String(result.activation.subscriptionId), input };
}
async function driver(subscriptionId: string, when = now) {
  const d = await deps(subscriptionId, "succeeded", when);
  d.input.settlement = api.createPostgresRenewalSettlementPort(executor, d.codec, transaction);
  return d;
}
beforeEach(async () => {
  // Fixture isolation is owner-only; the journeys below use the installed package
  // and its restricted runtime, without writing their terms/cycles by hand.
  await admin.query("UPDATE public.subscriptions SET status='cancelled' WHERE status='active'");
});

it.each([149, 150, 151])("retained threshold after discounts at %i charges once and replays without writes", async product => {
  const f = await active(terms(200 - product));
  const d = await driver(f.subscriptionId), shipping = product < 150 ? 37 : 0;
  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, { ...d.due, subscriptionId: f.subscriptionId.toUpperCase() }, now);
  expect(result.status).toBe("succeeded"); expect(d.execute).toHaveBeenCalledTimes(1);
  expect(d.execute.mock.calls[0][0].amountMinor).toBe(product + shipping);
  const op = (await d.input.store.readRenewal(result.identityKey))!;
  expect(op.cycleSnapshot.pricingSnapshot).toMatchObject({ productSubtotalAmountMinor: 200,
    discountAmountMinor: 200 - product, totalAmountMinor: product + shipping, shippingAmountMinor: shipping });
  const money = (await runtime.query(`SELECT o.total_amount_minor::integer AS total,
    (SELECT sum(line_amount_minor)::integer FROM public.commerce_order_items WHERE order_id=o.id) AS items,
    (SELECT count(*)::integer FROM public.commerce_order_adjustments WHERE order_id=o.id) AS adjustments,
    (SELECT COALESCE(sum(amount_minor),0)::integer FROM public.commerce_order_adjustments WHERE order_id=o.id) AS shipping
    FROM public.commerce_orders o WHERE o.id=$1`, [op.orderId])).rows[0];
  expect(money).toEqual({ total: product + shipping, items: product, shipping, adjustments: shipping ? 1 : 0 });
  const before = await allPublicRows(admin);
  expect(await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, days(now, 1))).toMatchObject({ status: "terminal_replay", operationId: op.operationId });
  expect(d.execute).toHaveBeenCalledTimes(1); expect(await allPublicRows(admin)).toEqual(before);
}, 30_000);

it("graduates before delivery three, leaves the due anchor, and repeats the frozen snapshot", async () => {
  const f = await active(), d = await driver(f.subscriptionId);
  expect((await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now)).status).toBe("succeeded");
  const nextAt = (await runtime.query("SELECT to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0].at;
  const later = await driver(f.subscriptionId, String(nextAt));
  const snapshot = await later.input.store.buildCycleSnapshots(later.due);
  expect(snapshot).toMatchObject({ templateSnapshot: { version: 2, cadenceDays: 30, lines: [{ quantity: 3 }] },
    pricingSnapshot: { totalAmountMinor: 300, discountAmountMinor: 0, shippingAmountMinor: 0 } });
  expect((await runtime.query("SELECT next_cycle_at=$2::timestamptz AS same,status FROM public.subscriptions WHERE id=$1", [f.subscriptionId, nextAt])).rows[0]).toEqual({ same: true, status: "active" });
  expect((await runtime.query("SELECT payload FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.starter_graduated'", [f.subscriptionId])).rows).toHaveLength(1);
  expect(await api.runOneAutomaticSubscriptionRenewal(later.input, later.due, String(nextAt))).toMatchObject({ status: "succeeded" });
  const bound = (await later.input.store.readRenewal(later.codec.identity(snapshot)))!.cycleSnapshot;
  expect(bound.orderSnapshot.shippingAddressRef).toBeTruthy();
  expect(bound).toEqual(later.codec.withDestination!(snapshot, bound.orderSnapshot.shippingAddressRef!));
  const before = await allPublicRows(admin);
  expect(await later.input.store.buildCycleSnapshots(later.due)).toEqual(bound);
  expect(await allPublicRows(admin)).toEqual(before);
}, 30_000);

it("requires a settlement transaction and rolls back every artifact on a projection failure", async () => {
  const f = await active(), d = await driver(f.subscriptionId);
  const snapshot = await d.input.store.buildCycleSnapshots(d.due);
  const claim = await d.input.store.claimDue({ snapshot, workerId: "projection-proof", now });
  expect(await inventory.createPostgresRenewalReservationPort(executor).reserve({ operationId: claim.operationId, claimToken: claim.claimToken, now })).toMatchObject({ reserved: true });
  const input = { operationId: claim.operationId, claimToken: claim.claimToken, now };
  const before = await allPublicRows(admin);
  await expect(api.createPostgresRenewalSettlementPort(executor, d.codec).prepareRenewal(input)).rejects.toThrow("transaction_required");
  expect(await allPublicRows(admin)).toEqual(before);
  const fail = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("INSERT INTO public.commerce_order_adjustments")) throw new Error("projection_fault");
    return executor.query(sql, values);
  });
  const port = api.createPostgresRenewalSettlementPort(executor, d.codec, work => transaction(db => work({ query: async (sql, values) => {
    if (sql.includes("INSERT INTO public.commerce_order_adjustments")) { await fail(sql, values); }
    return db.query(sql, values);
  } })));
  await expect(port.prepareRenewal(input)).rejects.toThrow("projection_fault"); expect(fail).toHaveBeenCalledTimes(1);
  expect(await allPublicRows(admin)).toEqual(before);
  const prepared = await d.input.settlement.prepareRenewal(input), projected = await allPublicRows(admin);
  expect(await d.input.settlement.prepareRenewal(input)).toMatchObject({ replayed: true, orderId: prepared.orderId });
  expect(await allPublicRows(admin)).toEqual(projected);
}, 30_000);

it.each(["2026-01-01T00:00:00.123456Z", "2026-01-01T00:00:00.000Z"])("normalizes registration instant %s and server basis; conflicts still refuse", async authorizedAt => {
  const f = await active(terms(), { authorizedAt });
  const writer = api.createPostgresPurchaseRenewalWriter(executor);
  for (const zone of ["Etc/GMT-9", "Etc/GMT+5"]) await transaction(async db => {
    await db.query("SELECT set_config('TimeZone',$1,true)", [zone]);
    const local = api.createPostgresPurchaseRenewalWriter(db);
    expect(await local.register(f.orderId.toUpperCase(), { ...f.input,
      unattendedChargeAuthorizedAt: authorizedAt.includes("123456") ? "2026-01-01T09:00:00.123456+09:00" : "2026-01-01T09:00:00.000000+09:00" })).toMatchObject({ replayed: true });
  });
  await expect(writer.register(f.orderId, { ...f.input, unattendedChargeAuthorizedAt: authorizedAt.includes("123456") ? "2026-01-01T00:00:00.123457Z" : "2026-01-01T00:00:00.000001Z" })).rejects.toMatchObject({ code: "23505" });
  await expect(writer.register(f.orderId, { ...f.input, shippingAmountMinor: 1 })).rejects.toMatchObject({ code: "23505" });
  const retained = (await rpc<{ renewalTerms: RenewalRetainedTerms }>("subscription_renewal_purchase_terms", [f.subscriptionId])).renewalTerms;
  expect(retained.starterPack!.basisTemplateVersion).toBe(1);
  await expect(rpc("subscription_register_renewal_purchase", [f.orderId, JSON.stringify({ ...facts, shippingAmountMinor: 1 })])).rejects.toMatchObject({ code: "22023" });
  for (const role of ["anon", "authenticated"]) await transaction(async db => {
    // This login can SET authenticated; anon membership is not implied.
    const grants = (await db.query("SELECT has_function_privilege($1,'public.subscription_renewal_purchase_terms(uuid)','EXECUTE') AS reader,has_function_privilege($1,'public.subscription_register_renewal_purchase_with_shipping(uuid,jsonb)','EXECUTE') AS writer", [role])).rows[0];
    expect(grants).toEqual({ reader: false, writer: false });
  });
  await expect(executor.query("SELECT purchase_facts FROM public.subscription_renewal_attachments")).rejects.toMatchObject({ code: "42501" });
}, 30_000);

// The shared lock and conflict completion lets the restricted runtime count destinations by client.
// A quote preview exists only for its client's subscription; absorption retains previews unread and refuses through the subscription.
it.each([null, "identity_privacy_erasures", "subscription_command_receipts", "subscription_stock_wait_cases", "subscription_quote_previews"] as const)("absorbs through the restricted runtime at the destinations count (block=%s)", async table => {
  // Scratch fixture: pending the G3 policy row. Never part of this forward.
  // The null case still exercises the full, unmodified chain.
  const pending = table ? await admin.query(`INSERT INTO public.client_absorption_policy(table_name,disposition,note)
    VALUES('commerce_destinations','block','Pending destination policy integration') ON CONFLICT DO NOTHING RETURNING table_name`) : null;
  try {
    const operator = randomUUID(), customer = randomUUID(), lead = randomUUID(), email = `${lead}@example.invalid`;
    // Owned fixture prerequisites; the operation itself executes as service_role.
    await admin.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [operator, `${operator}@example.invalid`]);
    await admin.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)", [operator, at]);
    await admin.query("INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)", [operator]);
    await admin.query("INSERT INTO public.clients(id,email,lifecycle_stage) VALUES($1,$2,'customer'),($3,$4,'lead')", [customer, `${customer}@example.invalid`, lead, email]);
    if (table === "identity_privacy_erasures") await admin.query(`INSERT INTO public.identity_privacy_erasures
      (erasure_id,idempotency_key,client_id,actor_principal_id,contract_version,contributor_versions,dispositions,retained_obligations,completed_at)
      VALUES($1,$2,$3,$4,'identity.erasure.v1','{}','{}','[]',$5)`, [randomUUID(), randomUUID(), lead, operator, at]);
    if (table === "subscription_command_receipts" || table === "subscription_stock_wait_cases" || table === "subscription_quote_previews") {
      const subscription = randomUUID();
      await admin.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)", [subscription, lead, at]);
      if (table === "subscription_command_receipts") await admin.query(`INSERT INTO public.subscription_command_receipts
        (actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,result,status)
        VALUES($1,$2,$3,$4,$5,'{}','{}','refused')`, [operator, randomUUID(), subscription, lead, "a".repeat(64)]);
      else if (table === "subscription_quote_previews") await admin.query(`INSERT INTO public.subscription_quote_previews
        (subscription_id,client_id,actor_id,action,quote_hash,template_version,expires_at,request_payload,quote_snapshot,totals)
        VALUES($1,$2,$3,'update_package_template',$4,1,$5,'{}','{}','{}')`, [subscription, lead, operator, "a".repeat(64), days(at, 1)]);
      else {
        const operation = randomUUID(), identity = `subscription:${subscription}:cycle:${at}`;
        await admin.query(`INSERT INTO public.subscription_renewal_operations
          (id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at)
          VALUES($1,$2,$3,1,$4,$5,'{}','reserved',$6,'fixture',$3,$7)`, [operation, subscription, at, identity, "a".repeat(64), randomUUID(), days(at, 1)]);
        await admin.query(`INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,
          cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits)
          VALUES($1,$2,$3,$4,1,'waiting','{}','{}',$5,$6,'[]')`, [subscription, lead, operation, at, "a".repeat(64), identity]);
      }
    }
    const key = `absorption:${randomUUID()}`;
    const before = await allPublicRows(admin);
    expect((await runtime.query("SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
      .toEqual([{ current_user: "service_role", session_user: "g7_runtime", rolsuper: false, rolbypassrls: false }]);
    expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user")).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const absorb = () => rpc<{ outcome: string; blockingTables?: string[] }>("customer_support_absorb_lead_v1", [operator, customer, lead, email, key, at]);
    const result = await absorb();
    if (table) {
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: "refused", action: "absorb_lead", leadId: lead, refusalCode: "lead_has_commercial_footprint" });
      expect(result.blockingTables).toContain(table === "subscription_quote_previews" ? "subscriptions" : table);
      expect(result.blockingTables).not.toContain("subscription_quote_previews");
      expect(result.blockingTables).not.toContain("commerce_destinations");
      const after = await allPublicRows(admin) as Record<string, unknown[]>, prior = before as Record<string, unknown[]>;
      for (const name of ["customer_support_subscription_commands", "customer_support_subscription_audit_events"]) {
        expect(after[name].length - prior[name].length, name).toBe(1);
        delete after[name]; delete prior[name];
      }
      expect(after).toEqual(prior);
    } else expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", leadId: lead, customerId: customer });
    const replayBefore = await allPublicRows(admin);
    expect(await absorb()).toEqual(table ? result : { ...result, outcome: "replayed" });
    expect(await allPublicRows(admin)).toEqual(replayBefore);
  } finally {
    if (pending?.rows.length) await admin.query("DELETE FROM public.client_absorption_policy WHERE table_name='commerce_destinations'");
  }
}, 30_000);

async function addonPurchase(addonQuantity: number) {
  const addon = "44444444-4444-4444-8444-444444444444";
  // Catalogue/price input is installation seed data; all journey facts below use writers.
  await admin.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'synthetic-addon','Addon') ON CONFLICT DO NOTHING", [addon]);
  await admin.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,is_addon,sellable_in_subscription) VALUES($1,$1,'SYNTHETIC-ADDON','Addon',true,true) ON CONFLICT DO NOTHING", [addon]);
  await admin.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES('33333333-3333-4333-8333-333333333333',$1,'any',40,'2026-01-01') ON CONFLICT DO NOTHING", [addon]);
  await fulfillment.createPostgresFulfillmentStockSyncPort(executor, { sourceKey: facts.stockSourceKey, readLocalInventoryStock: async () => [] })
    .recordProviderStockCurrent({ requestKey: `addon-stock:${randomUUID()}`, snapshot: { providerRef: "synthetic-addon", collectedAt: at,
      sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot", skuRef: "SYNTHETIC-ADDON", totalQuantity: 1000,
      forSaleQuantity: 1000, reservedOrUnavailableQuantity: 0, syncRunId: "addon-fixture" }, inventoryClass: "sellable", lastSyncedAt: at, staleAfter: "2027-01-01T00:00:00Z" });
  const accounts = identity.createPostgresAccountLinkStore({ connectionString: runtimeUrl });
  let clientId: string;
  try { clientId = (await accounts.createAccount({ email: `${randomUUID()}@example.invalid`, principalId: randomUUID(), acquisitionSource: "fixture", lifecycleStage: "customer" })).id; }
  finally { await accounts.close(); }
  const key = randomUUID(), money = (amountMinor: number) => ({ amountMinor, currency: "XXX" }), subtotal = 200 + addonQuantity * 40;
  const quoteLines = [{ sku: "G7-REFILL", productSlug: "g7-refill", quantity: 2, amount: 100 },
    { sku: "SYNTHETIC-ADDON", productSlug: "synthetic-addon", quantity: addonQuantity, amount: 40 }].map(line => ({
    sku: line.sku, productSlug: line.productSlug, quantity: line.quantity, unitPriceGross: money(line.amount), lineSubtotalGross: money(line.quantity * line.amount),
    tax: { included: true as const, country: "ZZ", category: "standard" as const, vatRateBps: 0, legalBasis: "Synthetic test tax",
      netAmount: money(line.quantity * line.amount), vatAmount: money(0), grossAmount: money(line.quantity * line.amount) } }));
  const made = await checkout.createPostgresNativeCheckoutPersistence(executor).createOrderDraft({ idempotencyKey: key, quoteSnapshot: {
    contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true, lines: quoteLines, discounts: [],
      context: { mode: "subscription", cadenceDays: 28, promoCodes: [] }, subtotalGross: money(subtotal), discountTotalGross: money(0),
      shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(subtotal), netTotal: money(subtotal), taxTotal: money(0) } } }, { clientId });
  const orderId = String(made.orderDraft.orderId).replace(/^order_/, "");
  const intent = await rpc<{ settlement: { id: string } }>("commerce_open_settlement_intent", [`open:${key}`, orderId, "sandbox", subtotal, "XXX", "{}", at]);
  expect(await captureSandboxPurchase(payments.createPostgresSandboxPaymentSimulator(executor, {
    dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" }),
  { settlementIntentId: intent.settlement.id, key, at })).toMatchObject({ status: 200 });
  await destinations.createPostgresDestinationPort(executor).registerOrder({ idempotencyKey: `destination:${key}`, orderId,
    address: { recipientName: "Synthetic recipient", line1: "Synthetic street 1", city: "Fixture", postalCode: "00000", country: "ZZ" }, now: at });
  await rpc("subscription_declare_provisional_activation", [`declare:${key}`, orderId, 28, at]);
  const settled = (await runtime.query("SELECT external_ref,id FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0];
  return { orderId, clientId, capturedReference: settled.external_ref ?? settled.id, idempotencyKey: `activate:${key}` };
}
async function nextDelivery(f: Awaited<ReturnType<typeof active>>) {
  const initial = await driver(f.subscriptionId);
  expect(await api.runOneAutomaticSubscriptionRenewal(initial.input, initial.due, now)).toMatchObject({ status: "succeeded" });
  const when = String((await runtime.query("SELECT to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0].at);
  return { ...(await driver(f.subscriptionId, when)), when };
}

it("graduates once under concurrent builders and preserves an acquisition addon", async () => {
  const retained = terms(); retained.starterPack!.delivery2 = { discountBps: 2500, discountMinor: 61, basisSubtotalMinor: 240 };
  retained.linePricing = [...retained.linePricing!, { sku: "SYNTHETIC-ADDON", quantity: 1, unitAmountMinor: 40, isAddon: true,
    quoteLine: { unitPriceGross: { amountMinor: 40 }, lineSubtotalGross: { amountMinor: 40 } } }];
  const f = await active(retained, { addon: true }), d = await nextDelivery(f);
  const snapshots = await Promise.all([d.input.store.buildCycleSnapshots(d.due), d.input.store.buildCycleSnapshots(d.due)]);
  expect(snapshots[0]).toEqual(snapshots[1]);
  expect(snapshots[0].templateSnapshot.lines).toEqual([{ lineOrdinal: 1, sku: "G7-REFILL", quantity: 3, unitAmountMinor: 100 },
    { lineOrdinal: 2, sku: "SYNTHETIC-ADDON", quantity: 1, unitAmountMinor: 40 }]);
  expect(snapshots[0].pricingSnapshot).toMatchObject({ totalAmountMinor: 340, discountAmountMinor: 0 });
  expect((await runtime.query("SELECT k.sku,l.quantity,l.is_addon FROM public.subscription_lines l JOIN public.catalog_skus k ON k.id=l.variant_id WHERE subscription_id=$1 ORDER BY is_addon", [f.subscriptionId])).rows)
    .toEqual([{ sku: "G7-REFILL", quantity: 3, is_addon: false }, { sku: "SYNTHETIC-ADDON", quantity: 1, is_addon: true }]);
  expect((await runtime.query("SELECT payload FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.starter_graduated'", [f.subscriptionId])).rows).toHaveLength(1);
}, 30_000);

it.each([28, 21])("retains a customer-edited mix and normalizes only the acquisition cadence (%i)", async cadence => {
  const f = await active(), d = await nextDelivery(f);
  // A customer edit is a precondition here; its unchanged command rail has separate characterization.
  await executor.query("UPDATE public.subscriptions SET template_version=2,cadence_days=$2 WHERE id=$1", [f.subscriptionId, cadence]);
  const snapshot = await d.input.store.buildCycleSnapshots(d.due);
  expect(snapshot.templateSnapshot).toMatchObject({ version: cadence === 28 ? 3 : 2, cadenceDays: cadence === 28 ? 30 : 21,
    lines: [{ quantity: 2, unitAmountMinor: 100 }] });
  expect((await runtime.query("SELECT event_type FROM public.subscription_events WHERE subscription_id=$1 AND event_type LIKE 'subscription.starter_%'", [f.subscriptionId])).rows)
    .toEqual(cadence === 28 ? [{ event_type: "subscription.starter_cadence_normalized" }] : []);
  expect((await runtime.query("SELECT next_cycle_at=$2::timestamptz AS same FROM public.subscriptions WHERE id=$1", [f.subscriptionId, d.when])).rows[0].same).toBe(true);
}, 30_000);

it("rolls graduation back after a line-write fault and retries without losing its agreement", async () => {
  const f = await active(), d = await nextDelivery(f), before = await allPublicRows(admin);
  const store = api.createPostgresRenewalStore(executor, d.codec, work => transaction(db => work({ query: (sql, values) => {
    if (sql.includes("INSERT INTO public.subscription_renewal_term_lines")) throw new Error("graduation_fault");
    return db.query(sql, values);
  } })));
  await expect(store.buildCycleSnapshots(d.due)).rejects.toThrow("graduation_fault");
  expect(await allPublicRows(admin)).toEqual(before);
  expect((await d.input.store.buildCycleSnapshots(d.due)).pricingSnapshot.totalAmountMinor).toBe(300);
}, 30_000);

it("refuses an unknown graduation SKU and an unresolved cycle without partial graduation", async () => {
  const retained = terms(); retained.starterPack!.graduation.lines[0].sku = "NOT-IN-CATALOG";
  const f = await active(retained), d = await nextDelivery(f), before = await allPublicRows(admin);
  await expect(d.input.store.buildCycleSnapshots(d.due)).rejects.toThrow("graduation_unknown_sku"); expect(await allPublicRows(admin)).toEqual(before);
  const other = await active(), pending = await nextDelivery(other);
  // Owner fault fixture: an unresolved payment obligation is never auto-graduated.
  await admin.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')", [other.subscriptionId, days(pending.when, -1)]);
  const unresolved = await allPublicRows(admin);
  await expect(pending.input.store.buildCycleSnapshots(pending.due)).rejects.toThrow("graduation_open_cycle"); expect(await allPublicRows(admin)).toEqual(unresolved);
}, 30_000);

it("rejects a stale prebuilt snapshot, and frozen evidence wins before damaged current terms", async () => {
  const f = await active(), d = await driver(f.subscriptionId), snapshot = await d.input.store.buildCycleSnapshots(d.due);
  await executor.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [f.subscriptionId]);
  const edited = await allPublicRows(admin);
  await expect(d.input.store.claimDue({ snapshot, workerId: "stale-proof", now })).rejects.toThrow("snapshot_stale"); expect(await allPublicRows(admin)).toEqual(edited);
  const fresh = await d.input.store.buildCycleSnapshots(d.due);
  const claimed = await d.input.store.claimDue({ snapshot: fresh, workerId: "fresh-proof", now });
  await admin.query("UPDATE public.subscription_renewal_attachments SET purchase_facts=jsonb_set(purchase_facts,'{renewalTerms}','null') WHERE subscription_id=$1", [f.subscriptionId]);
  const damaged = await allPublicRows(admin);
  expect(await d.input.store.buildCycleSnapshots(d.due)).toEqual(claimed.cycleSnapshot);
  expect(await allPublicRows(admin)).toEqual(damaged);
}, 30_000);

it("charges retained fixed shipping and enforces the reader's actual browser execution refusal", async () => {
  const f = await active({ version: "native.renewal-terms.v1" }, { shipping: 17 }), d = await driver(f.subscriptionId);
  expect(await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now)).toMatchObject({ status: "succeeded" });
  expect(d.execute.mock.calls[0][0].amountMinor).toBe(217);
  for (const role of ["anon", "authenticated"]) {
    const db = await admin.connect();
    try {
      await db.query("BEGIN"); await db.query(`SET LOCAL ROLE ${role}`);
      expect((await db.query("SELECT current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS elevated")).rows).toEqual([{ current_user: role, elevated: false }]);
      await expect(db.query("SELECT public.subscription_renewal_purchase_terms($1::uuid)", [f.subscriptionId])).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query("ROLLBACK"); db.release(); }
  }
}, 30_000);

it("matches the independent invoice allocator at a fractional tie with paid delivery", async () => {
  const retained = terms(); retained.shippingTerms = { ...retained.shippingTerms!, freeThresholdMinor: 350 };
  retained.starterPack!.delivery2 = { discountBps: 2500, discountMinor: 51, basisSubtotalMinor: 400 };
  retained.linePricing = [...retained.linePricing!, { sku: "SYNTHETIC-ADDON", quantity: 5, unitAmountMinor: 40, isAddon: true,
    quoteLine: { unitPriceGross: { amountMinor: 40 }, lineSubtotalGross: { amountMinor: 200 } } }];
  const f = await active(retained, { addon: 5 }), d = await driver(f.subscriptionId);
  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now);
  expect(result.status).toBe("succeeded"); expect(d.execute.mock.calls[0][0].amountMinor).toBe(386);
  const op = (await d.input.store.readRenewal(result.identityKey))!;
  const items = (await runtime.query(`SELECT sku.sku,sum(item.line_amount_minor)::integer AS gross,
    sum(item.quantity)::integer AS quantity,bool_and(item.line_amount_minor=item.unit_amount_minor*item.quantity) AS exact
    FROM public.commerce_order_items item JOIN public.catalog_skus sku ON sku.id=item.sku_id
    WHERE item.order_id=$1 GROUP BY sku.sku ORDER BY sku.sku`, [op.orderId])).rows;
  expect(items).toEqual([{ sku: "G7-REFILL", gross: 175, quantity: 2, exact: true }, { sku: "SYNTHETIC-ADDON", gross: 174, quantity: 5, exact: true }]);
  const installed = createRequire(resolve(".context/scratch/g7/installed/package.json"));
  const invoicing: typeof import("@openlup/platform/invoicing") = await import(pathToFileURL(installed.resolve("@openlup/platform/invoicing")).href);
  const invoice = invoicing.mapInvoiceClaimToProviderSnapshot({ orderRef: String(op.orderId), issueDate: "2026-01-01", sellDate: "2026-01-01",
    currency: "XXX", seller: {}, buyerSnapshot: { name: "Synthetic buyer" }, documentKind: "receipt", governmentClearanceRequired: false,
    payment: {}, linesSnapshot: [{ name: "Refill", quantity: 2, unitGrossMinor: 100, totalGrossMinor: 200, vatRate: "0" },
      { name: "Addon", quantity: 5, unitGrossMinor: 40, totalGrossMinor: 200, vatRate: "0" }], totalGrossMinor: 386, totalNetMinor: 386,
    orderMoney: { subtotalCents: 400, discountCents: 51, totalCents: 386 } },
  { defaultBuyerLabel: "Buyer", defaultLineLabel: "Product", deliveryLabel: "Delivery", defaultTaxRate: "0" });
  expect(invoice.lines.map(line => line.totalGrossMinor)).toEqual([175, 174, 37]);
  expect(invoice.chargedTotalGrossMinor).toBe(386);
  expect(invoice.lines.reduce((sum, line) => sum + line.totalGrossMinor, 0)).toBe(386);
}, 30_000);

it("keeps the graduated cycle monotonic after late payment and parcel arrival", async () => {
  const f = await active(), next = await nextDelivery(f), late = days(next.when, 26 / 24);
  const d = await driver(f.subscriptionId, late);
  const paid = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, late);
  expect(paid.status).toBe("succeeded");
  const op = (await d.input.store.readRenewal(paid.identityKey))!;
  expect((await runtime.query("SELECT cadence_days,status,next_cycle_at=$2::timestamptz AS expected FROM public.subscriptions WHERE id=$1", [f.subscriptionId, days(next.when, 31)])).rows[0])
    .toEqual({ cadence_days: 30, status: "active", expected: true });
  await admin.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
  const shipment = await fulfillment.createPostgresFulfillmentShipmentSpinePort(executor, { portKey: "g7-parcels" })
    .createShipment({ idempotencyKey: `graduated-parcel:${op.orderId}`, orderId: String(op.orderId), requestedAt: at });
  // Admission establishes the outstanding parcel case. Recording an arrival
  // without that case only supplies evidence and cannot claim alignment.
  const following = await driver(f.subscriptionId, days(next.when, 31));
  expect(await api.withNativeDeliveryAlignmentRenewalAdmission(following.input.store, executor)
    .admitDeliveryAlignment({ ...following.due, occurredAt: days(next.when, 31) }))
    .toMatchObject({ allowed: false, state: "protected" });
  const arrival = fulfillment.createPostgresDeliveryAlignmentPort(executor);
  const input = { requestKey: `graduated-arrival:${shipment.shipmentId}`, parcelRef: shipment.shipmentId,
    deliveredAt: days(next.when, 4), evidenceRef: `evidence:${shipment.shipmentId}` as const };
  const expected = days(next.when, 34);
  expect(await arrival.recordArrival(input)).toMatchObject({ disposition: "aligned", nextCycleAt: expected });
  const before = await allPublicRows(admin);
  expect(await arrival.recordArrival(input)).toMatchObject({ replayed: true, nextCycleAt: expected });
  expect(await allPublicRows(admin)).toEqual(before);
  expect(await arrival.recordArrival({ ...input, requestKey: `${input.requestKey}:older`, deliveredAt: days(next.when, 3) }))
    .toMatchObject({ nextCycleAt: expected });
  expect((await runtime.query("SELECT status,next_cycle_at=$2::timestamptz AS expected FROM public.subscriptions WHERE id=$1", [f.subscriptionId, expected])).rows[0])
    .toEqual({ status: "active", expected: true });
  // No replacement confirmation is used to manufacture an arrival.
}, 30_000);

// Solo: 6.21 s without coverage; 30 s retains more than three times that bound.
it("transfers paid shipping, retained terms, graduation agreements and frozen replay", async () => {
  await admin.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  const f = await active(), d = await nextDelivery(f);
  const result = await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, d.when);
  expect(result.status).toBe("succeeded");
  const original = (await d.input.store.readRenewal(result.identityKey))!;
  const packet = await captureStore(admin, `retained-renewal:${f.subscriptionId}`);
  await withRestoredStore(packet, async target => {
    const db = { query: (sql: string, values?: unknown[]) => target.runtime.query(sql, values) };
    const codec = api.createNativeRenewalCodec(), store = api.createPostgresRenewalStore(db, codec, target.transaction);
    expect(await store.readRenewal(original.identityKey)).toEqual(original);
    const agreement = await target.runtime.query("SELECT payload FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.starter_graduated'", [f.subscriptionId]);
    expect(agreement.rows).toHaveLength(1); expect(agreement.rows[0].payload.linePricing).toHaveLength(1);
    expect((await target.runtime.query("SELECT sum(a.amount_minor)::integer AS amount FROM public.commerce_order_adjustments a JOIN public.commerce_orders o ON o.id=a.order_id JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id WHERE c.subscription_id=$1", [f.subscriptionId])).rows[0].amount).toBe(37);
    expect((await target.runtime.query("SELECT public.subscription_renewal_purchase_terms($1::uuid) AS terms", [f.subscriptionId])).rows[0].terms.renewalTerms)
      .toMatchObject({ version: "native.renewal-terms.v1", starterPack: { basisTemplateVersion: 1 } });
    const forbidden = vi.fn(async (): Promise<never> => { throw new Error("restored_terminal_replay_must_not_dispatch"); });
    const before = await allPublicRows(target.owner);
    expect(await api.runOneAutomaticSubscriptionRenewal({ ...d.input, store,
      settlement: api.createPostgresRenewalSettlementPort(db, codec, target.transaction),
      inventory: { reserve: forbidden, expireReservations: forbidden }, paymentRails: { resolve: () => { throw new Error("restored_terminal_replay_must_not_resolve"); } } },
    d.due, days(d.when, 1))).toMatchObject({ status: "terminal_replay", operationId: original.operationId });
    expect(forbidden).not.toHaveBeenCalled(); expect(await allPublicRows(target.owner)).toEqual(before);
  });
}, 30_000);

/** Accepted server quote fixture, applied through the restricted C SQL boundary. */
async function classicEdit(f: Awaited<ReturnType<typeof active>>, input: {
  quantity: number; unit: number; planDays: number; requestedAt: string; list?: number;
}) {
  const current = (await runtime.query("SELECT template_version,cadence_days FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0];
  const variant = String((await runtime.query("SELECT variant_id FROM public.subscription_lines WHERE subscription_id=$1 AND NOT is_addon ORDER BY sort_order LIMIT 1", [f.subscriptionId])).rows[0].variant_id);
  const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  const quoteLine = { sku: "G7-REFILL", quantity: input.quantity, unitPriceGross: money(input.unit), lineSubtotalGross: money(input.quantity * input.unit),
    ...(input.list === undefined ? {} : { pricingComponents: [{ componentType: "base_unit", amountMinor: input.list }] }) };
  const price = money(input.quantity * input.unit), quote = { lines: [quoteLine], totalGross: price, subtotalGross: price, discountTotalGross: money(0) };
  const hash = api.hashPackageEditQuote(quote), actor = randomUUID(), key = randomUUID();
  const base = [{ variantId: variant, qty: input.quantity }], baseLines = [{ ...base[0], quoteLine }];
  const request = { planDays: input.planDays, base, addons: [], expectedTemplateVersion: current.template_version, acceptedQuoteHash: hash };
  const payload = { request, planDays: input.planDays, nominalPlanDays: input.planDays, base, addons: [], baseLines, addonLines: [],
    currentRecurringPrice: money(200), newRecurringPrice: price, delta: money(price.amountMinor - 200),
    expectedTemplateVersion: current.template_version, acceptedQuoteHash: hash };
  await admin.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','2') ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text");
  await rpc("subscription_quote_preview_record", [actor, f.clientId, f.subscriptionId, "update_package_template", hash, current.template_version,
    new Date(Date.parse(input.requestedAt) + 15 * 60_000).toISOString(),
    { planDays: input.planDays, nominalPlanDays: input.planDays, base, addons: [], compositionConstraint: { kind: "plan_days", value: input.planDays } },
    { baseLines, addonLines: [] }, { currentRecurringPrice: payload.currentRecurringPrice, newRecurringPrice: price, delta: payload.delta }, input.requestedAt]);
  const result = await rpc("subscription_package_edit_apply", [actor, f.clientId, key, f.subscriptionId, payload, input.requestedAt]);
  expect(result).toMatchObject({ status: "applied", templateVersion: Number(current.template_version) + 1 });
  return { result, payload, actor, quoteLine };
}

it.each([
  { branch: "list anchor", quantity: 14, unit: 997, list: 15442, planDays: 28, discount: 3920, total: 10038 },
  { branch: "no anchor", quantity: 14, unit: 997, list: undefined, planDays: 28, discount: 4885, total: 9073 },
  { branch: "frozen basis", quantity: 2, unit: 100, list: 250, planDays: 21, discount: 51, total: 149 },
])("bills the accepted edited delivery-two agreement to the minor unit ($branch)", async scenario => {
  const retained: RenewalRetainedTerms = { version: "native.renewal-terms.v1", minimumPayableMinor: 100, normalCadenceDays: [14, 21, 28],
    linePricing: terms().linePricing, starterPack: { schemaVersion: "1", starterIntervalDays: 28, basisTemplateVersion: 1,
      delivery2: { discountBps: 3500, discountMinor: 51, basisSubtotalMinor: 200 },
      graduation: { cadenceDays: 28, lines: [{ sku: "G7-REFILL", qty: 28, sortOrder: 0, isAddon: false,
        quoteLine: { unitPriceGross: { amountMinor: 997, currency: "XXX" }, lineSubtotalGross: { amountMinor: 27916, currency: "XXX" } } }] } } };
  const f = await active(retained), edited = await classicEdit(f, { ...scenario, requestedAt: days(at, 1) });
  const d = await driver(f.subscriptionId), snapshot = await d.input.store.buildCycleSnapshots(d.due);
  expect(snapshot.pricingSnapshot).toMatchObject({ productSubtotalAmountMinor: scenario.quantity * scenario.unit,
    discountAmountMinor: scenario.discount, totalAmountMinor: scenario.total, shippingAmountMinor: 0,
    linePricing: [{ sku: "G7-REFILL", quantity: scenario.quantity, unitAmountMinor: scenario.unit, isAddon: false, quoteLine: edited.quoteLine }] });
  expect((await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now)).status).toBe("succeeded");
  expect(d.execute).toHaveBeenCalledOnce(); expect(d.execute.mock.calls[0][0].amountMinor).toBe(scenario.total);
  const operation = (await d.input.store.readRenewal(d.codec.identity(snapshot)))!;
  expect((await runtime.query("SELECT total_amount_minor FROM public.commerce_orders WHERE id=$1", [operation.orderId])).rows[0].total_amount_minor).toBe(String(scenario.total));
  // A later accepted template cannot rewrite the operation that already prepared/billed these lines.
  await classicEdit(f, { quantity: 15, unit: 101, planDays: 28, requestedAt: days(now, 1), list: 1875 });
  expect(await d.input.store.buildCycleSnapshots(d.due)).toEqual(operation.cycleSnapshot);
}, 30_000);

it("keeps accepted classic pricing after a newer unpriced generic package command", async () => {
  const f = await active(), edited = await classicEdit(f, { quantity: 14, unit: 100, planDays: 28,
    requestedAt: days(at, 1), list: 1800 });
  const linePricing = [{ sku: "G7-REFILL", quantity: 14, unitAmountMinor: 100, isAddon: false, quoteLine: edited.quoteLine }];
  expect((await runtime.query("SELECT payload->'linePricing' AS pricing FROM public.subscription_events WHERE id=$1",
    [edited.result.eventId])).rows).toEqual([{ pricing: linePricing }]);
  const anchor = (await runtime.query("SELECT next_cycle_at::text AS anchor FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0].anchor;
  // The generic command reprices the same lines from the fixture catalogue,
  // changes only cadence, and emits its real event without top-level linePricing.
  const commands = api.createPostgresSubscriptionCommandStore({ withTransaction: transaction });
  const command = { actorId: edited.actor, clientId: f.clientId, subscriptionId: f.subscriptionId, idempotencyKey: randomUUID(),
    action: "update_package_template", now: days(at, 2), payload: {
      coreLines: edited.payload.base, addonLines: [], planDays: 45, expectedTemplateVersion: 2,
      compositionConstraint: { kind: "plan_days", value: 45 },
    } };
  const preview = await commands.preview(command);
  expect(preview).toMatchObject({ status: "previewed", newTotalMinor: 1400 });
  const payload = { ...command.payload, acceptedQuoteHash: String(preview.quoteHash) };
  const applied = await commands.apply({ ...command, payload });
  expect(applied).toMatchObject({ status: "applied", templateVersion: 3 });
  expect((await runtime.query(`SELECT id,event_type,payload FROM public.subscription_events WHERE subscription_id=$1
    AND event_type IN ('subscription.starter_graduated','subscription.customer_self_service.update_package_template')
    ORDER BY occurred_at DESC,id DESC LIMIT 1`, [f.subscriptionId])).rows).toEqual([{
    id: applied.eventId, event_type: "subscription.customer_self_service.update_package_template",
    payload: { action: command.action, payload,
      priceAgreementPolicy: { kind: "lock_until_edit", proration: "none", cycleEffect: "future_unlocked_cycles_only" } },
  }]);
  expect((await runtime.query("SELECT status,next_cycle_at=$2::timestamptz AS same,cadence_days FROM public.subscriptions WHERE id=$1",
    [f.subscriptionId, anchor])).rows).toEqual([{ status: "active", same: true, cadence_days: 45 }]);
  const d = await driver(f.subscriptionId), snapshot = await d.input.store.buildCycleSnapshots(d.due);
  expect(snapshot.pricingSnapshot).toMatchObject({ productSubtotalAmountMinor: 1400, discountAmountMinor: 50,
    totalAmountMinor: 1350, shippingAmountMinor: 0, linePricing });
  expect((await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now)).status).toBe("succeeded");
  expect(d.execute).toHaveBeenCalledOnce(); expect(d.execute.mock.calls[0][0].amountMinor).toBe(1350);
  const operation = (await d.input.store.readRenewal(d.codec.identity(snapshot)))!;
  expect(operation.cycleSnapshot.pricingSnapshot).toEqual(snapshot.pricingSnapshot);
  expect((await runtime.query("SELECT total_amount_minor FROM public.commerce_orders WHERE id=$1", [operation.orderId])).rows)
    .toEqual([{ total_amount_minor: "1350" }]);
}, 30_000);

it.each([28, 21])("a real classic edit cancels full graduation and only normalizes a retained starter cadence (%i)", async cadence => {
  const f = await active(), d = await nextDelivery(f);
  await classicEdit(f, { quantity: 6, unit: 137, planDays: cadence, requestedAt: days(now, 1), list: 1038 });
  const snapshot = await d.input.store.buildCycleSnapshots(d.due);
  expect(snapshot.templateSnapshot).toMatchObject({ version: cadence === 28 ? 3 : 2, cadenceDays: cadence === 28 ? 30 : 21,
    lines: [{ quantity: 6, unitAmountMinor: 137 }] });
  expect((await runtime.query("SELECT event_type FROM public.subscription_events WHERE subscription_id=$1 AND event_type LIKE 'subscription.starter_%'", [f.subscriptionId])).rows)
    .toEqual(cadence === 28 ? [{ event_type: "subscription.starter_cadence_normalized" }] : []);
}, 30_000);

it("admits an edit before cutoff, refuses a not-due claim and late edit, and freezes only the edited terms", async () => {
  const f = await active(), d = await driver(f.subscriptionId), due = d.due.scheduledAt;
  const cutoff = new Date(Date.parse(due) - 72 * 3_600_000 - 1).toISOString();
  const edited = await classicEdit(f, { quantity: 6, unit: 137, planDays: 28, requestedAt: cutoff, list: 1038 });
  const snapshot = await d.input.store.buildCycleSnapshots(d.due);
  expect(snapshot.templateSnapshot).toMatchObject({ version: 2, lines: [{ quantity: 6, unitAmountMinor: 137 }] });
  const beforeClaim = await allPublicRows(admin);
  await expect(d.input.store.claimDue({ snapshot, workerId: "not-due-editor-proof", now: new Date(Date.parse(due) - 1).toISOString() }))
    .rejects.toThrow("subscription_renewal_claim_not_due");
  expect(await allPublicRows(admin)).toEqual(beforeClaim);
  const claimed = await d.input.store.claimDue({ snapshot, workerId: "due-editor-proof", now: due });
  const reservation = await d.input.inventory.reserve({ operationId: claimed.operationId, claimToken: claimed.claimToken, now: due });
  expect(reservation).toMatchObject({ reserved: true });
  await d.input.settlement.prepareRenewal({ operationId: claimed.operationId, claimToken: claimed.claimToken, now: due });
  const prepared = await d.input.store.readRenewal(d.codec.identity(snapshot)), beforeLate = await allPublicRows(admin);
  await expect(rpc("subscription_package_edit_apply", [edited.actor, f.clientId, randomUUID(), f.subscriptionId,
    { ...edited.payload, expectedTemplateVersion: 2 }, due])).rejects.toThrow("subscription_edit_window_closed");
  expect(await allPublicRows(admin)).toEqual(beforeLate);
  expect(await d.input.store.readRenewal(d.codec.identity(snapshot))).toEqual(prepared);
  expect(await d.input.store.buildCycleSnapshots(d.due)).toEqual(prepared!.cycleSnapshot);
}, 30_000);
