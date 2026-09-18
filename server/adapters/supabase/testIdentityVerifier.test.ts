import { describe, expect, it } from "vitest";
import { createTestIdentityVerifier } from "./testIdentityVerifier.js";

describe("createTestIdentityVerifier", () => {
  const principal = { principalId: "test-user", email: "t@example.com", emailVerified: true };

  it("resolves any non-empty token to the fixed principal", async () => {
    const verifier = createTestIdentityVerifier(principal);
    expect(await verifier.verifyAccessToken("anything")).toEqual(principal);
  });

  it("returns null for an empty token", async () => {
    const verifier = createTestIdentityVerifier(principal);
    expect(await verifier.verifyAccessToken("")).toBeNull();
  });

  it("passes through a null principal", async () => {
    const verifier = createTestIdentityVerifier(null);
    expect(await verifier.verifyAccessToken("tok")).toBeNull();
  });
});
