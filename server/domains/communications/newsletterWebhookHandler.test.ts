import { describe, expect, it, vi } from "vitest";
import { createNewsletterWebhookHandler } from "./newsletterWebhookHandler.js";
import type { VercelResponse } from "../../_lib/types/vercel.js";

function response(): VercelResponse {
  return {
    status: vi.fn(function status(this: VercelResponse) { return this; }),
    json: vi.fn(function json(this: VercelResponse) { return this; }),
    setHeader: vi.fn(),
  } as unknown as VercelResponse;
}

describe("newsletter webhook handler", () => {
  it("suppresses marketing permissions from provider unsubscribe", async () => {
    const port = {
      recordProviderEvent: vi.fn(async () => ({ providerEventId: "evt-row", contactId: "contact-1", inserted: true })),
      recordPermission: vi.fn(async () => undefined),
      markProviderEvent: vi.fn(async () => undefined),
    };
    const res = response();

    await createNewsletterWebhookHandler({
      providerKind: "noop_newsletter",
      enabled: () => true,
      verifyAndNormalize: async () => ({
        providerKind: "noop_newsletter",
        providerEventId: "provider-evt-1",
        eventType: "unsubscribe",
        email: "ala@example.com",
        remoteProfileId: "remote-1",
        remoteListId: null,
        purpose: null,
        explicitOptInEvidence: false,
        doubleOptInStatus: "unknown",
        occurredAt: null,
        rawPayload: {},
      }),
      port,
    })({ method: "POST" } as never, res);

    expect(port.recordPermission).toHaveBeenCalledTimes(2);
    expect(port.recordPermission).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "marketing_newsletter",
      state: "suppressed",
    }));
  });

  it("audits subscribe without verified opt-in but does not grant permission", async () => {
    const port = {
      recordProviderEvent: vi.fn(async () => ({ providerEventId: "evt-row", contactId: "contact-1", inserted: true })),
      recordPermission: vi.fn(async () => undefined),
      markProviderEvent: vi.fn(async () => undefined),
    };
    const res = response();

    await createNewsletterWebhookHandler({
      providerKind: "noop_newsletter",
      enabled: () => true,
      verifyAndNormalize: async () => ({
        providerKind: "noop_newsletter",
        providerEventId: "provider-evt-2",
        eventType: "subscribe",
        email: "ala@example.com",
        remoteProfileId: "remote-1",
        remoteListId: null,
        purpose: "marketing_newsletter",
        explicitOptInEvidence: false,
        doubleOptInStatus: "pending",
        occurredAt: null,
        rawPayload: {},
      }),
      port,
    })({ method: "POST" } as never, res);

    expect(port.recordPermission).not.toHaveBeenCalled();
    expect(port.markProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: "ignored",
      metadata: expect.objectContaining({ reason: "provider_subscribe_without_verified_opt_in" }),
    }));
  });
});
