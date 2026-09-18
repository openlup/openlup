import type { OmnipackCarrierCase } from "./carrierCases.ts";

// Synthetic, signed OmniPack provider webhooks (W4). Real provider-initiated webhooks
// need our preview URL registered in the OmniPack account (a Łukasz follow-up); the
// self-serve e2e posts these SIGNED (Bearer OMNIPACK_WEBHOOK_TOKEN) payloads to the same
// routes the real provider would call. The concrete route owns the event, so the
// serialized body carries only correlation/status evidence and shipment tracking
// for shipped/delivered.

export type OmnipackWebhookEvent =
  | "shipment.accepted"
  | "order.processing_started"
  | "order.picked"
  | "order.shipped"
  | "order.delivered";

const EVENT_SPACING_MS = 1_000;
const LIFECYCLE_EVENTS: OmnipackWebhookEvent[] = [
  "shipment.accepted",
  "order.processing_started",
  "order.picked",
  "order.shipped",
  "order.delivered",
];

const ROUTE_BY_EVENT: Record<OmnipackWebhookEvent, string> = {
  "shipment.accepted": "/api/bff/fulfillment/webhooks/omnipack/shipment-accepted",
  "order.processing_started": "/api/bff/fulfillment/webhooks/omnipack/order-processing",
  "order.picked": "/api/bff/fulfillment/webhooks/omnipack/order-picked",
  "order.shipped": "/api/bff/fulfillment/webhooks/omnipack/order-shipped",
  "order.delivered": "/api/bff/fulfillment/webhooks/omnipack/order-delivered",
};

export interface SyntheticWebhookInput {
  event: OmnipackWebhookEvent;
  orderId: string;
  orderNumber: string;
  fulfilmentNumber: string;
  occurredAt: string;
  carrierCase: OmnipackCarrierCase;
}

export function buildLifecycleInputs(args: {
  carrierCase: OmnipackCarrierCase;
  providerOrderId: string;
  orderNumber: string;
  occurredAt: string;
}): SyntheticWebhookInput[] {
  const baseTime = Date.parse(args.occurredAt);
  if (!Number.isFinite(baseTime)) throw new Error("invalid_occurred_at");
  if (baseTime > Date.now() + 5_000) throw new Error("future_occurred_at_forbidden");
  return LIFECYCLE_EVENTS.map((event, index) => ({
    event,
    orderId: args.providerOrderId,
    orderNumber: args.orderNumber,
    fulfilmentNumber: `FUL-${args.carrierCase.id}`,
    occurredAt: new Date(baseTime - (LIFECYCLE_EVENTS.length - 1 - index) * EVENT_SPACING_MS).toISOString(),
    carrierCase: args.carrierCase,
  }));
}

export function buildOmnipackWebhookPayload(input: SyntheticWebhookInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    fulfilmentNumber: input.fulfilmentNumber,
    occurredAt: input.occurredAt,
  };
  if (input.event === "order.shipped" || input.event === "order.delivered") {
    payload.shipments = [
      {
        trackingNo: input.carrierCase.tracking.trackingNo,
        shippingMethod: input.carrierCase.tracking.shippingMethod,
        trackingUrl: input.carrierCase.tracking.trackingUrl,
      },
    ];
  }
  return payload;
}

export function omnipackWebhookRoute(event: OmnipackWebhookEvent): string {
  return ROUTE_BY_EVENT[event];
}

export interface PostWebhookResult {
  status: number;
  body: unknown;
}

// Posts a signed synthetic webhook. The route authenticates the Bearer token via
// verifyOmnipackWebhookToken, so we present it exactly as the real provider would.
export async function postOmnipackWebhook(args: {
  baseUrl: string;
  webhookToken: string;
  input: SyntheticWebhookInput;
  fetchImpl?: typeof fetch;
}): Promise<PostWebhookResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const url = `${args.baseUrl.replace(/\/+$/, "")}${omnipackWebhookRoute(args.input.event)}`;
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.webhookToken}`,
    },
    body: JSON.stringify(buildOmnipackWebhookPayload(args.input)),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
