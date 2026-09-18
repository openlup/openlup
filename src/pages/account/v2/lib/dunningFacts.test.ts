import { describe, expect, it } from "vitest";

import type {
  CustomerAccountActionRequired,
  CustomerAccountV2Response,
} from "@/domains/customers/accountV2Contracts";
import {
  hasExpiredRecoveryCase,
  hasOpenRecoveryCase,
  selectExpiredArrears,
  selectOpenRecoveryCase,
  selectSubscriptionArrears,
} from "./dunningFacts";

const openCase: CustomerAccountActionRequired = {
  actionId: "subscription:s1:payment_blocked",
  kind: "payment_recovery",
  severity: "critical",
  entityType: "subscription",
  entityId: "s1",
  subscriptionId: "s1",
  orderId: "o1",
  messageCode: "payment_blocked",
  failureCause: "unknown" as const,
  blockedReason: "payment_blocked",
  title: "Payment needs attention",
  body: null,
  cta: "repair_payment",
  recoveryEligible: true,
  dueAt: "2026-07-02T10:00:00.000Z",
  nextRetryAt: "2026-07-01T10:00:00.000Z",
};

// Deliberately not the platform default: the arrears figure has to be denominated by
// whichever record supplied it, so only a non-default value can falsify a constant.
const RECORD_CURRENCY = "EUR";

const subscription = {
  subscriptionId: "s1",
  recurringPrice: {
    subtotalGross: { amountMinor: 18760, currency: RECORD_CURRENCY },
    totalGross: { amountMinor: 18760, currency: RECORD_CURRENCY },
    currency: RECORD_CURRENCY,
    source: "frozen_quote_line",
  },
} as unknown as CustomerAccountV2Response["subscriptions"][number];

function account(
  actionRequired: CustomerAccountActionRequired[],
  recentOrders: Array<{ orderId: string; total: { amountMinor: number; currency: string } }> = [],
): Pick<CustomerAccountV2Response, "actionRequired" | "recentOrders"> {
  return {
    actionRequired,
    recentOrders: recentOrders as unknown as CustomerAccountV2Response["recentOrders"],
  };
}

describe("selectOpenRecoveryCase", () => {
  it("finds the open-case entry for the subscription", () => {
    expect(selectOpenRecoveryCase([openCase], "s1")).toBe(openCase);
    expect(hasOpenRecoveryCase([openCase], "s1")).toBe(true);
  });

  it("ignores an entry belonging to another subscription", () => {
    expect(selectOpenRecoveryCase([openCase], "s2")).toBeNull();
  });

  it("ignores states the server does NOT block self-service on", () => {
    // A failed cycle without a case, and a subscription that simply has no
    // stored method, are different states: the RPC gate reads open cases only.
    for (const messageCode of ["payment_failed", "missing_payment_method"] as const) {
      expect(selectOpenRecoveryCase([{ ...openCase, messageCode }], "s1")).toBeNull();
    }
  });

  it("returns null without a subscription id or without actions", () => {
    expect(selectOpenRecoveryCase([openCase], null)).toBeNull();
    expect(selectOpenRecoveryCase(undefined, "s1")).toBeNull();
    expect(hasOpenRecoveryCase([], "s1")).toBe(false);
  });
});

describe("selectSubscriptionArrears", () => {
  it("takes the amount from the order the case is attached to", () => {
    const arrears = selectSubscriptionArrears(
      account([openCase], [{ orderId: "o1", total: { amountMinor: 13702, currency: "USD" } }]),
      subscription,
    );
    // The currency comes from the SAME record that supplied the amount - the order, not
    // the subscription's frozen price and not the platform default - so a page cannot
    // show one record's number under another's denomination.
    expect(arrears).toEqual({
      orderId: "o1",
      recoveryEligible: true,
      dueAt: "2026-07-02T10:00:00.000Z",
      nextRetryAt: "2026-07-01T10:00:00.000Z",
      amountMinor: 13702,
      currency: "USD",
      failureCause: "unknown",
    });
  });

  it("falls back to the frozen recurring total when the order is out of the window", () => {
    const arrears = selectSubscriptionArrears(account([openCase]), subscription);
    expect(arrears?.amountMinor).toBe(18760);
    expect(arrears?.currency).toBe(RECORD_CURRENCY);
  });

  it("reports no amount rather than inventing one", () => {
    const arrears = selectSubscriptionArrears(account([{ ...openCase, orderId: null }]), {
      subscriptionId: "s1",
      recurringPrice: null,
    } as unknown as CustomerAccountV2Response["subscriptions"][number]);
    expect(arrears?.amountMinor).toBeNull();
    // Both halves absent together: no amount means no currency to state either.
    expect(arrears?.currency).toBeNull();
  });

  it("is null when no case is open", () => {
    expect(selectSubscriptionArrears(account([]), subscription)).toBeNull();
  });

  // An expired case is a different state, and reading it through the open-case
  // selectors would tell the customer that a retry is coming when none is.
  it("keeps the expired case out of the open-case selectors, and the reverse", () => {
    const expiredCase = {
      ...openCase,
      actionId: "subscription:s1:payment_expired",
      messageCode: "payment_expired" as const,
      failureCause: "unknown" as const,
      blockedReason: "payment_expired" as const,
      nextRetryAt: null,
    };
    expect(selectOpenRecoveryCase([expiredCase], "s1")).toBeNull();
    expect(hasOpenRecoveryCase([expiredCase], "s1")).toBe(false);
    expect(hasExpiredRecoveryCase([expiredCase], "s1")).toBe(true);
    expect(hasExpiredRecoveryCase([openCase], "s1")).toBe(false);
  });

  it("derives the same figures for an expired case, with no next attempt", () => {
    const expiredCase = {
      ...openCase,
      messageCode: "payment_expired" as const,
      failureCause: "unknown" as const,
      blockedReason: "payment_expired" as const,
      nextRetryAt: null,
    };
    const arrears = selectExpiredArrears(account([expiredCase]), subscription);
    expect(arrears?.amountMinor).toBe(18760);
    expect(arrears?.nextRetryAt).toBeNull();
    expect(selectSubscriptionArrears(account([expiredCase]), subscription)).toBeNull();
  });
});
