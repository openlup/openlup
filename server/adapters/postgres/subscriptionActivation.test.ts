import { describe, expect, it, vi } from "vitest";

import {
  capturedPaymentFingerprint,
  createPostgresSubscriptionActivationAdapter,
} from "./subscriptionActivation.js";

const ORDER = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION = "22222222-2222-4222-8222-222222222222";
const CAPTURED = "captured-handle-1";

function clientAnswering(data: unknown) {
  // The parameters are declared so `rpc.mock.calls` keeps the routine name it was
  // called with; an untyped `vi.fn` erases the tuple and the name assertion below
  // would have nothing to read.
  const rpc = vi.fn(async (_name: string, _args?: Record<string, unknown>) => ({ data, error: null }));
  return { rpc, adapter: createPostgresSubscriptionActivationAdapter({ rpc }) };
}

describe("postgres subscription activation adapter", () => {
  it("derives the payment identity from the captured handle rather than accepting one", async () => {
    const { rpc, adapter } = clientAnswering({
      orderId: ORDER, subscriptionId: SUBSCRIPTION, state: "active", cadenceDays: 28,
      activatedAt: "2026-05-01T09:00:00.000Z", repaired: false, replayed: false,
    });
    const activated = await adapter.activateFromCapturedPayment({
      idempotencyKey: "activation-key-1", orderId: ORDER, capturedReference: CAPTURED,
    });

    const [, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    // The fingerprint is a function of the handle alone: two calls that saw the same captured
    // payment agree, and no caller can hand in an identity of its own choosing.
    expect(args.p_payment_fingerprint).toBe(capturedPaymentFingerprint(CAPTURED));
    expect(String(args.p_payment_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(args).not.toHaveProperty("p_paid_at");
    expect(capturedPaymentFingerprint(CAPTURED)).not.toBe(capturedPaymentFingerprint("captured-handle-2"));
    expect(activated).toEqual({
      orderId: ORDER, subscriptionId: SUBSCRIPTION, state: "active", cadenceDays: 28,
      activatedAt: "2026-05-01T09:00:00.000Z", repaired: false, replayed: false,
    });
  });

  it("names every routine it calls, and calls no other", async () => {
    const { rpc, adapter } = clientAnswering({
      orderId: ORDER, sku: "sku", readiness: "ready", forSale: 3, sellable: true, continuationId: ORDER,
      status: "waiting", recorded: true, replayed: false, state: "provisional", cadenceDays: 28,
      declared: true, repaired: 0, overdue: 0, cancelled: true, reason: "abandoned_checkout",
      orderStatus: "cancelled", continuationStatus: "waiting", waiting: true,
    });
    await adapter.readOfferReadiness({ sourceKey: "source", sku: "sku" });
    await adapter.recordBackInStockContinuation({
      idempotencyKey: "continuation-key-1", sourceKey: "source", sku: "sku",
      contactRef: "a".repeat(64), consentRef: "b".repeat(64),
    });
    await adapter.readContinuationReentry({ sourceKey: "source", sku: "sku", contactRef: "a".repeat(64) });
    await adapter.declareProvisionalActivation({
      idempotencyKey: "fixture", orderId: ORDER, cadenceDays: 28,
    });
    await adapter.reconcilePaidActivationGaps(50);
    await adapter.compensateAbandonedCheckout({
      idempotencyKey: "compensate-key-1", orderId: ORDER, reason: "abandoned_checkout",
    });

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "commerce_offer_readiness",
      "commerce_record_offer_continuation",
      "commerce_offer_continuation_reentry",
      "subscription_declare_provisional_activation",
      "subscription_reconcile_paid_activation_gaps",
      "commerce_compensate_abandoned_checkout",
    ]);
  });

  it("reads the gap answer as the boolean it is, never as a truthy row", async () => {
    const open = clientAnswering(true);
    const closed = clientAnswering(false);
    const absent = clientAnswering(null);
    expect(await open.adapter.isPaidActivationGapOpen({ orderId: ORDER })).toBe(true);
    expect(await closed.adapter.isPaidActivationGapOpen({ orderId: ORDER })).toBe(false);
    expect(await absent.adapter.isPaidActivationGapOpen({ orderId: ORDER })).toBe(false);
  });

  it("refuses an answer that is missing the fields the caller will act on", async () => {
    const { adapter } = clientAnswering({ orderId: ORDER, state: "active" });
    await expect(adapter.activateFromCapturedPayment({
      idempotencyKey: "activation-key-1", orderId: ORDER, capturedReference: CAPTURED,
    })).rejects.toThrow("subscription activation response invalid");
  });

  it("surfaces a refusal from the database instead of reporting a result", async () => {
    const rpc = vi.fn(async () => ({
      data: null, error: { message: "subscription_activation_payment_fingerprint_conflict" },
    }));
    const adapter = createPostgresSubscriptionActivationAdapter({ rpc });
    await expect(adapter.activateFromCapturedPayment({
      idempotencyKey: "activation-key-1", orderId: ORDER, capturedReference: CAPTURED,
    })).rejects.toMatchObject({ message: "subscription_activation_payment_fingerprint_conflict" });
  });
});
