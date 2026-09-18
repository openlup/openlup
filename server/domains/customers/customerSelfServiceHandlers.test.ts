import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { CustomerSelfServiceMutationConflictError } from "./customerSelfServiceErrors.js";
import { createCustomerPetsHandler } from "./customerPetsHandler.js";
import { createCustomerPaymentRecoveryStartHandler } from "./customerPaymentRecoveryStartHandler.js";
import { createCustomerProfileHandler } from "./customerProfileHandler.js";
import { createCustomerSubscriptionActionHandler } from "./customerSubscriptionActionHandler.js";
import { createCustomerSubscriptionPreviewHandler } from "./customerSubscriptionPreviewHandler.js";

const PROFILE = {
  contractVersion: "customer.self_service.v1" as const,
  profile: {
    clientId: "11111111-1111-4111-8111-111111111111",
    email: "buyer@example.com",
    firstName: "Ala",
    lastName: null,
    phone: "+48500100100",
    lifecycleStage: "customer" as const,
  },
};

describe("customer self-service handlers", () => {
  it("updates a customer profile through an authenticated session", async () => {
    const profilePort = { updateProfile: vi.fn().mockResolvedValue(PROFILE) };
    const res = createResponse();

    await createCustomerProfileHandler({
      profilePort,
      authenticateUser: auth(),
    })(
      request("PATCH", { idempotencyKey: "profile-update-1", firstName: "Ala" }),
      res,
    );

    expect(profilePort.updateProfile).toHaveBeenCalledWith("user-1", {
      idempotencyKey: "profile-update-1",
      firstName: "Ala",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("applies a customer subscription action and rejects invalid payloads", async () => {
    const subscriptionActionPort = {
      applyAction: vi.fn().mockResolvedValue({
        contractVersion: "customer.self_service.v1",
        subscriptionAction: {
          subscriptionId: "22222222-2222-4222-8222-222222222222",
          action: "skip_next_cycle",
          status: "applied",
          subscriptionStatus: "active",
          nextCycleAt: "2026-06-20T12:00:00.000+02:00",
          templateVersion: 1,
          eventId: null,
        },
      }),
    };
    const ok = createResponse();
    const bad = createResponse();
    const handler = createCustomerSubscriptionActionHandler({
      subscriptionActionPort,
      authenticateUser: auth(),
    });

    await handler(
      request("POST", {
        action: "skip_next_cycle",
        idempotencyKey: "skip-cycle-1",
        subscriptionId: "22222222-2222-4222-8222-222222222222",
      }),
      ok,
    );
    await handler(request("POST", { action: "skip_next_cycle" }), bad);

    expect(ok.status).toHaveBeenCalledWith(200);
    expect(bad.status).toHaveBeenCalledWith(400);
  });

  it("previews customer subscription action eligibility and rejects wrong owners", async () => {
    const subscriptionPreviewPort = {
      previewAction: vi.fn().mockResolvedValueOnce({
        preview: {
          subscriptionId: "22222222-2222-4222-8222-222222222222",
          action: "skip_next_cycle",
          canApply: false,
          blockedReason: "cycle_locked",
          nextCycleAt: "2026-06-20T12:00:00.000+02:00",
          editCutoffAt: "2026-06-19T12:00:00.000+02:00",
          templateVersion: 1,
        },
      }).mockResolvedValueOnce(null),
    };
    const handler = createCustomerSubscriptionPreviewHandler({
      subscriptionPreviewPort,
      authenticateUser: auth(),
    });
    const ok = createResponse();
    const forbidden = createResponse();
    const bad = createResponse();

    await handler(
      request("POST", {
        subscriptionAction: {
          action: "skip_next_cycle",
          idempotencyKey: "skip-cycle-1",
          subscriptionId: "22222222-2222-4222-8222-222222222222",
        },
      }),
      ok,
    );
    await handler(
      request("POST", {
        subscriptionAction: {
          action: "skip_next_cycle",
          idempotencyKey: "skip-cycle-2",
          subscriptionId: "22222222-2222-4222-8222-222222222222",
        },
      }),
      forbidden,
    );
    await handler(request("POST", { subscriptionAction: { action: "skip_next_cycle" } }), bad);

    expect(ok.status).toHaveBeenCalledWith(200);
    expect(forbidden.status).toHaveBeenCalledWith(403);
    expect(bad.status).toHaveBeenCalledWith(400);
  });

  it("starts payment recovery with an actionable customer-safe response", async () => {
    const paymentRecoveryStartPort = {
      startPaymentRecovery: vi.fn().mockResolvedValueOnce({
        recoverable: true,
        recoveryUrlPath: "/konto/platnosc/napraw?token=rcv_safe",
        caseId: "33333333-3333-4333-8333-333333333333",
        expiresAt: "2026-06-20T12:00:00.000+02:00",
        nextRetryAt: null,
      }).mockResolvedValueOnce(null),
    };
    const handler = createCustomerPaymentRecoveryStartHandler({
      paymentRecoveryStartPort,
      authenticateUser: auth(),
    });
    const ok = createResponse();
    const forbidden = createResponse();
    const unauthenticated = createResponse();

    await handler(
      request("POST", {
        idempotencyKey: "recovery-start-1",
        subscriptionId: "22222222-2222-4222-8222-222222222222",
      }),
      ok,
    );
    await handler(
      request("POST", {
        idempotencyKey: "recovery-start-2",
        subscriptionId: "22222222-2222-4222-8222-222222222222",
      }),
      forbidden,
    );
    await createCustomerPaymentRecoveryStartHandler({
      paymentRecoveryStartPort,
      authenticateUser: vi.fn().mockResolvedValue({
        ok: false,
        code: "UNAUTHORIZED",
        message: "Customer session required",
      }),
    })(
      request("POST", {
        idempotencyKey: "recovery-start-3",
        subscriptionId: "22222222-2222-4222-8222-222222222222",
      }),
      unauthenticated,
    );

    expect(ok.status).toHaveBeenCalledWith(200);
    expect(ok.json).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({
        recoverable: true,
        recoveryUrlPath: "/konto/platnosc/napraw?token=rcv_safe",
      }),
    });
    expect(JSON.stringify(vi.mocked(ok.json).mock.calls)).not.toMatch(/provider|pm_|cus_|resend/i);
    expect(forbidden.status).toHaveBeenCalledWith(403);
    expect(unauthenticated.status).toHaveBeenCalledWith(401);
  });

  it("maps active pet removal blocks to a customer conflict", async () => {
    const petsPort = {
      listPets: vi.fn(),
      createPet: vi.fn(),
      updatePet: vi.fn(),
      removePet: vi
        .fn()
        .mockRejectedValue(new CustomerSelfServiceMutationConflictError("Cannot remove an active pet")),
    };
    const res = createResponse();

    await createCustomerPetsHandler({
      petsPort,
      authenticateUser: auth(),
    })(
      request("DELETE", {
        idempotencyKey: "pet-remove-1",
        petId: "33333333-3333-4333-8333-333333333333",
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

function auth() {
  return vi.fn().mockResolvedValue({ ok: true, userId: "user-1" });
}

function request(method: string, body: unknown): VercelRequest {
  return { method, body, query: {}, headers: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
