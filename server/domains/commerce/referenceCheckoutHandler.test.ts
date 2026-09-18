import { describe, expect, it, vi } from "vitest";

import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";
import { COMMERCE_CURRENCIES } from "../../../src/domains/commerce/types.js";
import { createReferenceCheckoutHandler } from "./referenceCheckoutHandler.js";

const command = {
  version: "commerce.checkout_command.v1" as const,
  idempotencyKey: "reference-checkout-001",
  mode: "one_time" as const,
  lines: [{ sku: "NORTHSTAR-REFILL-001", quantity: 1 }],
  customer: { firstName: "Alex", lastName: "Taylor", email: "alex@example.test", phone: "+12025550123" },
  shippingAddress: { street: "1 Reference Way", postalCode: "10001", city: "New York", country: "US" },
  currency: COMMERCE_CURRENCIES[0],
};

function paymentEffects() {
  return { admitProfile: vi.fn().mockReturnValue(true) };
}

// The shared paid-order service settles the rehearsal attempt inside
// `startCheckout`; the handler only reads that result.
function settlement(replayed: boolean) {
  return {
    contractVersion: "commerce.v1",
    paymentResult: {
      paymentIntentId: "33333333-3333-4333-8333-333333333333",
      paymentAttemptId: "44444444-4444-4444-8444-444444444444",
      paymentId: "55555555-5555-4555-8555-555555555555",
      orderId: "11111111-1111-4111-8111-111111111111",
      status: "succeeded" as const,
      kind: "capture",
      replayed,
    },
  };
}

function response(): HttpResponse {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function request(body: unknown): HttpRequest {
  return { method: "POST", body, headers: {}, query: {} } as unknown as HttpRequest;
}

describe("reference checkout handler", () => {
  it("uses the sole command-runtime entry after rate and risk admission", async () => {
    const startCheckout = vi.fn().mockResolvedValue({
      persistence: { replayed: true },
      settlement: settlement(false),
      runtime: {
        runtime: {
          orderId: "11111111-1111-4111-8111-111111111111",
          clientId: "22222222-2222-4222-8222-222222222222",
          finalizedReplayed: false,
          total: { amountMinor: 1490, currency: COMMERCE_CURRENCIES[0] },
          payment: {
            paymentIntentId: "33333333-3333-4333-8333-333333333333",
            paymentAttemptId: "44444444-4444-4444-8444-444444444444",
            status: "created",
            attemptStatus: "processing",
          },
        },
      },
    });
    const checkRateLimit = vi.fn().mockResolvedValue({ allowed: true });
    const checkRiskBlocklist = vi.fn().mockResolvedValue({ blocked: false });
    const res = response();

    await createReferenceCheckoutHandler({
      startCheckout,
      checkRateLimit,
      checkRiskBlocklist,
      ...paymentEffects(),
    })(request({ command }), res);

    expect(startCheckout).toHaveBeenCalledWith(command);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        replayed: true,
        orderId: "11111111-1111-4111-8111-111111111111",
        paymentStatus: "succeeded",
        paymentAttemptStatus: "succeeded",
      }),
    }));
  });

  it("rejects invalid input and blocks rate/risk admission before runtime", async () => {
    const startCheckout = vi.fn();
    const rateLimited = response();
    await createReferenceCheckoutHandler({
      startCheckout,
      checkRateLimit: vi.fn().mockResolvedValue({ allowed: false }),
      ...paymentEffects(),
    })(request({ command }), rateLimited);
    expect(rateLimited.status).toHaveBeenCalledWith(429);
    expect(startCheckout).not.toHaveBeenCalled();

    const forbidden = response();
    await createReferenceCheckoutHandler({
      startCheckout,
      checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
      checkRiskBlocklist: vi.fn().mockResolvedValue({ blocked: true }),
      ...paymentEffects(),
    })(request({ command }), forbidden);
    expect(forbidden.status).toHaveBeenCalledWith(403);
    expect(startCheckout).not.toHaveBeenCalled();

    const invalid = response();
    await createReferenceCheckoutHandler({
      startCheckout,
      checkRateLimit: vi.fn(),
      ...paymentEffects(),
    })(request({ command: { ...command, unexpected: true } }), invalid);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("rejects commands outside the active profile before rate-limit or runtime writes", async () => {
    const res = response();
    const startCheckout = vi.fn();
    const checkRateLimit = vi.fn();
    await createReferenceCheckoutHandler({
      startCheckout,
      checkRateLimit,
      ...paymentEffects(),
      admitProfile: vi.fn().mockReturnValue(false),
    })(request({ command: { ...command, currency: "AAA", shippingAddress: { ...command.shippingAddress, country: "ZZ" } } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it("maps runtime conflicts without exposing implementation details", async () => {
    const res = response();
    await createReferenceCheckoutHandler({
      startCheckout: vi.fn().mockRejectedValue(new CommerceRuntimeConflictError("Replay conflict")),
      checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
      ...paymentEffects(),
    })(request({ command }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "CONFLICT", message: "Replay conflict" }),
    }));
  });

  it("returns a recoverable refusal as a non-success payment status", async () => {
    const res = response();
    await createReferenceCheckoutHandler({
      startCheckout: vi.fn().mockResolvedValue({
        persistence: { replayed: false },
        settlement: null,
        runtime: {
          runtime: {
            orderId: "11111111-1111-4111-8111-111111111111",
            clientId: "22222222-2222-4222-8222-222222222222",
            finalizedReplayed: false,
            total: { amountMinor: 1490, currency: COMMERCE_CURRENCIES[0] },
            payment: {
              paymentIntentId: "33333333-3333-4333-8333-333333333333",
              paymentAttemptId: "44444444-4444-4444-8444-444444444444",
              status: "failed",
              attemptStatus: "failed",
            },
          },
        },
      }),
      checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
      ...paymentEffects(),
    })(request({ command }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        paymentStatus: "failed",
        paymentAttemptStatus: "failed",
      }),
    }));
  });
});
