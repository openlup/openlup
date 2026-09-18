import { describe, expect, it, vi } from "vitest";
import { createCapturedSubscriptionDunningDeliveryPort, createCapturedSubscriptionDunningEmailPort } from "./capturedSubscriptionDunningDeliveryPort.js";
describe("local reference captured dunning delivery", () => {
  it("records acceptance without forwarding the recipient or recovery credential", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const delivery = createCapturedSubscriptionDunningDeliveryPort({
      client: { rpc }, clock: { now: () => new Date("2026-06-18T12:00:00.000Z") },
    });
    const port = createCapturedSubscriptionDunningEmailPort(delivery);
    const outcome = await port.sendPaymentFailed({
      to: "customer@example.test", firstName: "Customer", amountLabel: "129.99 USD", retryAttempt: 2,
      nextRetryDateLabel: null, methodScheme: null, methodLastDigits: null,
      recoveryUrl: "https://example.test/recover?token=raw-secret",
      cause: "unknown" as const,
      templateSlug: "subscription-payment-failed-2",
      notificationId: "d4000000-0000-0000-0000-000000000001",
      locale: "en", signal: new AbortController().signal,
    });
    expect(outcome.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "subscription_dunning_record_email_attempt",
      expect.objectContaining({ p_status: "sent", p_sent_at: "2026-06-18T12:00:00.000Z" }),
    );
    expect(JSON.stringify(rpc.mock.calls[0]?.[1])).not.toMatch(/raw-secret|customer@example\.test/);
  });
});
