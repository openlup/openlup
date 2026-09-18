import { COMMERCE_CONTRACT_VERSION } from "./types.js";

export function listResponse() {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orders: [baseOrder()],
    summaryCounts: summaryCounts(),
    summaryTotals: summaryTotals(),
    totalCount: 1,
    page: 1,
    pageSize: 25,
  };
}

export function detailResponse() {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    order: {
      ...baseOrder(),
      shippingAddress: null,
      billingAddress: null,
      lines: [],
      subscription: { subscriptionId: null, subscriptionCycleId: null, subscriptionCycleStatus: null, nextCycleAt: null, cyclePaidAt: null },
      inventory: {
        status: "reserved",
        reservationId: "92222222-2222-4222-8222-222222222222",
        reservationStatus: "reserved",
        expiresAt: "2026-06-05T10:30:00+00:00",
        locationId: "a2222222-2222-4222-8222-222222222222",
        locationCode: "pl-main",
      },
      fulfillment: {
        fulfillmentOrderId: null,
        status: null,
        latestOperationType: null,
        latestOperationAt: null,
        providerTrackingId: null,
      },
      fulfillmentHealth: { healthStatus: "ok", attentionReasons: [], oldestAgeSeconds: null, opaqueIds: healthIds() },
      accounting: {
        status: "missing",
        invoiceId: null,
        invoiceRef: null,
        providerKind: null,
        providerInvoiceNumber: null,
        ksefStatus: null,
        outboxStatus: null,
        outboxAttemptCount: null,
        outboxNextAttemptAt: null,
        outboxLastError: null,
        recoveryGuidance: "not_requested",
        updatedAt: null,
      },
      actionEligibility: {
        addNote: { allowed: true, reason: null },
        createHold: { allowed: true, reason: null },
        releaseHold: { allowed: false, reason: "no_active_hold" },
        createFulfillment: { allowed: true, reason: null },
        updateShippingAddress: { allowed: true, reason: null },
        recordLabel: { allowed: false, reason: "fulfillment_not_ready_for_label" },
        handOff: { allowed: false, reason: "label_required_before_handoff" },
        recordTrackingEvent: { allowed: false, reason: "tracking_not_ready" },
        cancelFulfillment: { allowed: false, reason: "fulfillment_not_cancellable" },
        cancelOrder: { allowed: false, reason: "order_not_pending_payment" },
        markRefunded: { allowed: true, reason: null },
      },
      fulfillmentEligibility: { allowed: true, reason: null },
      holds: [],
      operations: [],
      payment: {
        intentId: null,
        paymentId: null,
        status: "not_started",
        activeAttemptId: null,
        providerPaymentId: null,
        updatedAt: null,
      },
      paymentAttempts: [],
      paymentTransitions: [],
      communicationDeliveries: [],
    },
  };
}

export function noteResponse() {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    operation: {
      id: "b2222222-2222-4222-8222-222222222221",
      orderId: "42222222-2222-4222-8222-222222222221",
      type: "support_note",
      holdId: null,
      actorUserId: "a2222222-2222-4222-8222-222222222221",
      occurredAt: "2026-06-05T10:04:00+00:00",
      payload: { note: "Checked address" },
    },
    replayed: false,
  };
}

export function markRefundedResponse() {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orderId: "42222222-2222-4222-8222-222222222221",
    status: "refunded",
    replayed: false,
  };
}

export function updateAddressResponse() {
  const fixture = deliveryContactFixture({ source: "oms_order_override", revision: 2 });
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    result: "applied",
    scope: "order",
    deliveryContact: fixture.canonical,
    operation: {
      id: "b2222222-2222-4222-8222-222222222222",
      orderId: "42222222-2222-4222-8222-222222222221",
      type: "shipping_address_updated",
      holdId: null,
      actorUserId: "a2222222-2222-4222-8222-222222222221",
      occurredAt: "2026-06-05T10:05:00+00:00",
      payload: { source: "commerce.oms.v0" },
    },
    address: fixture.address,
    replayed: false,
  };
}

export interface DeliveryContactFixture extends Record<string, unknown> {
  schemaVersion: 1;
  source: string;
  revision: number;
  recipientName: string;
  contactEmail: string;
  contactPhone: string;
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string;
  country: string;
  selectedDelivery: Record<string, unknown> | null;
  deliveryInstructions: string | null;
  courierInstructions: string | null;
}

export function deliveryContactFixture(overrides: Partial<DeliveryContactFixture> = {}) {
  const canonical: DeliveryContactFixture = {
    schemaVersion: 1,
    source: "checkout_submission",
    revision: 1,
    recipientName: "Ala Kowalska",
    contactEmail: "ala@example.com",
    contactPhone: "500600700",
    line1: "Prosta 1",
    line2: null,
    city: "Warszawa",
    postalCode: "00-001",
    country: "PL",
    selectedDelivery: null,
    deliveryInstructions: null,
    courierInstructions: null,
    ...overrides,
  };
  const {
    schemaVersion: _schemaVersion,
    source: _source,
    revision: _revision,
    selectedDelivery: _selectedDelivery,
    deliveryInstructions: _deliveryInstructions,
    courierInstructions: _courierInstructions,
    ...address
  } = canonical;
  return { canonical, address };
}

export function holdResponse() {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    hold: {
      id: "92222222-2222-4222-8222-222222222221",
      orderId: "42222222-2222-4222-8222-222222222221",
      status: "active",
      reason: "manual_support",
      note: null,
      createdAt: "2026-06-05T10:02:00+00:00",
      releasedAt: null,
    },
    operationId: "a2222222-2222-4222-8222-222222222221",
    replayed: false,
  };
}

function baseOrder() {
  return {
    orderId: "42222222-2222-4222-8222-222222222221",
    orderNumber: null,
    clientId: null,
    customer: null,
    pet: null,
    status: "paid",
    mode: "one_time",
    paymentMethodLabel: "Karta",
    paymentProvider: "stripe",
    paymentStatus: "succeeded",
    fulfillmentStatus: null,
    customerFulfillmentStep: "paid",
    inventoryStatus: "reserved",
    accountingStatus: "missing",
    providerOpsStatus: "none",
    providerOpsSla: null,
    providerOrderId: null,
    attentionReason: "fulfillment_pending",
    nextAction: "create_fulfillment",
    activeHoldCount: 0,
    activeHoldReasons: [],
    fulfillmentHealthDigest: { healthStatus: "ok", attentionReasons: [] },
    total: { amountMinor: 12900, currency: "PLN" },
    pricingSummary: {
      subtotal: { amountMinor: 12900, currency: "PLN" },
      productDiscount: { amountMinor: 0, currency: "PLN" },
      shipping: { amountMinor: 0, currency: "PLN" },
      shippingDiscount: { amountMinor: 0, currency: "PLN" },
      discountTotal: { amountMinor: 0, currency: "PLN" },
      finalTotal: { amountMinor: 12900, currency: "PLN" },
      source: "order_columns",
    },
    createdAt: "2026-06-05T10:00:00+00:00",
    updatedAt: "2026-06-05T10:01:00+00:00",
  };
}

function healthIds() {
  return {
    orderId: "42222222-2222-4222-8222-222222222221",
    fulfillmentOrderId: null,
    outboxEventId: null,
    dispatchRefFulfillmentOrderId: null,
    latestEvidenceFulfillmentOrderId: null,
  };
}

function summaryCounts() {
  return {
    needsAttention: 1,
    activeHold: 0,
    readyForFulfillment: 1,
    paymentIssues: 0,
    inventoryRisk: 0,
    fulfillmentBlocked: 0,
    fulfillmentExceptions: 0,
    invoiceIssues: 0,
    omnipackDispatchedNotPicked: 0,
  };
}

function summaryTotals() {
  return {
    gmv: { amountMinor: 12900, currency: "PLN" },
    aov: { amountMinor: 12900, currency: "PLN" },
    orderCount: 1,
    paidSubscriptionCycleCount: 0,
  };
}
