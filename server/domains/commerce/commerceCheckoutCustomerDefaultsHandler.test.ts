import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { CONFIGURATOR_INTENT_VERSION } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import {
  CUSTOMER_DEFAULTS_SNAPSHOT_VERSION,
  type CommerceCustomerDefaultsSnapshot,
} from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import {
  createCommerceCheckoutHandler,
  type CommerceCheckoutHandlerDeps,
} from "./commerceCheckoutHandler.js";
import { quoteSnapshot } from "./commerceCheckoutHandler.testFixtures.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const ADDRESS_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";

describe("commerce checkout customer defaults consumption", () => {
  it("attaches hidden defaults evidence to runtime metadata without applying it", async () => {
    const res = createResponse();
    const ports = {
      ...createPorts(),
      customerDefaultsPort: {
        getCustomerDefaultsSnapshot: vi.fn().mockResolvedValue(customerDefaultsSnapshot()),
      },
    };

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(ports.customerDefaultsPort.getCustomerDefaultsSnapshot).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      checkoutKind: "one_time",
    });
    expect(vi.mocked(ports.runtimePort.startRuntime)).toHaveBeenCalledWith(
      expect.objectContaining({
        shippingAddressId: ADDRESS_ID,
        metadata: expect.objectContaining({
          customerDefaults: expect.objectContaining({
            version: CUSTOMER_DEFAULTS_SNAPSHOT_VERSION,
            payment: expect.objectContaining({ methodKind: "card", applied: false }),
            addresses: expect.objectContaining({ applied: false }),
          }),
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("fails closed before order orchestration when defaults read fails", async () => {
    const res = createResponse();
    const ports = {
      ...createPorts(),
      customerDefaultsPort: {
        getCustomerDefaultsSnapshot: vi.fn().mockRejectedValue(new Error("defaults down")),
      },
    };

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(ports.runtimePort.startRuntime)).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "UPSTREAM_UNAVAILABLE",
          details: { feature: "checkout", stage: "customer_defaults" },
        }),
      }),
    );
  });
});

function createPorts(): CommerceCheckoutHandlerDeps {
  return {
    persistencePort: {
      persistIntent: vi.fn().mockResolvedValue({
        contractVersion: "commerce.configurator_intent_persistence.v1",
        intentVersion: CONFIGURATOR_INTENT_VERSION,
        idempotencyKey: "intent-2026-06-05-rex",
        clientId: CLIENT_ID,
        petId: PET_ID,
        addressId: ADDRESS_ID,
        replayed: false,
      }),
    },
    quotePort: { createQuote: vi.fn().mockResolvedValue(quoteSnapshot()) },
    orderDraftPort: {
      createOrderDraft: vi.fn().mockResolvedValue({
        contractVersion: "commerce.v1",
        orderDraft: {
          orderId: `order_${ORDER_ID}`,
          status: "draft",
          paymentStatus: "not_started",
          idempotencyKey: "intent-2026-06-05-rex",
          quoteSnapshot: quoteSnapshot(),
          replayed: false,
        },
      }),
    },
    runtimePort: {
      startRuntime: vi.fn().mockResolvedValue({
        contractVersion: "commerce.v1",
        runtime: { orderId: ORDER_ID, payment: { paymentIntentId: "55555555-5555-4555-8555-555555555555" } },
      }),
      applyPaymentResult: vi.fn().mockResolvedValue({ contractVersion: "commerce.v1" }),
    },
    compensationPort: {
      releaseOrderReservations: vi.fn(),
      cancelUnstartedPromotionOrder: vi.fn(),
      cancelAbandonedOrder: vi.fn(),
    },
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    rateLimitMessage: vi.fn().mockReturnValue("rate limited"),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  } as unknown as CommerceCheckoutHandlerDeps;
}

function customerDefaultsSnapshot(): CommerceCustomerDefaultsSnapshot {
  return {
    version: CUSTOMER_DEFAULTS_SNAPSHOT_VERSION,
    clientId: CLIENT_ID,
    payment: {
      available: true,
      scope: "one_time",
      methodKind: "card",
      source: "customer_payment_preferences",
      applied: false,
    },
    addresses: {
      hasDefaultShippingAddress: true,
      defaultShippingAddressId: "66666666-6666-4666-8666-666666666666",
      hasDefaultBillingAddress: false,
      defaultBillingAddressId: null,
      hasDefaultOrdererProfile: true,
      defaultOrdererProfileId: "77777777-7777-4777-8777-777777777777",
      hasDeliveryNotes: true,
      hasCourierInstructions: false,
      source: "customer_address_profiles",
      applied: false,
    },
    redactedFields: ["contact", "shipping_address", "delivery_notes"],
  };
}

function intent() {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-2026-06-05-rex",
    locale: "pl",
    mode: "one_time",
    cadenceDays: null,
    sizeConstraint: { kind: "unit_count", value: 14 },
    petProfile: {
      name: "Rex",
      ageBand: "adult",
      breed: "mixed",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: [],
      dailyKcalOverride: null,
    },
    contact: { firstName: "Anna", lastName: "Nowak", email: "anna@example.com", phone: "+48123456789" },
    address: { street: "Testowa 12", postalCode: "00-001", city: "Warszawa", country: "PL" },
    selectedDelivery: { kind: "courier", providerRef: null },
    selectedFlavorSlugs: ["lamb"],
    selectedVariants: [{ variantId: "variant-lamb", sku: "OPENLUP-DOG-LAMB-CAN-400G", flavorSlug: "lamb", qty: 14 }],
    consents: { gdpr: true, marketing: false, terms: true },
    paymentMethodIntent: { method: "card", saveForSubscription: false },
    consciousAllergenOverride: false,
  };
}

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {}, headers: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
