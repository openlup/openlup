import { expect, it } from "vitest";
import { evaluateCommunicationPolicy } from "../../src/communications/consentPolicy.js";
import { createCommunicationPreferenceToken, verifyCommunicationPreferenceToken } from "../../src/communications/preferencesToken.js";
import { canonicalNewsletterWebhookEventSchema, newsletterMarketingPurposeSchema } from "../../src/communications/newsletterIntegrationContracts.js";

it("C2/C5 legacy policy, token and schema defaults before registration", () => {
  for (const purpose of ["transactional", "subscription_dunning", "admin_notification", "tester_program", "marketing_launch_offer", "marketing_newsletter"] as const) {
    for (const state of ["unknown", "denied", "suppressed", "granted"] as const) {
      const input = { purpose, recipientKind: "customer" as const, permission: { state } };
      const result = evaluateCommunicationPolicy(input);
      const unconditional = ["transactional", "subscription_dunning", "admin_notification"].includes(purpose);
      expect(result).toEqual(purpose === "admin_notification" ? { decision: "allowed", reason: "admin_notification" } : unconditional ? { decision: "allowed", reason: "purpose_allowed_without_marketing_consent" } : purpose === "tester_program" ? { decision: state === "granted" ? "allowed" : "blocked", reason: state === "granted" ? "tester_program_granted" : state === "unknown" ? "missing_tester_program_permission" : `permission_${state}` } : { decision: state === "granted" ? "allowed" : "blocked", reason: state === "granted" ? "marketing_permission_granted" : state === "suppressed" ? "permission_suppressed" : "missing_marketing_permission" });
    }
    const token = createCommunicationPreferenceToken({ email: " Reader@Example.invalid ", purpose: purpose as "tester_program", expiresAt: 100 }, "synthetic");
    expect(verifyCommunicationPreferenceToken(token, "synthetic", 100)).toEqual(["tester_program", "marketing_launch_offer", "marketing_newsletter"].includes(purpose) ? { email: "reader@example.invalid", purpose, expiresAt: 100 } : null);
    expect(newsletterMarketingPurposeSchema.safeParse(purpose).success).toBe(["marketing_launch_offer", "marketing_newsletter"].includes(purpose));
  }
  expect(evaluateCommunicationPolicy({ purpose: "tester_program", recipientKind: "tester", permission: { state: "granted", legacySequencePaused: true } })).toEqual({ decision: "blocked", reason: "sequence_paused" });
  expect(newsletterMarketingPurposeSchema.safeParse("custom_notice").success).toBe(false);
  expect(canonicalNewsletterWebhookEventSchema.safeParse({ providerKind: "synthetic", providerEventId: "1", eventType: "unsubscribe", purpose: "custom_notice" }).success).toBe(false);
});
