import { describe, expect, it } from "vitest";
import {
  CONFIGURATOR_INTENT_VERSION,
  configuratorIntentSchema,
  type ConfiguratorIntent,
} from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type {
  CheckoutInvoicePreference,
  CheckoutKind,
} from "../../../src/domains/commerce/checkoutContracts.js";
import { buildQuoteRequest, runtimeMetadata } from "./commerceCheckoutOrchestrationHelpers.js";
import { createSupabaseOrderFulfillmentProviderKindReader } from "../../adapters/supabase/fulfillmentCompositionPorts.js";

const consumerInvoice: CheckoutInvoicePreference = { kind: "b2c_named" };

// Build a schema-valid intent so the canonical selectedDelivery shape (incl. the
// deliveryKind transform + the omnipack carrierCode/serviceCode superRefine) is
// exactly what production produces — not a hand-rolled object that could drift.
function makeIntent(overrides: Record<string, unknown> = {}): ConfiguratorIntent {
  return configuratorIntentSchema.parse({
    version: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-keystone-1",
    locale: "pl",
    mode: "one_time",
    sizeConstraint: { kind: "feeding_days", value: 21, dailyKcalOverride: 328 },
    petProfile: {
      name: "Maks",
      ageBand: "adult",
      breed: "labrador",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: ["chicken"],
      dailyKcalOverride: 328,
    },
    contact: { firstName: "Anna", lastName: "Kowalska", email: "anna@example.com", phone: "+48123456789" },
    address: { street: "Testowa 12", postalCode: "00-001", city: "Warszawa", country: "PL" },
    selectedDelivery: { kind: "courier", providerRef: null },
    selectedFlavorSlugs: ["lamb"],
    selectedVariants: [{ variantId: "variant-lamb-400", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 14 }],
    consents: { gdpr: true, marketing: false, terms: true },
    paymentMethodIntent: { method: "card", saveForSubscription: false },
    consciousAllergenOverride: false,
    ...overrides,
  });
}

const dpdOmnipack = {
  kind: "courier" as const,
  providerKind: "omnipack" as const,
  carrierKind: "dpd",
  carrierCode: "DPD",
  service: "DPD Courier",
  serviceCode: "DPD_COURIER_STANDARD",
  providerRef: null,
};

const inpostOmnipack = {
  kind: "parcel-locker" as const,
  providerKind: "omnipack" as const,
  carrierKind: "inpost",
  carrierCode: "INPOST",
  service: "InPost Paczkomat",
  serviceCode: "INPOST_LOCKER_STANDARD",
  providerRef: null,
  pickupPoint: {
    id: "WAW01A",
    provider: "inpost",
    name: "Paczkomat WAW01A",
    address: { line1: "Testowa 1", postalCode: "00-001", city: "Warszawa", country: "PL" },
  },
};

// Mirrors how the SQL finalize nests runtimeMetadata() output under
// commerce_orders.metadata.runtimeFinalize (see *_checkout_invoice_buyer_snapshot.sql),
// then feeds it to the actual routing reader. This is the keystone end-to-end at unit
// level: producer (runtimeMetadata) -> persistence shape -> consumer (routing).
function readerFor(metadata: Record<string, unknown>) {
  return createSupabaseOrderFulfillmentProviderKindReader({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { metadata }, error: null }) }),
      }),
    }),
  });
}

describe("runtimeMetadata — selectedDelivery persistence (KEYSTONE)", () => {
  it("persists the canonical omnipack courier selection for a one-time checkout", () => {
    const intent = makeIntent({ selectedDelivery: dpdOmnipack });
    const metadata = runtimeMetadata(intent, "one_time", consumerInvoice);
    expect(metadata.selectedDelivery).toEqual(intent.selectedDelivery);
    expect((metadata.selectedDelivery as Record<string, unknown>).providerKind).toBe("omnipack");
    // canonical shape carries the routing/dispatch inputs
    expect(metadata.selectedDelivery).toMatchObject({
      providerKind: "omnipack",
      carrierCode: "DPD",
      serviceCode: "DPD_COURIER_STANDARD",
      deliveryKind: "courier",
    });
    expect(metadata.deliveryContact).toEqual({
      schemaVersion: 1,
      source: "checkout_submission",
      revision: 1,
      recipientName: `${intent.contact.firstName} ${intent.contact.lastName}`,
      contactEmail: intent.contact.email,
      contactPhone: intent.contact.phone,
      line1: intent.address.street,
      line2: null,
      city: intent.address.city,
      postalCode: intent.address.postalCode,
      country: intent.address.country,
      selectedDelivery: intent.selectedDelivery,
      deliveryInstructions: null,
      courierInstructions: null,
    });
  });

  it("persists the omnipack InPost locker selection (incl. pickupPoint) for subscription_initial", () => {
    const intent = makeIntent({
      mode: "subscription",
      cadenceDays: 30,
      paymentMethodIntent: { method: "card", saveForSubscription: true },
      selectedDelivery: inpostOmnipack,
    });
    const metadata = runtimeMetadata(intent, "subscription_initial", consumerInvoice);
    expect(metadata.selectedDelivery).toEqual(intent.selectedDelivery);
    expect((metadata.selectedDelivery as Record<string, unknown>).pickupPoint).toMatchObject({ id: "WAW01A" });
  });

  it("KEYSTONE: runtimeMetadata output, nested under runtimeFinalize, routes a real order to omnipack", async () => {
    const intent = makeIntent({ selectedDelivery: dpdOmnipack });
    const runtime = runtimeMetadata(intent, "one_time", consumerInvoice);
    // The exact shape the SQL finalize writes to commerce_orders.metadata.
    const orderMetadata = { runtimeFinalize: { ...runtime, source: "commerce.runtime.hidden.v0" } };
    const providerKind = await readerFor(orderMetadata).readSelectedProviderKind("order-1");
    // This assertion FAILS if runtimeMetadata stops persisting selectedDelivery —
    // i.e. it is the regression guard for the keystone bug (real order -> simulator fallback).
    expect(providerKind).toBe("omnipack");
  });

  it("does NOT route to omnipack when the customer chose a non-omnipack (simulator) delivery", async () => {
    const intent = makeIntent(); // base selectedDelivery: courier, no providerKind
    const runtime = runtimeMetadata(intent, "one_time", consumerInvoice);
    const orderMetadata = { runtimeFinalize: runtime };
    expect(await readerFor(orderMetadata).readSelectedProviderKind("order-1")).toBeNull();
  });
});

describe("buildQuoteRequest — nullable subject compatibility", () => {
  it("does not synthesize a subject when the shared checkout chain has none", () => {
    const intent = makeIntent({ mode: "subscription", cadenceDays: 21 });
    const request = buildQuoteRequest(intent, { petId: null });

    expect(request.mode).toBe("subscription");
    expect(request.cadenceDays).toBe(21);
    expect(request.petId).toBeUndefined();
    expect(request.petProfileContext).toBeUndefined();
  });
});
