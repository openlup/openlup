import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashRecoveryToken, PaymentRecoveryRecordError } from "./paymentRecoveryPorts.js";

describe("subscription payment recovery public seam", () => {
  it.each([
    ["idempotency_conflict" as const, "Payment recovery idempotency conflict"],
    ["token_invalid_or_expired" as const, "Payment recovery token is invalid"],
  ])("preserves the controlled %s error contract", (reason, message) => {
    const error = new PaymentRecoveryRecordError(reason);

    expect(error).toMatchObject({
      name: "PaymentRecoveryRecordError",
      reason,
      message,
    });
  });

  it("exposes the canonical SHA-256 token boundary used by recovery adapters", () => {
    const token = "recovery-token-fixture-not-a-secret";

    expect(hashRecoveryToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
  });
});
