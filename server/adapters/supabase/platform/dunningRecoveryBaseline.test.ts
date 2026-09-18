import { describe, expect, it } from "vitest";
import {
  collectDunningRecoveryBaseline,
  createDunningRecoveryBaselineReader,
  DEFAULT_RECOVERY_CASE_LIMIT,
  DEFAULT_RECOVERY_WINDOW_DAYS,
  summarizeDunningRecoveryBaseline,
  type DunningRecoveryAmountRow,
  type DunningRecoveryCaseRow,
} from "./dunningRecoveryBaseline.js";

const NOW = new Date("2026-06-06T10:00:00.000Z");
const WINDOW_START = "2026-03-08T10:00:00.000Z";
const TEST_CURRENCY = "XTS";

describe("dunning recovery baseline", () => {
  it("splits the opened cohort into recovered, expired and still-open with amounts", () => {
    const baseline = summarize([
      caseRow({ id: "c-1", status: "recovered", metadata: { recoveredVia: "payment.control.apply_result" } }),
      caseRow({ id: "c-2", status: "recovered", metadata: { source: "subscription.recovery.hidden.v0" } }),
      caseRow({ id: "c-3", status: "recovered", metadata: {} }),
      caseRow({ id: "c-4", status: "expired" }),
      caseRow({ id: "c-5", status: "open" }),
      caseRow({ id: "c-6", status: "cancelled" }),
      caseRow({ id: "c-7", status: "resumed_unpaid" }),
    ]);

    expect(baseline.opened).toEqual({ count: 7, amountMinor: 7 * 12_900 });
    expect(baseline.recovered).toEqual({ count: 3, amountMinor: 3 * 12_900 });
    expect(baseline.expired).toEqual({ count: 1, amountMinor: 12_900 });
    expect(baseline.cancelled).toEqual({ count: 1, amountMinor: 12_900 });
    expect(baseline.resumedUnpaid).toEqual({ count: 1, amountMinor: 12_900 });
    expect(baseline.stillOpen).toEqual({ count: 1, amountMinor: 12_900 });
    expect(baseline.recoveredByAttribution).toEqual({
      automaticRetry: { count: 1, amountMinor: 12_900 },
      customerRedeem: { count: 1, amountMinor: 12_900 },
      unattributed: { count: 1, amountMinor: 12_900 },
    });
    expect(baseline.currency).toBe(TEST_CURRENCY);
  });

  it("counts still-open cases against the rate instead of hiding them", () => {
    // The denominator is every case opened in the window. Two recovered out of
    // four opened is 0.5 even though only three cases have resolved - a rate
    // computed over resolved cases only would read 0.667 and flatter itself.
    const baseline = summarize([
      caseRow({ id: "c-1", status: "recovered" }),
      caseRow({ id: "c-2", status: "recovered" }),
      caseRow({ id: "c-3", status: "expired" }),
      caseRow({ id: "c-4", status: "open" }),
    ]);
    expect(baseline.recoveryRateByCount).toBe(0.5);
    expect(baseline.recoveryRateByAmount).toBe(0.5);
    expect(baseline.stillOpen.count).toBe(1);
  });

  it("counts a cancellation against the rate rather than dropping it from the denominator", () => {
    // A subscription cancelled while its dunning case was open closes that case
    // as `cancelled` (migration 20260721200002). That is money that entered
    // dunning and did not come back, so it belongs in the denominator; leaving
    // it out would report 1.0 here instead of 0.5.
    const resolved = summarize([
      caseRow({ id: "c-1", status: "recovered" }),
      caseRow({ id: "c-2", status: "cancelled" }),
    ]);
    expect(resolved.recoveryRateByCount).toBe(0.5);
    expect(resolved.recoveryRateByAmount).toBe(0.5);
    expect(resolved.cancelled.count).toBe(1);
    expect(resolved.stillOpen.count).toBe(0);

    const withoutCancellation = summarize([caseRow({ id: "c-1", status: "recovered" })]);
    expect(withoutCancellation.recoveryRateByCount).toBe(1);
  });

  it("keeps an unrecognised status out of the recovered cohort", () => {
    // Defensive, not speculative: an unknown status depresses the rate instead
    // of quietly counting as a recovery.
    const baseline = summarize([
      caseRow({ id: "c-1", status: "recovered" }),
      caseRow({ id: "c-2", status: "some_future_status" }),
    ]);
    expect(baseline.recovered.count).toBe(1);
    expect(baseline.stillOpen.count).toBe(1);
    expect(baseline.recoveryRateByCount).toBe(0.5);
  });

  it("returns null rates for an empty window instead of dividing by zero", () => {
    const baseline = summarize([]);
    expect(baseline.recoveryRateByCount).toBeNull();
    expect(baseline.recoveryRateByAmount).toBeNull();
    expect(baseline.opened).toEqual({ count: 0, amountMinor: 0 });
    expect(baseline.cancelled).toEqual({ count: 0, amountMinor: 0 });
    expect(baseline.currency).toBeNull();
    expect(baseline.truncated).toBe(false);
  });

  it("keeps unresolved amounts out of the money figures and names how many", () => {
    const baseline = summarizeDunningRecoveryBaseline({
      cases: [
        caseRow({ id: "c-1", status: "recovered" }),
        caseRow({ id: "c-2", status: "expired", payment_intent_id: "intent-missing" }),
      ],
      amounts: [{ id: "intent-c-1", amount_cents: 12_900, currency: TEST_CURRENCY }],
      windowStart: WINDOW_START,
      windowEnd: NOW.toISOString(),
      windowDays: DEFAULT_RECOVERY_WINDOW_DAYS,
      caseLimit: DEFAULT_RECOVERY_CASE_LIMIT,
    });
    expect(baseline.amountsMissing).toBe(1);
    expect(baseline.opened).toEqual({ count: 2, amountMinor: 12_900 });
    expect(baseline.recoveryRateByCount).toBe(0.5);
    expect(baseline.recoveryRateByAmount).toBe(1);
  });

  it("refuses an amount rate across mixed currencies and flags the window", () => {
    const baseline = summarizeDunningRecoveryBaseline({
      cases: [caseRow({ id: "c-1", status: "recovered" }), caseRow({ id: "c-2", status: "expired" })],
      amounts: [
        { id: "intent-c-1", amount_cents: 12_900, currency: TEST_CURRENCY },
        { id: "intent-c-2", amount_cents: 4_900, currency: "XTC" },
      ],
      windowStart: WINDOW_START,
      windowEnd: NOW.toISOString(),
      windowDays: DEFAULT_RECOVERY_WINDOW_DAYS,
      caseLimit: DEFAULT_RECOVERY_CASE_LIMIT,
    });
    expect(baseline.mixedCurrencies).toBe(true);
    expect(baseline.currency).toBeNull();
    expect(baseline.recoveryRateByAmount).toBeNull();
    expect(baseline.recoveryRateByCount).toBe(0.5);
  });

  it("marks the window truncated when the read filled its cap", () => {
    const baseline = summarizeDunningRecoveryBaseline({
      cases: [caseRow({ id: "c-1", status: "recovered" }), caseRow({ id: "c-2", status: "expired" })],
      amounts: [],
      windowStart: WINDOW_START,
      windowEnd: NOW.toISOString(),
      windowDays: DEFAULT_RECOVERY_WINDOW_DAYS,
      caseLimit: 2,
    });
    expect(baseline.truncated).toBe(true);
  });
  // A subscription resumed after its case expired did NOT pay the cycle that
  // failed: the rail skips it. Counting that case as `recovered` would report
  // never-collected money inside the by-amount rate, which is the whole reason
  // the rail closes it as `resumed_unpaid`.
  it("counts a resumed-unpaid case against the rate, never as recovered volume", () => {
    const baseline = summarize([
      caseRow({ id: "c-1", status: "recovered" }),
      caseRow({ id: "c-2", status: "resumed_unpaid" }),
    ]);

    expect(baseline.recovered).toEqual({ count: 1, amountMinor: 12_900 });
    expect(baseline.resumedUnpaid).toEqual({ count: 1, amountMinor: 12_900 });
    expect(baseline.stillOpen).toEqual({ count: 0, amountMinor: 0 });
    expect(baseline.recoveryRateByCount).toBe(0.5);
    expect(baseline.recoveryRateByAmount).toBe(0.5);
  });

  it("slices the window by retry rung, each rung keeping the opened denominator", () => {
    const baseline = summarize([
      caseRow({ id: "c-1", status: "recovered", retry_attempt: 1 }),
      caseRow({ id: "c-2", status: "recovered", retry_attempt: 1 }),
      caseRow({ id: "c-3", status: "expired", retry_attempt: 1 }),
      caseRow({ id: "c-4", status: "recovered", retry_attempt: 2 }),
      caseRow({ id: "c-5", status: "open", retry_attempt: 2 }),
      caseRow({ id: "c-6", status: "expired", retry_attempt: 3 }),
    ]);

    expect(Object.keys(baseline.byRung).sort()).toEqual(["1", "2", "3"]);
    expect(baseline.byRung["1"]).toEqual({
      opened: { count: 3, amountMinor: 3 * 12_900 },
      recovered: { count: 2, amountMinor: 2 * 12_900 },
      recoveryRateByCount: 2 / 3,
      recoveryRateByAmount: 2 / 3,
    });
    // The still-open case at rung 2 counts against that rung exactly as it counts
    // against the window: half, not the 1.0 a resolved-only denominator would show.
    expect(baseline.byRung["2"]?.recoveryRateByCount).toBe(0.5);
    expect(baseline.byRung["3"]?.recoveryRateByCount).toBe(0);
  });

  it("names a rung it cannot read rather than dropping the case from every rung", () => {
    const baseline = summarize([
      caseRow({ id: "c-1", status: "recovered", retry_attempt: 1 }),
      caseRow({ id: "c-2", status: "expired" }),
    ]);

    expect(baseline.byRung["unknown"]).toMatchObject({ opened: { count: 1 }, recoveryRateByCount: 0 });
    // The slices still add back up to the window. A dropped case would leave the
    // rungs summing to less than `opened` while every visible rate looked fine.
    expect(sumOpened(baseline.byRung)).toBe(baseline.opened.count);
  });

  it("keeps cases opened before the class column under one unclassified key", () => {
    const baseline = summarize([
      caseRow({ id: "c-1", status: "recovered", failure_class: "soft_retryable" }),
      caseRow({ id: "c-2", status: "expired", failure_class: "soft_retryable" }),
      caseRow({ id: "c-3", status: "recovered", failure_class: "mandate_dead" }),
      caseRow({ id: "c-4", status: "expired" }),
      caseRow({ id: "c-5", status: "expired", failure_class: null }),
    ]);

    expect(Object.keys(baseline.byClass).sort()).toEqual(["mandate_dead", "soft_retryable", "unclassified"]);
    expect(baseline.byClass["soft_retryable"]?.recoveryRateByCount).toBe(0.5);
    expect(baseline.byClass["mandate_dead"]?.recoveryRateByCount).toBe(1);
    // Both class-less cases land together. The pre-column epoch is visible as a
    // cohort rather than quietly shrinking the classified denominators.
    expect(baseline.byClass["unclassified"]?.opened.count).toBe(2);
    expect(sumOpened(baseline.byClass)).toBe(baseline.opened.count);
  });

  it("reads the rail from the embedded payment row, as an object or as an array", () => {
    const baseline = summarizeWithRails(
      [
        caseRow({ id: "c-1", status: "recovered" }),
        caseRow({ id: "c-2", status: "expired" }),
        caseRow({ id: "c-3", status: "recovered" }),
      ],
      { "c-1": { provider: "rail-a" }, "c-2": { provider: "rail-a" }, "c-3": [{ provider: "rail-b" }] },
    );

    expect(baseline.byRail["rail-a"]?.recoveryRateByCount).toBe(0.5);
    expect(baseline.byRail["rail-b"]?.recoveryRateByCount).toBe(1);
  });

  it("names an unreadable rail instead of inventing one", () => {
    const baseline = summarizeWithRails(
      [
        caseRow({ id: "c-1", status: "recovered" }),
        caseRow({ id: "c-2", status: "expired" }),
        caseRow({ id: "c-3", status: "expired" }),
      ],
      { "c-1": { provider: "rail-a" }, "c-2": null, "c-3": { provider: "" } },
    );

    expect(baseline.byRail["unknown"]?.opened.count).toBe(2);
    expect(sumOpened(baseline.byRail)).toBe(baseline.opened.count);
  });

  it("refuses a per-slice money rate across mixed currencies, as the window does", () => {
    const baseline = summarizeDunningRecoveryBaseline({
      cases: [
        caseRow({ id: "c-1", status: "recovered", retry_attempt: 1 }),
        caseRow({ id: "c-2", status: "expired", retry_attempt: 1 }),
      ],
      amounts: [
        { id: "intent-c-1", amount_cents: 12_900, currency: TEST_CURRENCY },
        { id: "intent-c-2", amount_cents: 9_900, currency: "XTC" },
      ],
      windowStart: WINDOW_START,
      windowEnd: NOW.toISOString(),
      windowDays: DEFAULT_RECOVERY_WINDOW_DAYS,
      caseLimit: DEFAULT_RECOVERY_CASE_LIMIT,
    });

    // Decided window-wide, not per slice: this rung holds both currencies, but a
    // rung that happened to hold one would still refuse, because a money rate
    // that cannot be added to its neighbours is not a comparison.
    expect(baseline.mixedCurrencies).toBe(true);
    expect(baseline.byRung["1"]?.recoveryRateByAmount).toBeNull();
    expect(baseline.byRung["1"]?.recoveryRateByCount).toBe(0.5);
  });

  it("reports no slices at all for an empty window rather than empty-keyed ones", () => {
    const baseline = summarize([]);

    expect(baseline.byRung).toEqual({});
    expect(baseline.byClass).toEqual({});
    expect(baseline.byRail).toEqual({});
  });
});

describe("dunning recovery baseline collection", () => {
  it("derives the window from the injected clock and reads each intent once", async () => {
    const readWindows: string[] = [];
    const readIds: Array<readonly string[]> = [];
    const baseline = await collectDunningRecoveryBaseline({
      casesOpenedSince: (windowStart, limit) => {
        readWindows.push(`${windowStart}|${limit}`);
        return Promise.resolve([
          caseRow({ id: "c-1", status: "recovered", payment_intent_id: "intent-shared" }),
          caseRow({ id: "c-2", status: "expired", payment_intent_id: "intent-shared" }),
        ]);
      },
      amountsByPaymentIntentId: (ids) => {
        readIds.push(ids);
        return Promise.resolve([{ id: "intent-shared", amount_cents: 1_000, currency: TEST_CURRENCY }]);
      },
    }, { now: NOW });

    expect(readWindows).toEqual([`${WINDOW_START}|${DEFAULT_RECOVERY_CASE_LIMIT}`]);
    expect(readIds).toEqual([["intent-shared"]]);
    expect(baseline.windowEnd).toBe(NOW.toISOString());
    expect(baseline.windowDays).toBe(DEFAULT_RECOVERY_WINDOW_DAYS);
    expect(baseline.recoveryRateByAmount).toBe(0.5);
  });

  it("skips the amount read entirely when no case names an intent", async () => {
    let amountReads = 0;
    const baseline = await collectDunningRecoveryBaseline({
      casesOpenedSince: () => Promise.resolve([caseRow({ id: "c-1", status: "open", payment_intent_id: null })]),
      amountsByPaymentIntentId: () => {
        amountReads += 1;
        return Promise.resolve([]);
      },
    }, { now: NOW, windowDays: 30 });

    expect(amountReads).toBe(0);
    expect(baseline.windowStart).toBe("2026-05-07T10:00:00.000Z");
    expect(baseline.amountsMissing).toBe(1);
  });

  it("chunks the keyed amount read so no request URL carries every identifier", async () => {
    const chunkSizes: number[] = [];
    const reader = createDunningRecoveryBaselineReader(recordingClient(chunkSizes));
    const rows = await reader.amountsByPaymentIntentId(Array.from({ length: 450 }, (_, index) => `intent-${index}`));
    expect(chunkSizes).toEqual([200, 200, 50]);
    expect(rows).toHaveLength(3);
  });
});

function summarize(cases: DunningRecoveryCaseRow[]) {
  const amounts: DunningRecoveryAmountRow[] = cases.map((row) => ({
    id: String(row.payment_intent_id),
    amount_cents: 12_900,
    currency: TEST_CURRENCY,
  }));
  return summarizeDunningRecoveryBaseline({
    cases,
    amounts,
    windowStart: WINDOW_START,
    windowEnd: NOW.toISOString(),
    windowDays: DEFAULT_RECOVERY_WINDOW_DAYS,
    caseLimit: DEFAULT_RECOVERY_CASE_LIMIT,
  });
}

/** Same as `summarize`, with a rail embed attached per case id. */
function summarizeWithRails(
  cases: DunningRecoveryCaseRow[],
  rails: Record<string, DunningRecoveryAmountRow["rail"]>,
) {
  return summarizeDunningRecoveryBaseline({
    cases,
    amounts: cases.map((row) => ({
      id: String(row.payment_intent_id),
      amount_cents: 12_900,
      currency: TEST_CURRENCY,
      rail: rails[row.id],
    })),
    windowStart: WINDOW_START,
    windowEnd: NOW.toISOString(),
    windowDays: DEFAULT_RECOVERY_WINDOW_DAYS,
    caseLimit: DEFAULT_RECOVERY_CASE_LIMIT,
  });
}

/** Every breakdown must re-sum to the window it was cut from. */
function sumOpened(breakdown: Record<string, { opened: { count: number } }>): number {
  return Object.values(breakdown).reduce((total, entry) => total + entry.opened.count, 0);
}

function caseRow(overrides: Partial<DunningRecoveryCaseRow> & { id: string }): DunningRecoveryCaseRow {
  return {
    status: "open",
    opened_at: "2026-05-01T00:00:00.000Z",
    payment_intent_id: `intent-${overrides.id}`,
    ...overrides,
  };
}

function recordingClient(chunkSizes: number[]) {
  const builder: Record<string, unknown> = {
    then(resolve: (value: { data: unknown[]; error: null }) => void) {
      resolve({ data: [{ id: "intent-0", amount_cents: 1, currency: TEST_CURRENCY }], error: null });
    },
  };
  for (const method of ["select", "eq", "gte", "limit", "lte", "not", "order", "range"]) {
    builder[method] = () => builder;
  }
  builder.in = (_column: string, values: unknown[]) => {
    chunkSizes.push(values.length);
    return builder;
  };
  return { from: () => builder } as never;
}
