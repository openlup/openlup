import { describe, expect, it } from "vitest";
import { CONFIGURATOR_INTENT_VERSION } from "./configuratorIntentContracts.js";
import {
  CHECKOUT_CONTRACT_VERSION,
  checkoutRequestSchema,
  checkoutResponseSchema,
  paymentStatusResponseSchema,
} from "./checkoutContracts.js";

describe("checkout contracts", () => {
  it("keeps a missing display extension distinct from explicit null", () => {
    const schema = paymentStatusResponseSchema.pick({ failureDisplay: true });
    expect(schema.parse({})).not.toHaveProperty("failureDisplay");
    expect(schema.parse({ failureDisplay: null })).toEqual({ failureDisplay: null });
    expect(schema.parse({ failureDisplay: "provider_declined" })).toEqual({ failureDisplay: "provider_declined" });
    expect(schema.safeParse({ failureDisplay: "an_unknown_native_code" }).success).toBe(false);
  });
  it("accepts one-time and subscription-initial checkout intents", () => {
    const parsed = checkoutRequestSchema.parse({ intent: intent("one_time") });
    expect(parsed.invoicePreference).toEqual({ kind: "b2c_named" });
    expect(checkoutRequestSchema.safeParse({ intent: intent("subscription") }).success).toBe(true);
  });

  it("normalizes B2B checkout invoice preference NIP", () => {
    const parsed = checkoutRequestSchema.parse({
      intent: intent("one_time"),
      invoicePreference: {
        kind: "b2b_vat",
        companyName: "Example Company Sp. z o.o.",
        taxId: "PL 123-456-32-18",
        address: {
          line1: "Krolewska 1",
          city: "Krakow",
          postalCode: "30-001",
          country: "PL",
        },
      },
    });

    expect(parsed.invoicePreference).toMatchObject({
      kind: "b2b_vat",
      taxId: "1234563218",
    });
  });

  it("accepts B2B company names up to the invoice lookup provider limit", () => {
    const companyName = "A".repeat(240);
    const parsed = checkoutRequestSchema.parse({
      intent: intent("one_time"),
      invoicePreference: {
        kind: "b2b_vat",
        companyName,
        taxId: "1234563218",
        address: {
          line1: "Krolewska 1",
          city: "Krakow",
          postalCode: "30-001",
          country: "PL",
        },
      },
    });

    expect(parsed.invoicePreference).toMatchObject({
      kind: "b2b_vat",
      companyName,
    });

    expect(checkoutRequestSchema.safeParse({
      intent: intent("one_time"),
      invoicePreference: {
        kind: "b2b_vat",
        companyName: "A".repeat(241),
        taxId: "1234563218",
        address: {
          line1: "Krolewska 1",
          city: "Krakow",
          postalCode: "30-001",
          country: "PL",
        },
      },
    }).success).toBe(false);
  });

  it("rejects B2B invoice preference without a valid PL NIP or billing address", () => {
    expect(checkoutRequestSchema.safeParse({
      intent: intent("one_time"),
      invoicePreference: {
        kind: "b2b_vat",
        companyName: "Invalid NIP Sp. z o.o.",
        taxId: "123",
        address: {
          line1: "Krolewska 1",
          city: "Krakow",
          postalCode: "30-001",
          country: "PL",
        },
      },
    }).success).toBe(false);

    expect(checkoutRequestSchema.safeParse({
      intent: intent("one_time"),
      invoicePreference: {
        kind: "b2b_vat",
        companyName: "Missing Address Sp. z o.o.",
        taxId: "1234563218",
      },
    }).success).toBe(false);
  });

  it("requires saved payment method intent for subscription checkout", () => {
    const subscription = intent("subscription");

    expect(
      checkoutRequestSchema.safeParse({
        intent: {
          ...subscription,
          paymentMethodIntent: { ...subscription.paymentMethodIntent, saveForSubscription: false },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts transient Tpay BLIK execution outside persisted configurator intent", () => {
    const parsed = checkoutRequestSchema.parse({
      intent: intent("one_time"),
      paymentExecution: {
        provider: "tpay",
        flow: "blik_one_time",
        blikToken: "987654",
      },
    });

    expect(parsed.paymentExecution).toEqual({
      provider: "tpay",
      flow: "blik_one_time",
      blikToken: "987654",
    });
    expect(JSON.stringify(parsed.intent)).not.toContain("987654");
  });

  it("defaults returnContext to public and accepts an explicit account context", () => {
    expect(checkoutRequestSchema.parse({ intent: intent("one_time") }).returnContext).toBe("public");

    expect(
      checkoutRequestSchema.parse({ intent: intent("one_time"), returnContext: "account" }).returnContext,
    ).toBe("account");

    expect(
      checkoutRequestSchema.safeParse({ intent: intent("one_time"), returnContext: "elsewhere" }).success,
    ).toBe(false);
  });

  it("accepts an expected quote total as the checkout drift guard", () => {
    const parsed = checkoutRequestSchema.parse({
      intent: intent("one_time"),
      expectedQuote: { totalGross: { amountMinor: 25460, currency: "PLN" } },
    });

    expect(parsed.expectedQuote).toEqual({
      totalGross: { amountMinor: 25460, currency: "PLN" },
    });
  });

  it("accepts Tpay PBL channel and defaults recurring activation to Model M", () => {
    expect(checkoutRequestSchema.parse({
      intent: intent("one_time"),
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "21" },
    }).paymentExecution).toEqual({ provider: "tpay", flow: "pbl_one_time", channelId: "21" });

    expect(checkoutRequestSchema.parse({
      intent: intent("subscription"),
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_activation",
        blikToken: "654321",
      },
    }).paymentExecution).toEqual({
      provider: "tpay",
      flow: "blik_recurring_activation",
      blikToken: "654321",
      recurringModel: "M",
    });
  });

  it("accepts Tpay saved BLIK PAYID flows without exposing raw PAYID", () => {
    const savedMethodId = "22222222-2222-4222-8222-222222222222";

    expect(checkoutRequestSchema.parse({
      intent: intent("one_time"),
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_click", savedMethodId },
    }).paymentExecution).toEqual({ provider: "tpay", flow: "blik_one_click", savedMethodId });

    expect(checkoutRequestSchema.parse({
      intent: intent("subscription"),
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_recurring_saved", savedMethodId },
    }).paymentExecution).toEqual({
      provider: "tpay",
      flow: "blik_recurring_saved",
      savedMethodId,
      recurringModel: "M",
    });

    expect(JSON.stringify(checkoutRequestSchema.parse({
      intent: intent("one_time"),
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_click", savedMethodId },
    }))).not.toContain("payid_");
  });

  it("keeps Tpay PBL one-time only and recurring activation subscription-only", () => {
    expect(checkoutRequestSchema.safeParse({
      intent: intent("subscription"),
      paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "pbl_one_time", channelId: "21" },
    }).success).toBe(false);

    expect(checkoutRequestSchema.safeParse({
      intent: intent("one_time"),
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_activation",
        blikToken: "654321",
      },
    }).success).toBe(false);

    expect(checkoutRequestSchema.safeParse({
      intent: intent("one_time"),
      paymentProvider: "tpay",
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_saved",
        savedMethodId: "22222222-2222-4222-8222-222222222222",
      },
    }).success).toBe(false);
  });

  it("accepts a Stripe checkout with no paymentExecution", () => {
    const parsed = checkoutRequestSchema.parse({
      intent: intent("one_time"),
      paymentProvider: "stripe",
    });
    expect(parsed.paymentProvider).toBe("stripe");
    expect(parsed.paymentExecution).toBeUndefined();
  });

  it("rejects a Stripe checkout that carries a (mis-routed) paymentExecution", () => {
    expect(
      checkoutRequestSchema.safeParse({
        intent: intent("one_time"),
        paymentProvider: "stripe",
        paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
      }).success,
    ).toBe(false);
  });

  it("validates checkout v2 response metadata for subscription initial checkout", () => {
    const response = {
      contractVersion: CHECKOUT_CONTRACT_VERSION,
      checkoutKind: "subscription_initial",
      orderRef: "order_44444444-4444-4444-8444-444444444444",
      orderId: "44444444-4444-4444-8444-444444444444",
      clientId: "11111111-1111-4111-8111-111111111111",
      status: "paid",
      subscription: {
        requested: true,
        cadenceDays: 21,
        activationStatus: "pending_payment_success",
      },
      payment: { requiresReusablePaymentMethod: true },
    };

    expect(checkoutResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts a price_changed response without order or payment ids", () => {
    const response = {
      contractVersion: CHECKOUT_CONTRACT_VERSION,
      checkoutKind: "subscription_initial",
      status: "price_changed",
      priceChanged: true,
      expectedQuote: { totalGross: { amountMinor: 12730, currency: "PLN" } },
      authoritativeQuote: quoteResponse({ totalGross: { amountMinor: 25460, currency: "PLN" } }),
    };

    expect(checkoutResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects a Stripe provider_embedded action with no clientSecret (the strand shape)", () => {
    const result = checkoutResponseSchema.safeParse({
      ...processingResponseBase(),
      clientAction: { kind: "provider_embedded", provider: "stripe" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a Stripe provider_embedded action that carries a clientSecret", () => {
    const result = checkoutResponseSchema.safeParse({
      ...processingResponseBase(),
      clientAction: { kind: "provider_embedded", provider: "stripe", clientSecret: "pi_secret_1" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a Tpay provider_embedded action carrying only a sessionRef", () => {
    const result = checkoutResponseSchema.safeParse({
      ...processingResponseBase(),
      clientAction: { kind: "provider_embedded", provider: "tpay", sessionRef: "sess_1" },
    });
    expect(result.success).toBe(true);
  });
});

function processingResponseBase() {
  return {
    contractVersion: CHECKOUT_CONTRACT_VERSION,
    checkoutKind: "one_time" as const,
    orderRef: "order_44444444-4444-4444-8444-444444444444",
    orderId: "44444444-4444-4444-8444-444444444444",
    status: "processing" as const,
    paymentIntentId: "55555555-5555-4555-8555-555555555555",
    clientId: "11111111-1111-4111-8111-111111111111",
    subscription: { requested: false, cadenceDays: null, activationStatus: "not_applicable" as const },
    payment: { requiresReusablePaymentMethod: false },
  };
}

function quoteResponse(overrides: Record<string, unknown> = {}) {
  const lineGross = { amountMinor: 25460, currency: "PLN" };
  return {
    contractVersion: "commerce.v0",
    quote: {
      currency: "PLN",
      taxIncluded: true,
      lines: [
        {
          sku: "opaque:lamb-launch.v1",
          productSlug: "lamb",
          quantity: 19,
          unitPriceGross: { amountMinor: 1340, currency: "PLN" },
          lineSubtotalGross: lineGross,
          tax: {
            included: true,
            country: "PL",
            category: "pet_food",
            vatRateBps: 800,
            legalBasis: "PL VAT Annex 3 item 10c",
            netAmount: { amountMinor: 23574, currency: "PLN" },
            vatAmount: { amountMinor: 1886, currency: "PLN" },
            grossAmount: lineGross,
          },
        },
      ],
      discounts: [],
      subtotalGross: lineGross,
      discountTotalGross: { amountMinor: 0, currency: "PLN" },
      totalGross: lineGross,
      netTotal: { amountMinor: 23574, currency: "PLN" },
      taxTotal: { amountMinor: 1886, currency: "PLN" },
      ...overrides,
    },
  };
}

function intent(mode: "one_time" | "subscription") {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "checkout:11111111-1111-4111-8111-111111111111",
    locale: "pl",
    mode,
    cadenceDays: mode === "subscription" ? 21 : null,
    sizeConstraint: { kind: "feeding_days", value: 21, dailyKcalOverride: 328 },
    petProfile: {
      name: "Rex",
      ageBand: "adult",
      breed: "labrador",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: ["chicken"],
      dailyKcalOverride: 328,
    },
    contact: {
      firstName: "Anna",
      lastName: "Kowalska",
      email: "anna@example.com",
      phone: "+48123456789",
    },
    address: { street: "Testowa 12", postalCode: "00-001", city: "Warszawa", country: "PL" },
    selectedDelivery: { kind: "courier", providerRef: null },
    selectedFlavorSlugs: ["lamb"],
    selectedVariants: [
      { variantId: "variant-lamb-400", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 14 },
    ],
    consents: { gdpr: true, marketing: false, terms: true },
    paymentMethodIntent: { method: "card", saveForSubscription: mode === "subscription" },
    consciousAllergenOverride: false,
  };
}
