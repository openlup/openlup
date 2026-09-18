export const ORDER_A = order("42222222-2222-4222-8222-222222222221", "OMS-1001");
export const ORDER_B = order("42222222-2222-4222-8222-222222222222", "OMS-1002");

export function order(id: string, orderNumber: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    order_number: orderNumber,
    client_id: null,
    status: "paid",
    mode: "one_time",
    currency: "PLN",
    subtotal_cents: 12900,
    discount_cents: 0,
    shipping_cents: 0,
    shipping_discount_cents: 0,
    tax_cents: 956,
    total_cents: 12900,
    metadata: null,
    created_at: "2026-06-05T10:00:00+00:00",
    updated_at: "2026-06-05T10:01:00+00:00",
    subscription_id: null,
    subscription_cycle_id: null,
    shipping_address_id: "45555555-5555-4555-8555-555555555555",
    pet_id: null,
    ...overrides,
  };
}

/**
 * An order row in a currency this deployment does not accept. The channel
 * ingest rail is multi-currency by design, so this shape is reachable from real
 * data - it is not a synthetic impossibility. Kept as its own factory so the
 * default `order()` above stays the canonical accepted-currency row that every
 * other test in this suite reads.
 */
export function foreignCurrencyOrder(id: string, orderNumber: string, currency = "EUR") {
  return order(id, orderNumber, { currency });
}

/**
 * A `commerce_order_holds` row as both list reads see it: the active-hold read
 * selects `order_id, reason`, the released provider-exception read selects more
 * and filters on `status`/`reason`, so one factory has to carry every column
 * either of them can filter or project.
 */
export function hold(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    order_id: orderId,
    status: "active",
    reason: "fulfillment_exception",
    created_by: null,
    released_by: null,
    metadata: {},
    ...overrides,
  };
}

export function money(amountMinor: number) {
  return { amountMinor, currency: "PLN" };
}

export function paymentIntent(orderId: string) {
  return {
    id: `52222222-2222-4222-8222-${orderId.slice(-12)}`,
    order_id: orderId,
    payment_id: null,
    status: "succeeded",
    active_attempt_id: null,
    provider_payment_id: null,
    updated_at: "2026-06-05T10:01:00+00:00",
  };
}

export function orderItem(orderId: string, id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    order_id: orderId,
    sku_id: null,
    quantity: 1,
    unit_price_cents: 12900,
    total_cents: 12900,
    discount_allocated_cents: 0,
    effective_total_cents: 12900,
    effective_net_cents: 11944,
    vat_rate_bps: 800,
    product_snapshot: { title: "Puppy Beef Box" },
    variant_snapshot: null,
    ...overrides,
  };
}

export function reservation(orderId: string, orderItemId: string) {
  return {
    id: `92222222-2222-4222-8222-${orderId.slice(-12)}`,
    order_id: orderId,
    order_item_id: orderItemId,
    quantity: 1,
    status: "reserved",
    expires_at: "2026-06-05T10:30:00+00:00",
    location_id: "a2222222-2222-4222-8222-222222222222",
    inventory_locations: { code: "pl-main" },
  };
}

export function invoice(orderId: string, id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    order_id: orderId,
    correction_of_invoice_id: null,
    invoice_ref: `FV/${id}`,
    status: "issue_requested",
    provider_kind: "preview_accounting",
    provider_invoice_number: null,
    ksef_status: "pending",
    total_gross_cents: 12900,
    currency: "PLN",
    updated_at: "2026-06-05T10:02:00+00:00",
    ...overrides,
  };
}

export function correctionInvoice(orderId: string, id: string, baseInvoiceId: string, overrides: Record<string, unknown> = {}) {
  return invoice(orderId, id, {
    correction_of_invoice_id: baseInvoiceId,
    invoice_ref: `KOR/${id}`,
    status: "issued",
    updated_at: "2026-06-05T10:04:00+00:00",
    ...overrides,
  });
}

export function outbox(invoiceId: string, status: string, createdAt: string) {
  return {
    invoice_id: invoiceId,
    status,
    attempt_count: status === "failed" ? 1 : 0,
    next_attempt_at: status === "failed" ? "2026-06-05T10:30:00+00:00" : null,
    last_error: status === "failed" ? { code: "admin_oms_preview_fixture" } : {},
    created_at: createdAt,
  };
}

export function communicationDelivery(orderId: string) {
  return {
    id: "62222222-2222-4222-8222-222222222223",
    purpose: "transactional",
    template_slug: "commerce-order-paid",
    trigger_source: "outbox-dispatch",
    trigger_event: "commerce.order.paid.email",
    aggregate_type: "commerce_order",
    aggregate_id: orderId,
    dedupe_key: "outbox:72222222-2222-4222-8222-222222222223",
    status: "sent",
    provider_kind: "resend",
    provider_message_id: "resend_paid_1",
    scheduled_due_at: "2026-06-05T10:01:00+00:00",
    expected_send_at: "2026-06-05T10:11:00+00:00",
    queued_at: "2026-06-05T10:02:00+00:00",
    first_attempt_at: "2026-06-05T10:02:00+00:00",
    sent_at: "2026-06-05T10:02:01+00:00",
    delivered_at: null,
    terminal_at: null,
    last_error_code: null,
    outbox_event_id: "72222222-2222-4222-8222-222222222223",
    platform_job_run_id: null,
    email_send_id: "82222222-2222-4222-8222-222222222223",
    metadata: {},
    created_at: "2026-06-05T10:01:00+00:00",
    updated_at: "2026-06-05T10:02:01+00:00",
  };
}
