export const ORDER_MONEY_RECONCILIATION_MODES = [
  "one_time",
  "subscription_initial",
  "subscription_renewal",
] as const;

export type OrderMoneyReconciliationMode =
  (typeof ORDER_MONEY_RECONCILIATION_MODES)[number];

export type MoneyLedgerValue = {
  id: string;
  amountCents: number | null;
  currency: string | null;
};

export type ProviderSettlementReadback =
  | ({ state: "matched" | "mismatch" } & MoneyLedgerValue)
  | {
    state: "not_applicable" | "unsupported" | "pending" | "overdue";
    reason: string;
  };

export type OrderMoneyHeaderLedgerValue = MoneyLedgerValue & {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  shippingDiscountCents: number;
  taxCents: number;
  netCents: number;
};

export type ProviderEventMoneyEvidence = MoneyLedgerValue & {
  state: "matched" | "mismatch" | "unavailable";
};

export type AccountingInvoiceIssueTrigger = "handoff" | "paid";

/** Provider-neutral persistence readbacks consumed by the reconciliation policy. */
export type PaidOrderMoneyRow = {
  id: string;
  order_number: string | null;
  mode: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  shipping_discount_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  subscription_cycle_id: string | null;
  updated_at: string;
};

export type OrderItemMoneyRow = {
  id: string;
  order_id: string;
  allocation_ordinal: number;
  quantity: number;
  total_cents: number;
  discount_allocated_cents: number;
  effective_total_cents: number;
  effective_net_cents: number;
  vat_rate_bps: number;
};

export type SubscriptionCycleMoneyRow = { id: string; cycle_number: number };

export type PaymentIntentMoneyRow = {
  id: string;
  order_id: string;
  payment_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  active_attempt_id: string | null;
  provider_payment_id: string | null;
  updated_at: string;
};

export type PaymentAttemptMoneyRow = {
  id: string;
  created_at?: string;
  updated_at?: string;
  payment_intent_id: string;
  provider: string;
  status: string;
  amount_cents: number;
  currency: string;
  provider_attempt_id: string | null;
};

export type ProviderEventMoneyRow = {
  id: string;
  created_at?: string;
  provider: string;
  provider_event_id: string;
  provider_payment_id: string | null;
  payment_intent_id: string | null;
  payment_attempt_id: string | null;
  event_type: string;
  amount_cents: number | null;
  currency: string | null;
  signature_verified: boolean | null;
};

export type ProviderSettlementMoneyRow = {
  id: string;
  created_at: string;
  batch_id: string;
  provider_kind: string;
  provider_payment_id: string;
  payment_intent_id: string | null;
  payment_id: string | null;
  invoice_id: string | null;
  status: string;
  gross_cents: number;
  currency: string;
  evidence: Record<string, unknown> | null;
  correlation_issue?: "conflicting_links";
};

export type AccountingInvoiceMoneyRow = {
  id: string;
  order_id: string;
  invoice_ref?: string;
  status: string;
  correction_of_invoice_id: string | null;
  provider_kind?: string | null;
  provider_invoice_id: string | null;
  blocked_reason?: string | null;
  total_gross_cents: number;
  total_net_cents: number;
  currency: string;
  lines_snapshot: unknown;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  ksef_status?: string;
};

export type FulfillmentMoneyRow = {
  id: string;
  order_id: string;
  status: string;
  handed_over_at: string | null;
};

export type ProviderReconciliationMoneyRow = {
  id: string;
  payment_intent_id: string | null;
  payment_attempt_id: string | null;
  correction_status: string;
  provider_status: string;
  checked_at: string;
  payload: Record<string, unknown> | null;
};

export type OrderMoneyReconciliationRows = {
  orders: PaidOrderMoneyRow[];
  items: OrderItemMoneyRow[];
  cycles: SubscriptionCycleMoneyRow[];
  intents: PaymentIntentMoneyRow[];
  attempts: PaymentAttemptMoneyRow[];
  events: ProviderEventMoneyRow[];
  reconciliations: ProviderReconciliationMoneyRow[];
  settlements: ProviderSettlementMoneyRow[];
  invoices: AccountingInvoiceMoneyRow[];
  fulfillment: FulfillmentMoneyRow[];
};

export type OrderMoneyInvoiceExpectation = {
  issueTrigger: AccountingInvoiceIssueTrigger;
  state: "not_due" | "grace_period" | "required";
  anchorAt: string | null;
  dueAt: string | null;
};

export type OrderMoneyReconciliationDisposition =
  | "matched"
  | "mismatch"
  | "accounting_missing_invoice_owner"
  | "accepted_legacy_exception";

export type OrderMoneyMismatchCode =
  | "charge_intent_count"
  | "intent_amount"
  | "intent_currency"
  | "succeeded_attempt_count"
  | "intent_active_attempt"
  | "intent_attempt_payment_ref"
  | "attempt_amount"
  | "attempt_currency"
  | "trusted_provider_event_missing"
  | "provider_event_amount"
  | "provider_event_currency"
  | "provider_event_provider"
  | "provider_event_payment_ref"
  | "provider_reconciliation_currency"
  | "provider_settlement_payment_ref"
  | "provider_settlement_correlation"
  | "provider_settlement_provider"
  | "provider_settlement_status"
  | "provider_settlement_amount"
  | "provider_settlement_currency"
  | "base_invoice_count"
  | "order_header"
  | "invoice_amount"
  | "invoice_net_amount"
  | "invoice_currency"
  | "invoice_positions_invalid"
  | "invoice_positions_gross"
  | "invoice_positions_net"
  | "invoice_positions_order_items"
  | "invoice_positions_catalog"
  | "invoice_positions_discount"
  | "invoice_positions_shipping"
  | "invoice_positions_shipping_discount"
  | "subscription_cycle_missing"
  | "promotion_adjustments_invalid"
  | "promotion_product_total"
  | "promotion_shipping_total"
  | "promotion_product_discount_bound"
  | "promotion_shipping_discount_bound"
  | "promotion_product_floor"
  | "promotion_claim_ids";

export type OrderMoneyReconciliationEvidence = {
  orderId: string;
  orderRef: string | null;
  mode: OrderMoneyReconciliationMode;
  paymentProvider: string | null;
  subscriptionCycleId: string | null;
  mismatchCodes: OrderMoneyMismatchCode[];
  order: OrderMoneyHeaderLedgerValue;
  intent: MoneyLedgerValue | null;
  attempt: MoneyLedgerValue | null;
  providerEvent: ProviderEventMoneyEvidence | null;
  localSettlement: ProviderSettlementReadback;
  providerSettlement: ProviderSettlementReadback;
  fulfillment: {
    fulfillmentOrderIds: string[];
    statuses: string[];
    handedOverAt: string | null;
  };
  invoiceExpectation: OrderMoneyInvoiceExpectation;
  invoiceLineageIds: {
    rootInvoiceIds: string[];
    invoiceIds: string[];
    documentKeys: string[];
    currentInvoiceId: string | null;
  };
  disposition: OrderMoneyReconciliationDisposition;
  invoice: (MoneyLedgerValue & {
    netCents: number;
    positionGrossCents: number | null;
    positionNetCents: number | null;
  }) | null;
  relatedIds: {
    chargeIntentIds: string[];
    succeededAttemptIds: string[];
    trustedProviderEventIds: string[];
    trustedProviderReconciliationIds: string[];
    localSettlementIds: string[];
    trustedProviderSettlementIds: string[];
    baseInvoiceIds: string[];
  };
  observedAt: string;
};

export type OrderMoneyReconciliationModeSummary = {
  checkedCount: number;
  mismatchCount: number;
  providerUnavailableCount: number;
  providerUnsupportedCount: number;
  providerPendingCount: number;
  providerOverdueCount: number;
  providerEventMoneyUnavailableCount: number;
};

export type OrderMoneyReconciliationSnapshot = {
  checkedCount: number;
  mismatchCount: number;
  providerUnavailableCount: number;
  providerUnsupportedCount: number;
  providerPendingCount: number;
  providerOverdueCount: number;
  providerEventMoneyUnavailableCount: number;
  byMode: Record<OrderMoneyReconciliationMode, OrderMoneyReconciliationModeSummary>;
  evidence: OrderMoneyReconciliationEvidence[];
  promotionMoneyMismatchCount?: number;
  promotionMoneyEvidenceCount?: number;
  unmatchedPromotionMoneyEvidence?: Array<{
    orderId: string;
    mismatchCodes: OrderMoneyMismatchCode[];
  }>;
};
