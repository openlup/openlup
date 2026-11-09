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
  return {
    ...emailPort,
    async sendCheckoutRecovery(input) {
      const outcome = await emailPort.sendCheckoutRecovery(input);
      const classified = classifyEmailSendOutcome({ ...outcome, resendId: outcome.messageId });
      if (classified.sentAtEligible) {
        await evidence.recordConfirmedSend(input.outboxEventId, outcome.messageId ?? `confirmed:${input.outboxEventId}`);
      }
      return outcome;
    },
  };
}

