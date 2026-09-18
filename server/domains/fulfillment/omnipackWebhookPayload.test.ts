import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../../_lib/types/vercel.js";
import type { OmnipackWebhookEvidence } from "./omnipackWebhookHandler.js";
import {
  EVENT_TO_STATUS,
  buildProviderEventId,
  buildStoredPayload,
  uniqueTrackingReferences,
  verifyOmnipackWebhookToken,
} from "./omnipackWebhookPayload.js";

function evidence(overrides: Partial<OmnipackWebhookEvidence> = {}): OmnipackWebhookEvidence {
  return {
    provider: "omnipack",
    event: "order.shipped",
    providerOrderId: "provider-order-1",
    orderNumber: "openlup-1001",
    fulfilmentNumber: "FUL-1001",
    occurredAt: "2026-06-10T09:00:00+00:00",
    trackingNumbers: ["TRK-1", "TRK-1", "TRK-2"],
    trackingReferences: [
      { trackingNumber: "TRK-1", trackingUrl: "https://t.example/TRK-1", carrierKind: "inpost", service: "INPOST_PACZKOMAT" },
    ],
    shippingMethods: ["INPOST_PACZKOMAT"],
    ...overrides,
  };
}

function request(headers: Record<string, string> = {}): VercelRequest {
  return { method: "POST", headers, query: {} } as unknown as VercelRequest;
}

describe("omnipack webhook payload helpers", () => {
  // The route table now emits the SAME normalized vocabulary the poller uses,
  // so the local mapping has exactly one owner (localStatusFor) and the webhook
  // path no longer carries a private token set with a terminal-state default.
  // The push/pull conformance itself is asserted in the vocabulary suite.
  it("maps each route event to a normalized provider status", () => {
    expect(EVENT_TO_STATUS["order.shipped"]).toBe("shipping");
    expect(EVENT_TO_STATUS["order.delivered"]).toBe("delivered");
    expect(EVENT_TO_STATUS["shipment.accepted"]).toBe("new");
    expect(EVENT_TO_STATUS["order.processing_started"]).toBe("in_fulfillment");
    expect(EVENT_TO_STATUS["order.picked"]).toBe("ready_for_packing");
  });

  it("builds a deterministic provider event id and falls back when fields are missing", () => {
    expect(buildProviderEventId(evidence())).toBe("order.shipped:provider-order-1:FUL-1001:2026-06-10T09:00:00+00:00");
    expect(buildProviderEventId(evidence({ providerOrderId: null, fulfilmentNumber: null, occurredAt: null })))
      .toBe("order.shipped:openlup-1001:unknown-fulfilment:unknown-time");
  });

  it("dedupes tracking references by tracking number", () => {
    const refs = uniqueTrackingReferences(evidence());
    expect(refs.map((r) => r.trackingNumber)).toEqual(["TRK-1", "TRK-2"]);
    expect(refs[0]).toMatchObject({ carrierKind: "inpost", service: "INPOST_PACZKOMAT" });
  });

  it("builds a sanitized stored payload without leaking the raw tracking url", () => {
    const stored = buildStoredPayload(evidence(), { event: "order.shipped" });
    expect(stored).toMatchObject({ provider: "omnipack", event: "order.shipped", orderNumber: "openlup-1001" });
    expect(stored.trackingReferences).toEqual([
      { trackingNumber: "TRK-1", carrierKind: "inpost", service: "INPOST_PACZKOMAT", hasTrackingUrl: true },
      { trackingNumber: "TRK-2", carrierKind: null, service: null, hasTrackingUrl: false },
    ]);
  });

  it("verifies the webhook token via bearer or header, rejecting when unset", () => {
    expect(verifyOmnipackWebhookToken(request({ authorization: "Bearer secret" }), "secret")).toBe(true);
    expect(verifyOmnipackWebhookToken(request({ "x-omnipack-webhook-token": "secret" }), "secret")).toBe(true);
    expect(verifyOmnipackWebhookToken(request({ authorization: "Bearer wrong" }), "secret")).toBe(false);
    expect(verifyOmnipackWebhookToken(request({ authorization: "Bearer secret" }), undefined)).toBe(false);
  });

  it("verifies Basic Auth with a non-empty username and webhook token password", () => {
    expect(verifyOmnipackWebhookToken(request({ authorization: basicAuth("openlup", "secret") }), "secret")).toBe(true);
    expect(verifyOmnipackWebhookToken(request({ Authorization: basicAuth("openlup", "secret") }), "secret")).toBe(true);
    expect(verifyOmnipackWebhookToken(request({ authorization: basicAuth("openlup", "wrong") }), "secret")).toBe(false);
    expect(verifyOmnipackWebhookToken(request({ authorization: basicAuth("", "secret") }), "secret")).toBe(false);
    expect(verifyOmnipackWebhookToken(request({ authorization: basicAuth(" ", "secret") }), "secret")).toBe(false);
    expect(verifyOmnipackWebhookToken(request({ authorization: "Basic not-base64" }), "secret")).toBe(false);
    expect(verifyOmnipackWebhookToken(request({ authorization: `Basic ${Buffer.from("openlup").toString("base64")}` }), "secret")).toBe(false);
  });
});

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
