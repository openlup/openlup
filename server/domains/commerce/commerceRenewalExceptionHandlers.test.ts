import { describe, expect, it, vi } from "vitest";
import { createAdminCommerceRenewalExceptionsHandler } from "./commerceRenewalExceptionHandlers.js";
import { authorize, request, response } from "./commerceOmsHandlersTestKit.js";

describe("admin commerce renewal exception handler", () => {
  it("returns a sanitized read-only exception projection", async () => {
    const res = response();
    const renewalExceptionPort = { collectEvidence: vi.fn().mockResolvedValue(snapshot()) };

    await createAdminCommerceRenewalExceptionsHandler({
      authorizeAdmin: authorize(),
      renewalExceptionPort,
      now: () => new Date("2026-07-03T12:00:00.000Z"),
    })(request("POST", { page: 1, pageSize: 25 }), res);

    // The parsed window reaches the port, which is the only consumer that can
    // act on it; the projection downstream takes paging alone.
    expect(renewalExceptionPort.collectEvidence).toHaveBeenCalledWith(
      new Date("2026-07-03T12:00:00.000Z"),
      { windowDays: 90 },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.json).mock.calls[0][0] as { data: unknown };
    expect(body.data).toMatchObject({
      totalCount: 1,
      exceptions: [{ kind: "prepared_without_provider_ack", operatorNextAction: "inspect_provider_before_retry" }],
    });
    expect(JSON.stringify(body.data)).not.toContain("providerPaymentId");
    expect(JSON.stringify(body.data)).not.toContain("applyResult");
  });

  it("rejects non-admin callers before collecting evidence", async () => {
    const res = response();
    const renewalExceptionPort = { collectEvidence: vi.fn() };

    await createAdminCommerceRenewalExceptionsHandler({
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
      renewalExceptionPort,
    })(request("POST", { page: 1 }), res);

    expect(renewalExceptionPort.collectEvidence).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects invalid requests and methods before collecting evidence", async () => {
    const renewalExceptionPort = { collectEvidence: vi.fn() };
    const handler = createAdminCommerceRenewalExceptionsHandler({
      authorizeAdmin: authorize(),
      renewalExceptionPort,
    });

    const badRequest = response();
    await handler(request("POST", { pageSize: 1000 }), badRequest);
    expect(badRequest.status).toHaveBeenCalledWith(400);

    const badMethod = response();
    await handler(request("GET", undefined, { page: "1" }), badMethod);
    expect(badMethod.status).toHaveBeenCalledWith(405);
    expect(renewalExceptionPort.collectEvidence).not.toHaveBeenCalled();
  });

  it("maps evidence-port failures to an upstream unavailable envelope", async () => {
    const res = response();
    await createAdminCommerceRenewalExceptionsHandler({
      authorizeAdmin: authorize(),
      renewalExceptionPort: { collectEvidence: vi.fn().mockRejectedValue(new Error("db down")) },
    })(request("POST", { page: 1 }), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });
});

function snapshot() {
  return {
    checkedAt: "2026-07-03T12:00:00.000Z",
    dueCycleWithoutOrderCount: 0,
    dueCycleEvidence: [],
    paymentEvidence: [{
      kind: "prepared_without_provider_ack" as const,
      provider: "stripe",
      paymentIntentId: "intent-1",
      paymentAttemptId: "attempt-1",
      subscriptionId: "sub-1",
      subscriptionCycleId: "cycle-1",
      orderId: null,
      observedAt: "2026-07-03T12:00:00.000Z",
      ageSeconds: 2000,
    }],
    fulfillmentEvidence: [],
  };
}
