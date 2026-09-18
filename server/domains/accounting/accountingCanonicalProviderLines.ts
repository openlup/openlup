import type { AccountingDocumentProviderInvoiceSnapshot } from "../../../src/domains/accounting/ports.js";
import { allocateDiscountedGrossTotals } from "./accountingLineAllocation.js";

export function mapCanonicalIssueLines(
  linesSnapshot: unknown[],
  chargedTotalGrossMinor: number,
  chargedTotalNetMinor: number,
): AccountingDocumentProviderInvoiceSnapshot["lines"] {
  const lines = linesSnapshot.map((value) => {
    const row = isRecord(value) ? value : {};
    const quantity = requiredPositiveInteger(row.quantity, "quantity");
    const totalGrossMinor = requiredNonnegativeInteger(row.totalGrossMinor, "total_gross");
    const totalNetMinor = requiredNonnegativeInteger(row.totalNetMinor, "total_net");
    const vatRateBps = requiredNonnegativeInteger(row.vatRateBps, "vat_rate_bps");
    if (vatRateBps > 10_000 || netFromGross(totalGrossMinor, vatRateBps) !== totalNetMinor) {
      throw new Error("accounting_invoice_canonical_position_vat_mismatch");
    }
    const vatRate = canonicalVatRate(vatRateBps);
    const suppliedVatRate = textValue(row.vatRate);
    if (suppliedVatRate !== null && normalizeVatRate(suppliedVatRate) !== vatRate) {
      throw new Error("accounting_invoice_canonical_position_vat_label_mismatch");
    }
    return {
      positionKind: textValue(row.positionKind),
      name: textValue(row.name) ?? "Product",
      quantity,
      unitGrossMinor: requiredNonnegativeInteger(row.unitGrossMinor, "unit_gross"),
      unitNetMinor: requiredNonnegativeInteger(row.unitNetMinor, "unit_net"),
      totalGrossMinor,
      totalNetMinor,
      vatRate,
      catalogTotalGrossMinor: numberValue(row.catalogTotalGrossMinor),
      discountAllocatedMinor: numberValue(row.discountAllocatedMinor),
      shippingGrossMinor: numberValue(row.shippingGrossMinor),
      shippingDiscountMinor: numberValue(row.shippingDiscountMinor),
    };
  });
  const items = lines.filter((line) => line.positionKind === "item");
  const delivery = lines.filter((line) => line.positionKind === "delivery");
  if (items.length === 0 || delivery.length > 1) {
    throw new Error("accounting_invoice_canonical_position_cardinality_invalid");
  }

  const actualDelivery = delivery[0]?.totalGrossMinor ?? 0;
  if (delivery.length === 1) {
    const shippingGross = delivery[0]!.shippingGrossMinor;
    const shippingDiscount = delivery[0]!.shippingDiscountMinor;
    if (!Number.isSafeInteger(shippingGross) || !Number.isSafeInteger(shippingDiscount)
      || shippingGross! < 0 || shippingDiscount! < 0 || shippingDiscount! > shippingGross!
      || shippingGross! - shippingDiscount! !== actualDelivery) {
      throw new Error("accounting_invoice_canonical_delivery_mismatch");
    }
  }

  const catalogTotals = items.map((line) => {
    if (!Number.isInteger(line.catalogTotalGrossMinor) || (line.catalogTotalGrossMinor ?? -1) < 0) {
      throw new Error("accounting_invoice_canonical_catalog_total_invalid");
    }
    if (!Number.isInteger(line.discountAllocatedMinor) || (line.discountAllocatedMinor ?? -1) < 0) {
      throw new Error("accounting_invoice_canonical_discount_allocation_invalid");
    }
    if (line.totalGrossMinor + line.discountAllocatedMinor! !== line.catalogTotalGrossMinor) {
      throw new Error("accounting_invoice_canonical_line_allocation_mismatch");
    }
    return line.catalogTotalGrossMinor!;
  });
  const independentlyAllocated = allocateDiscountedGrossTotals(
    catalogTotals,
    chargedTotalGrossMinor - actualDelivery,
  );
  if (items.some((line, index) => line.totalGrossMinor !== independentlyAllocated[index])) {
    throw new Error("accounting_invoice_canonical_allocator_delta_nonzero");
  }

  const grossSum = lines.reduce((sum, line) => sum + line.totalGrossMinor, 0);
  const netSum = lines.reduce((sum, line) => sum + line.totalNetMinor, 0);
  if (grossSum !== chargedTotalGrossMinor || netSum !== chargedTotalNetMinor) {
    throw new Error(
      `accounting_invoice_canonical_positions_header_mismatch gross=${grossSum}/${chargedTotalGrossMinor} net=${netSum}/${chargedTotalNetMinor}`,
    );
  }

  return lines.map(({
    positionKind: _kind,
    catalogTotalGrossMinor: _catalog,
    discountAllocatedMinor: _discount,
    shippingGrossMinor: _shippingGross,
    shippingDiscountMinor: _shippingDiscount,
    ...line
  }) => line);
}

function requiredNonnegativeInteger(value: unknown, field: string): number {
  const number = numberValue(value);
  if (number === null || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`accounting_invoice_canonical_${field}_invalid`);
  }
  return number;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const number = requiredNonnegativeInteger(value, field);
  if (number === 0) throw new Error(`accounting_invoice_canonical_${field}_invalid`);
  return number;
}

function netFromGross(gross: number, vatRateBps: number): number {
  return Math.round(gross * 10_000 / (10_000 + vatRateBps));
}

function canonicalVatRate(vatRateBps: number): string {
  return normalizeVatRate(String(vatRateBps / 100));
}

function normalizeVatRate(value: string): string {
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("accounting_invoice_canonical_position_vat_label_invalid");
  }
  return String(parsed);
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
