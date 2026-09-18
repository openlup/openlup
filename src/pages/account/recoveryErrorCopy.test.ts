import { describe, expect, it } from "vitest";

import {
  formatDunningRecoveryError,
  localizeDunningRecoveryError,
  localizeRecoveryError,
  recoveryCardPaymentCopy,
  recoveryErrorReason,
} from "./recoveryErrorCopy";

// Identity translator so assertions read on the returned i18n key.
const t = (key: string) => key;

describe("recoveryErrorReason", () => {
  it("prefers details.reason over the top-level code", () => {
    expect(recoveryErrorReason({ code: "UPSTREAM_UNAVAILABLE", details: { reason: "provider_execution_failed" } }))
      .toBe("provider_execution_failed");
  });
  it("falls back to code when details.reason is absent", () => {
    expect(recoveryErrorReason({ code: "CONFLICT" })).toBe("CONFLICT");
  });
  it("returns null for non-object / shapeless errors", () => {
    expect(recoveryErrorReason("boom")).toBeNull();
    expect(recoveryErrorReason(null)).toBeNull();
    expect(recoveryErrorReason({})).toBeNull();
  });
});

describe("localizeRecoveryError", () => {
  it("maps provider_execution_failed to the providerFailed copy", () => {
    expect(localizeRecoveryError({ details: { reason: "provider_execution_failed" } }, t))
      .toBe("account:completePayment.errorReason.providerFailed");
  });
  it("maps in-flight / control-conflict reasons to the inProgress copy", () => {
    expect(localizeRecoveryError({ details: { reason: "provider_attempt_in_flight" } }, t))
      .toBe("account:completePayment.errorReason.inProgress");
    expect(localizeRecoveryError({ details: { reason: "payment_control_conflict" } }, t))
      .toBe("account:completePayment.errorReason.inProgress");
  });
  it("never returns the raw English message — unknown reasons fall back to the generic key", () => {
    expect(localizeRecoveryError(new Error("Recovery payment could not be started"), t))
      .toBe("account:completePayment.genericError");
  });
});

describe("localizeDunningRecoveryError", () => {
  it("routes a not-yet-durable method to copy that keeps the saved card true", () => {
    expect(localizeDunningRecoveryError(
      { details: { reason: "resume_method_not_chargeable" } },
      t,
    )).toBe("account:recovery.resumeMethodNotReady");
  });

  // The legacy delegate raises the same case-state error for a `repair_payment`
  // token whose case is no longer open, so this copy must not name a resume.
  it("routes a moved-on case to stale-link copy that fits either cohort", () => {
    expect(localizeDunningRecoveryError(
      { details: { reason: "resume_case_state_changed" } },
      t,
    )).toBe("account:recovery.linkStale");
  });

  it("still maps the legacy refusal a not-yet-redeployed BFF can emit", () => {
    expect(localizeDunningRecoveryError(
      { details: { reason: "resume_subscription_not_available" } },
      t,
    )).toBe("account:recovery.resumeNeedsSupport");
  });

  it("leaves unrelated recovery failures to the existing formatter", () => {
    expect(localizeDunningRecoveryError(new Error("Stripe unavailable"), t)).toBeNull();
  });
});

describe("formatDunningRecoveryError", () => {
  it("prefers the mapped reason, then the raw failure, then the generic key", () => {
    expect(formatDunningRecoveryError({ details: { reason: "resume_case_state_changed" } }, t))
      .toBe("account:recovery.linkStale");
    expect(formatDunningRecoveryError(new Error("upstream_503"), t)).toBe("upstream_503");
    expect(formatDunningRecoveryError({}, t)).toBe("account:recovery.genericError");
  });
});

describe("recoveryCardPaymentCopy", () => {
  it("switches only the pay CTA between a one-off and a subscription cycle", () => {
    expect(recoveryCardPaymentCopy(t, false).payButton).toBe("account:completePayment.payCta.oneTime");
    expect(recoveryCardPaymentCopy(t, true).payButton).toBe("account:completePayment.payCta.subscription");
  });

  // The embedded card step renders NOTHING it was not handed, so a missing entry
  // is a dead end with no words in it — the failure this vocabulary exists for.
  it("fills the whole failure vocabulary the embedded card step can render", () => {
    expect(recoveryCardPaymentCopy(t, false)).toEqual({
      payButton: "account:completePayment.payCta.oneTime",
      payingButton: "account:completePayment.processing",
      errorPrefix: "account:completePayment.cardDeclined",
      unavailable: "account:completePayment.cardUnavailable",
      loadFailed: "account:completePayment.cardLoadFailed",
      loadRetry: "account:completePayment.cardLoadRetry",
      loadAlternative: "account:completePayment.cardLoadAlternative",
    });
  });
});
