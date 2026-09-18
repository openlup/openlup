import { describe, expect, it } from "vitest";
import {
  OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG,
  OUTBOX_ORDER_PAID_TEMPLATE_SLUG,
  OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG,
  OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG,
  OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG,
  OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG,
  OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG,
} from "./outboxOrderDraftEmailPorts.js";

// Companion contract test: the email-send dedupe key is single-sourced from these
// slug constants (the handler's findExistingSend filter and the Resend adapter's
// ledger insert must share the exact value), so pin them here. Adding the
// shipment-exception slug must not drift the existing ones.
describe("outboxOrderDraftEmailPorts template slugs", () => {
  it("pins the canonical commerce template slugs", () => {
    expect(OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG).toBe("commerce-order-confirmation");
    expect(OUTBOX_ORDER_PAID_TEMPLATE_SLUG).toBe("commerce-order-paid");
    expect(OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG).toBe("commerce-payment-failed");
    expect(OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG).toBe("commerce-checkout-expired");
    expect(OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG).toBe("commerce-shipment-dispatched");
    expect(OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG).toBe("commerce-shipment-delivered");
    expect(OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG).toBe("commerce-shipment-exception");
  });

  it("keeps shipment slugs distinct", () => {
    const shipment = [
      OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG,
      OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG,
      OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG,
    ];
    expect(new Set(shipment).size).toBe(shipment.length);
  });
});
