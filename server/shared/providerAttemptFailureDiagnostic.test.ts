import { describe, expect, it } from "vitest";

import {
  providerAttemptDispatchFailure,
  providerAttemptFailureLogFields,
} from "./providerAttemptFailureDiagnostic.js";

describe("provider-attempt failure diagnostic boundary", () => {
  const safe = {
    httpStatus: 400,
    requestId: "d3a9826d92c48cb8c185",
    providerErrorCodes: ["invalid_request_body"],
    fieldNames: ["payer.email"],
  };

  it("carries a revalidated closed projection", () => {
    expect(providerAttemptDispatchFailure({
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      failureDiagnostic: safe,
    })).toEqual({
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      failureDiagnostic: safe,
    });
  });

  it("drops an invalid diagnostic without dropping the uncertainty fence", () => {
    const failure = providerAttemptDispatchFailure({
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      failureDiagnostic: {
        ...safe,
        requestId: "buyer-token",
        providerErrorCodes: ["PAYID-secret"],
        fieldNames: ["customer-token"],
      },
    });
    expect(failure).toMatchObject({ code: "tpay_request_failed", dispatchState: "unknown" });
    expect(failure?.failureDiagnostic).toBeNull();
  });

  // The 2026-08-28 BLIK outage was refused for `payer.userAgent`, but that name
  // was not on the allow-list, so it was filtered out and the 400 logged
  // `fieldNames: []`. Only the NAME travels - no diagnostic field carries a
  // provider value - so neither a user agent nor an IP address is ever logged.
  it.each(["payer.userAgent", "payer.ip"])("lets the 400 name %s instead of reporting nothing", (fieldName) => {
    const failure = providerAttemptDispatchFailure({
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      failureDiagnostic: { ...safe, providerErrorCodes: ["not_valid"], fieldNames: [fieldName] },
    });
    expect(failure?.failureDiagnostic?.fieldNames).toEqual([fieldName]);
  });

  it("builds the complete allowlisted log projection", () => {
    expect(providerAttemptFailureLogFields({
      paymentAttemptId: "attempt-1",
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      retryCount: 0,
      failureDiagnostic: safe,
    })).toEqual({
      paymentAttemptId: "attempt-1",
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      retryCount: 0,
      ...safe,
    });
  });
});
