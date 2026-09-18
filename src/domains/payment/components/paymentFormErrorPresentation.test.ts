import { describe, expect, it } from "vitest";
import { paymentFormErrorPresentation } from "./paymentFormErrorPresentation";

const key = (id: string) => `checkout:recoveryGuidance.messages.${id}`;
describe("curated checkout form errors", () => {
  it.each([
    ["incomplete_number", "c05a"], ["invalid_number", "c05a"], ["incorrect_number", "c05a"],
    ["incomplete_cvc", "c05b"], ["invalid_cvc", "c05b"], ["incorrect_cvc", "c05b"],
    ["incomplete_expiry", "c05c"], ["invalid_expiry_month", "c05c"], ["invalid_expiry_year", "c05c"], ["invalid_expiry_year_past", "c05c"],
  ])("preserves actionable field help for %s", (code, id) => {
    expect(paymentFormErrorPresentation({ code })).toBe(key(id));
  });
  it("treats incomplete input as correction, not bank refusal or a retry count", () => {
    expect(paymentFormErrorPresentation({ type: "validation_error" })).toBe(key("c05"));
    expect(paymentFormErrorPresentation({ type: "validation_error" }, { dispatch: "not_dispatched", retryAllowed: true })).toBe(key("c05"));
  });
  it("requires proven no-dispatch plus retry permission for start-failed retry", () => {
    expect(paymentFormErrorPresentation({ type: "rate_limit_error" })).toBe(key("c09"));
    expect(paymentFormErrorPresentation({ type: "rate_limit_error" }, { dispatch: "not_dispatched", retryAllowed: true })).toBe(key("c17"));
    expect(paymentFormErrorPresentation({ type: "invalid_request_error", code: "payment_intent_authentication_failure" }, { dispatch: "not_dispatched" })).toBe(key("c17a"));
    expect(paymentFormErrorPresentation(
      { type: "invalid_request_error", code: "payment_intent_authentication_failure" },
      { dispatch: "not_dispatched", retryAllowed: true },
    )).toBe(key("c17"));
  });
  it.each(["expired_card", "card_declined", "insufficient_funds", "unknown_future_code"])(
    "defers %s to authoritative guidance instead of guessing a safe action", (code) => {
      expect(paymentFormErrorPresentation({ type: "card_error", code })).toBe(key("c09"));
    },
  );
  it("never displays uncurated provider text", () => {
    expect(paymentFormErrorPresentation({ message: "private raw diagnostic" } as never)).toBe(key("c09"));
  });
});
