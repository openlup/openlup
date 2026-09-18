import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkoutOrchestrationFailureDetails,
  safeCommerceDiagnosticValue,
} from "./commerceDiagnostics.js";

describe("commerce diagnostics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redacts common PII, secrets, UUIDs, and idempotency-like values", () => {
    const value = safeCommerceDiagnosticValue(
      "client anna@example.com order_id=44444444-4444-4444-8444-444444444444 token=tok_secret_123 phone +48 600 700 800 idempotencyKey:intent-2026-06-05-rex-long-value",
    );

    expect(value).toContain("[redacted-email]");
    expect(value).toContain("[redacted-uuid]");
    expect(value).toContain("token=[redacted]");
    expect(value).toContain("[redacted-number]");
    expect(value).toContain("[redacted-id]");
    expect(value).not.toContain("anna@example.com");
    expect(value).not.toContain("44444444-4444-4444-8444-444444444444");
    expect(value).not.toContain("+48 600 700 800");
  });

  it("keeps constraint-level diagnostic text and truncates long messages", () => {
    const value = safeCommerceDiagnosticValue(
      `commerce_orders_subscription_cycle_mode_check ${"x".repeat(300)}`,
    );

    expect(value).toContain("commerce_orders_subscription_cycle_mode_check");
    expect(value).toHaveLength(240);
    expect(value?.endsWith("...")).toBe(true);
  });

  it("omits checkout orchestration diagnostics outside preview", () => {
    expect(checkoutOrchestrationFailureDetails("safe reason")).toEqual({
      feature: "checkout",
      stage: "orchestrate_order",
    });
  });

  it("includes checkout orchestration diagnostics for preview smoke only", () => {
    vi.stubEnv("VERCEL_ENV", "preview");

    expect(checkoutOrchestrationFailureDetails("safe reason")).toEqual({
      feature: "checkout",
      stage: "orchestrate_order",
      diagnosticReason: "safe reason",
    });
  });
});
