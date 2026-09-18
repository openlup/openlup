import { describe, expect, it } from "vitest";
import {
  classifyPaymentFailure,
  PAYMENT_FAILURE_HINTS,
  type PaymentFailureClass,
} from "@openlup/core/payment";

import { DECLINE_CODE_HINT_TABLE, declineCodeHints } from "./declineFailureHints.js";

describe("declineCodeHints", () => {
  it.each<[string, PaymentFailureClass]>([
    ["lost_card", "hard_do_not_retry"],
    ["stolen_card", "hard_do_not_retry"],
    ["pickup_card", "hard_do_not_retry"],
    ["fraudulent", "hard_do_not_retry"],
    ["merchant_blacklist", "hard_do_not_retry"],
    ["highest_risk_level", "hard_do_not_retry"],
    ["invalid_account", "hard_do_not_retry"],
    ["new_account_information_available", "hard_do_not_retry"],
    ["revocation_of_authorization", "hard_do_not_retry"],
    ["revocation_of_all_authorizations", "hard_do_not_retry"],
    ["stop_payment_order", "hard_do_not_retry"],
    ["card_not_supported", "hard_do_not_retry"],
    ["currency_not_supported", "hard_do_not_retry"],
    ["expired_card", "hard_do_not_retry"],
    ["restricted_card", "hard_do_not_retry"],
    ["transaction_not_allowed", "hard_do_not_retry"],
    ["pin_try_exceeded", "hard_do_not_retry"],
    ["insufficient_funds", "soft_retryable"],
    ["processing_error", "soft_retryable"],
    ["issuer_not_available", "soft_retryable"],
    ["approve_with_id", "soft_retryable"],
    ["reenter_transaction", "soft_retryable"],
    ["try_again_later", "soft_retryable"],
    ["card_velocity_exceeded", "soft_retry_delayed"],
    ["withdrawal_count_limit_exceeded", "soft_retry_delayed"],
    ["incorrect_number", "fix_and_retry_customer_action"],
    ["invalid_number", "fix_and_retry_customer_action"],
    ["incorrect_cvc", "fix_and_retry_customer_action"],
    ["invalid_cvc", "fix_and_retry_customer_action"],
    ["invalid_expiry_month", "fix_and_retry_customer_action"],
    ["invalid_expiry_year", "fix_and_retry_customer_action"],
    ["incorrect_zip", "fix_and_retry_customer_action"],
    ["incorrect_address", "fix_and_retry_customer_action"],
    ["invalid_amount", "fix_and_retry_customer_action"],
    ["authentication_required", "sca_required"],
  ])("%s resolves to %s", (code, expected) => {
    const classified = classifyPaymentFailure(
      { declineCode: code },
      { declineCodeHints: DECLINE_CODE_HINT_TABLE },
    );
    expect(classified).toEqual({ failureClass: expected, decidedBy: "neutral_hint" });
  });

  it.each(["do_not_honor", "generic_decline"])(
    "%s stays unmapped, because the issuer said nothing this table may read",
    (code) => {
      expect(declineCodeHints(code)).toEqual([]);
      expect(classifyPaymentFailure({ declineCode: code }, { declineCodeHints: DECLINE_CODE_HINT_TABLE }))
        .toEqual({ failureClass: "indeterminate", decidedBy: "default" });
    },
  );

  it("returns no hints for an unknown code or none at all", () => {
    expect(declineCodeHints("a_code_that_does_not_exist")).toEqual([]);
    expect(declineCodeHints(undefined)).toEqual([]);
  });

  it("does not treat an inherited property as a mapping", () => {
    expect(declineCodeHints("constructor")).toEqual([]);
    expect(declineCodeHints("toString")).toEqual([]);
  });

  it("only ever asserts hints the kernel declares", () => {
    const declared = new Set<string>(PAYMENT_FAILURE_HINTS);
    for (const hints of Object.values(DECLINE_CODE_HINT_TABLE)) {
      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) expect(declared.has(hint)).toBe(true);
    }
  });

  it("keeps the table frozen, so one caller cannot re-point a row for everyone", () => {
    expect(Object.isFrozen(DECLINE_CODE_HINT_TABLE)).toBe(true);
    expect(Object.isFrozen(DECLINE_CODE_HINT_TABLE.lost_card)).toBe(true);
  });
});
