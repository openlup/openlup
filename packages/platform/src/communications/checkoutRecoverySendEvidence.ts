import { classifyEmailSendOutcome, type EmailSendSkipReason } from './emailTransport.js';

interface RecoveryEmailSendPort {
  sendCheckoutRecovery(input: { outboxEventId: string }): Promise<{
    ok: boolean; messageId: string | null; providerError: string | null; aborted: boolean;
    skipReason?: EmailSendSkipReason | null;
  }>;
}

/** Adds confirmed-send evidence only for recovery mail. Other email methods and dedupe retain their binding.
 * The selected transport must preserve the outbox event's idempotency on ambiguous retries.
 * Acceptance is evidence for this exact transport profile, including a selected captured profile. */
export function withCheckoutRecoverySendEvidence<Port extends RecoveryEmailSendPort>(
  emailPort: Port,
  evidence: { recordConfirmedSend(eventId: string, deliveryReference: string): Promise<void> },
): Port {
  const sendCheckoutRecovery: RecoveryEmailSendPort['sendCheckoutRecovery'] = async input => {
    const outcome = await emailPort.sendCheckoutRecovery(input);
    const classified = classifyEmailSendOutcome({ ...outcome, resendId: outcome.messageId });
    if (classified.sentAtEligible) {
      await evidence.recordConfirmedSend(input.outboxEventId, outcome.messageId ?? `confirmed:${input.outboxEventId}`);
    }
    return outcome;
  };
  const boundMethods = new Map<unknown, unknown>();
  return new Proxy(emailPort, {
    get(_target, property) {
      if (property === 'sendCheckoutRecovery') return sendCheckoutRecovery;
      const value: unknown = Reflect.get(emailPort, property, emailPort);
      if (typeof value !== 'function') return value;
      if (!boundMethods.has(value)) boundMethods.set(value, value.bind(emailPort));
      return boundMethods.get(value);
    },
  });
}
