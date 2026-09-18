/** @beta */
export const SHIPPING_MODE_AT_CART = ["one_time", "subscription", "any"] as const;
/** @beta */
export type ShippingModeAtCart = (typeof SHIPPING_MODE_AT_CART)[number];

/** @beta */
export const SHIPPING_VAT_RATE_KINDS = ["fixed", "inherit_main_goods", "highest_in_cart"] as const;
/** @beta */
export type ShippingVatRateKind = (typeof SHIPPING_VAT_RATE_KINDS)[number];

/** @beta */
export interface ShippingRule {
  id: string;
  name: string;
  region_code: string;
  currency: string;
  mode_at_cart: ShippingModeAtCart;
  carrier_kind: string;
  free_threshold_minor: number | null;
  fixed_cost_minor: number | null;
  weight_threshold_g: number | null;
  delivery_estimate_days: number | null;
  priority: number;
  vat_rate_bps: number;
  vat_rate_kind: ShippingVatRateKind;
  active: boolean;
  valid_from: string;
  valid_to: string | null;
}

/** @beta */
export interface ShippingResolverCart {
  region_code: string;
  currency: string;
  cart_mode: "one_time" | "subscription";
  subtotal_minor: number;
  line_vat_rates_bps: ReadonlyArray<number>;
  weight_total_g?: number;
}

/** @beta */
export interface ResolvedShipping {
  amount_minor: number;
  carrier_kind: string;
  delivery_estimate_days: number | null;
  applied_rule_id: string;
  applied_rule_name: string;
  vat_rate_bps: number;
}
