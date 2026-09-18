import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKOUT_CONTINUATION_KEY,
  clearCheckoutContinuation,
  markCheckoutContinuationWaitExhausted,
  persistCheckoutContinuation,
  readCheckoutContinuation,
  setCheckoutContinuationPhase,
} from "./checkoutNavigation";

afterEach(() => {
  clearCheckoutContinuation();
});

/**
 * The exhaustion stamp answers "did a wait on this marker run past its cap".
 * It is written once and never rewritten, and `commerce_payment_intents` is
 * UNIQUE (order_id), so a retry against the same order carries the SAME
 * paymentIntentId. Identity alone therefore cannot tell a stale stamp from a
 * live one — a phase transition can, because it means something newer is in
 * flight.
 */
describe("continuation wait-exhaustion stamp", () => {
  const identity = {
    orderId: "44444444-4444-4444-8444-444444444444",
    paymentIntentId: "55555555-5555-4555-8555-555555555555",
  };
  const marker = {
    ...identity,
    orderRef: "order_123",
    clientId: "66666666-6666-4666-8666-666666666666",
    journeyId: "checkout:77777777-7777-4777-8777-777777777777",
    actionKind: "redirect" as const,
  };

  it("stamps once and does not rewrite", () => {
    persistCheckoutContinuation(marker);
    markCheckoutContinuationWaitExhausted(identity);
    const first = readCheckoutContinuation()?.waitExhaustedAt;
    expect(first).toEqual(expect.any(Number));
    markCheckoutContinuationWaitExhausted(identity);
    expect(readCheckoutContinuation()?.waitExhaustedAt).toBe(first);
  });

  it("retires the stamp when a confirm is dispatched, and keeps the marker", () => {
    persistCheckoutContinuation(marker);
    markCheckoutContinuationWaitExhausted(identity);
    expect(readCheckoutContinuation()?.waitExhaustedAt).toEqual(expect.any(Number));

    setCheckoutContinuationPhase("confirm_dispatched");

    const after = readCheckoutContinuation();
    // The claim that the wait ran out is gone...
    expect(after?.waitExhaustedAt).toBeUndefined();
    // ...but the marker itself survives: dropping it would strand the buyer,
    // which is the defect the marker exists to prevent.
    expect(after?.orderId).toBe(identity.orderId);
    expect(after?.paymentIntentId).toBe(identity.paymentIntentId);
    expect(after?.phase).toBe("confirm_dispatched");
  });

  // Named for a transition but written as a repeat: `persistCheckoutContinuation`
  // DEFAULTS the phase to `action_issued`, so the original form of this test set
  // the phase it already had and duplicated the same-phase case below it. The
  // genuine `confirm_dispatched -> action_issued` walk-back was untested.
  it("retires the stamp on a real transition, not only on a repeat", () => {
    persistCheckoutContinuation(marker);
    setCheckoutContinuationPhase("confirm_dispatched");
    markCheckoutContinuationWaitExhausted(identity);
    expect(readCheckoutContinuation()?.waitExhaustedAt).toEqual(expect.any(Number));

    // Reachable: `onConfirmSettled("retryable")` walks the phase BACK after a
    // pre-dispatch failure the provider never saw.
    setCheckoutContinuationPhase("action_issued");

    const after = readCheckoutContinuation();
    expect(after?.waitExhaustedAt).toBeUndefined();
    expect(after?.phase).toBe("action_issued");
  });

  // ⛔ THE chain this wave exists for. A buyer who already confirmed once carries
  // phase `confirm_dispatched`. The resume paths reopen the SAME attempt without
  // re-persisting, so a second confirm is a same-phase call. If that returned
  // early the stamp would survive into the new wait, and the seed — which matches
  // on (orderId, paymentIntentId), identical across retries because
  // `commerce_payment_intents` is UNIQUE (order_id) — would fire at t≈0 and tell a
  // buyer who JUST authorized that we cannot confirm their payment.
  it("retires the stamp on a REPEAT confirm, when the phase does not change", () => {
    persistCheckoutContinuation(marker);
    setCheckoutContinuationPhase("confirm_dispatched");
    markCheckoutContinuationWaitExhausted(identity);
    expect(readCheckoutContinuation()?.waitExhaustedAt).toEqual(expect.any(Number));

    setCheckoutContinuationPhase("confirm_dispatched");

    const after = readCheckoutContinuation();
    expect(after?.waitExhaustedAt).toBeUndefined();
    expect(after?.phase).toBe("confirm_dispatched");
    expect(after?.orderId).toBe(identity.orderId);
  });

  // ⛔ Assert on the WRITE, not on the stored string. The rewrite
  // `{ ...current, phase, waitExhaustedAt: undefined }` serialises BYTE-IDENTICALLY
  // to what `persistCheckoutContinuation` stored — same key order, and
  // `JSON.stringify` drops the undefined key — so comparing the string before and
  // after cannot detect a write at all. The earlier form of this test did exactly
  // that: the whole guard could be deleted and all six tests here stayed green.
  it("writes nothing when there is neither a phase change nor a stamp to retire", () => {
    persistCheckoutContinuation(marker);
    expect(sessionStorage.getItem(CHECKOUT_CONTINUATION_KEY)).not.toBeNull();

    // The suite runs in the `node` environment, where `sessionStorage` is a shim
    // and the global `Storage` class does not exist — spy the object, not the class.
    const setItem = vi.spyOn(sessionStorage, "setItem");
    try {
      setCheckoutContinuationPhase("action_issued");
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it("stamps nothing for a different order", () => {
    persistCheckoutContinuation(marker);
    markCheckoutContinuationWaitExhausted({
      orderId: "99999999-9999-4999-8999-999999999999",
      paymentIntentId: identity.paymentIntentId,
    });
    expect(readCheckoutContinuation()?.waitExhaustedAt).toBeUndefined();
  });
});
