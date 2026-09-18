import type {
  MoneyLedgerValue,
  OrderMoneyMismatchCode,
  ProviderSettlementReadback,
  PaidOrderMoneyRow,
  PaymentAttemptMoneyRow,
  PaymentIntentMoneyRow,
  ProviderSettlementMoneyRow,
} from "../../../src/domains/platform/orderMoneyReconciliationContracts.js";

type SettlementLayer = "local" | "provider";
const SETTLEMENT_OVERDUE_MS = 14 * 24 * 60 * 60 * 1000;
const NOT_APPLICABLE_PROVIDERS = new Set(["hidden_rehearsal", "noop_payment"]);

export function reconcileProviderSettlement(input: {
  rows: ProviderSettlementMoneyRow[];
  order: PaidOrderMoneyRow;
  intent: PaymentIntentMoneyRow | null;
  attempt: PaymentAttemptMoneyRow | null;
  intentAttempts: PaymentAttemptMoneyRow[];
  mismatches: OrderMoneyMismatchCode[];
  now: Date;
}): {
  localSettlement: ProviderSettlementReadback;
  providerSettlement: ProviderSettlementReadback;
} {
  const expectedProviderPaymentId = input.intent?.provider_payment_id ?? input.attempt?.provider_attempt_id ?? null;
  if (!expectedProviderPaymentId) {
    const notApplicable = { state: "not_applicable", reason: "expected_provider_payment_ref_absent" } as const;
    return { localSettlement: notApplicable, providerSettlement: notApplicable };
  }

  const priorFailedAttemptRefs = new Set(input.intentAttempts
    .filter((row) => row.id !== input.attempt?.id && row.status !== "succeeded")
    .flatMap((row) => row.provider_attempt_id ? [row.provider_attempt_id] : []));
  const shared = { ...input, expectedProviderPaymentId, priorFailedAttemptRefs };

  return {
    localSettlement: reconcileSettlementLayer({ ...shared, rows: input.rows, layer: "local" }),
    providerSettlement: reconcileSettlementLayer({
      ...shared,
      rows: input.rows.filter(hasTrustedProviderSettlementProvenance),
      layer: "provider",
    }),
  };
}

export function hasTrustedProviderSettlementProvenance(row: ProviderSettlementMoneyRow): boolean {
  const evidence = row.evidence;
  if (!evidence || typeof evidence !== "object") return false;
  const source = evidence.providerReadbackSource ?? evidence.statusSource ?? evidence.source;
  return source === "provider_api" || source === "provider_webhook" || source === "provider_settlement_readback";
}

function reconcileSettlementLayer(input: {
  rows: ProviderSettlementMoneyRow[];
  layer: SettlementLayer;
  order: PaidOrderMoneyRow;
  attempt: PaymentAttemptMoneyRow | null;
  expectedProviderPaymentId: string;
  priorFailedAttemptRefs: Set<string>;
  mismatches: OrderMoneyMismatchCode[];
  now: Date;
}): ProviderSettlementReadback {
  if (input.rows.some((row) => row.correlation_issue === "conflicting_links")) {
    pushMismatch(input.mismatches, "provider_settlement_correlation");
  }
  if (input.rows.length === 0) {
    return missingReadback(input, "absent");
  }

  const matching = input.rows.filter((row) => row.provider_payment_id === input.expectedProviderPaymentId);
  if (matching.length === 0) {
    const unexpected = input.rows.filter((row) => !input.priorFailedAttemptRefs.has(row.provider_payment_id));
    if (unexpected.length === 0) {
      return missingReadback(input, "prior_failed_attempt_only");
    }
    pushMismatch(input.mismatches, "provider_settlement_payment_ref");
    return { state: "mismatch", ...settlementLedger(newestSettlementRow(unexpected)) };
  }

  const mismatchingRows: ProviderSettlementMoneyRow[] = [];
  for (const row of matching) {
    const rowMismatch = settlementMismatchCodes(input.order, input.attempt, row);
    if (rowMismatch.length > 0) mismatchingRows.push(row);
    for (const code of rowMismatch) pushMismatch(input.mismatches, code);
  }
  if (mismatchingRows.length > 0) {
    return { state: "mismatch", ...settlementLedger(newestSettlementRow(mismatchingRows)) };
  }
  const newest = newestSettlementRow(matching);
  if (newest.status === "bank_pending") {
    return pendingOrOverdue(input.layer, newest.created_at, input.now);
  }
  if (newest.status !== "matched") {
    return { state: "mismatch", ...settlementLedger(newest) };
  }
  return { state: "matched", ...settlementLedger(newest) };
}

function settlementMismatchCodes(
  order: PaidOrderMoneyRow,
  attempt: PaymentAttemptMoneyRow | null,
  row: ProviderSettlementMoneyRow,
): OrderMoneyMismatchCode[] {
  const mismatches: OrderMoneyMismatchCode[] = [];
  if (attempt && normalizeProvider(row.provider_kind) !== normalizeProvider(attempt.provider)) {
    mismatches.push("provider_settlement_provider");
  }
  if (!Number.isSafeInteger(row.gross_cents) || row.gross_cents !== order.total_cents) {
    mismatches.push("provider_settlement_amount");
  }
  if (!row.currency || normalizeCurrency(row.currency) !== normalizeCurrency(order.currency)) {
    mismatches.push("provider_settlement_currency");
  }
  if (row.status !== "matched" && row.status !== "bank_pending") {
    mismatches.push("provider_settlement_status");
  }
  return mismatches;
}

function missingReadback(
  input: { layer: SettlementLayer; attempt: PaymentAttemptMoneyRow | null; order: PaidOrderMoneyRow; now: Date },
  reason: string,
): ProviderSettlementReadback {
  if (input.layer === "local") {
    return { state: "not_applicable", reason: `local_settlement_${reason}` };
  }
  const provider = normalizeProvider(input.attempt?.provider ?? "");
  if (provider === "stripe") {
    return pendingOrOverdue("provider", input.attempt?.updated_at ?? input.order.updated_at, input.now);
  }
  if (NOT_APPLICABLE_PROVIDERS.has(provider)) {
    return { state: "not_applicable", reason: "provider_settlement_not_applicable" };
  }
  return { state: "unsupported", reason: `provider_settlement_import_unsupported:${provider || "unknown"}` };
}

function pendingOrOverdue(layer: SettlementLayer, anchorAt: string, now: Date): ProviderSettlementReadback {
  const prefix = layer === "local" ? "local_settlement" : "trusted_provider_settlement";
  const anchor = new Date(anchorAt).getTime();
  const overdue = Number.isFinite(anchor) && now.getTime() - anchor >= SETTLEMENT_OVERDUE_MS;
  return {
    state: overdue ? "overdue" : "pending",
    reason: `${prefix}_${overdue ? "overdue" : "pending"}`,
  };
}

function pushMismatch(mismatches: OrderMoneyMismatchCode[], code: OrderMoneyMismatchCode): void {
  if (!mismatches.includes(code)) mismatches.push(code);
}

function newestSettlementRow(rows: ProviderSettlementMoneyRow[]): ProviderSettlementMoneyRow {
  return [...rows].sort((left, right) =>
    right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))[0];
}

function settlementLedger(row: ProviderSettlementMoneyRow): MoneyLedgerValue {
  return { id: row.id, amountCents: row.gross_cents, currency: normalizeCurrency(row.currency) };
}

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeProvider(value: string): string {
  return value.trim().toLowerCase();
}
