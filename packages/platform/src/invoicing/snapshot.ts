import type { InvoiceBuyer } from "./contracts/facts.js";
import { mapCanonicalIssueLines } from "./accountingCanonicalProviderLines.js";
import { allocateChargedGrossTotals } from "./accountingLineAllocation.js";

type IssueLines = ReturnType<typeof mapCanonicalIssueLines>;
interface Options {
  defaultLineLabel: string;
  deliveryLabel: string;
  defaultTaxRate: string;
}
/** Compatibility projection of a claimed host snapshot, not a second store contract.
 * Seller/date/kind/payment selection remains with the host; no environment is read.
 */
export function mapInvoiceClaimToProviderSnapshot<Seller, Kind, Payment>(input: {
  orderRef: string;
  issueDate: string;
  sellDate: string;
  currency: string;
  seller: Seller;
  buyerSnapshot: Record<string, unknown>;
  documentKind: Kind;
  governmentClearanceRequired: boolean;
  payment: Payment;
  linesSnapshot: unknown[];
  totalGrossMinor: number;
  totalNetMinor: number;
  orderMoney: unknown;
}, options: Options & { defaultBuyerLabel: string }) {
  return {
    orderRef: input.orderRef,
    issueDate: input.issueDate,
    sellDate: input.sellDate,
    currency: input.currency,
    seller: input.seller,
    buyer: {
      name: textValue(input.buyerSnapshot.name) ?? options.defaultBuyerLabel,
      email: textValue(input.buyerSnapshot.email),
      taxId: textValue(input.buyerSnapshot.taxId),
      companyName: textValue(input.buyerSnapshot.companyName),
      address: mapBuyerAddress(input.buyerSnapshot.address),
    },
    documentKind: input.documentKind,
    governmentClearanceRequired: input.governmentClearanceRequired,
    payment: input.payment,
    lines: mapIssueLinesToChargedTotal(input.linesSnapshot, input.totalGrossMinor, input.totalNetMinor, input.orderMoney, options),
    chargedTotalGrossMinor: input.totalGrossMinor,
  };
}

// Canonical issue snapshots already carry effective item and explicit delivery
// positions and are verified as a zero-delta passthrough. Historical snapshots
// without positionKind retain the independent #1693 reconciliation below.
function mapIssueLinesToChargedTotal(
  linesSnapshot: unknown[],
  chargedTotalGrossMinor: number,
  chargedTotalNetMinor: number,
  orderMoney: unknown,
  options: Options,
): IssueLines {
  const canonicalKinds = linesSnapshot.map((line) => textValue(isRecord(line) ? line.positionKind : null));
  if (canonicalKinds.some(Boolean)) {
    if (!canonicalKinds.every((kind) => kind === "item" || kind === "delivery")) {
      throw new Error("accounting_invoice_canonical_positions_mixed_or_invalid");
    }
    return mapCanonicalIssueLines(
      linesSnapshot,
      chargedTotalGrossMinor,
      chargedTotalNetMinor,
      options.defaultLineLabel,
    );
  }

  const parsed = linesSnapshot.map((line) => parseLineSnapshot(line, options));
  const deliveryGrossMinor = readDeliveryGrossMinor(orderMoney, chargedTotalGrossMinor);
  const chargedTotals = allocateChargedGrossTotals(
    parsed.map((line) => line.totalGrossMinor),
    chargedTotalGrossMinor - deliveryGrossMinor,
  );
  const positions: IssueLines = parsed.map((line, index) => {
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
    positions.push(buildDeliveryPosition(deliveryGrossMinor, parsed, options));
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
  options: Options,
): IssueLines[number] {
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
    name: options.deliveryLabel,
    quantity: 1,
    unitGrossMinor: deliveryGrossMinor,
    unitNetMinor: totalNetMinor,
    totalGrossMinor: deliveryGrossMinor,
    totalNetMinor,
    vatRate,
  };
}

function mapBuyerAddress(value: unknown): NonNullable<InvoiceBuyer["address"]> {
  const address = isRecord(value) ? value : {};
  return {
    line1: textValue(address.line1),
    postalCode: textValue(address.postalCode),
    city: textValue(address.city),
    country: textValue(address.country),
  };
}

function parseLineSnapshot(value: unknown, options: Options): {
  name: string;
  quantity: number;
  totalGrossMinor: number;
  vatRate: string;
} {
  const row = isRecord(value) ? value : {};
  const quantity = numberValue(row.quantity) || 1;
  const vatRate = textValue(row.vatRate) ?? options.defaultTaxRate;
  // Legacy (pre-#1693) lines_snapshot rows carry only the per-unit
  // unitGrossMinor, so the line total is unit price times quantity.
  const unitGrossMinor = numberValue(row.unitGrossMinor);
  const totalGrossMinor = numberValue(row.totalGrossMinor) ??
    (unitGrossMinor === null ? 0 : unitGrossMinor * quantity);
  return {
    name: textValue(row.name) ?? options.defaultLineLabel,
    quantity,
    totalGrossMinor,
    vatRate,
  };
}

function estimateNetMinor(grossMinor: number, vatRate: string): number {
  const rate = Number(vatRate.replace(",", "."));
  return Number.isFinite(rate) ? Math.round(grossMinor / (1 + rate / 100)) : grossMinor;
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
