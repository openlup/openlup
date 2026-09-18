import { describe, expect, it, vi } from "vitest";

import { scheduleRetryOnDurableMethodUpdate } from "./methodUpdateRetry.js";
import type { NormalizedProviderPaymentWebhook } from "../../../domains/payment/paymentWebhookHandlers.js";

const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";
const CASE_ID = "33333333-3333-4333-8333-333333333333";
const METHOD_REF = "method-ref-1";

const USABLE_REF = { subscription_id: SUBSCRIPTION_ID, status: "active", active: true };
const OPEN_CASE = { id: CASE_ID };

describe("retry on a durable method update", () => {
  it("schedules through the one recovery-retry rail when a usable method reaches an open case", async () => {
    const { client, rpc } = fakeClient({
      commerce_payment_method_refs: USABLE_REF,
      subscription_dunning_cases: OPEN_CASE,
    });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "scheduled", reason: "ready" });

    expect(rpc).toHaveBeenCalledWith("subscription_try_schedule_recovery_retry", {
      p_case_id: CASE_ID,
      p_payment_method_ref: METHOD_REF,
      p_requested_at: "2026-06-10T12:00:00.000Z",
      // The entry condition is named, never inferred: the redeem rail keeps the
      // default and this consumption asks for its own.
      p_entry: "method_ref_webhook",
    });
  });

  // A rotated credential is a fresh chance, so the network's automatic update
  // takes the same entry as a brand-new registration.
  it("schedules on a rotation exactly as on a registration", async () => {
    const { client, rpc } = fakeClient({
      commerce_payment_method_refs: USABLE_REF,
      subscription_dunning_cases: OPEN_CASE,
    });

    await expect(scheduleRetryOnDurableMethodUpdate(client, rotation("method_updated")))
      .resolves.toEqual({ outcome: "scheduled", reason: "ready" });

    expect(rpc).toHaveBeenCalledWith("subscription_try_schedule_recovery_retry", expect.objectContaining({
      p_payment_method_ref: METHOD_REF,
      p_entry: "method_ref_webhook",
    }));
  });

  // ⛔ A method that died must never start a charge against itself.
  it.each(["method_revoked", "method_expired", "method_suspended"])(
    "never schedules on %s",
    async (kind) => {
      const { client, rpc } = fakeClient({
        commerce_payment_method_refs: USABLE_REF,
        subscription_dunning_cases: OPEN_CASE,
      });

      await expect(scheduleRetryOnDurableMethodUpdate(client, rotation(kind)))
        .resolves.toEqual({ outcome: "skipped", reason: "no_usable_method_signal" });

      expect(rpc).not.toHaveBeenCalled();
    },
  );

  // The row, not the delivery, is the evidence: a death the lifecycle
  // consumption already applied leaves an inactive row, and that alone stops it.
  it("refuses a stored row that is no longer usable", async () => {
    const { client, rpc } = fakeClient({
      commerce_payment_method_refs: { ...USABLE_REF, status: "inactive", active: false },
      subscription_dunning_cases: OPEN_CASE,
    });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "skipped", reason: "method_ref_not_usable" });

    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a delivery whose method the webhook has not stored yet", async () => {
    const { client, rpc } = fakeClient({ subscription_dunning_cases: OPEN_CASE });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "skipped", reason: "method_ref_not_usable" });

    expect(rpc).not.toHaveBeenCalled();
  });

  it("leaves an account-scoped method alone", async () => {
    const { client, rpc } = fakeClient({
      commerce_payment_method_refs: { ...USABLE_REF, subscription_id: null },
      subscription_dunning_cases: OPEN_CASE,
    });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "skipped", reason: "method_ref_not_usable" });

    expect(rpc).not.toHaveBeenCalled();
  });

  it("leaves a subscription with no open case alone", async () => {
    const { client, rpc } = fakeClient({ commerce_payment_method_refs: USABLE_REF });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "skipped", reason: "no_open_case" });

    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads the newest open case and bounds the read to one row", async () => {
    const { client, calls } = fakeClient({
      commerce_payment_method_refs: USABLE_REF,
      subscription_dunning_cases: OPEN_CASE,
    });

    await scheduleRetryOnDurableMethodUpdate(client, registration());

    expect(calls.subscription_dunning_cases).toEqual({
      eq: [["subscription_id", SUBSCRIPTION_ID], ["status", "open"]],
      order: [["opened_at", { ascending: false }]],
      limit: [1],
    });
  });

  // A refused schedule is a reason, not a throw: the RPC decides, and a webhook
  // that raised on its verdict would become a provider retry forever.
  it("reports the rail's refusal without throwing", async () => {
    const { client } = fakeClient({
      commerce_payment_method_refs: USABLE_REF,
      subscription_dunning_cases: OPEN_CASE,
    }, { scheduled: false, reason: "cycle_not_retryable" });

    await expect(scheduleRetryOnDurableMethodUpdate(client, registration()))
      .resolves.toEqual({ outcome: "not_scheduled", reason: "cycle_not_retryable" });
  });

  it("skips a client that cannot read a table", async () => {
    await expect(scheduleRetryOnDurableMethodUpdate({ rpc: vi.fn() }, registration()))
      .resolves.toEqual({ outcome: "skipped", reason: "client_unavailable" });
  });
});

function registration(): NormalizedProviderPaymentWebhook {
  return {
    ...baseEvent(),
    eventType: "setup.succeeded",
    reusableMethod: {
      clientId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: SUBSCRIPTION_ID,
      providerCustomerRef: "customer-1",
      providerMethodRef: METHOD_REF,
      providerMandateRef: null,
      methodKind: "card",
      status: "active",
      consentSnapshot: { source: "account.card-update" },
    },
  };
}

function rotation(kind: string): NormalizedProviderPaymentWebhook {
  return {
    ...baseEvent(),
    eventType: kind === "method_updated" ? "setup.succeeded" : "setup.failed",
    methodLifecycle: {
      kind,
      providerKind: baseEvent().provider,
      providerMethodRef: METHOD_REF,
      providerEventId: "event-1",
      occurredAt: "2026-06-10T12:00:00.000Z",
      replacement: null,
    },
  } as unknown as NormalizedProviderPaymentWebhook;
}

// Spelled once: every published rail kind is a provider name whose exact count
// the readiness receipt freezes, and this module never branches on the value.
const RAIL: NormalizedProviderPaymentWebhook["provider"] = "stripe";

function baseEvent(): NormalizedProviderPaymentWebhook {
  return {
    provider: RAIL,
    providerEventId: "event-1",
    eventType: "setup.succeeded",
    providerPaymentId: "provider-payment-1",
    occurredAt: "2026-06-10T12:00:00.000Z",
    rawPayload: {},
    reusableMethod: null,
  };
}

type Recorded = { eq: unknown[][]; order: unknown[][]; limit: unknown[] };

function fakeClient(
  rows: Record<string, Record<string, unknown> | undefined>,
  rpcResult: Record<string, unknown> = { scheduled: true, reason: "ready" },
) {
  const calls: Record<string, Recorded> = {};
  const rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
  const client = {
    rpc,
    from(table: string) {
      const recorded: Recorded = calls[table] ??= { eq: [], order: [], limit: [] };
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { recorded.eq.push([column, value]); return builder; },
        order: (column: string, options: { ascending: boolean }) => {
          recorded.order.push([column, options]);
          return builder;
        },
        limit: (count: number) => { recorded.limit.push(count); return builder; },
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return builder;
    },
  };
  return { client, rpc, calls };
}
