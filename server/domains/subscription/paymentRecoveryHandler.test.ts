import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createPaymentRecoveryRedeemHandler,
  hashRecoveryToken,
  PaymentRecoveryRecordError,
  type PaymentRecoveryPort,
} from "./paymentRecoveryHandler.js";

const RECOVERY_TOKEN = ["01234567", "89abcdef"].join("").repeat(4);
const CUSTOMER_USER_ID = "auth-user-1";
const OTHER_USER_ID = "auth-user-2";
const CASE_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";
const CYCLE_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_ID = "55555555-5555-4555-8555-555555555555";

describe("payment recovery redeem handler", () => {
  it("requires an authenticated customer session before token lookup", async () => {
    const port = fakePort();
    const handler = createPaymentRecoveryRedeemHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: false }),
      recoveryPort: port,
    });
    const res = createResponse();

    await handler(request(), res);

    expect(port.findTokenEvidenceByHash).not.toHaveBeenCalled();
    expect(port.recordSubscriptionPaymentRecovery).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects expired tokens before mutating the payment method", async () => {
    const port = fakePort({
      findTokenEvidenceByHash: vi.fn(async () => tokenEvidence({
        expiresAt: "2026-06-06T11:59:59.000Z",
      })),
    });
    const handler = createPaymentRecoveryRedeemHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      now: () => new Date("2026-06-06T12:00:00.000Z"),
      recoveryPort: port,
    });
    const res = createResponse();

    await handler(request(), res);

    expect(port.recordSubscriptionPaymentRecovery).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("allows an owner-bound used token to reach the RPC idempotent replay path", async () => {
    const port = fakePort({
      findTokenEvidenceByHash: vi.fn(async () => tokenEvidence({
        usedAt: "2026-06-06T10:00:00.000Z",
      })),
      recordSubscriptionPaymentRecovery: vi.fn(async () => recoveryResult({ replayed: true })),
    });
    const handler = createPaymentRecoveryRedeemHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      now: () => new Date("2026-06-06T12:00:00.000Z"),
      recoveryPort: port,
    });
    const res = createResponse();

    await handler(request(), res);

    expect(port.recordSubscriptionPaymentRecovery).toHaveBeenCalledWith({
      idempotencyKey: "recovery-submit-1",
      recoveryToken: RECOVERY_TOKEN,
      paymentMethodRef: "pm_provider_reusable",
      paymentMethodKind: "stripe_payment_method",
      requestedAt: "2026-06-06T12:00:00.000Z",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toMatchObject({
      ok: true,
      data: { recovery: { subscriptionId: SUBSCRIPTION_ID, replayed: true } },
    });
  });

  it("rejects a valid token presented by the wrong authenticated customer", async () => {
    const port = fakePort({
      findTokenEvidenceByHash: vi.fn(async () => tokenEvidence({ authUserId: OTHER_USER_ID })),
    });
    const handler = createPaymentRecoveryRedeemHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      now: () => new Date("2026-06-06T12:00:00.000Z"),
      recoveryPort: port,
    });
    const res = createResponse();

    await handler(request(), res);

    expect(port.recordSubscriptionPaymentRecovery).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // CHANGED (expired-resume wave): this used to pin the BFF's own refusal of a
  // `resume_subscription` token, which mirrored the RPC's fail-closed guard. The
  // RPC resumes now, so refusing here would only hide it. What the test still
  // pins is that the BFF adds no judgement of its own: the token reaches the RPC
  // and the RPC's verdict is what the customer gets.
  it("passes an expired-dunning resume token through to the RPC", async () => {
    const port = fakePort({
      findTokenEvidenceByHash: vi.fn(async () => tokenEvidence({
        purpose: "resume_subscription",
      })),
    });
    const handler = createPaymentRecoveryRedeemHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      now: () => new Date("2026-06-06T12:00:00.000Z"),
      recoveryPort: port,
    });
    const res = createResponse();

    await handler(request(), res);

    expect(port.recordSubscriptionPaymentRecovery).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(409);
  });

  it("redeems a customer-bound token without returning raw token or provider method refs", async () => {
    const port = fakePort();
    const handler = createPaymentRecoveryRedeemHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      now: () => new Date("2026-06-06T12:00:00.000Z"),
      recoveryPort: port,
    });
    const res = createResponse();

    await handler(request(), res);

    expect(port.findTokenEvidenceByHash).toHaveBeenCalledWith(sha256(RECOVERY_TOKEN));
    expect(port.recordSubscriptionPaymentRecovery).toHaveBeenCalledWith({
      idempotencyKey: "recovery-submit-1",
      recoveryToken: RECOVERY_TOKEN,
      paymentMethodRef: "pm_provider_reusable",
      paymentMethodKind: "stripe_payment_method",
      requestedAt: "2026-06-06T12:00:00.000Z",
    });
    const responseBody = vi.mocked(res.json).mock.calls[0]?.[0];
    expect(JSON.stringify(responseBody)).not.toContain(RECOVERY_TOKEN);
    expect(JSON.stringify(responseBody)).not.toContain("pm_provider_reusable");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: "payment.recovery.v2",
        recovery: {
          caseId: CASE_ID,
          subscriptionId: SUBSCRIPTION_ID,
          cycleId: CYCLE_ID,
          orderId: ORDER_ID,
          purpose: "repair_payment",
          nextAction: "retry_existing_cycle",
          replayed: false,
        },
      },
      meta: { contractVersion: "payment.recovery.v2" },
    });
  });

  // The last two are the expired-dunning resume rail's own verdicts: the client
  // can only retry the webhook race, or stop, if the reason reaches it.
  it.each([
    ["token_invalid_or_expired" as const, "Payment recovery token is invalid", { usedAt: "2026-06-06T10:00:00.000Z" }],
    ["idempotency_conflict" as const, "Payment recovery idempotency conflict", {}],
    ["resume_method_not_chargeable" as const, "Payment recovery method is not chargeable yet", { purpose: "resume_subscription" as const }],
    ["resume_case_state_changed" as const, "Payment recovery case is no longer in the expected state", { purpose: "resume_subscription" as const }],
  ])("maps recovery %s errors to a controlled conflict", async (reason, message, evidenceOverrides) => {
    const port = fakePort({
      findTokenEvidenceByHash: vi.fn(async () => tokenEvidence(evidenceOverrides)),
      recordSubscriptionPaymentRecovery: vi.fn(async () => {
        throw new PaymentRecoveryRecordError(reason);
      }),
    });
    const handler = createPaymentRecoveryRedeemHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      now: () => new Date("2026-06-06T12:00:00.000Z"),
      recoveryPort: port,
    });
    const res = createResponse();

    await handler(request(), res);

    expect(port.recordSubscriptionPaymentRecovery).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "CONFLICT",
        message,
        details: { reason },
      },
    });
  });

  it("does a single SHA-256 lookup and does not retry a legacy hash on miss", async () => {
    // The MD5 read fallback was removed: a SHA-256 miss means the token is
    // simply not found — no second lookup with a legacy hash.
    const findTokenEvidenceByHash = vi.fn<PaymentRecoveryPort["findTokenEvidenceByHash"]>(
      async () => null,
    );
    const port = fakePort({ findTokenEvidenceByHash });
    const handler = createPaymentRecoveryRedeemHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      now: () => new Date("2026-06-06T12:00:00.000Z"),
      recoveryPort: port,
    });
    const res = createResponse();

    await handler(request(), res);

    expect(findTokenEvidenceByHash).toHaveBeenCalledTimes(1);
    expect(findTokenEvidenceByHash).toHaveBeenCalledWith(sha256(RECOVERY_TOKEN));
    expect(port.recordSubscriptionPaymentRecovery).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("uses the DB-compatible SHA-256 token hash, never the raw token, as lookup evidence", () => {
    expect(hashRecoveryToken(RECOVERY_TOKEN)).toBe(sha256(RECOVERY_TOKEN));
    expect(hashRecoveryToken(RECOVERY_TOKEN)).toMatch(/^[a-f0-9]{64}$/);
  });
});

function fakePort(overrides: Partial<PaymentRecoveryPort> = {}): PaymentRecoveryPort {
  return {
    findTokenEvidenceByHash: vi.fn(async () => tokenEvidence()),
    recordSubscriptionPaymentRecovery: vi.fn(async () => recoveryResult()),
    ...overrides,
  };
}

function recoveryResult(overrides: Partial<Awaited<ReturnType<PaymentRecoveryPort["recordSubscriptionPaymentRecovery"]>>["subscriptionPaymentRecovery"]> = {}) {
  return {
    contractVersion: "commerce.v0" as const,
    subscriptionPaymentRecovery: {
      caseId: CASE_ID,
      subscriptionId: SUBSCRIPTION_ID,
      cycleId: CYCLE_ID,
      orderId: ORDER_ID,
      purpose: "repair_payment" as const,
      nextAction: "retry_existing_cycle" as const,
      replayed: false,
      ...overrides,
    },
  };
}

function tokenEvidence(overrides: Partial<Awaited<ReturnType<PaymentRecoveryPort["findTokenEvidenceByHash"]>>> = {}) {
  return {
    tokenId: "token-row-1",
    caseId: "case-1",
    clientId: CLIENT_ID,
    authUserId: CUSTOMER_USER_ID,
    purpose: "repair_payment" as const,
    expiresAt: "2026-06-06T13:00:00.000Z",
    usedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function request(body: Record<string, unknown> = {}): VercelRequest {
  return {
    method: "POST",
    body: {
      idempotencyKey: "recovery-submit-1",
      recoveryToken: RECOVERY_TOKEN,
      paymentMethodRef: "pm_provider_reusable",
      paymentMethodKind: "stripe_payment_method",
      requestedAt: "2026-06-06T12:00:00.000Z",
      ...body,
    },
    query: {},
    headers: {},
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
