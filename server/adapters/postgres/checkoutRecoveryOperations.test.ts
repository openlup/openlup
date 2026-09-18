import { describe, expect, it, vi } from "vitest";
import type { PgQueryExecutor } from "./queryBuilder.js";
import {
  createPostgresAbandonedCartReminderEnqueuePort,
  createPostgresCheckoutRecoveryReminderEnqueuePort,
  createPostgresCheckoutRecoveryOperations,
  createPostgresOutboxPrunePort,
  createPostgresReminderDeliveryAuthorizationPort,
} from "./checkoutRecoveryOperations.js";

function executor(result: unknown) {
  const query = vi.fn(async () => ({ rows: [{ result }] }));
  return { query } as unknown as PgQueryExecutor & { query: typeof query };
}

describe("Postgres checkout-recovery operations", () => {
  it("publishes one capability-local adapter set for composition roots", () => {
    expect(Object.keys(createPostgresCheckoutRecoveryOperations(executor({})))).toEqual([
      "abandonedReminderPort",
      "checkoutRecoveryReminderPort",
      "outboxPrunePort",
      "deliveryAuthorizationPort",
    ]);
  });

  it("enqueues both reminder ladders with strict non-negative counts", async () => {
    const abandoned = executor({ enqueued_1h: 1, enqueued_24h: 2, enqueued_72h: 3 });
    await expect(createPostgresAbandonedCartReminderEnqueuePort(abandoned).enqueue(200, "ignored"))
      .resolves.toEqual({ enqueued1h: 1, enqueued24h: 2, enqueued72h: 3 });
    expect(abandoned.query).toHaveBeenCalledWith(
      "SELECT public.commerce_enqueue_abandoned_cart_reminders($1::integer) AS result",
      [200],
    );

    const recovery = executor({ enqueued_1h: 2, enqueued_20h: 1 });
    await expect(createPostgresCheckoutRecoveryReminderEnqueuePort(recovery).enqueue(200))
      .resolves.toEqual({ enqueued1h: 2, enqueued20h: 1 });
    await expect(createPostgresCheckoutRecoveryReminderEnqueuePort(executor({ enqueued_1h: -1 })).enqueue(5))
      .rejects.toThrow("checkout_recovery_reminder_invalid_response");
  });

  it("authorizes captured delivery only from a complete routine response", async () => {
    const authorized = executor({
      authorized: true,
      idempotencyKey: "checkout-reminder:event",
      recipientReference: "client",
      templateReference: "commerce-checkout-recovery",
    });
    await expect(createPostgresReminderDeliveryAuthorizationPort(authorized).authorize({
      eventId: "event",
      claimToken: "claim",
    })).resolves.toEqual({
      authorized: true,
      idempotencyKey: "checkout-reminder:event",
      recipientReference: "client",
      templateReference: "commerce-checkout-recovery",
    });

    await expect(createPostgresReminderDeliveryAuthorizationPort(
      executor({ authorized: false, reason: "order_not_recoverable" }),
    ).authorize({ eventId: "event", claimToken: "claim" }))
      .resolves.toEqual({ authorized: false, reason: "order_not_recoverable" });
    await expect(createPostgresReminderDeliveryAuthorizationPort(executor({ authorized: true }))
      .authorize({ eventId: "event", claimToken: "claim" }))
      .rejects.toThrow("checkout_reminder_authorization_invalid_response");
  });

  it("compacts terminal outbox rows through the bounded public routine", async () => {
    const db = executor({ compacted: 5, processed: 3, discarded: 2 });
    await expect(createPostgresOutboxPrunePort(db).pruneOutbox(500)).resolves.toEqual({
      compacted: 5,
      processed: 3,
      discarded: 2,
    });
    expect(db.query).toHaveBeenCalledWith(
      "SELECT public.commerce_outbox_compact_terminal($1::integer) AS result",
      [500],
    );
  });

  it("fails closed on missing scalar envelopes", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(createPostgresOutboxPrunePort(db as never).pruneOutbox(1))
      .rejects.toThrow("checkout_recovery_operation_invalid_response");
  });
});
