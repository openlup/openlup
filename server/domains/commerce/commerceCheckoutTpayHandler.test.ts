import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { CONFIGURATOR_INTENT_VERSION } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import {
  createCommerceCheckoutHandler,
  type CommerceCheckoutHandlerDeps,
} from "./commerceCheckoutHandler.js";
import { quoteSnapshot } from "./commerceCheckoutHandler.testFixtures.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const ADDRESS_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_INTENT_ID = "55555555-5555-4555-8555-555555555555";

describe("commerce checkout Tpay execution", () => {
  it("passes Tpay execution through runtime and returns a processing payment-control envelope", async () => {
    const res = createResponse();
    const linkCustomerAccount = vi.fn().mockResolvedValue(undefined);
    const ports = { ...createPorts(), linkCustomerAccount };
    vi.mocked(ports.runtimePort.startRuntime).mockResolvedValue({
      contractVersion: "commerce.v0",
      runtime: {
        orderId: ORDER_ID,
        orderRef: `order_${ORDER_ID}`,
        mode: "one_time",
        clientId: CLIENT_ID,
        petId: PET_ID,
        shippingAddressId: ADDRESS_ID,
        total: { amountMinor: 4990, currency: "PLN" },
        finalizedReplayed: false,
        reservations: [],
        payment: {
          paymentIntentId: PAYMENT_INTENT_ID,
          paymentId: "88888888-8888-4888-8888-888888888888",
          paymentAttemptId: "77777777-7777-4777-8777-777777777777",
          status: "processing",
          attemptStatus: "processing",
          provider: "tpay",
          providerAttemptId: "tpay_sim_55555555-5555-4555-8555-555555555555",
          providerClientSecret: null,
          providerRedirectUrl: null,
          providerNextActionKind: null,
        },
        readiness: {
          omsEligibility: { allowed: false, reason: "order_not_paid" },
          fulfillmentCreate: { allowed: false, reason: "order_not_paid", omsReason: "order_not_paid" },
        },
        nextAction: { kind: "await_hidden_payment_result", provider: "tpay" },
      },
    });

    await createCommerceCheckoutHandler(ports)(
      request(
        "POST",
        {
          intent: { ...intent(), paymentMethodIntent: { method: "blik", saveForSubscription: false } },
          paymentProvider: "tpay",
          paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
        },
        { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "Vitest" },
      ),
      res,
    );

    expect(vi.mocked(ports.runtimePort.startRuntime)).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentProvider: "tpay",
        providerFlow: "blik_one_time",
        paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
        providerPayer: {
          email: "anna@example.com",
          name: "Anna Kowalska",
          ip: "203.0.113.7",
          userAgent: "Vitest",
        },
      }),
    );
    expect(vi.mocked(ports.runtimePort.applyPaymentResult)).not.toHaveBeenCalled();
    expect(linkCustomerAccount).toHaveBeenCalledWith("anna@example.com");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          status: "processing",
          paymentIntentId: PAYMENT_INTENT_ID,
          clientId: CLIENT_ID,
          providerPaymentId: "tpay_sim_55555555-5555-4555-8555-555555555555",
          statusUrl: expect.stringContaining("paymentIntentId=55555555-5555-4555-8555-555555555555"),
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
      startRuntime: vi.fn(),
      applyPaymentResult: vi.fn().mockResolvedValue({ contractVersion: "commerce.v1" }),
    },
    compensationPort: {
      cancelUnstartedPromotionOrder: vi.fn().mockResolvedValue({ cancelled: false }),
      releaseOrderReservations: vi.fn().mockResolvedValue({ releasedCount: 1 }),
      cancelAbandonedOrder: vi.fn().mockResolvedValue({ cancelled: true }),
    },
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    rateLimitMessage: vi.fn().mockReturnValue("rate limited"),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  } as unknown as CommerceCheckoutHandlerDeps;
}

function intent() {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-2026-06-05-rex",
    locale: "pl",
    mode: "one_time",
    cadenceDays: null,
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
    paymentMethodIntent: { method: "card", saveForSubscription: false },
    consciousAllergenOverride: false,
  };
}

function request(method: string, body?: unknown, headers: Record<string, string> = {}): VercelRequest {
  return { method, body, query: {}, headers } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
