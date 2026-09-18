import { describe, expect, it } from "vitest";
import {
  createSupabaseOrderPaymentLifecyclePort,
  type OrderPaymentLifecycleSupabaseClient,
} from "./orderPaymentLifecycle.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function fakeClient(input: {
  order?: { status: string; metadata?: Record<string, unknown> | null } | null;
  payment?: { status: string; updated_at?: string | null } | null;
}): OrderPaymentLifecycleSupabaseClient {
  const client = {
    from(table: string) {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle() {
          if (table === "commerce_orders") {
            return Promise.resolve({ data: input.order ?? null, error: null });
          }
          return Promise.resolve({ data: input.payment ?? null, error: null });
        },
        then<R>(onfulfilled: (value: { data: unknown; error: null }) => R) {
          return Promise.resolve(onfulfilled({ data: null, error: null }));
        },
      };
      return query;
    },
  };
  return client as unknown as OrderPaymentLifecycleSupabaseClient;
}

describe("supabase order payment lifecycle port", () => {
  it("returns order state with latest payment presence", async () => {
    const port = createSupabaseOrderPaymentLifecyclePort(fakeClient({
      order: { status: "pending_payment" },
      payment: { status: "succeeded", updated_at: "2026-06-20T00:00:00.000Z" },
    }));

    await expect(port.read(ORDER_ID, new AbortController().signal)).resolves.toEqual({
      orderStatus: "pending_payment",
      paymentStatus: "succeeded",
      paymentUpdatedAt: "2026-06-20T00:00:00.000Z",
      hasPayment: true,
      // Added by this wave. False for every ordinary order; only the activation
      // sweep stamps the marker it reads, and only on the order it abandons.
      subscriptionActivationAbandoned: false,
    });
  });

  it("reports the sweep's abandonment marker so the expired-checkout gate can see it", async () => {
    // ⛔ The gate admits a `cancelled` order ONLY with this marker. Without it a
    // buyer whose FIRST subscription payment never confirmed gets no message at
    // all, because the expired-checkout producers require `expired` AND
    // `mode = 'one_time'` while the sweep writes `cancelled`.
    const port = createSupabaseOrderPaymentLifecyclePort(fakeClient({
      order: { status: "cancelled", metadata: { subscriptionActivation: "abandoned" } },
      payment: { status: "processing", updated_at: "2026-09-03T00:00:00.000Z" },
    }));

    await expect(port.read(ORDER_ID, new AbortController().signal)).resolves.toMatchObject({
      orderStatus: "cancelled",
      subscriptionActivationAbandoned: true,
    });
  });

  it("returns null when the order cannot be found", async () => {
    const port = createSupabaseOrderPaymentLifecyclePort(fakeClient({ order: null, payment: null }));

    await expect(port.read(ORDER_ID, new AbortController().signal)).resolves.toBeNull();
  });
});
