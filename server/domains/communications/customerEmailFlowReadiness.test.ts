import { describe, expect, it } from "vitest";

import { activeCustomerEmailFlowFlags } from "./customerEmailFlowReadiness.ts";

describe("activeCustomerEmailFlowFlags", () => {
  it("treats the outbox dispatcher as active unless explicitly disabled", () => {
    expect(activeCustomerEmailFlowFlags({})).toEqual(["COMMERCE_OUTBOX_DISPATCH_ENABLED"]);
    expect(activeCustomerEmailFlowFlags({ COMMERCE_OUTBOX_DISPATCH_ENABLED: "false" })).toEqual([]);
  });

  it("includes explicitly enabled non-accounting flows", () => {
    expect(activeCustomerEmailFlowFlags({
      COMMERCE_OUTBOX_DISPATCH_ENABLED: "false",
      COMMERCE_ABANDONED_CART_ENABLED: "true",
    })).toEqual(["COMMERCE_ABANDONED_CART_ENABLED"]);
  });

  it("uses the caller's existing accounting-runtime result for legacy aliases", () => {
    const env = {
      COMMERCE_OUTBOX_DISPATCH_ENABLED: "false",
      ACCOUNTING_B2C_EMAIL_ENABLED: "true",
    };

    expect(activeCustomerEmailFlowFlags(env)).toEqual([]);
    expect(activeCustomerEmailFlowFlags(env, { accountingProviderEmailEnabled: true })).toEqual([
      "ACCOUNTING_B2C_EMAIL_ENABLED",
    ]);
  });
});
