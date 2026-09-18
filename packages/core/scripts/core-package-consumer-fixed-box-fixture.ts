export const FIXED_BOX_CONSUMER_MARKER = "fixed-box packed consumer ok";

const uuid = {
  skuAlpha: "11111111-1111-4111-8111-111111111111",
  skuBeta: "22222222-2222-4222-8222-222222222222",
  location: "33333333-3333-4333-8333-333333333333",
  lotAlpha: "44444444-4444-4444-8444-444444444444",
  lotBeta: "55555555-5555-4555-8555-555555555555",
};

export function fixedBoxRuntimeImports(): string[] {
  return [
    "import { slugSchema, skuSchema } from '@openlup/core/catalog';",
    "import { validateCheckoutIdempotencyHeader } from '@openlup/core/checkout';",
    "import { calculateInventoryAtp } from '@openlup/core/inventory';",
    "import { assertBreakdownInvariant as assertFixedBoxBreakdown, buildOrderBreakdown as buildFixedBoxBreakdown } from '@openlup/core/pricing';",
    "import { resolveShipping } from '@openlup/core/shipping';",
    "import { evaluatePromos } from '@openlup/core/promo';",
  ];
}

export function fixedBoxRuntimeScenarioLines(): string[] {
  return [
    "const fixedBoxSlug = slugSchema.parse('fixed-box-alpha');",
    "const fixedBoxSku = skuSchema.parse('CORE-SKU-ALPHA');",
    "const fixedBoxHeader = validateCheckoutIdempotencyHeader('123e4567-e89b-42d3-a456-426614174000');",
    "if (!fixedBoxHeader.ok) throw new Error('fixed-box idempotency rejected');",
    "const fixedBoxAtp = calculateInventoryAtp({",
    "  request: {",
    "    contractVersion: 'inventory.v0',",
    `    requestedAt: '2026-08-01T10:00:00.000Z',`,
    "    orderMode: 'one_time',",
    "    region: 'EXAMPLE',",
    "    noSplitShipment: true,",
    "    minShelfLifeDays: 7,",
    "    lines: [",
    `      { skuId: '${uuid.skuAlpha}', sku: fixedBoxSku, quantity: 1 },`,
    `      { skuId: '${uuid.skuBeta}', sku: 'CORE-SKU-BETA', quantity: 1 },`,
    "    ],",
    "  },",
    "  stock: [",
    `    { skuId: '${uuid.skuAlpha}', sku: fixedBoxSku, locationId: '${uuid.location}', locationCode: 'NEUTRAL-WH', locationKind: 'internal_warehouse', locationStatus: 'active', fulfillable: true, lotId: '${uuid.lotAlpha}', lotCode: 'LOT-ALPHA', lotStatus: 'available', expiresAt: '2027-01-01T00:00:00.000Z', onHand: 3, reserved: 0, unavailable: 0, incoming: 0, safetyStock: 0 },`,
    `    { skuId: '${uuid.skuBeta}', sku: 'CORE-SKU-BETA', locationId: '${uuid.location}', locationCode: 'NEUTRAL-WH', locationKind: 'internal_warehouse', locationStatus: 'active', fulfillable: true, lotId: '${uuid.lotBeta}', lotCode: 'LOT-BETA', lotStatus: 'available', expiresAt: '2027-01-01T00:00:00.000Z', onHand: 3, reserved: 0, unavailable: 0, incoming: 0, safetyStock: 0 },`,
    "  ],",
    "});",
    "if (fixedBoxAtp.status !== 'fulfillable') throw new Error('fixed-box ATP failed');",
    "const fixedBoxShipping = resolveShipping(",
    "  { region_code: 'EXAMPLE', currency: 'USD', cart_mode: 'one_time', subtotal_minor: 2400, line_vat_rates_bps: [0, 0], weight_total_g: 1200 },",
    "  [{ id: 'standard', name: 'Standard', region_code: 'EXAMPLE', currency: 'USD', mode_at_cart: 'one_time', carrier_kind: 'neutral-carrier', free_threshold_minor: 2000, fixed_cost_minor: 300, weight_threshold_g: null, delivery_estimate_days: 3, priority: 1, vat_rate_bps: 0, vat_rate_kind: 'fixed', active: true, valid_from: '2026-01-01T00:00:00.000Z', valid_to: null }],",
    "  '2026-08-01T10:00:00.000Z',",
    ");",
    "if (!fixedBoxShipping || fixedBoxShipping.amount_minor !== 0) throw new Error('fixed-box shipping failed');",
    "const fixedBoxPromos = evaluatePromos({",
    "  now: '2026-08-01T10:00:00.000Z',",
    "  cart: { region_code: 'EXAMPLE', cart_mode: 'one_time', cart_subtotal_minor: 2400, shipping_amount_minor: fixedBoxShipping.amount_minor, client_orders_count: 0, client_onetime_orders_count: 0, applied_codes: ['FIXED10'] },",
    "  candidates: [{ id: 'fixed-box-promo', code: 'FIXED10', name: 'Fixed box credit', trigger_type: 'coupon_code', discount_type: 'fixed_amount', discount_value: 100, applies_to_kind: 'order_total', applies_to_payload: { cart_mode: 'one_time' }, stacking_rule: 'exclusive', eligibility: { first_onetime_purchase: true, min_cart_minor: 2000 }, valid_from: '2026-01-01T00:00:00.000Z', valid_to: null, status: 'active', region_availability: ['EXAMPLE'] }],",
    "});",
    "if (fixedBoxPromos[0]?.amount_off_minor !== 100) throw new Error('fixed-box promo failed');",
    "const fixedBoxBreakdown = buildFixedBoxBreakdown({ lines: [{ variant_id: fixedBoxSlug, line_qty: 2, base_unit_price_minor: 1200, resolved_unit_price_minor: 1200, matched_tier_min_qty: 1, mode_at_line: 'one_time', mode_resolved_via_fallback: false }], shipping: { amount_minor: fixedBoxShipping.amount_minor, applied_rule_id: fixedBoxShipping.applied_rule_id, carrier_kind: fixedBoxShipping.carrier_kind, vat_rate_bps: fixedBoxShipping.vat_rate_bps }, discounts: fixedBoxPromos.map((promo) => ({ promotionId: promo.promotion_id, amountOffMinor: promo.amount_off_minor, reasonCode: promo.reason_code })) });",
    "assertFixedBoxBreakdown(fixedBoxBreakdown, 2300);",
    `console.log('${FIXED_BOX_CONSUMER_MARKER}');`,
  ];
}

export function fixedBoxTypecheckImports(): string[] {
  return [
    "import { slugSchema, skuSchema } from '@openlup/core/catalog';",
    "import { validateCheckoutIdempotencyHeader } from '@openlup/core/checkout';",
    "import { calculateInventoryAtp, type InventoryAtpRequest, type InventoryStockLine } from '@openlup/core/inventory';",
    "import { assertBreakdownInvariant as assertFixedBoxBreakdown, buildOrderBreakdown as buildFixedBoxBreakdown } from '@openlup/core/pricing';",
    "import { resolveShipping, type ShippingRule } from '@openlup/core/shipping';",
    "import { evaluatePromos, type PromotionRow } from '@openlup/core/promo';",
  ];
}

export function fixedBoxTypecheckScenarioLines(): string[] {
  return [
    "const fixedBoxSlug = slugSchema.parse('fixed-box-alpha');",
    "const fixedBoxSku = skuSchema.parse('CORE-SKU-ALPHA');",
    "const fixedBoxHeader = validateCheckoutIdempotencyHeader('123e4567-e89b-42d3-a456-426614174000');",
    "if (!fixedBoxHeader.ok) throw new Error('fixed-box idempotency rejected');",
    "const fixedBoxRequest: InventoryAtpRequest = {",
    "  contractVersion: 'inventory.v0',",
    "  requestedAt: '2026-08-01T10:00:00.000Z',",
    "  orderMode: 'one_time',",
    "  region: 'EXAMPLE',",
    "  noSplitShipment: true,",
    "  minShelfLifeDays: 7,",
    `  lines: [{ skuId: '${uuid.skuAlpha}', sku: fixedBoxSku, quantity: 1 }, { skuId: '${uuid.skuBeta}', sku: 'CORE-SKU-BETA', quantity: 1 }],`,
    "};",
    "const fixedBoxStock: InventoryStockLine[] = [",
    `  { skuId: '${uuid.skuAlpha}', sku: fixedBoxSku, locationId: '${uuid.location}', locationCode: 'NEUTRAL-WH', locationKind: 'internal_warehouse', locationStatus: 'active', fulfillable: true, lotId: '${uuid.lotAlpha}', lotCode: 'LOT-ALPHA', lotStatus: 'available', expiresAt: '2027-01-01T00:00:00.000Z', onHand: 3, reserved: 0, unavailable: 0, incoming: 0, safetyStock: 0 },`,
    `  { skuId: '${uuid.skuBeta}', sku: 'CORE-SKU-BETA', locationId: '${uuid.location}', locationCode: 'NEUTRAL-WH', locationKind: 'internal_warehouse', locationStatus: 'active', fulfillable: true, lotId: '${uuid.lotBeta}', lotCode: 'LOT-BETA', lotStatus: 'available', expiresAt: '2027-01-01T00:00:00.000Z', onHand: 3, reserved: 0, unavailable: 0, incoming: 0, safetyStock: 0 },`,
    "];",
    "const fixedBoxAtp = calculateInventoryAtp({ request: fixedBoxRequest, stock: fixedBoxStock });",
    "const fixedBoxRules: ShippingRule[] = [{ id: 'standard', name: 'Standard', region_code: 'EXAMPLE', currency: 'USD', mode_at_cart: 'one_time', carrier_kind: 'neutral-carrier', free_threshold_minor: 2000, fixed_cost_minor: 300, weight_threshold_g: null, delivery_estimate_days: 3, priority: 1, vat_rate_bps: 0, vat_rate_kind: 'fixed', active: true, valid_from: '2026-01-01T00:00:00.000Z', valid_to: null }];",
    "const fixedBoxShipping = resolveShipping({ region_code: 'EXAMPLE', currency: 'USD', cart_mode: 'one_time', subtotal_minor: 2400, line_vat_rates_bps: [0, 0], weight_total_g: 1200 }, fixedBoxRules, '2026-08-01T10:00:00.000Z');",
    "if (!fixedBoxShipping) throw new Error('fixed-box shipping failed');",
    "const fixedBoxPromos = evaluatePromos({ now: '2026-08-01T10:00:00.000Z', cart: { region_code: 'EXAMPLE', cart_mode: 'one_time', cart_subtotal_minor: 2400, shipping_amount_minor: fixedBoxShipping.amount_minor, client_orders_count: 0, client_onetime_orders_count: 0, applied_codes: ['FIXED10'] }, candidates: [{ id: 'fixed-box-promo', code: 'FIXED10', name: 'Fixed box credit', trigger_type: 'coupon_code', discount_type: 'fixed_amount', discount_value: 100, applies_to_kind: 'order_total', applies_to_payload: { cart_mode: 'one_time' }, stacking_rule: 'exclusive', eligibility: { first_onetime_purchase: true, min_cart_minor: 2000 }, valid_from: '2026-01-01T00:00:00.000Z', valid_to: null, status: 'active', region_availability: ['EXAMPLE'] } satisfies PromotionRow] });",
    "const fixedBoxBreakdown = buildFixedBoxBreakdown({ lines: [{ variant_id: fixedBoxSlug, line_qty: 2, base_unit_price_minor: 1200, resolved_unit_price_minor: 1200, matched_tier_min_qty: 1, mode_at_line: 'one_time', mode_resolved_via_fallback: false }], shipping: { amount_minor: fixedBoxShipping.amount_minor, applied_rule_id: fixedBoxShipping.applied_rule_id, carrier_kind: fixedBoxShipping.carrier_kind, vat_rate_bps: fixedBoxShipping.vat_rate_bps }, discounts: fixedBoxPromos.map((promo) => ({ promotionId: promo.promotion_id, amountOffMinor: promo.amount_off_minor, reasonCode: promo.reason_code })) });",
    "assertFixedBoxBreakdown(fixedBoxBreakdown, 2300);",
    "export const fixedBoxConsumerProof = { sku: fixedBoxSku, atpStatus: fixedBoxAtp.status, orderTotalMinor: fixedBoxBreakdown.orderTotalMinor };",
  ];
}
