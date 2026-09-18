import type {
  AccountingCorrectionOutboxTarget,
  AccountingDocumentProviderInvoiceSnapshot,
  ClaimedAccountingInvoiceIssue,
} from "../../../src/domains/accounting/ports.js";
import {
  neutralTaxIdRouting,
  readAccountingSellerConfig,
  type TaxIdRoutingPort,
} from "../../../src/domains/accounting/invoiceContracts.js";
import { APP_DEFAULT_SELLER } from "../../../src/lib/brand/appBrand.js";
import { mapCanonicalIssueLines } from "./accountingCanonicalProviderLines.js";
import { allocateChargedGrossTotals } from "./accountingLineAllocation.js";

export type AccountingProviderInvoiceSnapshot = AccountingDocumentProviderInvoiceSnapshot;

export function mapInvoiceClaimToProviderSnapshot(
  claim: ClaimedAccountingInvoiceIssue,
  env: Record<string, string | undefined>,
): AccountingProviderInvoiceSnapshot {
  return {
    orderRef: claim.invoice.orderRef,
    issueDate: dateOnly(claim.invoice.packageShippedAt ?? claim.invoice.paymentCompletedAt),
    sellDate: dateOnly(claim.invoice.paymentCompletedAt),
    currency: claim.invoice.currency,
    seller: readAccountingSellerConfig(env, APP_DEFAULT_SELLER),
    buyer: {
      name: textValue(claim.invoice.buyerSnapshot.name) ?? "Customer",
      email: textValue(claim.invoice.buyerSnapshot.email),
      taxId: textValue(claim.invoice.buyerSnapshot.taxId),
      companyName: textValue(claim.invoice.buyerSnapshot.companyName),
      address: mapBuyerAddress(claim.invoice.buyerSnapshot.address),
    },
    documentKind: claim.invoice.documentKind === "b2b_vat" ? "b2b_vat" : "b2c_named",
    // The claim is an SQL-built JSON document cast without validation, so its
    // key names are a database contract; the neutral snapshot's are not.
    governmentClearanceRequired: claim.invoice.ksefRequired,
    payment: {
      provider: textValue(claim.invoice.metadata.paymentProvider),
      providerPaymentId: claim.invoice.providerPaymentId,
      paymentCompletedAt: claim.invoice.paymentCompletedAt ?? "",
    },
    lines: mapIssueLinesToChargedTotal(
      claim.invoice.linesSnapshot,
      claim.invoice.totalGrossCents,
      claim.invoice.totalNetCents,
      claim.invoice.orderMoney,
    ),
    chargedTotalGrossMinor: claim.invoice.totalGrossCents,
  };
}

const DELIVERY_POSITION_NAME = "Dostawa";

// Canonical issue snapshots already carry effective item and explicit delivery
// positions and are verified as a zero-delta passthrough. Historical snapshots
// without positionKind retain the independent #1693 reconciliation below.
function mapIssueLinesToChargedTotal(
  linesSnapshot: unknown[],
  chargedTotalGrossMinor: number,
  chargedTotalNetMinor: number,
  orderMoney: unknown,
): AccountingProviderInvoiceSnapshot["lines"] {
  const canonicalKinds = linesSnapshot.map((line) => textValue(isRecord(line) ? line.positionKind : null));
  if (canonicalKinds.some(Boolean)) {
    if (!canonicalKinds.every((kind) => kind === "item" || kind === "delivery")) {
      throw new Error("accounting_invoice_canonical_positions_mixed_or_invalid");
    }
    return mapCanonicalIssueLines(
      linesSnapshot,
      chargedTotalGrossMinor,
      chargedTotalNetMinor,
    );
  }

  const parsed = linesSnapshot.map(parseLineSnapshot);
  const deliveryGrossMinor = readDeliveryGrossMinor(orderMoney, chargedTotalGrossMinor);
  const chargedTotals = allocateChargedGrossTotals(
    parsed.map((line) => line.totalGrossMinor),
    chargedTotalGrossMinor - deliveryGrossMinor,
  );
  const positions: AccountingProviderInvoiceSnapshot["lines"] = parsed.map((line, index) => {
    const totalGrossMinor = chargedTotals[index];
    const totalNetMinor = estimateNetMinor(totalGrossMinor, line.vatRate);
    return {
      name: line.name,
      quantity: line.quantity,
      unitGrossMinor: Math.round(totalGrossMinor / line.quantity),
      unitNetMinor: Math.round(totalNetMinor / line.quantity),
      totalGrossMinor,
      totalNetMinor,
      vatRate: line.vatRate,
    };
  });
  if (deliveryGrossMinor > 0) {
    positions.push(buildDeliveryPosition(deliveryGrossMinor, parsed));
  }
  return positions;
}

// Legacy-only compatibility: pre-canonical claims had no explicit delivery
// position, so their effective delivery is the closed header residual. Current
// canonical claims never enter this path and use persisted shipping columns.
// Every inconsistent legacy shape degrades to 0 and then fails closed if the
// catalog lines cannot reconcile to the charged header.
function readDeliveryGrossMinor(orderMoney: unknown, chargedTotalGrossMinor: number): number {
  if (!isRecord(orderMoney)) return 0;
  const subtotal = numberValue(orderMoney.subtotalCents);
  const discount = numberValue(orderMoney.discountCents);
  const total = numberValue(orderMoney.totalCents);
  if (subtotal === null || discount === null || total === null) return 0;
  if (![subtotal, discount, total].every((value) => Number.isInteger(value) && value >= 0)) return 0;
  if (discount > subtotal) return 0;
  if (total !== chargedTotalGrossMinor) return 0;
  const deliveryGrossMinor = chargedTotalGrossMinor - (subtotal - discount);
  return deliveryGrossMinor > 0 ? deliveryGrossMinor : 0;
}

// Delivery is an ancillary supply and follows the goods' VAT rate; with mixed
// item rates (or no item line to source a rate from) the correct rate is
// ambiguous, so the claim fails closed into the outbox last_error.
function buildDeliveryPosition(
  deliveryGrossMinor: number,
  itemLines: Array<{ vatRate: string }>,
): AccountingProviderInvoiceSnapshot["lines"][number] {
  const rates = [...new Set(itemLines.map((line) => line.vatRate.trim()))];
  if (rates.length === 0) {
    throw new Error(`accounting_invoice_delivery_vat_rate_unavailable delivery=${deliveryGrossMinor}`);
  }
  if (rates.length > 1) {
    throw new Error(`accounting_invoice_delivery_vat_rates_mixed rates=${rates.join(",")}`);
  }
  const vatRate = rates[0];
  const totalNetMinor = estimateNetMinor(deliveryGrossMinor, vatRate);
  return {
    name: DELIVERY_POSITION_NAME,
    quantity: 1,
    unitGrossMinor: deliveryGrossMinor,
    unitNetMinor: totalNetMinor,
    totalGrossMinor: deliveryGrossMinor,
    totalNetMinor,
    vatRate,
  };
}

// Pro-rata discount allocation in integer minor units over the item portion
// of the charge (charged total minus any recognized delivery residual).
// Largest-remainder rounding guarantees the allocated totals sum exactly to
// the target. Fails closed on any shape it cannot make exact: a charge above
// the line totals (e.g. shipping the order header cannot account for) must
// never be smeared into item prices, and a discount cannot be spread over
// zero-value lines.
export function mapCorrectionClaimToProviderSnapshot(
  claim: AccountingCorrectionOutboxTarget,
  env: Record<string, string | undefined>,
): AccountingProviderInvoiceSnapshot {
  return {
    orderRef: claim.invoice.orderRef,
    issueDate: dateOnly(new Date().toISOString()),
    sellDate: dateOnly(new Date().toISOString()),
    currency: claim.invoice.currency,
    seller: readAccountingSellerConfig(env, APP_DEFAULT_SELLER),
    buyer: {
      name: textValue(claim.invoice.buyerSnapshot.name) ?? "Customer",
      email: textValue(claim.invoice.buyerSnapshot.email),
      taxId: textValue(claim.invoice.buyerSnapshot.taxId),
      companyName: textValue(claim.invoice.buyerSnapshot.companyName),
      address: mapCorrectionBuyerAddress(claim.invoice.buyerSnapshot.address),
    },
    documentKind: claim.invoice.documentKind === "b2b_vat" ? "b2b_vat" : "b2c_named",
    governmentClearanceRequired: claim.invoice.ksefRequired,
    lines: claim.invoice.linesSnapshot.map(mapCorrectionLineSnapshot),
  };
}

// The correction document mirrors the issued document's buyer; the full
// street (line1 + line2) rides on the single street field Fakturownia
// accepts (verified against the live 2026-07-13 manual correction).
function mapCorrectionBuyerAddress(value: unknown): AccountingProviderInvoiceSnapshot["buyer"]["address"] {
  const address = isRecord(value) ? value : {};
  const street = [textValue(address.line1), textValue(address.line2)].filter(Boolean).join(" ");
  return {
    line1: street ? street : null,
    postalCode: textValue(address.postalCode),
    city: textValue(address.city),
    country: textValue(address.country),
  };
}

/**
 * Refuses a business or clearance-bound document whose buyer tax id the
 * configured routing module will not vouch for.
 *
 * The router is a parameter with a **neutral default that refuses**, not a
 * hard-wired national rule. A jurisdiction module is opted into at the
 * composition root — `accountingJobService` names this deployment's — so a
 * caller that has not chosen one blocks the document instead of sending an
 * unverified tax id to a fiscal provider. The safe direction for a missing
 * routing policy is fewer documents, not less checking.
 */
export function assertProviderInvoiceTaxIdSafe(
  snapshot: AccountingProviderInvoiceSnapshot,
  routeTaxId: TaxIdRoutingPort = neutralTaxIdRouting,
): void {
  const wantsB2bOrGov =
    snapshot.documentKind === "b2b_vat" || snapshot.governmentClearanceRequired === true;
  if (!wantsB2bOrGov) return;
  const routing = routeTaxId(snapshot.buyer.taxId);
  if (
    !routing.ok || routing.documentKind !== "b2b_vat"
    || routing.governmentClearanceRequired !== true
  ) {
    throw new Error("fakturownia_b2b_invoice_invalid_tax_id");
  }
  snapshot.buyer.taxId = routing.normalizedTaxId;
}

export function sanitizeAccountingError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message: message.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]").slice(0, 180),
  };
}

// Correction lines carry the amounts of the document being corrected: the
// provider adapter mirrors them into correction_before and hardcodes the
// zero-out (correction_after = 0), so zeroed lines here would emit a 0→0
// no-op correction. The correction flow is manual by design and stays
// untouched by issue-path reconciliation.
function mapCorrectionLineSnapshot(value: unknown) {
  const { name, quantity, totalGrossMinor, vatRate } = parseLineSnapshot(value);
  const totalNetMinor = estimateNetMinor(totalGrossMinor, vatRate);
  return {
    name,
    quantity,
    unitGrossMinor: Math.round(totalGrossMinor / quantity),
    unitNetMinor: Math.round(totalNetMinor / quantity),
    totalGrossMinor,
    totalNetMinor,
    vatRate,
  };
}

function mapBuyerAddress(value: unknown): AccountingProviderInvoiceSnapshot["buyer"]["address"] {
  const address = isRecord(value) ? value : {};
  return {
    line1: textValue(address.line1),
    postalCode: textValue(address.postalCode),
    city: textValue(address.city),
    country: textValue(address.country),
  };
}

function parseLineSnapshot(value: unknown): {
  name: string;
  quantity: number;
  totalGrossMinor: number;
  vatRate: string;
} {
  const row = isRecord(value) ? value : {};
  const quantity = numberValue(row.quantity) || 1;
  const vatRate = textValue(row.vatRate) ?? "8";
  // Legacy (pre-#1693) lines_snapshot rows carry only the per-unit
  // unitGrossMinor, so the line total is unit price times quantity.
  const unitGrossMinor = numberValue(row.unitGrossMinor);
  const totalGrossMinor = numberValue(row.totalGrossMinor) ??
    (unitGrossMinor === null ? 0 : unitGrossMinor * quantity);
  return {
    name: textValue(row.name) ?? "Product",
    quantity,
    totalGrossMinor,
    vatRate,
  };
}

function estimateNetMinor(grossMinor: number, vatRate: string): number {
  const rate = Number(vatRate.replace(",", "."));
  return Number.isFinite(rate) ? Math.round(grossMinor / (1 + rate / 100)) : grossMinor;
}

function dateOnly(value: string | null): string {
  return value ? value.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
