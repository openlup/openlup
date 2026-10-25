import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { acquisitionTermsExpectationSchema, createCommerceQuotePrimitives } from "../../src/pricing/index.js";
import {
  CHECKOUT_CONTRACT_VERSION, CHECKOUT_RESUME_CONTRACT_VERSION, CONFIGURATOR_INTENT_VERSION,
  CUSTOMER_DEFAULTS_SNAPSHOT_VERSION, commerceMinimumUnits, commerceMinimumUnitsSchema,
  commerceOfferVersionSchema, commerceSizeConstraintCoreSchema, createConfiguratorIntentSchemas,
  configuratorIntentPersistenceResponseCoreSchema, checkoutResumeCompletionCoreSchema,
  createCheckoutQuoteSchemas, createCheckoutResponseSchemas, createCheckoutResumeSchemas,
  createCommerceSchemas, createCustomerDefaultsSnapshotSchemas, validateConfiguratorIntentCore,
} from "../../src/commerce/index.js";
import type { ConfiguratorIntent, CommerceCustomerDefaultsSnapshot, CheckoutResumeDraftState } from "../../src/commerce/contracts/index.js";

const currency = z.literal("XXX");
const primitives = createCommerceQuotePrimitives(currency);
const { configuratorIntentCoreSchema } = createConfiguratorIntentSchemas(primitives.commerceSkuSchema);
const line = z.object({ sku: primitives.commerceSkuSchema, quantity: z.number().int().positive() });
const quote = z.object({ contractVersion: z.literal("commerce.v0"), quote: z.object({ total: primitives.commerceMoneySchema }) }).strict();
const schemas = createCommerceSchemas({ ...primitives, cartLineInputSchema: line,
  createQuoteResponseSchema: quote, contractVersion: "commerce.v0" });
const money = { amountMinor: 120, currency: "XXX" };
const snapshot = { contractVersion: "commerce.v0", quote: { total: money } };
const id = "11111111-1111-4111-8111-111111111111";

it("binds cart, order and payment schemas without replacing pricing validation", () => {
  expect(schemas.createCartRequestSchema.parse({ lines: [{ sku: " ITEM-A ", quantity: 1 }] }))
    .toEqual({ lines: [{ sku: "ITEM-A", quantity: 1 }] });
  expect(schemas.cartDraftSchema.safeParse({ id: "cart_a", status: "draft", lines: [{ sku: "ITEM-A", quantity: 1 }], currency: "BAD" }).success).toBe(false);
  expect(schemas.createCheckoutResponseSchema.safeParse({ contractVersion: "commerce.v0", checkout: {
    id: "checkout_a", cartId: "cart_a", status: "created", redirectUrl: null, paymentProviderSessionId: null,
  } }).success).toBe(false);
  const request = schemas.createOrderDraftRequestSchema.parse({ idempotencyKey: " draft-key-1 ", quoteSnapshot: snapshot, clientId: "forged" });
  expect(request).toEqual({ idempotencyKey: "draft-key-1", quoteSnapshot: snapshot });
  expect(schemas.createOrderDraftResponseSchema.parse({ contractVersion: "commerce.v0", orderDraft: {
    orderId: "order_a", status: "draft", paymentStatus: "not_started", ...request, replayed: true,
  } }).orderDraft.replayed).toBe(true);
  expect(schemas.orderReadResponseSchema.parse({ contractVersion: "commerce.v0", order: {
    id: "order_a", status: "paid", paymentStatus: "paid", total: money, lines: [{ sku: "ITEM-A", quantity: 1 }],
  } }).order.total).toEqual(money);
  expect(schemas.paymentStatusReadResponseSchema.parse({ contractVersion: "commerce.v0", payment: {
    id: "payment_a", orderId: "order_a", status: "paid", amount: money, providerReference: null,
  } }).payment.amount).toEqual(money);
});

it("carries opaque offer asks, bounds them and uses the injected default only when absent", () => {
  expect(commerceOfferVersionSchema.parse("offer-a.v2")).toBe("offer-a.v2");
  for (const value of ["", " Offer-a", "offer..a", "a".repeat(41)]) expect(commerceOfferVersionSchema.safeParse(value).success).toBe(false);
  for (const value of [0, 100, 1.5]) expect(commerceMinimumUnitsSchema.safeParse(value).success).toBe(false);
  expect(commerceMinimumUnits({}, 14)).toBe(14);
  expect(commerceMinimumUnits({ minimumUnits: 2 }, 14)).toBe(2);
  expect(commerceSizeConstraintCoreSchema.safeParse({ kind: "unit_count", value: 0 }).success).toBe(false);
  const schema = configuratorIntentCoreSchema.superRefine((value, ctx) => validateConfiguratorIntentCore(value, ctx, 14));
  const value = { version: CONFIGURATOR_INTENT_VERSION, idempotencyKey: "intent-key-1", mode: "one_time",
    contact: { firstName: "Buyer", lastName: "Example", email: "buyer@example.test", phone: "123456789" },
    address: { street: "Example 1", postalCode: "00000", city: "Example", country: "AA" },
    selectedVariants: [{ variantId: "variant-a", sku: "ITEM-A", qty: 2 }] };
  expect(schema.safeParse(value).success).toBe(false);
  const parsed = schema.parse({ ...value, minimumUnits: 2, offerVersion: "offer-a.v2" });
  expect(parsed.minimumUnits).toBe(2);
  expectTypeOf(parsed).toEqualTypeOf<ConfiguratorIntent>();
  const noCadence = schema.safeParse({ ...value, minimumUnits: 2, mode: "subscription" });
  expect(noCadence.success).toBe(false);
  if (!noCadence.success) expect(noCadence.error.issues.map(issue => issue.path)).toEqual([["cadenceDays"]]);
  expect(configuratorIntentPersistenceResponseCoreSchema.parse({ contractVersion: "commerce.configurator_intent_persistence.v1",
    intentVersion: CONFIGURATOR_INTENT_VERSION, idempotencyKey: "intent-key-1", clientId: id, addressId: id, replayed: true,
    clientMatchReason: "client_match_plus_normalized_fallback" }).replayed).toBe(true);
});

it("composes acquisition acceptance and validates checkout activation and payment response paths", () => {
  const expected = createCheckoutQuoteSchemas({ moneySchema: primitives.commerceMoneySchema,
    pricingPolicySchema: z.object({ revision: z.string() }), acquisitionTermsExpectationSchema });
  const terms = { revision: "offer-a.v2", delivery2DiscountBps: 3500 };
  expect(expected.checkoutQuoteAcceptanceSchema.parse({ totalGross: money, acquisitionTerms: terms, promotionAcceptanceToken: "accepted" }))
    .toEqual({ totalGross: money, acquisitionTerms: terms, promotionAcceptanceToken: "accepted" });
  expect(expected.checkoutQuoteExpectationSchema.safeParse({ totalGross: money, acquisitionTerms: { ...terms, delivery2DiscountBps: 10001 } }).success).toBe(false);
  const checkout = createCheckoutResponseSchemas({ quoteSchema: quote, quoteExpectationSchema: expected.checkoutQuoteExpectationSchema,
    clientActionSchema: z.object({ kind: z.literal("none") }).strict(), paymentIntentStatusSchema: z.literal("paid"),
    paymentAttemptStatusSchema: z.literal("paid"), failureDisplaySchema: z.literal("declined") });
  const base = { contractVersion: CHECKOUT_CONTRACT_VERSION, checkoutKind: "one_time", orderRef: "order_a", orderId: id, status: "paid" };
  expect(checkout.checkoutResponseSchema.safeParse(base).success).toBe(true);
  expect(checkout.checkoutResponseSchema.safeParse({ ...base, checkoutKind: "subscription_initial" }).success).toBe(false);
  expect(checkout.checkoutResponseSchema.safeParse({ ...base, subscription: { requested: true, cadenceDays: 21, activationStatus: "activated" } }).success).toBe(false);
  expect(checkout.checkoutResponseSchema.parse({ contractVersion: CHECKOUT_CONTRACT_VERSION, checkoutKind: "one_time", status: "price_changed", priceChanged: true,
    expectedQuote: { totalGross: money, acquisitionTerms: terms }, authoritativeQuote: snapshot })).toMatchObject({ expectedQuote: { acquisitionTerms: terms } });
  const display = checkout.paymentStatusResponseSchema.pick({ failureDisplay: true });
  expect(display.parse({})).not.toHaveProperty("failureDisplay");
  expect(display.parse({ failureDisplay: null })).toEqual({ failureDisplay: null });
  expect(display.safeParse({ failureDisplay: "unknown" }).success).toBe(false);
});

describe("sanitized snapshots", () => {
  const resume = createCheckoutResumeSchemas({ sectionSchema: z.enum(["start", "review"]), redactedFieldSchema: z.enum(["contact", "payment_secret"]),
    completionSchema: checkoutResumeCompletionCoreSchema.default({ productSelection: false, cadence: false, account: false, shipping: false, billing: false, payment: false, review: false }),
    productSlugSchema: z.string().regex(/^[a-z][a-z0-9-]*$/), skuSchema: primitives.commerceSkuSchema,
    additionalForbiddenKeys: ["hostSecret"] });
  it("preserves resume defaults, strict privacy refusals, nested paths and replay", () => {
    const input = { version: CHECKOUT_RESUME_CONTRACT_VERSION };
    const state = resume.checkoutResumeDraftStateSchema.parse(input);
    expect(state).toMatchObject({ mode: null, cadenceDays: null, cart: { items: [] }, redactedFields: [] });
    expectTypeOf(state).toExtend<CheckoutResumeDraftState<typeof state.completion, "contact" | "payment_secret">>();
    for (const patch of [{ email: "buyer@example.test" }, { mode: "one_time", cadenceDays: 21 },
      { cart: { items: [{ sku: "ITEM-A", quantity: 1, providerPayload: {} }] } }]) {
      expect(resume.checkoutResumeDraftStateSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
    const extension = createCheckoutResumeSchemas({ sectionSchema: z.literal("review"), redactedFieldSchema: z.literal("contact"),
      completionSchema: z.object({ hostSecret: z.string() }), productSlugSchema: z.string(), skuSchema: z.string(),
      additionalForbiddenKeys: ["hostSecret"] });
    const extended = extension.checkoutResumeDraftStateSchema.safeParse({ ...input, completion: { hostSecret: "secret" } });
    expect(extended.success).toBe(false);
    if (!extended.success) expect(extended.error.issues.map(issue => issue.path)).toEqual([["completion", "hostSecret"]]);
    expect(resume.checkoutResumeUpsertRequestSchema.parse({ lastSectionId: "review", draftState: input }).ttlMinutes).toBe(120);
    const draft = { id, contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION, lastSectionId: "review", draftState: input,
      expiresAt: new Date(7_200_000).toISOString(), createdAt: new Date(0).toISOString(), updatedAt: new Date(3_600_000).toISOString(), replayed: true };
    const read = resume.checkoutResumeReadResponseSchema.parse({ contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION, draft });
    expect(read.draft.replayed).toBe(true);
    expect(JSON.stringify(read)).not.toContain("resumeToken");
  });
  it("keeps customer defaults descriptive and rejects raw data and host-secret keys", () => {
    const defaults = createCustomerDefaultsSnapshotSchemas({ paymentPreferenceScopeSchema: z.literal("all_orders"), paymentMethodKindSchema: z.literal("saved"), additionalForbiddenKeys: ["hostSecret"] });
    const input = { version: CUSTOMER_DEFAULTS_SNAPSHOT_VERSION, clientId: id,
      payment: { available: false, scope: null, methodKind: null, source: "customer_payment_preferences", applied: false },
      addresses: { hasDefaultShippingAddress: false, defaultShippingAddressId: null, hasDefaultBillingAddress: false,
        defaultBillingAddressId: null, hasDefaultOrdererProfile: false, defaultOrdererProfileId: null, hasDeliveryNotes: false,
        hasCourierInstructions: false, source: "customer_address_profiles", applied: false } };
    const parsed = defaults.commerceCustomerDefaultsSnapshotSchema.parse(input);
    expect(parsed.redactedFields).toEqual([]);
    const extension = createCustomerDefaultsSnapshotSchemas({ paymentPreferenceScopeSchema: z.object({ hostSecret: z.string() }),
      paymentMethodKindSchema: z.literal("saved"), additionalForbiddenKeys: ["hostSecret"] });
    const extended = extension.commerceCustomerDefaultsSnapshotSchema.safeParse({ ...input, payment: { ...input.payment, scope: { hostSecret: "secret" } } });
    expect(extended.success).toBe(false);
    if (!extended.success) expect(extended.error.issues.map(issue => issue.path)).toEqual([["payment", "scope", "hostSecret"]]);
    expectTypeOf(parsed).toEqualTypeOf<CommerceCustomerDefaultsSnapshot<"all_orders", "saved">>();
    for (const patch of [{ email: "buyer@example.test" }, { payment: { ...input.payment, applied: true } },
      { addresses: { ...input.addresses, hostSecret: "secret" } }]) expect(defaults.commerceCustomerDefaultsSnapshotSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
});
