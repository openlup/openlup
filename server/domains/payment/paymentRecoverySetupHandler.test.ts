import { describe, expect, it, vi } from "vitest";
import {
  createPaymentRecoverySetupHandler,
  hashRecoveryToken,
  type PaymentRecoverySetupPort,
  type StripeSetupIntentCallback,
} from "./paymentRecoverySetupHandler.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

const RECOVERY_TOKEN = "a".repeat(64);
const CASE_ID = "33333333-3333-4333-8333-000000000001";
const SUB_ID = "00000000-0000-4000-8000-000000000001";
const CUSTOMER_USER_ID = "user-1";
const CLIENT_ID = "client-1";
const CUSTOMER_REF = "cus_X";

function port(overrides: Partial<PaymentRecoverySetupPort> = {}): PaymentRecoverySetupPort {
  return {
    findTokenEvidenceByHash: vi.fn(async () => ({
      tokenId: "tok-1",
      caseId: CASE_ID,
      clientId: CLIENT_ID,
      authUserId: CUSTOMER_USER_ID,
      purpose: "repair_payment" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
      usedAt: null,
      revokedAt: null,
    })),
    recordSubscriptionPaymentRecovery: vi.fn(),
    resolveRecoveryCaseSubscription: vi.fn(async () => ({
      caseId: CASE_ID,
      subscriptionId: SUB_ID,
      providerCustomerRef: CUSTOMER_REF,
      failureClass: "mandate_dead",
      amountMinor: 12999,
      // ISO 4217 reserves XTS for testing. The handler passes the case's currency
      // through untouched, so the fixture proves that with a code no market uses
      // rather than borrowing a real one this deployment happens to sell in.
      currency: "XTS",
    })),
    ...overrides,
  };
}

function setupIntentMock(): StripeSetupIntentCallback {
  return vi.fn(async () => ({
    setupIntentId: "seti_1",
    clientSecret: "seti_1_secret_xyz",
    replayed: false,
  }));
}

function ensureCustomerMock(customer = "cus_new") {
  return vi.fn(async () => customer);
}

function req(body: Record<string, unknown> = {}): VercelRequest {
  return {
    method: "POST",
    body: {
      idempotencyKey: "recovery-setup-1",
      recoveryToken: RECOVERY_TOKEN,
      ...body,
    },
    headers: {},
    query: {},
  } as unknown as VercelRequest;
}

function res(): VercelResponse {
  const r = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(r.status).mockReturnValue(r);
  vi.mocked(r.json).mockReturnValue(r);
  return r;
}

describe("createPaymentRecoverySetupHandler", () => {
  it("rejects when feature flag is off", async () => {
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => false,
      authenticateCustomer: async () => ({ ok: false }),
      recoveryPort: port(),
      createSetupIntent: setupIntentMock(),
      ensureCustomer: ensureCustomerMock(),
    });
    const response = res();
    await handler(req(), response);
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it("rejects on missing auth", async () => {
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: false }),
      recoveryPort: port(),
      createSetupIntent: setupIntentMock(),
      ensureCustomer: ensureCustomerMock(),
    });
    const response = res();
    await handler(req(), response);
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it("rejects when token is expired", async () => {
    const recoveryPort = port({
      findTokenEvidenceByHash: vi.fn(async () => ({
        tokenId: "tok-1",
        caseId: CASE_ID,
        clientId: CLIENT_ID,
        authUserId: CUSTOMER_USER_ID,
        purpose: "repair_payment" as const,
        expiresAt: "2000-01-01T00:00:00.000Z",
        usedAt: null,
        revokedAt: null,
      })),
    });
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      recoveryPort,
      createSetupIntent: setupIntentMock(),
      ensureCustomer: ensureCustomerMock(),
      now: () => new Date("2026-06-09T00:00:00.000Z"),
    });
    const response = res();
    await handler(req(), response);
    expect(response.status).toHaveBeenCalledWith(409);
  });

  it("rejects when token owner mismatches authed user", async () => {
    const recoveryPort = port({
      findTokenEvidenceByHash: vi.fn(async () => ({
        tokenId: "tok-1",
        caseId: CASE_ID,
        clientId: CLIENT_ID,
        authUserId: "other-user",
        purpose: "repair_payment" as const,
        expiresAt: "2099-01-01T00:00:00.000Z",
        usedAt: null,
        revokedAt: null,
      })),
    });
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      recoveryPort,
      createSetupIntent: setupIntentMock(),
      ensureCustomer: ensureCustomerMock(),
    });
    const response = res();
    await handler(req(), response);
    expect(response.status).toHaveBeenCalledWith(403);
  });

  // CHANGED (expired-resume wave): this used to pin the refusal to mint for a
  // `resume_subscription` token, whose stated premise — no runtime handler for
  // the resume — the redeem RPC has since made false. What it pins now is that
  // minting is purpose-independent AND that the handler still schedules nothing
  // of its own: collecting a card must not be able to provoke a charge on an
  // expired case, which is the property the refusal used to buy.
  it("mints a SetupIntent for an expired-dunning resume token without scheduling anything", async () => {
    const createSetupIntent = setupIntentMock();
    const ensureCustomer = ensureCustomerMock();
    const recoveryPort = port({
      findTokenEvidenceByHash: vi.fn(async () => ({
        tokenId: "tok-expired",
        caseId: CASE_ID,
        clientId: CLIENT_ID,
        authUserId: CUSTOMER_USER_ID,
        purpose: "resume_subscription" as const,
        expiresAt: "2099-01-01T00:00:00.000Z",
        usedAt: null,
        revokedAt: null,
      })),
    });
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      recoveryPort,
      createSetupIntent,
      ensureCustomer,
    });
    const response = res();

    await handler(req(), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        setup: expect.objectContaining({
          purpose: "resume_subscription",
          caseId: CASE_ID,
          subscriptionId: SUB_ID,
        }),
      }),
    }));
    expect(createSetupIntent).toHaveBeenCalledTimes(1);
    // The whole port surface: resolution is the only call the handler makes
    // besides the mint — no redeem, no retry scheduling.
    expect(recoveryPort.resolveRecoveryCaseSubscription).toHaveBeenCalledTimes(1);
    expect(recoveryPort.recordSubscriptionPaymentRecovery).not.toHaveBeenCalled();
  });

  it("reports the token purpose so the capture surface can promise the right outcome", async () => {
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      recoveryPort: port(),
      createSetupIntent: setupIntentMock(),
      ensureCustomer: ensureCustomerMock(),
    });
    const response = res();

    await handler(req(), response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        setup: expect.objectContaining({ purpose: "repair_payment" }),
      }),
    }));
  });

  it("happy path mints SetupIntent metadata-tagged with subscriptionId+caseId+clientId", async () => {
    const createSetupIntent = setupIntentMock();
    const ensureCustomer = ensureCustomerMock();
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      recoveryPort: port(),
      createSetupIntent,
      ensureCustomer,
    });
    const response = res();
    await handler(req(), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(ensureCustomer).not.toHaveBeenCalled();
    expect(createSetupIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: CUSTOMER_REF,
        metadata: expect.objectContaining({
          clientId: CLIENT_ID,
          subscriptionId: SUB_ID,
          recoveryCaseId: CASE_ID,
          source: "payment-recovery.setup",
        }),
        idempotencyKey: expect.stringContaining(`recovery-setup:${CASE_ID}:`),
      }),
    );
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          setup: expect.objectContaining({
            clientSecret: "seti_1_secret_xyz",
            setupIntentId: "seti_1",
            caseId: CASE_ID,
            subscriptionId: SUB_ID,
          }),
        }),
      }),
    );
  });

  it("creates a Stripe customer before SetupIntent for a BLIK-only subscription", async () => {
    const createSetupIntent = setupIntentMock();
    const ensureCustomer = ensureCustomerMock("cus_for_blik_customer");
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      recoveryPort: port({
        resolveRecoveryCaseSubscription: vi.fn(async () => ({
          caseId: CASE_ID,
          subscriptionId: SUB_ID,
          providerCustomerRef: null, failureClass: null, amountMinor: null, currency: null
        })),
      }),
      createSetupIntent,
      ensureCustomer,
    });

    const response = res();
    await handler(req(), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(ensureCustomer).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      metadata: {
        clientId: CLIENT_ID,
        source: "payment-recovery.customer",
      },
      idempotencyKey: `recovery-customer:${CLIENT_ID}`,
    });
    expect(createSetupIntent).toHaveBeenCalledWith(expect.objectContaining({
      customer: "cus_for_blik_customer",
    }));
  });

  it("returns CONFLICT when no subscription can be resolved from the case", async () => {
    const recoveryPort = port({
      resolveRecoveryCaseSubscription: vi.fn(async () => null),
    });
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      recoveryPort,
      createSetupIntent: setupIntentMock(),
      ensureCustomer: ensureCustomerMock(),
    });
    const response = res();
    await handler(req(), response);
    expect(response.status).toHaveBeenCalledWith(409);
  });

  it("does a single SHA-256 lookup and does not retry a legacy hash on miss", async () => {
    // The MD5 read fallback was removed: a SHA-256 miss is a not-found token.
    const findTokenEvidenceByHash = vi.fn<PaymentRecoverySetupPort["findTokenEvidenceByHash"]>(
      async () => null,
    );
    const recoveryPort = port({ findTokenEvidenceByHash });
    const handler = createPaymentRecoverySetupHandler({
      enabled: () => true,
      authenticateCustomer: async () => ({ ok: true, userId: CUSTOMER_USER_ID }),
      recoveryPort,
      createSetupIntent: setupIntentMock(),
      ensureCustomer: ensureCustomerMock(),
    });
    const response = res();
    await handler(req(), response);

    expect(findTokenEvidenceByHash).toHaveBeenCalledTimes(1);
    expect(findTokenEvidenceByHash).toHaveBeenCalledWith(hashRecoveryToken(RECOVERY_TOKEN));
    expect(response.status).toHaveBeenCalledWith(409);
  });

  it("hashRecoveryToken produces the canonical SHA-256 hash", () => {
    expect(hashRecoveryToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashRecoveryToken("abc")).toMatch(/^[a-f0-9]{64}$/);
  });
});
