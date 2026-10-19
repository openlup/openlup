import type { NewsletterMarketingPurpose, NewsletterWebhookEvent } from "./newsletter.js";
export type NormalizedNewsletterWebhookEvent<Purpose extends string = NewsletterMarketingPurpose> = NewsletterWebhookEvent<Purpose>;
export interface NewsletterWebhookPort<Purpose extends string = NewsletterMarketingPurpose> {
  recordProviderEvent(input: NewsletterWebhookEvent<Purpose> & {
    state: "unknown" | "granted" | "denied" | "suppressed" | null;
    processingStatus: "received" | "ignored";
  }): Promise<{ providerEventId: string; contactId: string | null; inserted: boolean }>;
  recordPermission(input: {
    contactId: string;
    providerKind: string;
    providerEventId: string;
    purpose: Purpose;
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

