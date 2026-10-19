import type { NewsletterMarketingPurpose, NewsletterWebhookEvent } from "./newsletter.js";
export type NormalizedNewsletterWebhookEvent = NewsletterWebhookEvent;
export interface NewsletterWebhookPort {
  recordProviderEvent(input: NewsletterWebhookEvent & {
    state: "unknown" | "granted" | "denied" | "suppressed" | null;
    processingStatus: "received" | "ignored";
  }): Promise<{ providerEventId: string; contactId: string | null; inserted: boolean }>;
  recordPermission(input: {
    contactId: string;
    providerKind: string;
    providerEventId: string;
    purpose: NewsletterMarketingPurpose;
    state: "granted" | "suppressed";
    reason: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
  markProviderEvent(input: {
    providerEventId: string;
    status: "processed" | "ignored" | "failed";
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

