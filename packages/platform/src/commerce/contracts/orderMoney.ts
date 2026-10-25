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
