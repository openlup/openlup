import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createCommerceCustomerEligibilityHandler,
  type CommerceCustomerEligibilityHandlerDeps,
} from "./commerceCustomerEligibilityHandler.js";

describe("commerce customer-eligibility BFF handler", () => {
  it("recognizes an existing customer with prior paid orders as not first-order eligible", async () => {
    const res = createResponse();
    const countPaidOrdersByMode = vi
      .fn()
      .mockResolvedValue({ oneTime: 1, subscription: 0 });

    await createCommerceCustomerEligibilityHandler({
      resolveCustomerEligibility: async () => ({
        clientId: "client-1",
        source: "resolved_client",
        matchKind: "exact",
      }),
      countPaidOrdersByMode,
    })(request("POST", { email: "anna@example.com" }), res);

    expect(countPaidOrdersByMode).toHaveBeenCalledWith("client-1");
    expect(countPaidOrdersByMode).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: {
          contractVersion: "customer_eligibility.lookup.v1",
          recognized: true,
          firstOrderEligible: false,
        },
      }),
    );
  });

  it("does not recognize an exact-email lead with zero paid orders and keeps it first-order eligible", async () => {
    const res = createResponse();
    const countPaidOrdersByMode = vi
      .fn()
      .mockResolvedValue({ oneTime: 0, subscription: 0 });

    await createCommerceCustomerEligibilityHandler({
      resolveCustomerEligibility: async () => ({
        clientId: "client-2",
        source: "resolved_client",
        matchKind: "exact",
      }),
      countPaidOrdersByMode,
    })(request("POST", { email: "new-account@example.com" }), res);

    expect(countPaidOrdersByMode).toHaveBeenCalledWith("client-2");
    expect(countPaidOrdersByMode).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recognized: false, firstOrderEligible: true }),
      }),
    );
  });

  it("does NOT recognize a +tag alias of an existing account, but still demotes first-order eligibility (anti-farming)", async () => {
    const res = createResponse();
    const countPaidOrdersByMode = vi
      .fn()
      .mockResolvedValue({ oneTime: 2, subscription: 0 });

    // A guest typing `base+tag@` resolves the base client only via plus-normalization.
    // Recognition must stay FALSE (no account-existence hint to an unauthenticated
    // visitor — CJ01-AC follow-up), yet the paid-order count still demotes the
    // first-order discount so the alias cannot farm a fresh first-order price.
    await createCommerceCustomerEligibilityHandler({
      resolveCustomerEligibility: async () => ({
        clientId: "base-client",
        source: "resolved_client",
        matchKind: "plus_normalized",
      }),
      countPaidOrdersByMode,
    })(request("POST", { email: "base+tag@example.com" }), res);

    expect(countPaidOrdersByMode).toHaveBeenCalledWith("base-client");
    expect(countPaidOrdersByMode).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recognized: false, firstOrderEligible: false }),
      }),
    );
  });

  it("treats an unknown email as a new, first-order-eligible guest", async () => {
    const res = createResponse();
    const countPaidOrdersByMode = vi.fn();

    await createCommerceCustomerEligibilityHandler({
      resolveCustomerEligibility: async () => ({ clientId: null, source: "anonymous" }),
      countPaidOrdersByMode,
    })(request("POST", { email: "stranger@example.com" }), res);

    expect(countPaidOrdersByMode).not.toHaveBeenCalled();
    expect(countPaidOrdersByMode).toHaveBeenCalledTimes(0);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recognized: false, firstOrderEligible: true }),
      }),
    );
  });

  it("blocks the lookup when the rate limiter denies it", async () => {
    const res = createResponse();
    const resolveCustomerEligibility = vi.fn();

    await createCommerceCustomerEligibilityHandler({
      resolveCustomerEligibility,
      countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
      checkRateLimit: async () => ({ allowed: false }),
    })(request("POST", { email: "anna@example.com" }), res);

    expect(resolveCustomerEligibility).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "RATE_LIMITED" }) }),
    );
  });

  it("rejects non-POST methods and malformed bodies", async () => {
    const method = createResponse();
    await createCommerceCustomerEligibilityHandler({
      resolveCustomerEligibility: async () => ({ clientId: null, source: "anonymous" }),
      countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
    })(request("GET"), method);
    expect(method.status).toHaveBeenCalledWith(405);

    const invalid = createResponse();
    await createCommerceCustomerEligibilityHandler({
      resolveCustomerEligibility: async () => ({ clientId: null, source: "anonymous" }),
      countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
    })(request("POST", { email: "not-an-email" }), invalid);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });
});

describe("starter-pack capability handshake", () => {
  /** The exact body this endpoint returned before the starter lane existed. */
  const PRE_STARTER_BODY = {
    contractVersion: "customer_eligibility.lookup.v1",
    recognized: false,
    firstOrderEligible: true,
  };

  function deps(
    overrides?: { starterPackEnabled?: () => boolean },
  ): CommerceCustomerEligibilityHandlerDeps {
    return {
      resolveCustomerEligibility: async () => ({
        clientId: null,
        source: "anonymous" as const,
        matchKind: null,
      }),
      countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
      ...overrides,
    };
  }

  const UNCHANGED_CASES: Array<[string, Record<string, unknown>, () => boolean]> = [
    ["capability, flag off", { offerModeCapability: "commerce.starter_offer.v1" }, () => false],
    ["flag on, no capability", {}, () => true],
    ["neither", {}, () => false],
  ];

  it.each(UNCHANGED_CASES)("stays deep-equal to the pre-starter response with %s", async (_label, extra, flag) => {
    const res = createResponse();
    await createCommerceCustomerEligibilityHandler(deps({ starterPackEnabled: flag }))(
      request("POST", { email: "guest@example.com", ...extra }),
      res,
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, data: PRE_STARTER_BODY }),
    );
  });

  it("stays deep-equal when no starter gate is injected at all", async () => {
    const res = createResponse();
    await createCommerceCustomerEligibilityHandler(deps())(
      request("POST", {
        email: "guest@example.com",
        offerModeCapability: "commerce.starter_offer.v1",
      }),
      res,
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, data: PRE_STARTER_BODY }),
    );
  });

  it("emits the offer terms only when both the capability and the flag are present", async () => {
    const res = createResponse();
    await createCommerceCustomerEligibilityHandler(deps({ starterPackEnabled: () => true }))(
      request("POST", {
        email: "guest@example.com",
        offerModeCapability: "commerce.starter_offer.v1",
      }),
      res,
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: {
          ...PRE_STARTER_BODY,
          starterOffer: {
            eligible: true,
            initialDiscountBps: 5_000,
            delivery2DiscountBps: 3_500,
            minCans: 14,
            intervalMinDays: 7,
            intervalMaxDays: 28,
            steadyCadenceThresholdGramsPerDay: 800,
            maxDailyGrams: 1_500,
          },
        },
      }),
    );
  });

  it("reports the offer as not eligible for a returning buyer, still emitting the terms", async () => {
    const res = createResponse();
    await createCommerceCustomerEligibilityHandler({
      resolveCustomerEligibility: async () => ({
        clientId: "client-9",
        source: "resolved_client" as const,
        matchKind: "exact" as const,
      }),
      countPaidOrdersByMode: async () => ({ oneTime: 2, subscription: 0 }),
      starterPackEnabled: () => true,
    })(
      request("POST", {
        email: "returning@example.com",
        offerModeCapability: "commerce.starter_offer.v1",
      }),
      res,
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recognized: true,
          firstOrderEligible: false,
          starterOffer: expect.objectContaining({ eligible: false }),
        }),
      }),
    );
  });
});

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {}, headers: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
  return res as unknown as VercelResponse;
}
