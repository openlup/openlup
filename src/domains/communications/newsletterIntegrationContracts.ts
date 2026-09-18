import { z } from "../../lib/validation/zod.js";

export const NEWSLETTER_MARKETING_PURPOSES = [
  "marketing_launch_offer",
  "marketing_newsletter",
] as const;

export const NEWSLETTER_SYNC_EVENT_TYPES = [
  "subscribe",
  "update",
  "unsubscribe",
  "suppress",
] as const;

export const NEWSLETTER_WEBHOOK_EVENT_TYPES = [
  ...NEWSLETTER_SYNC_EVENT_TYPES,
  "complaint",
  "bounce",
  "email_change",
  "profile_update",
  "ignored",
] as const;

export const NEWSLETTER_PROVIDER_CAPABILITY_KEYS = [
  "subscribe",
  "unsubscribe",
  "suppress",
  "unsuppress",
  "doubleOptIn",
  "emailChange",
  "listMembership",
  "webhookIdempotency",
  "retryAfter",
] as const;

export type NewsletterProviderKind = string;
export type NewsletterMarketingPurpose = typeof NEWSLETTER_MARKETING_PURPOSES[number];
export type NewsletterSyncEventType = typeof NEWSLETTER_SYNC_EVENT_TYPES[number];
export type NewsletterWebhookEventType = typeof NEWSLETTER_WEBHOOK_EVENT_TYPES[number];
export type NewsletterProviderCapabilityKey =
  typeof NEWSLETTER_PROVIDER_CAPABILITY_KEYS[number];

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

export const defaultNewsletterProviderCapabilities: NewsletterProviderCapabilities = {
  subscribe: false,
  unsubscribe: false,
  suppress: false,
  unsuppress: false,
  doubleOptIn: false,
  emailChange: false,
  listMembership: false,
  webhookIdempotency: false,
  retryAfter: false,
};

export const fullNewsletterProviderCapabilities: NewsletterProviderCapabilities = {
  subscribe: true,
  unsubscribe: true,
  suppress: true,
  unsuppress: true,
  doubleOptIn: true,
  emailChange: true,
  listMembership: true,
  webhookIdempotency: true,
  retryAfter: true,
};

export const newsletterProviderKindSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

export const newsletterMarketingPurposeSchema = z.enum(NEWSLETTER_MARKETING_PURPOSES);
export const newsletterSyncEventTypeSchema = z.enum(NEWSLETTER_SYNC_EVENT_TYPES);
export const newsletterWebhookEventTypeSchema = z.enum(NEWSLETTER_WEBHOOK_EVENT_TYPES);

export const newsletterProviderCapabilitiesSchema = z.object({
  subscribe: z.boolean(),
  unsubscribe: z.boolean(),
  suppress: z.boolean(),
  unsuppress: z.boolean(),
  doubleOptIn: z.boolean(),
  emailChange: z.boolean(),
  listMembership: z.boolean(),
  webhookIdempotency: z.boolean(),
  retryAfter: z.boolean(),
});

export const canonicalNewsletterWebhookEventSchema = z.object({
  providerKind: newsletterProviderKindSchema,
  providerEventId: z.string().trim().min(1).max(200),
  eventType: newsletterWebhookEventTypeSchema,
  email: z.string().trim().email().nullable().optional(),
  remoteProfileId: z.string().trim().min(1).max(200).nullable().optional(),
  remoteListId: z.string().trim().min(1).max(200).nullable().optional(),
  purpose: newsletterMarketingPurposeSchema.nullable().optional(),
  explicitOptInEvidence: z.boolean().optional(),
  doubleOptInStatus: z.enum(["confirmed", "pending", "unknown"]).optional(),
  occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type CanonicalNewsletterWebhookEvent = z.infer<
  typeof canonicalNewsletterWebhookEventSchema
>;

export function normalizeCanonicalNewsletterWebhookEvent(
  event: CanonicalNewsletterWebhookEvent,
): NewsletterWebhookEvent {
  return {
    providerKind: event.providerKind,
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    email: event.email ?? null,
    remoteProfileId: event.remoteProfileId ?? null,
    remoteListId: event.remoteListId ?? null,
    purpose: event.purpose ?? null,
    explicitOptInEvidence: event.explicitOptInEvidence === true,
    doubleOptInStatus: event.doubleOptInStatus ?? "unknown",
    occurredAt: event.occurredAt ?? null,
    rawPayload: event.payload ?? {},
  };
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

export function requiredNewsletterCapabilityForEvent(
  eventType: NewsletterSyncEventType,
): NewsletterProviderCapabilityKey {
  if (eventType === "subscribe") return "subscribe";
  if (eventType === "unsubscribe") return "unsubscribe";
  if (eventType === "suppress") return "suppress";
  return "listMembership";
}

export function supportsNewsletterSyncEvent(
  capabilities: NewsletterProviderCapabilities,
  eventType: NewsletterSyncEventType,
): boolean {
  return capabilities[requiredNewsletterCapabilityForEvent(eventType)] === true;
}
