import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  buildProviderEventId,
  createOmnipackWebhookHandler,
  OmnipackFulfillmentStateConflict,
  verifyOmnipackWebhookToken,
  type OmnipackWebhookPort,
} from "./omnipackWebhookHandler.js";

const INBOUND_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const STATUS_EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";
const DISPATCH_REF_ID = "33333333-3333-4333-8333-333333333333";
const FULFILLMENT_ORDER_ID = "44444444-4444-4444-8444-444444444444";

describe("OmniPack webhook handler", () => {
  it("fails closed before DB work when disabled", async () => {
    const port = fakePort();
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.shipped",
      enabled: () => false,
      verifyToken: () => true,
      port,
      parsePayload: async () => parsedWebhook(ORDER_SHIPPED),
    });
    const res = createResponse();

    await handler(request(), res);

    expect(port.ingestInboundEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("rejects missing or wrong token before parsing or DB work", async () => {
    const port = fakePort();
    const parsePayload = vi.fn();
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.shipped",
      enabled: () => true,
      verifyToken: () => false,
      port,
      parsePayload,
    });
    const res = createResponse();

    await handler(request(), res);

    expect(parsePayload).not.toHaveBeenCalled();
    expect(port.ingestInboundEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("records matching shipped evidence after consuming provider stock, then handoff and tracking", async () => {
    const port = fakePort();
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.shipped",
      enabled: () => true,
      verifyToken: () => true,
      port,
      parsePayload: async (req) => parsedWebhook(req.body),
    });
    const res = createResponse();

    await handler(request("POST", ORDER_SHIPPED), res);

    const evidenceId = buildProviderEventId({
      provider: "omnipack",
      event: "order.shipped",
      providerOrderId: "provider-order-1",
      orderNumber: "openlup-order-1001",
      fulfilmentNumber: "FUL-1001",
      occurredAt: "2026-06-10T09:00:00+00:00",
      trackingNumbers: ["INPOST-TRACK-1001"],
      trackingReferences: [{
        trackingNumber: "INPOST-TRACK-1001",
        trackingUrl: "https://inpost.example/track/INPOST-TRACK-1001",
        carrierKind: "inpost",
        service: "INPOST_PACZKOMAT",
      }],
      shippingMethods: ["INPOST_PACZKOMAT"],
    });
    expect(port.ingestInboundEvent).toHaveBeenCalledWith(expect.objectContaining({
      providerEventId: evidenceId,
      eventType: "order.shipped",
      processingStatus: "received",
      payload: expect.objectContaining({
        event: "order.shipped",
        trackingNumbers: ["INPOST-TRACK-1001"],
        trackingReferences: [{
          trackingNumber: "INPOST-TRACK-1001",
          carrierKind: "inpost",
          service: "INPOST_PACZKOMAT",
          hasTrackingUrl: true,
        }],
      }),
    }));
    expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `omnipack:webhook:${evidenceId}:status`,
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      dispatchRefId: DISPATCH_REF_ID,
      providerStatus: "shipping",
      providerSubStatus: "order.shipped",
      localStatus: "in_transit",
      inboundProviderEventId: INBOUND_EVENT_ID,
    }));
    expect(port.markHandedOver).toHaveBeenCalledWith({
      idempotencyKey: `omnipack:webhook:${FULFILLMENT_ORDER_ID}:handoff`,
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      suppressDispatched: false,
    });
    expect(port.markProviderStockConsumed).toHaveBeenCalledWith({
      idempotencyKey: `omnipack:webhook:${FULFILLMENT_ORDER_ID}:provider-stock-consumed`,
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
    });
    // Finished-picking consumption comes first, then hand-over, then tracking.
    expect(vi.mocked(port.markProviderStockConsumed).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(port.markHandedOver).mock.invocationCallOrder[0]);
    expect(vi.mocked(port.acknowledgeDispatchAcceptance!).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(port.recordStatusEvidence).mock.invocationCallOrder[0]);
    expect(vi.mocked(port.markHandedOver).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(port.recordTrackingReference).mock.invocationCallOrder[0]);
    expect(port.recordTrackingReference).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `omnipack:webhook:${evidenceId}:tracking:INPOST-TRACK-1001`,
      orderId: "order-1",
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      trackingNumber: "INPOST-TRACK-1001",
      trackingUrl: "https://inpost.example/track/INPOST-TRACK-1001",
      carrierKind: "inpost",
      service: "INPOST_PACZKOMAT",
      status: "in_transit",
    }));
    expect(port.markInboundEventProcessed).toHaveBeenCalledWith({
      inboundProviderEventId: INBOUND_EVENT_ID,
      processingStatus: "processed",
      error: {},
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ status: "processed", trackingRefs: 1, trackingReadBacks: 1, replayed: false }),
    }));
  });

  it("consumes local reservations on order.picked without writing tracking refs", async () => {
    const issueAccountingInvoice = vi.fn(async () => undefined);
    const port = fakePort({ issueAccountingInvoice });
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.picked",
      enabled: () => true,
      verifyToken: () => true,
      port,
      parsePayload: async (req) => parsedWebhook(req.body),
    });
    const res = createResponse();

    await handler(request("POST", ORDER_PICKED), res);

    expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
      providerStatus: "ready_for_packing",
      providerSubStatus: "order.picked",
      localStatus: "packed",
    }));
    expect(port.markProviderStockConsumed).toHaveBeenCalledWith({
      idempotencyKey: `omnipack:webhook:${FULFILLMENT_ORDER_ID}:provider-stock-consumed`,
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
    });
    expect(port.markHandedOver).not.toHaveBeenCalled();
    expect(issueAccountingInvoice).not.toHaveBeenCalled();
    expect(port.recordTrackingReference).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ status: "processed", trackingRefs: 0 }),
    }));
  });

  it("issues the accounting invoice on the webhook-driven hand-over when enabled", async () => {
    const issueAccountingInvoice = vi.fn(async () => undefined);
    const port = fakePort({ issueAccountingInvoice });
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.shipped",
      enabled: () => true,
      verifyToken: () => true,
      port,
      parsePayload: async (req) => parsedWebhook(req.body),
    });
    const res = createResponse();

    await handler(request("POST", ORDER_SHIPPED), res);

    expect(issueAccountingInvoice).toHaveBeenCalledWith({
      idempotencyKey: `omnipack:webhook:${FULFILLMENT_ORDER_ID}:accounting-invoice`,
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
    });
    // invoice request happens after hand-over, before tracking.
    expect(vi.mocked(port.markHandedOver).mock.invocationCallOrder[0])
      .toBeLessThan(issueAccountingInvoice.mock.invocationCallOrder[0]);
  });

  it("settles out-of-order terminal events as processed (200) instead of 5xx-looping", async () => {
    const port = fakePort({
      recordTrackingReference: vi.fn(async () => {
        throw new OmnipackFulfillmentStateConflict("commerce_fulfillment_tracking_after_delivered_forbidden");
      }),
    });
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.shipped",
      enabled: () => true,
      verifyToken: () => true,
      port,
      parsePayload: async (req) => parsedWebhook(req.body),
    });
    const res = createResponse();

    await handler(request("POST", ORDER_SHIPPED), res);

    expect(port.markInboundEventProcessed).toHaveBeenCalledWith({
      inboundProviderEventId: INBOUND_EVENT_ID,
      processingStatus: "processed",
      error: { superseded: "commerce_fulfillment_tracking_after_delivered_forbidden" },
    });
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ status: "superseded" }),
    }));
  });

  it("propagates non-conflict write failures (real errors must not be swallowed)", async () => {
    const port = fakePort({
      markHandedOver: vi.fn(async () => {
        throw new Error("omnipack_webhook_handoff_write_failed:08006");
      }),
    });
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.shipped",
      enabled: () => true,
      verifyToken: () => true,
      port,
      parsePayload: async (req) => parsedWebhook(req.body),
    });

    await expect(handler(request("POST", ORDER_SHIPPED), createResponse())).rejects.toThrow(/handoff_write_failed/);
  });

  it("quarantines unknown dispatch refs without recording status evidence", async () => {
    const port = fakePort({
      findDispatchRef: vi.fn(async () => null),
    });
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.delivered",
      enabled: () => true,
      verifyToken: () => true,
      port,
      parsePayload: async (req) => parsedWebhook(req.body),
    });
    const res = createResponse();

    await handler(request("POST", ORDER_DELIVERED), res);

    expect(port.recordStatusEvidence).not.toHaveBeenCalled();
    expect(port.recordTrackingReference).not.toHaveBeenCalled();
    expect(port.markInboundEventProcessed).toHaveBeenCalledWith({
      inboundProviderEventId: INBOUND_EVENT_ID,
      processingStatus: "ignored",
      error: { reason: "omnipack_dispatch_ref_not_found" },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ status: "ignored_unknown_order" }),
    }));
  });

  it("suppresses a future-tense dispatched notification for delivered-first", async () => {
    const port = fakePort();
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.delivered",
      enabled: () => true,
      verifyToken: () => true,
      port,
      parsePayload: async (req) => parsedWebhook(req.body),
    });

    await handler(request("POST", ORDER_DELIVERED), createResponse());

    expect(port.markHandedOver).toHaveBeenCalledWith({
      idempotencyKey: `omnipack:webhook:${FULFILLMENT_ORDER_ID}:handoff`,
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      suppressDispatched: true,
    });
  });

  it("marks replayed events as replayed without duplicating response semantics", async () => {
    const port = fakePort({
      ingestInboundEvent: vi.fn(async () => ({ inboundProviderEventId: INBOUND_EVENT_ID, replayed: true })),
      recordStatusEvidence: vi.fn(async () => ({ statusEvidenceId: STATUS_EVIDENCE_ID, replayed: true })),
    });
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "shipment.accepted",
      enabled: () => true,
      verifyToken: () => true,
      port,
      parsePayload: async (req) => parsedWebhook(req.body),
    });
    const res = createResponse();

    await handler(request("POST", SHIPMENT_ACCEPTED), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ replayed: true }),
    }));
  });

  it("rejects route/payload mismatches before ingesting", async () => {
    const port = fakePort();
    const handler = createOmnipackWebhookHandler({
      expectedEvent: "order.picked",
      enabled: () => true,
      verifyToken: () => true,
      port,
      parsePayload: async (req) => parsedWebhook(req.body),
    });
    const res = createResponse();

    await handler(request("POST", ORDER_SHIPPED), res);

    expect(port.ingestInboundEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("accepts bearer and x-omnipack-webhook-token tokens", () => {
    expect(verifyOmnipackWebhookToken(request("POST", {}, { authorization: "Bearer secret" }), "secret")).toBe(true);
    expect(verifyOmnipackWebhookToken(request("POST", {}, { "x-omnipack-webhook-token": "secret" }), "secret")).toBe(true);
    expect(verifyOmnipackWebhookToken(request("POST", {}, { authorization: "Bearer wrong" }), "secret")).toBe(false);
  });
});

const SHIPMENT_ACCEPTED = {
  event: "shipment.accepted",
  orderId: "provider-order-1",
  orderNumber: "openlup-order-1001",
  fulfilmentNumber: "FUL-1001",
  occurredAt: "2026-06-10T08:05:00+00:00",
};

const ORDER_SHIPPED = {
  event: "order.shipped",
  orderId: "provider-order-1",
  orderNumber: "openlup-order-1001",
  fulfilmentNumber: "FUL-1001",
  occurredAt: "2026-06-10T09:00:00+00:00",
  shipments: [{
    trackingNo: "INPOST-TRACK-1001",
    shippingMethod: "INPOST_PACZKOMAT",
    trackingUrl: "https://inpost.example/track/INPOST-TRACK-1001",
  }],
};

const ORDER_PICKED = {
  event: "order.picked",
  orderId: "provider-order-1",
  orderNumber: "openlup-order-1001",
  fulfilmentNumber: "FUL-1001",
  occurredAt: "2026-06-10T08:45:00+00:00",
};

const ORDER_DELIVERED = {
  event: "order.delivered",
  orderId: "provider-order-1",
  orderNumber: "openlup-order-1001",
  fulfilmentNumber: "FUL-1001",
  occurredAt: "2026-06-11T12:00:00+00:00",
  shipments: [{ trackingNo: "INPOST-TRACK-1001", shippingMethod: "INPOST_PACZKOMAT" }],
};

function parsedWebhook(body: unknown) {
  const payload = body as {
    event?: string;
    orderId?: string;
    orderNumber?: string;
    fulfilmentNumber?: string;
    occurredAt?: string;
    shipments?: Array<{ trackingNo?: string; shippingMethod?: string; trackingUrl?: string }>;
  };
  return {
    evidence: {
      provider: "omnipack" as const,
      event: payload.event ?? "",
      providerOrderId: payload.orderId ?? null,
      orderNumber: payload.orderNumber ?? null,
      fulfilmentNumber: payload.fulfilmentNumber ?? null,
      occurredAt: payload.occurredAt ?? null,
      trackingNumbers: (payload.shipments ?? []).map((shipment) => shipment.trackingNo ?? "").filter(Boolean),
      trackingReferences: (payload.shipments ?? []).map((shipment) => ({
        trackingNumber: shipment.trackingNo ?? "",
        trackingUrl: shipment.trackingUrl ?? null,
        carrierKind: carrierKindFromService(shipment.shippingMethod ?? null),
        service: shipment.shippingMethod ?? null,
      })).filter((ref) => ref.trackingNumber),
      shippingMethods: (payload.shipments ?? []).map((shipment) => shipment.shippingMethod ?? "").filter(Boolean),
    },
    sanitizedPayload: { event: payload.event, orderNumber: payload.orderNumber },
  };
}

function fakePort(overrides: Partial<OmnipackWebhookPort> = {}): OmnipackWebhookPort {
  return {
    ingestInboundEvent: vi.fn(async () => ({ inboundProviderEventId: INBOUND_EVENT_ID, replayed: false })),
    findDispatchRef: vi.fn(async () => ({
      dispatchRefId: DISPATCH_REF_ID,
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      orderId: "order-1",
      providerOrderId: "provider-order-1",
    })),
    acknowledgeDispatchAcceptance: vi.fn(async (input) => ({
      dispatchRefId: input.dispatchRefId,
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      orderId: "order-1",
      providerOrderId: input.providerOrderId ?? "provider-order-1",
      dispatchStatus: "created" as const,
      fulfillmentStatus: "label_created",
      replayed: false,
    })),
    recordStatusEvidence: vi.fn(async () => ({ statusEvidenceId: STATUS_EVIDENCE_ID, replayed: false })),
    recordTrackingReference: vi.fn(async () => ({ replayed: false, readBack: true })),
    markHandedOver: vi.fn(async () => ({ status: "handed_over", replayed: false })),
    markProviderStockConsumed: vi.fn(async () => ({ status: "packed", replayed: false })),
    markInboundEventProcessed: vi.fn(async () => undefined),
    ...overrides,
  };
}

function carrierKindFromService(service: string | null): string | null {
  if (!service) return null;
  const [carrier] = service.split("_");
  return carrier ? carrier.toLowerCase() : null;
}

function request(
  method = "POST",
  body: unknown = {},
  headers: Record<string, string> = {},
): VercelRequest {
  return { method, body, query: {}, headers } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
