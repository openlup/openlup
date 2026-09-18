import { describe, expect, it } from "vitest";
import { createSupabasePaymentVerifyNowPort } from "./paymentVerifyNow.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown> | null;

function fakeClient(rows: { intent?: Row; order?: Row; attempt?: Row; failTable?: string }) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q = {
        eq(col: string, val: unknown) {
          filters[col] = val;
          return q;
        },
        maybeSingle() {
          if (rows.failTable === table) {
            return Promise.resolve({ data: null, error: { message: "boom" } });
          }
          const data =
            table === "commerce_payment_intents" ? rows.intent ?? null
            : table === "commerce_orders" ? rows.order ?? null
            : table === "commerce_payment_attempts" ? rows.attempt ?? null
            : null;
          return Promise.resolve({ data, error: null });
        },
      };
      return { select: () => q };
    },
  } as never;
}

const INTENT = {
  id: INTENT_ID,
  order_id: ORDER_ID,
  status: "processing",
  active_attempt_id: ATTEMPT_ID,
  provider_payment_id: null,
};
const ORDER = { id: ORDER_ID, client_id: "c-1", mode: "subscription_cycle" };
const ATTEMPT = {
  id: ATTEMPT_ID,
  payment_id: "p-1",
  status: "processing",
  provider: "stripe",
  provider_attempt_id: "pi_x",
  provider_session_id: null,
  amount_cents: 11175,
  currency: "PLN",
  updated_at: "2026-07-24T06:08:38.776+00:00",
};

describe("supabase payment verify port", () => {
  it("assembles the intent+order+attempt snapshot", async () => {
    const port = createSupabasePaymentVerifyNowPort(
      fakeClient({ intent: INTENT, order: ORDER, attempt: ATTEMPT }),
    );
    const snap = await port.readVerifiableAttempt({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });
    expect(snap).toEqual({
      orderId: ORDER_ID,
      orderClientId: "c-1",
      orderMode: "subscription_cycle",
      paymentIntentId: INTENT_ID,
      intentStatus: "processing",
      intentProviderPaymentId: null,
      paymentAttemptId: ATTEMPT_ID,
      paymentId: "p-1",
      attemptStatus: "processing",
      provider: "stripe",
      providerAttemptId: "pi_x",
      providerSessionId: null,
      amountMinor: 11175,
      currency: "PLN",
      localUpdatedAt: "2026-07-24T06:08:38.776+00:00",
    });
  });

  it("returns null when the intent is missing or has no active attempt", async () => {
    const port = createSupabasePaymentVerifyNowPort(fakeClient({ intent: null }));
    expect(await port.readVerifiableAttempt({ orderId: ORDER_ID, paymentIntentId: INTENT_ID })).toBeNull();

    const noAttempt = createSupabasePaymentVerifyNowPort(
      fakeClient({ intent: { ...INTENT, active_attempt_id: null } }),
    );
    expect(await noAttempt.readVerifiableAttempt({ orderId: ORDER_ID, paymentIntentId: INTENT_ID })).toBeNull();
  });

  it("returns null when the order or attempt row is missing", async () => {
    const noOrder = createSupabasePaymentVerifyNowPort(
      fakeClient({ intent: INTENT, order: null, attempt: ATTEMPT }),
    );
    expect(await noOrder.readVerifiableAttempt({ orderId: ORDER_ID, paymentIntentId: INTENT_ID })).toBeNull();

    const noAttemptRow = createSupabasePaymentVerifyNowPort(
      fakeClient({ intent: INTENT, order: ORDER, attempt: null }),
    );
    expect(await noAttemptRow.readVerifiableAttempt({ orderId: ORDER_ID, paymentIntentId: INTENT_ID })).toBeNull();
  });

  it("throws a stable error when a query fails", async () => {
    const port = createSupabasePaymentVerifyNowPort(
      fakeClient({ intent: INTENT, order: ORDER, attempt: ATTEMPT, failTable: "commerce_orders" }),
    );
    await expect(
      port.readVerifiableAttempt({ orderId: ORDER_ID, paymentIntentId: INTENT_ID }),
    ).rejects.toThrow("commerce_orders: boom");
  });
});
