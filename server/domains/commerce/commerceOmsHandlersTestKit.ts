import { vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { deliveryContactFixture } from "../../../src/domains/commerce/omsClient.fixtures.js";
import type {
  AdminCommerceOrderHoldResponse,
  AdminCommerceOrderMarkRefundedResponse,
  AdminCommerceOrderNoteResponse,
  AdminCommerceOrderUpdateShippingAddressResponse,
  AdminCommerceOrdersListResponse,
} from "../../../src/domains/commerce/omsContracts.js";

export function request(method: string, body?: unknown, query: Record<string, unknown> = {}): VercelRequest {
  return { method, body, query, headers: {} } as VercelRequest;
}

export function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
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
        pet: null,
        status: "paid",
        mode: "one_time",
        paymentMethodLabel: "Karta",
        paymentProvider: "stripe",
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
      omnipackDispatchedNotPicked: 0,
    },
    summaryTotals: {
      gmv: { amountMinor: 12900, currency: "PLN" },
      aov: { amountMinor: 12900, currency: "PLN" },
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
      recipientName: "Ala Kowalska", contactEmail: "ala@example.com", contactPhone: "500600700",
      line1: "Prosta 1", city: "Warszawa", postalCode: "00-001", country: "PL",
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
    reason: "operator confirmed Tpay panel refund",
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
      recipientName: "Ala Kowalska", contactEmail: "ala@example.com", contactPhone: "500600700",
      line1: "Prosta 1", line2: null, city: "Warszawa", postalCode: "00-001", country: "PL",
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
