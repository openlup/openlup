import { describe, expect, it, vi } from "vitest";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerSubscriptionActionPort } from "./ports.js";
import {
  CustomerSubscriptionActionConflictError,
  createCustomerSubscriptionActionHandler,
} from "./customerSubscriptionActionHandler.js";

// Request/response types are derived from the handler signature instead of the
// platform type module, so this test adds no closed-vocabulary identifiers.
type Handler = ReturnType<typeof createCustomerSubscriptionActionHandler>;
type HandlerRequest = Parameters<Handler>[0];
type HandlerResponse = Parameters<Handler>[1];

const SUBSCRIPTION_ID = "5b000000-0000-0000-0000-000000000001";

describe("customer subscription action handler", () => {
  // The editor tells a minimum-order rejection apart from a generic pricing
  // failure through `details.reason`; the message stays the coarse label.
  it("forwards the conflict error details onto the BFF error envelope", async () => {
    const res = createResponse();
    await createHandler({
      applyAction: vi.fn(async () => {
        throw new CustomerSubscriptionActionConflictError(
          "BAD_REQUEST",
          "subscription_edit_reprice_failed",
          { reason: "subscription_reprice_below_minimum_order_units" },
        );
      }),
    })(request(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "BAD_REQUEST",
          message: "subscription_edit_reprice_failed",
          details: { reason: "subscription_reprice_below_minimum_order_units" },
        }),
      }),
    );
  });

  it("keeps the envelope shape for a conflict error without details", async () => {
    const res = createResponse();
    await createHandler({
      applyAction: vi.fn(async () => {
        throw new CustomerSubscriptionActionConflictError("CONFLICT", "customer_self_service_conflict");
      }),
    })(request(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: "CONFLICT", message: "customer_self_service_conflict" }),
      }),
    );
  });

  it("falls back to UPSTREAM_UNAVAILABLE for an unrecognised failure", async () => {
    const res = createResponse();
    await createHandler({
      applyAction: vi.fn(async () => {
        throw new Error("db down");
      }),
    })(request(), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });
});

function createHandler({
  applyAction,
  auth = { ok: true, userId: "user-1" },
}: {
  applyAction: CustomerSubscriptionActionPort["applyAction"];
  auth?: CustomerUserAuthenticationResult;
}) {
  return createCustomerSubscriptionActionHandler({
    subscriptionActionPort: { applyAction },
    authenticateUser: vi.fn().mockImplementation(async () => auth),
  });
}

function request(method = "POST"): HandlerRequest {
  return {
    method,
    body: {
      action: "slide_next_cycle",
      idempotencyKey: "idem-key-1234567890",
      subscriptionId: SUBSCRIPTION_ID,
      newNextCycleAt: "2026-09-01T00:00:00.000Z",
    },
  } as unknown as HandlerRequest;
}

function createResponse(): HandlerResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as HandlerResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
