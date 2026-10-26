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
