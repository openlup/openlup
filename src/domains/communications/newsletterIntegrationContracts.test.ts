import { describe, expect, it } from "vitest";
import {
  canonicalNewsletterWebhookEventSchema,
  defaultNewsletterProviderCapabilities,
  fullNewsletterProviderCapabilities,
  normalizeCanonicalNewsletterWebhookEvent,
  requiredNewsletterCapabilityForEvent,
  supportsNewsletterSyncEvent,
} from "./newsletterIntegrationContracts.js";

describe("newsletter integration contracts", () => {
  it("accepts canonical provider events and applies stable defaults", () => {
    const parsed = canonicalNewsletterWebhookEventSchema.parse({
      providerKind: "noop_newsletter",
      providerEventId: "evt_1",
      eventType: "subscribe",
      email: "ala@example.com",
      purpose: "marketing_newsletter",
      occurredAt: "2026-06-14T10:00:00+00:00",
    });

    expect(normalizeCanonicalNewsletterWebhookEvent(parsed)).toMatchObject({
      providerKind: "noop_newsletter",
      providerEventId: "evt_1",
      eventType: "subscribe",
      explicitOptInEvidence: false,
      doubleOptInStatus: "unknown",
      remoteProfileId: null,
      remoteListId: null,
      rawPayload: {},
    });
  });

  it("rejects malformed provider identity and missing event type", () => {
    expect(canonicalNewsletterWebhookEventSchema.safeParse({
      providerKind: "Bad Provider",
      providerEventId: "evt_1",
    }).success).toBe(false);
  });

  it("maps outbound event types to declared provider capabilities", () => {
    expect(requiredNewsletterCapabilityForEvent("subscribe")).toBe("subscribe");
    expect(requiredNewsletterCapabilityForEvent("unsubscribe")).toBe("unsubscribe");
    expect(requiredNewsletterCapabilityForEvent("suppress")).toBe("suppress");
    expect(requiredNewsletterCapabilityForEvent("update")).toBe("listMembership");
    expect(supportsNewsletterSyncEvent(fullNewsletterProviderCapabilities, "subscribe")).toBe(true);
    expect(supportsNewsletterSyncEvent(defaultNewsletterProviderCapabilities, "subscribe")).toBe(false);
  });
});
