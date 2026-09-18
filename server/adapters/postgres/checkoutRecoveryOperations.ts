import {
  type AbandonedCartReminderEnqueuePort,
  type CheckoutRecoveryReminderEnqueuePort,
  type OutboxPrunePort,
  type ReminderDeliveryAuthorizationPort,
} from "../../domains/commerce/checkoutRecoveryOperations.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const ABANDONED_SQL = "SELECT public.commerce_enqueue_abandoned_cart_reminders($1::integer) AS result";
const RECOVERY_SQL = "SELECT public.commerce_enqueue_checkout_recovery_reminders($1::integer) AS result";
const AUTHORIZE_SQL = "SELECT public.commerce_checkout_reminder_delivery_authorize($1::uuid,$2::text) AS result";
const COMPACT_SQL = "SELECT public.commerce_outbox_compact_terminal($1::integer) AS result";

export function createPostgresCheckoutRecoveryOperations(executor: PgQueryExecutor) {
  return {
    abandonedReminderPort: createPostgresAbandonedCartReminderEnqueuePort(executor),
    checkoutRecoveryReminderPort: createPostgresCheckoutRecoveryReminderEnqueuePort(executor),
    outboxPrunePort: createPostgresOutboxPrunePort(executor),
    deliveryAuthorizationPort: createPostgresReminderDeliveryAuthorizationPort(executor),
  };
}

export function createPostgresAbandonedCartReminderEnqueuePort(
  executor: PgQueryExecutor,
): AbandonedCartReminderEnqueuePort {
  return {
    async enqueue(limit) {
      const row = record(scalar(await executor.query(ABANDONED_SQL, [limit])));
      return {
        enqueued1h: count(row.enqueued_1h, "abandoned_cart_reminder_invalid_response"),
        enqueued24h: count(row.enqueued_24h, "abandoned_cart_reminder_invalid_response"),
        enqueued72h: count(row.enqueued_72h, "abandoned_cart_reminder_invalid_response"),
      };
    },
  };
}

export function createPostgresCheckoutRecoveryReminderEnqueuePort(
  executor: PgQueryExecutor,
): CheckoutRecoveryReminderEnqueuePort {
  return {
    async enqueue(limit) {
      const row = record(scalar(await executor.query(RECOVERY_SQL, [limit])));
      return {
        enqueued1h: count(row.enqueued_1h, "checkout_recovery_reminder_invalid_response"),
        enqueued20h: count(row.enqueued_20h, "checkout_recovery_reminder_invalid_response"),
      };
    },
  };
}

export function createPostgresReminderDeliveryAuthorizationPort(
  executor: PgQueryExecutor,
): ReminderDeliveryAuthorizationPort {
  return {
    async authorize(input) {
      const row = record(scalar(await executor.query(AUTHORIZE_SQL, [input.eventId, input.claimToken])));
      if (row.authorized === false && text(row.reason)) {
        return { authorized: false, reason: text(row.reason) };
      }
      if (row.authorized !== true) throw new Error("checkout_reminder_authorization_invalid_response");
      const idempotencyKey = text(row.idempotencyKey);
      const recipientReference = text(row.recipientReference);
      const templateReference = text(row.templateReference);
      if (!idempotencyKey || !recipientReference || !templateReference) {
        throw new Error("checkout_reminder_authorization_invalid_response");
      }
      return { authorized: true, idempotencyKey, recipientReference, templateReference };
    },
  };
}

export function createPostgresOutboxPrunePort(executor: PgQueryExecutor): OutboxPrunePort {
  return {
    async pruneOutbox(limit) {
      const row = record(scalar(await executor.query(COMPACT_SQL, [limit])));
      return {
        compacted: count(row.compacted, "outbox_compaction_invalid_response"),
        processed: count(row.processed, "outbox_compaction_invalid_response"),
        discarded: count(row.discarded, "outbox_compaction_invalid_response"),
      };
    },
  };
}

function scalar(result: { rows: Record<string, unknown>[] }): unknown {
  if (result.rows.length !== 1 || !Object.hasOwn(result.rows[0]!, "result")) {
    throw new Error("checkout_recovery_operation_invalid_response");
  }
  return result.rows[0]!.result;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("checkout_recovery_operation_invalid_response");
  }
  return value as Record<string, unknown>;
}

function count(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(message);
  return value as number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
