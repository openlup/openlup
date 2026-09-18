export interface ExpiredCheckoutRecoveryWritePort {
  prepareReplacement(input: {
    idempotencyKey: string;
    sourceOrderId: string;
    replacementOrderId: string;
  }): Promise<{ replacementOrderId: string; replayed: boolean }>;
}

export class ExpiredCheckoutRecoveryConflictError extends Error {
  constructor(public readonly reason: string) {
    super(`expired_checkout_recovery_${reason}`);
    this.name = "ExpiredCheckoutRecoveryConflictError";
  }
}

export interface AbandonedCartReminderEnqueueResult {
  enqueued1h: number;
  enqueued24h: number;
  enqueued72h: number;
  // Set when the versioned Vercel enqueue RPC short-circuited on its deployment
  // identity guard instead of
  // genuinely scanning for eligible drafts. Distinguishes "ran cleanly, zero
  // eligible" from "silently blocked" — see CJ01-AB.
  skipped?: string;
}

export interface AbandonedCartReminderEnqueuePort {
  enqueue(limit: number, runtimeBaseUrl: string): Promise<AbandonedCartReminderEnqueueResult>;
}

export interface CheckoutRecoveryReminderEnqueueResult {
  enqueued1h: number;
  enqueued20h: number;
}

export interface CheckoutRecoveryReminderEnqueuePort {
  enqueue(limit: number): Promise<CheckoutRecoveryReminderEnqueueResult>;
}

export interface ReminderDeliveryAuthorizationPort {
  authorize(input: {
    eventId: string;
    claimToken: string;
  }): Promise<
    | {
      authorized: true;
      idempotencyKey: string;
      recipientReference: string;
      templateReference: string;
    }
    | { authorized: false; reason: string }
  >;
}

export interface CapturedReminderDeliveryPort {
  send(input: {
    idempotencyKey: string;
    recipientReference: string;
    templateReference: string;
  }): Promise<{ state: "accepted" | "failed"; attemptCount: number }>;
}

export function createCapturedCheckoutReminderHandler(input: {
  eventType: string;
  authorization: ReminderDeliveryAuthorizationPort;
  delivery: CapturedReminderDeliveryPort;
}): import("./contracts.js").OutboxHandler {
  return {
    eventType: input.eventType,
    timeoutMs: 10_000,
    async handle(row, signal, execution) {
      const claimToken = typeof row.metadata.claimToken === "string"
        ? row.metadata.claimToken : "";
      if (!claimToken) return { kind: "retry", reason: "checkout_reminder_claim_token_missing" };
      if (signal.aborted) return { kind: "retry", reason: "outbox_handler_timeout" };
      execution?.setPhase("authorize");
      const authorization = await input.authorization.authorize({ eventId: row.id, claimToken });
      if (authorization.authorized === false) {
        return { kind: "processed", detail: { skipped: authorization.reason } };
      }
      if (signal.aborted) return { kind: "retry", reason: "outbox_handler_timeout" };
      execution?.setPhase("captured_delivery");
      try {
        const receipt = await input.delivery.send(authorization);
        return receipt.state === "accepted"
          ? { kind: "processed", detail: { captured: "accepted", attempts: receipt.attemptCount } }
          : { kind: "retry", reason: "captured_transactional_delivery_failed" };
      } catch {
        return { kind: "retry", reason: "captured_transactional_delivery_unavailable" };
      }
    },
  };
}

export type OutboxPruneResult = {
  compacted: number;
  processed: number;
  discarded: number;
};

export interface OutboxPrunePort {
  pruneOutbox(limit: number): Promise<OutboxPruneResult>;
}
