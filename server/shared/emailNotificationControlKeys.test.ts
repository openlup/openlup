import { describe, expect, it } from "vitest";

import {
  EMAIL_NOTIFICATION_ADMIN_DISABLED,
  EMAIL_NOTIFICATION_CONTROL_FAMILY_KEYS,
  emailNotificationControlKeys,
} from "./emailNotificationControlKeys.js";

describe("emailNotificationControlKeys", () => {
  it("always checks the exact slug first", () => {
    expect(emailNotificationControlKeys("commerce-order-confirmation")).toEqual(["commerce-order-confirmation"]);
  });

  it("adds family-level controls for dynamic mail families", () => {
    expect(emailNotificationControlKeys("auth-confirmation")).toEqual(["auth-confirmation", "auth-*"]);
    expect(emailNotificationControlKeys("subscription-payment-failed-2")).toEqual([
      "subscription-payment-failed-2",
      "subscription-payment-failed-*",
    ]);
    expect(emailNotificationControlKeys("survey_consumer_notification")).toEqual([
      "survey_consumer_notification",
      "survey_*_notification",
    ]);
  });

  it("exports canonical terminal skip and family keys", () => {
    expect(EMAIL_NOTIFICATION_ADMIN_DISABLED).toBe("admin_disabled");
    expect(EMAIL_NOTIFICATION_CONTROL_FAMILY_KEYS).toEqual([
      "auth-*",
      "subscription-payment-failed-*",
      "survey_*_notification",
    ]);
  });
});
