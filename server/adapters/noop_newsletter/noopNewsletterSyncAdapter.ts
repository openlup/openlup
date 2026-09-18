import type {
  NewsletterSyncEvent,
  NewsletterSyncOutcome,
  NewsletterSyncProviderPort,
} from "../../../src/domains/communications/ports.js";
import { fullNewsletterProviderCapabilities } from "../../../src/domains/communications/newsletterIntegrationContracts.js";

export const NOOP_NEWSLETTER_PROVIDER_KIND = "noop_newsletter";

export function createNoopNewsletterSyncAdapter(): NewsletterSyncProviderPort {
  return {
    providerKind: NOOP_NEWSLETTER_PROVIDER_KIND,
    capabilities: fullNewsletterProviderCapabilities,
    async sync(event: NewsletterSyncEvent): Promise<NewsletterSyncOutcome> {
      return {
        status: "sent",
        remoteProfileId: `noop:${event.contactId}`,
        responseSummary: {
          providerCall: false,
          eventType: event.eventType,
          purpose: event.purpose,
        },
      };
    },
    async reconcile() {
      return {
        status: "skipped" as const,
        reason: "provider_neutral_reconcile_noop",
        responseSummary: { providerCall: false },
      };
    },
  };
}
