import type {
  NewsletterSyncEvent,
  NewsletterSyncProviderPort,
} from "../../../src/domains/communications/ports.js";
import {
  requiredNewsletterCapabilityForEvent,
  supportsNewsletterSyncEvent,
} from "../../../src/domains/communications/newsletterIntegrationContracts.js";

export interface CommunicationSyncStore {
  claimBatch(input: {
    providerKind: string;
    batchSize: number;
    visibilitySeconds: number;
    maxAttempts: number;
  }): Promise<NewsletterSyncEvent[]>;
  markSent(input: {
    eventId: string;
    claimToken: string;
    providerKind: string;
    remoteProfileId?: string | null;
    responseSummary?: Record<string, unknown>;
  }): Promise<boolean>;
  markFailed(input: {
    eventId: string;
    claimToken: string;
    providerKind: string;
    error: string;
    retry: boolean;
    backoffSeconds: number;
  }): Promise<boolean>;
}

export interface CommunicationSyncConfig {
  batchSize: number;
  maxAttempts: number;
  visibilitySeconds: number;
  backoffSeconds: number;
}

export interface CommunicationSyncRunResult {
  ok: boolean;
  checked: number;
  updated: number;
  failures: number;
  skipped: boolean;
  reason?: string;
  providerKind: string;
  sent: number;
  retried: number;
  skippedEvents: number;
}

export const DEFAULT_COMMUNICATION_SYNC_CONFIG: CommunicationSyncConfig = {
  batchSize: 25,
  maxAttempts: 8,
  visibilitySeconds: 300,
  backoffSeconds: 300,
};

export async function runCommunicationSyncDispatch(input: {
  store: CommunicationSyncStore;
  provider: NewsletterSyncProviderPort;
  config?: Partial<CommunicationSyncConfig>;
}): Promise<CommunicationSyncRunResult> {
  const config = { ...DEFAULT_COMMUNICATION_SYNC_CONFIG, ...input.config };
  const events = await input.store.claimBatch({
    providerKind: input.provider.providerKind,
    batchSize: clamp(config.batchSize, 1, 100),
    visibilitySeconds: clamp(config.visibilitySeconds, 60, 3600),
    maxAttempts: clamp(config.maxAttempts, 1, 20),
  });

  const result: CommunicationSyncRunResult = {
    ok: true,
    checked: events.length,
    updated: 0,
    failures: 0,
    skipped: events.length === 0,
    reason: events.length === 0 ? "empty_queue" : undefined,
    providerKind: input.provider.providerKind,
    sent: 0,
    retried: 0,
    skippedEvents: 0,
  };

  for (const event of events) {
    try {
      if (event.originProviderKind === input.provider.providerKind) {
        const applied = await input.store.markSent({
          eventId: event.id,
          claimToken: event.claimToken,
          providerKind: input.provider.providerKind,
          remoteProfileId: event.remoteProfileId ?? null,
          responseSummary: {
            status: "skipped",
            reason: "origin_provider_echo_loop",
            originProviderKind: event.originProviderKind,
            originProviderEventId: event.originProviderEventId ?? null,
          },
        });
        result.updated += applied ? 1 : 0;
        result.skippedEvents += 1;
        continue;
      }

      if (!supportsNewsletterSyncEvent(input.provider.capabilities, event.eventType)) {
        const requiredCapability = requiredNewsletterCapabilityForEvent(event.eventType);
        const applied = await input.store.markSent({
          eventId: event.id,
          claimToken: event.claimToken,
          providerKind: input.provider.providerKind,
          remoteProfileId: event.remoteProfileId ?? null,
          responseSummary: {
            status: "skipped",
            reason: "unsupported_provider_capability",
            eventType: event.eventType,
            requiredCapability,
          },
        });
        result.updated += applied ? 1 : 0;
        result.skippedEvents += 1;
        continue;
      }

      const outcome = await input.provider.sync(event);
      if (outcome.status === "sent" || outcome.status === "skipped") {
        const applied = await input.store.markSent({
          eventId: event.id,
          claimToken: event.claimToken,
          providerKind: input.provider.providerKind,
          remoteProfileId: outcome.status === "sent" ? outcome.remoteProfileId : null,
          responseSummary: {
            status: outcome.status,
            ...(outcome.responseSummary ?? {}),
            ...(outcome.status === "skipped" ? { reason: outcome.reason } : {}),
          },
        });
        result.updated += applied ? 1 : 0;
        if (outcome.status === "sent") result.sent += 1;
        if (outcome.status === "skipped") result.skippedEvents += 1;
        continue;
      }

      await input.store.markFailed({
        eventId: event.id,
        claimToken: event.claimToken,
        providerKind: input.provider.providerKind,
        error: outcome.reason,
        retry: true,
        backoffSeconds: outcome.retryAfterSeconds ?? config.backoffSeconds,
      });
      result.retried += 1;
      result.failures += 1;
    } catch (error) {
      await input.store.markFailed({
        eventId: event.id,
        claimToken: event.claimToken,
        providerKind: input.provider.providerKind,
        error: safeMessage(error),
        retry: event.attemptCount + 1 < config.maxAttempts,
        backoffSeconds: config.backoffSeconds,
      });
      result.retried += 1;
      result.failures += 1;
    }
  }

  result.ok = result.failures === 0;
  if (!result.ok) result.reason = "communication_sync_failures";
  return result;
}

export async function runCommunicationSyncDispatchForProviders(input: {
  store: CommunicationSyncStore;
  providers: NewsletterSyncProviderPort[];
  config?: Partial<CommunicationSyncConfig>;
}): Promise<CommunicationSyncRunResult> {
  if (input.providers.length === 0) {
    return {
      ok: true,
      checked: 0,
      updated: 0,
      failures: 0,
      skipped: true,
      reason: "no_newsletter_providers_enabled",
      providerKind: "provider_registry",
      sent: 0,
      retried: 0,
      skippedEvents: 0,
    };
  }

  const results: CommunicationSyncRunResult[] = [];
  for (const provider of input.providers) {
    results.push(await runCommunicationSyncDispatch({
      store: input.store,
      provider,
      config: input.config,
    }));
  }
  return aggregateProviderResults(results);
}

export interface CommunicationReconcileRunResult {
  ok: boolean;
  checked: number;
  updated: number;
  failures: number;
  skipped: boolean;
  reason?: string;
}

export async function runCommunicationSyncReconcile(input: {
  providers?: NewsletterSyncProviderPort[];
} = {}): Promise<CommunicationReconcileRunResult> {
  const providers = input.providers ?? [];
  if (providers.length === 0) {
    return {
      ok: true,
      checked: 0,
      updated: 0,
      failures: 0,
      skipped: true,
      reason: "no_newsletter_providers_enabled",
    };
  }

  let checked = 0;
  let updated = 0;
  let failures = 0;
  let skipped = 0;
  for (const provider of providers) {
    if (!provider.reconcile) {
      skipped += 1;
      continue;
    }
    const outcome = await provider.reconcile();
    if (outcome.status === "skipped") {
      skipped += 1;
      continue;
    }
    checked += outcome.checked;
    updated += outcome.updated;
    failures += outcome.failures;
  }

  return {
    ok: true,
    checked,
    updated,
    failures,
    skipped: skipped === providers.length,
    reason: skipped === providers.length ? "provider_neutral_reconcile_noop" : undefined,
  };
}

function aggregateProviderResults(results: CommunicationSyncRunResult[]): CommunicationSyncRunResult {
  const aggregate = results.reduce<CommunicationSyncRunResult>((acc, item) => ({
    ok: acc.ok && item.ok,
    checked: acc.checked + item.checked,
    updated: acc.updated + item.updated,
    failures: acc.failures + item.failures,
    skipped: acc.skipped && item.skipped,
    providerKind: "provider_registry",
    sent: acc.sent + item.sent,
    retried: acc.retried + item.retried,
    skippedEvents: acc.skippedEvents + item.skippedEvents,
    reason: undefined,
  }), {
    ok: true,
    checked: 0,
    updated: 0,
    failures: 0,
    skipped: true,
    providerKind: "provider_registry",
    sent: 0,
    retried: 0,
    skippedEvents: 0,
  });

  if (!aggregate.ok) aggregate.reason = "communication_sync_failures";
  if (aggregate.skipped) aggregate.reason = "empty_queue";
  return aggregate;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
