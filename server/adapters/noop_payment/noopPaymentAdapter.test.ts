import { describe, expect, it } from "vitest";
import { createNoopPaymentAdapter } from "./noopPaymentAdapter.js";

describe("noopPaymentAdapter", () => {
  it("initiatePayment returns a pending PaymentSession with a client_secret + redirect next_action", async () => {
    const adapter = createNoopPaymentAdapter();
    const session = await adapter.initiatePayment({
      amount_minor: 14900,
      currency: "PLN",
      customer_ref: "client_lamb",
    });

    expect(session.state).toBe("pending");
    expect(session.client_secret).toMatch(/^noop_client_secret_/);
    expect(session.next_action_kind).toBe("redirect");
    expect(session.raw_provider_payload.provider_kind).toBe("noop_payment");
  });

  it("capturePayment transitions to succeeded", async () => {
    const adapter = createNoopPaymentAdapter();
    const captured = await adapter.capturePayment("noop_session_42");
    expect(captured.state).toBe("succeeded");
  });

  it("refundPayment returns a deterministic refund id and the requested amount", async () => {
    const adapter = createNoopPaymentAdapter();
    const refund = await adapter.refundPayment("noop_payment_42", 990);
    expect(refund.refund_provider_id).toMatch(/^noop_refund_/);
    expect(refund.amount_minor).toBe(990);
    expect(refund.state).toBe("succeeded");
  });

  it("parseWebhook canonicalises raw payloads", () => {
    const adapter = createNoopPaymentAdapter();
    const event = adapter.parseWebhook({
      event_id: "evt_001",
      event_type: "payment.succeeded",
      payment_id: "pay_001",
      amount_minor: 14900,
    });
    expect(event.provider_event_id).toBe("evt_001");
    expect(event.event_type).toBe("payment.succeeded");
    expect(event.payment_provider_id).toBe("pay_001");
    expect(event.amount_minor).toBe(14900);
  });
});
