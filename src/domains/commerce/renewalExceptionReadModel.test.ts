import { describe, expect, it } from "vitest";
import type { AdminCommerceRenewalExceptionEvidenceSnapshot, RenewalExceptionTriageContext } from "./renewalExceptionContracts";
import { adminCommerceRenewalExceptionsResponseSchema } from "./renewalExceptionContracts";
import { buildAdminCommerceRenewalExceptionsResponse } from "./renewalExceptionReadModel";

const checkedAt = "2026-07-03T12:00:00.000Z";

describe("renewal exception read model", () => {
  it("projects prepared payment ambiguity and paid fulfillment gaps without provider secrets", () => {
    const evidenceWithSecrets = {
      ...prepared("2026-07-03T11:45:00.000Z", 5000),
      providerPaymentId: "pi_secret_raw",
      providerEventId: "evt_secret_raw",
      reason: "raw provider said something scary",
    };
    const response = buildAdminCommerceRenewalExceptionsResponse(snapshot({
      dueCycleWithoutOrderCount: 2,
      dueCycleEvidence: [
        dueCycle("sub-due-1", 3600),
        dueCycle("sub-due-2", 3500),
      ],
      fulfillmentEvidence: [paidNoFulfillment("order-1", 4000)],
      paymentEvidence: [evidenceWithSecrets],
    }), { page: 1, pageSize: 25 });

    expect(adminCommerceRenewalExceptionsResponseSchema.parse(response)).toMatchObject({
      totalCount: 4,
      summaryCounts: {
        preparedWithoutProviderAck: 1,
        paidRenewalWithoutFulfillment: 1,
        dueCycleWithoutOrder: 2,
      },
    });
    expect(response.exceptions.map((row) => row.kind)).toEqual([
      "prepared_without_provider_ack",
      "paid_renewal_without_fulfillment",
      "due_cycle_without_order",
      "due_cycle_without_order",
    ]);
    expect(response.summarySignals).toEqual([expect.objectContaining({
      kind: "due_cycle_without_order",
      count: 2,
      operatorNextAction: "inspect_subscription_scheduler",
    })]);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("pi_secret_raw");
    expect(serialized).not.toContain("evt_secret_raw");
    expect(serialized).not.toContain("raw provider said");
    expect(serialized).not.toContain("providerPaymentId");
    expect(serialized).not.toContain("providerEventId");
    expect(serialized).not.toContain("client_secret");
    expect(serialized).not.toContain("recovery");
    expect(serialized).not.toContain("paymentMethodRef");
  });

  it("dedupes by local object ids and never uses observedAt in the dedupe key", () => {
    const response = buildAdminCommerceRenewalExceptionsResponse(snapshot({
      paymentEvidence: [
        prepared("2026-07-03T11:45:00.000Z", 900),
        prepared("2026-07-03T11:50:00.000Z", 1200),
      ],
    }), { page: 1, pageSize: 25 });

    expect(response.totalCount).toBe(1);
    expect(response.exceptions[0]?.ageSeconds).toBe(1200);
    expect(response.exceptions[0]?.dedupeKey).toBe(
      "renewal-exception:prepared_without_provider_ack:sub-1:cycle-1:intent-1:attempt-1",
    );
    expect(response.exceptions[0]?.dedupeKey).not.toContain("2026");
  });

  it("paginates deterministic severity and age order", () => {
    const response = buildAdminCommerceRenewalExceptionsResponse(snapshot({
      fulfillmentEvidence: [
        paidNoFulfillment("order-old", 7000),
        paidNoFulfillment("order-new", 9000),
      ],
    }), { page: 2, pageSize: 1 });

    expect(response.totalCount).toBe(2);
    expect(response.exceptions).toEqual([expect.objectContaining({ orderId: "order-old" })]);
  });

  it("carries the recovery baseline through, truncation and mixed currencies included", () => {
    const response = buildAdminCommerceRenewalExceptionsResponse(
      snapshot({ dunningRecovery: baseline() }),
      { page: 1, pageSize: 25 },
    );

    const parsed = adminCommerceRenewalExceptionsResponseSchema.parse(response);
    // Both honesty flags have to survive the projection. A truncated, mixed
    // window that arrives looking clean is worse than no baseline at all.
    expect(parsed.dunningRecovery).toMatchObject({
      truncated: true,
      mixedCurrencies: true,
      recoveryRateByAmount: null,
      byRung: { "1": { recoveryRateByCount: 0.5 } },
      byClass: { unclassified: { opened: { count: 2 } } },
      byRail: { "rail-a": { recoveryRateByCount: 0.5 } },
    });
  });

  it("omits the baseline key entirely when the snapshot carries none", () => {
    const response = buildAdminCommerceRenewalExceptionsResponse(snapshot(), { page: 1, pageSize: 25 });

    // Absent, not null: "the baseline was not computed" must not be expressible
    // as a present field that a reader could mistake for a measured zero.
    expect("dunningRecovery" in response).toBe(false);
    expect(adminCommerceRenewalExceptionsResponseSchema.parse(response).dunningRecovery).toBeUndefined();
  });
});

function baseline(): NonNullable<AdminCommerceRenewalExceptionEvidenceSnapshot["dunningRecovery"]> {
  const cohort = (count: number) => ({ count, amountMinor: count * 12_900 });
  const dimension = {
    opened: cohort(2),
    recovered: cohort(1),
    recoveryRateByCount: 0.5,
    recoveryRateByAmount: null,
  };
  return {
    windowStart: "2026-04-04T12:00:00.000Z",
    windowEnd: checkedAt,
    windowDays: 90,
    truncated: true,
    currency: null,
    mixedCurrencies: true,
    amountsMissing: 0,
    opened: cohort(2),
    recovered: cohort(1),
    expired: cohort(1),
    cancelled: cohort(0),
    resumedUnpaid: cohort(0),
    stillOpen: cohort(0),
    recoveredByAttribution: {
      automaticRetry: cohort(1),
      customerRedeem: cohort(0),
      unattributed: cohort(0),
    },
    recoveryRateByCount: 0.5,
    recoveryRateByAmount: null,
    byRung: { "1": dimension },
    byClass: { unclassified: dimension },
    byRail: { "rail-a": dimension },
  };
}

function prepared(observedAt: string, ageSeconds: number) {
  return {
    kind: "prepared_without_provider_ack" as const,
    provider: "tpay",
    paymentIntentId: "intent-1",
    paymentAttemptId: "attempt-1",
    orderId: null,
    subscriptionId: "sub-1",
    subscriptionCycleId: "cycle-1",
    observedAt,
    ageSeconds,
  };
}

function paidNoFulfillment(orderId: string, ageSeconds: number) {
  return {
    kind: "paid_renewal_without_fulfillment" as const,
    subscriptionId: `sub-${orderId}`,
    subscriptionCycleId: `cycle-${orderId}`,
    orderId,
    ageSeconds,
    observedAt: checkedAt,
    triageContext: paidFulfillmentTriageContext(),
  };
}

function dueCycle(subscriptionId: string, ageSeconds: number) {
  return {
    kind: "due_cycle_without_order" as const,
    subscriptionId,
    nextCycleAt: "2026-07-03T11:00:00.000Z",
    ageSeconds,
    observedAt: checkedAt,
    triageContext: dueCycleTriageContext(),
  };
}

function paidFulfillmentTriageContext(): RenewalExceptionTriageContext {
  return {
    localPaymentStatus: "succeeded",
    subscriptionCycleStatus: "paid",
    orderStatus: "paid",
    outboxStatus: "discarded",
    outboxAvailableAt: "2026-07-03T10:30:00.000Z",
    outboxAttempts: 8,
    fulfillmentEligibilityReason: "order_paid_outbox_discarded",
    fulfillmentRecoveryPosture: "existing_outbox_replay_required",
    lockedCycleSummary: {
      status: "paid",
      scheduledAt: "2026-07-03T10:00:00.000Z",
      nextCycleAt: null,
      templateVersion: 3,
      lineCount: 2,
      totalQuantity: 4,
    },
    futureTemplateSummary: {
      status: "active",
      scheduledAt: null,
      nextCycleAt: "2026-08-03T10:00:00.000Z",
      templateVersion: 4,
      lineCount: 3,
      totalQuantity: 5,
    },
  };
}

function dueCycleTriageContext(): RenewalExceptionTriageContext {
  return {
    localPaymentStatus: null,
    subscriptionCycleStatus: null,
    orderStatus: null,
    outboxStatus: null,
    outboxAvailableAt: null,
    outboxAttempts: null,
    fulfillmentEligibilityReason: "cycle_order_missing",
    fulfillmentRecoveryPosture: "not_retryable",
    lockedCycleSummary: null,
    futureTemplateSummary: {
      status: "active",
      scheduledAt: null,
      nextCycleAt: "2026-07-03T11:00:00.000Z",
      templateVersion: 2,
      lineCount: 1,
      totalQuantity: 1,
    },
  };
}

function snapshot(
  overrides: Partial<AdminCommerceRenewalExceptionEvidenceSnapshot> = {},
): AdminCommerceRenewalExceptionEvidenceSnapshot {
  return {
    checkedAt,
    dueCycleWithoutOrderCount: 0,
    dueCycleEvidence: [],
    paymentEvidence: [],
    fulfillmentEvidence: [],
    ...overrides,
  };
}
