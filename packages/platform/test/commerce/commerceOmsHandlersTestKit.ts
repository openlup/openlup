import type { TestResponse } from "./omsConformanceTestKit.js";
import type { OmsHandlerRequest as TestRequest } from "../../src/commerce/server/handlerSupport.js";
import { vi } from "vitest";
import { COMMERCE_CONTRACT_VERSION } from "../../src/pricing/contracts/index.js";
import { deliveryContactFixture } from "./omsNeutralFixtures.js";
import type {
  AdminCommerceOrderHoldResponse,
  AdminCommerceOrderMarkRefundedResponse,
  AdminCommerceOrderNoteResponse,
  AdminCommerceOrderUpdateShippingAddressResponse,
  AdminCommerceOrdersListResponse,
} from "../../src/commerce/oms/omsContracts.js";

export function request(method: string, body?: unknown, query: Record<string, unknown> = {}): TestRequest {
  return { method, body, query, headers: {} } as TestRequest;
}

export function response(): TestResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as TestResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

export function authorize(
  result:
    | { ok: true; userId: string }
    | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string } = {
    ok: true,
    userId: "admin-user-1",
  },
) {
  return vi.fn().mockResolvedValue(result);
}

export function listResponse(): AdminCommerceOrdersListResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orders: [
      {
        orderId: "42222222-2222-4222-8222-222222222221",
        orderNumber: null,
        clientId: null,
        customer: null,
        status: "paid",
        mode: "one_time",
        paymentMethodLabel: "Card",
        paymentProvider: "example-card",
        paymentStatus: "succeeded",
        fulfillmentStatus: null,
        customerFulfillmentStep: "paid",
        inventoryStatus: "missing",
        accountingStatus: "missing",
        providerOpsStatus: "none",
        providerOpsSla: null,
        providerOrderId: null,
        attentionReason: "missing_shipping_address",
        nextAction: "review_address",
        activeHoldCount: 0,
        activeHoldReasons: [],
        fulfillmentHealthDigest: { healthStatus: "ok", attentionReasons: [] },
        total: { amountMinor: 12900, currency: "XXX" },
        pricingSummary: {
          subtotal: { amountMinor: 12900, currency: "XXX" },
          productDiscount: { amountMinor: 0, currency: "XXX" },
          shipping: { amountMinor: 0, currency: "XXX" },
          shippingDiscount: { amountMinor: 0, currency: "XXX" },
          discountTotal: { amountMinor: 0, currency: "XXX" },
          finalTotal: { amountMinor: 12900, currency: "XXX" },
          source: "order_columns",
        },
        createdAt: "2026-06-05T10:00:00+00:00",
        updatedAt: "2026-06-05T10:01:00+00:00",
      },
    ],
    summaryCounts: {
      needsAttention: 1,
      activeHold: 0,
      readyForFulfillment: 0,
      paymentIssues: 0,
      inventoryRisk: 1,
      fulfillmentBlocked: 0,
      fulfillmentExceptions: 0,
      invoiceIssues: 0,
      providerDispatchedNotPicked: 0,
    },
    summaryTotals: {
      gmv: { amountMinor: 12900, currency: "XXX" },
      aov: { amountMinor: 12900, currency: "XXX" },
      orderCount: 1,
      paidSubscriptionCycleCount: 0,
    },
    totalCount: 1,
    page: 1,
    pageSize: 25,
  };
}

export function holdRequest() {
  return {
    idempotencyKey: "oms-hold-1",
    orderId: "42222222-2222-4222-8222-222222222221",
    reason: "manual_support" as const,
  };
}

export function updateShippingAddressRequest() {
  return {
    idempotencyKey: "oms-address-1",
    orderId: "42222222-2222-4222-8222-222222222221",
    expectedRevision: 1,
    expectedContactDigest: "0123456789abcdef0123456789abcdef",
    address: {
      recipientName: "Example Person", contactEmail: "person@example.invalid", contactPhone: "000000001",
      line1: "Example Road 1", city: "Example City", postalCode: "EXAMPLE-001", country: "XX",
    },
  };
}

export function noteRequest() {
  return {
    idempotencyKey: "oms-note-1",
    orderId: "42222222-2222-4222-8222-222222222221",
    note: "Call customer before shipment",
  };
}

export function noteResponse(): AdminCommerceOrderNoteResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    operation: {
      id: "b2222222-2222-4222-8222-222222222223",
      orderId: "42222222-2222-4222-8222-222222222221",
      type: "support_note",
      holdId: null,
      actorUserId: "72222222-2222-4222-8222-222222222221",
      occurredAt: "2026-06-05T10:06:00+00:00",
      payload: { note: "Call customer before shipment" },
    },
    replayed: false,
  };
}

export function markRefundedRequest() {
  return {
    idempotencyKey: "oms-mark-refunded-1", // gitleaks:allow
    orderId: "42222222-2222-4222-8222-222222222221",
    reason: "operator confirmed example payment provider panel refund",
  };
}

export function markRefundedResponse(): AdminCommerceOrderMarkRefundedResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orderId: "42222222-2222-4222-8222-222222222221",
    status: "refunded",
    replayed: false,
  };
}

export function updateShippingAddressResponse(): AdminCommerceOrderUpdateShippingAddressResponse {
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
      actorUserId: null,
      occurredAt: "2026-06-05T10:05:00+00:00",
      payload: { source: "commerce.oms.v0" },
    },
    address: {
      recipientName: "Example Person", contactEmail: "person@example.invalid", contactPhone: "000000001",
      line1: "Example Road 1", line2: null, city: "Example City", postalCode: "EXAMPLE-001", country: "XX",
    },
    replayed: false,
  };
}

export function holdResponse(): AdminCommerceOrderHoldResponse {
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
