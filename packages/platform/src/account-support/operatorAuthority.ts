import type {
  EmailCorrectionRefusal as OperatorEmailCorrectionRefusalCode, PhoneCorrectionRefusal as OperatorPhoneCorrectionRefusalCode,
  OperatorSubscriptionRefusal as OperatorSubscriptionRefusalCode, OperatorSubscriptionResult as OperatorSubscriptionCommandResult,
  OperatorEmailCorrectionResult, OperatorPhoneCorrectionResult, OperatorEmailCorrectionAdmission,
  OperatorEmailCorrectionExecution, OperatorEmailCorrectionSettlement, NativeOperatorSubscriptionResult,
  OperatorOwnerReceipt, ManagedOperatorAuthorityPort, OperatorAuthorityCapabilities, OperatorAccountLinkResult,
  OperatorAccountLinkRefusal, OperatorLeadAbsorptionResult, LeadAbsorptionCarried,
  LeadRefusal as OperatorLeadAbsorptionRefusalCode, CustomerRecoveryAuthorityResult, RecoveryRefusal,
} from "./contracts/index.js";
type OperatorSubscriptionAppliedBy = "operator_reschedule_band" | "customer_self_service_delegate";

export class CustomerSupportCommandInvalidError extends Error { constructor() { super("customer_support_operator_command_invalid"); } }
export class CustomerSupportCommandIdempotencyConflictError extends Error { constructor() { super("customer_support_idempotency_conflict"); } }
export class OperatorSubscriptionAuthorityUnavailableError extends Error { constructor() { super("operator_subscription_authority_unavailable"); } }
export class CustomerSupportCommandRequiresHumanError extends Error { constructor() { super("customer_support_command_requires_human"); } }
export class CustomerSupportOperatorInactiveError extends Error { constructor() { super("managed_customer_support_operator_inactive"); } }
export class CustomerSupportOperatorNotProvisionedError extends Error { constructor() { super("operator_identity_not_provisioned"); } }

type Row = Record<string, unknown>;

const SETTLED_OUTCOMES = new Set(["applied", "noop", "replayed"]);
const EMAIL_REFUSALS = new Set<OperatorEmailCorrectionRefusalCode>(["subject_not_found", "subject_account_linked", "email_expectation_conflict", "email_already_in_use"]);
const PHONE_REFUSALS = new Set<OperatorPhoneCorrectionRefusalCode>(["subject_not_found", "phone_expectation_conflict"]);
// Must stay equal to operatorSubscriptionRefusalCodeSchema, whose docstring says why:
// a code missing here becomes an invalid response, i.e. a 503 hiding a stated reason.
// Equality is now pinned by customerSupportRefusalParity.test.ts rather than by these
// two sentences, which is what the last drift proved was necessary.
export const SUBSCRIPTION_REFUSALS = new Set<OperatorSubscriptionRefusalCode>(["subscription_not_found", "subject_not_found", "subject_account_unlinked", "version_conflict", "slide_target_invalid", "slide_not_available", "slide_out_of_window", "payment_blocked", "invalid_transition", "charge_timing_not_confirmed", "payment_method_not_chargeable", "invalid_address"]);
const APPLIED_BY = new Set<OperatorSubscriptionAppliedBy>(["operator_reschedule_band", "customer_self_service_delegate"]);

function object(value: unknown, failure: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(failure);
  return value as Row;
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function emailCorrection(value: unknown): OperatorEmailCorrectionResult {
  const row = object(value, "customer_support_email_correction_response_invalid");
  const outcome = text(row.outcome);
  const refusalCode = text(row.refusalCode ?? row.refusal_code) as OperatorEmailCorrectionRefusalCode;
  if ((outcome === "refused" || outcome === "conflict") && EMAIL_REFUSALS.has(refusalCode)) {
    return { outcome, refusalCode };
  }
  if (SETTLED_OUTCOMES.has(outcome ?? "")) {
    // The completed receipt reports the linkage observed at admission.
    const authUserLinked = row.authUserLinked ?? row.auth_user_linked;
    if (typeof authUserLinked === "boolean") {
      return { outcome: outcome as "applied" | "noop" | "replayed", authUserLinked };
    }
  }
  throw new Error("customer_support_email_correction_response_invalid");
}

/** Admission authorizes a command; only a service claim authorizes its execution. */
export function emailCorrectionAdmission(value: unknown): OperatorEmailCorrectionAdmission {
  const row = object(value, "customer_support_email_correction_response_invalid");
  if (row.outcome === "failed") throw new Error("customer_support_email_correction_failed");
  if ((row.outcome === "admitted" || row.outcome === "pending")
    && (row.authUserId === null || typeof row.authUserId === "string")
    && typeof row.originalEmail === "string" && typeof row.newEmail === "string") {
    return { outcome: "admitted", authUserId: typeof row.authUserId === "string" ? row.authUserId : null, originalEmail: row.originalEmail, newEmail: row.newEmail };
  }
  return emailCorrection(value);
}
export function emailCorrectionExecution(value: unknown): OperatorEmailCorrectionExecution {
  const row = object(value, "customer_support_email_correction_response_invalid");
  if (row.outcome === "claimed" && typeof row.idempotencyKey === "string"
    && typeof row.claimToken === "string" && typeof row.sequence === "string") {
    const admission = emailCorrectionAdmission({ ...row, outcome: "pending" });
    if (admission.outcome === "admitted") return { ...admission, outcome: "claimed",
      idempotencyKey: row.idempotencyKey, claimToken: row.claimToken, sequence: row.sequence };
  }
  return emailCorrectionSettlement(value);
}
export function emailCorrectionSettlement(value: unknown): OperatorEmailCorrectionSettlement {
  const row = object(value, "customer_support_email_correction_response_invalid");
  if (row.outcome === "pending" || row.outcome === "failed") return { outcome: row.outcome };
  return emailCorrection(value);
}

export function phoneCorrection(value: unknown): OperatorPhoneCorrectionResult {
  const row = object(value, "customer_support_phone_correction_response_invalid");
  const outcome = text(row.outcome);
  const refusalCode = text(row.refusalCode ?? row.refusal_code) as OperatorPhoneCorrectionRefusalCode;
  if ((outcome === "refused" || outcome === "conflict") && PHONE_REFUSALS.has(refusalCode)) {
    return { outcome, refusalCode };
  }
  if (SETTLED_OUTCOMES.has(outcome ?? "")) return { outcome: outcome as "applied" | "noop" | "replayed" };
  throw new Error("customer_support_phone_correction_response_invalid");
}

/**
 * A `timestamptz` reaches us as PostgreSQL renders it (`+00:00`), so it is
 * re-rendered as an ISO instant before it can reach a contract that pins the
 * offset form. An unparseable value becomes null rather than a 500.
 */
function instant(value: unknown): string | null {
  const raw = text(value).trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function subscriptionCommand(value: unknown): OperatorSubscriptionCommandResult {
  const row = object(value, "customer_support_subscription_command_response_invalid");
  const outcome = text(row.outcome);
  const refusalCode = text(row.refusalCode ?? row.refusal_code).trim() as OperatorSubscriptionRefusalCode;
  if ((outcome === "refused" || outcome === "conflict") && SUBSCRIPTION_REFUSALS.has(refusalCode)) {
    return { outcome, refusalCode };
  }
  const templateVersion = row.templateVersion ?? row.template_version;
  if (SETTLED_OUTCOMES.has(outcome) && typeof templateVersion === "number" && Number.isInteger(templateVersion)) {
    const appliedBy = text(row.appliedBy ?? row.applied_by).trim() as OperatorSubscriptionAppliedBy;
    return {
      outcome: outcome as "applied" | "noop" | "replayed",
      subscriptionStatus: text(row.subscriptionStatus ?? row.subscription_status).trim() || "unknown",
      nextCycleAt: instant(row.nextCycleAt ?? row.next_cycle_at),
      templateVersion,
      eventId: text(row.eventId ?? row.event_id).trim() || null,
      appliedBy: APPLIED_BY.has(appliedBy) ? appliedBy : null,
    };
  }
  throw new Error("customer_support_subscription_command_response_invalid");
}

/**
 * Translate the routine's raised SQLSTATEs into failures the route can price as
 * HTTP without reading a driver error. Anything unrecognized stays an opaque
 * upstream failure rather than being guessed into a client fault.
 */
export function operatorCommandFailure(error: unknown, fallback: string): Error {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  // The machine fence raises the same SQLSTATE the inactive-operator gate uses, so
  // its message must be read first: a refused machine actor told "operator inactive"
  // would send a human chasing provisioning that is not the problem.
  if (message.includes("customer_support_command_requires_human")) return new CustomerSupportCommandRequiresHumanError();
  if (code === "42501" || message.includes("communications_operator_inactive")) return new CustomerSupportOperatorInactiveError();
  if (code === "22023" || /customer_support_(subscription_command|email_correction|phone_correction|absorb_lead|account_link)_invalid/.test(message)) return new CustomerSupportCommandInvalidError();
  if (code === "23505" || message.includes("customer_support_idempotency_conflict")) return new CustomerSupportCommandIdempotencyConflictError();
  // The ledger `operator_id` foreign key. Reachable because the eligibility gate is a
  // union of the admin roster and `platform_communication_operators`, so a principal
  // it admits on the roster arm alone has no row for the receipt to reference. The
  // scope refuses this before anything mutates when the caller declares a command
  // intent; this arm is the backstop for one that does not, so the failure is still
  // named rather than reaching an operator as an anonymous outage.
  if (code === "23503" || /platform_communication_operators/.test(message)) return new CustomerSupportOperatorNotProvisionedError();
  // The routine exists in the database but the API layer cannot see it: that layer
  // answers PGRST202 from a schema cache it has not reloaded since the migration,
  // and direct SQL answers 42883. Neither is a fault in the command, so neither may
  // arrive as an anonymous failure - that is exactly the shape that cost an hour of
  // production diagnosis, because it looked identical to the whole journey being
  // down. `AuthorityUnavailable` is the honest name: the authority is deployed but
  // unreachable, which is what an operator and a log both need to be told.
  if (code === "PGRST202" || code === "42883" || /Could not find the function/i.test(message)) {
    return new OperatorSubscriptionAuthorityUnavailableError();
  }
  return new Error(`${fallback}: ${code || "unknown"}`);
}

const LEAD_REFUSALS = new Set<OperatorLeadAbsorptionRefusalCode>([
  "lead_not_found", "customer_not_found", "lead_email_expectation_conflict",
  "lead_has_identity", "lead_has_commercial_footprint", "unclassified_referencing_table",
]);
const SETTLED = new Set(["applied", "noop", "replayed"]);
const CARRIED_KINDS = ["personalization", "consents", "sourceLinks", "deliveries"] as const;


const INVALID = "customer_support_lead_absorption_response_invalid";

function leadText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Bounded, de-duplicated and order-preserving. The list is rendered verbatim to an
 * operator so they can hand it to whoever classifies the table, so a blank or a
 * repeat in it is noise in the one place the refusal has to be actionable.
 */
function blockingTables(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(leadText).filter(Boolean))].slice(0, 200);
}

/**
 * What was carried, or null when the authority did not report it as four
 * non-negative integers. Null is a refusal to guess: reporting "carried nothing"
 * for an answer that simply did not say would tell an operator the campaign
 * attribution was lost when it may well have moved.
 */
function carried(value: unknown): LeadAbsorptionCarried | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Row;
  const counts = CARRIED_KINDS.map((kind) => count(row[kind] ?? row[snake(kind)]));
  if (counts.some((entry) => entry === null)) return null;
  const [personalization, consents, sourceLinks, deliveries] = counts as number[];
  return { personalization: personalization!, consents: consents!, sourceLinks: sourceLinks!, deliveries: deliveries! };
}

function snake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Translate the routine's JSON into the one result shape both lanes report. */
export function leadAbsorption(value: unknown): OperatorLeadAbsorptionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
  const row = value as Row;
  const outcome = leadText(row.outcome);
  const leadId = leadText(row.leadId ?? row.lead_id);
  if (!leadId) throw new Error(INVALID);

  if (outcome === "refused" || outcome === "conflict") {
    const refusalCode = leadText(row.refusalCode ?? row.refusal_code) as OperatorLeadAbsorptionRefusalCode;
    if (!LEAD_REFUSALS.has(refusalCode)) throw new Error(INVALID);
    return { outcome, leadId, refusalCode, blockingTables: blockingTables(row.blockingTables ?? row.blocking_tables) };
  }

  const moved = carried(row.carried);
  const customerId = leadText(row.customerId ?? row.customer_id);
  if (!SETTLED.has(outcome) || !customerId || !moved) throw new Error(INVALID);
  return { outcome: outcome as "applied" | "noop" | "replayed", leadId, customerId, carried: moved };
}


/** Translate the routine's JSON into the one result shape the route reports. */
export function accountLink(value: unknown): OperatorAccountLinkResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("customer_support_account_link_response_invalid");
  const row = value as Record<string, unknown>;
  const outcome = typeof row.outcome === "string" ? row.outcome : "";
  if (outcome === "refused" || outcome === "conflict") {
    const code = row.refusalCode ?? row.refusal_code;
    if (typeof code === "string" && LINK_REFUSALS.has(code as OperatorAccountLinkRefusal)) {
      return { outcome, refusalCode: code as OperatorAccountLinkRefusal };
    }
    throw new Error("customer_support_account_link_response_invalid");
  }
  if (SETTLED_OUTCOMES.has(outcome)) return { outcome: outcome as "applied" | "noop" | "replayed" };
  throw new Error("customer_support_account_link_response_invalid");
}


const LINK_REFUSALS = new Set<OperatorAccountLinkRefusal>(["subject_not_found", "subject_not_customer", "subject_email_missing",
  "email_expectation_conflict", "subject_account_linked", "identity_not_linkable", "identity_linked_elsewhere"]);
const RECOVERY_REFUSALS = new Set<RecoveryRefusal>(["subject_not_found", "case_not_found", "lifecycle_not_eligible",
  "dunning_authority_unavailable", "case_not_open", "recoverable_order_unavailable"]);
export function recoveryResult(value: unknown): CustomerRecoveryAuthorityResult {
  const row = object(value, "customer_support_recovery_response_invalid");
  const outcome = text(row.outcome);
  if (outcome === "issued" || outcome === "replayed") {
    const deliveryStatus = text(row.deliveryStatus ?? row.delivery_status);
    const auditEventId = text(row.auditEventId ?? row.audit_event_id);
    if (deliveryStatus && auditEventId) return { outcome, deliveryStatus, auditEventId };
  }
  const refusalCode = text(row.refusalCode ?? row.refusal_code) as RecoveryRefusal;
  if (outcome === "refused" && RECOVERY_REFUSALS.has(refusalCode)) return { outcome, refusalCode };
  if (outcome === "conflict") return { outcome, conflictCode: "idempotency_conflict" };
  throw new Error("customer_support_recovery_response_invalid");
}

/** Native-only additions never enter the managed subscription decoder. */
export function nativeSubscriptionCommand(value: unknown): NativeOperatorSubscriptionResult {
  const row = object(value, "customer_support_subscription_command_response_invalid");
  let ownerReceipt: OperatorOwnerReceipt | undefined;
  if (row.ownerReceipt !== undefined) {
    const receipt = object(row.ownerReceipt, "customer_support_owner_receipt_invalid");
    if (![receipt.id, receipt.actorId, receipt.idempotencyKey, receipt.commandFingerprint].every(v => typeof v === "string" && v.length > 0)) {
      throw new Error("customer_support_owner_receipt_invalid");
    }
    ownerReceipt = { id: receipt.id as string, actorId: receipt.actorId as string,
      idempotencyKey: receipt.idempotencyKey as string, commandFingerprint: receipt.commandFingerprint as string,
      result: object(receipt.result, "customer_support_owner_receipt_invalid") };
  }
  const result = row.outcome === "refused" && row.refusalCode === "operator_subscription_authority_unavailable"
    ? { outcome: "refused", refusalCode: "operator_subscription_authority_unavailable" } as const
    : subscriptionCommand(row);
  return ownerReceipt ? { ...result, ownerReceipt } : result;
}

export function operatorAuthorityCapabilities(graph: "managed" | "native"): OperatorAuthorityCapabilities {
  const available = { supported: true } as const;
  const conditional = graph === "managed" ? available : { supported: false, refusalCode: "operator_subscription_authority_unavailable" } as const;
  return { graph, email: conditional, phone: conditional, link: conditional, address: conditional,
    shortBand: conditional, unpaidResume: conditional, preparedAttemptPause: conditional,
    pause: available, resume: available, slide: available };
}

export interface OperatorRpcExecutor {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
/** Injected recovery material is private to the adapter; paths belong to the host. */
export interface OperatorRecoveryMaterial {
  tokenHash: string; payloadFingerprint: string; expiresAt: string; recoveryPath: string;
}
export interface OperatorAuthorityOptions {
  operatorId: string; now: () => number;
  recoveryPath: (rawToken: string) => string;
  /** Defaults to 32 random bytes from Web Crypto, encoded as base64url. */
  createOpaqueToken?: () => string;
}
export async function operatorRecoveryMaterial(input: { subjectId: string; caseId: string }, options: OperatorAuthorityOptions): Promise<OperatorRecoveryMaterial> {
  const token = options.createOpaqueToken ? options.createOpaqueToken() : btoa(String.fromCharCode(...globalThis.crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hash = async (value: string) => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    byte => byte.toString(16).padStart(2, "0")).join("");
  return { tokenHash: await hash(token), payloadFingerprint: await hash(JSON.stringify({ action: "issue_recovery", subjectId: input.subjectId, caseId: input.caseId })),
    expiresAt: new Date(options.now() + 86_400_000).toISOString(), recoveryPath: options.recoveryPath(token) };
}

/** Current managed calls over an injected executor; no provider, credentials or defaults. */
export function createManagedOperatorAuthority(executor: OperatorRpcExecutor, options: OperatorAuthorityOptions): ManagedOperatorAuthorityPort {
  const operatorId = options.operatorId.trim();
  if (!operatorId) throw new Error("customer_support_operator_required");
  const check = (input: { operatorId: string }) => {
    if (input.operatorId !== operatorId) throw new Error("customer_support_operator_scope_mismatch");
  };
  const call = async (name: string, args: Record<string, unknown>, failure: string) => {
    const { data, error } = await executor.rpc(name, args);
    if (error) throw operatorCommandFailure(error, failure);
    return data;
  };
  const now = () => new Date(options.now()).toISOString();
  return {
    async applySubscriptionAction(input) {
      check(input);
      return subscriptionCommand(await call("customer_support_apply_subscription_action_v1", {
        p_operator_id: operatorId, p_subscription_id: input.subscriptionId, p_action: input.subscriptionAction,
        p_payload: input.payload ?? {}, p_expected_version: input.expectedVersion,
        p_idempotency_key: input.idempotencyKey, p_now: now(),
      }, "customer_support_subscription_command_failed"));
    },
    async correctSubjectEmail(input) {
      check(input);
      return emailCorrectionAdmission(await call("customer_support_admit_subject_email_v1", {
        p_operator_id: operatorId, p_subject_id: input.subjectId, p_expected_email: input.expectedEmail,
        p_new_email: input.newEmail, p_idempotency_key: input.idempotencyKey, p_now: now(),
      }, "customer_support_email_correction_failed"));
    },
    async claimSubjectEmail(input) {
      return emailCorrectionExecution(await call("customer_support_claim_subject_email_v1", {
        p_idempotency_key: input.idempotencyKey,
      }, "customer_support_email_correction_claim_failed"));
    },
    async settleSubjectEmail(input) {
      return emailCorrectionSettlement(await call("customer_support_settle_subject_email_v1", {
        p_idempotency_key: input.idempotencyKey, p_claim_token: input.claimToken, p_phase: input.phase,
      }, "customer_support_email_correction_settlement_failed"));
    },
    async correctSubjectPhone(input) {
      check(input);
      return phoneCorrection(await call("customer_support_correct_subject_phone_v1", {
        p_operator_id: operatorId, p_subject_id: input.subjectId, p_expected_phone: input.expectedPhone,
        p_new_phone: input.newPhone, p_idempotency_key: input.idempotencyKey, p_now: now(),
      }, "customer_support_phone_correction_failed"));
    },
    async linkSubjectAccount(input) {
      check(input);
      return accountLink(await call("customer_support_link_subject_account_v1", {
        p_operator_id: operatorId, p_subject_id: input.subjectId, p_expected_email: input.expectedEmail,
        p_auth_user_id: input.authUserId, p_idempotency_key: input.idempotencyKey, p_now: now(),
      }, "customer_support_account_link_failed"));
    },
    async absorbLead(input) {
      check(input);
      return leadAbsorption(await call("customer_support_absorb_lead_v1", {
        p_operator_id: operatorId, p_customer_id: input.customerId, p_lead_id: input.leadId,
        p_expected_lead_email: input.expectedLeadEmail, p_idempotency_key: input.idempotencyKey, p_now: now(),
      }, "customer_support_lead_absorption_failed"));
    },
    async issueRecovery(input) {
      check(input);
      const material = await operatorRecoveryMaterial(input, options);
      const { data, error } = await executor.rpc("customer_support_issue_recovery", {
        p_operator_id: operatorId, p_subject_id: input.subjectId, p_case_id: input.caseId, p_idempotency_key: input.idempotencyKey,
        p_payload_fingerprint: material.payloadFingerprint, p_token_hash: material.tokenHash,
        p_expires_at: material.expiresAt, p_recovery_path: material.recoveryPath,
      });
      if (error) {
        const e = error as { code?: string; message?: string };
        if (e.message?.includes("customer_support_command_requires_human")) throw new CustomerSupportCommandRequiresHumanError();
        if (e.code === "23505" || e.message?.includes("idempotency_conflict")) return { outcome: "conflict", conflictCode: "idempotency_conflict" };
        throw new Error("customer_support_recovery_failed");
      }
      return recoveryResult(data);
    },
  };
}
