import { describe, expect, it } from "vitest";

import { BffClientError } from "@/lib/bff/client";
import { isCheckoutDisabled } from "./checkoutDisabled.js";

describe("isCheckoutDisabled", () => {
  it("is false for a plain error", () => {
    expect(isCheckoutDisabled(new Error("nope"))).toBe(false);
  });

  it("is false for a non-UPSTREAM BffClientError even with a flag-off reason", () => {
    const err = new BffClientError(
      { code: "BAD_REQUEST", message: "x", details: { reason: "feature_flag_disabled" } },
      400,
    );
    expect(isCheckoutDisabled(err)).toBe(false);
  });

  it("is true for UPSTREAM_UNAVAILABLE with a flag-off reason", () => {
    for (const reason of [
      "feature_flag_disabled",
      "dependency_flag_disabled",
      "rehearsal_payment_disabled",
    ]) {
      const err = new BffClientError(
        { code: "UPSTREAM_UNAVAILABLE", message: "x", details: { reason } },
        503,
      );
      expect(isCheckoutDisabled(err)).toBe(true);
    }
  });

  it("is true when a requiredEnv is named", () => {
    const err = new BffClientError(
      { code: "UPSTREAM_UNAVAILABLE", message: "x", details: { requiredEnv: "STRIPE_SECRET_KEY" } },
      503,
    );
    expect(isCheckoutDisabled(err)).toBe(true);
  });

  it("is false for an UPSTREAM error with an unrelated reason", () => {
    const err = new BffClientError(
      { code: "UPSTREAM_UNAVAILABLE", message: "x", details: { stage: "orchestrate_order" } },
      503,
    );
    expect(isCheckoutDisabled(err)).toBe(false);
  });
});
