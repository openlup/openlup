export type PaymentRefusalHandoff = {
  outcome: "refused" | "not_refused";
  idempotencyKey: string;
  paymentIntentId: string | null;
  sourceEventId: string;
  failureReason: string | null;
  occurredAt: string;
};

export interface PaymentFailureDunningPort {
  openFromExplicitRefusal(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    sourceEventId: string;
    failureReason: string | null;
    occurredAt: string;
  }): Promise<void>;
}

/**
 * Neutral terminal handoff. Only explicit refusal evidence may enter dunning;
 * silence, timeout and every other non-terminal answer are deliberate no-ops.
 */
export async function handoffExplicitPaymentRefusal(
  input: PaymentRefusalHandoff,
  port: PaymentFailureDunningPort,
): Promise<void> {
  if (input.outcome !== "refused" || !input.paymentIntentId) return;
  await port.openFromExplicitRefusal({
    idempotencyKey: input.idempotencyKey,
    paymentIntentId: input.paymentIntentId,
    sourceEventId: input.sourceEventId,
    failureReason: input.failureReason,
    occurredAt: input.occurredAt,
  });
}
