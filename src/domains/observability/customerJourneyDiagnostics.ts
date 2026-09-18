import { z } from "../../lib/validation/zod.js";
import { bffRequestReferenceSchema } from "../../lib/bff/contracts.js";

export const CUSTOMER_DIAGNOSTIC_INGEST_CONTRACT_VERSION = "customer-diagnostic-ingest.v1" as const;
export const CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1 = "customer-diagnostic-history.v1" as const;
export const CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2 = "customer-diagnostic-history.v2" as const;
/** Retained alias for existing v1 callers; mixed event-version reads opt into the explicit v2 constant. */
export const CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION = CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1;
export const customerDiagnosticHistoryContractVersionSchema = z.enum([
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1,
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2,
]);
export type CustomerDiagnosticHistoryContractVersion = z.infer<typeof customerDiagnosticHistoryContractVersionSchema>;
export const CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V1 = "purchase-auth-account.v1" as const;
export const CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V2 = "purchase-auth-account.v2" as const;
export const CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION = CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V2;
export const customerDiagnosticCoverageVersionSchema = z.enum([
  CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V1,
  CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V2,
]);
export type CustomerDiagnosticCoverageVersion = z.infer<typeof customerDiagnosticCoverageVersionSchema>;

export const customerDiagnosticActionSchema = z.enum([
  "entry_boot", "entry_hydration", "route_render", "configurator_enter",
  "checkout_submit", "payment_confirm", "payment_status", "auth_bootstrap",
  "auth_magic_link", "auth_otp", "auth_oauth", "account_mutation",
  "account_refresh", "account_card_setup",
  "configurator_gate", "checkout_recovery_submit", "checkout_recovery_readback",
  "checkout_recovery_hatch", "auth_callback", "account_subscription_mutation",
  "account_profile_mutation", "account_companion_mutation", "account_address_mutation",
  "account_billing_mutation", "account_delivery_mutation", "account_payment_mutation",
  "account_communication_mutation",
]);
export const customerDiagnosticPhaseSchema = z.enum([
  "entered", "attempted", "settled", "refresh_started", "refresh_settled",
]);
export const customerDiagnosticCodeSchema = z.enum([
  "observed", "succeeded", "rejected", "failed", "unknown", "timeout",
  "transport_uncertain", "retryable", "hydration_failed", "render_failed",
  "session_present", "session_absent", "profile_unavailable", "refresh_failed",
  "validation_blocked", "quote_unavailable", "callback_invalid", "callback_expired",
]);
export type CustomerDiagnosticAction = z.infer<typeof customerDiagnosticActionSchema>;
export type CustomerDiagnosticPhase = z.infer<typeof customerDiagnosticPhaseSchema>;
export type CustomerDiagnosticCode = z.infer<typeof customerDiagnosticCodeSchema>;

const credentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const outcomeCodes = new Set<CustomerDiagnosticCode>([
  "succeeded", "rejected", "failed", "unknown", "timeout", "transport_uncertain", "retryable",
  "validation_blocked", "quote_unavailable",
]);
const callbackOutcomeCodes = new Set<CustomerDiagnosticCode>([
  "succeeded", "callback_invalid", "callback_expired", "failed", "unknown", "timeout", "transport_uncertain",
]);
const legacyActions = new Set<CustomerDiagnosticAction>([
  "entry_boot", "entry_hydration", "route_render", "configurator_enter",
  "checkout_submit", "payment_confirm", "payment_status", "auth_bootstrap",
  "auth_magic_link", "auth_otp", "auth_oauth", "account_mutation",
  "account_refresh", "account_card_setup",
]);
const legacyCodes = new Set<CustomerDiagnosticCode>([
  "observed", "succeeded", "rejected", "failed", "unknown", "timeout",
  "transport_uncertain", "retryable", "hydration_failed", "render_failed",
  "session_present", "session_absent", "profile_unavailable", "refresh_failed",
]);
/** Observations describe what the browser saw, never verified business outcomes. */
const customerDiagnosticIngestRequestBaseSchema = z.object({
  contractVersion: z.literal(CUSTOMER_DIAGNOSTIC_INGEST_CONTRACT_VERSION),
  clientEventKey: z.string().uuid(),
  clientActionKey: z.string().uuid().optional(),
  segmentCredential: credentialSchema.optional(),
  action: customerDiagnosticActionSchema,
  phase: customerDiagnosticPhaseSchema,
  code: customerDiagnosticCodeSchema.optional(),
  durationMs: z.number().int().min(0).max(600_000).optional(),
  relatedRequestId: bffRequestReferenceSchema.optional(),
}).strict();

function validateDiagnosticObservation(event: z.infer<typeof customerDiagnosticIngestRequestBaseSchema>, context: z.RefinementCtx): void {
  const { action, phase, code } = event;
  let valid = false;
  if (action === "entry_boot") {
    valid = (phase === "entered" && code === "observed") || (phase === "settled" && code === "failed");
  } else if (action === "configurator_enter") {
    valid = phase === "entered" && code === "observed";
  } else if (action === "entry_hydration") {
    valid = (phase === "entered" && code === "observed") ||
      (phase === "settled" && (code === "succeeded" || code === "hydration_failed"));
  } else if (action === "route_render") {
    valid = phase === "settled" && code === "render_failed";
  } else if (action === "auth_bootstrap") {
    valid = phase === "settled" && ["session_present", "session_absent", "profile_unavailable", "unknown", "timeout", "failed"].includes(code ?? "");
  } else if (action === "account_refresh") {
    valid = Boolean(event.clientActionKey) && (
      (phase === "refresh_started" && code === "observed") ||
      (phase === "refresh_settled" && (code === "succeeded" || code === "refresh_failed"))
    );
  } else if (action === "auth_callback") {
    valid = phase === "settled" && code !== undefined && callbackOutcomeCodes.has(code);
  } else {
    valid = Boolean(event.clientActionKey) && (
      (phase === "attempted" && code === "observed") ||
      (phase === "settled" && code !== undefined && outcomeCodes.has(code))
    );
  }
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid diagnostic observation combination" });
}

export const customerDiagnosticLegacyIngestRequestSchema = customerDiagnosticIngestRequestBaseSchema
  .superRefine((event, context) => {
    if (!legacyActions.has(event.action) || (event.code !== undefined && !legacyCodes.has(event.code))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid legacy diagnostic vocabulary" });
      return;
    }
    validateDiagnosticObservation(event, context);
  });
export const customerDiagnosticV2IngestRequestSchema = customerDiagnosticIngestRequestBaseSchema.extend({
  coverageVersion: z.literal(CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V2),
}).strict().superRefine((event, context) => {
  validateDiagnosticObservation(event, context);
  if (event.action === "entry_hydration" && event.phase === "settled" && event.code === "succeeded") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid v2 hydration observation combination" });
  }
});
export const customerDiagnosticIngestRequestSchema = z.union([
  customerDiagnosticLegacyIngestRequestSchema,
  customerDiagnosticV2IngestRequestSchema,
]);
export type CustomerDiagnosticLegacyIngestRequest = z.infer<typeof customerDiagnosticLegacyIngestRequestSchema>;
export type CustomerDiagnosticV2IngestRequest = z.infer<typeof customerDiagnosticV2IngestRequestSchema>;
export type CustomerDiagnosticIngestRequest = z.infer<typeof customerDiagnosticIngestRequestSchema>;
export type CustomerDiagnosticIngestInput = CustomerDiagnosticIngestRequest;
export type CustomerDiagnosticBrowserEventInput = Omit<CustomerDiagnosticV2IngestRequest,
  "contractVersion" | "coverageVersion" | "clientEventKey" | "segmentCredential">;

export const customerDiagnosticIngestResponseSchema = z.object({
  contractVersion: z.literal(CUSTOMER_DIAGNOSTIC_INGEST_CONTRACT_VERSION),
  persistence: z.literal("committed"),
  segmentCredential: credentialSchema,
  deduplicated: z.boolean(),
}).strict();

const cursorSchema = z.string().min(1).max(200).optional();
const overviewCursorSchema = z.string().regex(/^[0-9]{1,7}$/).optional();
const overviewWindowSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  pageSize: z.coerce.number().int().min(1).max(25).default(10),
  cursor: overviewCursorSchema,
});
export const customerDiagnosticLookupSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("search"),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    subjectId: z.string().uuid().optional(),
    action: customerDiagnosticActionSchema.optional(),
    phase: customerDiagnosticPhaseSchema.optional(),
    code: customerDiagnosticCodeSchema.optional(),
    pageSize: z.coerce.number().int().min(1).max(25).default(10),
    cursor: cursorSchema,
  }).strict(),
  z.object({
    mode: z.literal("history"),
    segmentId: z.string().uuid(),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    cursor: cursorSchema,
  }).strict(),
  overviewWindowSchema.extend({ mode: z.literal("overview") }).strict(),
]).refine((query) => query.mode === "history" || (
  Date.parse(query.to) > Date.parse(query.from) &&
  Date.parse(query.to) - Date.parse(query.from) <= 7 * 86_400_000
), "Diagnostic window must be positive and at most seven days");
