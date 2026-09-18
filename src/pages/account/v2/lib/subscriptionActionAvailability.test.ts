import { describe, expect, it } from "vitest";

import type { Subscription } from "./subscriptionEditModel";
import {
  subscriptionActionAvailability,
  type SubscriptionUiAction,
} from "./subscriptionActionAvailability";

const editable = {
  subscriptionId: "s1",
  status: "active",
  canEditUpcomingPackage: true,
  editBlockedReason: null,
} as unknown as Subscription;

/** A subscription paused while its recovery case is open: the server answers
 * `not_active` on the edit-blocked field, which is exactly why the UI cannot
 * gate on that field. */
const pausedInRecovery = {
  subscriptionId: "s1",
  status: "paused",
  canEditUpcomingPackage: false,
  editBlockedReason: "not_active",
} as unknown as Subscription;

const BLOCKED_BY_THE_SERVER: SubscriptionUiAction[] = [
  "edit",
  "manage_addons",
  "reschedule",
  "skip",
  "order_now",
  "pause",
  "resume",
  "reactivate",
];

describe("subscriptionActionAvailability without a recovery case", () => {
  it("keeps the edit-window actions enabled for an editable subscription", () => {
    for (const action of ["edit", "manage_addons", "reschedule", "skip", "order_now"] as const) {
      expect(subscriptionActionAvailability(editable, action).enabled).toBe(true);
    }
  });

  it("reports the edit-window reason without inventing a payment one", () => {
    const closed = {
      ...editable,
      canEditUpcomingPackage: false,
      editBlockedReason: "edit_window_closed",
    } as unknown as Subscription;
    const availability = subscriptionActionAvailability(closed, "edit");
    expect(availability).toEqual({
      visible: true,
      enabled: false,
      reason: "edit_window_closed",
      reasonKey: "account:dashboard.subscriptionV2.blocked.editWindowClosed",
      recoveryCta: false,
    });
  });

  it("hides order-now for a non-active subscription and leaves lifecycle actions alone", () => {
    expect(subscriptionActionAvailability(pausedInRecovery, "order_now").visible).toBe(false);
    for (const action of ["pause", "resume", "cancel", "change_address", "reactivate"] as const) {
      const availability = subscriptionActionAvailability(pausedInRecovery, action);
      expect(availability.enabled).toBe(true);
      expect(availability.reasonKey).toBeNull();
    }
  });
});

describe("subscriptionActionAvailability with an open recovery case", () => {
  it("refuses every action the RPC refuses, naming the payment reason", () => {
    for (const action of BLOCKED_BY_THE_SERVER) {
      const availability = subscriptionActionAvailability(pausedInRecovery, action, {
        paymentBlocked: true,
      });
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toBe("payment_blocked");
      expect(availability.reasonKey).toBe(
        "account:dashboard.subscriptionV2.blocked.paymentBlocked",
      );
      expect(availability.recoveryCta).toBe(true);
    }
  });

  it("keeps cancel and change-address enabled, because the server still accepts them", () => {
    // Greying these out would trap a customer inside a subscription they are
    // trying to leave. Cancel is handled ahead of the dunning guard and closes
    // the case; change-address is explicitly excluded from the guard.
    for (const action of ["cancel", "change_address"] as const) {
      const availability = subscriptionActionAvailability(pausedInRecovery, action, {
        paymentBlocked: true,
      });
      expect(availability.enabled).toBe(true);
      expect(availability.reasonKey).toBeNull();
    }
  });

  it("does not change the verdict of an editable subscription when the flag is false", () => {
    for (const action of BLOCKED_BY_THE_SERVER) {
      expect(subscriptionActionAvailability(editable, action, { paymentBlocked: false })).toEqual(
        subscriptionActionAvailability(editable, action),
      );
    }
  });

  // --- terminal-expired case ------------------------------------------------
  // The state this wave exists for: the case is spent, the subscription is
  // paused, and a plain Resume used to succeed and leave the subscription
  // active but permanently unchargeable. The RPC now refuses it without a
  // chargeable stored method, so the UI must refuse it too.
  it("offers resume only when the stored method can be charged unattended", () => {
    const withMethod = (paymentMethodStatus: string | null) =>
      ({ ...pausedInRecovery, paymentMethodStatus } as unknown as Subscription);

    for (const status of ["usable", "expiring"]) {
      const availability = subscriptionActionAvailability(withMethod(status), "resume", {
        paymentExpired: true,
      });
      expect(availability.enabled).toBe(true);
      expect(availability.recoveryCta).toBe(false);
      expect(availability.reasonKey).toContain("expiredResumeReady");
    }

    for (const status of ["revoked", "missing", "invalid", null]) {
      const availability = subscriptionActionAvailability(withMethod(status), "resume", {
        paymentExpired: true,
      });
      expect(availability.enabled).toBe(false);
      expect(availability.recoveryCta).toBe(true);
      expect(availability.reasonKey).toContain("expiredResumeNeedsMethod");
    }
  });

  // ⛔ CHARACTERIZATION, and a deliberate limit rather than a claim. The account
  // payload carries `paymentMethodStatus`, which is derived from the method
  // row's status, active flag and expiry alone. It has never carried the stored
  // mandate's autopayment model, so this verdict cannot answer "can this be
  // charged with nobody present" and does not pretend to: the server's
  // subscription_method_chargeable_unattended is the authority, and the resume
  // RPC refuses with `resume_method_not_chargeable`, which RecoverPaymentPage
  // already renders. The pin exists so nobody upgrades this optimistic ENABLE
  // into a rendered health badge without plumbing the mandate fact first.
  it("decides resume from method status alone and never claims mandate health", () => {
    const usableButMandateUnknown = {
      ...pausedInRecovery,
      paymentMethodStatus: "usable",
    } as unknown as Subscription;

    const availability = subscriptionActionAvailability(usableButMandateUnknown, "resume", {
      paymentExpired: true,
    });

    expect(availability.enabled).toBe(true);
    expect(availability.reason).toBeNull();
    // No health vocabulary is produced here: the only strings this path emits
    // are the two resume keys, neither of which asserts a chargeable mandate.
    expect(availability.reasonKey).toContain("expiredResumeReady");
    expect(Object.keys(availability)).not.toContain("methodHealth");
  });

  it("keeps cancel and change-address open, and everything else shut, on an expired case", () => {
    for (const action of ["cancel", "change_address"] as const) {
      expect(subscriptionActionAvailability(pausedInRecovery, action, { paymentExpired: true }).enabled)
        .toBe(true);
    }
    for (const action of ["edit", "manage_addons", "reschedule", "skip", "pause"] as const) {
      const availability = subscriptionActionAvailability(pausedInRecovery, action, {
        paymentExpired: true,
      });
      expect(availability.enabled).toBe(false);
      expect(availability.recoveryCta).toBe(true);
    }
  });

  it("lets an OPEN case outrank an expired one, so resume stays shut while retries run", () => {
    const availability = subscriptionActionAvailability(pausedInRecovery, "resume", {
      paymentBlocked: true,
      paymentExpired: true,
    });
    expect(availability.enabled).toBe(false);
    expect(availability.reason).toBe("payment_blocked");
  });

  it("does not change any verdict when the expired flag is false", () => {
    for (const action of BLOCKED_BY_THE_SERVER) {
      expect(subscriptionActionAvailability(editable, action, { paymentExpired: false })).toEqual(
        subscriptionActionAvailability(editable, action),
      );
    }
  });
});
