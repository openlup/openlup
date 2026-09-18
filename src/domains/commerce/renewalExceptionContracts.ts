import { z } from "../../lib/validation/zod.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import {
  dunningRecoveryBaselineSchema,
  type DunningRecoveryBaselineProjection,
} from "./dunningRecoveryContracts.js";

export const renewalExceptionSeveritySchema = z.enum(["p0", "p1", "p2", "p3"]);
export const renewalExceptionOwnerSchema = z.enum([
  "commerce/payment",
  "commerce/fulfillment",
  "commerce/subscription-support",
]);
export const renewalExceptionRowKindSchema = z.enum([
  "prepared_without_provider_ack",
  "paid_renewal_without_fulfillment",
  "due_cycle_without_order",
]);
export const renewalExceptionSummaryKindSchema = z.enum(["due_cycle_without_order"]);
export const renewalExceptionCustomerSafeStatusSchema = z.enum([
  "operator_review_required",
  "paid_fulfillment_pending",
]);
export const renewalExceptionOperatorNextActionSchema = z.enum([
  "inspect_provider_before_retry",
  "inspect_fulfillment_dispatch",
  "inspect_subscription_scheduler",
]);

const nullableLocalIdSchema = z.string().trim().min(1).max(128).nullable();
const isoDateTimeSchema = z.string().datetime({ offset: true });
const nullableLocalStatusSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9_.:-]+$/).nullable();

export const renewalExceptionFulfillmentRecoveryPostureSchema = z.enum([
  "wait_for_outbox",
  "existing_outbox_replay_required",
  "manual_review",
  "not_retryable",
]);

export const renewalExceptionFulfillmentEligibilityReasonSchema = z.enum([
  "cycle_order_missing",
  "payment_provider_ack_missing",
  "paid_cycle_order_without_fulfillment",
  "local_payment_not_succeeded",
  "subscription_cycle_not_paid",
  "order_paid_outbox_missing",
  "order_paid_outbox_pending",
  "order_paid_outbox_failed_retrying",
  "order_paid_outbox_discarded",
  "order_paid_outbox_processed_without_fulfillment",
]);

export const renewalExceptionSnapshotSummarySchema = z.object({
  status: nullableLocalStatusSchema,
  scheduledAt: isoDateTimeSchema.nullable(),
  nextCycleAt: isoDateTimeSchema.nullable(),
  templateVersion: z.number().int().nonnegative().nullable(),
  lineCount: z.number().int().nonnegative().nullable(),
  totalQuantity: z.number().nonnegative().nullable(),
}).strict();

export const renewalExceptionTriageContextSchema = z.object({
  localPaymentStatus: nullableLocalStatusSchema,
  subscriptionCycleStatus: nullableLocalStatusSchema,
  orderStatus: nullableLocalStatusSchema,
  outboxStatus: nullableLocalStatusSchema,
  outboxAvailableAt: isoDateTimeSchema.nullable(),
  outboxAttempts: z.number().int().nonnegative().nullable(),
  fulfillmentEligibilityReason: renewalExceptionFulfillmentEligibilityReasonSchema,
  fulfillmentRecoveryPosture: renewalExceptionFulfillmentRecoveryPostureSchema,
  lockedCycleSummary: renewalExceptionSnapshotSummarySchema.nullable(),
  futureTemplateSummary: renewalExceptionSnapshotSummarySchema.nullable(),
}).strict();

export const adminCommerceRenewalExceptionsRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * Window for the recovery baseline below. Paging governs the exception rows;
   * this governs the months-spanning cohort read, which is a different question
   * over a different table and must not inherit the row page size.
   */
  windowDays: z.coerce.number().int().min(1).max(365).default(90),
}).strict();


export const adminCommerceRenewalExceptionRowSchema = z.object({
  dedupeKey: z.string().trim().min(1).max(640),
  kind: renewalExceptionRowKindSchema,
  severity: renewalExceptionSeveritySchema,
  owner: renewalExceptionOwnerSchema,
  customerSafeStatus: renewalExceptionCustomerSafeStatusSchema,
  operatorNextAction: renewalExceptionOperatorNextActionSchema,
  reason: z.string().trim().min(1).max(160),
  subscriptionId: nullableLocalIdSchema,
  subscriptionCycleId: nullableLocalIdSchema,
  orderId: nullableLocalIdSchema,
  paymentIntentId: nullableLocalIdSchema,
  paymentAttemptId: nullableLocalIdSchema,
  provider: z.string().trim().min(1).max(32).nullable(),
  ageSeconds: z.number().int().nonnegative(),
  observedAt: isoDateTimeSchema,
  orderDetailPath: z.string().trim().min(1).max(240).nullable(),
  triageContext: renewalExceptionTriageContextSchema,
}).strict();

export const adminCommerceRenewalExceptionSummarySignalSchema = z.object({
  kind: renewalExceptionSummaryKindSchema,
  count: z.number().int().nonnegative(),
  severity: renewalExceptionSeveritySchema,
  owner: renewalExceptionOwnerSchema,
  customerSafeStatus: renewalExceptionCustomerSafeStatusSchema,
  operatorNextAction: renewalExceptionOperatorNextActionSchema,
  reason: z.string().trim().min(1).max(160),
}).strict();

export const adminCommerceRenewalExceptionSummaryCountsSchema = z.object({
  totalRows: z.number().int().nonnegative(),
  preparedWithoutProviderAck: z.number().int().nonnegative(),
  paidRenewalWithoutFulfillment: z.number().int().nonnegative(),
  dueCycleWithoutOrder: z.number().int().nonnegative(),
  paymentRows: z.number().int().nonnegative(),
  fulfillmentRows: z.number().int().nonnegative(),
  p0: z.number().int().nonnegative(),
  p1: z.number().int().nonnegative(),
  p2: z.number().int().nonnegative(),
  p3: z.number().int().nonnegative(),
}).strict();

export const adminCommerceRenewalExceptionsResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  checkedAt: isoDateTimeSchema,
  exceptions: z.array(adminCommerceRenewalExceptionRowSchema),
  summarySignals: z.array(adminCommerceRenewalExceptionSummarySignalSchema),
  summaryCounts: adminCommerceRenewalExceptionSummaryCountsSchema,
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  /**
   * Optional because it is composed separately from the exception rows and is
   * allowed to be missing. Absent means the baseline was not computed for this
   * response -- either the composer did not ask for it, or its read failed and
   * the rows were served anyway. It never means "no cases recovered"; that is a
   * present baseline with a zero cohort.
   */
  dunningRecovery: dunningRecoveryBaselineSchema.optional(),
}).strict();

export type AdminCommerceRenewalExceptionsRequest = z.infer<typeof adminCommerceRenewalExceptionsRequestSchema>;
export type AdminCommerceRenewalExceptionsRequestInput = z.input<typeof adminCommerceRenewalExceptionsRequestSchema>;
export type AdminCommerceRenewalExceptionRow = z.infer<typeof adminCommerceRenewalExceptionRowSchema>;
export type AdminCommerceRenewalExceptionsResponse = z.infer<typeof adminCommerceRenewalExceptionsResponseSchema>;
export type RenewalExceptionTriageContext = z.infer<typeof renewalExceptionTriageContextSchema>;

export type RenewalExceptionPaymentEvidence = {
  kind: "prepared_without_provider_ack";
  provider?: string | null;
  paymentIntentId?: string | null;
  paymentAttemptId?: string | null;
  orderId?: string | null;
  subscriptionId?: string | null;
  subscriptionCycleId?: string | null;
  ageSeconds?: number;
  observedAt: string;
  triageContext?: RenewalExceptionTriageContext | null;
};

export type RenewalExceptionFulfillmentEvidence = {
  kind: "paid_renewal_without_fulfillment";
  subscriptionId: string;
  subscriptionCycleId: string;
  orderId: string;
  ageSeconds: number;
  observedAt: string;
  triageContext?: RenewalExceptionTriageContext | null;
};

export type RenewalExceptionDueCycleEvidence = {
  kind: "due_cycle_without_order";
  subscriptionId: string;
  nextCycleAt: string;
  ageSeconds: number;
  observedAt: string;
  triageContext?: RenewalExceptionTriageContext | null;
};

export type AdminCommerceRenewalExceptionEvidenceSnapshot = {
  checkedAt: string;
  dueCycleWithoutOrderCount: number;
  dueCycleEvidence: RenewalExceptionDueCycleEvidence[];
  paymentEvidence: RenewalExceptionPaymentEvidence[];
  fulfillmentEvidence: RenewalExceptionFulfillmentEvidence[];
  /** Absent when the composer did not collect it, or when collecting it failed. */
  dunningRecovery?: DunningRecoveryBaselineProjection | null;
};
