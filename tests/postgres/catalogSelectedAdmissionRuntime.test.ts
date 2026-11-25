import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { evaluatePromotionAdjustmentsV2 } from "@openlup/core/promo";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
// eslint-disable-next-line no-restricted-imports -- exercise the private submit boundary without an installed export
import { submitSelectedCatalogAdmission } from "../../packages/platform/dist/catalog/catalogSelectedAdmissionRuntime.js";
// eslint-disable-next-line no-restricted-imports -- issue from the same private evaluator on a read-only connection
import { evaluateSelectedAdmissionOwner, ownerRequest, selectedInstant, type SelectedProfile } from "../../packages/platform/dist/catalog/catalogSelectedAdmissionOwner.js";
// eslint-disable-next-line no-restricted-imports -- verify private owner byte equality and payload assembly
import { selectedSubmitInput, selectedWrite, type SelectedOriginal } from "../../packages/platform/dist/catalog/catalogSelectedAdmissionWrite.js";
// eslint-disable-next-line no-restricted-imports -- exercise the exact private reader and staged verifier
import { readAdmissionIssues } from "../../packages/platform/dist/catalog/catalogAdmissionIssueRead.js";
// eslint-disable-next-line no-restricted-imports -- construct signer vectors on the other side of the boundary
import { authenticateSelectedOfferReview, promotionQuoteAcceptanceEnvelope as codec } from "../../packages/platform/dist/promotions/promotionQuoteAcceptanceEnvelope.js";
// eslint-disable-next-line no-restricted-imports -- bind the installed price owner for the private component
import { createPostgresCommercePriceAuthorityReadPort } from "../../packages/platform/dist/commerce/server/postgres/commercePriceRead.js";
import { createPostgresNativeCheckoutHostPort, createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import { resolveThresholdShipping } from "@openlup/platform/shipping";
import { canonicalCatalogDraftJson as canonical } from "@openlup/platform/catalog/contracts";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { documentRow, fixture, graph, hash, insertGraph, installPublicationActors, transaction } from "./catalogPublicationFixture.js";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

const keyring = { current: "0123456789abcdef0123456789abcdef" };
const currency = "XTS";
const offer = { ref: "owner:regular-α", version: "example:subscription" };
const runtimeSql = "SELECT public.catalog_admission_runtime_checkout($1::text,$2::text,$3::uuid,$4::jsonb) AS result";
const dark = { label: "catalog_admission_quote_authority_required",
  message: "Governed checkout is unavailable for this selection. Use a supported offer or replay the original request." };
const conflict = { label: "commerce_order_draft_idempotency_conflict", message: "Replay the original authorized request.", code: "23505" };
const integrity = { label: "catalog_admission_evidence_binding_mismatch" };
const unavailable = { label: "catalog_admission_line_ineligible" };
const signedWindow = 72 * 60 * 60 * 1_000;
let installation: LifecycleInstallation, otherDb: Pool;
let original: SelectedOriginal, profile: SelectedProfile, instant: string;
let evaluated: Awaited<ReturnType<typeof evaluateSelectedAdmissionOwner>>;
const evaluatePromotion = vi.fn<NonNullable<SelectedProfile["authority"]>["evaluate"]>();

beforeAll(async () => {
  installation = await lifecycleInstallation("qualified-v2", { freshCluster: true });
  const { owner, runtime } = installation;
  expect((await runtime.query(`SELECT current_setting('server_version_num')::integer / 10000 AS major,
    current_user, session_user, pg_has_role(session_user,'service_role','USAGE') AS inherited,
    has_schema_privilege(session_user,'public','CREATE') AS writable,
    has_function_privilege(current_user,'public.catalog_offer_memberships_page(text,jsonb,integer,text)','EXECUTE') AS reader,
    has_function_privilege(current_user,'public.catalog_admission_replay_order_draft(text,uuid,text,text)','EXECUTE') AS replay,
    has_function_privilege(current_user,'public.catalog_admission_runtime_checkout(text,text,uuid,jsonb)','EXECUTE') AS writer`)).rows)
    .toEqual([{ major: 16, current_user: "service_role", session_user: "lifecycle_r", inherited: true, writable: false, reader: true, replay: true, writer: true }]);
  await owner.query("CREATE DATABASE selected_checkout_peer");
  otherDb = new Pool({ ...owner.options, database: "selected_checkout_peer" });
  await installPublicationActors(owner);
  const actorRef = randomUUID();
  const email = "buyer@example.invalid";
  const clientId = (await owner.query("INSERT INTO public.clients(email,principal_id) VALUES($1,$2) RETURNING id", [email, actorRef])).rows[0]!.id as string;
  const seeded = await transaction(owner, async db => {
    const entry = await graph(db, { ...fixture(), skuCode: "ARTICLE-A" }, null, true, { lifecycle: "active", subscriptionEligible: true });
    entry.facts.memberships = [{ offerVersion: offer.version, admitted: true }];
    entry.facts.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: "0000000000017", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null }];
    await insertGraph(db, entry);
    const legacy = await graph(db, { ...fixture(), skuCode: "ARTICLE-B" });
    await documentRow(db, legacy);
    await db.query("UPDATE public.catalog_products SET status='active' WHERE id=$1", [legacy.productId]);
    await db.query("UPDATE public.catalog_skus SET status='active',sellable_standalone=true,sellable_in_subscription=true WHERE id=$1", [legacy.skuId]);
    await db.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary)
      VALUES($1,'example','gtin','00000000000024','unit',1,true)`, [legacy.skuId]);
    return { entry, legacy };
  });
  const priceListId = (await owner.query(`INSERT INTO public.price_lists(name,region_code,currency,status,valid_from)
    VALUES('Selected fixture','ZZ',$1,'active',clock_timestamp()-interval '1 day') RETURNING id,amount_basis`, [currency])).rows[0]!;
  expect(priceListId.amount_basis).toBeNull();
  await owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,amount_kind,valid_from)
    SELECT $1, sku, mode, 1, amount, 'gross', clock_timestamp()-interval '1 day'
    FROM unnest($2::uuid[]) sku CROSS JOIN (VALUES ('one_time',1490),('subscription',1340)) tier(mode,amount)`,
  [priceListId.id, [seeded.entry.skuId, seeded.legacy.skuId]]);
  instant = selectedInstant((await owner.query("SELECT clock_timestamp()::text AS instant")).rows[0]!.instant as string);
  const validFrom = new Date(Date.parse(instant) - 60_000).toISOString();
  const acquisition = { schemaVersion: "subscription-acquisition.v1", revision: "acquisition:1", initialDiscountBps: 2000,
    delivery2DiscountBps: 3000, effectiveFrom: validFrom, effectiveTo: null, sourcePromotionId: "promotion:regular" } as const;
  const shippingTerms = { version: "shipping-threshold.v1", currency, flatMinor: 150, freeThresholdMinor: 2700 } as const;
  evaluatePromotion.mockImplementation(async ({ referenceProductMinor, subtotalGrossMinor }) => ({
    secondProductMinor: evaluatePromotionAdjustmentsV2({
      purchaseScope: "subscription_initial", referenceProductMinor, currentProductMinor: subtotalGrossMinor,
      shippingMinor: 0, minimumProductPayableMinor: 10,
    }, [{ promotionId: acquisition.sourcePromotionId, name: acquisition.sourcePromotionId, source: "automatic",
      scopes: ["subscription_initial"], kind: "target_percentage", lane: "product", valueBps: acquisition.delivery2DiscountBps }]).productPayableMinor,
    result: { acquisitionTerms: acquisition, shippingTerms, shippingGrossMinor: 150, hasShipping: true, codeRejections: [], codeRejectionDetails: [],
      discounts: [{ promotionId: acquisition.sourcePromotionId, reasonCode: "promotion_target_percentage", appliesTo: "order_total", amountOffMinor: 296 }] },
    decisions: { promotions: [{ ref: acquisition.sourcePromotionId, revision: "1", validFrom, validTo: null, decision: "applied" }],
      eligibilityRef: "owner:eligibility-α", claim: "eligible", acquisitionPolicyRef: "owner:acquisition", taxRef: "owner:tax", shippingRef: "owner:shipping" },
  }));
  const identity = { configuration: "regular", ownerNamespace: "example:store", merchantRef: "example:merchant", installationRef: "example:site", offer };
  profile = { identity, offerSelector: "configured:regular", currency, country: "ZZ", termsRevision: "terms:1", cadenceDays: [28],
    minimumUnits: 1, maximumUnits: 12, sourceOrdinal: 1, skuIds: [seeded.entry.skuId, seeded.legacy.skuId], skuCodes: ["ARTICLE-A", "ARTICLE-B"],
    skuRevisionId: seeded.entry.skuRevisionId, priceListId: priceListId.id, authority: {
      pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" },
      tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 2300, legalBasis: "Example VAT rule" },
      async verifyDocument(document, envelope) { expect(hash(canonical(document))).toBe(envelope.documentRevision.digest); },
      priceRead: createPostgresCommercePriceAuthorityReadPort,
      secondShipping: (terms, product) => resolveThresholdShipping(terms, product).grossMinor,
      phase: { applicability: "absent" }, destination: null,
      retention: { minimumPayableMinor: 10, normalCadenceDays: [28, 56], graduationCadenceDays: 56, basisTemplateVersion: 1 },
      evaluate: evaluatePromotion,
    } };
  original = { ...identity, actorRef, clientId, key: randomUUID(), lane: "starter-checkout", purpose: "offer-review",
    selection: { mode: "subscription", cadenceDays: 28, lines: [{ sku: "ARTICLE-A", quantity: 1 }, { sku: "ARTICLE-B", quantity: 1 }],
      acquisitionCapability: "subscription-acquisition.v1", promoCodes: [] },
    contact: { country: "ZZ", firstName: "Sample", lastName: "Buyer", phone: "000000", line1: "Example 1", city: "Example",
      postalCode: "000", email, purchaser: clientId }, consent: { accepted: true, termsRevision: "terms:1" } };
  const db = await runtime.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    evaluated = await evaluateSelectedAdmissionOwner(db, profile, ownerRequest(original, profile.offerSelector), instant);
    await db.query("COMMIT");
  } finally { db.release(); }
}, postgresSetupTimeoutMs);

afterAll(async () => {
  try { await closePostgres([], [otherDb].filter(Boolean)); } finally { await installation?.close(); }
}, postgresTeardownTimeoutMs);

function signed(request = original, patch: Record<string, unknown> = {}, override = keyring.current) {
  const quote = evaluated.quoteSnapshot.quote;
  const { acquisitionTerms, shippingTerms } = quote.context;
  const iat = Date.parse(instant);
  const payload = { v: 1, kid: codec.keyId(override), iat, exp: iat + signedWindow, engine: "promotion-engine.v2",
    requestBinding: codec.requestBinding(ownerRequest(request, profile.offerSelector), override), codeBinding: codec.codeBinding([], override),
    quoteBinding: codec.quoteBinding(quote, override, acquisitionTerms, shippingTerms),
    sectionBindings: codec.sectionBindings(quote, override, acquisitionTerms, shippingTerms),
    totalMinor: quote.totalGross.amountMinor, currency, ownerQuoteDigest: evaluated.owner.evidence.quoteDigest, ...patch };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${codec.sign(body, override, true)}`;
}

function trace(overrides?: (index: number, sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] } | undefined>) {
  const statements: Array<{ index: number; sql: string; values?: unknown[] }> = [];
  let connection = 0;
  const pool = { async connect() {
    const index = connection++, db = await installation.runtime.connect();
    return {
      async query(query: string | { text: string; values: unknown[]; query_timeout?: number }, args?: unknown[]) {
        const sql = typeof query === "string" ? query : query.text, values = typeof query === "string" ? args : query.values;
        statements.push({ index, sql, values });
        return await overrides?.(index, sql, values) ?? (typeof query === "string" ? db.query(query, values) : db.query(query));
      },
      on: db.on.bind(db), removeListener: db.removeListener.bind(db), release: db.release.bind(db),
    };
  } };
  return { pool: pool as unknown as Parameters<typeof submitSelectedCatalogAdmission>[0], statements,
    writes: () => statements.filter(entry => entry.sql === runtimeSql && entry.values?.[0] === "write"),
    guards: () => statements.filter(entry => entry.sql === runtimeSql && entry.values?.[0] === "prelock") };
}
const prepare = (request = original) => ({ original: request, quoteAcceptance: signed(request), expectedTotal: evaluated.quoteSnapshot.quote.totalGross });
const options = (request = original): Parameters<typeof submitSelectedCatalogAdmission>[2] => ({ profile, timeoutMs: 6_000,
  initialOrder: (db, id) => createPostgresNativeCheckoutHostPort(db).isInitialCheckoutOrder(id),
  authenticateReview: (token, request) => authenticateSelectedOfferReview(token, keyring, request),
  verified: { actorRef: request.actorRef, clientId: request.clientId, key: request.key, email: request.contact.email } });

async function effectRows() {
  return (await installation.owner.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM public.commerce_orders t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.commerce_order_items t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.commerce_order_draft_receipts t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.commerce_settlement_intents t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.commerce_order_adjustments t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.commerce_promotion_claims t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.commerce_promotion_claim_events t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.commerce_destination_v2_order_bindings t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.commerce_destination_bindings t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.commerce_order_holds t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.fulfillment_stock_current t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.subscription_activations t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.payment_provider_attempts t
    UNION ALL SELECT jsonb_agg(to_jsonb(t)) FROM public.outbox_events t`)).rows;
}

it("evaluates once on the fenced writer and dispatches the exact projection to the installed dark arm", async () => {
  const before = await effectRows(), input = prepare();
  evaluatePromotion.mockClear();
  const observed = trace(async (_index, sql) => sql.startsWith("SELECT clock_timestamp()") ? { rows: [{ instant }] } : undefined);
  const copies = { ownerDocument: evaluated.owner.document, ownerQuoteDigest: evaluated.owner.evidence.quoteDigest };
  await expect(submitSelectedCatalogAdmission(observed.pool, { ...input, copies }, options())).rejects.toMatchObject(dark);
  expect(evaluatePromotion).toHaveBeenCalledTimes(1);
  expect(observed.guards()).toHaveLength(1);
  const tokenDigest = hash(input.quoteAcceptance);
  const expected = selectedWrite(original, evaluated.quoteSnapshot, evaluated.owner, tokenDigest);
  const writes = observed.writes();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ index: 0, sql: runtimeSql });
  expect(writes[0]!.values?.slice(0, 3)).toEqual(["write", original.key, original.clientId]);
  expect(hash(canonical(JSON.parse(String(writes[0]!.values?.[3]))))).toBe(hash(canonical(expected)));
  const bound = observed.statements.filter(row => row.sql.includes("catalog_offer_memberships_page") || row.sql.includes("subscription_price_policy_revisions"));
  expect(bound.length).toBeGreaterThan(1);
  expect(bound.every(row => row.index === 0)).toBe(true);
  expect(observed.statements.some(row => row.sql === "COMMIT")).toBe(false);
  for (const payload of [expected, { ...expected, receipt: {} }, { ...expected, submit: { ...expected.submit, reviewedPayable: null } }]) {
    await expect(installation.runtime.query(runtimeSql, ["write", original.key, original.clientId, JSON.stringify(payload)]))
      .rejects.toMatchObject({ code: "55000", message: dark.label, hint: dark.message });
  }
  expect(await effectRows()).toEqual(before);
});

it("checks the closed original and its adjacent input bounds", () => {
  const base = prepare();
  for (const [field, maximum] of Object.entries({ firstName: 64, lastName: 64, phone: 32, postalCode: 32, line1: 200, city: 200 })) {
    for (const length of [1, maximum, 0, maximum + 1]) {
      const input = { ...base, original: { ...original, contact: { ...original.contact, [field]: "a".repeat(length) } } };
      expect(selectedSubmitInput.safeParse(input).success, field + ":" + length).toBe(length >= 1 && length <= maximum);
    }
    const contact = { ...original.contact } as Record<string, unknown>;
    delete contact[field];
    expect(selectedSubmitInput.safeParse({ ...base, original: { ...original, contact } }).success).toBe(false);
  }
  for (const [line2, accepted] of [["", true], ["a".repeat(200), true], ["a".repeat(201), false], [null, false]] as const) {
    expect(selectedSubmitInput.safeParse({ ...base, original: { ...original, contact: { ...original.contact, line2 } } }).success).toBe(accepted);
  }
  for (const [keyLength, accepted] of [[7, false], [8, true], [120, true], [121, false]] as const) {
    expect(selectedSubmitInput.safeParse({ ...base, original: { ...original, key: "a".repeat(keyLength) } }).success).toBe(accepted);
  }
  for (const [quantity, accepted] of [[0, false], [1, true], [99, true], [100, false], [1.5, false]] as const) {
    const selection = { ...original.selection, lines: [{ ...original.selection.lines[0], quantity }, original.selection.lines[1]] };
    expect(selectedSubmitInput.safeParse({ ...base, original: { ...original, selection } }).success).toBe(accepted);
  }
  for (const [amountMinor, accepted] of [[0, false], [1, true], [Number.MAX_SAFE_INTEGER, true], [Number.MAX_SAFE_INTEGER + 1, false]] as const) {
    expect(selectedSubmitInput.safeParse({ ...base, expectedTotal: { amountMinor, currency } }).success).toBe(accepted);
  }
});

it("preserves authorization timing and qualification precedence on an absent receipt", async () => {
  const observed = trace();
  evaluatePromotion.mockClear();
  const input = prepare();
  const expired = signed(original, { iat: Date.parse(instant) - 1, exp: Date.parse(instant) });
  for (const invalid of [
    { ...input, quoteAcceptance: expired + "=" },
    { ...input, original: { ...original, purpose: "checkout" }, quoteAcceptance: expired },
    { ...input, original: { ...original, selection: { ...original.selection, promoCodes: ["different"] } }, quoteAcceptance: expired },
    { ...input, quoteAcceptance: signed(original, { requestBinding: "a".repeat(64), iat: Date.parse(instant) - 1, exp: Date.parse(instant) }) },
  ]) await expect(submitSelectedCatalogAdmission(observed.pool, invalid, options())).rejects.toMatchObject({ label: "starter_quote_refresh_required" });
  await expect(submitSelectedCatalogAdmission(observed.pool, input, { ...options(), profile: { ...profile, authority: undefined } }))
    .rejects.toMatchObject(unavailable);
  expect(observed.guards()).toHaveLength(0);
  expect(evaluatePromotion).not.toHaveBeenCalled();
  const sampled = trace(async (_index, sql) => sql.startsWith("SELECT clock_timestamp()") ? { rows: [{ instant }] } : undefined);
  await expect(submitSelectedCatalogAdmission(sampled.pool, { ...input, quoteAcceptance: expired }, options()))
    .rejects.toMatchObject({ label: "catalog_admission_quote_expired" });
  expect(sampled.guards()).toHaveLength(1);
  expect(evaluatePromotion).not.toHaveBeenCalled();
});

it("refuses missing owner offer authority and a missing offer in a transported copy independently", async () => {
  const observed = trace(), input = prepare();
  const identity = { ...profile.identity } as Partial<SelectedProfile["identity"]>;
  delete identity.offer;
  await expect(submitSelectedCatalogAdmission(observed.pool, input, {
    ...options(), profile: { ...profile, identity: identity as SelectedProfile["identity"] },
  })).rejects.toMatchObject({ label: "catalog_admission_membership_authority_unavailable" });
  const evidence = { ...evaluated.owner.evidence };
  delete evidence.offer;
  await expect(submitSelectedCatalogAdmission(observed.pool, { ...input, copies: { evidence } }, options())).rejects.toMatchObject(integrity);
  expect(observed.writes()).toHaveLength(0);
});

it("separates signed money and digest motion and checks each signed section", async () => {
  const input = prepare(), before = await effectRows();
  const observed = trace();
  await expect(submitSelectedCatalogAdmission(observed.pool, { ...input, quoteAcceptance: signed(original, { ownerQuoteDigest: "a".repeat(64) }) }, options()))
    .rejects.toMatchObject({ label: "catalog_admission_quote_digest_moved" });
  await expect(submitSelectedCatalogAdmission(observed.pool, { ...input, expectedTotal: { amountMinor: 1, currency },
    quoteAcceptance: signed(original, { ownerQuoteDigest: "a".repeat(64), totalMinor: 1 }) }, options()))
    .rejects.toMatchObject({ label: "starter_quote_refresh_required" });
  await expect(submitSelectedCatalogAdmission(observed.pool, { ...input, quoteAcceptance: signed(original, { ownerQuoteDigest: undefined }) }, options()))
    .rejects.toMatchObject({ label: "starter_quote_refresh_required" });
  const quote = evaluated.quoteSnapshot.quote;
  const hashes = codec.sectionBindings(quote, keyring.current, quote.context.acquisitionTerms, quote.context.shippingTerms);
  for (const section of Object.keys(hashes)) {
    await expect(submitSelectedCatalogAdmission(observed.pool, { ...input, quoteAcceptance: signed(original, { sectionBindings: { ...hashes, [section]: "a".repeat(64) } }) }, options()))
      .rejects.toMatchObject(integrity);
  }
  expect(observed.writes()).toHaveLength(0);
  expect(await effectRows()).toEqual(before);
});

it("makes a cluster visibility retry explicit on the same immutable request", async () => {
  const input = prepare(), before = await effectRows();
  let advanced = false;
  evaluatePromotion.mockClear();
  const observed = trace(async (index, sql) => {
    if (index === 1 && sql.startsWith("WITH snap AS MATERIALIZED") && !advanced) {
      advanced = true;
      await otherDb.query("SELECT pg_current_xact_id()");
    }
    return undefined;
  });
  await expect(submitSelectedCatalogAdmission(observed.pool, input, options())).rejects.toMatchObject({
    message: "catalog_admission_visibility_changed", code: "40001", hint: "Retry the same request with the same idempotency key.",
  });
  expect(observed.statements.filter(row => row.sql.startsWith("BEGIN"))).toHaveLength(1);
  expect(observed.writes()).toHaveLength(0);
  expect(evaluatePromotion).not.toHaveBeenCalled();
  await expect(submitSelectedCatalogAdmission(observed.pool, input, options())).rejects.toMatchObject(dark);
  expect(evaluatePromotion).toHaveBeenCalledTimes(1);
  expect(observed.writes()).toHaveLength(1);
  expect(await effectRows()).toEqual(before);
});

it("refuses legacy origins on selected checkout and replays the same key through the incumbent path", async () => {
  evaluatePromotion.mockClear();
  const { runtime } = installation;
  const amount = { amountMinor: 1490, currency }, zero = { amountMinor: 0, currency };
  const snapshot = { contractVersion: "commerce.v0", quote: { currency, taxIncluded: true, context: { mode: "one_time", promoCodes: [] },
    lines: [{ sku: "ARTICLE-B", productSlug: "example", quantity: 1, unitPriceGross: amount, lineSubtotalGross: amount,
      tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Example",
        netAmount: amount, vatAmount: zero, grossAmount: amount } }], discounts: [], subtotalGross: amount,
    discountTotalGross: zero, totalGross: amount, netTotal: amount, taxTotal: zero } } as const;
  for (const stamped of [true, false]) {
    const request = { ...original, key: randomUUID() };
    const legacy = { idempotencyKey: request.key, quoteSnapshot: structuredClone(snapshot) as unknown as Parameters<
      ReturnType<typeof createPostgresNativeCheckoutPersistence>["createOrderDraft"]>[0]["quoteSnapshot"] };
    const legacyPayload = { configuration: "regular", locale: "en", cart: { schemaVersion: 1, mode: "one_time", lines: [{ sku: "ARTICLE-B", quantity: 1 }] } };
    const stampScope = { schemaVersion: 1, clientId: request.clientId, requestKey: request.key, ownerNamespace: request.ownerNamespace,
      actorRef: request.actorRef, lane: request.lane, acceptanceTokenDigest: null };
    const legacyDigest = hash(canonical(["catalog.checkout-submit.v1", stampScope, { ...legacyPayload, email: request.contact.email }]));
    const saved = await transaction(runtime, async db => {
      const result = await createPostgresNativeCheckoutPersistence(db).createOrderDraft(legacy, { clientId: request.clientId });
      if (stamped) await db.query("SELECT public.catalog_admission_attach_legacy_submit($1,$2,$3)",
        [request.key, request.clientId, { ...stampScope, submitDigest: legacyDigest }]);
      return result;
    });
    const before = await effectRows();
    const observed = trace();
    await expect(submitSelectedCatalogAdmission(observed.pool, prepare(request), options(request))).rejects.toMatchObject(conflict);
    expect(observed.guards()).toHaveLength(0);
    expect(observed.writes()).toHaveLength(0);
    const replay = stamped ? (await runtime.query(
      "SELECT public.catalog_admission_replay_order_draft($1,$2,$3,$4) AS result",
      [request.key, request.clientId, request.lane, legacyDigest])).rows[0]!.result
      : await createPostgresNativeCheckoutPersistence(runtime).createOrderDraft(legacy, { clientId: request.clientId });
    expect(replay).toEqual({ ...saved, orderDraft: { ...saved.orderDraft, replayed: true } });
    expect(await effectRows()).toEqual(before);
  }
  expect(evaluatePromotion).not.toHaveBeenCalled();
});

it("accepts only an exact governed fixture transcript and classifies owned expiry after conflict", async () => {
  const input = prepare(), orderId = randomUUID(), nativeFingerprint = "a".repeat(32);
  const { submit } = selectedWrite(original, evaluated.quoteSnapshot, evaluated.owner, hash(input.quoteAcceptance));
  const { ownerQuoteDigest, reviewedPayable, ...stamp } = submit;
  const snapshot = evaluated.quoteSnapshot;
  const row = {
    id: orderId, client_id: original.clientId, receipt_key: original.key, status: "pending_payment", currency_code: currency,
    total_amount_minor: reviewedPayable.amountMinor, snapshot, stamp,
    origin: { schemaVersion: 1, orderId, receiptKey: original.key, nativeFingerprint },
    fingerprint: nativeFingerprint, completed: false, quote_digest: ownerQuoteDigest,
  };
  const response = { contractVersion: "commerce.v0", orderDraft: { orderId: `order_${orderId}`, status: "draft", paymentStatus: "not_started",
    idempotencyKey: original.key, quoteSnapshot: snapshot, replayed: true } };
  for (const outcome of ["pending", "replayed", "conflict", "expired"] as const) {
    evaluatePromotion.mockClear();
    const observed = trace(async (_index, sql) => {
      if (sql.includes("idempotency_key=$1 FOR UPDATE")) return { rows: [{ order_id: orderId }] };
      if (sql.includes("AS origin")) return { rows: [{ ...row, completed: outcome === "replayed" }] };
      if (sql.startsWith("SELECT public.catalog_admission_replay_order_draft")) {
        if (outcome === "expired" || outcome === "conflict") throw Object.assign(new Error("commerce_order_draft_expired"), { code: "40001" });
        return { rows: [{ result: response }] };
      }
      if (sql.includes("AS initial_checkout")) return { rows: [{ initial_checkout: true }] };
      return undefined;
    });
    const result = submitSelectedCatalogAdmission(observed.pool, outcome === "conflict" ? { ...input, quoteAcceptance: "changed.token" } : input, options());
    if (outcome === "expired") await expect(result).rejects.toMatchObject({ label: "commerce_order_draft_expired", code: "40001" });
    else if (outcome === "conflict") {
      await expect(result).rejects.toMatchObject(conflict);
      expect(observed.statements.some(entry => entry.sql.startsWith("SELECT public.catalog_admission_replay_order_draft"))).toBe(false);
    } else await expect(result).resolves.toMatchObject({ kind: outcome, response });
    expect(observed.guards()).toHaveLength(0);
    expect(observed.writes()).toHaveLength(0);
    expect(evaluatePromotion).not.toHaveBeenCalled();
  }
});

it("refuses locally contradictory reader results and forwards an exact successful cursor", async () => {
  const source = profile.skuIds[0], declaring = profile.skuRevisionId, productId = randomUUID();
  const head = { productId, publicationId: randomUUID(), revision: 1, documentDigest: "a".repeat(64) };
  const cursor = { selectedSkuId: source, offerVersion: offer.version, mode: "admission_issue", limit: 1, offset: 1,
    headDigest: "a".repeat(64), binding: "b".repeat(64) };
  const page = (kind: string, revision: string, nextCursor: unknown) => ({ kind: "page", value: {
    issues: [{ ...head, kind, skuRevisionId: revision }], consultedHeads: [head], rosterCount: 2, nextCursor,
  } });
  const first = page("compared", randomUUID(), cursor), second = page("declaring", declaring, null);
  function consume(...results: unknown[]) {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ result: results.shift() }] }));
    return { query, result: readAdmissionIssues({ query }, offer.version, source, declaring, 1, 1) };
  }
  const exact = consume(first, second);
  await expect(exact.result).resolves.toEqual({ issues: [first, second].map(result => ({ ...result.value.issues[0], sourceOrdinal: 1 })),
    consultedHeads: [head] });
  expect(JSON.parse(exact.query.mock.calls[0]![1]?.[1] as string)).toEqual({ selectedSkuId: source });
  expect(JSON.parse(exact.query.mock.calls[1]![1]?.[1] as string)).toEqual({ selectedSkuId: source, continuation: cursor });
  for (const invalid of [
    { ...first, extra: true }, { kind: "refusal", reason: "head_moved" }, { kind: "refusal", reason: "unknown_offer", detail: "wrong" },
    page("compared", first.value.issues[0]!.skuRevisionId, null), page("compared", randomUUID(), { ...cursor, offset: 2 }),
  ]) await expect(consume(invalid, second).result).rejects.toMatchObject({ label: "catalog_admission_membership_authority_unavailable" });
});

function reviewCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, field: unknown) => {
    if (key === "starterRequest" || key === "atTime") return undefined;
    return field;
  })) as T;
}

function edits(value: unknown, path: Array<string | number> = []): Array<{ path: Array<string | number>; value?: unknown; remove?: true }> {
  if (Array.isArray(value)) {
    return [...(value.length > 1 ? [{ path, value: [...value].reverse() }] : []),
      ...value.flatMap((item, index) => [{ path: [...path, index], remove: true as const }, ...edits(item, [...path, index])])];
  }
  if (value && typeof value === "object") {
    return [{ path: [...path, "extra"], value: true }, ...Object.entries(value).flatMap(([key, item]) =>
      [{ path: [...path, key], remove: true as const }, ...edits(item, [...path, key])])];
  }
  return [{ path, value: typeof value === "number" ? value + 1 : typeof value === "string" ? "different" : value === null ? "different" : !value },
    ...(value === null ? [] : [{ path, value: null }])];
}

it("compares each carried leaf and presence before offering any motion advice", async () => {
  const input = prepare(), tokenDigest = hash(input.quoteAcceptance);
  const { owner, quoteSnapshot } = evaluated;
  const payload = selectedWrite(original, quoteSnapshot, owner, tokenDigest);
  const copies: Record<string, unknown> = { ...payload, quoteSnapshot: reviewCopy(payload.quoteSnapshot), draft: reviewCopy(payload.draft),
    ownerDocument: owner.document, ownerQuoteDigest: owner.evidence.quoteDigest, secondTotalMinor: owner.document.reviewedProjection.secondTotalMinor };
  expect(() => selectedWrite(original, quoteSnapshot, owner, tokenDigest, copies)).not.toThrow();
  for (const edit of edits(copies)) {
    if (edit.remove && edit.path.length === 1) continue;
    const changed = structuredClone(copies);
    const parent = edit.path.slice(0, -1).reduce<Record<string, unknown>>((cursor, part) =>
      cursor[part] as Record<string, unknown>, changed);
    const key = String(edit.path.at(-1));
    if (edit.remove) {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else parent[key] = edit.value;
    if (canonical(changed) === canonical(copies)) continue;
    expect(() => selectedWrite(original, quoteSnapshot, owner, tokenDigest, changed), edit.path.join(".")).toThrow(
      expect.objectContaining(integrity));
  }
  for (const name of ["splits", "adjustments", "receipt", "payment"]) {
    expect(() => selectedWrite(original, quoteSnapshot, owner, tokenDigest, { [name]: null })).toThrow(expect.objectContaining(integrity));
  }
  const changedTotal = { amountMinor: 1, currency };
  const coherent = { quoteSnapshot: structuredClone(copies.quoteSnapshot) as typeof payload.quoteSnapshot,
    draft: structuredClone(copies.draft) as typeof payload.draft, submit: { ...payload.submit, reviewedPayable: changedTotal } };
  coherent.quoteSnapshot.quote.totalGross = coherent.draft.totals.totalGross = changedTotal;
  for (const x of [{ original: { ...original, contact: { ...original.contact, line2: "" } } },
    { quoteSnapshot: { ...copies.quoteSnapshot as object, quote: payload.quoteSnapshot.quote } }, coherent]) {
    expect(() => selectedWrite(original, quoteSnapshot, owner, tokenDigest, x)).toThrow(expect.objectContaining(integrity));
  }
  const observed = trace();
  await expect(submitSelectedCatalogAdmission(observed.pool, { ...input, copies: coherent,
    quoteAcceptance: signed(original, { ownerQuoteDigest: "e".repeat(64) }) }, options())).rejects.toMatchObject(integrity);
  expect(observed.writes()).toHaveLength(0);
});

it("enforces reader count, page caps and exact refusal dispositions", async () => {
  const selectedSkuId = profile.skuIds[0], revision = profile.skuRevisionId, offerVersion = offer.version;
  const head = { productId: randomUUID(), publicationId: randomUUID(), revision: 2_147_483_647, documentDigest: "a".repeat(64) };
  const roster = Array.from({ length: 500 }, (_, index) => ({ ...head, kind: index ? "compared" : "declaring",
    skuRevisionId: index ? randomUUID() : revision }));
  function consume(count: number, limit: number) {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      const offset = JSON.parse(String(values?.[1])).continuation?.offset ?? 0;
      const next = offset + limit;
      return { rows: [{ result: { kind: "page", value: { rosterCount: count, consultedHeads: [head], issues: roster.slice(offset, next),
        nextCursor: next < count ? { offset: next, selectedSkuId, offerVersion, mode: "admission_issue", limit,
          headDigest: "b".repeat(64), binding: "c".repeat(64) } : null } } }] };
    });
    return { query, result: readAdmissionIssues({ query }, offerVersion, selectedSkuId, revision, 2, limit) };
  }
  for (const limit of [25, 100]) {
    const accepted = consume(500, limit);
    const result = await accepted.result;
    expect(result.issues).toHaveLength(500);
    expect(result.issues.every(issue => issue.sourceOrdinal === 2)).toBe(true);
    expect(accepted.query).toHaveBeenCalledTimes(500 / limit);
  }
  for (const [count, limit] of [[501, 100], [500, 24], [500, 0], [500, 101], [0, 100]] as const) {
    await expect(consume(count, limit).result).rejects.toMatchObject({ label: "catalog_admission_membership_authority_unavailable" });
  }
  for (const [reason, detail, label, message] of [
    ["invalid_request", undefined, "catalog_admission_membership_authority_unavailable", "Restart the bound catalogue read from page one."],
    ["unknown_offer", undefined, "catalog_admission_membership_authority_unavailable", "Choose an eligible published subscription offer."],
    ["inconsistent_evidence", undefined, "catalog_admission_membership_authority_unavailable", "Have the catalogue owner reconcile the publication evidence, then read the offer again."],
    ["invalid_request", "catalog_admission_selection_ineligible", "catalog_admission_line_ineligible", "Choose an eligible SKU in the same offer."],
    ["inconsistent_evidence", "catalog_publication_live_drift", "catalog_admission_membership_authority_unavailable", "Have the catalogue owner reconcile the live listing with its publication, then read the offer again."],
    ["inconsistent_evidence", "catalog_admission_membership_cap_exceeded", "catalog_admission_membership_authority_unavailable", "Use a smaller supported offer."],
    ["inconsistent_evidence", "catalog_admission_page_cap_exceeded", "catalog_admission_membership_authority_unavailable", "Have the catalogue owner verify the installed reader and restart from page one."],
    ["head_moved", undefined, "catalog_admission_membership_authority_unavailable", "Have the catalogue owner verify the installed reader and restart from page one."],
  ] as const) {
    const query = async () => ({ rows: [{ result: { kind: "refusal", reason, ...(detail && { detail }) } }] });
    await expect(readAdmissionIssues({ query }, offerVersion, selectedSkuId, revision, 2)).rejects.toMatchObject({ label, message });
  }
});
