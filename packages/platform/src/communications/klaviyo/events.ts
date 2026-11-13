import type { EcommerceEvent, EcommerceEventExportRequest } from "../contracts/ecommerceEvents.js";

// This version freezes metric identity and payload translation. A different mapping
// needs its own explicit qualification; it never changes an already retained request.
export const eventMappingVersion = "ecommerce-v1";
export const eventMetrics: Readonly<Record<EcommerceEvent["sourceType"], string>> = Object.freeze({
  "order.paid": "Placed Order",
  "order.refund_status_changed": "OpenLup Order Refund Status Changed",
  "checkout.recovery_qualified": "OpenLup Checkout Recovery Qualified",
  "subscription.created": "OpenLup Subscription Created",
  "subscription.paused": "OpenLup Subscription Paused",
  "subscription.resumed": "OpenLup Subscription Resumed",
  "subscription.cancelled": "OpenLup Subscription Cancelled",
});

function eventValue(minor: number, exponent: number): number | undefined {
  const value = minor / 10 ** exponent;
  // Compare the actual JSON decimal with the retained integer, not floating-point
  // multiplication: that can round a lost minor unit back to the original number.
  const [whole, fraction = ""] = JSON.stringify(value).split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > exponent) return;
  const units = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, "0") || "0");
  return units === BigInt(minor) ? value : undefined;
}

/** Existing profile ID only: Events API may otherwise create/update profiles. */
export function eventBody(request: EcommerceEventExportRequest) {
  const event = request.event;
  const value = event.sourceType === "order.paid" ? eventValue(event.data.amountMinor, request.currencyExponent!) : undefined;
  if (event.sourceType === "order.paid" && value === undefined) return;
  const properties = event.sourceType === "order.paid" ? {
    OrderId: event.data.orderId, PurchaseKind: event.data.purchaseKind,
    AmountMinor: event.data.amountMinor, CurrencyExponent: request.currencyExponent,
    Items: event.data.lines.map(line => ({ SKU: line.sku, Quantity: line.quantity, AmountMinor: line.amountMinor })),
  } : event.sourceType === "order.refund_status_changed" ? { OrderId: event.data.orderId, Status: event.data.status }
    : event.sourceType === "checkout.recovery_qualified" ? { OrderId: event.data.orderId, ExpiresAt: event.data.expiresAt }
      : { SubscriptionId: event.data.subscriptionId };
  return { data: { type: "event", attributes: {
    properties, time: event.occurredAt, unique_id: event.sourceId,
    profile: { data: { type: "profile", id: request.profileId } },
    metric: { data: { type: "metric", attributes: { name: eventMetrics[event.sourceType] } } },
    ...(event.sourceType === "order.paid" ? { value, value_currency: event.data.currency } : {}),
  } } };
}
