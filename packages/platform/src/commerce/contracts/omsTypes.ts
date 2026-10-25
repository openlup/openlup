import type { PaymentIntentStatus } from "@openlup/core/payment";
import type { OmsPaymentStatus } from "./state.js";
import type { OrderMoneyIssueCode, OrderMoneyHeaderRow, OrderMoneyItemRow, CanonicalOrderMoneyLine, CanonicalOrderMoney, OrderMoneyDiagnostic } from "./orderMoney.js";
export type { OrderMoneyIssueCode, OrderMoneyHeaderRow, OrderMoneyItemRow, CanonicalOrderMoneyLine, CanonicalOrderMoney, OrderMoneyDiagnostic } from "./orderMoney.js";
import type { OmsFulfillmentBlockReason, OmsInventoryStatus } from "./state.js";
export type { OmsFulfillmentBlockReason, OmsInventoryStatus } from "./state.js";
import type { TimedFulfillmentSignal, ReleasedProviderExceptionHold, ProviderStatusEvidence, ResolvedProviderExceptionRecovery } from "./fulfillmentRecovery.js";
export type { TimedFulfillmentSignal, ReleasedProviderExceptionHold, ProviderStatusEvidence, ResolvedProviderExceptionRecovery } from "./fulfillmentRecovery.js";
// Browser-safe OMS DTOs and structural ports. Runtime schemas are tested for type parity.
// Browser-safe OMS DTOs and structural ports. Keep runtime schema parity tests with changes.
type ActionEligibility = {
    allowed: false | true;
    reason: null | string;
};
type OmsPricingSummary = {
    subtotal: CommerceMoney;
    productDiscount: CommerceMoney;
    shipping: CommerceMoney;
    shippingDiscount: CommerceMoney;
    discountTotal: CommerceMoney;
    finalTotal: CommerceMoney;
    source: "order_columns";
};
type OmsCommunicationDelivery = {
    id: string;
    purpose: string;
    templateSlug: string;
    triggerSource: string;
    triggerEvent: string;
    aggregateType: null | string;
    aggregateId: null | string;
    dedupeKey: string;
    status: "failed" | "processing" | "delivered" | "planned" | "skipped" | "blocked" | "queued" | "sent" | "delivery_delayed" | "bounced" | "complained" | "missed" | "legacy_unlinked";
    providerKind: null | string;
    providerMessageId: null | string;
    scheduledDueAt: null | string;
    expectedSendAt: null | string;
    queuedAt: null | string;
    firstAttemptAt: null | string;
    sentAt: null | string;
    deliveredAt: null | string;
    terminalAt: null | string;
    lastErrorCode: null | string;
    outboxEventId: null | string;
    platformJobRunId: null | string;
    emailSendId: null | string;
    metadata: {
        [key: string]: unknown;
    };
    createdAt: string;
    updatedAt: string;
};
type OmsDeliverySelection = {
    deliveryKind: "courier" | "parcel-locker";
    providerKind: null | string;
    carrierKind: null | string;
    carrierCode: null | string;
    serviceCode: null | string;
    pickupPoint: null | {
        id: string;
        name: string;
        address: null | {
            line1: string;
            postalCode: string;
            city: string;
            country: string;
        };
    };
    source: null | string;
};
type OmsDeliveryContact = {
    schemaVersion: 1;
    source: string;
    revision: number;
    recipientName: null | string;
    contactEmail: null | string;
    contactPhone: null | string;
    line1: null | string;
    line2: null | string;
    city: null | string;
    postalCode: null | string;
    country: null | string;
    selectedDelivery: null | {
        [key: string]: unknown;
    };
    deliveryInstructions: null | string;
    courierInstructions: null | string;
};
type OmsDeliveryContactProjection = {
    baseline: null | OmsDeliveryContact;
    effective: null | OmsDeliveryContact;
    scope: "missing" | "baseline" | "order_override" | "parcel" | "legacy_inferred";
    source: null | string;
    revision: null | number;
    digest: null | string;
    frozen: false | true;
    providerSubmissionState: "draft" | "failed" | "cancelled" | "not_started" | "created" | "unknown" | "not_materialized" | "submitting" | "uncertain" | "cancel_requested";
    correctionAllowed: false | true;
};
type OmsCustomerSummary = {
    id: string;
    email: string;
    firstName: null | string;
    lastName: null | string;
    phone: null | string;
    lifecycleStage: null | string;
};
type OmsAddressSummary = {
    id: string;
    label: null | string;
    line1: null | string;
    line2: null | string;
    city: null | string;
    postalCode: null | string;
    country: null | string;
    recipientName: null | string;
    contactPhone: null | string;
    companyName: null | string;
    taxId: null | string;
    deliveryNotes: null | string;
    courierInstructions: null | string;
};
type OmsOrderLine = {
    id: string;
    skuId: null | string;
    sku: null | string;
    title: null | string;
    quantity: number;
    unitPrice: CommerceMoney;
    total: CommerceMoney;
    discountAllocated: CommerceMoney;
    effectiveTotal: CommerceMoney;
    effectiveNet: CommerceMoney;
    vatRateBps: null | number;
    productSnapshot: {
        [key: string]: unknown;
    };
    variantSnapshot: null | {
        [key: string]: unknown;
    };
};
type OmsAccountingSummary = {
    status: string;
    invoiceId: null | string;
    invoiceRef: null | string;
    providerKind: null | string;
    providerInvoiceNumber: null | string;
    outboxStatus: null | string;
    outboxAttemptCount: null | number;
    outboxNextAttemptAt: null | string;
    outboxLastError: null | {
        code: null | string;
        message: null | string;
        retryable: null | false | true;
    };
    recoveryGuidance: "none" | "not_requested" | "wait_for_retry" | "review_and_retry";
    updatedAt: null | string;
    fiscalStatus?: undefined | null | string;
};
type OmsOrderActionEligibility = {
    addNote: ActionEligibility;
    createHold: ActionEligibility;
    releaseHold: ActionEligibility;
    createFulfillment: ActionEligibility;
    updateShippingAddress: ActionEligibility;
    recordLabel: ActionEligibility;
    handOff: ActionEligibility;
    recordTrackingEvent: ActionEligibility;
    cancelFulfillment: ActionEligibility;
    cancelOrder: ActionEligibility;
    markRefunded: ActionEligibility;
};
type OmsOrderSearchMatch = AdminOmsOrderSearchMatch;
type OmsOrderListItem = AdminOmsOrderListItem;
type OmsOrderListSummaryCounts = AdminOmsOrderListSummaryCounts;
type OmsOrderListSummaryTotals = AdminOmsOrderListSummaryTotals;
type OmsOrderOperation = {
    id: string;
    orderId: string;
    type: "hold_created" | "hold_released" | "fulfillment_reviewed" | "support_note" | "shipping_address_updated" | "order_marked_refunded" | "order_cancelled_manual" | "replacement_shipment_requested";
    holdId: null | string;
    actorUserId: null | string;
    occurredAt: string;
    payload: {
        [key: string]: unknown;
    };
};
type OmsPaymentSummary = {
    intentId: null | string;
    paymentId: null | string;
    status: OmsOrderPaymentStatus;
    activeAttemptId: null | string;
    providerPaymentId: null | string;
    updatedAt: null | string;
};
type OmsPaymentAttempt = {
    id: string;
    status: "failed" | "expired" | "cancelled" | "created" | "requires_action" | "processing" | "succeeded" | "blocked_preflight" | "sent_to_provider";
    provider: string;
    providerAttemptId: null | string;
    nextActionKind: null | string;
    updatedAt: string;
};
type OmsPaymentTransition = {
    id: string;
    transitionKind: string;
    fromStatus: null | string;
    toStatus: string;
    reason: string;
    occurredAt: string;
};
type OmsFulfillmentEligibility = {
    allowed: false | true;
    reason: null | "active_hold" | "missing_shipping_address" | "payment_not_succeeded" | "inventory_review" | "risk_review" | "order_not_paid" | "subscription_cycle_not_paid";
};
type AdminCommerceOrderShippingAddressInput = {
    recipientName: string;
    contactEmail: string;
    line1: string;
    city: string;
    postalCode: string;
    country: string;
    contactPhone: string;
    line2?: undefined | null | string;
    deliveryInstructions?: undefined | null | string;
    courierInstructions?: undefined | null | string;
};
type OmsControlPlaneHold = {
    id: string;
    status: "released" | "active";
    reason: "fulfillment_exception" | "payment_not_succeeded" | "inventory_review" | "risk_review" | "address_review" | "manual_support";
    note: null | string;
    createdAt: string;
    releasedAt: null | string;
};
type OmsControlPlaneOperation = {
    id: string;
    action: "hold_created" | "hold_released" | "order_cancelled" | "order_refunded";
    holdId: null | string;
    actorId: null | string;
    occurredAt: string;
};
type OmsProviderOpsSla = {
    status: "ok" | "watch" | "breached" | "paused_non_shipping_day";
    dispatchedAt: null | string;
    deadlineAt: null | string;
    remainingOperationalMinutes: null | number;
};
type OmsFulfillmentTrackingReference = {
    providerKind: string;
    trackingNumber: string;
    trackingUrl: null | string;
    carrierKind: null | string;
    service: null | string;
    updatedAt: null | string;
};
type OmsFulfillmentTimelineEvent = {
    eventType: string;
    label: string;
    occurredAt: null | string;
    source: "webhook" | "reconciliation" | "manual" | "simulator" | "fulfillment" | "dispatch" | "provider";
};
type OmsSubscriptionContext = {
    subscriptionId: null | string;
    subscriptionCycleId: null | string;
    subscriptionCycleStatus: null | "paid" | "cancelled" | "planned" | "payment_pending" | "payment_failed" | "retry_scheduled" | "skipped";
    nextCycleAt: null | string;
    cyclePaidAt: null | string;
};
type OmsInventorySummary = {
    status: OmsInventoryStatus;
    reservationId: null | string;
    reservationStatus: null | "expired" | "reserved" | "released" | "consumed";
    expiresAt: null | string;
    locationId: null | string;
    locationCode: null | string;
};
type OmsFulfillmentSummary = {
    fulfillmentOrderId: null | string;
    status: null | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
    providerKind: null | string;
    latestOperationType: null | string;
    latestOperationAt: null | string;
    providerTrackingId: null | string;
    trackingUrl: null | string;
    carrierKind: null | string;
    service: null | string;
    trackingReferences: Array<OmsFulfillmentTrackingReference>;
    trackingTimeline: Array<OmsFulfillmentTimelineEvent>;
    providerEvidence: Array<OmsProviderEvidence>;
};
type OmsSupersededParcel = {
    fulfillmentOrderId: string;
    sequenceNo: number;
    status: null | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
    replacementReason: null | string;
    handedOverAt: null | string;
    deliveredAt: null | string;
    trackingReferences: Array<OmsFulfillmentTrackingReference>;
};
type OmsFulfillmentDebugStep = {
    key: "fulfillment" | "dispatch" | "provider" | "payment" | "stock" | "provider_stock" | "tracking" | "communication";
    status: "missing" | "ok" | "pending" | "warning" | "blocked";
    label: string;
    value: null | string;
    evidenceAt: null | string;
    details: Array<string>;
};
type OmsFulfillmentHealth = {
    healthStatus: "ok" | "needs_attention" | "blocked_uncertain" | "local_ahead" | "provider_ahead" | "missing_local_commitment";
    attentionReasons: Array<"paid_order_missing_fulfillment" | "paid_order_missing_dispatch_ref" | "dispatch_submission_stale" | "dispatch_outcome_uncertain" | "dispatch_failed" | "dispatch_created_without_provider_order_id" | "dispatch_terminal_without_progress" | "dispatch_status_unknown" | "provider_exception_after_delivery" | "provider_exception_after_handover" | "provider_exception_before_handover" | "local_status_ahead_of_provider" | "provider_accepted_local_label_ack_missing" | "order_paid_outbox_discarded" | "order_paid_outbox_processed_without_fulfillment" | "order_paid_outbox_missing">;
    oldestAgeSeconds: null | number;
    opaqueIds: {
        orderId: string;
        fulfillmentOrderId: null | string;
        outboxEventId: null | string;
        dispatchRefFulfillmentOrderId: null | string;
        latestEvidenceFulfillmentOrderId: null | string;
    };
    dispatchRefId?: undefined | null | string;
    dispatchStatus?: undefined | null | string;
};
type OmsFulfillmentHealthDigest = {
    healthStatus: "ok" | "needs_attention" | "blocked_uncertain" | "local_ahead" | "provider_ahead" | "missing_local_commitment";
    attentionReasons: Array<"paid_order_missing_fulfillment" | "paid_order_missing_dispatch_ref" | "dispatch_submission_stale" | "dispatch_outcome_uncertain" | "dispatch_failed" | "dispatch_created_without_provider_order_id" | "dispatch_terminal_without_progress" | "dispatch_status_unknown" | "provider_exception_after_delivery" | "provider_exception_after_handover" | "provider_exception_before_handover" | "local_status_ahead_of_provider" | "provider_accepted_local_label_ack_missing" | "order_paid_outbox_discarded" | "order_paid_outbox_processed_without_fulfillment" | "order_paid_outbox_missing">;
};
type CommerceMoney = {
    amountMinor: number;
    currency: string;
};
type OmsProviderEvidence = {
    evidenceType: "dispatch_ref" | "provider_attempt" | "status_evidence";
    status: null | string;
    providerStatus: null | string;
    providerOrderId: null | string;
    evidenceKind: null | string;
    occurredAt: null | string;
    updatedAt: null | string;
    summary: null | string;
};
export type QueueSelection = {
    orderIds: Array<string>;
    totalCount: number;
    matches: {
        [key: string]: AdminOmsOrderSearchMatch;
    };
    summaryCounts: AdminOmsOrderListSummaryCounts;
    summaryTotals: AdminOmsOrderListSummaryTotals;
};
export type OmsManagedReadProjections = {
    queueMatchSchema?: { safeParse(input: unknown): { success: true; data: AdminOmsOrderSearchMatch } | { success: false } };
    model?: undefined | OmsReadModelProjections;
    orderColumns?: undefined | string;
    invoiceColumns?: undefined | string;
    mapInvoice?: undefined | ((value: unknown) => OmsAccountingInvoiceRow);
    projectQueue?: undefined | ((data: unknown) => unknown);
    readIdentity?: undefined | ((store: CommerceOmsStore, orders: Array<OmsOrderRow>, view: "list" | "detail") => Promise<{
        [key: string]: {
            [key: string]: unknown;
        };
    }>);
    readFulfillmentOperations?: undefined | ((store: CommerceOmsStore, ids: Array<string>) => Promise<Array<OmsFulfillmentOperationRow>>);
    readProviderDispatchRefs?: undefined | ((store: CommerceOmsStore, ids: Array<string>) => Promise<Array<OmsProviderDispatchRefRow>>);
    readProviderStatusEvidence?: undefined | ((store: CommerceOmsStore, ids: Array<string>) => Promise<Array<OmsProviderStatusEvidenceRow>>);
    readProviderAttempts?: undefined | ((store: CommerceOmsStore, ids: Array<string>) => Promise<Array<OmsProviderAttemptRow>>);
    readReleasedProviderExceptionHolds?: undefined | ((store: CommerceOmsStore, ids: Array<string>) => Promise<Array<OmsReleasedProviderExceptionHoldRow>>);
    readProviderStockCurrent?: undefined | ((store: CommerceOmsStore, items: Array<OmsOrderItemRow>) => Promise<Array<OmsFulfillmentProviderStockCurrentRow>>);
    readInboundEvents?: undefined | ((store: CommerceOmsStore, input: {
        order: OmsOrderRow;
        dispatchRefs: Array<OmsProviderDispatchRefRow>;
    }) => Promise<Array<OmsInboundProviderEventRow>>);
    buildHealth?: undefined | ((input: {
        order: OmsOrderRow;
        paymentStatus: string;
        fulfillmentOrders: Array<OmsFulfillmentOrderRow>;
        dispatchRefs: Array<OmsProviderDispatchRefRow>;
        statusEvidence: Array<OmsProviderStatusEvidenceRow>;
        orderPaidOutboxEvents: Array<unknown>;
    }) => OmsFulfillmentHealth);
    buildHealthDigests?: undefined | ((input: {
        orders: Array<OmsOrderRow>;
        paymentIntents: Array<OmsPaymentIntentRow>;
        fulfillmentOrders: Array<OmsFulfillmentOrderRow>;
        dispatchRefs: Array<OmsProviderDispatchRefRow>;
        statusEvidence: Array<OmsProviderStatusEvidenceRow>;
    }) => {
        [key: string]: OmsFulfillmentHealthDigest;
    });
};
export type CommerceOmsRpcClient = {
    rpc: (functionName: string, args: {
        [key: string]: unknown;
    }) => PromiseLike<{
        data: unknown;
        error: null | RpcError;
    }>;
};
export type CommerceOmsStore = {
    query: (table: string) => ManagedQueryBuilder;
    rpc: (functionName: string, args: {
        [key: string]: unknown;
    }) => PromiseLike<{
        data: unknown;
        error: null | RpcError;
    }>;
};
export interface ManagedQueryBuilder extends PromiseLike<ManagedQueryResult> {
  select(columns: string, options?: Record<string, unknown>): ManagedQueryBuilder;
  order(column: string, options?: Record<string, unknown>): ManagedQueryBuilder;
  eq(column: string, value: unknown): ManagedQueryBuilder;
  is(column: string, value: unknown): ManagedQueryBuilder;
  in(column: string, values: unknown[]): ManagedQueryBuilder;
  gte(column: string, value: unknown): ManagedQueryBuilder;
  lte(column: string, value: unknown): ManagedQueryBuilder;
  ilike(column: string, value: string): ManagedQueryBuilder;
  insert(values: Record<string, unknown> | Array<Record<string, unknown>>): ManagedQueryBuilder;
  update(values: Record<string, unknown>): ManagedQueryBuilder;
  range(from: number, to: number): PromiseLike<ManagedQueryResult>;
  maybeSingle(): PromiseLike<ManagedQueryResult>;
}

export type ManagedQueryResult = {
    data: unknown;
    error: null | RpcError;
    count?: undefined | null | number;
};
export type RpcError = {
    code?: undefined | string;
    message?: undefined | string;
    details?: undefined | string;
    hint?: undefined | string;
};
export type OmsAccountingRecoveryGuidance = "none" | "not_requested" | "wait_for_retry" | "review_and_retry";
export type OmsCurrencyPolicy = {
    defaultCurrency: string;
    accepts: (currency: string) => false | true;
};
export type OmsInboundProviderEventRow = {
    id: string;
    provider: string;
    provider_event_id: string;
    event_type: string;
    processing_status: string;
    payload?: unknown;
    error?: unknown;
    created_at: string;
    processed_at?: undefined | null | string;
};
export type OmsFulfillmentProviderStockCurrentRow = {
    provider_kind: string;
    sku: string;
    provider_for_sale_quantity: number;
    provider_total_quantity: number;
    last_synced_at: string;
    stale_after: string;
};
export type OmsFulfillmentOrderRow = {
    id: string;
    order_id: string;
    status: null | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
    provider_kind?: undefined | null | string;
    handed_over_at?: undefined | null | string;
    delivered_at?: undefined | null | string;
    created_at?: undefined | null | string;
    updated_at?: undefined | null | string;
    sequence_no?: undefined | null | number;
    replaces_fulfillment_order_id?: undefined | null | string;
    replacement_reason?: undefined | null | string;
    shipping_address_snapshot?: undefined | null | {
        [key: string]: unknown;
    };
};
export type OmsFulfillmentOperationRow = {
    fulfillment_order_id: string;
    operation_type: string;
    occurred_at: string;
};
export type OmsProviderAttemptRow = {
    fulfillment_order_id: string;
    provider_kind?: undefined | null | string;
    status?: undefined | null | string;
    provider_tracking_id?: undefined | null | string;
    error?: unknown;
    created_at?: undefined | null | string;
};
export type OmsProviderDispatchRefRow = {
    id?: undefined | null | string;
    fulfillment_order_id: string;
    provider_order_id?: undefined | null | string;
    dispatch_mode?: undefined | null | string;
    status?: undefined | null | string;
    error?: unknown;
    created_at?: undefined | null | string;
    updated_at?: undefined | null | string;
};
export type OmsProviderStatusEvidenceRow = {
    id?: undefined | null | string;
    fulfillment_order_id: string;
    provider_status?: undefined | null | string;
    provider_sub_status?: undefined | null | string;
    local_status?: undefined | null | string;
    customer_status?: undefined | null | string;
    evidence_kind?: undefined | null | string;
    occurred_at?: undefined | null | string;
    created_at?: undefined | null | string;
};
export type OmsReleasedProviderExceptionHoldRow = {
    order_id: string;
    status?: undefined | null | string;
    reason?: undefined | null | string;
    created_by?: undefined | null | string;
    released_by?: undefined | null | string;
    metadata?: unknown;
};
export type OmsShipmentExternalRefRow = {
    order_id: string;
    fulfillment_order_id?: undefined | null | string;
    provider_tracking_id: string;
    active: false | true;
    provider_kind?: undefined | null | string;
    tracking_url?: undefined | null | string;
    carrier_kind?: undefined | null | string;
    service?: undefined | null | string;
    updated_at?: undefined | null | string;
    created_at?: undefined | null | string;
};
export type OmsOperationalLadderInput = {
    orderStatus: "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
    activeHoldCount: number;
    paymentStatus: OmsOrderPaymentStatus;
    hasShippingAddress: false | true;
    inventoryStatus: OmsInventoryStatus;
    fulfillmentStatus: null | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
    fulfillmentAllowed: false | true;
    accountingStatus: string;
};
export type OmsOperationalRung = {
    readonly id: string;
    readonly sqlPredicate: string;
    readonly attentionReason: AdminOmsAttentionReason;
    readonly nextAction: AdminOmsNextAction;
    readonly matches: (input: OmsOperationalLadderInput) => false | true;
};
export type OmsPaymentMethodSummary = {
    provider: null | string;
    label: null | string;
};
export type OmsOrderIdentity = ({
    customer: null | OmsCustomerSummary;
}) & ({
    [key: string]: unknown;
});
export type OmsActionAvailabilityFlags = {
    holdMutationsEnabled?: undefined | false | true;
    supportMutationsEnabled?: undefined | false | true;
    fulfillmentMutationsEnabled?: undefined | false | true;
    refundMutationsEnabled?: undefined | false | true;
    orderCancellationEnabled?: undefined | false | true;
};
export type OmsReadModelProjections = {
    currency?: undefined | OmsCurrencyPolicy;
    detailFields?: undefined | ((input: {
        order: OmsOrderRow;
        orderItems?: undefined | Array<OmsOrderItemRow>;
        orderMoney: CanonicalOrderMoney;
    }) => {
        [key: string]: unknown;
    });
    providerOps?: undefined | ((input: {
        fulfillmentOrders: Array<OmsFulfillmentOrderRow>;
        dispatchRefs?: undefined | Array<OmsProviderDispatchRefRow>;
        statusEvidence?: undefined | Array<OmsProviderStatusEvidenceRow>;
    }) => {
        status: string;
        sla: null | OmsProviderOpsSla;
        providerOrderId: null | string;
    });
    paymentMethodLabel?: undefined | ((attempt: OmsPaymentAttemptRow) => string);
    usesExternalStock?: undefined | ((providerKind: null | string) => false | true);
    timelineLabel?: undefined | ((step: null | "paid" | "cancelled" | "delivered" | "exception" | "accepted" | "packing" | "transit") => string);
    dispatchLabel?: undefined | ((status: undefined | null | string) => string);
    debugSummary?: undefined | ((action: "review_payment" | "create_fulfillment" | "wait" | "retry_dispatch" | "reconcile" | "review_stock" | "review_provider" | "contact_support") => string);
    dispatchStepLabel?: undefined | string;
    automaticExceptionHoldSource?: undefined | string;
    automaticExceptionReleaseSource?: undefined | string;
    additionalAccountingStatuses?: undefined | Array<string>;
    dispatchedNotPickedStatus?: undefined | string;
    parseList?: undefined | ((value: unknown) => AdminCommerceOrdersListResponse);
    parseDetail?: undefined | ((value: unknown) => AdminCommerceOrderDetailResponse);
};
export type OmsOrderRow = {
    id: string;
    order_number: null | string;
    client_id: null | string;
    status: "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
    mode: "one_time" | "subscription_cycle";
    currency: string;
    subtotal_cents: null | number;
    discount_cents: null | number;
    shipping_cents: null | number;
    shipping_discount_cents: null | number;
    tax_cents: null | number;
    total_cents: number;
    metadata: null | {
        [key: string]: unknown;
    };
    created_at: string;
    updated_at: string;
    subscription_id: null | string;
    subscription_cycle_id: null | string;
    shipping_address_id?: undefined | null | string;
    source_kind?: undefined | null | string;
    source_order_ref?: undefined | null | string;
    sales_channels?: undefined | null | {
        slug?: undefined | null | string;
    };
};
export type OmsPaymentIntentRow = {
    id: string;
    order_id: string;
    payment_id: string;
    status: "failed" | "expired" | "cancelled" | "refunded" | "created" | "requires_action" | "processing" | "succeeded" | "partially_refunded" | "disputed";
    active_attempt_id: null | string;
    provider_payment_id: null | string;
    updated_at: string;
};
export type OmsPaymentAttemptRow = {
    id: string;
    payment_intent_id?: undefined | null | string;
    status: "failed" | "expired" | "cancelled" | "created" | "requires_action" | "processing" | "succeeded" | "blocked_preflight" | "sent_to_provider";
    provider: string;
    provider_attempt_id: null | string;
    next_action_kind: null | string;
    updated_at: string;
};
export type OmsHoldRow = {
    id: string;
    order_id: string;
    status: "released" | "active";
    reason: "fulfillment_exception" | "payment_not_succeeded" | "inventory_review" | "risk_review" | "address_review" | "manual_support";
    note: null | string;
    created_at: string;
    released_at: null | string;
};
export type OmsOperationRow = {
    id: string;
    order_id: string;
    operation_type: "hold_created" | "hold_released" | "fulfillment_reviewed" | "support_note" | "shipping_address_updated" | "order_marked_refunded" | "order_cancelled_manual" | "replacement_shipment_requested";
    hold_id: null | string;
    actor_user_id: null | string;
    occurred_at: string;
    payload: {
        [key: string]: unknown;
    };
};
export type OmsPaymentTransitionRow = {
    id: string;
    transition_kind: string;
    from_status: null | string;
    to_status: string;
    reason: string;
    occurred_at: string;
};
export type OmsInventoryReservationRow = {
    id: string;
    order_id: string;
    order_item_id: null | string;
    quantity: number;
    status: "expired" | "reserved" | "released" | "consumed";
    expires_at: null | string;
    location_id: null | string;
    inventory_locations?: undefined | null | {
        code?: undefined | null | string;
    };
};
export type OmsOrderItemRow = {
    id: string;
    order_id?: undefined | string;
    sku_id?: undefined | null | string;
    sku?: undefined | null | string;
    title?: undefined | null | string;
    quantity: number;
    unit_price_cents?: undefined | null | number;
    total_cents?: undefined | null | number;
    discount_allocated_cents?: undefined | null | number;
    effective_total_cents?: undefined | null | number;
    effective_net_cents?: undefined | null | number;
    vat_rate_bps?: undefined | null | number;
    product_snapshot?: undefined | null | {
        [key: string]: unknown;
    };
    variant_snapshot?: undefined | null | {
        [key: string]: unknown;
    };
};
export type OmsCustomerRow = {
    id: string;
    email: string;
    first_name: null | string;
    last_name: null | string;
    phone: null | string;
    lifecycle_stage: null | string;
};
export type OmsAddressRow = {
    id: string;
    label?: undefined | null | string;
    line1?: undefined | null | string;
    line2?: undefined | null | string;
    city?: undefined | null | string;
    postal_code?: undefined | null | string;
    country?: undefined | null | string;
    recipient_name?: undefined | null | string;
    contact_phone?: undefined | null | string;
    company_name?: undefined | null | string;
    tax_id?: undefined | null | string;
    delivery_notes?: undefined | null | string;
    courier_instructions?: undefined | null | string;
};
export type OmsAccountingInvoiceRow = {
    id: string;
    order_id: string;
    invoice_ref: string;
    status: string;
    provider_kind: null | string;
    provider_invoice_number: null | string;
    fiscal_status?: undefined | null | string;
    total_gross_cents: number;
    currency: string;
    blocked_reason?: undefined | null | string;
    updated_at: string;
};
export type OmsAccountingOutboxRow = {
    invoice_id: string;
    status: string;
    attempt_count?: undefined | null | number;
    next_attempt_at?: undefined | null | string;
    last_error?: unknown;
    created_at?: undefined | null | string;
};
export type OmsCommunicationDeliveryRow = {
    id: string;
    purpose: string;
    template_slug: string;
    trigger_source: string;
    trigger_event: string;
    aggregate_type: null | string;
    aggregate_id: null | string;
    dedupe_key: string;
    status: "failed" | "processing" | "delivered" | "planned" | "skipped" | "blocked" | "queued" | "sent" | "delivery_delayed" | "bounced" | "complained" | "missed" | "legacy_unlinked";
    provider_kind: null | string;
    provider_message_id: null | string;
    scheduled_due_at: null | string;
    expected_send_at: null | string;
    queued_at: null | string;
    first_attempt_at: null | string;
    sent_at: null | string;
    delivered_at: null | string;
    terminal_at: null | string;
    last_error_code: null | string;
    outbox_event_id: null | string;
    platform_job_run_id: null | string;
    email_send_id: null | string;
    metadata: null | {
        [key: string]: unknown;
    };
    created_at: string;
    updated_at: string;
};
export type OmsOrderRowCoreInput = {
    projections?: undefined | OmsReadModelProjections;
    order: OmsOrderRow;
    activeHoldCount: number;
    paymentIntents: Array<OmsPaymentIntentRow>;
    paymentAttempts: Array<OmsPaymentAttemptRow>;
    identity: OmsOrderIdentity;
    orderItems?: undefined | Array<OmsOrderItemRow>;
    inventoryReservations: Array<OmsInventoryReservationRow>;
    fulfillmentOrders: Array<OmsFulfillmentOrderRow>;
    fulfillmentOperations: Array<OmsFulfillmentOperationRow>;
    shipmentExternalRefs: Array<OmsShipmentExternalRefRow>;
    providerAttempts?: undefined | Array<OmsProviderAttemptRow>;
    dispatchRefs?: undefined | Array<OmsProviderDispatchRefRow>;
    statusEvidence?: undefined | Array<OmsProviderStatusEvidenceRow>;
    releasedProviderExceptionHolds?: undefined | Array<OmsReleasedProviderExceptionHoldRow>;
    accountingInvoice: null | OmsAccountingInvoiceRow;
    accountingOutbox: Array<OmsAccountingOutboxRow>;
    subscriptionCycleStatus: null | "paid" | "cancelled" | "planned" | "payment_pending" | "payment_failed" | "retry_scheduled" | "skipped";
    orderMoney?: undefined | CanonicalOrderMoney;
};
export type OmsOrderRowCore = {
    row: {
        status: "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
        mode: "one_time" | "subscription_cycle";
        sourceKind: undefined | string;
        sourceChannelSlug: undefined | string;
        sourceOrderRef: undefined | string;
        paymentMethodLabel: null | string;
        paymentProvider: null | string;
        paymentStatus: OmsOrderPaymentStatus;
        fulfillmentStatus: null | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
        customerFulfillmentStep: "paid" | "cancelled" | "delivered" | "exception" | "accepted" | "packing" | "transit";
        inventoryStatus: OmsInventoryStatus;
        accountingStatus: string;
        providerOpsStatus: string;
        providerOpsSla: null | OmsProviderOpsSla;
        providerOrderId: null | string;
        attentionReason: AdminOmsAttentionReason;
        nextAction: AdminOmsNextAction;
        activeHoldCount: number;
        total: CommerceMoney;
        pricingSummary: OmsPricingSummary;
        createdAt: string;
        updatedAt: string;
        customer: null | OmsCustomerSummary;
        orderId: string;
        orderNumber: null | string;
        clientId: null | string;
    };
    paymentStatus: OmsOrderPaymentStatus;
    inventory: OmsInventorySummary;
    fulfillment: OmsFulfillmentSummary;
    accounting: OmsAccountingSummary;
    fulfillmentEligibility: {
        allowed: false | true;
        reason: null | "active_hold" | "missing_shipping_address" | "payment_not_succeeded" | "inventory_review" | "risk_review" | "order_not_paid" | "subscription_cycle_not_paid";
    };
};
export type AdminCommerceOrderPaymentLinkRefusal = "order_not_found" | "order_paid" | "order_cancelled" | "order_not_recoverable" | "order_changed";
export type AdminCommerceOrdersListRequest = {
    page: number;
    pageSize: number;
    sort: "created_desc" | "created_asc" | "updated_desc" | "updated_asc" | "attention_priority_desc";
    search?: undefined | string;
    status?: undefined | "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
    mode?: undefined | "one_time" | "subscription_cycle";
    paymentStatus?: undefined | "failed" | "expired" | "cancelled" | "refunded" | "not_started" | "created" | "requires_action" | "processing" | "succeeded" | "partially_refunded" | "disputed";
    fulfillmentStatus?: undefined | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
    inventoryStatus?: undefined | "expired" | "not_checked" | "reserved" | "missing" | "released" | "consumed" | "review_required";
    accountingStatus?: undefined | string;
    providerOpsStatus?: undefined | string;
    attentionReason?: undefined | "none" | "fulfillment_pending" | "payment_required" | "active_hold" | "missing_shipping_address" | "inventory_missing" | "fulfillment_blocked" | "fulfillment_exception" | "invoice_missing" | "invoice_issue_failed" | "invoice_buyer_data_invalid";
    attentionOnly?: undefined | false | true;
    nextAction?: undefined | "none" | "review_payment" | "release_hold" | "review_address" | "review_inventory" | "review_fulfillment" | "create_fulfillment" | "record_label" | "hand_off" | "review_tracking" | "review_invoice";
    from?: undefined | string;
    to?: undefined | string;
    includeWithdrawn?: undefined | false | true;
};
export type AdminCommerceOrdersListRequestInput = {
    page?: unknown;
    pageSize?: unknown;
    search?: undefined | string;
    status?: undefined | "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
    mode?: undefined | "one_time" | "subscription_cycle";
    paymentStatus?: undefined | "failed" | "expired" | "cancelled" | "refunded" | "not_started" | "created" | "requires_action" | "processing" | "succeeded" | "partially_refunded" | "disputed";
    fulfillmentStatus?: undefined | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
    inventoryStatus?: undefined | "expired" | "not_checked" | "reserved" | "missing" | "released" | "consumed" | "review_required";
    accountingStatus?: undefined | string;
    providerOpsStatus?: undefined | string;
    attentionReason?: undefined | "none" | "fulfillment_pending" | "payment_required" | "active_hold" | "missing_shipping_address" | "inventory_missing" | "fulfillment_blocked" | "fulfillment_exception" | "invoice_missing" | "invoice_issue_failed" | "invoice_buyer_data_invalid";
    attentionOnly?: undefined | false | true | "true" | "false";
    nextAction?: undefined | "none" | "review_payment" | "release_hold" | "review_address" | "review_inventory" | "review_fulfillment" | "create_fulfillment" | "record_label" | "hand_off" | "review_tracking" | "review_invoice";
    from?: undefined | string;
    to?: undefined | string;
    sort?: undefined | "created_desc" | "created_asc" | "updated_desc" | "updated_asc" | "attention_priority_desc";
    includeWithdrawn?: undefined | false | true | "true" | "false";
};
export type AdminCommerceOrderDetailRequest = {
    orderId: string;
};
export type AdminCommerceOrderHoldRequest = {
    idempotencyKey: string;
    orderId: string;
    reason: "fulfillment_exception" | "payment_not_succeeded" | "inventory_review" | "risk_review" | "address_review" | "manual_support";
    note?: undefined | string;
    metadata?: undefined | {
        [key: string]: unknown;
    };
};
export type AdminCommerceOrderReleaseHoldRequest = {
    idempotencyKey: string;
    holdId: string;
    note?: undefined | string;
    metadata?: undefined | {
        [key: string]: unknown;
    };
};
export type AdminCommerceOrderNoteRequest = {
    idempotencyKey: string;
    orderId: string;
    note: string;
    metadata?: undefined | {
        [key: string]: unknown;
    };
};
export type AdminCommerceOrderMarkRefundedRequest = {
    idempotencyKey: string;
    orderId: string;
    reason: string;
    metadata?: undefined | {
        [key: string]: unknown;
    };
};
export type AdminCommerceOrderCancelRequest = {
    idempotencyKey: string;
    orderId: string;
    reason: string;
    metadata?: undefined | {
        [key: string]: unknown;
    };
};
export type AdminCommerceOrderPaymentLinkRequest = {
    orderId: string;
    delivery?: undefined | "email" | "copy";
};
export type AdminCommerceOrderRequestReplacementShipmentRequest = {
    idempotencyKey: string;
    orderId: string;
    reason: "damaged" | "lost" | "returned_undelivered" | "other";
    metadata?: undefined | {
        [key: string]: unknown;
    };
};
export type AdminCommerceOrderUpdateShippingAddressRequest = {
    idempotencyKey: string;
    orderId: string;
    expectedRevision: number;
    expectedContactDigest: string;
    address: AdminCommerceOrderShippingAddressInput;
    metadata?: undefined | {
        [key: string]: unknown;
    };
};
export type AdminCommerceOrdersListResponse = {
    contractVersion: "commerce.v0";
    orders: Array<AdminOmsOrderListItem>;
    summaryCounts: AdminOmsOrderListSummaryCounts;
    summaryTotals: AdminOmsOrderListSummaryTotals;
    totalCount: number;
    page: number;
    pageSize: number;
};
export type AdminCommerceOrderDetailResponse = {
    contractVersion: "commerce.v0";
    order: OmsOrderDetail;
};
export type AdminCommerceOrderHoldResponse = {
    contractVersion: "commerce.v0";
    hold: OmsOrderHold;
    operationId: string;
    replayed: false | true;
};
export type AdminCommerceOrderNoteResponse = {
    contractVersion: "commerce.v0";
    operation: OmsOrderOperation;
    replayed: false | true;
};
export type AdminCommerceOrderMarkRefundedResponse = {
    contractVersion: "commerce.v0";
    orderId: string;
    status: "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
    replayed: false | true;
};
export type AdminCommerceOrderPaymentLinkResponse = {
    token: string;
    expiresAt: string;
    orderRef: string;
    emailQueued: false | true;
};
export type AdminCommerceOrderRequestReplacementShipmentResponse = {
    contractVersion: "commerce.v0";
    operation: OmsOrderOperation;
    replacement: {
        fulfillmentOrderId: string;
        orderId: string;
        sequenceNo: number;
        replacesFulfillmentOrderId: string;
        reason: "damaged" | "lost" | "returned_undelivered" | "other";
        status: string;
    };
    releasedHoldIds: Array<string>;
    replayed: false | true;
};
export type AdminCommerceOrderUpdateShippingAddressResponse = {
    contractVersion: "commerce.v0";
    result: "replayed" | "applied";
    scope: "parcel" | "order";
    deliveryContact: OmsDeliveryContact;
    operation: OmsOrderOperation;
    address: {
        recipientName: null | string;
        contactEmail: null | string;
        contactPhone: null | string;
        line1: null | string;
        line2: null | string;
        city: null | string;
        postalCode: null | string;
        country: null | string;
    };
    replayed: false | true;
};
export type AdminOmsOrderListItem = {
    orderId: string;
    orderNumber: null | string;
    clientId: null | string;
    customer: null | OmsCustomerSummary;
    status: "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
    mode: "one_time" | "subscription_cycle";
    paymentMethodLabel: null | string;
    paymentProvider: null | string;
    paymentStatus: OmsOrderPaymentStatus;
    fulfillmentStatus: null | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
    customerFulfillmentStep: "paid" | "cancelled" | "delivered" | "exception" | "accepted" | "packing" | "transit";
    inventoryStatus: OmsInventoryStatus;
    accountingStatus: string;
    providerOpsStatus: string;
    providerOpsSla: null | OmsProviderOpsSla;
    providerOrderId: null | string;
    attentionReason: AdminOmsAttentionReason;
    nextAction: AdminOmsNextAction;
    activeHoldCount: number;
    activeHoldReasons: Array<"fulfillment_exception" | "payment_not_succeeded" | "inventory_review" | "risk_review" | "address_review" | "manual_support">;
    fulfillmentHealthDigest: OmsFulfillmentHealthDigest;
    total: CommerceMoney;
    pricingSummary: OmsPricingSummary;
    createdAt: string;
    updatedAt: string;
    sourceKind?: undefined | string;
    sourceChannelSlug?: undefined | string;
    sourceOrderRef?: undefined | string;
    match?: undefined | AdminOmsOrderSearchMatch;
};
export type AdminOmsOrderSearchMatch = {
    field: string;
    label: string;
    valuePreview: null | string;
};
export type AdminOmsOrderListSummaryCounts = {
    needsAttention: number;
    activeHold: number;
    readyForFulfillment: number;
    paymentIssues: number;
    inventoryRisk: number;
    fulfillmentBlocked: number;
    fulfillmentExceptions: number;
    invoiceIssues: number;
    providerDispatchedNotPicked?: undefined | number;
};
export type AdminOmsOrderListSummaryTotals = {
    gmv: CommerceMoney;
    aov: CommerceMoney;
    orderCount: number;
    paidSubscriptionCycleCount: number;
};
export type AdminOmsAttentionReason = "none" | "fulfillment_pending" | "payment_required" | "active_hold" | "missing_shipping_address" | "inventory_missing" | "fulfillment_blocked" | "fulfillment_exception" | "invoice_missing" | "invoice_issue_failed" | "invoice_buyer_data_invalid";
export type AdminOmsNextAction = "none" | "review_payment" | "release_hold" | "review_address" | "review_inventory" | "review_fulfillment" | "create_fulfillment" | "record_label" | "hand_off" | "review_tracking" | "review_invoice";
export type OmsOrderDetail = {
    orderId: string;
    orderNumber: null | string;
    clientId: null | string;
    customer: null | OmsCustomerSummary;
    status: "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
    mode: "one_time" | "subscription_cycle";
    paymentMethodLabel: null | string;
    paymentProvider: null | string;
    paymentStatus: OmsOrderPaymentStatus;
    fulfillmentStatus: null | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
    customerFulfillmentStep: "paid" | "cancelled" | "delivered" | "exception" | "accepted" | "packing" | "transit";
    inventoryStatus: OmsInventoryStatus;
    accountingStatus: string;
    providerOpsStatus: string;
    providerOpsSla: null | OmsProviderOpsSla;
    providerOrderId: null | string;
    attentionReason: AdminOmsAttentionReason;
    nextAction: AdminOmsNextAction;
    activeHoldCount: number;
    activeHoldReasons: Array<"fulfillment_exception" | "payment_not_succeeded" | "inventory_review" | "risk_review" | "address_review" | "manual_support">;
    fulfillmentHealthDigest: OmsFulfillmentHealthDigest;
    total: CommerceMoney;
    pricingSummary: OmsPricingSummary;
    createdAt: string;
    updatedAt: string;
    shippingAddress: null | OmsAddressSummary;
    billingAddress: null | OmsAddressSummary;
    deliverySelection: null | OmsDeliverySelection;
    lines: Array<OmsOrderLine>;
    subscription: OmsSubscriptionContext;
    fulfillmentEligibility: OmsFulfillmentEligibility;
    inventory: OmsInventorySummary;
    fulfillment: OmsFulfillmentSummary;
    replacementChain: OmsReplacementChain;
    fulfillmentHealth: OmsFulfillmentHealth;
    fulfillmentDebug: OmsFulfillmentDebug;
    accounting: OmsAccountingSummary;
    actionEligibility: OmsOrderActionEligibility;
    holds: Array<OmsOrderHold>;
    operations: Array<OmsOrderOperation>;
    payment: OmsPaymentSummary;
    paymentAttempts: Array<OmsPaymentAttempt>;
    paymentTransitions: Array<OmsPaymentTransition>;
    communicationDeliveries: Array<OmsCommunicationDelivery>;
    sourceKind?: undefined | string;
    sourceChannelSlug?: undefined | string;
    sourceOrderRef?: undefined | string;
    match?: undefined | AdminOmsOrderSearchMatch;
    deliveryContact?: undefined | OmsDeliveryContactProjection;
};
export type OmsDeliveryContactResolution = {
    resolutionVersion: 1;
    scope: "missing" | "baseline" | "order_override" | "parcel" | "legacy_inferred";
    baseline: null | OmsDeliveryContact;
    contact: null | OmsDeliveryContact;
    contactDigest: null | string;
};
export type OmsOrderHold = {
    id: string;
    orderId: string;
    status: "released" | "active";
    reason: "fulfillment_exception" | "payment_not_succeeded" | "inventory_review" | "risk_review" | "address_review" | "manual_support";
    note: null | string;
    createdAt: string;
    releasedAt: null | string;
};
export type OmsOrderPaymentStatus = OmsPaymentStatus<PaymentIntentStatus>;
export type OmsAccountingStatus = string;
export type AdminOmsProviderOpsStatus = string;
export type OmsControlPlaneListRequest = {
    view: "control_plane_v1";
    page: number;
    pageSize: number;
    status?: undefined | "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
};
export type OmsControlPlaneDetailRequest = {
    view: "control_plane_v1";
    orderId: string;
};
export type OmsControlPlaneOrder = {
    orderId: string;
    status: "draft" | "pending_payment" | "paid" | "failed" | "expired" | "fulfillment_pending" | "cancelled" | "fulfilled" | "refunded";
    sourceKind: string;
    sourceOrderRef: null | string;
    money: null | {
        amountMinor: number;
        currency: string;
    };
    shipmentStatus: null | "cancelled" | "created" | "packed" | "label_pending" | "label_created" | "handed_over" | "in_transit" | "delivered" | "exception";
    activeHoldCount: number;
    activeHoldReasons: Array<"fulfillment_exception" | "payment_not_succeeded" | "inventory_review" | "risk_review" | "address_review" | "manual_support">;
    actions: {
        createHold: ActionEligibility;
        releaseHold: ActionEligibility;
        cancelOrder: ActionEligibility;
        markRefunded: ActionEligibility;
    };
    createdAt: string;
    updatedAt: string;
};
export type OmsControlPlaneListResponse = {
    contractVersion: "commerce.oms_control_plane.v1";
    orders: Array<OmsControlPlaneOrder>;
    totalCount: number;
    page: number;
    pageSize: number;
};
export type OmsControlPlaneDetailResponse = {
    contractVersion: "commerce.oms_control_plane.v1";
    order: OmsControlPlaneOrder;
    holds: Array<OmsControlPlaneHold>;
    operations: Array<OmsControlPlaneOperation>;
};
export type CommerceOmsControlPlanePort = {
    listOrders: (request: OmsControlPlaneListRequest) => Promise<OmsControlPlaneListResponse>;
    getOrderDetail: (request: OmsControlPlaneDetailRequest) => Promise<null | OmsControlPlaneDetailResponse>;
};
export type CommerceOmsOperatorResolver = {
    resolveOperator: (principalId: string) => Promise<null | string>;
};
export type OmsReplacementChain = {
    sequenceNo: number;
    replacesFulfillmentOrderId: null | string;
    replacementReason: null | string;
    supersededParcels: Array<OmsSupersededParcel>;
};
export type OmsFulfillmentDebug = {
    summary: string;
    severity: "ok" | "watch" | "action_required";
    nextAction: "review_payment" | "create_fulfillment" | "wait" | "retry_dispatch" | "reconcile" | "review_stock" | "review_provider" | "contact_support";
    blockers: Array<string>;
    steps: Array<OmsFulfillmentDebugStep>;
};
export type CommerceOmsReadPort = {
    listOrders: (request: AdminCommerceOrdersListRequest) => Promise<AdminCommerceOrdersListResponse>;
    getOrderDetail: (request: AdminCommerceOrderDetailRequest) => Promise<null | AdminCommerceOrderDetailResponse>;
};
export type CommerceOmsHoldPort = {
    createHold: (request: (AdminCommerceOrderHoldRequest) & ({
        actorUserId: string;
    })) => Promise<AdminCommerceOrderHoldResponse>;
    releaseHold: (request: (AdminCommerceOrderReleaseHoldRequest) & ({
        actorUserId: string;
    })) => Promise<AdminCommerceOrderHoldResponse>;
    addNote: (request: (AdminCommerceOrderNoteRequest) & ({
        actorUserId: string;
    })) => Promise<AdminCommerceOrderNoteResponse>;
    updateShippingAddress: (request: (AdminCommerceOrderUpdateShippingAddressRequest) & ({
        actorUserId: string;
    })) => Promise<AdminCommerceOrderUpdateShippingAddressResponse>;
    markRefunded: (request: (AdminCommerceOrderMarkRefundedRequest) & ({
        actorUserId: string;
    })) => Promise<AdminCommerceOrderMarkRefundedResponse>;
    cancelOrder: (request: (AdminCommerceOrderCancelRequest) & ({
        actorUserId: string;
    })) => Promise<AdminCommerceOrderMarkRefundedResponse>;
    requestReplacementShipment: (request: (AdminCommerceOrderRequestReplacementShipmentRequest) & ({
        actorUserId: string;
    })) => Promise<AdminCommerceOrderRequestReplacementShipmentResponse>;
};
export type OmsReplacementRefusal = "missing_shipping_address" | "payment_not_succeeded" | "subscription_cycle_not_paid" | "order_not_found" | "invalid_input" | "idempotency_conflict" | "order_not_replaceable" | "missing_client" | "shipping_address_not_found" | "no_parcel_to_replace" | "undispatched_replacement_exists" | "missing_order_items" | "missing_catalog_sku" | "missing_inventory_reservation" | "blocked_by_payment_not_succeeded_hold" | "blocked_by_inventory_review_hold" | "blocked_by_risk_review_hold" | "blocked_by_address_review_hold" | "blocked_by_manual_support_hold" | "inventory_external_provider_insufficient_available_stock" | "inventory_external_provider_stock_stale" | "inventory_external_provider_stock_missing" | "inventory_external_provider_sku_not_found" | "inventory_external_provider_location_missing" | "inventory_reservation_insufficient_available_stock" | "inventory_reservation_allocation_incomplete" | "inventory_reservation_payment_status_not_reservable" | "inventory_reservation_invalid_quantity" | "unspecified_refusal";
