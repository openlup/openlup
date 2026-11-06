import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import { afterAll, expect, it } from "vitest";
import { createPostgresCheckoutRecoveryTokenPort } from "@openlup/platform/commerce/server";
import { createPostgresDataGateway, createPostgresRoleFreeTransactionLane, type PgGatewayClient } from "@openlup/platform/data";
import { createCapturedCustomerChallengeDelivery, createCustomerIdentityVerifier, createPostgresContactClientRegistrar,
  createPostgresCustomerMePort, resolveCustomerSessionBinding } from "@openlup/platform/identity";
import { composePurchaseCapabilities } from "../../examples/neutral-store/host/purchase-composition.ts";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";
import { ACQUISITION_TERMS_CAPABILITY } from "@openlup/platform/pricing";
import { buildDemoSeed } from "../../examples/neutral-store/owned/demo-seed.ts";
import { quoteConfigurations } from "../../examples/neutral-store/owned/quote.config.ts";
import { isRecord } from "../../examples/neutral-store/shared/offer.ts";
import { seedQuoteAuthority } from "../../examples/neutral-store/installation/quote-seed.ts";
import { demoRenewalConfig } from "../../examples/neutral-store/owned/renewal.config.ts";
import type { ActionContext } from "../../examples/neutral-store/host/bindings.ts";
import type { StoreConfig } from "../../examples/neutral-store/shared/config.ts";
import { assertConfig } from "../../examples/neutral-store/shared/config.ts";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { assertJourneyWithoutIntake, captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
afterAll(() => resources.close(), postgresTeardownTimeoutMs);
const words = { en: "Synthetic collection", pl: "Synthetic collection" };
const config: StoreConfig = {
  renewal: demoRenewalConfig("journey"),
  subscriptionEditing: structuredClone(configurations.coffee!.subscriptionEditing),
  quote: { ...quoteConfigurations.coffee, acquisition: { ...quoteConfigurations.coffee.acquisition, enabled: true, minimumProductPayableMinor: 274 } },
  id: "journey", brand: { name: "Synthetic", strapline: words, description: words },
  theme: { ink: "#111111", paper: "#ffffff", accent: "#222222", accentInk: "#ffffff", border: "#333333" },
  copy: { heroTitle: words, heroBody: words, offerTitle: words, offerBody: words, shippingNote: words },
  media: { hero: "/media/synthetic.svg", heroAlt: words },
  market: { country: "ZZ", currency: "XXX", timezone: "UTC", locales: ["en", "pl"] },
  offer: { layout: "cards", minUnits: 1, maxUnits: 10, shippingMinor: 0, freeShippingFromMinor: 0,
    subscriptionDiscountBps: 0, subscriptionRoundingQuantumMinor: 1, renewalShippingMinor: 0,
    cadenceDays: [28], defaultCadenceDays: 28, products: [{ sku: "JOURNEY-GUEST", slug: "item", title: "Synthetic item",
      name: words, description: words, details: words, media: "/media/synthetic.svg", mediaAlt: words, contents: "1",
      physical: { netWeightG: 1, unitGtin: "0000000000017", issuer: "synthetic" },
      unitPrice: { amountMinor: 137, currency: "XXX" }, permittedPurchaseModes: ["one_time", "subscription"] }] },
  purchase: { recoveryMessage: { subject: words, body: words, expiryLabel: words, orderLabel: words },
    inputLimits: { text: 200, postalCode: 32, email: 160, name: 64, phone: 32 },
    contact: { acquisitionSource: "synthetic", lifecycleStage: "lead" }, responseFloorMs: 0,
    attemptLimits: { windowMs: 60_000, maxPerRequester: 10, maxPerEmail: 10, retentionMs: 60_000, maxEntries: 100 },
    reservationMinutes: 30, stock: { quantities: { "JOURNEY-GUEST": 100 },
      collectedAt: "2026-01-01T00:00:00.000Z", staleAfter: "2099-01-01T00:00:00.000Z", providerRef: "synthetic", syncRunId: "synthetic" },
    tax: { vatRateBps: 0, category: "standard", legalBasis: "Synthetic fixture" },
    sandbox: { dunningTemplateSlug: "synthetic-refused", recoveryTemplateSlug: "synthetic-recovered", recoveryUrlPath: "/recover" } },
  legal: { revision: "synthetic-1", returnsDays: 14, demoOnly: true },
  features: { reviews: false, acquisition: false, research: false, partners: false, risk: false, normalizedIngest: false },
};
assertConfig(config);

// Main's checkout.create and payment.simulate bind these same native ports.
it.each(["one_time", "subscription"] as const)("joins anonymous %s purchase, transfer and native customer sign-in", async mode => {
  const source = await resources.installation(`guest-${mode}-source`), target = await resources.installation(`guest-${mode}-target`);
  await assertJourneyWithoutIntake(source);
  await assertJourneyWithoutIntake(target);
  const pristine = await captureStoreJourney(target.owner, "guest-pristine");
  const seed = buildDemoSeed(config);
  const product = seed.products[0]!.id, sku = seed.skus[0]!.id, list = seed.priceLists[0]!.id;
  await source.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'demo-journey-item','Synthetic item')", [product]);
  await source.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$2,'JOURNEY-GUEST','Synthetic item',true)", [sku, product]);
  await source.owner.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic list','ZZ','XXX','2026-01-01T00:00:00Z')", [list]);
  for (const price of seed.prices) await source.owner.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,$4,'2026-01-01T00:00:00Z')",
    [list, sku, price.mode, price.unit_price_minor]);
  const installation = await source.owner.connect();
  try {
    await installation.query("BEGIN");
    await seedQuoteAuthority(config, seed, installation);
    await installation.query("COMMIT");
  } catch (error) { await installation.query("ROLLBACK"); throw error; }
  finally { installation.release(); }
  const contacts = [source, target].map(store => createPostgresContactClientRegistrar({ connectionString: store.runtimeUrl }));
  const lanes = [source, target].map(store => createPostgresRoleFreeTransactionLane({ connectionString: store.runtimeUrl }));
  const recoveryMessages: { email: string; orderRef: string; rawToken: string }[] = [];
  const keyring = { current: randomUUID() + randomUUID() };
  const actions = [source, target].map((store, index) => composePurchaseCapabilities(store.runtime, contacts[index]!, undefined, {
    tokens: createPostgresCheckoutRecoveryTokenPort(lanes[index]!),
    deliver: async message => { recoveryMessages.push(message); },
  }, { keyring }));
  const context: ActionContext = { config, actor: { customerRef: null, operatorRef: null, requesterKey: createHash("sha256").update("synthetic-peer").digest("hex") }, commandKey: `guest-${mode}` };
  const email = `guest-${mode}@example.invalid`;
  const input = { email, locale: "en", acquisitionCapability: ACQUISITION_TERMS_CAPABILITY, configuration: config.id, country: "ZZ", termsAccepted: true, termsRevision: config.legal.revision,
    firstName: "Synthetic", lastName: "Buyer", phone: "000000000", line1: "1 Synthetic Lane", city: "Synthetic", postalCode: "00000",
    cart: { schemaVersion: 1, configuration: config.id, mode, cadenceDays: mode === "subscription" ? 28 : null,
      lines: [{ sku: "JOURNEY-GUEST", quantity: 2 }] } };
  try {
    expect((await source.owner.query("SELECT count(*)::int AS count FROM public.clients")).rows).toEqual([{ count: 0 }]);
    const quote = await actions[0]!["offer.validate"]!(input, context);
    if (!quote.ok || !isRecord(quote.value)) throw new Error("Guest quote refused");
    const payload = { ...input, quoteAcceptance: quote.value.quoteAcceptance, expectedTotal: quote.value.expectedTotal };
    const made = await actions[0]!["checkout.create"]!(payload, context);
    expect(made, JSON.stringify(made)).toMatchObject({ ok: true, replayed: false, value: { status: "pending_payment", total: { amountMinor: 274, currency: "XXX" } } });
    if (!made.ok) throw new Error("Guest checkout refused");
    const order = made.value as { orderRef: string; token: string };
    expect(recoveryMessages).toEqual([expect.objectContaining({ email, orderRef: order.orderRef, rawToken: order.token })]);
    const client = (await source.owner.query("SELECT id,principal_id FROM public.clients WHERE email=$1", [email])).rows[0];
    expect(client.principal_id).toBeNull();
    expect(await actions[0]!["payment.simulate"]!({ orderRef: order.orderRef, token: order.token, outcome: "captured" },
      { ...context, commandKey: `pay-${mode}` })).toMatchObject({ ok: true, value: { orderRef: order.orderRef, status: "paid" } });
    expect((await source.owner.query("SELECT principal_id FROM public.clients WHERE id=$1", [client.id])).rows).toEqual([{ principal_id: null }]);
    expect((await source.owner.query("SELECT count(*)::int AS count FROM public.subscriptions")).rows).toEqual([{ count: mode === "subscription" ? 1 : 0 }]);
    await assertJourneyWithoutIntake(source);
    const packet = await captureStoreJourney(source.owner, "guest-purchased");
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine })).toMatchObject({ replayed: false });
    const purchaseRows = async (store: JourneyInstallation) => {
      const all = await journeyCensus(store.owner);
      return Object.fromEntries(Object.entries(all).filter(([name]) => /^(commerce_order|commerce_settlement|payment_simulator|subscription_|subscriptions$|fulfillment_inventory_reservation|fulfillment_purchase_reservation|outbox_events$|commerce_destination)/.test(name)));
    };
    const before = await purchaseRows(source);
    expect(await purchaseRows(target)).toEqual(before);
    const replays: unknown[] = [];
    for (let index = 0; index < 2; index++) {
      replays.push(await actions[index]!["checkout.create"]!(payload, context));
      expect(replays[index]).toMatchObject({ ok: true, replayed: true, value: { orderRef: order.orderRef, status: "paid" } });
      expect(await purchaseRows([source, target][index]!)).toEqual(before);
    }
    expect(replays[1]).toEqual(replays[0]);
    const keys = await generateKeyPair("ES256", { extractable: true });
    const keyId = "synthetic-guest", issuer = "https://identity.example.invalid", audience = "synthetic-guest";
    const privateJwk = { ...await exportJWK(keys.privateKey), alg: "ES256", kid: keyId, use: "sig" };
    const publicJwk = { ...await exportJWK(keys.publicKey), alg: "ES256", kid: keyId, use: "sig" };
    const delivered: string[] = [];
    const session = resolveCustomerSessionBinding({ PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: target.runtimeUrl,
      CUSTOMER_IDENTITY_AUDIENCE: audience, CUSTOMER_IDENTITY_ISSUER: issuer, CUSTOMER_IDENTITY_KEY_ID: keyId,
      CUSTOMER_IDENTITY_PRIVATE_JWK: JSON.stringify(privateJwk) }, { loadJwt: () => import("jose"),
      delivery: createCapturedCustomerChallengeDelivery(async challenge => { delivered.push(challenge.token); }) });
    if (!session.binding) throw new Error(session.error);
    expect((await target.owner.query("SELECT count(*)::int AS count FROM public.customer_identity_challenges")).rows).toEqual([{ count: 0 }]);
    await session.binding.requestChallenge(email);
    expect(delivered).toHaveLength(1);
    const signed = await session.binding.verifyChallenge(delivered[0]!);
    expect(signed).toMatchObject({ user: { email } });
    if (!signed) throw new Error("Restored guest did not sign in");
    expect(await session.binding.verifyChallenge(delivered[0]!)).toBeNull();
    const verifier = createCustomerIdentityVerifier({ audience, issuer, jwks: JSON.stringify({ keys: [publicJwk] }) }, () => import("jose"));
    const principal = await verifier.verifyAccessToken(signed.accessToken);
    expect(principal?.principalId).toBe(signed.user.id);
    const gateway = createPostgresDataGateway({ connectionString: target.runtimeUrl }, { poolFactory: () => target.runtime });
    const me = (id: string) => gateway.asActor({ sub: id, role: "authenticated" }, db => createPostgresCustomerMePort(db as PgGatewayClient).getCustomerMe(id));
    expect(await me(signed.user.id)).toMatchObject({ clientId: client.id, email, firstName: "Synthetic", lastName: "Buyer" });
    expect(await me(randomUUID())).toBeNull();
    expect(await actions[1]!["checkout.read"]!({ orderRef: order.orderRef }, { ...context,
      actor: { customerRef: client.id, principalRef: signed.user.id, operatorRef: null } })).toMatchObject({ ok: true, value: { orderRef: order.orderRef, status: "paid", total: { amountMinor: 274, currency: "XXX" } } });
    expect((await target.owner.query("SELECT id,client_id FROM public.commerce_orders")).rows).toEqual([{ id: order.orderRef, client_id: client.id }]);
  } finally { await Promise.all([...contacts.map(port => port.close()), ...lanes.map(lane => lane.close())]); }
// Two-store installation previously measured about 11 s; 90 s leaves setup and loaded-host headroom.
}, 90_000);
