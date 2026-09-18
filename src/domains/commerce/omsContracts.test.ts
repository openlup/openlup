import { describe, expect, it } from "vitest";
import { deliveryContactFixture } from "./omsClient.fixtures.js";
import {
  adminCommerceOrderDetailResponseSchema,
  adminCommerceOrderHoldRequestSchema,
  adminCommerceOrderUpdateShippingAddressRequestSchema,
  adminCommerceOrderUpdateShippingAddressResponseSchema,
  adminCommerceOrdersListRequestSchema,
  adminCommerceOrdersListResponseSchema,
} from "./omsContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";

const pricingSummary = {
  subtotal: { amountMinor: 12900, currency: "PLN" },
  productDiscount: { amountMinor: 0, currency: "PLN" },
  shipping: { amountMinor: 0, currency: "PLN" },
  shippingDiscount: { amountMinor: 0, currency: "PLN" },
  discountTotal: { amountMinor: 0, currency: "PLN" },
  finalTotal: { amountMinor: 12900, currency: "PLN" },
  source: "order_columns",
} as const;

describe("commerce OMS contracts", () => {
  it("validates hidden admin order list contracts", () => {
    expect(adminCommerceOrdersListRequestSchema.parse({ page: "2" })).toEqual({
      page: 2,
      pageSize: 25,
      sort: "created_desc",
    });
    expect(adminCommerceOrdersListRequestSchema.parse({ attentionOnly: "true", nextAction: "create_fulfillment", sort: "attention_priority_desc" })).toMatchObject({
      attentionOnly: true,
      nextAction: "create_fulfillment",
      sort: "attention_priority_desc",
    });
    expect(adminCommerceOrdersListRequestSchema.parse({ attentionOnly: "false" })).toMatchObject({
      attentionOnly: false,
    });
    expect(adminCommerceOrdersListRequestSchema.parse({ providerOpsStatus: "omnipack_dispatched_not_picked" })).toMatchObject({
      providerOpsStatus: "omnipack_dispatched_not_picked",
    });

    expect(
      adminCommerceOrdersListResponseSchema.parse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        orders: [
          {
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
            fulfillmentStatus: "label_created",
            customerFulfillmentStep: "accepted",
            inventoryStatus: "reserved",
            accountingStatus: "issued",
            attentionReason: "none",
            nextAction: "none",
            activeHoldCount: 0,
            activeHoldReasons: [],
            fulfillmentHealthDigest: { healthStatus: "ok", attentionReasons: [] },
            total: { amountMinor: 12900, currency: "PLN" },
            pricingSummary,
            createdAt: "2026-06-05T10:00:00+00:00",
            updatedAt: "2026-06-05T10:01:00+00:00",
          },
        ],
        summaryCounts: {
          needsAttention: 0,
          activeHold: 0,
          readyForFulfillment: 0,
          paymentIssues: 0,
          inventoryRisk: 0,
          fulfillmentBlocked: 0,
          fulfillmentExceptions: 0,
          invoiceIssues: 0,
          omnipackDispatchedNotPicked: 0,
        },
        summaryTotals: {
          gmv: { amountMinor: 12900, currency: "PLN" },
          aov: { amountMinor: 12900, currency: "PLN" },
          orderCount: 1,
          paidSubscriptionCycleCount: 0,
        },
        totalCount: 1,
        page: 2,
        pageSize: 25,
      }),
    ).toMatchObject({ totalCount: 1 });
  });

  it("pins revisioned order-only delivery-contact corrections", () => {
    const request = adminCommerceOrderUpdateShippingAddressRequestSchema.parse({
      idempotencyKey: "oms-address-1",
      orderId: "42222222-2222-4222-8222-222222222221",
      expectedRevision: 1,
      expectedContactDigest: "0123456789abcdef0123456789abcdef",
      address: deliveryContactFixture().address,
    });
    expect(request.expectedRevision).toBe(1);
    expect(request.expectedContactDigest).toHaveLength(32);
    expect(adminCommerceOrderUpdateShippingAddressRequestSchema.safeParse({
      ...request,
      expectedRevision: undefined,
    }).success).toBe(false);
    expect(adminCommerceOrderUpdateShippingAddressRequestSchema.safeParse({
      ...request,
      expectedRevision: 0,
    }).success).toBe(false);
    expect(adminCommerceOrderUpdateShippingAddressRequestSchema.safeParse({
      ...request,
      expectedContactDigest: "not-a-digest",
    }).success).toBe(false);

    expect(adminCommerceOrderUpdateShippingAddressResponseSchema.parse({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      result: "applied",
      scope: "order",
      deliveryContact: deliveryContactFixture({ source: "oms_order_override", revision: 2 }).canonical,
      operation: {
        id: "b2222222-2222-4222-8222-222222222222",
        orderId: request.orderId,
        type: "shipping_address_updated",
        holdId: null,
        actorUserId: null,
        occurredAt: "2026-06-05T10:05:00+00:00",
        payload: { beforeRevision: 1, afterRevision: 2 },
      },
      address: deliveryContactFixture().address,
      replayed: false,
    })).toMatchObject({ result: "applied", scope: "order", deliveryContact: { revision: 2 } });
  });

  it("validates fulfillment blocked queue next action", () => {
    const parsed = adminCommerceOrdersListResponseSchema.parse({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      orders: [
        {
          orderId: "42222222-2222-4222-8222-222222222221",
          orderNumber: "V-1002",
          clientId: null,
          customer: null,
          pet: null,
          status: "paid",
          mode: "subscription_cycle",
          paymentMethodLabel: null,
          paymentProvider: null,
          paymentStatus: "succeeded",
          fulfillmentStatus: null,
          customerFulfillmentStep: "paid",
          inventoryStatus: "reserved",
          accountingStatus: "missing",
          attentionReason: "fulfillment_blocked",
          nextAction: "review_fulfillment",
          activeHoldCount: 0,
          activeHoldReasons: [],
          fulfillmentHealthDigest: { healthStatus: "ok", attentionReasons: [] },
          total: { amountMinor: 12900, currency: "PLN" },
          pricingSummary,
          createdAt: "2026-06-05T10:00:00+00:00",
          updatedAt: "2026-06-05T10:01:00+00:00",
        },
      ],
      summaryCounts: {
        needsAttention: 1,
        activeHold: 0,
        readyForFulfillment: 0,
        paymentIssues: 0,
        inventoryRisk: 0,
        fulfillmentBlocked: 1,
        fulfillmentExceptions: 0,
        invoiceIssues: 0,
        omnipackDispatchedNotPicked: 0,
      },
      summaryTotals: {
        gmv: { amountMinor: 12900, currency: "PLN" },
        aov: { amountMinor: 12900, currency: "PLN" },
        orderCount: 1,
        paidSubscriptionCycleCount: 1,
      },
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(parsed.orders[0]?.nextAction).toBe("review_fulfillment");
  });

  it("validates hidden hold mutations without provider/payment fields", () => {
    expect(
      adminCommerceOrderHoldRequestSchema.parse({
        idempotencyKey: "oms-hold-1",
        orderId: "42222222-2222-4222-8222-222222222221",
        reason: "manual_support",
      }),
    ).toMatchObject({ reason: "manual_support" });

    expect(
      adminCommerceOrderHoldRequestSchema.safeParse({
        idempotencyKey: "oms-hold-1",
        orderId: "42222222-2222-4222-8222-222222222221",
        reason: "payment.succeeded",
      }).success,
    ).toBe(false);
  });

  it("keeps payment-control timeline separate in detail response", () => {
    const parsed = adminCommerceOrderDetailResponseSchema.parse({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      order: {
        orderId: "42222222-2222-4222-8222-222222222221",
        orderNumber: "V-1001",
        clientId: null,
        customer: null,
        pet: null,
        status: "paid",
        mode: "one_time",
        paymentMethodLabel: "BLIK",
        paymentProvider: "tpay",
        paymentStatus: "succeeded",
        fulfillmentStatus: "label_created",
        customerFulfillmentStep: "accepted",
        inventoryStatus: "reserved",
        accountingStatus: "issued",
        attentionReason: "none",
        nextAction: "none",
        activeHoldCount: 0,
        activeHoldReasons: [],
        fulfillmentHealthDigest: { healthStatus: "ok", attentionReasons: [] },
        total: { amountMinor: 12900, currency: "PLN" },
        pricingSummary,
        createdAt: "2026-06-05T10:00:00+00:00",
        updatedAt: "2026-06-05T10:01:00+00:00",
        shippingAddress: null,
        billingAddress: null,
        lines: [],
        subscription: {
          subscriptionId: null,
          subscriptionCycleId: null,
          subscriptionCycleStatus: null,
          nextCycleAt: null,
          cyclePaidAt: null,
        },
        inventory: {
          status: "reserved",
          reservationId: "92222222-2222-4222-8222-222222222222",
          reservationStatus: "reserved",
          expiresAt: "2026-06-05T10:30:00+00:00",
          locationId: "a2222222-2222-4222-8222-222222222222",
          locationCode: "pl-main",
        },
        fulfillment: {
          fulfillmentOrderId: "a2222222-2222-4222-8222-222222222222",
          status: "label_created",
          latestOperationType: "label_created",
          latestOperationAt: "2026-06-05T10:03:00+00:00",
          providerTrackingId: "NOOP-TRACK-1",
        },
        fulfillmentHealth: {
          healthStatus: "ok",
          attentionReasons: [],
          oldestAgeSeconds: null,
          opaqueIds: {
            orderId: "42222222-2222-4222-8222-222222222221",
            fulfillmentOrderId: "a2222222-2222-4222-8222-222222222222",
            outboxEventId: null,
            dispatchRefFulfillmentOrderId: null,
            latestEvidenceFulfillmentOrderId: null,
          },
        },
        accounting: {
          status: "issued",
          invoiceId: null,
          invoiceRef: "FV/1001",
          providerKind: null,
          providerInvoiceNumber: null,
          ksefStatus: null,
          outboxStatus: null,
          outboxAttemptCount: null,
          outboxNextAttemptAt: null,
          outboxLastError: null,
          recoveryGuidance: "none",
          updatedAt: "2026-06-05T10:04:00+00:00",
        },
        fulfillmentEligibility: { allowed: true, reason: null },
        actionEligibility: {
          addNote: { allowed: true, reason: null },
          createHold: { allowed: true, reason: null },
          releaseHold: { allowed: false, reason: "No active hold" },
          createFulfillment: { allowed: false, reason: "Fulfillment already exists" },
          updateShippingAddress: { allowed: false, reason: "Label already created" },
          recordLabel: { allowed: false, reason: "Label already created" },
          handOff: { allowed: true, reason: null },
          recordTrackingEvent: { allowed: false, reason: "tracking_not_ready" },
          cancelFulfillment: { allowed: false, reason: "fulfillment_not_cancellable" },
          cancelOrder: { allowed: false, reason: "order_not_pending_payment" },
          markRefunded: { allowed: true, reason: null },
        },
        holds: [],
        operations: [],
        payment: {
          intentId: "52222222-2222-4222-8222-222222222221",
          paymentId: "62222222-2222-4222-8222-222222222221",
          status: "succeeded",
          activeAttemptId: "72222222-2222-4222-8222-222222222221",
          providerPaymentId: "psp_1",
          updatedAt: "2026-06-05T10:01:00+00:00",
        },
        paymentAttempts: [],
        paymentTransitions: [
          {
            id: "82222222-2222-4222-8222-222222222221",
            transitionKind: "business_result",
            fromStatus: "processing",
            toStatus: "succeeded",
            reason: "state_changed",
            occurredAt: "2026-06-05T10:01:00+00:00",
          },
        ],
        communicationDeliveries: [],
      },
    });

    expect(parsed.order.operations).toEqual([]);
    expect(parsed.order.paymentTransitions).toHaveLength(1);
  });
});
