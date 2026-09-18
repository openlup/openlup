import { resolveAccountingDocumentHistory } from "../../../src/domains/accounting/contracts.js";
import type {
  AccountingInvoiceIssueTrigger,
  AccountingInvoiceMoneyRow,
  FulfillmentMoneyRow,
  OrderItemMoneyRow,
  OrderMoneyInvoiceExpectation,
  OrderMoneyMismatchCode,
  OrderMoneyReconciliationEvidence,
  PaidOrderMoneyRow,
} from "../../../src/domains/platform/orderMoneyReconciliationContracts.js";
import { sumCanonicalInvoicePositions } from "./invoicePositionSnapshot.js";
import {
  compareCanonicalInvoicePositionsToOrder,
} from "./orderMoneyInvoiceComparison.js";

const INVOICE_GRACE_MILLIS = 60 * 60 * 1000;

export function reconcileOrderInvoice(input: {
  order: PaidOrderMoneyRow;
  orderItems: OrderItemMoneyRow[];
  paymentConfirmedAt: string | null;
  invoices: AccountingInvoiceMoneyRow[];
  fulfillment: FulfillmentMoneyRow[];
  issueTrigger: AccountingInvoiceIssueTrigger;
  now: Date;
  mismatches: OrderMoneyMismatchCode[];
}) {
  const fulfillment = summarizeFulfillment(input.fulfillment);
  const expectation = invoiceExpectation({
    issueTrigger: input.issueTrigger,
    paymentAt: input.paymentConfirmedAt,
    handedOverAt: fulfillment.handedOverAt,
    now: input.now,
  });
  const roots = input.invoices.filter((row) => row.correction_of_invoice_id == null);
  if (roots.length > 1 || (roots.length === 0 && expectation.state === "required")) {
    input.mismatches.push("base_invoice_count");
  }

  const history = resolveAccountingDocumentHistory({
    invoices: input.invoices,
    providerArtifactEligible: () => true,
  });
  const resolvedCurrent = history.current
    ? input.invoices.find((row) => row.id === history.current?.invoiceId) ?? null
    : null;
  const current = resolvedCurrent ?? fallbackLocalInvoice(input.invoices, roots);
  const positionTotals = current ? sumCanonicalInvoicePositions(current.lines_snapshot) : null;
  if (current) compareCurrentInvoice(input.order, input.orderItems, current, positionTotals, input.mismatches);

  return {
    current,
    positionTotals,
    fulfillment,
    expectation,
    lineage: {
      rootInvoiceIds: roots.map((row) => row.id).sort(),
      invoiceIds: [...new Set(input.invoices.map((row) => row.id))].sort(),
      documentKeys: history.documents.map((row) => row.documentKey),
      currentInvoiceId: current?.id ?? null,
    } satisfies OrderMoneyReconciliationEvidence["invoiceLineageIds"],
  };
}

function fallbackLocalInvoice(
  invoices: AccountingInvoiceMoneyRow[],
  roots: AccountingInvoiceMoneyRow[],
): AccountingInvoiceMoneyRow | null {
  if (roots.length !== 1) return null;
  const root = roots[0];
  const eligible = invoices.filter((row) =>
    (row.id === root.id || row.correction_of_invoice_id === root.id) &&
    row.status === "issue_requested" &&
    !row.blocked_reason);
  const replacements = eligible.filter((row) => row.correction_of_invoice_id === root.id);
  return [...(replacements.length > 0 ? replacements : eligible)]
    .sort(compareInvoicesNewestFirst)[0] ?? null;
}

function compareInvoicesNewestFirst(a: AccountingInvoiceMoneyRow, b: AccountingInvoiceMoneyRow): number {
  const aTime = Date.parse(a.created_at ?? a.updated_at ?? "");
  const bTime = Date.parse(b.created_at ?? b.updated_at ?? "");
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  if (Number.isFinite(aTime) !== Number.isFinite(bTime)) return Number.isFinite(aTime) ? -1 : 1;
  return b.id.localeCompare(a.id);
}

function compareCurrentInvoice(
  order: PaidOrderMoneyRow,
  orderItems: OrderItemMoneyRow[],
  invoice: AccountingInvoiceMoneyRow,
  positions: ReturnType<typeof sumCanonicalInvoicePositions> | null,
  mismatches: OrderMoneyMismatchCode[],
): void {
  if (!Number.isSafeInteger(invoice.total_gross_cents) || invoice.total_gross_cents !== order.total_cents) {
    mismatches.push("invoice_amount");
  }
  if (!invoice.currency || normalizeCurrency(invoice.currency) !== normalizeCurrency(order.currency)) {
    mismatches.push("invoice_currency");
  }
  if (!Number.isSafeInteger(invoice.total_net_cents) ||
    invoice.total_net_cents !== order.total_cents - order.tax_cents) {
    mismatches.push("invoice_net_amount");
  }
  if (!positions?.valid) {
    mismatches.push("invoice_positions_invalid");
    return;
  }
  if (positions.grossCents !== invoice.total_gross_cents) mismatches.push("invoice_positions_gross");
  if (positions.netCents !== invoice.total_net_cents) mismatches.push("invoice_positions_net");
  compareCanonicalInvoicePositionsToOrder({ order, orderItems, positions, mismatches });
}

function invoiceExpectation(input: {
  issueTrigger: AccountingInvoiceIssueTrigger;
  paymentAt: string | null;
  handedOverAt: string | null;
  now: Date;
}): OrderMoneyInvoiceExpectation {
  const anchorAt = input.issueTrigger === "paid" ? validTimestamp(input.paymentAt) : input.handedOverAt;
  if (!anchorAt) return { issueTrigger: input.issueTrigger, state: "not_due", anchorAt: null, dueAt: null };
  const dueAt = new Date(Date.parse(anchorAt) + INVOICE_GRACE_MILLIS).toISOString();
  return {
    issueTrigger: input.issueTrigger,
    state: input.now.getTime() >= Date.parse(dueAt) ? "required" : "grace_period",
    anchorAt,
    dueAt,
  };
}

function summarizeFulfillment(rows: FulfillmentMoneyRow[]): OrderMoneyReconciliationEvidence["fulfillment"] {
  const handedOverAt = rows
    .map((row) => validTimestamp(row.handed_over_at))
    .filter((value): value is string => value !== null)
    .sort()[0] ?? null;
  return {
    fulfillmentOrderIds: rows.map((row) => row.id).sort(),
    statuses: [...new Set(rows.map((row) => row.status))].sort(),
    handedOverAt,
  };
}

function validTimestamp(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}
