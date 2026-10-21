import { expect, it } from "vitest";
import { mapOmnipackWebhookPayload } from "../../../src/fulfillment/omnipack/mappers.js";
import { buildProviderEventId, EVENT_TO_STATUS, verifyOmnipackWebhookToken } from "../../../src/fulfillment/omnipack/omnipackWebhookPayload.js";
import { localStatusFor, normalizeStatus } from "../../../src/fulfillment/omnipack/omnipackStatusVocabulary.js";
import { providerOccurrenceKey } from "../../../src/fulfillment/omnipack/omnipackReconciliationPayload.js";

it("accepts the donor token forms and rejects missing or incorrect tokens", () => {
  const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  for (const headers of [{ authorization: "Bearer placeholder" }, { "x-omnipack-webhook-token": "placeholder" }, { Authorization: basic("example", "placeholder") }]) {
    expect(verifyOmnipackWebhookToken({ headers }, "placeholder")).toBe(true);
  }
  for (const headers of [{ authorization: "Bearer wrong" }, { authorization: basic("example", "wrong") }, { authorization: basic("", "placeholder") }, { authorization: basic(" ", "placeholder") }, { authorization: "Basic not-base64" }, {}]) {
    expect(verifyOmnipackWebhookToken({ headers }, "placeholder")).toBe(false);
  }
  expect(verifyOmnipackWebhookToken({ headers: { authorization: "Bearer placeholder" } }, undefined)).toBe(false);
});
it("binds event identity to subject, outcome and occurrence with explicit unknown fallbacks", () => {
  const evidence = mapOmnipackWebhookPayload({ event: "order.shipped", orderId: "provider-1", orderNumber: "ORDER-1", fulfilmentNumber: "FUL-1", occurredAt: "2026-06-10T09:00:00Z" });
  expect(buildProviderEventId(evidence)).toBe("order.shipped:provider-1:FUL-1:2026-06-10T09:00:00Z");
  for (const delta of [{ event: "order.delivered" }, { providerOrderId: "provider-2" }, { occurredAt: "2026-06-11T09:00:00Z" }]) expect(buildProviderEventId({ ...evidence, ...delta })).not.toBe(buildProviderEventId(evidence));
  expect(buildProviderEventId({ ...evidence, providerOrderId: null, fulfilmentNumber: null, occurredAt: null })).toBe("order.shipped:ORDER-1:unknown-fulfilment:unknown-time");
  expect(providerOccurrenceKey("fulfillment-1", "shipping", null)).toBe("fulfillment-1:shipping:unknown-time");
  expect(providerOccurrenceKey("fulfillment-2", "delivered", "2026-06-11T09:00:00Z")).toBe("fulfillment-2:delivered:2026-06-11T09:00:00Z");
});
it("quarantines unknown taxonomy and maps routes through the primary status vocabulary", () => {
  for (const value of ["UNKNOWN", "Some brand new state", null, "Processing", "In transit"]) expect(normalizeStatus(value)).toBeNull();
  for (const [status, local] of [["NEW", "provider_received"], ["IN_FULFILLMENT", "picking"], ["READY_FOR_PACKING", "packed"], ["AWAITING_COURIER", "packed"], ["SHIPPING", "in_transit"], ["DELIVERED", "delivered"], ["SHIPPING_FAILED", "exception"], ["RETURNED_TO_SENDER", "exception"], ["SUSPENDED", "exception"], ["CANCELLED", "exception"]]) expect(localStatusFor(normalizeStatus(status)!)).toBe(local);
  expect(Object.keys(EVENT_TO_STATUS)).toHaveLength(5);
  expect(Object.entries(EVENT_TO_STATUS).filter(([, status]) => localStatusFor(status) === "delivered").map(([event]) => event)).toEqual(["order.delivered"]);
});
