export interface ClientsRecipient {
  email: string;
  firstName: string | null;
  country?: string | null;
}

export interface ClientsRecipientPort {
  resolve(clientId: string, signal: AbortSignal): Promise<ClientsRecipient | null>;
}

export interface DueWinbackSubscription {
  subscriptionId: string;
  clientId: string;
  endedAt: string | null;
  subjectReference: string | null;
}

export interface SubscriptionWinbackPort {
  listDueForWinback(limit: number): Promise<DueWinbackSubscription[]>;
  recordMessageAccepted(
    subscriptionId: string,
    endedAt: string | null,
  ): Promise<"recorded" | "deduped">;
}

export interface AutoResumeJobResult {
  ok: boolean;
  scanned: number;
  resumed: number;
  skippedRows: number;
  failed: number;
  reason?: string;
  skipped?: boolean;
}

export interface SubscriptionAutoResumePort {
  run(limit: number): Promise<AutoResumeJobResult>;
}

export type SubscriberRetentionRefusal =
  | "control_disabled"
  | "consent_missing"
  | "stale_revision"
  | "subscription_state_ineligible"
  | "review_request_not_accepted"
  | "source_kind_ineligible"
  | "source_not_found"
  | "source_subject_mismatch"
  | "source_subscription_mismatch"
  | "authorization_contract_invalid"
  | "source_ineligible"
  | "idempotency_contract_invalid"
  | "source_kind_already_planned"
  | "access_grant_unavailable"
  | "delivery_failed";

export interface SubscriberProfile {
  subjectReference: string;
  displayName: string | null;
  locale: string | null;
  revision: number;
}

export interface SubscriberPersonalizationFacts {
  subjectReference: string;
  displayFacts: Readonly<Record<string, string>>;
  capabilities: readonly string[];
  locale: string | null;
  revision: number;
}

export interface SubscriberMessageIntent {
  intentId: string;
  subjectReference: string;
  subscriptionId: string | null;
  sourceReference: string;
  accessGrantReference: string | null;
  kind: "paid_cycle_recap" | "reorder_reminder" | "review_request" | "review_effects" | "winback";
  templateReference: string;
  fingerprint: string;
  status: "planned" | "dispatching" | "accepted" | "failed" | "refused";
  refusal: SubscriberRetentionRefusal | null;
  deliveryReference: string | null;
  attemptCount: number;
  replayed: boolean;
}

export interface SubscriberPendingIntent {
  idempotencyKey: string;
  subjectReference: string;
  kind: SubscriberMessageIntent["kind"];
  templateReference: string;
  accessGrantReference: string | null;
  fingerprint: string;
  claimReference: string;
}

export interface SubscriberRetentionPlanResult {
  scanned: number;
  planned: number;
  refused: number;
  replayed: number;
}

export interface SubscriberRetentionPort {
  upsertProfile(input: {
    profile: SubscriberProfile;
    facts: SubscriberPersonalizationFacts;
    fingerprint: string;
  }): Promise<{ replayed: boolean }>;
  createIntent(input: {
    idempotencyKey: string;
    subjectReference: string;
    subscriptionId: string | null;
    sourceReference: string;
    kind: SubscriberMessageIntent["kind"];
    templateReference: string;
    fingerprint: string;
    expectedRevision: number;
    recipientFingerprint: string;
    controlKey: string;
    consentPurpose: string | null;
  }): Promise<SubscriberMessageIntent>;
  recordDelivery(input: {
    idempotencyKey: string;
    fingerprint: string;
    state: "accepted" | "failed";
    deliveryReference: string | null;
    attemptCount: number;
    claimReference: string;
  }): Promise<SubscriberMessageIntent>;
  readProfile(subjectReference: string): Promise<{
    profile: SubscriberProfile;
    facts: SubscriberPersonalizationFacts;
  } | null>;
  readIntent(intentId: string): Promise<SubscriberMessageIntent | null>;
  planDue(kind: SubscriberMessageIntent["kind"], limit: number): Promise<SubscriberRetentionPlanResult>;
  claimIntent(idempotencyKey: string, fingerprint: string): Promise<SubscriberPendingIntent | null>;
  listPending(kind: SubscriberMessageIntent["kind"], limit: number): Promise<SubscriberPendingIntent[]>;
}
