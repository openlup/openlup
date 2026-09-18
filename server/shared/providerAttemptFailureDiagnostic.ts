export type ProviderAttemptFailurePhase = "oauth" | "transaction_dispatch" | "response_decode" | "local_finalize";

export const PROVIDER_ATTEMPT_PREPARE_IDEMPOTENCY_CONFLICT =
  "payment_control_provider_attempt_prepare_idempotency_conflict";

export interface ProviderAttemptFailureDiagnostic {
  httpStatus: number;
  requestId: string | null;
  providerErrorCodes: string[];
  fieldNames: string[];
}

/**
 * `dispatchState` mirrors the provider-side fact, not the wire: `not_dispatched`
 * means the transaction call was never invoked, `refused` means it was invoked
 * and the provider's answer proves it created nothing, `unknown` means a
 * transaction may exist. Only the first two admit a same-submit release.
 */
export type ProviderAttemptDispatchState = "not_dispatched" | "refused" | "unknown";

export interface ProviderAttemptDispatchFailure {
  phase: ProviderAttemptFailurePhase;
  code: string;
  dispatchState: ProviderAttemptDispatchState;
  failureDiagnostic?: ProviderAttemptFailureDiagnostic | null;
}

const MAX_DIAGNOSTIC_ITEMS = 5;
const TPAY_REQUEST_ID = /^[a-f0-9]{20}$/;
const LOGGABLE_PROVIDER_ERROR_CODES = new Set([
  "bank_group_does_not_exist",
  "blik_token_not_present",
  "cannot_create_transaction",
  "channel_passed_with_group",
  "channel_unavailable",
  "channel_unavailable_for_source",
  "configuration_error",
  "country_not_valid",
  "crc_not_unique",
  "field_required",
  "general",
  "incorrect_content_type",
  "internal_server_error",
  "invalid_request_body",
  "is_required",
  "no_payment_data",
  "not_array",
  "not_natural_int",
  "not_string",
  "not_valid",
  "partner_cannot_create_transaction",
  "payment_failed",
  "too_low",
  "transaction_blocked",
  "transaction_lock",
  "ts:channel:amount_outside_range",
  "ts:channel:both_channel_and_group_specified",
  "ts:channel:channel_blocked",
  "ts:channel:channel_disabled",
  "ts:channel:channel_disabled_for_pos",
  "ts:channel:collect_prohibited",
  "ts:channel:group_disabled_for_pos",
  "ts:channel:not_available",
  "ts:channel:not_found",
  "ts:channel:source_prohibited",
  "ts:channel:surcharge_prohibited",
  "ts:country:not_valid",
  "ts:merchant:disabled",
  "ts:merchant:is_partner",
  "ts:merchant:not_found",
  "ts:payer:phone:not_valid",
  "ts:pos:not_found",
  "ts:pos:result_url_not_overridable",
  "ts:request:no_ip",
  "ts:transaction:not_inserted",
  "ts:transaction:payer_data_not_inserted",
  "ts:transaction:payer_info_not_inserted",
  "unexpected_field",
  "unsupported_blik_token",
  "url_override_is_disabled",
  "wrong_alias",
  "wrong_autopayment_alias",
  "wrong_model_data_combination",
]);
const LOGGABLE_PROVIDER_FIELD_NAMES = new Set([
  "amount",
  "currency",
  "description",
  "hiddenDescription",
  "payer.email",
  "payer.name",
  "payer.phone",
  "payer.address",
  "payer.city",
  "payer.country",
  "payer.postalCode",
  // This list carries FIELD NAMES ONLY - `ProviderAttemptFailureDiagnostic` has
  // no field that holds a provider value - so these two entries log the literal
  // strings, never a user agent or an IP address. Their absence is why the
  // 2026-08-28 BLIK outage logged `fieldNames: []` and stayed unattributed for
  // days: `readTpayHttpFailure` filters Tpay's returned `fieldName` through this
  // set, so an unlisted name is silently dropped.
  "payer.ip",
  "payer.userAgent",
  "pay.groupId",
  "pay.channelId",
  "pay.blikPaymentData.blikToken",
  "pay.blikPaymentData.type",
  "pay.blikPaymentData.aliases.value",
  "pay.blikPaymentData.aliases.type",
  "callbacks.notification.url",
  "callbacks.payerUrls.success",
  "callbacks.payerUrls.error",
]);

export function providerAttemptDispatchFailure(error: unknown): ProviderAttemptDispatchFailure | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<ProviderAttemptDispatchFailure>;
  const validPhase = candidate.phase === "oauth" || candidate.phase === "transaction_dispatch"
    || candidate.phase === "response_decode" || candidate.phase === "local_finalize";
  const validCode = typeof candidate.code === "string" && /^[a-z0-9_]{1,80}$/.test(candidate.code);
  const validDispatchState = candidate.dispatchState === "not_dispatched"
    || candidate.dispatchState === "refused"
    || candidate.dispatchState === "unknown";
  if (!validPhase || !validCode || !validDispatchState) return null;
  return {
    phase: candidate.phase as ProviderAttemptFailurePhase,
    code: candidate.code as string,
    dispatchState: candidate.dispatchState as ProviderAttemptDispatchState,
    failureDiagnostic: providerAttemptFailureDiagnostic(candidate.failureDiagnostic),
  };
}

export function providerAttemptFailureLogFields(input: {
  paymentAttemptId: string | null;
  phase: string;
  code: string;
  dispatchState: ProviderAttemptDispatchState;
  retryCount: number;
  failureDiagnostic: unknown;
}): Record<string, unknown> {
  const diagnostic = providerAttemptFailureDiagnostic(input.failureDiagnostic);
  return {
    paymentAttemptId: input.paymentAttemptId,
    phase: input.phase,
    code: input.code,
    dispatchState: input.dispatchState,
    retryCount: input.retryCount,
    ...(diagnostic ?? {}),
  };
}

function providerAttemptFailureDiagnostic(value: unknown): ProviderAttemptFailureDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ProviderAttemptFailureDiagnostic>;
  if (!Number.isInteger(candidate.httpStatus) || candidate.httpStatus! < 100 || candidate.httpStatus! > 599) return null;
  if (candidate.requestId !== null && !loggableProviderRequestId(candidate.requestId)) return null;
  if (!loggableProviderErrorCodes(candidate.providerErrorCodes) || !loggableProviderFieldNames(candidate.fieldNames)) return null;
  return {
    httpStatus: candidate.httpStatus!,
    requestId: candidate.requestId as string | null,
    providerErrorCodes: [...candidate.providerErrorCodes!],
    fieldNames: [...candidate.fieldNames!],
  };
}

export function loggableProviderRequestId(value: unknown): value is string {
  return typeof value === "string" && TPAY_REQUEST_ID.test(value);
}

export function loggableProviderErrorCode(value: unknown): value is string {
  return typeof value === "string" && LOGGABLE_PROVIDER_ERROR_CODES.has(value);
}

export function loggableProviderFieldName(value: unknown): value is string {
  return typeof value === "string" && LOGGABLE_PROVIDER_FIELD_NAMES.has(value);
}

function loggableProviderErrorCodes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_DIAGNOSTIC_ITEMS && value.every(loggableProviderErrorCode);
}

function loggableProviderFieldNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_DIAGNOSTIC_ITEMS && value.every(loggableProviderFieldName);
}
