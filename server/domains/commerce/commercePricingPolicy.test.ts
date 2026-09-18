import { afterEach, describe, expect, it } from "vitest";

import {
  CommercePricingPolicyRequestError,
  CommercePricingPolicyUnavailableError,
  mapPricingPolicyFailure,
  PRICING_POLICY_REQUEST_REASONS,
  resolveCommercePricingPolicy,
} from "./commercePricingPolicy.js";
import {
  createPricingPolicyToken,
  verifyPricingPolicyToken,
} from "./pricingPolicyToken.js";
import {
  OFFER_POLICY_V2_READINESS_CONTRACT,
  resetOfferPolicyReadinessCacheForTests,
} from "./offerPolicyReadiness.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetOfferPolicyReadinessCacheForTests();
});

describe("commerce pricing policy authority", () => {
  it("keeps a legacy/no-capability request literally unextended", async () => {
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "10000";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = "pricing-policy-test-secret-32-bytes-minimum";

    const request = {
      mode: "one_time" as const,
      lines: [{ sku: "sku-lamb", quantity: 1 }],
      promoCodes: [],
    };
    await expect(resolveCommercePricingPolicy(request)).resolves.toBeUndefined();
    expect(JSON.stringify(request)).toBe(
      '{"mode":"one_time","lines":[{"sku":"sku-lamb","quantity":1}],"promoCodes":[]}',
    );
  });

  it("keeps a capable request literally legacy when policy config is unavailable", async () => {
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    delete process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET;

    await expect(resolveCommercePricingPolicy({
      visitorId: "visitor-rollback",
      pricingPolicy: { capability: "commerce.offer-policy.v2" },
    })).resolves.toBeUndefined();
  });

  it("honors a valid bound assignment while the rollout flag is off", async () => {
    const secret = "pricing-policy-test-secret-32-bytes-minimum";
    const now = Date.now();
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "false";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = secret;
    const token = createPricingPolicyToken({
      assignmentKey: "visitor-bound",
      issuedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      offerPolicyVersion: "commerce.offer-policy.v2",
      promotionEngineVersion: "promotion-engine.v2",
    }, secret);

    await expect(resolveCommercePricingPolicy({
      visitorId: "visitor-bound",
      pricingPolicy: { token },
    }, { readOfferPolicyV2Readiness: () => Promise.reject(new Error("must not read")) }))
      .resolves.toEqual({
      offerPolicyVersion: "commerce.offer-policy.v2",
      promotionEngineVersion: "promotion-engine.v2",
      pricingPolicyToken: token,
    });
  });

  it("issues a signed v1 assignment when readiness is unavailable", async () => {
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "10000";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = "pricing-policy-test-secret-32-bytes-minimum";

    await expect(resolveCommercePricingPolicy({
      visitorId: "visitor-held",
      pricingPolicy: { capability: "commerce.offer-policy.v2" },
    })).resolves.toEqual(expect.objectContaining({
      offerPolicyVersion: "commerce.offer-policy.v1",
      promotionEngineVersion: "promotion-engine.v1",
      pricingPolicyToken: expect.stringMatching(/^pp1\./),
    }));
  });

  it("assigns v2 only when the service-role readiness contract is green", async () => {
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "10000";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = "pricing-policy-test-secret-32-bytes-minimum";

    await expect(resolveCommercePricingPolicy({
      visitorId: "visitor-ready",
      pricingPolicy: { capability: "commerce.offer-policy.v2" },
    }, {
      readOfferPolicyV2Readiness: async () => ({
        contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
        ready: true,
        checkedAt: new Date().toISOString(),
        reasons: [],
      }),
    })).resolves.toEqual(expect.objectContaining({
      offerPolicyVersion: "commerce.offer-policy.v2",
      promotionEngineVersion: "promotion-engine.v2",
    }));
  });

  it("attributes a caller-side gap to the caller, not to an unavailable origin", async () => {
    process.env.COMMERCE_OFFER_POLICY_V1_FALLBACK_DISABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "10000";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = "pricing-policy-test-secret-32-bytes-minimum";
    const readinessPort = {
      readOfferPolicyV2Readiness: async () => ({
        contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
        ready: true,
        checkedAt: new Date().toISOString(),
        reasons: [],
      }),
    };

    // A browser that cannot persist a visitor id sends exactly this shape.
    const noVisitor = await resolveCommercePricingPolicy({
      pricingPolicy: { capability: "commerce.offer-policy.v2" },
    }, readinessPort).then(() => null, (error: unknown) => error);
    expect(noVisitor).toBeInstanceOf(CommercePricingPolicyRequestError);
    expect(noVisitor).toMatchObject({ reason: "v2_visitor_id_required" });
    expect(noVisitor).not.toBeInstanceOf(CommercePricingPolicyUnavailableError);
    expect(mapPricingPolicyFailure(noVisitor)).toEqual({
      code: "BAD_REQUEST",
      details: {
        reason: "pricing_policy_request_invalid",
        stage: "pricing_policy",
        policyReason: "v2_visitor_id_required",
      },
    });

    // A stale bundle that sends only an unbound token declares no capability.
    const noCapability = await resolveCommercePricingPolicy({
      visitorId: "visitor-stale-bundle",
      pricingPolicy: { token: "unbound-token-that-is-at-least-32-characters-long" },
    }, readinessPort).then(() => null, (error: unknown) => error);
    expect(noCapability).toBeInstanceOf(CommercePricingPolicyRequestError);
    expect(noCapability).toMatchObject({ reason: "v2_capability_required" });

    // Only a genuinely misconfigured origin keeps the 503 class.
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "5000";
    const misconfigured = await resolveCommercePricingPolicy({
      visitorId: "visitor-config",
      pricingPolicy: { capability: "commerce.offer-policy.v2" },
    }, readinessPort).then(() => null, (error: unknown) => error);
    expect(misconfigured).toBeInstanceOf(CommercePricingPolicyUnavailableError);
    expect(mapPricingPolicyFailure(misconfigured)).toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      details: {
        reason: "pricing_policy_unavailable",
        stage: "pricing_policy",
        policyReason: "v2_assignment_config_invalid",
      },
    });
  });

  it("rejects every new v1 fallback when the staging hard gate is enabled", async () => {
    process.env.COMMERCE_OFFER_POLICY_V1_FALLBACK_DISABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "10000";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = "pricing-policy-test-secret-32-bytes-minimum";

    await expect(resolveCommercePricingPolicy({ visitorId: "visitor-old-client" }))
      .rejects.toMatchObject({
        name: "CommercePricingPolicyRequestError",
        reason: "v2_capability_required",
      } satisfies Partial<CommercePricingPolicyRequestError>);

    await expect(resolveCommercePricingPolicy({
      visitorId: "visitor-unready",
      pricingPolicy: { capability: "commerce.offer-policy.v2" },
    }, {
      readOfferPolicyV2Readiness: async () => ({
        contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
        ready: false,
        checkedAt: new Date().toISOString(),
        reasons: ["promotion_claim_sweep_not_ready"],
      }),
    })).rejects.toMatchObject({
      name: "CommercePricingPolicyUnavailableError",
      reason: "v2_readiness_not_ready",
    } satisfies Partial<CommercePricingPolicyUnavailableError>);
  });

  it("rejects a signed v1 assignment and a partial cohort under the staging hard gate", async () => {
    const secret = "pricing-policy-test-secret-32-bytes-minimum";
    process.env.COMMERCE_OFFER_POLICY_V1_FALLBACK_DISABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "5000";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = secret;
    const now = Date.now();
    const v1Token = createPricingPolicyToken({
      assignmentKey: "visitor-v1",
      issuedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      offerPolicyVersion: "commerce.offer-policy.v1",
      promotionEngineVersion: "promotion-engine.v1",
    }, secret);

    await expect(resolveCommercePricingPolicy({
      visitorId: "visitor-v1",
      pricingPolicy: { token: v1Token },
    })).rejects.toMatchObject({ reason: "v1_assignment_rejected" });

    await expect(resolveCommercePricingPolicy({
      visitorId: "visitor-partial",
      pricingPolicy: { capability: "commerce.offer-policy.v2" },
    }, {
      readOfferPolicyV2Readiness: async () => ({
        contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
        ready: true,
        checkedAt: new Date().toISOString(),
        reasons: [],
      }),
    })).rejects.toMatchObject({ reason: "v2_assignment_config_invalid" });
  });

  it("replaces an obsolete bound assignment with current v2 only after every hard gate is green", async () => {
    const secret = "pricing-policy-test-secret-32-bytes-minimum";
    process.env.COMMERCE_OFFER_POLICY_V1_FALLBACK_DISABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "10000";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = secret;
    const now = Date.now();
    const obsoleteToken = createPricingPolicyToken({
      assignmentKey: "visitor-restored-draft",
      issuedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      offerPolicyVersion: "commerce.offer-policy.v1",
      promotionEngineVersion: "promotion-engine.v1",
    }, secret);
    const readiness = {
      readOfferPolicyV2Readiness: async () => ({
        contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
        ready: true,
        checkedAt: new Date().toISOString(),
        reasons: [],
      }),
    };

    const refreshed = await resolveCommercePricingPolicy({
      visitorId: "visitor-restored-draft",
      pricingPolicy: {
        capability: "commerce.offer-policy.v2",
        token: obsoleteToken,
      },
    }, readiness);

    expect(refreshed).toEqual(expect.objectContaining({
      offerPolicyVersion: "commerce.offer-policy.v2",
      promotionEngineVersion: "promotion-engine.v2",
      pricingPolicyToken: expect.stringMatching(/^pp1\./),
    }));
    expect(refreshed?.pricingPolicyToken).not.toBe(obsoleteToken);
    expect(verifyPricingPolicyToken(refreshed!.pricingPolicyToken!, secret))
      .toMatchObject({
        offerPolicyVersion: "commerce.offer-policy.v2",
        promotionEngineVersion: "promotion-engine.v2",
      });
  });

  it("does not refresh an obsolete assignment while readiness is closed", async () => {
    const secret = "pricing-policy-test-secret-32-bytes-minimum";
    process.env.COMMERCE_OFFER_POLICY_V1_FALLBACK_DISABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "10000";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = secret;
    const now = Date.now();
    const obsoleteToken = createPricingPolicyToken({
      assignmentKey: "visitor-restored-unready",
      issuedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      offerPolicyVersion: "commerce.offer-policy.v1",
      promotionEngineVersion: "promotion-engine.v1",
    }, secret);

    await expect(resolveCommercePricingPolicy({
      visitorId: "visitor-restored-unready",
      pricingPolicy: {
        capability: "commerce.offer-policy.v2",
        token: obsoleteToken,
      },
    }, {
      readOfferPolicyV2Readiness: async () => ({
        contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
        ready: false,
        checkedAt: new Date().toISOString(),
        reasons: ["promotion_claim_sweep_not_ready"],
      }),
    })).rejects.toMatchObject({
      name: "CommercePricingPolicyUnavailableError",
      reason: "v2_readiness_not_ready",
    } satisfies Partial<CommercePricingPolicyUnavailableError>);
  });

  it("fails closed to a signed v1 assignment for a malformed readiness contract", async () => {
    process.env.COMMERCE_OFFER_POLICY_V2_ENABLED = "true";
    process.env.COMMERCE_OFFER_POLICY_V2_ROLLOUT_BPS = "10000";
    process.env.COMMERCE_PRICING_POLICY_TOKEN_SECRET = "pricing-policy-test-secret-32-bytes-minimum";

    await expect(resolveCommercePricingPolicy({
      visitorId: "visitor-malformed",
      pricingPolicy: { capability: "commerce.offer-policy.v2" },
    }, { readOfferPolicyV2Readiness: async () => ({ ready: true }) }))
      .resolves.toEqual(expect.objectContaining({
        offerPolicyVersion: "commerce.offer-policy.v1",
        promotionEngineVersion: "promotion-engine.v1",
      }));
  });
  // ⛔ The second way a caller-side refusal can go dark, and it is not the
  // monitor's end. `policy_reason` is what the Axiom monitors key on, and
  // safePricingPolicyReason() collapses anything outside the safe set to
  // "other". A reason that is thrown but never added to SAFE_PRICING_POLICY_REASONS
  // is logged as "other", matches no monitor's filter, and produces exactly the
  // silence this pair of guards exists to prevent - one holds the reason to a
  // monitor, this one holds it to a legible log field.
  it("publishes every caller-side reason verbatim, so a monitor can key on it", () => {
    for (const reason of PRICING_POLICY_REQUEST_REASONS) {
      const mapped = mapPricingPolicyFailure(new CommercePricingPolicyRequestError(reason));

      expect(mapped, `${reason} must map`).not.toBeNull();
      expect(mapped!.code, `${reason} is caller-side`).toBe("BAD_REQUEST");
      expect(mapped!.details.reason).toBe("pricing_policy_request_invalid");
      // Never "other": that is the redaction that would erase the alert key.
      expect(mapped!.details.policyReason, `${reason} was redacted`).toBe(reason);
    }
  });
});
