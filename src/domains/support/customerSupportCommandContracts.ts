import { z } from "../../lib/validation/zod.js";

import {
  SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
  datetimeSchema,
  idSchema,
  nullableDatetimeSchema,
  statusSchema,
} from "./customer360Contracts.js";
import { operatorChangeShippingAddressPayloadSchema } from "./customerSupportAddressContracts.js";
import { idempotencyKeySchema, operatorEmailSchema, operatorLeadAbsorptionRequestSchema } from "./customerSubjectCorrectionContracts.js";

/**
 * The command half of the support customer-360 contract: every request an
 * operator may send on a subscriber's behalf, the outcome it settles on, and the
 * named refusals it may come back with.
 *
 * The read half — the snapshot, the candidate search and the projections the MCP tool
 * surface consumes — stays in ./customer360Contracts.ts, and only the read half is
 * imported here. That direction is deliberate: a command is always *about* the contract
 * version and the wire vocabulary the read half defines, so both halves quote one
 * `SUPPORT_CUSTOMER_360_CONTRACT_VERSION` and one set of id, timestamp and status
 * bounds instead of restating them and drifting apart.
 */

export const customerRecoveryCommandRequestSchema = z.object({
  action: z.literal("issue_recovery"),
  subjectId: idSchema,
  caseId: idSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const customerRecoveryRefusalCodeSchema = z.enum(["subject_not_found", "case_not_found",
  "lifecycle_not_eligible", "dunning_authority_unavailable", "case_not_open", "recoverable_order_unavailable"]);

const recoveryResponseBaseSchema = z.object({
  contractVersion: z.literal(SUPPORT_CUSTOMER_360_CONTRACT_VERSION),
  action: z.literal("issue_recovery"),
  subjectId: idSchema,
  caseId: idSchema,
});

export const customerRecoveryCommandResponseSchema = z.discriminatedUnion("outcome", [
  recoveryResponseBaseSchema.extend({
    outcome: z.literal("issued"),
    replayed: z.literal(false),
    deliveryStatus: statusSchema,
    auditEventId: idSchema,
  }).strict(),
  recoveryResponseBaseSchema.extend({
    outcome: z.literal("replayed"),
    replayed: z.literal(true),
    deliveryStatus: statusSchema,
    auditEventId: idSchema,
  }).strict(),
  recoveryResponseBaseSchema.extend({
    outcome: z.literal("refused"),
    replayed: z.literal(false),
    refusalCode: customerRecoveryRefusalCodeSchema,
  }).strict(),
  recoveryResponseBaseSchema.extend({
    outcome: z.literal("conflict"),
    replayed: z.literal(false),
    conflictCode: z.literal("idempotency_conflict"),
  }).strict(),
]);

const templateVersionSchema = z.number().int().min(1);

/**
 * E.164 only: the dispatch payload hands the provider `clients.phone` verbatim, so
 * storing a national number would reintroduce the defect this repairs. The console
 * normalizes with the canonical `normalizePhoneToE164`; this refuses the remainder.
 */
const operatorPhoneSchema = z.string().trim().regex(/^\+[1-9]\d{7,14}$/);

/** The subscription verbs an operator may run on a subscriber's behalf. */
export const operatorSubscriptionActionKindSchema = z.enum(["pause", "resume", "slide_next_cycle", "change_shipping_address"]);
export const operatorSubscriptionPausePresetSchema = z.enum(["2_weeks", "1_month", "indefinite"]);

/**
 * The delegate's own payload vocabulary plus the one operator-only key, or the address
 * payload from ./customerSupportAddressContracts.js, which states its own exclusion
 * rule. `slideMinDays` narrows the reschedule floor below the subscriber's three-day
 * minimum and is the operator's only extra latitude. Nothing here carries a principal,
 * a fingerprint or a quote lock: the authority derives the subscriber identity itself.
 */
export const operatorSubscriptionActionPayloadSchema = z.union([z.object({
  pausePreset: operatorSubscriptionPausePresetSchema.optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  newNextCycleAt: datetimeSchema.optional(),
  slideMinDays: z.number().int().min(1).max(60).optional(),
  confirmedChargeTiming: z.boolean().optional(),
}).strict(), operatorChangeShippingAddressPayloadSchema]);

export const operatorSubscriptionActionRequestSchema = z.object({
  action: z.literal("apply_subscription_action"),
  subscriptionId: idSchema,
  subscriptionAction: operatorSubscriptionActionKindSchema,
  expectedVersion: templateVersionSchema,
  idempotencyKey: idempotencyKeySchema,
  payload: operatorSubscriptionActionPayloadSchema.optional(),
}).strict();

/**
 * `expectedEmail` may be empty because a subject can reach support with no
 * address on file at all; the authority compares the trimmed lower-cased copy
 * either way and refuses when the expectation no longer holds.
 */
export const operatorEmailCorrectionRequestSchema = z.object({
  action: z.literal("correct_email"),
  subjectId: idSchema,
  expectedEmail: z.union([z.literal(""), operatorEmailSchema]),
  newEmail: operatorEmailSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/**
 * `expectedPhone` may be empty for the same reason `expectedEmail` may: a subject
 * can reach support with no number on file.
 */
export const operatorPhoneCorrectionRequestSchema = z.object({
  action: z.literal("correct_phone"),
  subjectId: idSchema,
  expectedPhone: z.union([z.literal(""), operatorPhoneSchema]),
  newPhone: operatorPhoneSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/**
 * Every command this route accepts, discriminated by `action`.
 *
 * `issue_recovery` keeps its original shape byte-for-byte so existing callers
 * and the MCP tool surface are unaffected.
 */
export const customerSupportCommandRequestSchema = z.discriminatedUnion("action", [
  customerRecoveryCommandRequestSchema,
  operatorSubscriptionActionRequestSchema,
  operatorEmailCorrectionRequestSchema,
  operatorPhoneCorrectionRequestSchema,
  operatorLeadAbsorptionRequestSchema,
]);

export const operatorCommandOutcomeSchema = z.enum(["applied", "noop", "replayed", "refused", "conflict"]);

/**
 * Which rail actually performed the write. `customer_self_service_delegate`
 * means the subscriber's own wrapper chain answered, so every no-op truth,
 * cadence split and dunning fence applied unchanged;
 * `operator_reschedule_band` is the one narrow sub-three-day slide the delegate
 * cannot accept.
 */
export const operatorSubscriptionAppliedBySchema = z.enum(["operator_reschedule_band", "customer_self_service_delegate"]);

/**
 * Every code reachable for the four verbs: some the authority assigns itself, the rest
 * raised by the subscriber delegate and renamed by stripping its
 * `customer_self_service_` prefix. `payment_blocked` also answers an address change
 * against a cycle already paid for. `invalid_address` covers an id naming no row, one
 * belonging to somebody else, and one that is not a shipping address - a single name,
 * because the write path draws no distinction between them. Codes reachable only
 * through actions this surface cannot request are absent by design. Equality with the
 * adapter allowlist is pinned by customerSupportRefusalParity.test.ts, because a
 * comment saying "keep these equal" is precisely what failed to keep them equal.
 */
export const operatorSubscriptionRefusalCodeSchema = z.enum([
  "subscription_not_found", "subject_not_found", "subject_account_unlinked", "version_conflict",
  "slide_target_invalid", "slide_not_available", "slide_out_of_window",
  "payment_blocked", "invalid_transition", "charge_timing_not_confirmed",
  "payment_method_not_chargeable", "invalid_address",
]);

/**
 * `subject_account_linked` is no longer applied - the caller moves the
 * authorization copy itself - but it stays *reachable*: a command refused under
 * the old fence is settled, and replaying its key answers with that code.
 */
export const operatorEmailCorrectionRefusalCodeSchema = z.enum([
  "subject_not_found", "subject_account_linked", "email_expectation_conflict", "email_already_in_use",
]);

export const operatorPhoneCorrectionRefusalCodeSchema = z.enum(["subject_not_found", "phone_expectation_conflict"]);

const operatorSubscriptionResponseBaseSchema = z.object({
  contractVersion: z.literal(SUPPORT_CUSTOMER_360_CONTRACT_VERSION),
  action: z.literal("apply_subscription_action"),
  subscriptionAction: operatorSubscriptionActionKindSchema,
  subscriptionId: idSchema,
});

/**
 * `eventId` and `appliedBy` are always present and explicitly null when the
 * command settled without writing an event, so a caller never has to tell an
 * absent key from an unknown one.
 */
const operatorSubscriptionSettledShape = {
  subscriptionStatus: statusSchema,
  nextCycleAt: nullableDatetimeSchema,
  templateVersion: templateVersionSchema,
  eventId: idSchema.nullable(),
  appliedBy: operatorSubscriptionAppliedBySchema.nullable(),
} as const;

export const operatorSubscriptionActionResponseSchema = z.discriminatedUnion("outcome", [
  operatorSubscriptionResponseBaseSchema.extend({
    outcome: z.literal("applied"), ...operatorSubscriptionSettledShape,
  }).strict(),
  operatorSubscriptionResponseBaseSchema.extend({
    outcome: z.literal("noop"), ...operatorSubscriptionSettledShape,
  }).strict(),
  operatorSubscriptionResponseBaseSchema.extend({
    outcome: z.literal("replayed"), ...operatorSubscriptionSettledShape,
  }).strict(),
  operatorSubscriptionResponseBaseSchema.extend({
    outcome: z.literal("refused"), refusalCode: operatorSubscriptionRefusalCodeSchema,
  }).strict(),
  operatorSubscriptionResponseBaseSchema.extend({
    outcome: z.literal("conflict"), refusalCode: operatorSubscriptionRefusalCodeSchema,
  }).strict(),
]);

const operatorEmailCorrectionResponseBaseSchema = z.object({
  contractVersion: z.literal(SUPPORT_CUSTOMER_360_CONTRACT_VERSION),
  action: z.literal("correct_email"),
  subjectId: idSchema,
});

/**
 * `authUserLinked` says whether an authorization copy existed to move. It is now
 * genuinely a boolean: a linked account is corrected rather than refused, and the
 * caller is responsible for having moved `auth.users.email` first.
 */
/**
 * `holderId` turns the commonest refusal from a dead end into a next step. It is
 * the id of the record already holding the address, and it is set only for
 * `email_already_in_use`, which is the only refusal a holder explains; every
 * other arm reports it as explicitly null rather than omitting it.
 *
 * It is an opaque identifier the console can look up through reads the operator
 * already has, never a stored address - so this does not widen what a response
 * may disclose beyond the value the operator typed themselves.
 */
export const operatorEmailCorrectionResponseSchema = z.discriminatedUnion("outcome", [
  operatorEmailCorrectionResponseBaseSchema.extend({
    outcome: z.literal("applied"), authUserLinked: z.boolean(),
  }).strict(),
  operatorEmailCorrectionResponseBaseSchema.extend({
    outcome: z.literal("noop"), authUserLinked: z.boolean(),
  }).strict(),
  operatorEmailCorrectionResponseBaseSchema.extend({
    outcome: z.literal("replayed"), authUserLinked: z.boolean(),
  }).strict(),
  operatorEmailCorrectionResponseBaseSchema.extend({
    outcome: z.literal("refused"), refusalCode: operatorEmailCorrectionRefusalCodeSchema, holderId: idSchema.nullable(),
  }).strict(),
  operatorEmailCorrectionResponseBaseSchema.extend({
    outcome: z.literal("conflict"), refusalCode: operatorEmailCorrectionRefusalCodeSchema, holderId: idSchema.nullable(),
  }).strict(),
]);

const operatorPhoneCorrectionResponseBaseSchema = z.object({
  contractVersion: z.literal(SUPPORT_CUSTOMER_360_CONTRACT_VERSION),
  action: z.literal("correct_phone"),
  subjectId: idSchema,
}).strict();

/**
 * No `authUserLinked` counterpart and no uniqueness refusal: a number is not an
 * authorization credential, and one household legitimately shares one.
 */
const phoneSettled = (outcome: "applied" | "noop" | "replayed") =>
  operatorPhoneCorrectionResponseBaseSchema.extend({ outcome: z.literal(outcome) }).strict();
const phoneRefused = (outcome: "refused" | "conflict") =>
  operatorPhoneCorrectionResponseBaseSchema.extend({
    outcome: z.literal(outcome), refusalCode: operatorPhoneCorrectionRefusalCodeSchema,
  }).strict();

export const operatorPhoneCorrectionResponseSchema = z.discriminatedUnion("outcome", [
  phoneSettled("applied"), phoneSettled("noop"), phoneSettled("replayed"),
  phoneRefused("refused"), phoneRefused("conflict"),
]);

export type CustomerRecoveryCommandRequest = z.infer<typeof customerRecoveryCommandRequestSchema>;
export type CustomerRecoveryRefusalCode = z.infer<typeof customerRecoveryRefusalCodeSchema>;
export type CustomerRecoveryCommandResponse = z.infer<typeof customerRecoveryCommandResponseSchema>;
export type CustomerSupportCommandRequest = z.infer<typeof customerSupportCommandRequestSchema>;
export type OperatorCommandOutcome = z.infer<typeof operatorCommandOutcomeSchema>;
export type OperatorSubscriptionActionKind = z.infer<typeof operatorSubscriptionActionKindSchema>;
export type OperatorSubscriptionPausePreset = z.infer<typeof operatorSubscriptionPausePresetSchema>;
export type OperatorSubscriptionActionPayload = z.infer<typeof operatorSubscriptionActionPayloadSchema>;
export type OperatorSubscriptionAppliedBy = z.infer<typeof operatorSubscriptionAppliedBySchema>;
export type OperatorSubscriptionRefusalCode = z.infer<typeof operatorSubscriptionRefusalCodeSchema>;
export type OperatorSubscriptionActionRequest = z.infer<typeof operatorSubscriptionActionRequestSchema>;
export type OperatorSubscriptionActionResponse = z.infer<typeof operatorSubscriptionActionResponseSchema>;
export type OperatorEmailCorrectionRefusalCode = z.infer<typeof operatorEmailCorrectionRefusalCodeSchema>;
export type OperatorEmailCorrectionRequest = z.infer<typeof operatorEmailCorrectionRequestSchema>;
export type OperatorEmailCorrectionResponse = z.infer<typeof operatorEmailCorrectionResponseSchema>;
export type OperatorPhoneCorrectionRefusalCode = z.infer<typeof operatorPhoneCorrectionRefusalCodeSchema>;
export type OperatorPhoneCorrectionRequest = z.infer<typeof operatorPhoneCorrectionRequestSchema>;
export type OperatorPhoneCorrectionResponse = z.infer<typeof operatorPhoneCorrectionResponseSchema>;
