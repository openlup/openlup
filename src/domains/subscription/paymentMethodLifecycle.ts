import type { PaymentFailureHint } from "@openlup/core/payment";
import { storedMethodExpectations } from "../payment/contracts.js";
import type { SubscriptionPaymentMethodStatus } from "./selfServiceContracts.js";

// Single source of truth for every renewal preflight reason. Kept as a runtime
// `as const` tuple (not just a type union) so operator/customer classification
// can be checked for exhaustive coverage in a test — a new reason added here
// that nobody classifies is caught, instead of silently defaulting to customer
// dunning. See recordSubscriptionRenewalPreflightBlock.ts.
//
// The `tpay_`-prefixed members are FROZEN persisted strings, not evidence of a
// live provider branch: the checks that report them read rail capabilities now,
// and the names survive only because dunning cases, alert queries and tests
// already match them. Renaming them is a separate, enumerated wave.
export const SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS = [
  "missing_provider_method_ref",
  "payment_method_revoked",
  "payment_method_requires_action",
  "payment_method_invalid",
  "payment_method_cross_client",
  "payment_method_unhandled_status",
  "tpay_recurring_requires_blik_payid",
  "tpay_recurring_payid_missing",
  "tpay_recurring_requires_model_o",
  "tpay_payer_missing",
  "subscription_provider_not_supported",
  "stripe_provider_not_configured",
  "tpay_provider_not_configured",
] as const;

export type SubscriptionPaymentMethodPreflightReason =
  (typeof SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS)[number];

/**
 * What a persisted preflight reason ASSERTS about the stored method, stated in
 * the kernel's neutral vocabulary.
 *
 * Lives here, beside the frozen list, because this module owns those strings and
 * emits three of the four rows below itself. The classifier deliberately refuses
 * to guess at a reason key that names a scheme it does not own, and it is right
 * to: the meaning is ours, not its. Publishing the hint is how that meaning
 * crosses without the vendor string ever entering the kernel's own table.
 *
 * Matched on the reason's SHAPE — the part that says what went wrong — and not
 * on the rail prefix, which the list above already records as a vestigial
 * persisted string rather than a live provider branch.
 *
 * Scoped to the frozen list, so this module speaks only for the reasons it owns.
 * A shape-alike arriving from somewhere else stays unclassified: the kernel's
 * `indeterminate` is the honest answer for a reason nobody here emits, and
 * reading one would be the same guess the kernel is right to refuse.
 *
 * Type-only import of the hint vocabulary, so a client bundle that only reads a
 * method's status still pulls nothing but these literals.
 *
 * The five operator-only reasons match no shape on purpose: they return before
 * any row is persisted, so a class on them would be a second, invisible register.
 */
const MANDATE_UNFIT: readonly PaymentFailureHint[] = Object.freeze(["mandateUnsupported"]);
const CUSTOMER_DATA: readonly PaymentFailureHint[] = Object.freeze(["dataInvalid"]);
const NO_NEUTRAL_HINTS: readonly PaymentFailureHint[] = Object.freeze([]);

const NEUTRAL_HINTS_BY_REASON_SHAPE: readonly (readonly [string, readonly PaymentFailureHint[]])[] =
  Object.freeze([
    // Consent registered under an autopayment model that cannot back a charge
    // made while the payer is away. The instrument may be in perfect health; the
    // AGREEMENT does not cover charging it unattended.
    Object.freeze(["_requires_model_o", MANDATE_UNFIT] as const),
    // A method IS stored, but of a kind that only ever authorizes one payment
    // with the payer present. The same reading, one step earlier.
    Object.freeze(["_requires_blik_payid", MANDATE_UNFIT] as const),
    // Nothing is stored at all, so there is no mandate to be unfit. That is the
    // branch one `if` above it, `missing_provider_method_ref`, which the kernel
    // already reads as customer-fixable; this reason differs only by naming the
    // ref it looked for, so it must not classify differently.
    Object.freeze(["_recurring_payid_missing", CUSTOMER_DATA] as const),
    // The mandate may be fine; the payer CONTACT the rail needs in order to
    // present the charge is absent. Fixable data, not dead consent.
    Object.freeze(["_payer_missing", CUSTOMER_DATA] as const),
  ]);

/**
 * The neutral hints this module is willing to assert for a persisted preflight
 * reason. Empty for every reason it says nothing about — including the ones the
 * kernel already classifies from the key alone, which must keep classifying
 * exactly as they do.
 *
 * Takes `string` rather than the union because callers hold a reason read back
 * from a row, written by a deployment that may be older than this table.
 */
export function neutralHintsForPreflightReason(reason: string): readonly PaymentFailureHint[] {
  if (!OWNED_PREFLIGHT_REASONS.has(reason)) return NO_NEUTRAL_HINTS;
  for (const [shape, hints] of NEUTRAL_HINTS_BY_REASON_SHAPE) {
    if (reason.endsWith(shape)) return hints;
  }
  return NO_NEUTRAL_HINTS;
}

const OWNED_PREFLIGHT_REASONS: ReadonlySet<string> = new Set<string>(
  SUBSCRIPTION_PAYMENT_METHOD_PREFLIGHT_REASONS,
);

export interface SubscriptionPaymentMethodEvidence {
  clientId?: string | null;
  methodClientId?: string | null;
  providerKind?: string | null;
  providerCustomerRef?: string | null;
  providerMethodRef?: string | null;
  methodKind?: string | null;
  methodStatus?: string | null;
  methodActive?: boolean | null;
  methodExpiresAt?: string | null;
  payerEmail?: string | null;
}

export interface SubscriptionPaymentMethodResolution {
  status: SubscriptionPaymentMethodStatus;
  canAttemptCharge: boolean;
  preflightReason: SubscriptionPaymentMethodPreflightReason | null;
}

export interface ResolveSubscriptionPaymentMethodOptions {
  now?: Date | string;
  expiringWindowDays?: number;
  providerDisabledReason?: SubscriptionPaymentMethodPreflightReason | null;
}

const HANDLED_METHOD_STATUSES = new Set(["active", "revoked", "pending_verification", "expired"]);
const DEFAULT_EXPIRING_WINDOW_DAYS = 14;

export function resolveSubscriptionPaymentMethodStatus(
  evidence: SubscriptionPaymentMethodEvidence,
  options: ResolveSubscriptionPaymentMethodOptions = {},
): SubscriptionPaymentMethodResolution {
  if (options.providerDisabledReason) {
    return blocked("provider_disabled", options.providerDisabledReason);
  }

  const providerKind = normalized(evidence.providerKind);
  const methodKind = normalized(evidence.methodKind);
  const providerMethodRef = normalized(evidence.providerMethodRef);
  const providerCustomerRef = normalized(evidence.providerCustomerRef);
  const methodStatus = normalized(evidence.methodStatus);
  const clientId = normalized(evidence.clientId);
  const methodClientId = normalized(evidence.methodClientId);

  if (clientId && methodClientId && clientId !== methodClientId) {
    return blocked("invalid", "payment_method_cross_client");
  }

  if (methodStatus && !HANDLED_METHOD_STATUSES.has(methodStatus)) {
    return blocked("invalid", "payment_method_unhandled_status");
  }

  if (methodStatus === "revoked") return blocked("revoked", "payment_method_revoked");
  if (methodStatus === "pending_verification") {
    return blocked("requires_action", "payment_method_requires_action");
  }
  if (methodStatus === "expired") return blocked("invalid", "payment_method_invalid");
  if (evidence.methodActive === false) return blocked("missing", "missing_provider_method_ref");

  const expiry = parseDate(evidence.methodExpiresAt);
  if (expiry && expiry.getTime() <= referenceNow(options.now).getTime()) {
    return blocked("invalid", "payment_method_invalid");
  }

  if (!providerKind) {
    return methodKind || providerMethodRef
      ? blocked("invalid", "payment_method_invalid")
      : blocked("missing", "missing_provider_method_ref");
  }
  // Every check below reads what the rail EXPECTS of a stored method, never
  // which provider it is. The reason strings still spell the mandate rail's name
  // because they are persisted on renewal blocks and matched by dunning,
  // alerting and tests; renaming them is a separate, enumerated wave, so they
  // are mapped back here at the boundary and nothing durable changes.
  const expectations = storedMethodExpectations(providerKind);
  if (!expectations) return blocked("provider_disabled", "subscription_provider_not_supported");
  if (!providerMethodRef) {
    // A rail that requires one stored-method kind stores its mandate in that
    // ref, so its absence is the missing-mandate reason rather than the generic one.
    return expectations.requiredMethodKind
      ? blocked("missing", "tpay_recurring_payid_missing")
      : blocked("missing", "missing_provider_method_ref");
  }
  if (expectations.requiresCustomerRef && !providerCustomerRef) {
    return blocked("missing", "missing_provider_method_ref");
  }
  if (expectations.requiredMethodKind && methodKind !== expectations.requiredMethodKind) {
    return blocked("invalid", "tpay_recurring_requires_blik_payid");
  }
  if (expectations.requiresPayerContact && !normalized(evidence.payerEmail)) {
    return blocked("invalid", "tpay_payer_missing");
  }

  if (expiry && isExpiringSoon(expiry, options)) {
    return { status: "expiring", canAttemptCharge: true, preflightReason: null };
  }

  return { status: "usable", canAttemptCharge: true, preflightReason: null };
}

export function canUsePaymentMethodForRenewal(status: SubscriptionPaymentMethodStatus | null | undefined): boolean {
  return status === "usable" || status === "expiring";
}

function blocked(
  status: SubscriptionPaymentMethodStatus,
  preflightReason: SubscriptionPaymentMethodPreflightReason,
): SubscriptionPaymentMethodResolution {
  return { status, canAttemptCharge: false, preflightReason };
}

function normalized(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function referenceNow(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  return value ? new Date(value) : new Date();
}

function isExpiringSoon(expiry: Date, options: ResolveSubscriptionPaymentMethodOptions): boolean {
  const now = referenceNow(options.now).getTime();
  const windowDays = options.expiringWindowDays ?? DEFAULT_EXPIRING_WINDOW_DAYS;
  return expiry.getTime() <= now + windowDays * 24 * 60 * 60 * 1000;
}
