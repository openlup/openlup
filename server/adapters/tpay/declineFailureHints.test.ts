import { describe, expect, it } from "vitest";
import {
  classifyPaymentFailure,
  PAYMENT_FAILURE_HINTS,
  PAYMENT_RETRY_ADVICE_CODES,
  type PaymentFailureClass,
} from "@openlup/core/payment";

import {
  DECLINE_CODE_READING_TABLE,
  declineCodeReading,
  KNOWN_UNREADABLE_DECLINE_CODES,
} from "./declineFailureHints.js";

describe("declineCodeReading", () => {
  it.each<[string, PaymentFailureClass, string]>([
    ["101", "hard_do_not_retry", "advice_code"],
    ["103", "soft_retryable", "neutral_hint"],
    ["104", "soft_retryable", "neutral_hint"],
    ["105", "mandate_dead", "neutral_hint"],
    ["106", "soft_retry_delayed", "neutral_hint"],
    ["107", "hard_do_not_retry", "advice_code"],
  ])("%s resolves to %s by %s", (code, expectedClass, expectedSource) => {
    const reading = declineCodeReading(code);
    expect(classifyPaymentFailure({
      adviceCode: reading.adviceCode,
      neutralReasonHints: reading.hints,
    })).toEqual({ failureClass: expectedClass, decidedBy: expectedSource });
  });

  it.each([...KNOWN_UNREADABLE_DECLINE_CODES])(
    "%s is read as nothing, because nothing published says what it means",
    (code) => {
      expect(KNOWN_UNREADABLE_DECLINE_CODES).toContain(code);
      expect(DECLINE_CODE_READING_TABLE).not.toHaveProperty(code);
      expect(declineCodeReading(code)).toEqual({});
      const reading = declineCodeReading(code);
      expect(classifyPaymentFailure({
        adviceCode: reading.adviceCode,
        neutralReasonHints: reading.hints,
      })).toEqual({ failureClass: "indeterminate", decidedBy: "default" });
    },
  );

  it("states a retry verdict for a deliberate refusal rather than claiming the instrument is dead", () => {
    // 101 and 107 are refusals the payer or their bank MADE; the instrument may
    // be in perfect health. The adapter says only what it knows — do not repeat
    // this unattended — and asserts no hint about the credential.
    for (const code of ["101", "107"]) {
      expect(declineCodeReading(code).adviceCode).toBe("do_not_try_again");
      expect(declineCodeReading(code).hints).toBeUndefined();
    }
  });

  it("returns no reading for an unknown code, none at all, or an inherited key", () => {
    expect(declineCodeReading("999")).toEqual({});
    expect(declineCodeReading(undefined)).toEqual({});
    expect(declineCodeReading("constructor")).toEqual({});
    expect(declineCodeReading("toString")).toEqual({});
  });

  it("only ever states vocabulary the kernel declares", () => {
    const hints = new Set<string>(PAYMENT_FAILURE_HINTS);
    const advice = new Set<string>(PAYMENT_RETRY_ADVICE_CODES);
    for (const reading of Object.values(DECLINE_CODE_READING_TABLE)) {
      expect(reading.hints !== undefined || reading.adviceCode !== undefined).toBe(true);
      for (const hint of reading.hints ?? []) expect(hints.has(hint)).toBe(true);
      if (reading.adviceCode !== undefined) expect(advice.has(reading.adviceCode)).toBe(true);
    }
  });

  it("keeps the table frozen, so one caller cannot re-point a row for everyone", () => {
    expect(Object.isFrozen(DECLINE_CODE_READING_TABLE)).toBe(true);
    expect(Object.isFrozen(DECLINE_CODE_READING_TABLE["103"])).toBe(true);
  });
});
