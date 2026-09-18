import { describe, expect, it } from "vitest";
import { PAYMENT_FAILURE_CUSTOMER_CAUSES } from "@openlup/core/payment";

import {
  CAUSE_COPY_LOCALES,
  subscriptionPaymentCauseSentence,
} from "./subscriptionPaymentCauseCopy.js";

const LOCALES = CAUSE_COPY_LOCALES;

describe("subscriptionPaymentCauseSentence", () => {
  it("answers every stated cause in every locale", () => {
    for (const locale of LOCALES) {
      for (const cause of PAYMENT_FAILURE_CUSTOMER_CAUSES) {
        const sentence = subscriptionPaymentCauseSentence(locale, cause);
        if (cause === "unknown") {
          expect(sentence).toBeNull();
          continue;
        }
        expect(sentence, `${locale}/${cause}`).toBeTruthy();
        expect(sentence!.trim()).toBe(sentence);
        expect(sentence!.endsWith(".")).toBe(true);
      }
    }
  });

  it("says nothing for `unknown`, in both locales", () => {
    // The whole safety property of this wave: a cause nobody recorded adds no
    // sentence, so an unclassified failure renders what it rendered before.
    for (const locale of LOCALES) {
      expect(subscriptionPaymentCauseSentence(locale, "unknown")).toBeNull();
    }
  });

  it("never claims a decline for a cause where nothing was declined", () => {
    // `needs_confirmation` and `method_missing` describe states reached without
    // the issuer refusing anything. Saying "declined"/"odrzuc…" there would be
    // false, and it is the exact falsehood this vocabulary exists to prevent.
    const declineWords = /(odrzuc|declin|refus)/i;
    for (const locale of LOCALES) {
      for (const cause of ["needs_confirmation", "method_missing"] as const) {
        expect(subscriptionPaymentCauseSentence(locale, cause) ?? "").not.toMatch(declineWords);
      }
    }
  });

  it("gives each locale its own wording rather than one table twice", () => {
    const [first, second] = LOCALES;
    for (const cause of PAYMENT_FAILURE_CUSTOMER_CAUSES.filter((c) => c !== "unknown")) {
      expect(subscriptionPaymentCauseSentence(first, cause)).not.toBe(
        subscriptionPaymentCauseSentence(second, cause),
      );
    }
  });
});
