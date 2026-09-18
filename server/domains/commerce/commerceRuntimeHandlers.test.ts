import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  createApplyHiddenCheckoutPaymentResultHandler,
  createStartHiddenCheckoutRuntimeHandler,
} from "./commerceRuntimeHandlers.js";

describe("hidden commerce runtime handlers", () => {
  it("keeps runtime start disabled by default", async () => {
    const runtimePort = { startRuntime: vi.fn(), applyPaymentResult: vi.fn() };
    const res = response();

    await createStartHiddenCheckoutRuntimeHandler({
      runtimePort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => false,
    })(request("POST", startRequest()), res);

    expect(runtimePort.startRuntime).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects subscription checkout without pet context before touching runtime", async () => {
    const runtimePort = { startRuntime: vi.fn(), applyPaymentResult: vi.fn() };
    const res = response();

    await createStartHiddenCheckoutRuntimeHandler({
      runtimePort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
    })(request("POST", { ...startRequest(), mode: "subscription_cycle", petId: undefined }), res);

    expect(runtimePort.startRuntime).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("does not let a caller-supplied neutral command marker bypass the pet barrier", async () => {
    // `commerce.checkout_command.v1` is the discriminator the finalize RPC uses
    // to permit a pet-less subscription. It is legitimate only when the neutral
    // executor stamps it server-side; on this admin route it is request body,
    // i.e. attacker-controlled, and must not unlock anything.
    const runtimePort = { startRuntime: vi.fn(), applyPaymentResult: vi.fn() };
    const res = response();

    await createStartHiddenCheckoutRuntimeHandler({
      runtimePort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
    })(request("POST", {
      ...startRequest(),
      mode: "subscription_cycle",
      petId: undefined,
      metadata: { checkoutCommandVersion: "commerce.checkout_command.v1" },
    }), res);

    expect(runtimePort.startRuntime).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns enabled runtime start through the shared envelope", async () => {
    const result = startResponse();
    const runtimePort = { startRuntime: vi.fn().mockResolvedValue(result), applyPaymentResult: vi.fn() };
    const res = response();

    await createStartHiddenCheckoutRuntimeHandler({
      runtimePort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
    })(request("POST", startRequest()), res);

    expect(runtimePort.startRuntime).toHaveBeenCalledWith(expect.objectContaining({ mode: "one_time" }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: result });
  });

  it("maps runtime conflicts to BFF conflict", async () => {
    const runtimePort = {
      startRuntime: vi.fn().mockRejectedValue(new CommerceRuntimeConflictError("Pet not owned")),
      applyPaymentResult: vi.fn(),
    };
    const res = response();

    await createStartHiddenCheckoutRuntimeHandler({
      runtimePort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
    })(request("POST", startRequest()), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("keeps payment-result mutation disabled by default", async () => {
    const runtimePort = { startRuntime: vi.fn(), applyPaymentResult: vi.fn() };
    const res = response();

    await createApplyHiddenCheckoutPaymentResultHandler({
      runtimePort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => false,
    })(request("POST", paymentResultRequest()), res);

    expect(runtimePort.applyPaymentResult).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {}, headers: {} } as VercelRequest;
}

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function authorize() {
  return vi.fn().mockResolvedValue({ ok: true, userId: "admin-user-1" });
}

function startRequest() {
  return {
    idempotencyKey: "runtime-start-1",
    orderDraft: orderDraft(),
    mode: "one_time",
    clientId: "41111111-1111-4111-8111-111111111111",
    shippingAddressId: "45555555-5555-4555-8555-555555555555",
  };
}

function paymentResultRequest() {
  return {
    idempotencyKey: "runtime-payment-1",
    orderId: "42222222-2222-4222-8222-222222222221",
    paymentIntentId: "49999999-9999-4999-8999-999999999991",
    resultStatus: "succeeded",
    occurredAt: "2026-06-05T12:00:00+00:00",
  };
}

function startResponse() {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    runtime: {
      orderId: "42222222-2222-4222-8222-222222222221",
      orderRef: "order_42222222-2222-4222-8222-222222222221",
      mode: "one_time",
      clientId: "41111111-1111-4111-8111-111111111111",
      petId: null,
      shippingAddressId: "45555555-5555-4555-8555-555555555555",
      total: { amountMinor: 1490, currency: "PLN" },
      finalizedReplayed: false,
      reservations: [
        {
          reservationId: "46666666-6666-4666-8666-666666666661",
          reservationIds: ["46666666-6666-4666-8666-666666666661"],
          orderItemId: "47777777-7777-4777-8777-777777777771",
          skuId: "48888888-8888-4888-8888-888888888881",
          sku: "OPENLUP-BEEF-ADULT-CAN-400G",
          status: "reserved",
          replayed: false,
        },
      ],
      payment: {
        paymentIntentId: "49999999-9999-4999-8999-999999999991",
        paymentId: "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        paymentAttemptId: "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        status: "created",
        attemptStatus: "processing",
        provider: "hidden_rehearsal",
      },
      readiness: {
        omsEligibility: { allowed: false, reason: "order_not_paid" },
        fulfillmentCreate: { allowed: false, reason: "oms_blocked", omsReason: "order_not_paid" },
      },
      nextAction: { kind: "await_hidden_payment_result", provider: "hidden_rehearsal" },
    },
  };
}

function orderDraft() {
  return {
    orderId: "order_42222222-2222-4222-8222-222222222221",
    status: "draft",
    paymentStatus: "not_started",
    idempotencyKey: "order-draft-1",
    quoteSnapshot: {
      contractVersion: COMMERCE_CONTRACT_VERSION,
      quote: {
        currency: "PLN",
        taxIncluded: true,
        lines: [
          {
            sku: "OPENLUP-BEEF-ADULT-CAN-400G",
            productSlug: "beef",
            quantity: 1,
            unitPriceGross: { amountMinor: 1490, currency: "PLN" },
            lineSubtotalGross: { amountMinor: 1490, currency: "PLN" },
            tax: {
              included: true,
              country: "PL",
              category: "pet_food",
              vatRateBps: 800,
              legalBasis: "PL VAT Annex 3 item 10c",
              netAmount: { amountMinor: 1380, currency: "PLN" },
              vatAmount: { amountMinor: 110, currency: "PLN" },
              grossAmount: { amountMinor: 1490, currency: "PLN" },
            },
          },
        ],
        discounts: [],
        subtotalGross: { amountMinor: 1490, currency: "PLN" },
        discountTotalGross: { amountMinor: 0, currency: "PLN" },
        totalGross: { amountMinor: 1490, currency: "PLN" },
        netTotal: { amountMinor: 1380, currency: "PLN" },
        taxTotal: { amountMinor: 110, currency: "PLN" },
      },
    },
    replayed: false,
  };
}
