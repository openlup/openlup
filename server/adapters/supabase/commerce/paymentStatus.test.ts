import { describe, expect, it } from "vitest";

import { createSupabasePaymentStatusPort, type PaymentStatusSupabaseClient } from "./paymentStatus.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_ID = "44444444-4444-4444-8444-444444444444";

function client(rows: {
  intent?: Record<string, unknown> | null;
  order?: Record<string, unknown> | null;
  attempt?: Record<string, unknown> | null;
  subscription?: Record<string, unknown> | null;
  paidActivationGap?: Record<string, unknown> | null;
}): PaymentStatusSupabaseClient {
  const table = (data: Record<string, unknown> | null | undefined) => {
    const filters: Array<[string, unknown]> = [];
    let selected: string[] = [];
    const query = {
      eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
      maybeSingle: () => Promise.resolve({
        data: data && filters.every(([column, value]) => data[column] === value)
          ? Object.fromEntries(selected.map((column) => [column, data[column]])) : null,
        error: null,
      }),
    };
    return { select: (columns: string) => { selected = columns.split(",").map((column) => column.trim()); return query; } };
  };
  return {
    from: (name: string) => {
      if (name === "commerce_payment_intents") return table(rows.intent);
      if (name === "commerce_orders") return table(rows.order);
      if (name === "commerce_payment_attempts") return table(rows.attempt
        ? { payment_intent_id: INTENT_ID, ...rows.attempt } : null);
      if (name === "subscriptions") return table(rows.subscription);
      if (name === "subscription_paid_activation_gaps") return table(rows.paidActivationGap);
      throw new Error(`Unexpected payment-status table: ${name}`);
    },
  } as PaymentStatusSupabaseClient;
}

const intentRow = (over: Record<string, unknown> = {}) => ({
  id: INTENT_ID,
  order_id: ORDER_ID,
  status: "failed",
  active_attempt_id: ATTEMPT_ID,
  provider_payment_id: null,
  updated_at: "2026-07-20T18:00:00.000+00:00",
  failure_reason: null,
  ...over,
});

const orderRow = { id: ORDER_ID, client_id: CLIENT_ID, status: "pending_payment", mode: "one_time", subscription_id: null };

describe("supabase payment status port", () => {
  it.each([
    ["tpay", "tpay_sim_current", "tpay_sim_current", null, "tpay_sim_current"],
    ["tpay", "tpay_sim_current", "tpay_sim_current", "pi_stale", "tpay_sim_current"],
    ["tpay", "TR-current", "transaction-current", "TR-stale", "TR-current"],
    ["stripe", "pi_current", "pi_current", "tpay_sim_stale", "pi_current"],
    ["tpay", null, "transaction-current", "pi_stale", "transaction-current"],
    ["tpay", "  ", "transaction-current", "pi_stale", "transaction-current"],
    ["tpay", null, null, "pi_stale", null],
    ["tpay", " ", " ", "tpay_sim_stale", null],
  ])("resolves the exact %s attempt identity %s", async (provider, attemptId, sessionId, legacyId, expectedId) => {
    const snapshot = await createSupabasePaymentStatusPort(client({
      intent: intentRow({ status: "processing", provider_payment_id: legacyId }),
      order: orderRow,
      attempt: { id: ATTEMPT_ID, status: "processing", provider,
        provider_attempt_id: attemptId, provider_session_id: sessionId, failure_reason: null },
    })).getPaymentStatus({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });
    expect(snapshot).toMatchObject({
      paymentAttemptId: ATTEMPT_ID, attemptStatus: "processing", provider, providerPaymentId: expectedId,
    });
  });

  it.each([
    null,
    { id: "55555555-5555-4555-8555-555555555555", payment_intent_id: INTENT_ID },
    { id: ATTEMPT_ID, payment_intent_id: "55555555-5555-4555-8555-555555555555" },
  ])("does not substitute an unrelated row or legacy ID for an active pointer: %j", async (identity) => {
    const snapshot = await createSupabasePaymentStatusPort(client({
      intent: intentRow({ provider_payment_id: "tpay_sim_stale" }), order: orderRow,
      attempt: identity ? { ...identity, status: "succeeded", provider: "tpay", provider_attempt_id: "tpay_sim_wrong" } : null,
    })).getPaymentStatus({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });
    expect(snapshot).toMatchObject({ paymentAttemptId: null, attemptStatus: null, provider: null, providerPaymentId: null });
  });

  it("preserves the intent-only legacy identity only without an active pointer", async () => {
    const snapshot = await createSupabasePaymentStatusPort(client({
      intent: intentRow({ active_attempt_id: null, provider_payment_id: "legacy-reference" }), order: orderRow,
      attempt: { id: ATTEMPT_ID, status: "succeeded", provider: "stripe", provider_attempt_id: "pi_unselected" },
    })).getPaymentStatus({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });
    expect(snapshot).toMatchObject({ paymentAttemptId: null, attemptStatus: null, provider: null, providerPaymentId: "legacy-reference" });
  });

  it("surfaces the attempt's failure reason so the buyer can be told what actually happened", async () => {
    const port = createSupabasePaymentStatusPort(client({
      intent: intentRow(),
      order: orderRow,
      attempt: { id: ATTEMPT_ID, status: "failed", provider: "tpay", failure_reason: "blik_recurring_unsupported_bank" },
    }));

    const snapshot = await port.getPaymentStatus({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });

    expect(snapshot?.failureReason).toBe("blik_recurring_unsupported_bank");
  });

  it("prefers the attempt's reason over the intent's, which is the older and coarser one", async () => {
    const port = createSupabasePaymentStatusPort(client({
      intent: intentRow({ failure_reason: "provider_declined" }),
      order: orderRow,
      attempt: { id: ATTEMPT_ID, status: "failed", provider: "tpay", failure_reason: "blik_recurring_unsupported_bank" },
    }));

    const snapshot = await port.getPaymentStatus({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });

    expect(snapshot?.failureReason).toBe("blik_recurring_unsupported_bank");
  });

  it("falls back to the intent's reason when no attempt carries one", async () => {
    const port = createSupabasePaymentStatusPort(client({
      intent: intentRow({ failure_reason: "provider_declined", active_attempt_id: null }),
      order: orderRow,
      attempt: null,
    }));

    const snapshot = await port.getPaymentStatus({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });

    expect(snapshot?.failureReason).toBe("provider_declined");
  });

  it("reports no reason for a payment that has not failed", async () => {
    const port = createSupabasePaymentStatusPort(client({
      intent: intentRow({ status: "processing" }),
      order: orderRow,
      attempt: { id: ATTEMPT_ID, status: "processing", provider: "tpay", failure_reason: null },
    }));

    const snapshot = await port.getPaymentStatus({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });

    expect(snapshot?.failureReason).toBeNull();
  });

  it("uses only the exact fail-closed Model O gap to expose activation repair", async () => {
    const subscriptionOrder = {
      ...orderRow,
      status: "paid",
      mode: "subscription_cycle",
      subscription_id: "55555555-5555-4555-8555-555555555555",
    };
    const common = {
      intent: intentRow({ status: "succeeded" }),
      order: subscriptionOrder,
      attempt: { id: ATTEMPT_ID, status: "succeeded", provider: "tpay", failure_reason: null },
      subscription: { id: subscriptionOrder.subscription_id, status: "pending_activation" },
    };

    const withoutGap = await createSupabasePaymentStatusPort(client(common))
      .getPaymentStatus({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });
    expect(withoutGap?.subscriptionActivationStatus).toBe("not_applicable");

    const withGap = await createSupabasePaymentStatusPort(client({
      ...common,
      paidActivationGap: { payment_intent_id: INTENT_ID, paid_at: "2026-07-20T18:00:00.000Z" },
    })).getPaymentStatus({ orderId: ORDER_ID, paymentIntentId: INTENT_ID });
    expect(withGap?.subscriptionActivationStatus).toBe("action_required");
  });
});
