import type {
  PaymentAttemptMoneyRow,
  ProviderEventMoneyRow,
  ProviderReconciliationMoneyRow,
} from "../../../src/domains/platform/orderMoneyReconciliationContracts.js";

const CHARGE_BEARING_INTENT_STATUSES = new Set([
  "succeeded",
  "partially_refunded",
  "refunded",
  "disputed",
]);

export function isChargeBearingIntentStatus(status: string): boolean {
  return CHARGE_BEARING_INTENT_STATUSES.has(status);
}

export function resolvePaymentConfirmedAt(input: {
  events: ProviderEventMoneyRow[];
  reconciliations: ProviderReconciliationMoneyRow[];
  attempt: PaymentAttemptMoneyRow | null;
}): string | null {
  return earliestValidTimestamp(input.events.map((row) => row.created_at))
    ?? earliestValidTimestamp(input.reconciliations.map((row) => row.checked_at))
    ?? validTimestamp(input.attempt?.updated_at)
    ?? validTimestamp(input.attempt?.created_at);
}

export function isTrustedSucceededReconciliation(
  row: ProviderReconciliationMoneyRow,
  attempt: PaymentAttemptMoneyRow,
): boolean {
  const payload = row.payload;
  return row.payment_attempt_id === attempt.id &&
    row.correction_status === "corrected" &&
    payload?.source === "payment-provider-reconciliation.v0" &&
    payload.normalizedStatus === "succeeded" &&
    payload.resultStatus === "succeeded" &&
    payload.applied === true;
}

export function hasComparableMoney(
  row: ProviderEventMoneyRow,
): row is ProviderEventMoneyRow & { amount_cents: number; currency: string } {
  return Number.isSafeInteger(row.amount_cents) &&
    typeof row.currency === "string" && row.currency.trim().length === 3;
}

function earliestValidTimestamp(values: Array<string | undefined>): string | null {
  return values
    .map(validTimestamp)
    .filter((value): value is string => value !== null)
    .sort()[0] ?? null;
}

function validTimestamp(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
