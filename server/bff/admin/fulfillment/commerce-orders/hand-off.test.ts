import { describe, expect, it } from "vitest";
import { shouldAttachAccountingHandoffTrigger } from "./hand-off.js";

describe("admin commerce fulfillment hand-off accounting trigger", () => {
  it("uses the neutral request switch for handoff accounting trigger decisions", () => {
    expect(shouldAttachAccountingHandoffTrigger({
      ACCOUNTING_REQUEST_ENABLED: "true",
      ACCOUNTING_ISSUE_TRIGGER: "handoff",
      COMMERCE_ACCOUNTING_SHADOW_ENABLED: "false",
    })).toBe(true);

    expect(shouldAttachAccountingHandoffTrigger({
      ACCOUNTING_REQUEST_ENABLED: "true",
      ACCOUNTING_ISSUE_TRIGGER: "paid",
    })).toBe(false);
  });

  it("keeps legacy shadow as request-enabled fallback only", () => {
    expect(shouldAttachAccountingHandoffTrigger({
      COMMERCE_ACCOUNTING_SHADOW_ENABLED: "true",
    })).toBe(true);

    expect(shouldAttachAccountingHandoffTrigger({
      ACCOUNTING_REQUEST_ENABLED: "false",
      COMMERCE_ACCOUNTING_SHADOW_ENABLED: "true",
    })).toBe(false);
  });
});
