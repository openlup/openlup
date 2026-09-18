export const ORDER_HEADER_MONEY_COLUMNS = [
  "currency",
  "subtotal_cents",
  "discount_cents",
  "shipping_cents",
  "shipping_discount_cents",
  "tax_cents",
  "total_cents",
].join(", ");

export const ORDER_ITEM_MONEY_COLUMNS = [
  "unit_price_cents",
  "total_cents",
  "discount_allocated_cents",
  "effective_total_cents",
  "effective_net_cents",
  "vat_rate_bps",
].join(", ");

export type OrderMoneyIssueCode =
  | "allocated_discount_mismatch"
  | "catalog_subtotal_mismatch"
  | "effective_subtotal_mismatch"
  | "header_equation_mismatch"
  | "item_catalog_equation_mismatch"
  | "item_catalog_money_out_of_range"
  | "item_discount_out_of_range"
  | "item_effective_money_out_of_range"
  | "item_gross_equation_mismatch"
  | "item_net_vat_mismatch"
  | "item_quantity_out_of_range"
  | "item_vat_rate_out_of_range"
  | "missing_item_canonical_money"
  | "mixed_vat_rates"
  | "product_discount_out_of_range"
  | "shipping_discount_out_of_range"
  | "tax_total_mismatch"
  | "total_positions_mismatch";

export interface OrderMoneyHeaderRow {
  id?: string;
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  shipping_discount_cents: number;
  tax_cents: number;
  total_cents: number;
}

export interface OrderMoneyItemRow {
  id?: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  discount_allocated_cents: number | null | undefined;
  effective_total_cents: number | null | undefined;
  effective_net_cents: number | null | undefined;
  vat_rate_bps: number;
}

export interface CanonicalOrderMoneyLine {
  id: string | null;
  quantity: number;
  catalogUnit: number;
  catalogTotal: number;
  discountAllocated: number;
  effectiveGross: number;
  effectiveNet: number;
  vatRateBps: number;
}

export interface CanonicalOrderMoney {
  orderId: string | null;
  currency: string;
  subtotal: number;
  productDiscount: number;
  shippingGross: number;
  shippingDiscount: number;
  shippingEffective: number;
  tax: number;
  total: number;
  lines: CanonicalOrderMoneyLine[];
  validationScope: "full" | "header";
  reconciled: boolean;
  issueCodes: OrderMoneyIssueCode[];
}

export interface OrderMoneyDiagnostic {
  event: "commerce_order_money_unreconciled";
  orderId: string | null;
  validationScope: CanonicalOrderMoney["validationScope"];
  issueCodes: OrderMoneyIssueCode[];
}

export function deriveOrderMoney(
  order: OrderMoneyHeaderRow,
  items?: readonly OrderMoneyItemRow[],
  onDiagnostic: (diagnostic: OrderMoneyDiagnostic) => void = emitOrderMoneyDiagnostic,
): CanonicalOrderMoney {
  const issueCodes = new Set<OrderMoneyIssueCode>();
  const shippingEffective = order.shipping_cents - order.shipping_discount_cents;

  if (
    order.shipping_discount_cents < 0
    || order.shipping_discount_cents > order.shipping_cents
  ) {
    issueCodes.add("shipping_discount_out_of_range");
  }
  if (order.discount_cents < 0 || order.discount_cents > order.subtotal_cents) {
    issueCodes.add("product_discount_out_of_range");
  }
  if (
    order.subtotal_cents - order.discount_cents + shippingEffective
    !== order.total_cents
  ) {
    issueCodes.add("header_equation_mismatch");
  }

  const lines = items?.map((item) => mapLine(item, issueCodes)) ?? [];
  if (items) validateLines(order, lines, issueCodes);

  const result: CanonicalOrderMoney = {
    orderId: order.id ?? null,
    currency: order.currency,
    subtotal: order.subtotal_cents,
    productDiscount: order.discount_cents,
    shippingGross: order.shipping_cents,
    shippingDiscount: order.shipping_discount_cents,
    shippingEffective,
    tax: order.tax_cents,
    total: order.total_cents,
    lines,
    validationScope: items ? "full" : "header",
    reconciled: issueCodes.size === 0,
    issueCodes: [...issueCodes],
  };

  if (!result.reconciled) {
    try {
      onDiagnostic({
        event: "commerce_order_money_unreconciled",
        orderId: result.orderId,
        validationScope: result.validationScope,
        issueCodes: result.issueCodes,
      });
    } catch {
      // Diagnostics must never turn the rollback-only read fallback into a
      // customer-facing outage.
    }
  }
  return result;
}

export function emitOrderMoneyDiagnostic(diagnostic: OrderMoneyDiagnostic): void {
  console.warn(diagnostic.event, JSON.stringify({
    orderId: diagnostic.orderId,
    validationScope: diagnostic.validationScope,
    issueCodes: diagnostic.issueCodes,
  }));
}

function mapLine(
  item: OrderMoneyItemRow,
  issueCodes: Set<OrderMoneyIssueCode>,
): CanonicalOrderMoneyLine {
  const trioComplete = item.discount_allocated_cents != null
    && item.effective_total_cents != null
    && item.effective_net_cents != null;
  if (!trioComplete) issueCodes.add("missing_item_canonical_money");

  const discountAllocated = trioComplete ? item.discount_allocated_cents as number : 0;
  const effectiveGross = trioComplete ? item.effective_total_cents as number : item.total_cents;
  const effectiveNet = trioComplete
    ? item.effective_net_cents as number
    : netFromGross(item.total_cents, item.vat_rate_bps);

  if (!isPositiveSafeInteger(item.quantity)) {
    issueCodes.add("item_quantity_out_of_range");
  }
  if (
    !isNonNegativeSafeInteger(item.unit_price_cents)
    || !isNonNegativeSafeInteger(item.total_cents)
  ) {
    issueCodes.add("item_catalog_money_out_of_range");
  }
  if (
    !isNonNegativeSafeInteger(item.vat_rate_bps)
    || item.vat_rate_bps > 10_000
  ) {
    issueCodes.add("item_vat_rate_out_of_range");
  }
  if (trioComplete) {
    if (
      !isNonNegativeSafeInteger(discountAllocated)
      || discountAllocated > item.total_cents
    ) {
      issueCodes.add("item_discount_out_of_range");
    }
    if (
      !isNonNegativeSafeInteger(effectiveGross)
      || !isNonNegativeSafeInteger(effectiveNet)
      || effectiveGross > item.total_cents
      || effectiveNet > effectiveGross
    ) {
      issueCodes.add("item_effective_money_out_of_range");
    }
  }

  if (effectiveGross + discountAllocated !== item.total_cents) {
    issueCodes.add("item_gross_equation_mismatch");
  }
  if (item.unit_price_cents * item.quantity !== item.total_cents) {
    issueCodes.add("item_catalog_equation_mismatch");
  }
  if (effectiveNet !== netFromGross(effectiveGross, item.vat_rate_bps)) {
    issueCodes.add("item_net_vat_mismatch");
  }
  return {
    id: item.id ?? null,
    quantity: item.quantity,
    catalogUnit: item.unit_price_cents,
    catalogTotal: item.total_cents,
    discountAllocated,
    effectiveGross,
    effectiveNet,
    vatRateBps: item.vat_rate_bps,
  };
}

function validateLines(
  order: OrderMoneyHeaderRow,
  lines: readonly CanonicalOrderMoneyLine[],
  issueCodes: Set<OrderMoneyIssueCode>,
): void {
  const catalogTotal = sum(lines, (line) => line.catalogTotal);
  const allocatedDiscount = sum(lines, (line) => line.discountAllocated);
  const effectiveTotal = sum(lines, (line) => line.effectiveGross);

  if (catalogTotal !== order.subtotal_cents) issueCodes.add("catalog_subtotal_mismatch");
  if (allocatedDiscount !== order.discount_cents) issueCodes.add("allocated_discount_mismatch");
  if (effectiveTotal !== order.subtotal_cents - order.discount_cents) {
    issueCodes.add("effective_subtotal_mismatch");
  }
  if (
    effectiveTotal + order.shipping_cents - order.shipping_discount_cents
    !== order.total_cents
  ) {
    issueCodes.add("total_positions_mismatch");
  }

  const rates = new Set(lines.map((line) => line.vatRateBps));
  if (lines.length > 0 && rates.size !== 1) issueCodes.add("mixed_vat_rates");
  if (lines.length > 0 && rates.size === 1) {
    const vatRateBps = lines[0]?.vatRateBps ?? 0;
    const netTotal = sum(lines, (line) => line.effectiveNet)
      + netFromGross(order.shipping_cents - order.shipping_discount_cents, vatRateBps);
    if (order.total_cents - netTotal !== order.tax_cents) {
      issueCodes.add("tax_total_mismatch");
    }
  } else if (lines.length === 0 && order.total_cents !== order.tax_cents) {
    issueCodes.add("tax_total_mismatch");
  }
}

function netFromGross(gross: number, vatRateBps: number): number {
  return Math.round(gross * 10_000 / (10_000 + vatRateBps));
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
