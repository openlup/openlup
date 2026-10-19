/** Delivery seam for public intake capabilities. */
export type PublicIntakeDeliveryPurpose = "transactional" | "admin_notification";
export type PublicIntakeRecipientKind = "external_contact" | "admin_internal";

export interface PublicIntakePolicyDecision {
  allowed: boolean;
  reason: string;
  decisionId: string | null;
}

export interface PublicIntakeDeliveryResult {
  /** The delivery implementation returned a durable message identifier. */
  accepted: boolean;
  messageId: string | null;
  /** A policy or explicit no-egress terminal outcome. */
  skip: string | null;
  /** A non-sent terminal outcome, including an ambiguous provider acceptance. */
  error: string | null;
}

export interface PublicIntakeDeliveryMessage {
  sender: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface PublicIntakeDeliveryPort {
  evaluatePolicy(input: {
    email: string | null | undefined;
    purpose: PublicIntakeDeliveryPurpose;
    source: string;
    recipientKind: PublicIntakeRecipientKind;
    sourceTable?: "b2b_inquiries";
    sourceId?: string | null;
    metadata: Record<string, unknown>;
  }): Promise<PublicIntakePolicyDecision>;
  deliver(input: {
    source: string;
    templateSlug: string;
    policyDecisionId: string | null;
    dedupeKey: string;
    purpose: PublicIntakeDeliveryPurpose;
    triggerEvent: string;
    recipientEmail: string;
    aggregateType: string;
    aggregateId: string;
    metadata?: Record<string, unknown>;
    message: PublicIntakeDeliveryMessage;
  }): Promise<PublicIntakeDeliveryResult>;
}
