import { describe, expect, it } from "vitest";
import { deliveryContactFixture } from "./omsClient.fixtures.js";
import type { OmsDeliveryContactResolution } from "./omsContracts.js";
import {
  buildOmsOrderDetailResponse,
  buildOmsOrderListResponse,
  type OmsOrderItemRow,
  type OmsOrderRow,
} from "./omsReadModel.js";

const order: OmsOrderRow = {
  id: "42222222-2222-4222-8222-222222222221",
  order_number: "V-1001",
  client_id: "41111111-1111-4111-8111-111111111111",
  status: "paid",
  mode: "subscription_cycle",
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
  subscription_id: "43333333-3333-4333-8333-333333333333",
  subscription_cycle_id: "44444444-4444-4444-8444-444444444444",
  shipping_address_id: "45555555-5555-4555-8555-555555555555",
};

describe("commerce OMS read model", () => {
  it("projects the frozen 50% first-subscription ladder only for a reconciled initial subscription", () => {
    const response = buildOmsOrderDetailResponse({
      order: {
        ...order,
        mode: "subscription_cycle",
        subtotal_cents: 49_580,
        discount_cents: 22_015,
        shipping_cents: 1_500,
        shipping_discount_cents: 1_500,
        tax_cents: 0,
        total_cents: 27_565,
        metadata: {
          runtimeFinalize: { checkoutKind: "subscription_initial" },
          orderDraftSnapshot: { discounts: [{ customerSemantic: "first_subscription_50" }] },
        },
      },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      orderItems: [canonicalOrderItem({
        unit_price_cents: 49_580,
        total_cents: 49_580,
        discount_allocated_cents: 22_015,
        effective_total_cents: 27_565,
        effective_net_cents: 27_565,
        vat_rate_bps: 0,
        product_snapshot: {
          quoteLine: {
            pricingComponents: [{
              scope: "line",
              componentType: "base_unit",
              amountMinor: 55_130,
            }],
          },
        },
      })],
      inventoryReservations: [],
      subscriptionCycleStatus: null,
    });

    expect(response.order.firstSubscriptionPricePresentation).toEqual({
      catalogProducts: money(55_130),
      productDiscount: money(27_565),
      productPayable: money(27_565),
      shipping: money(1_500),
      shippingDiscount: money(1_500),
      shippingEffective: money(0),
      total: money(27_565),
      discountPercent: 50,
    });
  });

  it.each([
    {
      name: "without discounts or shipping",
      header: {
        discount_cents: 0,
        shipping_cents: 0,
        shipping_discount_cents: 0,
        tax_cents: 956,
        total_cents: 12900,
      },
      line: canonicalOrderItem({
        discount_allocated_cents: 0,
        effective_total_cents: 12900,
        effective_net_cents: 11944,
      }),
      expected: {
        subtotal: money(12900),
        productDiscount: money(0),
        shipping: money(0),
        shippingDiscount: money(0),
        discountTotal: money(0),
        finalTotal: money(12900),
        source: "order_columns",
      },
    },
    {
      name: "with a product discount",
      header: {
        discount_cents: 900,
        shipping_cents: 0,
        shipping_discount_cents: 0,
        tax_cents: 889,
        total_cents: 12000,
      },
      line: canonicalOrderItem({
        discount_allocated_cents: 900,
        effective_total_cents: 12000,
        effective_net_cents: 11111,
      }),
      expected: {
        subtotal: money(12900),
        productDiscount: money(900),
        shipping: money(0),
        shippingDiscount: money(0),
        discountTotal: money(900),
        finalTotal: money(12000),
        source: "order_columns",
      },
    },
    {
      name: "with paid shipping",
      header: {
        discount_cents: 900,
        shipping_cents: 1500,
        shipping_discount_cents: 0,
        tax_cents: 1000,
        total_cents: 13500,
      },
      line: canonicalOrderItem({
        discount_allocated_cents: 900,
        effective_total_cents: 12000,
        effective_net_cents: 11111,
      }),
      expected: {
        subtotal: money(12900),
        productDiscount: money(900),
        shipping: money(1500),
        shippingDiscount: money(0),
        discountTotal: money(900),
        finalTotal: money(13500),
        source: "order_columns",
      },
    },
    {
      name: "with free shipping",
      header: {
        discount_cents: 900,
        shipping_cents: 1500,
        shipping_discount_cents: 1500,
        tax_cents: 889,
        total_cents: 12000,
      },
      line: canonicalOrderItem({
        discount_allocated_cents: 900,
        effective_total_cents: 12000,
        effective_net_cents: 11111,
      }),
      expected: {
        subtotal: money(12900),
        productDiscount: money(900),
        shipping: money(0),
        shippingDiscount: money(1500),
        discountTotal: money(2400),
        finalTotal: money(12000),
        source: "order_columns",
      },
    },
  ])("maps canonical pricing $name", ({ header, line, expected }) => {
    const scenarioOrder = { ...order, ...header };
    const response = buildOmsOrderDetailResponse({
      order: scenarioOrder,
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      orderItems: [line],
      inventoryReservations: [],
      subscriptionCycleStatus: null,
    });

    expect(response.order.pricingSummary).toEqual(expected);
    expect(response.order.lines).toEqual([{
      id: line.id,
      skuId: null,
      sku: null,
      title: null,
      quantity: 1,
      unitPrice: money(12900),
      total: money(12900),
      discountAllocated: money(line.discount_allocated_cents ?? 0),
      effectiveTotal: money(line.effective_total_cents ?? 12900),
      effectiveNet: money(line.effective_net_cents ?? 11944),
      vatRateBps: 800,
      productSnapshot: {},
      variantSnapshot: null,
    }]);
  });

  it("maps list rows with payment-control status and active hold counts", () => {
    const response = buildOmsOrderListResponse({
      orders: [order],
      paymentIntents: [
        {
          id: "52222222-2222-4222-8222-222222222221",
          order_id: order.id,
          payment_id: "62222222-2222-4222-8222-222222222221",
          status: "succeeded",
          active_attempt_id: "72222222-2222-4222-8222-222222222221",
          provider_payment_id: "psp_1",
          updated_at: "2026-06-05T10:01:00+00:00",
        },
      ],
      paymentAttempts: [
        {
          id: "72222222-2222-4222-8222-222222222221",
          payment_intent_id: "52222222-2222-4222-8222-222222222221",
          status: "succeeded",
          provider: "stripe",
          provider_attempt_id: "pi_1",
          next_action_kind: null,
          updated_at: "2026-06-05T10:01:00+00:00",
        },
      ],
      activeHoldCounts: { [order.id]: 1 },
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(response.orders[0]).toMatchObject({
      orderId: order.id,
      paymentStatus: "succeeded",
      paymentMethodLabel: "Karta",
      paymentProvider: "stripe",
      activeHoldCount: 1,
      total: { amountMinor: 12900, currency: "PLN" },
    });
    expect(response.summaryCounts).toMatchObject({
      needsAttention: 1,
      activeHold: 1,
    });
  });

  it("surfaces the order source axis on list and detail, and omits it rather than guessing", () => {
    // Three rows, three states the axis can legitimately be in. The third is the
    // reason both fields are optional rather than defaulted: a row read before the
    // source-axis migration applied holds NO opinion about where it was sold, and
    // answering "storefront" for it would be a fact this reader invented.
    const externalOrder: OmsOrderRow = {
      ...order,
      id: "42222222-2222-4222-8222-222222222291",
      source_kind: "marketplace",
      sales_channels: { slug: "external-surface-a" },
    };
    const storefrontOrder: OmsOrderRow = {
      ...order,
      id: "42222222-2222-4222-8222-222222222292",
      source_kind: "storefront",
      sales_channels: null,
    };
    const preAxisOrder: OmsOrderRow = { ...order, id: "42222222-2222-4222-8222-222222222293" };

    const list = buildOmsOrderListResponse({
      orders: [externalOrder, storefrontOrder, preAxisOrder],
      paymentIntents: [],
      paymentAttempts: [],
      activeHoldCounts: {},
      totalCount: 3,
      page: 1,
      pageSize: 25,
    });

    expect(list.orders[0]).toMatchObject({
      sourceKind: "marketplace",
      sourceChannelSlug: "external-surface-a",
    });
    // A storefront order names no channel, so the slug carries no value.
    expect(list.orders[1].sourceKind).toBe("storefront");
    expect(list.orders[1].sourceChannelSlug).toBeUndefined();
    // A row without the columns yields neither field, not a fabricated default.
    expect(list.orders[2].sourceKind).toBeUndefined();
    expect(list.orders[2].sourceChannelSlug).toBeUndefined();

    // Detail extends the list item, so the same two fields must arrive there too.
    const detail = buildOmsOrderDetailResponse({
      order: externalOrder,
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      subscriptionCycleStatus: null,
    });

    expect(detail.order).toMatchObject({
      sourceKind: "marketplace",
      sourceChannelSlug: "external-surface-a",
    });
  });

  it("projects an exactly released suspended recovery in both OMS list and detail", () => {
    const fulfillmentOrderId = "d2222222-2222-4222-8222-222222222221";
    const exceptionAt = "2026-08-04T10:00:00+00:00";
    const recoveryAt = "2026-08-04T10:01:00+00:00";
    const omnipackStatusEvidence = [
      { id: "exception-evidence", fulfillment_order_id: fulfillmentOrderId, provider_status: "SUSPENDED", local_status: "exception", occurred_at: exceptionAt },
      { id: "recovery-evidence", fulfillment_order_id: fulfillmentOrderId, provider_status: "AWAITING_COURIER", local_status: "packed", occurred_at: recoveryAt },
    ];
    const releasedProviderExceptionHolds = [{
      order_id: order.id,
      status: "released",
      reason: "fulfillment_exception",
      created_by: null,
      released_by: null,
      metadata: {
        source: "commerce.fulfillment.omnipack_provider_exception",
        autoReleased: true,
        autoReleaseSource: "commerce.fulfillment.omnipack_provider_exception_healed",
        autoReleaseProof: "provider_recovered",
        autoReleaseEvidence: {
          fulfillmentOrderId,
          statusEvidenceId: "recovery-evidence",
          localStatus: "packed",
          occurredAt: recoveryAt,
          clearedStatusEvidenceId: "exception-evidence",
          clearedProviderStatus: "SUSPENDED",
          clearedOccurredAt: exceptionAt,
        },
      },
    }];
    const fulfillmentOrders = [{ id: fulfillmentOrderId, order_id: order.id, status: "exception" as const }];

    const list = buildOmsOrderListResponse({
      orders: [order], paymentIntents: [], activeHoldCounts: {}, fulfillmentOrders,
      omnipackStatusEvidence, releasedProviderExceptionHolds, totalCount: 1, page: 1, pageSize: 25,
    });
    const detail = buildOmsOrderDetailResponse({
      order, paymentIntent: null, paymentAttempts: [], paymentTransitions: [], holds: [], operations: [],
      fulfillmentOrders, fulfillmentOperations: [], shipmentExternalRefs: [], omnipackStatusEvidence,
      releasedProviderExceptionHolds, subscriptionCycleStatus: null,
    });

    expect(list.orders[0]?.customerFulfillmentStep).toBe("packing");
    expect(detail.order.customerFulfillmentStep).toBe("packing");

    const blockedList = buildOmsOrderListResponse({
      orders: [order], paymentIntents: [], activeHoldCounts: { [order.id]: 1 }, fulfillmentOrders,
      omnipackStatusEvidence, releasedProviderExceptionHolds, totalCount: 1, page: 1, pageSize: 25,
    });
    const blockedDetail = buildOmsOrderDetailResponse({
      order, paymentIntent: null, paymentAttempts: [], paymentTransitions: [], operations: [],
      holds: [{ id: "e2222222-2222-4222-8222-222222222221", order_id: order.id, status: "active", reason: "manual_support", note: null, created_at: recoveryAt, released_at: null }],
      fulfillmentOrders, fulfillmentOperations: [], shipmentExternalRefs: [], omnipackStatusEvidence,
      releasedProviderExceptionHolds, subscriptionCycleStatus: null,
    });
    expect(blockedList.orders[0]?.customerFulfillmentStep).toBe("exception");
    expect(blockedDetail.order.customerFulfillmentStep).toBe("exception");
  });

  it("maps Tpay BLIK attempts as BLIK instead of guessing from succeeded status", () => {
    const response = buildOmsOrderListResponse({
      orders: [order],
      paymentIntents: [
        {
          id: "52222222-2222-4222-8222-222222222221",
          order_id: order.id,
          payment_id: "62222222-2222-4222-8222-222222222221",
          status: "succeeded",
          active_attempt_id: "72222222-2222-4222-8222-222222222221",
          provider_payment_id: "tpay-1",
          updated_at: "2026-06-05T10:01:00+00:00",
        },
      ],
      paymentAttempts: [
        {
          id: "72222222-2222-4222-8222-222222222221",
          payment_intent_id: "52222222-2222-4222-8222-222222222221",
          status: "succeeded",
          provider: "tpay",
          provider_attempt_id: "blik-123",
          next_action_kind: "blik_code",
          updated_at: "2026-06-05T10:01:00+00:00",
        },
      ],
      activeHoldCounts: {},
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(response.orders[0]).toMatchObject({
      paymentStatus: "succeeded",
      paymentMethodLabel: "BLIK",
      paymentProvider: "tpay",
    });
  });

  it("maps simulator Tpay attempts as BLIK even when provider attempt id has no method hint", () => {
    const response = buildOmsOrderListResponse({
      orders: [order],
      paymentIntents: [
        {
          id: "52222222-2222-4222-8222-222222222221",
          order_id: order.id,
          payment_id: "62222222-2222-4222-8222-222222222221",
          status: "succeeded",
          active_attempt_id: "72222222-2222-4222-8222-222222222221",
          provider_payment_id: "tpay_sim_1",
          updated_at: "2026-06-05T10:01:00+00:00",
        },
      ],
      paymentAttempts: [
        {
          id: "72222222-2222-4222-8222-222222222221",
          payment_intent_id: "52222222-2222-4222-8222-222222222221",
          status: "succeeded",
          provider: "tpay",
          provider_attempt_id: "tpay_sim_1",
          next_action_kind: null,
          updated_at: "2026-06-05T10:01:00+00:00",
        },
      ],
      activeHoldCounts: {},
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(response.orders[0]).toMatchObject({
      paymentMethodLabel: "BLIK",
      paymentProvider: "tpay",
    });
  });

  it("summarizes dashboard totals from succeeded payment rows only", () => {
    const unpaidOrder: OmsOrderRow = {
      ...order,
      id: "42222222-2222-4222-8222-222222222229",
      order_number: "V-1009",
      mode: "one_time",
      total_cents: 99900,
      subscription_id: null,
      subscription_cycle_id: null,
    };

    const response = buildOmsOrderListResponse({
      orders: [order, unpaidOrder],
      paymentIntents: [
        {
          id: "52222222-2222-4222-8222-222222222221",
          order_id: order.id,
          payment_id: "62222222-2222-4222-8222-222222222221",
          status: "succeeded",
          active_attempt_id: null,
          provider_payment_id: "psp_1",
          updated_at: "2026-06-05T10:01:00+00:00",
        },
        {
          id: "52222222-2222-4222-8222-222222222229",
          order_id: unpaidOrder.id,
          payment_id: "62222222-2222-4222-8222-222222222229",
          status: "failed",
          active_attempt_id: null,
          provider_payment_id: "psp_2",
          updated_at: "2026-06-05T10:01:00+00:00",
        },
      ],
      activeHoldCounts: {},
      totalCount: 2,
      page: 1,
      pageSize: 25,
    });

    expect(response.summaryTotals).toEqual({
      gmv: { amountMinor: 12900, currency: "PLN" },
      aov: { amountMinor: 12900, currency: "PLN" },
      orderCount: 1,
      paidSubscriptionCycleCount: 1,
    });
    expect(response.summaryCounts.paymentIssues).toBe(1);
  });

  it("aggregates payment-control rows and OMS holds without duplicating payment transitions", () => {
    const response = buildOmsOrderDetailResponse({
      order,
      paymentIntent: {
        id: "52222222-2222-4222-8222-222222222221",
        order_id: order.id,
        payment_id: "62222222-2222-4222-8222-222222222221",
        status: "succeeded",
        active_attempt_id: "72222222-2222-4222-8222-222222222221",
        provider_payment_id: "psp_1",
        updated_at: "2026-06-05T10:01:00+00:00",
      },
      paymentAttempts: [
        {
          id: "72222222-2222-4222-8222-222222222221",
          status: "succeeded",
          provider: "adyen",
          provider_attempt_id: "psp_1",
          next_action_kind: null,
          updated_at: "2026-06-05T10:01:00+00:00",
        },
      ],
      paymentTransitions: [
        {
          id: "82222222-2222-4222-8222-222222222221",
          transition_kind: "business_result",
          from_status: "processing",
          to_status: "succeeded",
          reason: "state_changed",
          occurred_at: "2026-06-05T10:01:00+00:00",
        },
      ],
      holds: [
        {
          id: "92222222-2222-4222-8222-222222222221",
          order_id: order.id,
          status: "active",
          reason: "manual_support",
          note: "check before shipping",
          created_at: "2026-06-05T10:02:00+00:00",
          released_at: null,
        },
      ],
      operations: [
        {
          id: "a2222222-2222-4222-8222-222222222221",
          order_id: order.id,
          operation_type: "hold_created",
          hold_id: "92222222-2222-4222-8222-222222222221",
          actor_user_id: null,
          occurred_at: "2026-06-05T10:02:00+00:00",
          payload: { reason: "manual_support" },
        },
      ],
      orderItems: [{
        id: "e2222222-2222-4222-8222-222222222221",
        quantity: 1,
        unit_price_cents: 12900,
        total_cents: 12900,
        discount_allocated_cents: 0,
        effective_total_cents: 12900,
        effective_net_cents: 11944,
        vat_rate_bps: 800,
      }],
      inventoryReservations: [{
        id: "b2222222-2222-4222-8222-222222222221",
        order_id: order.id,
        order_item_id: "e2222222-2222-4222-8222-222222222221",
        quantity: 1,
        status: "reserved",
        expires_at: "2026-06-05T10:30:00+00:00",
        location_id: "c2222222-2222-4222-8222-222222222221",
        inventory_locations: { code: "pl-main" },
      }],
      fulfillmentOrders: [{
        id: "d2222222-2222-4222-8222-222222222221",
        order_id: order.id,
        status: "label_created",
        provider_kind: "dhl",
      }],
      fulfillmentOperations: [{
        fulfillment_order_id: "d2222222-2222-4222-8222-222222222221",
        operation_type: "label_created",
        occurred_at: "2026-06-05T10:03:00+00:00",
      }],
      omnipackDispatchRefs: [{
        fulfillment_order_id: "d2222222-2222-4222-8222-222222222221",
        provider_order_id: null,
        dispatch_mode: "live",
        status: "failed",
        error: { code: "provider_rejected" },
        created_at: "2026-06-05T10:02:00+00:00",
        updated_at: "2026-06-05T10:05:00+00:00",
      }],
      fulfillmentHealth: {
        healthStatus: "needs_attention",
        attentionReasons: ["dispatch_failed"],
        oldestAgeSeconds: 0,
        dispatchRefId: "c2222222-2222-4222-8222-222222222225",
        dispatchStatus: "failed",
        opaqueIds: {
          orderId: order.id,
          fulfillmentOrderId: "d2222222-2222-4222-8222-222222222221",
          outboxEventId: null,
          dispatchRefFulfillmentOrderId: null,
          latestEvidenceFulfillmentOrderId: null,
        },
      },
      shipmentExternalRefs: [{
        order_id: order.id,
        provider_tracking_id: "NOOP-TRACK-1",
        provider_kind: "dhl",
        carrier_kind: "dhl",
        service: null,
        tracking_url: "https://track.example/NOOP-TRACK-1",
        updated_at: "2026-06-05T10:04:00+00:00",
        active: true,
      }],
      subscriptionCycleStatus: "paid",
    });

    expect(response.order.payment.status).toBe("succeeded");
    expect(response.order.paymentTransitions).toHaveLength(1);
    expect(response.order.operations).toHaveLength(1);
    expect(response.order.fulfillmentEligibility).toEqual({
      allowed: false,
      reason: "active_hold",
    });
    expect(response.order.inventory).toMatchObject({ status: "reserved", locationCode: "pl-main" });
    expect(response.order.fulfillment).toMatchObject({
      fulfillmentOrderId: "d2222222-2222-4222-8222-222222222221",
      status: "label_created",
      providerKind: "dhl",
      latestOperationType: "label_created",
      latestOperationAt: "2026-06-05T10:03:00+00:00",
      providerTrackingId: "NOOP-TRACK-1",
      trackingUrl: "https://track.example/NOOP-TRACK-1",
      carrierKind: "dhl",
    });
    expect(response.order.customerFulfillmentStep).toBe("exception");
    expect(response.order.fulfillment.trackingReferences[0]).toMatchObject({
      providerKind: "dhl",
      trackingNumber: "NOOP-TRACK-1",
      trackingUrl: "https://track.example/NOOP-TRACK-1",
      updatedAt: "2026-06-05T10:04:00+00:00",
    });
    expect(response.order.fulfillment.trackingTimeline).toContainEqual(expect.objectContaining({
      eventType: "label_created",
      source: "fulfillment",
    }));
    expect(response.order.fulfillment.providerEvidence[0]).toMatchObject({
      evidenceType: "dispatch_ref",
      status: "failed",
      providerStatus: null,
      providerOrderId: null,
      evidenceKind: "live",
      summary: "dispatch_error_present",
    });
    expect(response.order.fulfillmentHealth).toMatchObject({
      healthStatus: "needs_attention",
      attentionReasons: ["dispatch_failed"],
      dispatchRefId: "c2222222-2222-4222-8222-222222222225",
      dispatchStatus: "failed",
      opaqueIds: {
        orderId: order.id,
        fulfillmentOrderId: "d2222222-2222-4222-8222-222222222221",
      },
    });
    expect(response.order.actionEligibility).toMatchObject({
      handOff: { allowed: true, reason: null },
      recordTrackingEvent: { allowed: false, reason: "tracking_not_ready" },
      cancelFulfillment: { allowed: false, reason: "fulfillment_not_cancellable" },
    });
  });

  it("parses an order-marked-refunded operation without throwing (regression: schema drift vs commerce_order_mark_refunded_manual RPC)", () => {
    const response = buildOmsOrderDetailResponse({
      order: { ...order, status: "refunded" },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [
        {
          id: "a3333333-3333-4333-8333-333333333331",
          order_id: order.id,
          operation_type: "order_marked_refunded",
          hold_id: null,
          actor_user_id: null,
          occurred_at: "2026-06-05T10:05:00+00:00",
          payload: { reason: "manual Tpay refund" },
        },
      ],
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [],
      fulfillmentOperations: [],
      shipmentExternalRefs: [],
      subscriptionCycleStatus: null,
    });

    expect(response.order.operations).toHaveLength(1);
    expect(response.order.operations[0]).toMatchObject({ type: "order_marked_refunded" });
  });

  it("shows selected InPost pickup delivery evidence on OMS detail before fulfillment tracking exists", () => {
    const response = buildOmsOrderDetailResponse({
      order: {
        ...order,
        metadata: {
          runtimeFinalize: {
            selectedDelivery: {
              kind: "parcel-locker",
              deliveryKind: "parcel-locker",
              providerKind: "omnipack",
              carrierKind: "inpost",
              carrierCode: "INPOST",
              serviceCode: "INPOST_LOCKER_STANDARD",
              pickupPoint: {
                id: "WAW01A",
                name: "Paczkomat WAW01A",
                address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
              },
            },
          },
        },
      },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [],
      shipmentExternalRefs: [],
      subscriptionCycleStatus: "planned",
    });

    expect(response.order.deliverySelection).toMatchObject({
      deliveryKind: "parcel-locker",
      providerKind: "omnipack",
      carrierKind: "inpost",
      carrierCode: "INPOST",
      serviceCode: "INPOST_LOCKER_STANDARD",
      pickupPoint: { id: "WAW01A", name: "Paczkomat WAW01A" },
      source: "orderRuntimeFinalize",
    });
    expect(response.order.fulfillment.trackingReferences).toEqual([]);
  });

  it("blocks paid orders without a hard inventory reservation", () => {
    const response = buildOmsOrderDetailResponse({
      order: { ...order, mode: "one_time", subscription_id: null, subscription_cycle_id: null },
      paymentIntent: {
        id: "52222222-2222-4222-8222-222222222221",
        order_id: order.id,
        payment_id: "62222222-2222-4222-8222-222222222221",
        status: "succeeded",
        active_attempt_id: null,
        provider_payment_id: null,
        updated_at: "2026-06-05T10:01:00+00:00",
      },
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      orderItems: [],
      inventoryReservations: [],
      subscriptionCycleStatus: null,
    });

    expect(response.order.inventory.status).toBe("missing");
    expect(response.order.fulfillmentEligibility).toEqual({ allowed: false, reason: "inventory_review" });
  });

  it("requires reservation coverage for every order item", () => {
    const response = buildOmsOrderDetailResponse({
      order: { ...order, mode: "one_time", subscription_id: null, subscription_cycle_id: null },
      paymentIntent: {
        id: "52222222-2222-4222-8222-222222222221",
        order_id: order.id,
        payment_id: "62222222-2222-4222-8222-222222222221",
        status: "succeeded",
        active_attempt_id: null,
        provider_payment_id: null,
        updated_at: "2026-06-05T10:01:00+00:00",
      },
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      orderItems: [
        canonicalOrderItem({
          id: "e2222222-2222-4222-8222-222222222221",
          unit_price_cents: 6450,
          total_cents: 6450,
          effective_total_cents: 6450,
          effective_net_cents: 5972,
        }),
        canonicalOrderItem({
          id: "e2222222-2222-4222-8222-222222222222",
          unit_price_cents: 6450,
          total_cents: 6450,
          effective_total_cents: 6450,
          effective_net_cents: 5972,
        }),
      ],
      inventoryReservations: [
        {
          id: "b2222222-2222-4222-8222-222222222221",
          order_id: order.id,
          order_item_id: "e2222222-2222-4222-8222-222222222221",
          quantity: 1,
          status: "reserved",
          expires_at: "2026-06-05T10:30:00+00:00",
          location_id: "c2222222-2222-4222-8222-222222222221",
          inventory_locations: { code: "pl-main" },
        },
      ],
      subscriptionCycleStatus: null,
    });

    expect(response.order.inventory.status).toBe("missing");
    expect(response.order.fulfillmentEligibility).toEqual({ allowed: false, reason: "inventory_review" });
  });

  it("projects immutable baseline and parcel-effective contact with provider cutoff", () => {
    const baseline = deliveryContact("checkout_submission", 1, "Bazowa 1", "base@example.com");
    const parcelContact = deliveryContact("operator_parcel_override", 2, "Paczka 2", "parcel@example.com");
    const common = {
      order: {
        ...order,
        metadata: { runtimeFinalize: { deliveryContact: baseline } },
      },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [{
        id: "f2222222-2222-4222-8222-222222222221",
        order_id: order.id,
        status: "created" as const,
        shipping_address_snapshot: { deliveryContact: parcelContact },
      }],
      deliveryContactResolution: contactResolution("parcel", parcelContact, baseline),
      subscriptionCycleStatus: null,
    };
    const draft = buildOmsOrderDetailResponse({
      ...common,
      omnipackDispatchRefs: [{
        fulfillment_order_id: "f2222222-2222-4222-8222-222222222221",
        status: "draft",
        provider_order_id: null,
      }],
    });
    const submitting = buildOmsOrderDetailResponse({
      ...common,
      omnipackDispatchRefs: [{
        fulfillment_order_id: "f2222222-2222-4222-8222-222222222221",
        status: "submitting",
        provider_order_id: null,
      }],
    });
    const draftAfterEffect = buildOmsOrderDetailResponse({
      ...common,
      omnipackDispatchRefs: [{
        fulfillment_order_id: "f2222222-2222-4222-8222-222222222221",
        status: "draft",
        provider_order_id: null,
      }, {
        fulfillment_order_id: "f2222222-2222-4222-8222-222222222221",
        status: "created",
        provider_order_id: "provider-order-1",
      }],
    });

    expect(draft.order.deliveryContact).toMatchObject({
      baseline,
      effective: parcelContact,
      scope: "parcel",
      source: "operator_parcel_override",
      revision: 2,
      frozen: false,
      providerSubmissionState: "draft",
      correctionAllowed: true,
    });
    expect(draft.order.shippingAddress).toMatchObject({
      line1: "Paczka 2",
      postalCode: "00-001",
    });
    expect(draft.order.actionEligibility.updateShippingAddress).toEqual({ allowed: true, reason: null });
    expect(submitting.order.deliveryContact).toMatchObject({
      frozen: true,
      providerSubmissionState: "submitting",
      correctionAllowed: false,
    });
    expect(submitting.order.actionEligibility.updateShippingAddress).toEqual({
      allowed: false,
      reason: "delivery_contact_submission_started",
    });
    expect(draftAfterEffect.order.deliveryContact).toMatchObject({
      frozen: true,
      providerSubmissionState: "created",
      correctionAllowed: false,
    });
    expect(draftAfterEffect.order.actionEligibility.updateShippingAddress).toEqual({
      allowed: false,
      reason: "delivery_contact_submission_started",
    });
  });

  it("uses the order override before parcel creation and labels legacy inference", () => {
    const override = deliveryContact("operator_order_override", 2, "Korekta 2", "override@example.com");
    const preParcel = buildOmsOrderDetailResponse({
      order: { ...order, metadata: { deliveryContactOverride: override } },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      shippingAddress: null,
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [],
      deliveryContactResolution: contactResolution("order_override", override),
      subscriptionCycleStatus: null,
    });
    const legacy = buildOmsOrderDetailResponse({
      order: { ...order, metadata: null },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      shippingAddress: legacyAddress("Żywy 1"),
      customer: null,
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [],
      deliveryContactResolution: contactResolution(
        "legacy_inferred",
        deliveryContact("legacy_inferred", 1, "Żywy 1", "customer@example.com"),
      ),
      subscriptionCycleStatus: null,
    });

    expect(preParcel.order.deliveryContact).toMatchObject({
      effective: override,
      scope: "order_override",
      revision: 2,
      frozen: false,
    });
    expect(legacy.order.deliveryContact).toMatchObject({
      scope: "legacy_inferred",
      source: "legacy_inferred",
      revision: 1,
      frozen: false,
      correctionAllowed: true,
    });
    expect(legacy.order.actionEligibility.updateShippingAddress).toEqual({ allowed: true, reason: null });
  });

  it("uses the dispatch-compatible legacy contact ladder only for old parcels", () => {
    const legacy = buildOmsOrderDetailResponse({
      order: { ...order, metadata: null },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      shippingAddress: {
        ...legacyAddress("Saved 1"),
        recipient_name: "Saved recipient",
        contact_phone: "222333444",
      },
      customer: {
        id: order.client_id!,
        email: "customer@example.com",
        first_name: "Client",
        last_name: "Name",
        phone: "999888777",
        lifecycle_stage: null,
      },
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [{
        id: "f2222222-2222-4222-8222-222222222221",
        order_id: order.id,
        status: "packed",
        shipping_address_snapshot: {
          ...deliveryContactFixture({ line1: "Parcel 1", city: "Krakow", postalCode: "30-001" }).address,
          label: "Parcel label",
          recipientName: "Parcel recipient",
          contactPhone: "111222333",
        },
      }],
      omnipackDispatchRefs: [],
      deliveryContactResolution: contactResolution(
        "legacy_inferred",
        deliveryContact("legacy_inferred", 1, "Parcel 1", "customer@example.com", {
          recipientName: "Parcel recipient",
          contactPhone: "111222333",
          city: "Krakow",
          postalCode: "30-001",
        }),
      ),
      subscriptionCycleStatus: null,
    });

    expect(legacy.order.deliveryContact).toMatchObject({
      scope: "legacy_inferred",
      revision: 1,
      frozen: false,
      correctionAllowed: true,
      effective: {
        recipientName: "Parcel recipient",
        contactEmail: "customer@example.com",
        contactPhone: "111222333",
        line1: "Parcel 1",
      },
    });
    expect(legacy.order.actionEligibility.updateShippingAddress).toEqual({ allowed: true, reason: null });
    expect(legacy.order.shippingAddress).toMatchObject({
      recipientName: "Parcel recipient",
      contactPhone: "111222333",
      line1: "Parcel 1",
    });
  });

  it("keeps an inferred legacy contact frozen only after a provider effect or parcel lock", () => {
    const legacyParcel = {
      id: "f2222222-2222-4222-8222-222222222221",
      order_id: order.id,
      status: "packed" as const,
      shipping_address_snapshot: {
        ...deliveryContactFixture({ line1: "Parcel 1", city: "Krakow", postalCode: "30-001" }).address,
        recipientName: "Parcel recipient",
        contactPhone: "111222333",
      },
    };
    const effectful = buildOmsOrderDetailResponse({
      order: { ...order, metadata: null },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      shippingAddress: legacyAddress("Saved 1"),
      customer: null,
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [legacyParcel],
      omnipackDispatchRefs: [{
        fulfillment_order_id: legacyParcel.id,
        status: "submitting",
        provider_order_id: null,
      }],
      deliveryContactResolution: contactResolution(
        "legacy_inferred",
        deliveryContact("legacy_inferred", 1, "Parcel 1", "customer@example.com"),
      ),
      subscriptionCycleStatus: null,
    });
    const locked = buildOmsOrderDetailResponse({
      order: { ...order, metadata: null },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      shippingAddress: legacyAddress("Saved 1"),
      customer: null,
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [{ ...legacyParcel, status: "label_created" as const }],
      omnipackDispatchRefs: [],
      deliveryContactResolution: contactResolution(
        "legacy_inferred",
        deliveryContact("legacy_inferred", 1, "Parcel 1", "customer@example.com"),
      ),
      subscriptionCycleStatus: null,
    });

    expect(effectful.order.deliveryContact).toMatchObject({
      scope: "legacy_inferred",
      revision: 1,
      frozen: true,
      providerSubmissionState: "submitting",
      correctionAllowed: false,
    });
    expect(effectful.order.actionEligibility.updateShippingAddress).toEqual({
      allowed: false,
      reason: "delivery_contact_submission_started",
    });
    expect(locked.order.deliveryContact).toMatchObject({
      scope: "legacy_inferred",
      revision: 1,
      frozen: true,
      providerSubmissionState: "not_started",
      correctionAllowed: false,
    });
    expect(locked.order.actionEligibility.updateShippingAddress).toEqual({
      allowed: false,
      reason: "address_locked_after_label",
    });
  });

  it("excludes synthetic invalid customer email from legacy inference", () => {
    const legacy = buildOmsOrderDetailResponse({
      order: { ...order, metadata: null },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      shippingAddress: legacyAddress("Saved 1"),
      customer: {
        id: order.client_id!,
        email: "placeholder@example.invalid",
        first_name: "Client",
        last_name: "Name",
        phone: "999888777",
        lifecycle_stage: null,
      },
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [],
      deliveryContactResolution: contactResolution(
        "legacy_inferred",
        deliveryContact("legacy_inferred", 1, "Saved 1", ""),
      ),
      subscriptionCycleStatus: null,
    });

    expect(legacy.order.deliveryContact?.effective?.contactEmail).toBeNull();
  });

  it("fails closed on a malformed higher-priority parcel contact", () => {
    const baseline = deliveryContact("checkout_submission", 1, "Baseline 1", "base@example.com");
    const response = buildOmsOrderDetailResponse({
      order: { ...order, metadata: { runtimeFinalize: { deliveryContact: baseline } } },
      paymentIntent: null,
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      shippingAddress: legacyAddress("Mutable 1"),
      orderItems: [],
      inventoryReservations: [],
      fulfillmentOrders: [{
        id: "f2222222-2222-4222-8222-222222222221",
        order_id: order.id,
        status: "created",
        shipping_address_snapshot: {
          deliveryContact: { schemaVersion: 1, revision: 0 },
        },
      }],
      omnipackDispatchRefs: [],
      deliveryContactResolution: {
        resolutionVersion: 1,
        scope: "parcel",
        baseline,
        contact: null,
        contactDigest: null,
      },
      subscriptionCycleStatus: null,
    });

    expect(response.order.deliveryContact).toMatchObject({
      baseline,
      effective: null,
      scope: "parcel",
      source: null,
      revision: null,
      correctionAllowed: false,
    });
    expect(response.order.shippingAddress).toBeNull();
    expect(response.order.actionEligibility.updateShippingAddress).toEqual({
      allowed: false,
      reason: "missing_shipping_address",
    });
  });
});

function deliveryContact(
  source: string,
  revision: number,
  line1: string,
  contactEmail: string,
  overrides: Parameters<typeof deliveryContactFixture>[0] = {},
) {
  return deliveryContactFixture({
    source,
    revision,
    contactEmail,
    line1,
    ...overrides,
  }).canonical;
}

function contactResolution(
  scope: OmsDeliveryContactResolution["scope"],
  contact: OmsDeliveryContactResolution["contact"],
  baseline: OmsDeliveryContactResolution["baseline"] = null,
): OmsDeliveryContactResolution {
  return {
    resolutionVersion: 1,
    scope,
    baseline,
    contact,
    contactDigest: contact ? "0123456789abcdef0123456789abcdef" : null,
  };
}

function legacyAddress(line1: string) {
  const address = deliveryContactFixture({ line1 }).address;
  const { postalCode, ...rest } = address;
  return { ...rest, id: order.shipping_address_id!, postal_code: postalCode };
}

function canonicalOrderItem(
  overrides: Partial<OmsOrderItemRow> = {},
): OmsOrderItemRow {
  return {
    id: "e2222222-2222-4222-8222-222222222221",
    quantity: 1,
    unit_price_cents: 12900,
    total_cents: 12900,
    discount_allocated_cents: 0,
    effective_total_cents: 12900,
    effective_net_cents: 11944,
    vat_rate_bps: 800,
    product_snapshot: {},
    variant_snapshot: null,
    ...overrides,
  };
}

function money(amountMinor: number) {
  return { amountMinor, currency: "PLN" as const };
}
