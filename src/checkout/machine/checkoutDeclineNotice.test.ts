// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  DECLINE_NOTICE_STORAGE_KEY,
  clearCheckoutDeclineNotice,
  stashCheckoutDeclineNotice,
  takeCheckoutDeclineNotice,
  takeCheckoutRecoveryRequest,
} from "./checkoutDeclineNotice";

beforeEach(() => sessionStorage.clear());

describe("checkout decline notice", () => {
  it("hands the reason across a remount exactly once", () => {
    stashCheckoutDeclineNotice("checkout:errors.paymentDeclinedCard");

    expect(takeCheckoutDeclineNotice()).toBe("checkout:errors.paymentDeclinedCard");
    // Read-once is the point: a buyer who reloads the payment step must not be
    // told their card was declined above a form they have not submitted.
    expect(takeCheckoutDeclineNotice()).toBeNull();
  });

  it("returns null when nothing was stashed", () => {
    expect(takeCheckoutDeclineNotice()).toBeNull();
  });

  it("refuses any value outside the checkout error vocabulary", () => {
    // The value reaches `t()`, so a tampered or stale entry must be dropped
    // rather than rendered — and dropped while still consuming it.
    sessionStorage.setItem(DECLINE_NOTICE_STORAGE_KEY, "account:somethingElse");

    expect(takeCheckoutDeclineNotice()).toBeNull();
    expect(sessionStorage.getItem(DECLINE_NOTICE_STORAGE_KEY)).toBeNull();
  });

  it("clears a pending notice on demand", () => {
    stashCheckoutDeclineNotice("checkout:errors.paymentDeclinedBlik", {
      orderId: "11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
    });

    clearCheckoutDeclineNotice();

    expect(takeCheckoutDeclineNotice()).toBeNull();
    expect(takeCheckoutRecoveryRequest()).toBeNull();
  });
});
