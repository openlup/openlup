export const taxAndMoneyDomain = {
  owned: {
    moneyAndTax: [
      "commerce_money_limits_v2",
      "tax_calculations",
      "commerce_order_tax_snapshots",
      "commerce_order_line_sources",
      "commerce_order_delivery_buckets",
      "commerce_order_line_allocations",
      "commerce_order_tax_positions",
      "commerce_order_fee_lines",
    ],
    // Authoritative installation configuration with operator audit references.
    coverageRevisions: [
      "tax_coverage_revisions",
    ],
  },
  restore: {
    coverageRevisions: [
      "tax_coverage_revisions",
    ],
    orderLineSources: [
      "commerce_order_line_sources",
    ],
    postOrders: [
      "commerce_money_limits_v2",
      "tax_calculations",
      "commerce_order_tax_snapshots",
      "commerce_order_delivery_buckets",
      "commerce_order_line_allocations",
      "commerce_order_tax_positions",
      "commerce_order_fee_lines",
    ],
  },
  allowedInsertTriggers: {
    tax_calculations: ["tax_calculation_guard"],
  },
} as const;
