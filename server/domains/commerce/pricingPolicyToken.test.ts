import { describe, expect, it } from "vitest";

import {
  createPricingPolicyToken,
  resolvePricingPolicy,
  verifyPricingPolicyToken,
} from "./pricingPolicyToken.js";

const secret = "pricing-policy-test-secret-32-bytes-minimum";

describe("pricing policy token", () => {
  it("keeps a no-capability/no-token client on legacy v1", () => {
    expect(resolvePricingPolicy({ nowMs: 1_000, secret, v2Enabled: true, rolloutBps: 10_000 }))
      .toMatchObject({ offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v1" });
  });

  it("mints and verifies a short-lived server-signed v2 assignment", () => {
    const resolved = resolvePricingPolicy({
      assignmentKey: "visitor-1",
      capability: "commerce.offer-policy.v2",
      nowMs: 1_000,
      secret,
      v2Enabled: true,
      rolloutBps: 10_000,
      ttlMs: 60_000,
    });

    expect(resolved.offerPolicyVersion).toBe("commerce.offer-policy.v2");
    expect(verifyPricingPolicyToken(resolved.pricingPolicyToken!, secret, 2_000))
      .toMatchObject({ offerPolicyVersion: "commerce.offer-policy.v2", assignmentKeyHash: expect.any(String) });
  });

  it("keeps the default assignment stable for the 72-hour compatibility window", () => {
    const issuedAtMs = 1_000;
    const resolved = resolvePricingPolicy({
      assignmentKey: "visitor-72h",
      capability: "commerce.offer-policy.v2",
      nowMs: issuedAtMs,
      secret,
      v2Enabled: true,
      rolloutBps: 0,
    });

    expect(verifyPricingPolicyToken(resolved.pricingPolicyToken!, secret, issuedAtMs))
      .toMatchObject({
        issuedAtMs,
        expiresAtMs: issuedAtMs + 72 * 60 * 60 * 1_000,
        offerPolicyVersion: "commerce.offer-policy.v1",
      });
  });

  it("rejects tampering and expiry instead of trusting a client-selected version", () => {
    const token = createPricingPolicyToken({
      assignmentKey: "visitor-1",
      expiresAtMs: 2_000,
      issuedAtMs: 1_000,
      offerPolicyVersion: "commerce.offer-policy.v2",
      promotionEngineVersion: "promotion-engine.v2",
    }, secret);

    expect(verifyPricingPolicyToken(`${token}x`, secret, 1_500)).toBeNull();
    expect(verifyPricingPolicyToken(token, secret, 2_001)).toBeNull();
  });

  it("grandfathers a valid bound v2 token when new v2 assignments are off", () => {
    const token = createPricingPolicyToken({
      assignmentKey: "visitor-1", expiresAtMs: 20_000, issuedAtMs: 1_000,
      offerPolicyVersion: "commerce.offer-policy.v2",
      promotionEngineVersion: "promotion-engine.v2",
    }, secret);
    expect(resolvePricingPolicy({
      assignmentKey: "visitor-1", capability: "commerce.offer-policy.v2",
      token, nowMs: 2_000, secret, v2Enabled: false, rolloutBps: 10_000,
    })).toMatchObject({
      offerPolicyVersion: "commerce.offer-policy.v2",
      promotionEngineVersion: "promotion-engine.v2",
      pricingPolicyToken: token,
    });
  });

  it("does not create a new v2 assignment when the backend switch is off", () => {
    expect(resolvePricingPolicy({
      assignmentKey: "visitor-1", capability: "commerce.offer-policy.v2",
      nowMs: 2_000, secret, v2Enabled: false, rolloutBps: 10_000,
    })).toEqual({
      offerPolicyVersion: "commerce.offer-policy.v1",
      promotionEngineVersion: "promotion-engine.v1",
    });
  });
});
