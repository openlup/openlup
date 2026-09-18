import { describe, expect, it } from "vitest";

import { createOutboxCheckoutRecoveryEmailHandler } from "./outboxCheckoutRecoveryEmailHandler.js";
import { COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import {
  OUTBOX_CHECKOUT_RECOVERY_TEMPLATE_SLUG,
  type CheckoutRecoveryEmailInput,
  type OrderPaymentLifecyclePort,
  type OrderPaymentLifecycleState,
  type TransactionalEmailPort,
  type OrderRecipientPort,
} from "./outboxOrderDraftEmailPorts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";

const OK = { ok: true as const, resendId: "re_1", httpStatus: 200, providerError: null, aborted: false };

function makeDeps(overrides?: {
  recipient?: { email: string; firstName: string | null; country?: string | null } | null;
  existing?: boolean;
  outcome?: Awaited<ReturnType<TransactionalEmailPort["sendCheckoutRecovery"]>>;
  lifecycle?: OrderPaymentLifecycleState | null;
}) {
  const calls: CheckoutRecoveryEmailInput[] = [];
  const emailPort = {
    findExistingSend: async () => overrides?.existing ?? false,
    sendCheckoutRecovery: async (input: CheckoutRecoveryEmailInput) => {
      calls.push(input);
      return overrides?.outcome ?? OK;
    },
  } as unknown as TransactionalEmailPort;
  const recipientPort: OrderRecipientPort = {
    resolve: async () =>
      overrides?.recipient === undefined
        ? { email: "a@b.test", firstName: "Ala", country: "PL", petName: "Fistaszek" }
        : overrides.recipient,
  };
  const lifecycleCalls: string[] = [];
  const lifecyclePort: OrderPaymentLifecyclePort = {
    async read(orderUuid) {
      lifecycleCalls.push(orderUuid);
      // Keyed on presence, not truthiness: `lifecycle: null` is the "order is
      // gone" case, and `??` would have quietly served the healthy default for it.
      if (overrides && "lifecycle" in overrides) return overrides.lifecycle ?? null;
      return {
        orderStatus: "pending_payment",
        paymentStatus: "pending",
        hasPayment: true,
      };
    },
  };
  return {
    handler: createOutboxCheckoutRecoveryEmailHandler({ emailPort, recipientPort, lifecyclePort }),
    calls,
    lifecycleCalls,
  };
}

function row(payload: Record<string, unknown>, attempts = 0): OutboxEventRow {
  return { id: "evt-1", payload, attempts } as unknown as OutboxEventRow;
}

const VALID = {
  orderId: "11111111-1111-1111-1111-111111111111",
  recoveryToken: "raw-token-abc",
  mode: "subscription_cycle",
  reminderHours: 1,
};

describe("outboxCheckoutRecoveryEmailHandler", () => {
  it("claims the commerce.checkout_recovery event type", () => {
    const { handler } = makeDeps();
    expect(handler.eventType).toBe(COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE);
  });

  it("discards an unparseable payload (missing token)", async () => {
    const { handler } = makeDeps();
    const out = await handler.handle(row({ orderId: VALID.orderId }), new AbortController().signal);
    expect(out.kind).toBe("discard");
  });

  it("processes-skip when the recipient cannot be resolved", async () => {
    const { handler, calls } = makeDeps({ recipient: null });
    const out = await handler.handle(row(VALID), new AbortController().signal);
    expect(out).toEqual({ kind: "processed", detail: { skipped: "recipient_unresolved" } });
    expect(calls).toHaveLength(0);
  });

  it("skips stale recovery when the order is already paid", async () => {
    const { handler, calls, lifecycleCalls } = makeDeps({
      lifecycle: { orderStatus: "paid", paymentStatus: "succeeded", hasPayment: true },
    });
    const out = await handler.handle(row(VALID), new AbortController().signal);
    expect(out).toEqual({ kind: "processed", detail: { skipped: "order_not_pending_payment" } });
    expect(lifecycleCalls).toEqual([VALID.orderId]);
    expect(calls).toHaveLength(0);
  });

  it("skips recovery for pending orders with a successful payment readback", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: { orderStatus: "pending_payment", paymentStatus: "succeeded", hasPayment: true },
    });
    const out = await handler.handle(row(VALID), new AbortController().signal);
    expect(out).toEqual({ kind: "processed", detail: { skipped: "order_already_paid" } });
    expect(calls).toHaveLength(0);
  });

  // The emit key `checkout_recovery:1h:<order>` exists once per order forever, so
  // settling this event terminally destroys the only nudge the buyer will get.
  // A live payment session is transient; it must defer, never drop.
  it("defers recovery while a fresh payment session is active", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: {
        orderStatus: "pending_payment",
        paymentStatus: "pending",
        paymentUpdatedAt: new Date().toISOString(),
        hasPayment: true,
      },
    });
    const out = await handler.handle(row(VALID), new AbortController().signal);
    expect(out).toEqual({ kind: "retry", reason: "payment_session_active" });
    expect(calls).toHaveLength(0);
  });

  it("retires the nudge as processed once deferrals are exhausted", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: {
        orderStatus: "pending_payment",
        paymentStatus: "pending",
        paymentUpdatedAt: new Date().toISOString(),
        hasPayment: true,
      },
    });
    // Past the ceiling the row must NOT keep retrying into the terminal DLQ,
    // where a merely untimely reminder would read as a dispatch failure.
    const out = await handler.handle(row(VALID, 5), new AbortController().signal);
    expect(out).toEqual({ kind: "processed", detail: { skipped: "payment_session_exhausted" } });
    expect(calls).toHaveLength(0);
  });

  it("defers rather than retiring when attempts is absent from the row", async () => {
    const { handler } = makeDeps({
      lifecycle: {
        orderStatus: "pending_payment",
        paymentStatus: "pending",
        paymentUpdatedAt: new Date().toISOString(),
        hasPayment: true,
      },
    });
    const bare = { id: "evt-1", payload: VALID } as unknown as OutboxEventRow;
    expect(await handler.handle(bare, new AbortController().signal)).toEqual({
      kind: "retry",
      reason: "payment_session_active",
    });
  });

  // The wave's whole point. An operator link is minted for an order that has
  // usually LEFT pending_payment (expired is the ordinary case), and the redeem
  // rail recreates it when the customer opens the link. Judged by the cron's rule
  // this would be skipped as `order_not_pending_payment` and never sent, with the
  // operator having already told the customer to expect it.
  it("sends an operator-issued link for an order that has left pending_payment", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: { orderStatus: "expired", paymentStatus: "failed", hasPayment: true },
    });
    const out = await handler.handle(
      row({ ...VALID, operatorIssued: true }),
      new AbortController().signal,
    );
    expect(out.kind).toBe("processed");
    expect(calls).toHaveLength(1);
    expect(calls[0].recoveryToken).toBe(VALID.recoveryToken);
  });

  // Same lifecycle, no marker: the cron rule still applies unchanged.
  it("keeps skipping a cron nudge for an order that has left pending_payment", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: { orderStatus: "expired", paymentStatus: "failed", hasPayment: true },
    });
    const out = await handler.handle(row(VALID), new AbortController().signal);
    expect(out).toEqual({ kind: "processed", detail: { skipped: "order_not_pending_payment" } });
    expect(calls).toHaveLength(0);
  });

  it("skips an operator-issued link once the money is in", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: { orderStatus: "paid", paymentStatus: "succeeded", hasPayment: true },
    });
    const out = await handler.handle(
      row({ ...VALID, operatorIssued: true }),
      new AbortController().signal,
    );
    expect(out).toEqual({ kind: "processed", detail: { skipped: "order_already_paid" } });
    expect(calls).toHaveLength(0);
  });

  // Identical deferral semantics to the cron branch, ceiling included: do not tell
  // someone to finish paying while they are paying, but never drop the row for it.
  it("defers an operator-issued link while a fresh payment session is active", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: {
        orderStatus: "expired",
        paymentStatus: "processing",
        paymentUpdatedAt: new Date().toISOString(),
        hasPayment: true,
      },
    });
    const out = await handler.handle(
      row({ ...VALID, operatorIssued: true }),
      new AbortController().signal,
    );
    expect(out).toEqual({ kind: "retry", reason: "payment_session_active" });
    expect(calls).toHaveLength(0);
  });

  it("retires an operator-issued link once its deferrals are exhausted", async () => {
    const { handler } = makeDeps({
      lifecycle: {
        orderStatus: "expired",
        paymentStatus: "processing",
        paymentUpdatedAt: new Date().toISOString(),
        hasPayment: true,
      },
    });
    const out = await handler.handle(
      row({ ...VALID, operatorIssued: true }, 5),
      new AbortController().signal,
    );
    expect(out).toEqual({ kind: "processed", detail: { skipped: "payment_session_exhausted" } });
  });

  // The buyer's escape hatch, and the one rule that separates it from the
  // operator's. A buyer who taps it is BY CONSTRUCTION inside a live payment
  // session — that session is what will not finish. Deferring on
  // `payment_session_active` would defer every hatch row through the ceiling and
  // then retire it, so the control would send nothing, ever, in silence.
  it("sends a buyer-requested link while a fresh payment session is active", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: {
        orderStatus: "pending_payment",
        paymentStatus: "pending",
        paymentUpdatedAt: new Date().toISOString(),
        hasPayment: true,
      },
    });
    const out = await handler.handle(
      row({ ...VALID, buyerRequested: true }),
      new AbortController().signal,
    );
    expect(out.kind).toBe("processed");
    expect(calls).toHaveLength(1);
    expect(calls[0].linkSource).toBe("buyer_hatch");
  });

  it("still refuses a buyer-requested link once the money is in", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: { orderStatus: "paid", paymentStatus: "succeeded", hasPayment: true },
    });
    const out = await handler.handle(
      row({ ...VALID, buyerRequested: true }),
      new AbortController().signal,
    );
    expect(out).toEqual({ kind: "processed", detail: { skipped: "order_already_paid" } });
    expect(calls).toHaveLength(0);
  });

  it("still refuses a buyer-requested link when the order is gone", async () => {
    const { handler, calls } = makeDeps({ lifecycle: null });
    const out = await handler.handle(
      row({ ...VALID, buyerRequested: true }),
      new AbortController().signal,
    );
    expect(out).toEqual({ kind: "processed", detail: { skipped: "order_unavailable" } });
    expect(calls).toHaveLength(0);
  });

  it("carries no linkSource for a cron row, so its deep-link is unchanged", async () => {
    const { handler, calls } = makeDeps();
    await handler.handle(row(VALID), new AbortController().signal);
    expect(calls[0].linkSource).toBeUndefined();
  });

  it("carries no linkSource for an operator row either", async () => {
    const { handler, calls } = makeDeps({
      lifecycle: { orderStatus: "expired", paymentStatus: "failed", hasPayment: true },
    });
    await handler.handle(
      row({ ...VALID, operatorIssued: true }),
      new AbortController().signal,
    );
    expect(calls[0].linkSource).toBeUndefined();
  });

  it("dedupes on an existing send", async () => {
    const { handler, calls } = makeDeps({ existing: true });
    const out = await handler.handle(row(VALID), new AbortController().signal);
    expect(out).toEqual({ kind: "processed", detail: { dedupe: "email_already_sent" } });
    expect(calls).toHaveLength(0);
  });

  it("sends with the raw token + mode + reminderHours and reports processed", async () => {
    const { handler, calls } = makeDeps();
    const out = await handler.handle(row(VALID), new AbortController().signal);
    expect(out.kind).toBe("processed");
    expect(calls[0]).toMatchObject({
      to: "a@b.test",
      petName: "Fistaszek",
      orderId: VALID.orderId,
      recoveryToken: "raw-token-abc",
      mode: "subscription_cycle",
      reminderHours: 1,
      outboxEventId: "evt-1",
    });
  });

  it("snoozes on a provider 5xx (attempt refunded)", async () => {
    const { handler } = makeDeps({
      outcome: { ok: false, resendId: null, httpStatus: 503, providerError: "down", aborted: false },
    });
    const out = await handler.handle(row(VALID), new AbortController().signal);
    expect(out.kind).toBe("snooze");
  });

  it("uses the canonical template slug for dedupe", async () => {
    expect(OUTBOX_CHECKOUT_RECOVERY_TEMPLATE_SLUG).toBe("commerce-checkout-recovery");
  });
});
