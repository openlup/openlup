export const taxAndMoneyDomain = {
  owned: {
    renewalIssuances: ["subscription_cycle_tax_issuances"],
    renewalBindings: ["subscription_cycle_tax_bindings"],
    renewalRebinds: ["subscription_cycle_calculation_rebinds"],
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
    commerce_order_tax_snapshots: ["trg_commerce_order_tax_snapshots_money_v2"],
    commerce_order_line_sources: ["trg_commerce_order_line_sources_money_v2"],
    commerce_order_delivery_buckets: ["trg_commerce_order_delivery_buckets_money_v2"],
    commerce_order_line_allocations: ["trg_commerce_order_line_allocations_money_v2"],
    commerce_order_tax_positions: ["trg_commerce_order_tax_positions_money_v2"],
    commerce_order_fee_lines: ["trg_commerce_order_fee_lines_money_v2"],
    tax_calculations: ["tax_calculation_guard"],
  },
} as const;
