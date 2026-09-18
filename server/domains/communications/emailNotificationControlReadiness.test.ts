import { describe, expect, it } from "vitest";

import {
  MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS,
} from "./emailNotificationControlReadiness.js";

describe("mandatory customer notification-control readiness", () => {
  it("derives only implemented customer controls from the canonical email inventory", () => {
    expect(MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS).toEqual(expect.arrayContaining([
      "commerce-order-paid",
      "commerce-abandoned-cart-1h",
      "subscription-welcome",
      "auth-*",
      "subscription-payment-failed-*",
    ]));
    expect(MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS).not.toEqual(expect.arrayContaining([
      "commerce-back-in-stock",
      "commerce-invoice-document",
      "survey_*_notification",
      "waitlist_confirmation",
    ]));
  });
});
