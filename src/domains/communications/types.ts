export const COMMUNICATION_CHANNEL = "email";
export const COMMUNICATION_PROVIDER = "resend";

export const EMAIL_SEND_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "skipped",
] as const;

export const EMAIL_SEND_SKIP_REASONS = [
  "sequence_paused",
  "already_sent",
  "template_unavailable",
  "race_lost",
  "policy_blocked",
  "admin_disabled",
] as const;

export const RESEND_EMAIL_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
  "email.scheduled",
] as const;

export type CommunicationChannel = typeof COMMUNICATION_CHANNEL;
export type CommunicationProvider = typeof COMMUNICATION_PROVIDER;
export type EmailSendStatus = (typeof EMAIL_SEND_STATUSES)[number];
export type EmailSendSkipReason = (typeof EMAIL_SEND_SKIP_REASONS)[number];
export type ResendEmailEventType = (typeof RESEND_EMAIL_EVENT_TYPES)[number];

export const COMMUNICATION_PURPOSES = [
  "transactional",
  "tester_program",
  "marketing_launch_offer",
  "marketing_newsletter",
  "subscription_dunning",
  "admin_notification",
] as const;

export const COMMUNICATION_PERMISSION_STATES = [
  "unknown",
  "granted",
  "denied",
  "suppressed",
] as const;

export const COMMUNICATION_POLICY_DECISIONS = ["allowed", "blocked"] as const;

export type CommunicationPurpose = (typeof COMMUNICATION_PURPOSES)[number];
export type CommunicationPermissionState = (typeof COMMUNICATION_PERMISSION_STATES)[number];
export type CommunicationPolicyDecision = (typeof COMMUNICATION_POLICY_DECISIONS)[number];

export interface CommunicationRecipientRef {
  system: "supabase";
  table: "testers";
  id: string;
  email: string | null;
}

export interface EmailTemplateRef {
  slug: string;
  locale: string | null;
}

export interface EmailSendDedupeKeyInput {
  recipientId: string;
  templateSlug: string;
}

export type EmailSendDecision =
  | { outcome: "send" }
  | {
      outcome: "skip";
      reason: EmailSendSkipReason;
      existingMessageId: string | null;
    };

export interface EmailMessageReadModel {
  id: string;
  channel: CommunicationChannel;
  recipientId: string;
  templateSlug: string;
  status: EmailSendStatus;
  provider: CommunicationProvider | null;
  providerMessageId: string | null;
  skippedReason: EmailSendSkipReason | null;
}
