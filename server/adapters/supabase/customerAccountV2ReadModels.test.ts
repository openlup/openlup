import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerAccountV2Response } from "../../../src/domains/customers/accountV2Contracts.js";
import { buildActionRequired } from "./customerAccountActionRequiredReadModel.js";
import {
  computeEditState,
  editCutoff,
  isCustomerVisibleSubscription,
  readSubscriptionBlockers,
  recurringPrice,
} from "./customerAccountV2ReadModels.js";

const now = "2026-06-13T10:00:00+00:00";
const subscriptionId = "11111111-1111-4111-8111-111111111111";
// Deliberately not the platform default: `recurringPrice` must denominate its sum from
// the lines it summed, so only a non-default value can falsify a re-asserted constant.
const LINE_CURRENCY = "EUR";
const orderId = "22222222-2222-4222-8222-222222222222";

describe("customer account v2 read model actionRequired", () => {
  it("maps open payment recovery state to customer-safe action-required data", () => {
    const actions = buildActionRequired(
      [subscription({ paymentMethodKind: "card" })],
      [],
      new Map([
        [
          subscriptionId,
          {
            subscriptionId,
            orderId,
            blockedReason: "payment_blocked",
            failureCause: "unknown" as const,
            recoveryEligible: true,
            dueAt: now,
            nextRetryAt: now,
          },
        ],
      ]),
    );

    expect(actions).toEqual([
      expect.objectContaining({
        actionId: `subscription:${subscriptionId}:payment_blocked`,
        kind: "payment_recovery",
        severity: "critical",
        entityType: "subscription",
        entityId: subscriptionId,
        subscriptionId,
        orderId,
        messageCode: "payment_blocked",
        failureCause: "unknown" as const,
        blockedReason: "payment_blocked",
        cta: "repair_payment",
        recoveryEligible: true,
        nextRetryAt: now,
      }),
    ]);
    expect(JSON.stringify(actions)).not.toMatch(/token|provider|pm_|cus_/i);
  });

  it("surfaces missing subscription payment method without provider data", () => {
    const actions = buildActionRequired([subscription({ paymentMethodKind: null, paymentMethodStatus: "missing" })], []);

    expect(actions[0]).toMatchObject({
      kind: "payment_method_missing",
      severity: "warning",
      messageCode: "missing_payment_method",
      failureCause: "unknown" as const,
      blockedReason: "missing_payment_method",
      cta: "contact_support",
      recoveryEligible: false,
    });
  });

  it("surfaces revoked subscription payment method even when legacy kind is still mirrored", () => {
    const actions = buildActionRequired([subscription({ paymentMethodKind: "card", paymentMethodStatus: "revoked" })], []);

    expect(actions[0]).toMatchObject({
      kind: "payment_method_missing",
      messageCode: "missing_payment_method",
      cta: "contact_support",
    });
  });

  it("derives the edit cutoff 72h before the next cycle by default", () => {
    // Default (null column) falls back to the 72h edit window.
    expect(editCutoff("2026-09-01T00:00:00.000Z", null)).toBe("2026-08-29T00:00:00.000Z");
    // An explicit per-subscription window still governs when present.
    expect(editCutoff("2026-09-01T00:00:00.000Z", 72)).toBe("2026-08-29T00:00:00.000Z");
    expect(editCutoff("2026-09-01T00:00:00.000Z", 24)).toBe("2026-08-31T00:00:00.000Z");
    expect(editCutoff(null, null)).toBeNull();
  });

  it("computes customer-safe subscription edit blockers from RPC-aligned evidence", () => {
    expect(computeEditState(eligibility({ status: "paused" })).reason).toBe("not_active");
    expect(computeEditState(eligibility(), new Map([[subscriptionId, "payment_blocked"]])).reason).toBe("payment_blocked");
    expect(computeEditState(eligibility(), new Map([[subscriptionId, "cycle_locked"]])).reason).toBe("cycle_locked");
    expect(computeEditState(eligibility({ paymentMethodRefPresent: false })).reason).toBe("missing_payment_method");
    expect(computeEditState(eligibility({ paymentMethodStatus: "revoked" })).reason).toBe("missing_payment_method");
    expect(computeEditState(eligibility({ paymentMethodStatus: "expiring" }))).toEqual({ canEdit: true, reason: null });
    expect(computeEditState(eligibility({ editCutoffAt: "2020-01-01T10:00:00+00:00" })).reason).toBe("edit_window_closed");
    expect(computeEditState(eligibility())).toEqual({ canEdit: true, reason: null });
  });

  it("sums the frozen recurring price only when every line is priced", () => {
    // The sum is denominated by the LINES, not by the platform default: this is the
    // number a customer is told they will next be charged, and it is built entirely from
    // prices frozen when they agreed to them.
    expect(recurringPrice([line(12900), line(4100)])).toMatchObject({
      subtotalGross: { amountMinor: 17000, currency: LINE_CURRENCY },
      totalGross: { amountMinor: 17000, currency: LINE_CURRENCY },
      currency: LINE_CURRENCY,
      source: "frozen_quote_line",
    });
  });

  it("fails closed when any line lacks a frozen subtotal the renewal engine could charge", () => {
    // Mixed: a partial sum would claim a price renewal would refuse to charge.
    expect(recurringPrice([line(12900), line(null)])).toBeNull();
    expect(recurringPrice([line(12900), line(undefined)])).toBeNull();
    // No line priced, and no lines at all, stay null as before.
    expect(recurringPrice([line(null), line(null)])).toBeNull();
    expect(recurringPrice([])).toBeNull();
    // Two currencies are not summable: there is no rate here, so the honest answer is
    // the same "unpriced" one a missing amount already gets, not a plausible total.
    expect(recurringPrice([line(12900), line(4100, "USD")])).toBeNull();
  });

  it("scopes cycle locks to the upcoming cycle instead of historical paid cycles", async () => {
    const historicalOnly = await readSubscriptionBlockers(
      serviceClient({
        subscription_cycles: [{ id: "cycle-old", subscription_id: subscriptionId, scheduled_at: "2026-05-01T10:00:00+00:00", status: "paid" }],
        subscription_dunning_cases: [],
        commerce_orders: [],
      }),
      [subscriptionId],
      new Map([[subscriptionId, now]]),
    );
    const upcoming = await readSubscriptionBlockers(
      serviceClient({
        subscription_cycles: [{ id: "cycle-next", subscription_id: subscriptionId, scheduled_at: now, status: "payment_pending" }],
        subscription_dunning_cases: [],
        commerce_orders: [{ subscription_id: subscriptionId, subscription_cycle_id: "cycle-next", status: "paid" }],
      }),
      [subscriptionId],
      new Map([[subscriptionId, now]]),
    );

    expect(historicalOnly.has(subscriptionId)).toBe(false);
    expect(upcoming.get(subscriptionId)).toBe("cycle_locked");
  });
});

describe("customer-visible subscription rule", () => {
  it("shows every live status the account surface can act on", () => {
    expect(isCustomerVisibleSubscription({ status: "active" })).toBe(true);
    expect(isCustomerVisibleSubscription({ status: "paused" })).toBe(true);
    // pending_activation carries the complete-payment CTA, so it must stay visible
    // even though it has no usable payment method yet.
    expect(isCustomerVisibleSubscription({ status: "pending_activation" })).toBe(true);
  });

  it("keeps a customer-cancelled subscription for the win-back path", () => {
    expect(
      isCustomerVisibleSubscription({ status: "cancelled", cancellation_source: "customer_self_service" }),
    ).toBe(true);
  });

  it("hides sweep-cancelled abandoned-checkout ghosts that can never reactivate", () => {
    // Production shape: cancelled by subscription.sweep.v0 with no cancellation_source
    // and no stored payment method - reactivate always fails.
    expect(isCustomerVisibleSubscription({ status: "cancelled", cancellation_source: null })).toBe(false);
    expect(isCustomerVisibleSubscription({ status: "cancelled" })).toBe(false);
  });

  it("hides system-sourced cancellations", () => {
    expect(isCustomerVisibleSubscription({ status: "cancelled", cancellation_source: "system_sweep" })).toBe(false);
    expect(isCustomerVisibleSubscription({ status: "cancelled", cancellation_source: "system_dunning" })).toBe(false);
  });

  it("hides terminal statuses with no customer action", () => {
    expect(isCustomerVisibleSubscription({ status: "activation_failed" })).toBe(false);
    expect(isCustomerVisibleSubscription({ status: "completed" })).toBe(false);
  });
});

function subscription(
  patch: Partial<CustomerAccountV2Response["subscriptions"][number]> = {},
): CustomerAccountV2Response["subscriptions"][number] {
  return {
    subscriptionId,
    petId: null,
    shippingAddressId: null,
    status: "active",
    pausePreset: null,
    pauseStartedAt: null,
    pauseEndsAt: null,
    cadenceDays: 28,
    nextCycleAt: now,
    editCutoffAt: now,
    canEditUpcomingPackage: true,
    editBlockedReason: null,
    paymentMethodKind: "card",
    paymentMethodStatus: "usable",
    templateVersion: 1,
    sizeConstraint: null,
    packageSummary: "1 recipe",
    recurringPrice: null,
    lines: [],
    ...patch,
  };
}

// recurringPrice reads only `lineSubtotal.amountMinor`. The rest of the line
// contract is asserted by the schema tests, and spelling it out here would add
// neutrality-scanned vocabulary (scripts/oss-readiness.test.ts freezes those
// counts) for no proof value - hence the narrow fixture and the cast.
/**
 * A subscription line whose frozen subtotal carries **its own** currency, because that
 * is what the read model stores: a `commerceMoneySchema` object, amount and denomination
 * together. The default is deliberately not the platform's, so a `recurringPrice` that
 * went back to asserting one would fail these cases instead of passing them.
 */
function line(
  amountMinor: number | null | undefined,
  currency = LINE_CURRENCY,
): CustomerAccountV2Response["subscriptions"][number]["lines"][number] {
  return {
    lineId: "33333333-3333-4333-8333-333333333333",
    variantId: "44444444-4444-4444-8444-444444444444",
    qty: 1,
    sortOrder: 0,
    isAddon: false,
    lineSubtotal: typeof amountMinor === "number" ? { amountMinor, currency } : amountMinor,
  } as CustomerAccountV2Response["subscriptions"][number]["lines"][number];
}

function eligibility(
  patch: Partial<Parameters<typeof computeEditState>[0]> = {},
): Parameters<typeof computeEditState>[0] {
  return {
    subscriptionId,
    status: "active",
    nextCycleAt: now,
    editCutoffAt: "2099-06-13T10:00:00+00:00",
    paymentMethodKind: "card",
    paymentMethodRefPresent: true,
    ...patch,
  };
}

function serviceClient(rows: Record<string, Record<string, unknown>[]>): SupabaseClient {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        in: () => builder,
        eq: () => builder,
        then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: rows[table] ?? [], error: null }));
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}
