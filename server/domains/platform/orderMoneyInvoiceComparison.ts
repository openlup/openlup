import type {
  OrderItemMoneyRow,
  OrderMoneyMismatchCode,
  PaidOrderMoneyRow,
} from "../../../src/domains/platform/orderMoneyReconciliationContracts.js";
import type { CanonicalInvoicePositionTotals } from "./invoicePositionSnapshot.js";

export function compareCanonicalInvoicePositionsToOrder(input: {
  order: PaidOrderMoneyRow;
  orderItems: OrderItemMoneyRow[];
  positions: CanonicalInvoicePositionTotals;
  mismatches: OrderMoneyMismatchCode[];
}): void {
  const { order, orderItems, positions, mismatches } = input;
  if (!hasValidCanonicalOrderHeader(order)) mismatches.push("order_header");

  const orderNetCents = order.total_cents - order.tax_cents;
  if (positions.grossCents !== order.total_cents) mismatches.push("invoice_positions_gross");
  if (positions.netCents !== orderNetCents) mismatches.push("invoice_positions_net");
  if (positions.itemCatalogGrossCents !== order.subtotal_cents) mismatches.push("invoice_positions_catalog");
  if (positions.itemDiscountAllocatedCents !== order.discount_cents) mismatches.push("invoice_positions_discount");
  const expectedDeliveryGross = order.shipping_cents - order.shipping_discount_cents;
  if (positions.deliveryGrossCents !== expectedDeliveryGross) mismatches.push("invoice_positions_shipping");
  if (expectedDeliveryGross > 0) {
    if (positions.shippingGrossCents !== order.shipping_cents) mismatches.push("invoice_positions_shipping");
    if (positions.shippingDiscountCents !== order.shipping_discount_cents) {
      mismatches.push("invoice_positions_shipping_discount");
    }
  }
  if (!sameCanonicalOrderItems(orderItems, positions)) mismatches.push("invoice_positions_order_items");
}

export function hasValidCanonicalOrderHeader(order: PaidOrderMoneyRow): boolean {
  const money = [
    order.subtotal_cents,
    order.discount_cents,
    order.shipping_cents,
    order.shipping_discount_cents,
    order.tax_cents,
    order.total_cents,
  ];
  return money.every(nonnegativeSafeInteger) &&
    order.discount_cents <= order.subtotal_cents &&
    order.shipping_discount_cents <= order.shipping_cents &&
    order.tax_cents <= order.total_cents &&
    order.subtotal_cents - order.discount_cents + order.shipping_cents - order.shipping_discount_cents ===
      order.total_cents;
}

function sameCanonicalOrderItems(
  rows: OrderItemMoneyRow[],
  positions: CanonicalInvoicePositionTotals,
): boolean {
  if (rows.length === 0 || rows.length !== positions.items.length) return false;
  const sortedRows = [...rows].sort((left, right) =>
    left.allocation_ordinal - right.allocation_ordinal || left.id.localeCompare(right.id));
  return sortedRows.every((row, index) => {
    const position = positions.items[index];
    return position !== undefined &&
      row.id === position.orderItemId &&
      row.allocation_ordinal === position.allocationOrdinal &&
      row.quantity === position.quantity &&
      row.total_cents === position.catalogGrossCents &&
      row.discount_allocated_cents === position.discountAllocatedCents &&
      row.effective_total_cents === position.totalGrossCents &&
      row.effective_net_cents === position.totalNetCents &&
      row.vat_rate_bps === position.vatRateBps;
  });
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
