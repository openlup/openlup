import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CustomerSubscriptionPreviewResponse } from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerSubscriptionPreviewPort } from "./ports.js";
import { createCustomerSubscriptionPreviewHandler } from "./customerSubscriptionPreviewHandler.js";
import { CustomerSubscriptionActionConflictError } from "./customerSubscriptionActionHandler.js";

const SUBSCRIPTION_ID = "5b000000-0000-0000-0000-000000000001";

const PREVIEW: CustomerSubscriptionPreviewResponse = {
  preview: {
    subscriptionId: SUBSCRIPTION_ID,
    action: "slide_next_cycle",
    canApply: true,
    blockedReason: null,
    nextCycleAt: "2026-09-01T00:00:00.000Z",
    editCutoffAt: "2026-08-31T00:00:00.000Z",
    templateVersion: 4,
  },
};

describe("customer subscription preview handler", () => {
  it("returns the preview through the shared BFF envelope", async () => {
    const res = createResponse();
    await createHandler({ previewAction: vi.fn(async () => PREVIEW) })(request(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: PREVIEW });
  });

  it("returns FORBIDDEN when the session has no linked subscription", async () => {
    const res = createResponse();
    await createHandler({ previewAction: vi.fn(async () => null) })(request(), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // Regression for OBS-2/CJ01-S: a repricer failure on an unservable edit (e.g. a
  // subscription whose size_constraint carries no dailyKcalOverride) is the
  // customer's edit being rejected, not an infra outage — it must surface as the
  // same client-actionable 4xx the apply path already gives, not a blind 503.
  it("maps a CustomerSubscriptionActionConflictError from the port to its own BFF error code", async () => {
    const res = createResponse();
    await createHandler({
      previewAction: vi.fn(async () => {
        throw new CustomerSubscriptionActionConflictError("BAD_REQUEST", "subscription_edit_reprice_failed");
      }),
    })(request(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "BAD_REQUEST", message: "subscription_edit_reprice_failed" }),
      }),
    );
  });

  // The editor tells a minimum-order rejection apart from a generic pricing
  // failure through `details.reason`; the message stays the coarse label.
  it("forwards the conflict error details onto the BFF error envelope", async () => {
    const res = createResponse();
    await createHandler({
      previewAction: vi.fn(async () => {
        throw new CustomerSubscriptionActionConflictError(
          "BAD_REQUEST",
          "subscription_edit_reprice_failed",
          { reason: "subscription_reprice_below_minimum_order_units" },
        );
      }),
    })(request(), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "subscription_edit_reprice_failed",
          details: { reason: "subscription_reprice_below_minimum_order_units" },
        }),
      }),
    );
  });

  it("falls back to UPSTREAM_UNAVAILABLE for an unrecognised failure", async () => {
    const res = createResponse();
    await createHandler({
      previewAction: vi.fn(async () => {
        throw new Error("db down");
      }),
    })(request(), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("rejects unsupported methods and missing sessions", async () => {
    const method = createResponse();
    await createHandler({ previewAction: vi.fn(async () => PREVIEW) })(request("GET"), method);

    const unauthorized = createResponse();
    await createHandler({
      previewAction: vi.fn(async () => PREVIEW),
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request(), unauthorized);

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
  });
});

function createHandler({
  previewAction,
  auth = { ok: true, userId: "user-1" },
}: {
  previewAction: CustomerSubscriptionPreviewPort["previewAction"];
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerSubscriptionPreviewHandler({
    subscriptionPreviewPort: { previewAction },
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method = "POST"): VercelRequest {
  return {
    method,
    body: {
      subscriptionAction: {
        action: "slide_next_cycle",
        idempotencyKey: "idem-key-1234567890",
        subscriptionId: SUBSCRIPTION_ID,
        newNextCycleAt: "2026-09-01T00:00:00.000Z",
      },
    },
  } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
