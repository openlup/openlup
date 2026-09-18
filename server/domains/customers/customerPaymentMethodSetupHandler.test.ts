import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

import { createCustomerPaymentMethodSetupHandler } from "./customerPaymentMethodSetupHandler.js";

const SUB = "5b000000-0000-4000-8000-000000000001";
const CLIENT = "c0000000-0000-4000-8000-000000000001";

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function req(over: Partial<VercelRequest> = {}): VercelRequest {
  return { method: "POST", body: { subscriptionId: SUB, idempotencyKey: "idem-12345678" }, headers: {}, ...over } as VercelRequest;
}

function baseDeps() {
  return {
    enabled: () => true,
    authenticateUser: vi.fn(async () => ({ ok: true as const, userId: "user-1" })),
    setupPort: {
      resolveSubscriptionForCardSetup: vi.fn(async () => ({ clientId: CLIENT, subscriptionId: SUB, providerCustomerRef: "cus_existing" })),
    },
    createSetupIntent: vi.fn(async () => ({ setupIntentId: "seti_1", clientSecret: "seti_1_secret" })),
    ensureCustomer: vi.fn(async () => "cus_new"),
  };
}

describe("createCustomerPaymentMethodSetupHandler", () => {
  it("mints a SetupIntent against the subscription's existing Stripe customer", async () => {
    const deps = baseDeps();
    const res = createResponse();
    await createCustomerPaymentMethodSetupHandler(deps)(req(), res);

    expect(deps.ensureCustomer).not.toHaveBeenCalled();
    expect(deps.createSetupIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_existing",
        metadata: { clientId: CLIENT, subscriptionId: SUB, source: "account.card-update" },
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          setup: expect.objectContaining({ clientSecret: "seti_1_secret", setupIntentId: "seti_1", subscriptionId: SUB }),
        }),
      }),
    );
  });

  it("mints a fresh Stripe customer when the subscription has no card yet", async () => {
    const deps = baseDeps();
    deps.setupPort.resolveSubscriptionForCardSetup.mockResolvedValueOnce({ clientId: CLIENT, subscriptionId: SUB, providerCustomerRef: null } as never);
    const res = createResponse();
    await createCustomerPaymentMethodSetupHandler(deps)(req(), res);

    expect(deps.ensureCustomer).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ clientId: CLIENT }) }));
    expect(deps.createSetupIntent).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_new" }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("403s when the subscription is not owned by the caller", async () => {
    const deps = baseDeps();
    deps.setupPort.resolveSubscriptionForCardSetup.mockResolvedValueOnce(null as never);
    const res = createResponse();
    await createCustomerPaymentMethodSetupHandler(deps)(req(), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(deps.createSetupIntent).not.toHaveBeenCalled();
  });

  it("401s when the session is unauthenticated", async () => {
    const deps = baseDeps();
    deps.authenticateUser.mockResolvedValueOnce({ ok: false, code: "UNAUTHORIZED", message: "no session" } as never);
    const res = createResponse();
    await createCustomerPaymentMethodSetupHandler(deps)(req(), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a bad body and a non-POST method", async () => {
    const deps = baseDeps();
    const bad = createResponse();
    await createCustomerPaymentMethodSetupHandler(deps)(req({ body: { subscriptionId: "not-a-uuid" } }), bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    const method = createResponse();
    await createCustomerPaymentMethodSetupHandler(deps)(req({ method: "GET" }), method);
    expect(method.status).toHaveBeenCalledWith(405);
  });

  it("is disabled behind the feature flag", async () => {
    const deps = { ...baseDeps(), enabled: () => false };
    const res = createResponse();
    await createCustomerPaymentMethodSetupHandler(deps)(req(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(deps.createSetupIntent).not.toHaveBeenCalled();
  });
});
