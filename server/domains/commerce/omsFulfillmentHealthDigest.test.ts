import { describe, expect, it } from "vitest";
import { buildOmsFulfillmentHealth } from "./omsFulfillmentHealth.js";
import { buildOmsFulfillmentHealthDigests } from "./omsFulfillmentHealthDigest.js";
import { omsFulfillmentHealthDigestSchema } from "../../../src/domains/commerce/omsFulfillmentHealthSchemas.js";

// Row shapes read off the digest builder's own input, so this suite cannot drift
// from the contract it exercises and needs no second copy of the row types.
type DigestInput = Parameters<typeof buildOmsFulfillmentHealthDigests>[0];
type OrderRow = DigestInput["orders"][number];
type PaymentIntentRow = DigestInput["paymentIntents"][number];
type FulfillmentOrderRow = DigestInput["fulfillmentOrders"][number];
type DispatchRefRow = DigestInput["dispatchRefs"][number];
type EvidenceRow = DigestInput["statusEvidence"][number];

const NOW = new Date("2026-06-05T11:00:00.000Z");
const ORDER_ID = "42222222-2222-4222-8222-222222222221";
const SIBLING_ORDER_ID = "42222222-2222-4222-8222-222222222299";
const FULFILLMENT_ID = "52222222-2222-4222-8222-222222222221";
const DISPATCH_REF_ID = "82222222-2222-4222-8222-222222222221";
const OUTBOX_ID = "72222222-2222-4222-8222-222222222221";
const HANDED_OVER_AT = "2026-06-05T09:30:00.000Z";

describe("OMS fulfillmentHealth list digest", () => {
  it("reaches the queue digest through the shared builder, not a second rule", () => {
    const digests = buildOmsFulfillmentHealthDigests({
      orders: [order()],
      paymentIntents: [succeededIntent()],
      fulfillmentOrders: [fulfillmentOrder({
        status: "in_transit",
        handed_over_at: HANDED_OVER_AT,
        updated_at: HANDED_OVER_AT,
      })],
      dispatchRefs: [dispatchRef()],
      statusEvidence: [evidence({
        local_status: "exception",
        provider_status: "SHIPPING_FAILED",
        occurred_at: "2026-06-05T10:00:00.000Z",
      })],
      now: NOW,
    });

    expect(digests[ORDER_ID]).toEqual({
      healthStatus: "needs_attention",
      attentionReasons: ["provider_exception_after_handover"],
    });
    expect(omsFulfillmentHealthDigestSchema.parse(digests[ORDER_ID])).toEqual(digests[ORDER_ID]);
  });

  it("agrees with the detail snapshot on identical inputs, minus the outbox-derived reasons", () => {
    // Parity is the whole contract of the digest: an operator reading a queue row
    // and the operator opening that order must not be told two different things.
    // The single permitted divergence is the outbox axis the list does not read.
    const inputs = {
      order: order(),
      fulfillmentOrders: [fulfillmentOrder({ status: "created" })],
      dispatchRefs: [dispatchRef({ provider_order_id: "" })],
      statusEvidence: [evidence()],
    };
    const detail = buildOmsFulfillmentHealth({
      ...inputs,
      paymentStatus: "succeeded",
      orderPaidOutboxEvents: [{ id: OUTBOX_ID, event_type: "commerce.order.paid", status: "processed" }],
      now: NOW,
    });
    const digests = buildOmsFulfillmentHealthDigests({
      orders: [inputs.order],
      paymentIntents: [succeededIntent()],
      fulfillmentOrders: inputs.fulfillmentOrders,
      dispatchRefs: inputs.dispatchRefs,
      statusEvidence: inputs.statusEvidence,
      now: NOW,
    });

    expect(detail.attentionReasons.some((reason) => reason.startsWith("order_paid_outbox_"))).toBe(false);
    expect(digests[ORDER_ID]).toEqual({
      healthStatus: detail.healthStatus,
      attentionReasons: detail.attentionReasons,
    });
    expect(omsFulfillmentHealthDigestSchema.parse(digests[ORDER_ID])).toEqual(digests[ORDER_ID]);
  });

  it("keeps one order's provider evidence out of a sibling row with no fulfillment order", () => {
    // The builder's internal evidence filter is a no-op when an order has no
    // fulfillment order, so the page-wide arrays must be narrowed before the call.
    const sibling = order({ id: SIBLING_ORDER_ID, order_number: "OMS-SIBLING" });
    const digests = buildOmsFulfillmentHealthDigests({
      orders: [order(), sibling],
      paymentIntents: [succeededIntent(), succeededIntent(SIBLING_ORDER_ID)],
      fulfillmentOrders: [fulfillmentOrder({ status: "created" })],
      dispatchRefs: [dispatchRef({ provider_order_id: "" })],
      statusEvidence: [evidence()],
      now: NOW,
    });

    expect(digests[ORDER_ID]?.attentionReasons).toEqual(["dispatch_created_without_provider_order_id"]);
    expect(digests[SIBLING_ORDER_ID]).toEqual({
      healthStatus: "missing_local_commitment",
      attentionReasons: ["paid_order_missing_fulfillment"],
    });
  });
});

function succeededIntent(orderId = ORDER_ID): PaymentIntentRow {
  return {
    id: `52222222-2222-4222-8222-${orderId.slice(-12)}`,
    order_id: orderId,
    payment_id: "62222222-2222-4222-8222-222222222221",
    status: "succeeded" as const,
    active_attempt_id: null,
    provider_payment_id: null,
    updated_at: "2026-06-05T10:01:00.000Z",
  };
}

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER_ID,
    order_number: "OPENLUP-HEALTH",
    client_id: "41111111-1111-4111-8111-111111111111",
    status: "paid",
    mode: "one_time",
    currency: "PLN",
    subtotal_cents: 12900,
    discount_cents: 0,
    shipping_cents: 0,
    shipping_discount_cents: 0,
    tax_cents: 0,
    total_cents: 12900,
    metadata: null,
    created_at: "2026-06-05T09:00:00.000Z",
    updated_at: "2026-06-05T10:00:00.000Z",
    subscription_id: null,
    subscription_cycle_id: null,
    shipping_address_id: "45555555-5555-4555-8555-555555555555",
    ...overrides,
  };
}

function fulfillmentOrder(overrides: Partial<FulfillmentOrderRow> = {}): FulfillmentOrderRow {
  return {
    id: FULFILLMENT_ID,
    order_id: ORDER_ID,
    status: "created",
    provider_kind: "omnipack",
    created_at: "2026-06-05T10:00:00.000Z",
    updated_at: "2026-06-05T10:00:00.000Z",
    ...overrides,
  };
}

function dispatchRef(overrides: Partial<DispatchRefRow> = {}): DispatchRefRow {
  return {
    id: DISPATCH_REF_ID,
    fulfillment_order_id: FULFILLMENT_ID,
    provider_order_id: "dispatch-order-1",
    status: "created",
    created_at: "2026-06-05T10:20:00.000Z",
    updated_at: "2026-06-05T10:20:00.000Z",
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    fulfillment_order_id: FULFILLMENT_ID,
    provider_status: "NEW",
    provider_sub_status: "READY_FOR_EXPORT",
    local_status: "provider_received",
    evidence_kind: "reconciliation",
    occurred_at: "2026-06-05T10:00:00.000Z",
    created_at: "2026-06-05T10:01:00.000Z",
    ...overrides,
  };
}
