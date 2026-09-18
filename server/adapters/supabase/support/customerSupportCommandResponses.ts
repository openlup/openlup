/**
 * Translating what the operator command routines return.
 *
 * These are pure: an RPC answered, and this decides whether the answer is one the
 * port may report. Every arm is deliberate. A refusal is admitted only when its
 * code is one this wave knows, so a routine that grows a new refusal cannot have it
 * rendered as an unexplained failure; and a settled outcome is admitted only with
 * the fields the console needs to state what happened.
 *
 * Extracted from the managed adapter when that file reached its line cap. Nothing
 * here talks to a driver, so nothing here needs to live beside one - which is why
 * the subscription translation joined its two siblings here when the absorption
 * command arrived and the adapter was again exactly at that cap.
 */
import type {
  OperatorEmailCorrectionRefusalCode,
  OperatorPhoneCorrectionRefusalCode,
  OperatorSubscriptionAppliedBy,
  OperatorSubscriptionRefusalCode,
} from "../../../../src/domains/support/customerSupportCommandContracts.js";
import {
  CustomerSupportCommandIdempotencyConflictError,
  CustomerSupportCommandInvalidError,
  OperatorSubscriptionAuthorityUnavailableError,
  type OperatorEmailCorrectionResult,
  type OperatorPhoneCorrectionResult,
  type OperatorSubscriptionCommandResult,
} from "../../../domains/support/customerRecoveryCommand.js";
import { CustomerSupportCommandRequiresHumanError,
  CustomerSupportOperatorInactiveError, CustomerSupportOperatorNotProvisionedError } from "../../../runtime/support/customerJourneyBinding.js";

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
    // `authUserLinked` is now a fact the authority observed, not a precondition it
    // enforced: a linked account is corrected, and the route moved the
    // authorization copy of the address before this call. Still required to be a
    // boolean, because an absent key would mean the authority is older than the
    // route calling it and the identity move it assumes never happened.
    const authUserLinked = row.authUserLinked ?? row.auth_user_linked;
    if (typeof authUserLinked === "boolean") {
      return { outcome: outcome as "applied" | "noop" | "replayed", authUserLinked };
    }
  }
  throw new Error("customer_support_email_correction_response_invalid");
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
  if (code === "22023" || /customer_support_(subscription_command|email_correction|phone_correction|absorb_lead)_invalid/.test(message)) return new CustomerSupportCommandInvalidError();
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
