import type { OperatorContext } from "./customer360.js";
export type OperatorSubscriptionAction = "pause" | "resume" | "slide_next_cycle" | "change_shipping_address";
export interface OperatorNewShippingAddress {
  recipientName: string; line1: string; line2?: string; postalCode: string;
  city: string; country: string; contactPhone?: string;
}
export type OperatorShippingAddressPayload = { shippingAddressId: string; reason?: string }
  | { newAddress: OperatorNewShippingAddress; reason?: string };
export type OperatorSubscriptionPayload = {
  pausePreset?: "2_weeks" | "1_month" | "indefinite"; reason?: string;
  newNextCycleAt?: string; slideMinDays?: number; confirmedChargeTiming?: boolean;
} | OperatorShippingAddressPayload;
export type OperatorSubscriptionRefusal = "subscription_not_found" | "subject_not_found"
  | "subject_account_unlinked" | "version_conflict" | "slide_target_invalid" | "slide_not_available"
  | "slide_out_of_window" | "payment_blocked" | "invalid_transition" | "charge_timing_not_confirmed"
  | "payment_method_not_chargeable" | "invalid_address";
export type RecoveryRefusal = "subject_not_found" | "case_not_found" | "lifecycle_not_eligible"
  | "dunning_authority_unavailable" | "case_not_open" | "recoverable_order_unavailable";
export type EmailCorrectionRefusal = "subject_not_found" | "subject_account_linked" | "email_expectation_conflict" | "email_already_in_use";
export type PhoneCorrectionRefusal = "subject_not_found" | "phone_expectation_conflict";
export type LeadRefusal = "lead_not_found" | "customer_not_found" | "lead_email_expectation_conflict"
  | "lead_has_identity" | "lead_has_commercial_footprint" | "unclassified_referencing_table";
export type OperatorContactCommand =
  | { action: "correct_email"; subjectId: string; expectedEmail: string; newEmail: string; idempotencyKey: string }
  | { action: "correct_phone"; subjectId: string; expectedPhone: string; newPhone: string; idempotencyKey: string };
export interface OperatorLeadCommand { action: "absorb_lead"; subjectId: string; leadId: string; expectedLeadEmail: string; idempotencyKey: string }
export type OperatorRecoveryCommand =
  | { action: "issue_recovery"; subjectId: string; caseId: string; idempotencyKey: string }
  | { action: "apply_subscription_action"; subscriptionId: string; subscriptionAction: OperatorSubscriptionAction;
      expectedVersion: number; idempotencyKey: string; payload?: OperatorSubscriptionPayload }
  | OperatorContactCommand | OperatorLeadCommand;
/** Carries trusted context and the original command; performs no authorization or writes.
 * The host preserves the command key, optional reason and expected version.
 */
export interface OperatorRecoveryCommandEnvelope<Command = OperatorRecoveryCommand> {
  actor: OperatorContext;
  subject: { subjectId: string; subscriptionId?: string; orderId?: string; caseId?: string };
  command: Command; reason: string | null; idempotencyKey: string; expectedVersion: number | null;
  evidence: readonly { owner: string; resourceId: string; revision: string | null }[];
}
export type OperatorSubscriptionResult =
  | { outcome: "applied" | "noop" | "replayed"; subscriptionStatus: string; nextCycleAt: string | null;
      templateVersion: number; eventId: string | null; appliedBy: "operator_reschedule_band" | "customer_self_service_delegate" | null }
  | { outcome: "refused" | "conflict"; refusalCode: OperatorSubscriptionRefusal };

/** Actual M10 receipt evidence; support never manufactures an audit identifier. */
export interface OperatorOwnerReceipt {
  id: string; actorId: string; idempotencyKey: string; commandFingerprint: string;
  result: Record<string, unknown>;
}
/** Additive native superset. The managed transcription above remains unchanged. */
export type NativeOperatorSubscriptionResult =
  | (OperatorSubscriptionResult & { ownerReceipt?: OperatorOwnerReceipt })
  | { outcome: "refused"; refusalCode: "operator_subscription_authority_unavailable"; ownerReceipt?: OperatorOwnerReceipt };
export type OperatorAuthorityUnavailable = { outcome: "refused"; refusalCode: "operator_subscription_authority_unavailable" };
export type OperatorEmailCorrectionResult =
  | { outcome: "applied" | "noop" | "replayed"; authUserLinked: boolean }
  | { outcome: "refused" | "conflict"; refusalCode: EmailCorrectionRefusal };
export type OperatorPhoneCorrectionResult = { outcome: "applied" | "noop" | "replayed" }
  | { outcome: "refused" | "conflict"; refusalCode: PhoneCorrectionRefusal };
export type CustomerRecoveryAuthorityResult =
  | { outcome: "issued"; deliveryStatus: string; auditEventId: string }
  | { outcome: "replayed"; deliveryStatus: string; auditEventId: string }
  | { outcome: "refused"; refusalCode: RecoveryRefusal }
  | { outcome: "conflict"; conflictCode: "idempotency_conflict" };
export interface LeadAbsorptionCarried { personalization: number; consents: number; sourceLinks: number; deliveries: number }
export type OperatorLeadAbsorptionResult =
  | { outcome: "applied" | "noop" | "replayed"; leadId: string; customerId: string; carried: LeadAbsorptionCarried }
  | { outcome: "refused" | "conflict"; leadId: string; refusalCode: LeadRefusal; blockingTables: string[] };
export interface OperatorEmailCorrectionClaim { idempotencyKey: string; claimToken: string; sequence: string }
export interface OperatorIdentityMovePort {
  findClientHoldingEmail(email: string): Promise<{ clientId: string } | null>;
  readIdentityEmail(authUserId: string): Promise<string>;
  moveIdentityEmail(authUserId: string, email: string, claim: OperatorEmailCorrectionClaim): Promise<void>;
}
export type OperatorEmailCorrectionAdmission = OperatorEmailCorrectionResult | {
  outcome: "admitted"; authUserId: string | null; originalEmail: string; newEmail: string;
};
export type OperatorEmailCorrectionPhase = "complete" | "release" | "fail";
export type OperatorEmailCorrectionSettlement = OperatorEmailCorrectionResult | { outcome: "pending" } | { outcome: "failed" };
export type OperatorEmailCorrectionExecution = OperatorEmailCorrectionSettlement | (OperatorEmailCorrectionClaim & {
  outcome: "claimed"; authUserId: string | null; originalEmail: string; newEmail: string;
});
export type OperatorAccountLinkRefusal = "subject_not_found" | "subject_not_customer" | "subject_email_missing"
  | "email_expectation_conflict" | "subject_account_linked" | "identity_not_linkable" | "identity_linked_elsewhere";
export type OperatorAccountLinkResult = { outcome: "applied" | "noop" | "replayed" }
  | { outcome: "refused" | "conflict"; refusalCode: OperatorAccountLinkRefusal };
export interface OperatorAccountLinkRequest { action: "link_account"; subjectId: string; expectedEmail: string; idempotencyKey: string }
export interface OperatorAccountLinkIdentityPort {
  findSubject(clientId: string): Promise<{ identityKind: string | null; email: string | null; authUserId: string | null } | null>;
  resolveIdentityForEmail(email: string): Promise<string>;
}
export interface OperatorSubscriptionInput {
  subscriptionId: string; subscriptionAction: OperatorSubscriptionAction; expectedVersion: number;
  payload: OperatorSubscriptionPayload; idempotencyKey: string; operatorId: string;
}
export interface OperatorEmailInput { subjectId: string; expectedEmail: string; newEmail: string; idempotencyKey: string; operatorId: string }
export interface OperatorPhoneInput { subjectId: string; expectedPhone: string; newPhone: string; idempotencyKey: string; operatorId: string }
export interface OperatorLinkInput { subjectId: string; expectedEmail: string; authUserId: string | null; idempotencyKey: string; operatorId: string }
export interface OperatorRecoveryInput { subjectId: string; caseId: string; idempotencyKey: string; operatorId: string }
export interface OperatorAbsorptionInput { customerId: string; leadId: string; expectedLeadEmail: string; idempotencyKey: string; operatorId: string }
export interface ManagedOperatorAuthorityPort {
  applySubscriptionAction(input: OperatorSubscriptionInput): Promise<OperatorSubscriptionResult>;
  correctSubjectEmail(input: OperatorEmailInput): Promise<OperatorEmailCorrectionAdmission>;
  claimSubjectEmail(input: { idempotencyKey: string }): Promise<OperatorEmailCorrectionExecution>;
  settleSubjectEmail(input: { idempotencyKey: string; claimToken: string; phase: OperatorEmailCorrectionPhase }): Promise<OperatorEmailCorrectionSettlement>;
  correctSubjectPhone(input: OperatorPhoneInput): Promise<OperatorPhoneCorrectionResult>;
  linkSubjectAccount(input: OperatorLinkInput): Promise<OperatorAccountLinkResult>;
  issueRecovery(input: OperatorRecoveryInput): Promise<CustomerRecoveryAuthorityResult>;
  absorbLead(input: OperatorAbsorptionInput): Promise<OperatorLeadAbsorptionResult>;
}
export interface NativeOperatorAuthorityPort {
  applySubscriptionAction(input: OperatorSubscriptionInput): Promise<NativeOperatorSubscriptionResult>;
  correctSubjectEmail(input: OperatorEmailInput): Promise<OperatorAuthorityUnavailable>;
  correctSubjectPhone(input: OperatorPhoneInput): Promise<OperatorAuthorityUnavailable>;
  linkSubjectAccount(input: OperatorLinkInput): Promise<OperatorAuthorityUnavailable>;
  issueRecovery(input: OperatorRecoveryInput): Promise<CustomerRecoveryAuthorityResult>;
  absorbLead(input: OperatorAbsorptionInput): Promise<OperatorLeadAbsorptionResult>;
}
export type LinkThenSubscriptionResult =
  | { outcome: "link_refused"; link: OperatorAccountLinkResult | OperatorAuthorityUnavailable }
  | { outcome: "completed"; link: OperatorAccountLinkResult; subscription: NativeOperatorSubscriptionResult }
  | { outcome: "partial"; link: OperatorAccountLinkResult; subscription: NativeOperatorSubscriptionResult | null };
