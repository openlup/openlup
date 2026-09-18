import { describe, expect, it } from "vitest";
import { subscriptionEmailContent as publicContent } from "./exampleSubscriptionEmailContent.js";

const EXPECTED_KEYS = [
  "activationActionRequired", "addressChanged", "cancelled", "cycleSkipped",
  "deliveryRescheduled", "packageChanged", "pauseReminder", "paused",
  "paymentExpired", "paymentFailed", "paymentRecovered", "renewalAtRisk",
  "renewalUpcoming", "resumed", "welcome", "winback",
];

describe("subscription email content roots", () => {
  it("exposes the complete public bilingual contract", () => {
    expect(publicContent.id).toBe("example");
    const localizedEntries = Object.entries(publicContent)
      .filter(([key]) => key !== "id");
    expect(localizedEntries.map(([key]) => key).sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const [, localized] of localizedEntries) {
      if (typeof localized !== "object" || localized === null) {
        throw new Error("subscription email family must be a localized object");
      }
      expect(Object.keys(localized).sort()).toEqual(["en", "pl"]);
    }
  });

  it("freezes the public composition root", () => {
    expect(Object.isFrozen(publicContent)).toBe(true);
  });
});
