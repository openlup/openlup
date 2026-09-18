import { describe, expect, it, vi } from "vitest";
import {
  CustomerAccountReadModelError,
  customerAccountReadFailureDetails,
  logCustomerAccountReadFailure,
  withCustomerAccountReadStage,
} from "./customerAccountReadDiagnostics.js";

describe("customer account read diagnostics", () => {
  it("wraps account aggregate read failures with the failing stage", async () => {
    const cause = Object.assign(new Error("permission denied for table commerce_orders"), { code: "42501" });

    await expect(withCustomerAccountReadStage("account_aggregate", async () => {
      throw cause;
    })).rejects.toMatchObject({
      name: "CustomerAccountReadModelError",
      stage: "account_aggregate",
      cause,
    });
  });

  it("does not double-wrap staged read failures", async () => {
    const staged = new CustomerAccountReadModelError("account_aggregate", new Error("db unavailable"));

    await expect(withCustomerAccountReadStage("account_aggregate", async () => {
      throw staged;
    })).rejects.toBe(staged);
  });

  it("returns only safe BFF failure details", () => {
    const cause = Object.assign(new Error("permission denied"), {
      code: "42501",
      token: "service-role-token",
    });

    expect(customerAccountReadFailureDetails(new CustomerAccountReadModelError("account_aggregate", cause))).toEqual({
      reason: "read_model_failed",
      stage: "account_aggregate",
      providerCode: "42501",
    });
    expect(customerAccountReadFailureDetails(new Error("plain failure"))).toEqual({
      reason: "read_model_failed",
      stage: "unknown",
    });
  });

  it("logs diagnostic context without leaking arbitrary provider payload fields", () => {
    const cause = Object.assign(new Error("permission denied for table commerce_orders"), {
      code: "42501",
      details: "policy blocked",
      token: "service-role-token",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logCustomerAccountReadFailure(new CustomerAccountReadModelError("account_aggregate", cause));

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("account_aggregate");
    expect(logged).toContain("42501");
    expect(logged).toContain("policy blocked");
    expect(logged).not.toContain("service-role-token");
    errorSpy.mockRestore();
  });
});
