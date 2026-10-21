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

export function loggableProviderRequestId(value: unknown): value is string {
  return typeof value === "string" && TPAY_REQUEST_ID.test(value);
}

export function loggableProviderErrorCode(value: unknown): value is string {
  return typeof value === "string" && LOGGABLE_PROVIDER_ERROR_CODES.has(value);
}

export function loggableProviderFieldName(value: unknown): value is string {
  return typeof value === "string" && LOGGABLE_PROVIDER_FIELD_NAMES.has(value);
}

