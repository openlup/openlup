import { describe, expect, it } from "vitest";
import { safeRiskString as packagedSafeRiskString } from "@openlup/platform/risk/server";
import { riskSubjectHash, safeRiskString } from "./riskFingerprint.js";

describe("riskSubjectHash", () => {
  it("is deterministic for the same kind + value", () => {
    expect(safeRiskString).toBe(packagedSafeRiskString);
    expect(riskSubjectHash("email", "a@b.com")).toBe(riskSubjectHash("email", "a@b.com"));
  });

  it("is namespaced by kind (same value, different kind → different hash)", () => {
    expect(riskSubjectHash("email", "a@b.com")).not.toBe(riskSubjectHash("ip", "a@b.com"));
  });

  it("produces a non-empty hex digest and varies with the secret", () => {
    expect(riskSubjectHash("email", "a@b.com").length).toBeGreaterThan(0);
    // The HMAC secret only applies at >=16 chars (else it falls back to plain sha256).
    expect(riskSubjectHash("email", "a@b.com", "secret-aaaaaaaaaa")).not.toBe(
      riskSubjectHash("email", "a@b.com", "secret-bbbbbbbbbb"),
    );
  });
});
