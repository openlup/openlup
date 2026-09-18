import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DUNNING_RECOVERY_TOKEN_PREFIX,
  findRecoveryTokenEvidence,
  hashRecoveryToken,
  isQpSafeRecoveryLinkToken,
} from "./recoveryTokenHash.js";
import type { SubscriptionRecoveryTokenEvidence as PaymentRecoveryTokenEvidence } from "./paymentRecoveryPorts.js";

describe("hashRecoveryToken", () => {
  it("is the lowercase SHA-256 hex of the raw token (matches SQL encode(sha256(...)))", () => {
    const token = `${DUNNING_RECOVERY_TOKEN_PREFIX}deadbeef`;
    const expected = createHash("sha256").update(token).digest("hex");
    expect(hashRecoveryToken(token)).toBe(expected);
    expect(hashRecoveryToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the WHOLE token, so the rcv_ prefix round-trips transparently", () => {
    // The prefixed token and its bare-hex tail hash to DIFFERENT digests — the
    // validate RPC must receive the same whole token it minted, which it does.
    const tail = "a".repeat(64);
    expect(hashRecoveryToken(`${DUNNING_RECOVERY_TOKEN_PREFIX}${tail}`)).not.toBe(
      hashRecoveryToken(tail),
    );
  });
});

describe("DUNNING_RECOVERY_TOKEN_PREFIX / isQpSafeRecoveryLinkToken", () => {
  it("is a non-hex-leading sentinel matching the SQL mint", () => {
    expect(DUNNING_RECOVERY_TOKEN_PREFIX).toBe("rcv_");
    expect(/^[0-9A-Fa-f]/.test(DUNNING_RECOVERY_TOKEN_PREFIX)).toBe(false);
  });

  it("accepts tokens that cannot begin a =<2 hex> quoted-printable escape", () => {
    expect(isQpSafeRecoveryLinkToken(`${DUNNING_RECOVERY_TOKEN_PREFIX}7d3f`)).toBe(true);
    expect(isQpSafeRecoveryLinkToken("ey...")).toBe(true); // base64url(JSON) head
    expect(isQpSafeRecoveryLinkToken("g0abc")).toBe(true); // first char non-hex
  });

  it("rejects tokens whose first two chars are both hex digits (the corrupting case)", () => {
    expect(isQpSafeRecoveryLinkToken("7d3f0011")).toBe(false);
    expect(isQpSafeRecoveryLinkToken("AB")).toBe(false);
    expect(isQpSafeRecoveryLinkToken("00")).toBe(false);
  });
});

describe("findRecoveryTokenEvidence", () => {
  it("looks the evidence up by the SHA-256 hash of the whole raw token", async () => {
    const token = `${DUNNING_RECOVERY_TOKEN_PREFIX}${"f".repeat(64)}`;
    const evidence: PaymentRecoveryTokenEvidence = {
      tokenId: "tok-1",
      caseId: "case-1",
      clientId: "client-1",
      authUserId: null,
      purpose: "repair_payment",
      expiresAt: "2026-08-01T00:00:00.000Z",
      usedAt: null,
      revokedAt: null,
    };
    let seenHash: string | null = null;
    const port = {
      findTokenEvidenceByHash: async (hash: string) => {
        seenHash = hash;
        return evidence;
      },
    };
    const result = await findRecoveryTokenEvidence(port, token);
    expect(seenHash).toBe(hashRecoveryToken(token));
    expect(result).toBe(evidence);
  });

  it("returns null when no evidence row matches", async () => {
    const port = { findTokenEvidenceByHash: async () => null };
    expect(await findRecoveryTokenEvidence(port, "rcv_missing")).toBeNull();
  });
});
