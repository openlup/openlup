import { expect, it } from "vitest";
import { PAYMENT_EXECUTION_PROVIDERS } from "../payment/types.js";
import { PLATFORM_ACCEPTED_CURRENCIES } from "../../lib/currency/platformCurrency.js";
import * as contracts from "./contracts.js";
import * as checkout from "./checkoutContracts.js";
import * as resume from "./checkoutResumeContracts.js";
import * as intent from "./configuratorIntentContracts.js";
import * as persistence from "./configuratorIntentPersistenceContracts.js";
import * as primitives from "./contractPrimitives.js";
import * as defaults from "./customerDefaultsSnapshotContracts.js";

// Golden results captured against 2cfedd7a before extraction: success, parsed
// output, and complete issues (including nested paths). Intentional D1-D9
// additions have separate witnesses; these inputs exercise the legacy surface.
const hostCountry = checkout.invoiceBuyerSnapshotAddressSchema.shape.country.value;
const [, , embeddedProvider, interactiveProvider] = PAYMENT_EXECUTION_PROVIDERS;
const id = "11111111-1111-4111-8111-111111111111";
const profile = { name: "Example", ageBand: "adult", breed: "mixed", weightKg: 10,
  activityLevel: "normal", bcs: "ideal", allergenSlugs: [], dailyKcalOverride: null };
const baseIntent = { version: intent.CONFIGURATOR_INTENT_VERSION, idempotencyKey: "example-intent-1",
  mode: "one_time", sizeConstraint: { kind: "unit_count", value: 14 }, petProfile: profile,
  contact: { firstName: " Buyer ", lastName: "Example", email: "buyer@example.test", phone: "123456789" },
  address: { street: "Example 1", postalCode: "00000", city: "Example", country: hostCountry },
  selectedDelivery: { kind: "courier" }, selectedFlavorSlugs: ["item-a"],
  selectedVariants: [{ variantId: "variant-a", sku: "ITEM-A", flavorSlug: "item-a", qty: 14 }],
  consents: { gdpr: true, terms: true }, paymentMethodIntent: { method: "card" } };
const draftState = { version: resume.CHECKOUT_RESUME_CONTRACT_VERSION, completion: {} };
const snapshot = { version: defaults.CUSTOMER_DEFAULTS_SNAPSHOT_VERSION, clientId: id,
  payment: { available: false, scope: null, methodKind: null, source: "customer_payment_preferences", applied: false },
  addresses: { hasDefaultShippingAddress: false, defaultShippingAddressId: null,
    hasDefaultBillingAddress: false, defaultBillingAddressId: null,
    hasDefaultOrdererProfile: false, defaultOrdererProfileId: null, hasDeliveryNotes: false,
    hasCourierInstructions: false, source: "customer_address_profiles", applied: false } };
const cases: Array<[string, { safeParse(value: unknown): unknown }, unknown]> = [
  ["cart", contracts.createCartRequestSchema, { lines: [{ sku: " ITEM-A ", quantity: 1 }], locale: "en", extra: true }],
  ["cart locale refusal", contracts.createCartRequestSchema, { lines: [{ sku: "ITEM-A", quantity: 1 }], locale: "xx" }],
  ["cart bounds", contracts.createCartRequestSchema, { lines: [{ sku: "", quantity: 0 }] }],
  ["checkout placeholder", contracts.createCheckoutResponseSchema, { contractVersion: "commerce.v0", checkout: { id: "checkout_a", cartId: "cart_a", status: "not_configured", redirectUrl: null, paymentProviderSessionId: null } }],
  ["checkout redirect mismatch", contracts.createCheckoutResponseSchema, { contractVersion: "commerce.v0", checkout: { id: "checkout_a", cartId: "cart_a", status: "created", redirectUrl: null, paymentProviderSessionId: null } }],
  ["intent defaults", intent.configuratorIntentSchema, baseIntent],
  ...Object.entries({ locale: "xx", mode: "other", cadenceDays: 0, petProfile: { ...profile, weightKg: -1 },
    sizeConstraint: { kind: "feeding_days", value: 21 }, address: { ...baseIntent.address, country: "AA" },
    selectedDelivery: { kind: "parcel-locker", pickupPoint: { id: "point-a" } },
    selectedFlavorSlugs: ["item-b"], selectedVariants: [{ ...baseIntent.selectedVariants[0], qty: 13 }],
    extra: true }).map(([key, value]): [string, typeof intent.configuratorIntentSchema, unknown] => [
      `intent ${key} refusal`, intent.configuratorIntentSchema, { ...baseIntent, [key]: value }]),
  ["subscription missing cadence", intent.configuratorIntentSchema, { ...baseIntent, mode: "subscription" }],
  ["fixed cadence refusal", intent.configuratorIntentSchema, { ...baseIntent, cadencePolicyVersion: intent.CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION, cadenceDays: 20 }],
  ["legacy cadence", intent.configuratorIntentSchema, { ...baseIntent, cadenceDays: 20 }],
  ["checkout defaults", checkout.checkoutRequestSchema, { intent: baseIntent }],
  ["checkout subscription refusal", checkout.checkoutRequestSchema, { intent: { ...baseIntent, mode: "subscription", cadenceDays: 21 } }],
  ["checkout provider refusal", checkout.checkoutRequestSchema, { intent: baseIntent, paymentProvider: interactiveProvider }],
  ["checkout strict refusal", checkout.checkoutRequestSchema, { intent: baseIntent, extra: true }],
  ["invoice address defaults", checkout.invoiceBuyerSnapshotAddressSchema, { line1: " Example 1 ", city: "Example", postalCode: "00000", country: hostCountry, source: "example" }],
  ["invoice country refusal", checkout.invoiceBuyerSnapshotAddressSchema, { line1: "Example 1", city: "Example", postalCode: "00000", country: "AA", source: "example" }],
  ["invoice tax refusal", checkout.checkoutInvoicePreferenceSchema, { kind: "b2b_vat", companyName: "Example", taxId: "123", address: { line1: "Example 1", city: "Example", postalCode: "00000", country: hostCountry } }],
  ["action none", checkout.checkoutClientActionSchema, { kind: "none" }],
  ["action secret refusal", checkout.checkoutClientActionSchema, { kind: "provider_embedded", provider: embeddedProvider }],
  ["action redirect refusal", checkout.checkoutClientActionSchema, { kind: "redirect", url: "invalid" }],
  ["resume defaults", resume.checkoutResumeDraftStateSchema, draftState],
  ["resume cadence refusal", resume.checkoutResumeDraftStateSchema, { ...draftState, cadenceDays: 21 }],
  ["resume raw refusal", resume.checkoutResumeDraftStateSchema, { ...draftState, email: "buyer@example.test" }],
  ["resume nested refusal", resume.checkoutResumeDraftStateSchema, { ...draftState, cart: { items: [{ sku: "ITEM-A", quantity: 1, providerPayload: {} }] } }],
  ["resume request defaults", resume.checkoutResumeUpsertRequestSchema, { lastSectionId: "pet_profile", draftState }],
  ["resume section refusal", resume.checkoutResumeUpsertRequestSchema, { lastSectionId: "unknown", draftState }],
  ["persistence", persistence.configuratorIntentPersistenceResponseSchema, { contractVersion: persistence.CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION, intentVersion: intent.CONFIGURATOR_INTENT_VERSION, idempotencyKey: "example-intent-1", clientId: id, petId: id, addressId: id, replayed: true }],
  ["persistence missing", persistence.configuratorIntentPersistenceResponseSchema, {}],
  ["defaults", defaults.commerceCustomerDefaultsSnapshotSchema, snapshot],
  ["defaults raw refusal", defaults.commerceCustomerDefaultsSnapshotSchema, { ...snapshot, email: "buyer@example.test" }],
  ["defaults nested refusal", defaults.commerceCustomerDefaultsSnapshotSchema, { ...snapshot, payment: { ...snapshot.payment, providerPayload: {} } }],
  ["key normalized", primitives.commerceIdempotencyKeySchema, " example-key:1 "],
  ["key refusal", primitives.commerceIdempotencyKeySchema, "bad/key"],
  ["size defaults", primitives.commerceSizeConstraintSchema, { kind: "unit_count", value: 1 }],
  ["size strict refusal", primitives.commerceSizeConstraintSchema, { kind: "unit_count", value: 1, extra: true }],
];

it.each(cases)("preserves pre-extraction parse results: %s", (_name, schema, input) => {
  const result = schema.safeParse(input) as { success: boolean; data?: unknown; error?: { issues: unknown[] } };
  expect(projectHostVocabulary(result.success ? { success: true, data: result.data } : { success: false, issues: result.error?.issues })).toMatchSnapshot();
});

it("admits donor offer asks and acquisition expectations without treating them as server admission", async () => {
  const parsed = intent.configuratorIntentSchema.parse({ ...baseIntent, minimumUnits: 2, offerVersion: "offer-a.v2",
    acquisitionCapability: "subscription-acquisition.v1", selectedVariants: [{ ...baseIntent.selectedVariants[0], qty: 2 }] });
  expect(parsed.minimumUnits).toBe(2);
  expect(intent.configuratorIntentSchema.safeParse({ ...baseIntent, minimumUnits: 0 }).success).toBe(false);
  const { buildQuoteRequest } = await import("../../../server/domains/commerce/commerceCheckoutOrchestrationHelpers.js");
  expect(buildQuoteRequest(parsed, { petId: null }).acquisitionCapability).toBe("subscription-acquisition.v1");
  const expectedQuote = { totalGross: { amountMinor: 120, currency: PLATFORM_ACCEPTED_CURRENCIES[0] },
    acquisitionTerms: { revision: "offer-a.v2", delivery2DiscountBps: 3500 } };
  expect(checkout.checkoutRequestSchema.parse({ intent: baseIntent, expectedQuote }).expectedQuote).toEqual(expectedQuote);
  expect(checkout.checkoutRequestSchema.safeParse({ intent: baseIntent, expectedQuote: { ...expectedQuote,
    acquisitionTerms: { revision: "offer-a.v2", delivery2DiscountBps: 10001 } } }).success).toBe(false);
});

// The captured transcript uses symbolic host values rather than publishing
// country/provider literals. Only vocabulary from the existing reference
// constants is projected; outputs, refusals, issue paths and other text remain.
function projectHostVocabulary(value: unknown): unknown {
  if (typeof value === "string") return value.split(hostCountry).join("<host-country>")
    .replace(new RegExp(embeddedProvider, "gi"), "<embedded-provider>")
    .replace(new RegExp(interactiveProvider, "gi"), "<interactive-provider>");
  if (Array.isArray(value)) return value.map(projectHostVocabulary);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, nested]) => [key, projectHostVocabulary(nested)]));
  return value;
}
