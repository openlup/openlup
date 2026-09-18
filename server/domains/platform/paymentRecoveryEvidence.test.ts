import { describe, expect, it } from "vitest";
import { summarizePayments } from "./paymentObservabilityEvidence.js";

// The detector under test lives in `paymentRecoveryEvidence.ts`, but it is
// exercised through `summarizePayments` on purpose: that is the seam the
// watchdog actually calls, so these cases prove the wiring as well as the
// predicate. `recoveryRequiredWithoutLinkCount` is the counter it feeds.
const now = new Date("2026-07-03T14:00:00.000Z");

// ⛔ This detector was structurally dead before this suite existed: its predicate
// read `attempt.recovery_required` and `attempt.recovery_link_created`, columns
// no migration creates, so the p1 could never fire. Every case below is pinned
// to a column a migration defines — the attempt status, the intent status, and a
// row in `commerce_checkout_recovery_tokens`.
describe("recovery path missing", () => {
  const failedFifteenMinutesAgo = "2026-07-03T13:40:00.000Z";

  function scenario(overrides: {
    intent?: Record<string, unknown>;
    attempts?: Record<string, unknown>[];
    recoveryTokenOrderIds?: string[];
    dunningCases?: Record<string, unknown>[];
  } = {}) {
    return summarizePayments(
      [{
        id: "intent-1",
        status: "requires_action",
        target_kind: "one_time_order",
        order_id: "order-1",
        ...overrides.intent,
      }],
      (overrides.attempts ?? [{
        id: "attempt-1",
        payment_intent_id: "intent-1",
        status: "failed",
        provider: "provider-a",
        updated_at: failedFifteenMinutesAgo,
      }]) as Parameters<typeof summarizePayments>[1],
      [],
      now,
      [],
      new Set(overrides.recoveryTokenOrderIds ?? []),
      (overrides.dunningCases ?? []) as Parameters<typeof summarizePayments>[6],
    );
  }

  it("names an unfinished payment that nobody was offered a way back into", () => {
    const snapshot = scenario();

    expect(snapshot.recoveryRequiredWithoutLinkCount).toBe(1);
    expect(snapshot.evidence).toContainEqual(expect.objectContaining({
      kind: "recovery_missing",
      paymentIntentId: "intent-1",
      paymentAttemptId: "attempt-1",
      orderId: "order-1",
      reason: "failed_attempt_without_any_recovery_path",
      owner: "commerce/payment",
      customerSafeStatus: "operator_review_required",
    }));
  });

  it("stays quiet once the recovery rail issued a token for that order", () => {
    expect(scenario({ recoveryTokenOrderIds: ["order-1"] }).recoveryRequiredWithoutLinkCount).toBe(0);
  });

  it("does not read another order's token as this order's recovery path", () => {
    expect(scenario({ recoveryTokenOrderIds: ["order-2"] }).recoveryRequiredWithoutLinkCount).toBe(1);
  });

  // A mistyped card produces a failed attempt and the customer retries in
  // seconds. Alerting on that is how a p1 gets muted.
  it("stays quiet when the money landed on the same intent after all", () => {
    expect(scenario({ intent: { status: "succeeded" } }).recoveryRequiredWithoutLinkCount).toBe(0);
  });

  it("stays quiet when a sibling attempt on the intent succeeded", () => {
    expect(scenario({
      attempts: [
        { id: "attempt-1", payment_intent_id: "intent-1", status: "failed", updated_at: failedFifteenMinutesAgo },
        { id: "attempt-2", payment_intent_id: "intent-1", status: "succeeded", updated_at: "2026-07-03T13:42:00.000Z" },
      ],
    }).recoveryRequiredWithoutLinkCount).toBe(0);
  });

  it("gives the customer the whole 15-minute window to retry before alerting", () => {
    expect(scenario({
      attempts: [{
        id: "attempt-1", payment_intent_id: "intent-1", status: "failed",
        updated_at: "2026-07-03T13:50:00.000Z",
      }],
    }).recoveryRequiredWithoutLinkCount).toBe(0);
  });

  // The token read is windowed to 24h. Judging an older failure against it
  // would allege a missing recovery path the adapter simply never read.
  it("refuses to judge a failure older than the token read window", () => {
    expect(scenario({
      attempts: [{
        id: "attempt-1", payment_intent_id: "intent-1", status: "failed",
        updated_at: "2026-07-02T10:00:00.000Z",
      }],
    }).recoveryRequiredWithoutLinkCount).toBe(0);
  });

  it("ignores an attempt that has not reached a terminal refusal", () => {
    expect(scenario({
      attempts: [{
        id: "attempt-1", payment_intent_id: "intent-1", status: "processing",
        updated_at: failedFifteenMinutesAgo,
      }],
    }).recoveryRequiredWithoutLinkCount).toBe(0);
  });

  it("cannot allege a missing order recovery path for an intent that names no order", () => {
    expect(scenario({ intent: { order_id: null } }).recoveryRequiredWithoutLinkCount).toBe(0);
  });
});

// ⛔ The false positive this detector nearly shipped. A renewal refusal never
// receives a checkout-recovery token — its way back is a dunning case. Judged on
// the token alone, every ordinary soft-retryable renewal decline raised a p1
// saying "recovery path missing" while recovery was demonstrably running, which
// is the same disease the detector was repaired for. Hence the suppressor is the
// fact of rescue, not a guess at the originating rail.
describe("recovery path missing on the renewal rail", () => {
  const failedFifteenMinutesAgo = "2026-07-03T13:40:00.000Z";

  function renewalScenario(dunningCases: Record<string, unknown>[]) {
    return summarizePayments(
      [{
        id: "intent-renewal",
        status: "requires_action",
        target_kind: "subscription_cycle",
        order_id: "order-renewal",
        subscription_id: "sub-1",
        subscription_cycle_id: "cycle-7",
      }],
      [{
        id: "attempt-renewal",
        payment_intent_id: "intent-renewal",
        status: "failed",
        updated_at: failedFifteenMinutesAgo,
      }] as Parameters<typeof summarizePayments>[1],
      [],
      now,
      [],
      new Set<string>(),
      dunningCases as Parameters<typeof summarizePayments>[6],
    );
  }

  it.each([
    ["open", { status: "open" }],
    ["recovered", { status: "recovered" }],
    ["expired", { status: "expired" }],
  ])("stays quiet while a %s dunning case covers the cycle", (_label, overrides) => {
    // Every status counts: open is a recovery running, recovered one that
    // worked, expired one that ran and gave up. All three offered a way back.
    expect(renewalScenario([{ ...overrides, payment_intent_id: "intent-renewal", cycle_id: "cycle-7" }])
      .recoveryRequiredWithoutLinkCount).toBe(0);
  });

  // The cycle link is what survives intent churn across the retry ladder.
  it("matches the case on the cycle even when it names a different intent", () => {
    expect(renewalScenario([{ status: "open", payment_intent_id: "intent-earlier-retry", cycle_id: "cycle-7" }])
      .recoveryRequiredWithoutLinkCount).toBe(0);
  });

  it("does not read another cycle's dunning case as this one's recovery path", () => {
    expect(renewalScenario([{ status: "open", payment_intent_id: "intent-other", cycle_id: "cycle-99" }])
      .recoveryRequiredWithoutLinkCount).toBe(1);
  });

  // This is the blind spot worth a p1: a renewal that ended and left the
  // customer with no case, no token, and no worker coming back for it.
  it("names a renewal refusal that opened no dunning case at all", () => {
    const snapshot = renewalScenario([]);

    expect(snapshot.recoveryRequiredWithoutLinkCount).toBe(1);
    expect(snapshot.evidence).toContainEqual(expect.objectContaining({
      kind: "recovery_missing",
      paymentIntentId: "intent-renewal",
      reason: "failed_attempt_without_any_recovery_path",
    }));
  });
});

// The cycle link cannot fire when the intent row carries no cycle — a case that
// names the intent directly is still proof of rescue, and is what this second
// link exists for. Found by a surviving mutant: every other renewal case here
// supplies a cycle, so the cycle link masked this branch entirely.
describe("recovery path missing when the intent names no cycle", () => {
  it("reads a dunning case that points straight at the intent", () => {
    const snapshot = summarizePayments(
      [{
        id: "intent-cycleless",
        status: "requires_action",
        target_kind: "subscription_cycle",
        order_id: "order-cycleless",
      }],
      [{
        id: "attempt-cycleless",
        payment_intent_id: "intent-cycleless",
        status: "failed",
        updated_at: "2026-07-03T13:40:00.000Z",
      }] as Parameters<typeof summarizePayments>[1],
      [],
      now,
      [],
      new Set<string>(),
      [{ status: "open", payment_intent_id: "intent-cycleless", cycle_id: null }] as Parameters<typeof summarizePayments>[6],
    );

    expect(snapshot.recoveryRequiredWithoutLinkCount).toBe(0);
  });
});
