export type NewsletterProviderKind = string;
export type NewsletterMarketingPurpose = "marketing_launch_offer" | "marketing_newsletter";
export type NewsletterSyncEventType = "subscribe" | "update" | "unsubscribe" | "suppress";
export type NewsletterWebhookEventType = "subscribe" | "update" | "unsubscribe" | "suppress" | "complaint" | "bounce" | "email_change" | "profile_update" | "ignored";
export type NewsletterProviderCapabilityKey =
  "subscribe" | "unsubscribe" | "suppress" | "unsuppress" | "doubleOptIn" | "emailChange" | "listMembership" | "webhookIdempotency" | "retryAfter";

export type NewsletterProviderCapabilities = Record<NewsletterProviderCapabilityKey, boolean>;

export interface NewsletterWebhookEvent {
  providerKind: NewsletterProviderKind;
  providerEventId: string;
  eventType: NewsletterWebhookEventType;
  email: string | null;
  remoteProfileId: string | null;
  remoteListId: string | null;
  purpose: NewsletterMarketingPurpose | null;
  explicitOptInEvidence: boolean;
  doubleOptInStatus: "confirmed" | "pending" | "unknown";
  occurredAt: string | null;
  rawPayload: Record<string, unknown>;
}


export interface NewsletterSyncEvent {
  id: string;
  claimToken: string;
  contactId: string;
  normalizedEmail: string;
  eventType: NewsletterSyncEventType;
  purpose: NewsletterMarketingPurpose;
  payload: Record<string, unknown>;
  attemptCount: number;
  originProviderKind?: NewsletterProviderKind | null;
  originProviderEventId?: string | null;
  remoteProfileId?: string | null;
  remoteListId?: string | null;
}


export type NewsletterSyncOutcome =
  | {
      status: "sent";
      remoteProfileId?: string | null;
      responseSummary?: Record<string, unknown>;
    }
  | {
      status: "skipped";
      reason: string;
      responseSummary?: Record<string, unknown>;
    }
  | {
      status: "retry";
      reason: string;
      retryAfterSeconds?: number;
    };

export interface NewsletterSyncProviderPort {
  readonly providerKind: string;
  readonly capabilities: NewsletterProviderCapabilities;
  sync(event: NewsletterSyncEvent): Promise<NewsletterSyncOutcome>;
  reconcile?(): Promise<NewsletterSyncReconcileOutcome>;
}

export type NewsletterSyncReconcileOutcome =
  | {
      status: "skipped";
      reason: string;
      responseSummary?: Record<string, unknown>;
    }
  | {
      status: "checked";
      checked: number;
      updated: number;
      failures: number;
      responseSummary?: Record<string, unknown>;
    };

