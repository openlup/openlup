import { fireEvent, screen } from "@testing-library/react";
type SearchMatch = { field: "order_number" | "order_id" | "email" | "phone" | "customer" | "pet" | "address" | "postal_code" | "tracking" | "invoice" | "payment" | "provider_order" | "sku"; label: string; valuePreview: string | null };
type ListResponseOverrides = { totalCount?: number; orders?: Array<ReturnType<typeof baseOrder>>; summaryTotals?: { gmv: { amountMinor: number; currency: string }; aov: { amountMinor: number; currency: string }; orderCount: number; paidSubscriptionCycleCount: number } };
export function listResponse(overrides: ListResponseOverrides = {}) {
  return {
    contractVersion: "commerce.v0",
    orders: overrides.orders ?? [baseOrder()],
    summaryCounts: {
      needsAttention: 7,
      activeHold: 3,
      readyForFulfillment: 5,
      paymentIssues: 2,
      inventoryRisk: 1,
      fulfillmentBlocked: 4,
      fulfillmentExceptions: 0,
      invoiceIssues: 6,
      omnipackDispatchedNotPicked: 8,
    },
    summaryTotals: overrides.summaryTotals ?? {
      gmv: { amountMinor: 250000, currency: "PLN" },
      aov: { amountMinor: 12500, currency: "PLN" },
      orderCount: overrides.totalCount ?? 1,
      paidSubscriptionCycleCount: 14,
    },
    totalCount: overrides.totalCount ?? 1,
    page: 1,
    pageSize: 25,
  };
}
export function detailResponse(overrides: { order?: Record<string, unknown> } = {}) {
  const shippingAddress = {
    id: "a2222222-2222-4222-8222-222222222222",
    label: "shipping",
    recipientName: "Ala Kowalska",
    companyName: null,
    taxId: null,
    line1: "Prosta 1",
    line2: null,
    city: "Warszawa",
    postalCode: "00-001",
    country: "PL",
    contactPhone: "500600700",
    deliveryNotes: "Leave at door",
    courierInstructions: "Call before arrival",
  };
  const { id: _id, label: _label, companyName: _companyName, taxId: _taxId, deliveryNotes, ...contactAddress } = shippingAddress;
  const contact = { schemaVersion: 1, source: "checkout_submission", revision: 1, ...contactAddress, contactEmail: "ala@example.com", selectedDelivery: null, deliveryInstructions: deliveryNotes };
  const order = {
    ...baseOrder(),
    shippingAddress,
    deliveryContact: {
      baseline: contact,
      effective: contact,
      scope: "baseline",
      source: "checkout_submission",
      revision: 1,
      digest: "0123456789abcdef0123456789abcdef",
      frozen: false,
      providerSubmissionState: "not_materialized",
      correctionAllowed: true,
    },
    billingAddress: {
      id: "a3222222-2222-4222-8222-222222222222",
      label: "billing",
      recipientName: "Ala Kowalska",
      companyName: "Ala Dogs sp. z o.o.",
      taxId: "PL1234567890",
      line1: "Fakturowa 2",
      line2: null,
      city: "Warszawa",
      postalCode: "00-002",
      country: "PL",
      contactPhone: "500600700",
      deliveryNotes: null,
      courierInstructions: null,
    },
    deliverySelection: null,
    lines: [
      {
        id: "52222222-2222-4222-8222-222222222221",
        skuId: "52222222-2222-4222-8222-222222222222",
        sku: "beef-box",
        title: "Puppy Beef Box",
        quantity: 1,
        unitPrice: { amountMinor: 12900, currency: "PLN" },
        total: { amountMinor: 12900, currency: "PLN" },
        discountAllocated: { amountMinor: 900, currency: "PLN" },
        effectiveTotal: { amountMinor: 12000, currency: "PLN" },
        effectiveNet: { amountMinor: 9756, currency: "PLN" },
        vatRateBps: 2300,
        productSnapshot: {},
        variantSnapshot: null,
      },
    ],
    // cyclePaidAt is Monday 2026-07-20 12:00 Warsaw — a business day before the
    // 16:00 cut-off, so the admin estimate renders a same-day dispatch.
    subscription: { subscriptionId: "12222222-2222-4222-8222-222222222221", subscriptionCycleId: "12222222-2222-4222-8222-222222222222", subscriptionCycleStatus: "paid", nextCycleAt: "2026-08-17T10:00:00+00:00", cyclePaidAt: "2026-07-20T10:00:00+00:00" },
    inventory: {
      status: "reserved", reservationId: "92222222-2222-4222-8222-222222222222", reservationStatus: "reserved",
      expiresAt: "2026-06-05T10:30:00+00:00", locationId: "a2222222-2222-4222-8222-222222222222", locationCode: "pl-main",
    },
    fulfillment: {
      fulfillmentOrderId: null,
      status: null,
      providerKind: null,
      latestOperationType: null,
      latestOperationAt: null,
      providerTrackingId: null,
      trackingUrl: null,
      carrierKind: null,
      service: null,
      trackingReferences: [],
      trackingTimeline: [],
      providerEvidence: [],
    },
    replacementChain: { sequenceNo: 0, replacesFulfillmentOrderId: null, replacementReason: null, supersededParcels: [] },
    fulfillmentHealth: { healthStatus: "ok", attentionReasons: [], oldestAgeSeconds: null, opaqueIds: { orderId: "42222222-2222-4222-8222-222222222221", fulfillmentOrderId: null, outboxEventId: null, dispatchRefFulfillmentOrderId: null, latestEvidenceFulfillmentOrderId: null } },
    fulfillmentDebug: { summary: "Brak danych fulfillmentu.", severity: "watch", nextAction: "wait", blockers: [], steps: [] },
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
    operations: [
      {
        id: "62222222-2222-4222-8222-222222222221",
        orderId: "42222222-2222-4222-8222-222222222221",
        type: "support_note",
        holdId: null,
        actorUserId: "72222222-2222-4222-8222-222222222221",
        occurredAt: "2026-06-05T10:08:00+00:00",
        payload: { note: "Packed with care" },
      },
      {
        id: "62222222-2222-4222-8222-222222222222",
        orderId: "42222222-2222-4222-8222-222222222221",
        type: "shipping_address_updated",
        holdId: null,
        actorUserId: "72222222-2222-4222-8222-222222222221",
        occurredAt: "2026-06-05T10:09:00+00:00",
        payload: { source: "commerce.oms.v0", address: { city: "Warszawa", postalCode: "00-001", country: "PL" } },
      },
    ],
    payment: {
      intentId: "d2222222-2222-4222-8222-222222222221",
      paymentId: "p2222222-2222-4222-8222-222222222221",
      status: "succeeded",
      activeAttemptId: "e2222222-2222-4222-8222-222222222221",
      providerPaymentId: "pay_123",
      updatedAt: "2026-06-05T10:02:00+00:00",
    },
    paymentAttempts: [
      {
        id: "e2222222-2222-4222-8222-222222222221",
        status: "succeeded",
        provider: "simulator",
        providerAttemptId: "attempt_123",
        nextActionKind: null,
        updatedAt: "2026-06-05T10:02:00+00:00",
      },
    ],
    paymentTransitions: [
      {
        id: "f2222222-2222-4222-8222-222222222221",
        transitionKind: "provider_result",
        fromStatus: "processing",
        toStatus: "succeeded",
        reason: "simulator_paid",
        occurredAt: "2026-06-05T10:02:00+00:00",
      },
    ],
    ...(overrides.order ?? {}),
  };
  return {
    contractVersion: "commerce.v0",
    order,
  };
}
export function accountingSummaryResponse() {
  return {
    summary: {
      orderId: "42222222-2222-4222-8222-222222222221",
      status: "outbox_failed",
      recoveryGuidance: "review_and_retry",
      invoice: {
        id: "92222222-2222-4222-8222-222222222221",
        orderId: "42222222-2222-4222-8222-222222222221",
        invoiceRef: "FV/OMS/1001",
        status: "issue_requested",
        documentType: "b2b_invoice",
        buyerKind: "business",
        ksefRequirement: "required",
        ksefStatus: "pending",
        providerKind: "local_invoice_provider",
        providerInvoiceId: null,
        providerInvoiceNumber: "FV-1001",
        totalGrossMinor: 12900,
        currency: "PLN",
      },
      outbox: {
        status: "failed",
        attemptCount: 3,
        nextAttemptAt: "2026-06-05T11:00:00+00:00",
        lastError: {
          code: "invoice_provider_failed",
          message: "Provider rejected the local invoice snapshot",
          retryable: true,
        },
      },
    },
  };
}
export function chooseOption(fieldLabel: RegExp, optionLabel: string) {
  const trigger = screen.getByRole("combobox", { name: fieldLabel });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(screen.getByRole("option", { name: optionLabel }));
}
export function installRadixSelectDomMocks() {
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
}
function baseOrder() {
  return {
    orderId: "42222222-2222-4222-8222-222222222221",
    orderNumber: "OMS-1001",
    clientId: "32222222-2222-4222-8222-222222222221",
    customer: { id: "32222222-2222-4222-8222-222222222221",
      firstName: "Ala",
      lastName: "Kowalska",
      email: "ala@example.com",
      phone: null,
    },
    pet: {
      id: "82222222-2222-4222-8222-222222222221",
      name: "Figa",
      species: "dog",
      breed: "mix",
    },
    status: "paid",
    mode: "one_time",
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
    activeHoldReasons: [] as Array<"payment_not_succeeded" | "inventory_review" | "risk_review" | "address_review" | "fulfillment_exception" | "manual_support">, fulfillmentHealthDigest: { healthStatus: "ok", attentionReasons: [] as string[] },
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
    communicationDeliveries: [],
    match: undefined as SearchMatch | undefined,
    createdAt: "2026-06-05T10:00:00+00:00",
    updatedAt: "2026-06-05T10:03:00+00:00",
  };
}
