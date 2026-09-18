import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { ProviderReconciliationStatus } from "./paymentProviderReconciliationContracts.js";
import {
  createCommercePaymentVerifyHandler,
  type VerifiableAttemptSnapshot,
} from "./paymentVerifyNowHandler.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PAYMENT_INTENT_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const PAYMENT_ID = "66666666-6666-4666-8666-666666666666";

function snapshot(over: Partial<VerifiableAttemptSnapshot> = {}): VerifiableAttemptSnapshot {
  return {
    orderId: ORDER_ID,
    orderClientId: CLIENT_ID,
    orderMode: "subscription_cycle",
    paymentIntentId: PAYMENT_INTENT_ID,
    intentStatus: "processing",
    intentProviderPaymentId: null,
    paymentAttemptId: PAYMENT_ATTEMPT_ID,
    paymentId: PAYMENT_ID,
    attemptStatus: "processing",
    provider: "stripe",
    providerAttemptId: "pi_live_123",
    providerSessionId: null,
    amountMinor: 11175,
    currency: "PLN",
    localUpdatedAt: "2026-07-24T06:08:38.776+00:00",
    ...over,
  };
}

function providerReading(
  over: Partial<ProviderReconciliationStatus> = {},
): ProviderReconciliationStatus {
  return {
    status: "failed",
    providerStatus: "requires_payment_method",
    occurredAt: null,
    failureReason: "stripe_requires_payment_method",
    amountMinor: 11175,
    currency: "PLN",
    rawPayload: {},
    ...over,
  };
}

function makeHandler(input: {
  snap?: VerifiableAttemptSnapshot | null;
  reading?: ProviderReconciliationStatus;
  providers?: Record<string, { readPayment: () => Promise<ProviderReconciliationStatus> }>;
  apply?: ReturnType<typeof vi.fn>;
  enabled?: boolean;
}) {
  const apply = input.apply ?? vi.fn().mockResolvedValue({
    replayed: false,
    correctionStatus: "corrected",
    paymentResult: {},
    subscriptionWebhookDunning: { opened: false, replayed: false },
  });
  const readPayment = vi.fn().mockResolvedValue(input.reading ?? providerReading());
  const providers = input.providers ?? { stripe: { readPayment } };
  const handler = createCommercePaymentVerifyHandler({
    readPort: { async readVerifiableAttempt() { return input.snap === undefined ? snapshot() : input.snap; } },
    applyPort: { applyTerminalResult: apply as never },
    providers: providers as never,
    mutationsEnabled: () => input.enabled ?? true,
    now: () => new Date("2026-07-24T07:00:00.000Z"),
  });
  return { handler, apply, readPayment };
}

function request(body: unknown, method = "POST"): VercelRequest {
  return { method, query: {}, body, headers: {} } as unknown as VercelRequest;
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

const VALID_BODY = { orderId: ORDER_ID, paymentIntentId: PAYMENT_INTENT_ID, clientId: CLIENT_ID };

function sentData(res: VercelResponse): Record<string, unknown> {
  const payload = vi.mocked(res.json).mock.calls.at(-1)?.[0] as { data?: Record<string, unknown> };
  return payload?.data ?? {};
}

describe("commerce payment verify handler", () => {
  it("applies a terminal failed provider readback through the reconciliation key", async () => {
    const { handler, apply } = makeHandler({});
    const res = createResponse();
    await handler(request(VALID_BODY), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sentData(res)).toEqual({ status: "failed", verified: true, applied: true });
    expect(apply).toHaveBeenCalledTimes(1);
    const applied = apply.mock.calls[0][0];
    expect(applied.idempotencyKey).toBe(
      `payment-provider-reconciliation:${PAYMENT_ATTEMPT_ID}:apply:failed`,
    );
    expect(applied.expectedOrderId).toBe(ORDER_ID);
    expect(applied.expectedPaymentAttemptId).toBe(PAYMENT_ATTEMPT_ID);
    expect(applied.expectedPaymentId).toBe(PAYMENT_ID);
    expect(applied.resultStatus).toBe("failed");
    expect(applied.providerPaymentId).toBe("pi_live_123");
  });

  it("marks applied=false when the apply replays (cron already corrected)", async () => {
    const apply = vi.fn().mockResolvedValue({
      replayed: true,
      correctionStatus: "corrected",
      paymentResult: {},
      subscriptionWebhookDunning: { opened: false, replayed: true },
    });
    const { handler } = makeHandler({ apply });
    const res = createResponse();
    await handler(request(VALID_BODY), res);
    expect(sentData(res)).toEqual({ status: "failed", verified: true, applied: false });
  });

  it("returns pending and does NOT apply for a non-terminal provider state", async () => {
    const { handler, apply } = makeHandler({
      reading: providerReading({ status: "pending", providerStatus: "processing" }),
    });
    const res = createResponse();
    await handler(request(VALID_BODY), res);
    expect(sentData(res)).toEqual({ status: "pending", verified: true, applied: false });
    expect(apply).not.toHaveBeenCalled();
  });

  it("preserves unknown provider vocabulary as non-terminal pending", async () => {
    const { handler, apply } = makeHandler({
      reading: providerReading({ status: "unknown", providerStatus: "future_state" }),
    });
    const res = createResponse();
    await handler(request(VALID_BODY), res);
    expect(sentData(res)).toEqual({ status: "pending", verified: true, applied: false });
    expect(apply).not.toHaveBeenCalled();
  });

  it("short-circuits an already-terminal attempt without a provider call", async () => {
    const readPayment = vi.fn();
    const { handler, apply } = makeHandler({
      snap: snapshot({ attemptStatus: "failed" }),
      providers: { stripe: { readPayment } },
    });
    const res = createResponse();
    await handler(request(VALID_BODY), res);
    expect(sentData(res)).toEqual({ status: "failed", verified: false, applied: false });
    expect(readPayment).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("responds not-found for a non-owning client triple (no existence leak)", async () => {
    const { handler, apply } = makeHandler({ snap: snapshot({ orderClientId: OTHER_CLIENT_ID }) });
    const res = createResponse();
    await handler(request(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(apply).not.toHaveBeenCalled();
  });

  it("responds not-found when no verifiable attempt exists", async () => {
    const { handler } = makeHandler({ snap: null });
    const res = createResponse();
    await handler(request(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns unavailable without mutation when the provider is not configured", async () => {
    const { handler, apply } = makeHandler({ providers: {} });
    const res = createResponse();
    await handler(request(VALID_BODY), res);
    expect(sentData(res)).toEqual({ status: "unavailable", verified: false, applied: false });
    expect(apply).not.toHaveBeenCalled();
  });

  it("routes an amount mismatch to manual_review and never applies", async () => {
    const { handler, apply } = makeHandler({
      reading: providerReading({ amountMinor: 999 }),
    });
    const res = createResponse();
    await handler(request(VALID_BODY), res);
    expect(sentData(res)).toEqual({ status: "manual_review", verified: true, applied: false });
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects an invalid body with 400", async () => {
    const { handler } = makeHandler({});
    const res = createResponse();
    await handler(request({ orderId: "nope" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects non-POST methods", async () => {
    const { handler } = makeHandler({});
    const res = createResponse();
    await handler(request(VALID_BODY, "GET"), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("responds upstream-unavailable when payments are disabled", async () => {
    const { handler } = makeHandler({ enabled: false });
    const res = createResponse();
    await handler(request(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe("commerce payment verify handler read purpose", () => {
  // This route's only caller is a browser in a live checkout, so the read it
  // makes is not the reconciliation worker's. Without the purpose an intent
  // that no issuer was ever asked about reads as refused, and the route writes
  // a terminal failure onto a payment still being entered - measured in
  // production on 2026-08-23 at 64 s and 70 s after the intents were minted.
  // What the purpose then MEANS belongs to the adapter and is pinned there.
  it("asks the provider as an active checkout, not as reconciliation", async () => {
    const { handler, readPayment } = makeHandler({
      reading: providerReading({ status: "pending", providerStatus: "requires_payment_method" }),
    });
    await handler(request(VALID_BODY), createResponse());

    expect(readPayment).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "active_checkout" }),
    );
  });
});
