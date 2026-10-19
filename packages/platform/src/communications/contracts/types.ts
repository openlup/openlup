type COMMUNICATION_CHANNEL = "email";

type EMAIL_SEND_STATUSES = "queued" | "sent" | "delivered" | "bounced" | "complained" | "failed" | "skipped";

type EMAIL_SEND_SKIP_REASONS = "sequence_paused" | "already_sent" | "template_unavailable" | "race_lost" | "policy_blocked" | "admin_disabled";

type RESEND_EMAIL_EVENT_TYPES = "email.sent" | "email.delivered" | "email.delivery_delayed" | "email.opened" | "email.clicked" | "email.bounced" | "email.complained" | "email.failed" | "email.suppressed" | "email.scheduled";

export type CommunicationChannel = COMMUNICATION_CHANNEL;
/** The host supplies its persisted provider vocabulary. */
export type CommunicationProvider<Provider extends string = string> = Provider;
export type EmailSendStatus = EMAIL_SEND_STATUSES;
export type EmailSendSkipReason = EMAIL_SEND_SKIP_REASONS;
export type ResendEmailEventType = RESEND_EMAIL_EVENT_TYPES;

type COMMUNICATION_PURPOSES = "transactional" | "tester_program" | "marketing_launch_offer" | "marketing_newsletter" | "subscription_dunning" | "admin_notification";

type COMMUNICATION_PERMISSION_STATES = "unknown" | "granted" | "denied" | "suppressed";

type COMMUNICATION_POLICY_DECISIONS = "allowed" | "blocked";

export type CommunicationPurpose = COMMUNICATION_PURPOSES;
export type CommunicationPermissionState = COMMUNICATION_PERMISSION_STATES;
export type CommunicationPolicyDecision = COMMUNICATION_POLICY_DECISIONS;

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

export interface EmailMessageReadModel<Provider extends string = string> {
  id: string;
  channel: CommunicationChannel;
  recipientId: string;
  templateSlug: string;
  status: EmailSendStatus;
  provider: CommunicationProvider<Provider> | null;
  providerMessageId: string | null;
  skippedReason: EmailSendSkipReason | null;
}
