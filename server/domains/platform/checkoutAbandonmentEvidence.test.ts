import { describe, expect, it } from "vitest";

import {
  collectAbandonedBeforeConfirmationEvidence,
  collectPendingPaymentPastRecoveryWindowEvidence,
} from "./checkoutAbandonmentEvidence.js";
import { summarizePayments } from "./paymentObservabilityEvidence.js";

/**
 * The direct companion for `checkoutAbandonmentEvidence.ts`.
 *
 * ⛔ THE FILENAME IS LOAD-BEARING. `assert-changed-runtime-coverage.ts` resolves
 * a companion by literal path — `${module-without-extension}.test.ts` — so these
 * cases living in the sibling module's suite left the new file reading as
 * uncovered runtime, whatever it actually exercised. The same mechanism caught a
 * sibling evidence module one wave earlier.
 *
 * Both seams are covered on purpose. The collectors are called DIRECTLY, which is
 * what makes this a companion rather than a file that merely happens to import
 * the module; and a subset is re-run through `summarizePayments`, which is the
 * seam the watchdog actually calls, so a detector that works in isolation but is
 * never wired in still fails here.
 *
 * ⛔ NO VENDOR NAMES IN THIS FILE, comments included. It sits under
 * `server/domains/**`, where provider terms are counted by the OSS ratchet, and a
 * mention inside a comment is a token like any other. The one assertion that must
 * name the producing adapter — that the disposition string it writes matches the
 * literal this detector matches — lives in that adapter's own companion under
 * `server/adapters/`, which is excluded from the count and owns the value anyway.
 */

// The disposition literal, spelled out rather than imported from the module under
// test: importing it would make the test agree with the module by construction
// and prove nothing about the string the reconciler actually writes.
const ABANDONED = "abandoned_before_confirmation";

describe("the abandonment collector, called directly", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");

  const runRow = (overrides: Record<string, unknown> = {}) => ({
    payment_attempt_id: "attempt-direct",
    payment_intent_id: "intent-direct",
    provider: "provider-a",
    checked_at: "2026-08-27T11:30:00.000Z",
    payload: { providerPayload: { nonDeclineDisposition: ABANDONED } },
    ...overrides,
  });

  it("reads the disposition and attributes the evidence to the attempt", () => {
    const rows = collectAbandonedBeforeConfirmationEvidence(
      [runRow()] as Parameters<typeof collectAbandonedBeforeConfirmationEvidence>[0],
      new Map([["intent-direct", { id: "intent-direct", status: "failed", order_id: "order-direct" }]]) as Parameters<typeof collectAbandonedBeforeConfirmationEvidence>[1],
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("abandoned_before_confirmation");
    expect(rows[0].paymentAttemptId).toBe("attempt-direct");
    expect(rows[0].orderId).toBe("order-direct");
  });

  it("needs no intent in the map to report the evidence", () => {
    const rows = collectAbandonedBeforeConfirmationEvidence(
      [runRow()] as Parameters<typeof collectAbandonedBeforeConfirmationEvidence>[0],
      new Map(),
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBeNull();
  });
});

describe("the recovery-window collector, called directly", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");
  const hoursAgo = (hours: number) =>
    new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();

  it("reports an order past the window and ignores one inside it", () => {
    const rows = collectPendingPaymentPastRecoveryWindowEvidence(
      [
        { id: "order-old", created_at: hoursAgo(30) },
        { id: "order-fresh", created_at: hoursAgo(2) },
      ],
      [],
      now,
    );
    expect(rows.map((row) => row.orderId)).toEqual(["order-old"]);
  });
});

// ⛔ THE DETECTOR THAT REPLACED AN UNREACHABLE ONE.
//
// The first version of this signal asked "is an acknowledged attempt still
// unconfirmed 45 minutes later". It could never fire, and the arithmetic is
// pinned in `ABANDONED_BEFORE_CONFIRMATION`'s docblock: the reconciliation cron
// claims exactly those attempt statuses, requires exactly those acknowledgement
// columns, becomes eligible at 15-minute staleness and is scheduled by the adopter with a maximum 30-minute lag, and terminalises
// `requires_payment_method` to `failed` — so the row was always closed before
// the window opened, and the terminal write reset the clock on the residue.
//
// What is always observable is what the reconciler CONCLUDED, so this suite is
// written against the durable run payload rather than any age.
describe("payments the reconciler settled because nobody tried to pay them", () => {
  const runNow = new Date("2026-08-27T12:00:00.000Z");

  // ⛔ The nesting is the part that breaks silently. `evidencePayload` stores the
  // provider's `rawPayload` under `providerPayload`, so the disposition lives two
  // levels down; reading the shallow path type-checks and matches nothing.
  // `disposition: null` means "the key is absent from providerPayload" — spelled
  // with null rather than undefined because a default parameter would swallow an
  // explicitly passed undefined and hand the case back its own default.
  function run(overrides: Record<string, unknown> = {}, disposition: string | null = "abandoned_before_confirmation") {
    return {
      payment_attempt_id: "attempt-a",
      payment_intent_id: "intent-a",
      provider: "provider-a",
      provider_payment_id: "provider-ref-a",
      checked_at: "2026-08-27T11:30:00.000Z",
      payload: {
        source: "payment-provider-reconciliation.v0",
        applied: true,
        resultStatus: "failed",
        providerPayload: disposition === null ? {} : { nonDeclineDisposition: disposition },
      },
      ...overrides,
    };
  }

  function abandoned(
    runs: Record<string, unknown>[],
    intents: Record<string, unknown>[] = [{ id: "intent-a", status: "failed", order_id: "order-a" }],
  ) {
    const snapshot = summarizePayments(
      intents as Parameters<typeof summarizePayments>[0],
      [],
      [],
      runNow,
      runs as Parameters<typeof summarizePayments>[4],
    );
    return snapshot.evidence.filter((row) => row.kind === "abandoned_before_confirmation");
  }

  it("reports a run whose durable payload carries the abandonment disposition", () => {
    const rows = abandoned([run()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("reconciler_settled_payment_never_confirmed_by_buyer");
    expect(rows[0].paymentAttemptId).toBe("attempt-a");
    expect(rows[0].orderId).toBe("order-a");
    // Masked like every other provider reference this module emits.
    expect(rows[0].providerPaymentId).not.toBe("provider-ref-a");
  });

  // ⛔ THE REACHABILITY PROOF, stated as a test rather than as prose. A terminal
  // intent is the NORMAL state for this evidence, because the reconciler has by
  // definition already settled the payment. The predicate this replaced required
  // a NON-terminal intent, which is why it could not fire.
  it("fires precisely where the previous age-based predicate could not: on a settled payment", () => {
    for (const status of ["failed", "cancelled", "expired"]) {
      expect(abandoned([run()], [{ id: "intent-a", status, order_id: "order-a" }]), status).toHaveLength(1);
    }
  });

  // Run rows are idempotency-keyed per 30-minute bucket, so one payment leaves
  // several — an observed row per pass plus the apply row. Counting rows instead
  // of attempts would report one buyer as a spike.
  it("counts the buyer once however many run rows the attempt left behind", () => {
    const rows = abandoned([
      run({ checked_at: "2026-08-27T11:00:00.000Z", payload: { providerPayload: { nonDeclineDisposition: "abandoned_before_confirmation" } } }),
      run({ checked_at: "2026-08-27T11:30:00.000Z" }),
      run({ checked_at: "2026-08-27T11:45:00.000Z" }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("counts two different attempts separately", () => {
    const rows = abandoned([
      run(),
      run({ payment_attempt_id: "attempt-b", payment_intent_id: "intent-b" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  // A refusal an issuer actually made is a DIFFERENT fact with its own monitors.
  // Labelling it abandonment would drop a real decline out of the decline count.
  it("ignores a run that carries any other disposition, or none", () => {
    expect(abandoned([run({}, null)])).toHaveLength(0);
    expect(abandoned([run({}, "hard_do_not_retry")])).toHaveLength(0);
    expect(abandoned([run({ payload: {} })])).toHaveLength(0);
    expect(abandoned([run({ payload: null })])).toHaveLength(0);
  });

  // ⛔ The shallow path is the mistake a future reader will make. Asserting the
  // silence keeps the nesting a tested fact rather than a comment.
  it("does not read the disposition from the top level of the payload", () => {
    expect(abandoned([run({
      payload: { nonDeclineDisposition: "abandoned_before_confirmation" },
    })])).toHaveLength(0);
  });

  // A row that cannot be deduped against its siblings would risk the very
  // multiple-count the attempt key exists to prevent.
  it("skips a run with no attempt to attribute it to", () => {
    expect(abandoned([run({ payment_attempt_id: null })])).toHaveLength(0);
  });

  it("reports the evidence even when the intent is not in the snapshot's window", () => {
    const rows = abandoned([run()], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBeNull();
  });

  it("omits the age rather than inventing one when the run has no timestamp", () => {
    expect(abandoned([run({ checked_at: null })])[0].ageSeconds).toBeUndefined();
    expect(abandoned([run()])[0].ageSeconds).toBe(30 * 60);
  });
});

describe("unpaid order past the recovery window", () => {
  const orderNow = new Date("2026-08-27T12:00:00.000Z");
  const hoursAgo = (hours: number) =>
    new Date(orderNow.getTime() - hours * 60 * 60 * 1000).toISOString();

  function pending(
    orders: Record<string, unknown>[],
    intents: Record<string, unknown>[] = [],
  ) {
    const snapshot = summarizePayments(
      intents as Parameters<typeof summarizePayments>[0],
      [],
      [],
      orderNow,
      [],
      new Set<string>(),
      [],
      orders as Parameters<typeof summarizePayments>[7],
    );
    return snapshot.evidence.filter((row) => row.kind === "pending_payment_past_recovery_window");
  }

  it("reports an unpaid order that outlived the 24h recovery rail", () => {
    const rows = pending([{ id: "order-old", created_at: hoursAgo(27) }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe("order-old");
    expect(rows[0].reason).toBe("pending_payment_order_outlived_recovery_reminders");
    expect(rows[0].ageSeconds).toBe(27 * 60 * 60);
  });

  // 26h, not 24h: the two hours of grace keep the signal off a row the 20h
  // reminder may still be working on.
  it("leaves the recovery rail its own window plus grace", () => {
    expect(pending([{ id: "order-fresh", created_at: hoursAgo(25) }])).toHaveLength(0);
  });

  // An order stuck in pending_payment while its money landed is a DIFFERENT and
  // worse defect with its own owner. Saying "nobody chased this buyer" about a
  // buyer who paid is the class of untrue alert this wave exists to stop making.
  it("says nothing about an order whose payment actually succeeded", () => {
    for (const status of ["succeeded", "refunded", "partially_refunded", "disputed"]) {
      expect(pending(
        [{ id: "order-paid", created_at: hoursAgo(50) }],
        [{ id: "intent-paid", status, order_id: "order-paid" }],
      ), status).toHaveLength(0);
    }
  });

  it("still reports an order whose intent is merely unfinished", () => {
    const rows = pending(
      [{ id: "order-stuck", created_at: hoursAgo(50) }],
      [{ id: "intent-stuck", status: "processing", order_id: "order-stuck", subscription_id: "sub-1" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].paymentIntentId).toBe("intent-stuck");
    expect(rows[0].subscriptionId).toBe("sub-1");
  });

  // ⛔ A zero timestamp means the READ dropped the column, not that the order is
  // ancient. Firing here would turn a select-list mistake into a page about
  // every unpaid order in the table.
  it("refuses to treat an unreadable creation time as ancient", () => {
    expect(pending([{ id: "order-nodate" }])).toHaveLength(0);
    expect(pending([{ id: "order-baddate", created_at: "not-a-date" }])).toHaveLength(0);
  });

  it("reports nothing when no order is handed to it", () => {
    expect(pending([])).toHaveLength(0);
  });
});
