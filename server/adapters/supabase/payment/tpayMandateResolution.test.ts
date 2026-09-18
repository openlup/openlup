import { describe, expect, it, vi } from "vitest";

import { resolveMandateForSubscription } from "./tpayMandateResolution.js";
import type { TpaySubscriptionActivationClient } from "./tpaySubscriptionActivation.js";

const CANDIDATE = {
  orderId: "order-1",
  paymentIntentId: "intent-1",
  clientId: "client-1",
  subscriptionId: "sub-b",
};

function ref(id: string, providerMethodRef: string) {
  return {
    id,
    provider_kind: "tpay",
    method_kind: "blik_payid",
    provider_method_ref: providerMethodRef,
    status: "active",
    active: true,
  };
}

/**
 * Fake keyed on whether the query filtered by `subscription_id`, which is what
 * distinguishes the linked lookup from the client-wide one.
 */
function client(rows: { linked?: unknown; clientWide?: unknown[] }): TpaySubscriptionActivationClient {
  return {
    from: vi.fn(() => {
      let subscriptionScoped = false;
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = (column: string) => {
        if (column === "subscription_id") subscriptionScoped = true;
        return query;
      };
      query.order = () => query;
      query.limit = () => query;
      query.maybeSingle = () => Promise.resolve({ data: rows.linked ?? null, error: null });
      query.then = (resolve: (value: { data: unknown; error: null }) => unknown) =>
        resolve({ data: subscriptionScoped ? rows.linked ?? null : rows.clientWide ?? [], error: null });
      return query;
    }),
  } as unknown as TpaySubscriptionActivationClient;
}

describe("resolveMandateForSubscription", () => {
  it("uses the mandate explicitly linked to this subscription", async () => {
    const resolved = await resolveMandateForSubscription(
      client({ linked: ref("ref-b", "payid_b"), clientWide: [ref("ref-a", "payid_a")] }),
      CANDIDATE,
    );

    expect(resolved?.providerMethodRef).toBe("payid_b");
  });

  it("falls back to the client's single mandate, since one cannot be the wrong one", async () => {
    // Older refs can carry a null subscription link (the generic provider-webhook
    // path does not always know the subscription), so ordinary single-subscription
    // customers depend on this fallback.
    const resolved = await resolveMandateForSubscription(
      client({ linked: null, clientWide: [ref("ref-a", "payid_a")] }),
      CANDIDATE,
    );

    expect(resolved?.providerMethodRef).toBe("payid_a");
  });

  it("refuses to choose between several unlinked mandates", async () => {
    // The race this exists for: a customer running two subscriptions has two
    // mandates in flight, and `payment.succeeded` for the second can beat its
    // `ALIAS_REGISTER`. Guessing by recency would renew a subscription on a
    // consent its payer gave for a different one.
    const resolved = await resolveMandateForSubscription(
      client({ linked: null, clientWide: [ref("ref-a", "payid_a"), ref("ref-b", "payid_b")] }),
      CANDIDATE,
    );

    expect(resolved).toBeNull();
  });

  it("returns none when the client holds no mandate yet", async () => {
    const resolved = await resolveMandateForSubscription(
      client({ linked: null, clientWide: [] }),
      CANDIDATE,
    );

    expect(resolved).toBeNull();
  });
});
