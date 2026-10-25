import { describe, expect, it, vi } from "vitest";
import { createSubscriptionWebhookDunningAfterProcessedViaGateway } from "./paymentWebhookGateway.js";
import { paymentProviderCapabilityDescriptors } from "../../paymentProviderCapabilityRegistry.js";
import type { NormalizedProviderPaymentWebhook } from "../../../domains/payment/paymentWebhookHandlers.js";
import type { DataGatewayPort } from "../../../../src/domains/platform-runtime/ports.js";

function fixture(data: unknown, error: unknown = null) {
  const filters: Array<[string, string]> = [];
  const query = {
    eq(column: string, value: string) { filters.push([column, value]); return query; },
    then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data, error }).then(resolve); },
  };
  const rpc = vi.fn(async () => ({ data: {}, error: null }));
  const from = vi.fn(() => ({ select: vi.fn(() => query) }));
  const gateway = { asService: async (work: (client: unknown) => unknown) => work({ rpc, from }) } as DataGatewayPort;
  return { rpc, from, filters, run: createSubscriptionWebhookDunningAfterProcessedViaGateway(gateway) };
}
const providers = paymentProviderCapabilityDescriptors.map(descriptor => descriptor.providerKind as NormalizedProviderPaymentWebhook["provider"]);
function input(provider = providers[0]!) {
  return {
    event: { provider, providerEventId: "provider-event", eventType: "payment.failed" as const, providerPaymentId: "charge", paymentAttemptId: "untrusted-hint-B", occurredAt: "2026-10-25T09:00:00Z", rawPayload: {} },
    ingested: { paymentEventId: "stored-event", paymentIntentId: "intent", paymentAttemptId: "current-hint-C", replayed: true }, resultStatus: "failed" as const,
  };
}
describe("webhook dunning attribution at its gateway consumer", () => {
  it.each(providers)("uses the applied transition for %s", async provider => {
    const f = fixture([{ payment_attempt_id: "applied-A", to_status: "failed" }]);
    await f.run(input(provider));
    expect(f.from).toHaveBeenCalledWith("commerce_payment_state_transitions");
    expect(f.filters).toEqual([["provider_event_id", "stored-event"], ["payment_intent_id", "intent"], ["transition_kind", "business_result"]]);
    expect(f.rpc).toHaveBeenCalledWith("subscription_open_dunning_from_failed_payment_result", expect.objectContaining({ p_failed_payment_attempt_id: "applied-A", p_failure_class: null }));
  });
  it.each([
    { data: [], error: null, refusal: "unattributed" },
    { data: [{ payment_attempt_id: "A", to_status: "failed" }, { payment_attempt_id: "B", to_status: "failed" }], error: null, refusal: "ambiguous" },
    { data: [{ payment_attempt_id: null, to_status: "failed" }], error: null, refusal: "unattributed" },
    { data: [{ payment_attempt_id: "A", to_status: "succeeded" }], error: null, refusal: "unattributed" },
    { data: null, error: { message: "read failed" }, refusal: "lookup_failed" },
  ])("refuses $refusal before opening", async ({ data, error, refusal }) => {
    const f = fixture(data, error);
    await expect(f.run(input())).rejects.toThrow(`subscription_webhook_dunning_attempt_${refusal}`);
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
