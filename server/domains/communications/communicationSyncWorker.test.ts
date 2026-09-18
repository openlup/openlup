import { describe, expect, it, vi } from "vitest";
import {
  runCommunicationSyncDispatch,
  runCommunicationSyncDispatchForProviders,
  runCommunicationSyncReconcile,
} from "./communicationSyncWorker.js";
import {
  defaultNewsletterProviderCapabilities,
  fullNewsletterProviderCapabilities,
} from "../../../src/domains/communications/newsletterIntegrationContracts.js";
import type { NewsletterSyncEvent } from "../../../src/domains/communications/ports.js";

const EVENT: NewsletterSyncEvent = {
  id: "outbox-1",
  claimToken: "claim-1",
  contactId: "contact-1",
  normalizedEmail: "ala@example.com",
  eventType: "subscribe",
  purpose: "marketing_newsletter",
  payload: {},
  attemptCount: 1,
};

describe("communication sync worker", () => {
  it("marks noop provider success as sent", async () => {
    const store = {
      claimBatch: vi.fn(async () => [EVENT]),
      markSent: vi.fn(async () => true),
      markFailed: vi.fn(async () => true),
    };

    const result = await runCommunicationSyncDispatch({
      store,
      provider: {
        providerKind: "noop_newsletter",
        capabilities: fullNewsletterProviderCapabilities,
        sync: vi.fn(async () => ({ status: "sent" as const, remoteProfileId: "remote-1" })),
      },
    });

    expect(result).toMatchObject({ ok: true, checked: 1, sent: 1, failures: 0 });
    expect(store.markSent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "outbox-1",
      providerKind: "noop_newsletter",
      remoteProfileId: "remote-1",
    }));
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it("retries provider retry outcomes", async () => {
    const store = {
      claimBatch: vi.fn(async () => [EVENT]),
      markSent: vi.fn(async () => true),
      markFailed: vi.fn(async () => true),
    };

    const result = await runCommunicationSyncDispatch({
      store,
      provider: {
        providerKind: "noop_newsletter",
        capabilities: fullNewsletterProviderCapabilities,
        sync: vi.fn(async () => ({ status: "retry" as const, reason: "rate_limited", retryAfterSeconds: 120 })),
      },
    });

    expect(result).toMatchObject({ ok: false, checked: 1, retried: 1, failures: 1 });
    expect(store.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      error: "rate_limited",
      retry: true,
      backoffSeconds: 120,
    }));
  });

  it("skips unsupported provider capabilities without calling the provider", async () => {
    const sync = vi.fn();
    const store = {
      claimBatch: vi.fn(async () => [EVENT]),
      markSent: vi.fn(async () => true),
      markFailed: vi.fn(async () => true),
    };

    const result = await runCommunicationSyncDispatch({
      store,
      provider: {
        providerKind: "limited_newsletter",
        capabilities: defaultNewsletterProviderCapabilities,
        sync,
      },
    });

    expect(result).toMatchObject({ ok: true, checked: 1, skippedEvents: 1, failures: 0 });
    expect(sync).not.toHaveBeenCalled();
    expect(store.markSent).toHaveBeenCalledWith(expect.objectContaining({
      responseSummary: expect.objectContaining({
        reason: "unsupported_provider_capability",
        requiredCapability: "subscribe",
      }),
    }));
  });

  it("skips events originating from the same provider as an echo-loop guard", async () => {
    const sync = vi.fn();
    const store = {
      claimBatch: vi.fn(async () => [{
        ...EVENT,
        originProviderKind: "noop_newsletter",
        originProviderEventId: "provider-evt-1",
      }]),
      markSent: vi.fn(async () => true),
      markFailed: vi.fn(async () => true),
    };

    const result = await runCommunicationSyncDispatch({
      store,
      provider: {
        providerKind: "noop_newsletter",
        capabilities: fullNewsletterProviderCapabilities,
        sync,
      },
    });

    expect(result).toMatchObject({ ok: true, checked: 1, skippedEvents: 1 });
    expect(sync).not.toHaveBeenCalled();
    expect(store.markSent).toHaveBeenCalledWith(expect.objectContaining({
      responseSummary: expect.objectContaining({ reason: "origin_provider_echo_loop" }),
    }));
  });

  it("runs dispatch across enabled providers from a registry", async () => {
    const store = {
      claimBatch: vi.fn(async () => []),
      markSent: vi.fn(async () => true),
      markFailed: vi.fn(async () => true),
    };

    const result = await runCommunicationSyncDispatchForProviders({
      store,
      providers: [
        { providerKind: "one", capabilities: fullNewsletterProviderCapabilities, sync: vi.fn() },
        { providerKind: "two", capabilities: fullNewsletterProviderCapabilities, sync: vi.fn() },
      ],
    });

    expect(result).toMatchObject({ ok: true, checked: 0, skipped: true });
    expect(store.claimBatch).toHaveBeenCalledTimes(2);
  });

  it("reports noop reconcile through provider ports", async () => {
    const result = await runCommunicationSyncReconcile({
      providers: [{
        providerKind: "noop_newsletter",
        capabilities: fullNewsletterProviderCapabilities,
        sync: vi.fn(),
        reconcile: vi.fn(async () => ({
          status: "skipped" as const,
          reason: "provider_neutral_reconcile_noop",
        })),
      }],
    });

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      reason: "provider_neutral_reconcile_noop",
    });
  });
});
