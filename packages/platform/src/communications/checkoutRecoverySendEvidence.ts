import { classifyEmailSendOutcome, type EmailSendSkipReason } from './emailTransport.js';

interface EmailSendOutcome {
  ok: boolean;
  messageId: string | null;
  httpStatus: number;
  providerError: string | null;
  providerErrorCode?: string | null;
  aborted: boolean;
  skipReason?: EmailSendSkipReason | null;
}

// Structural bounds leave domain payload types with the supplied transactional
// email port. The facade exposes only its email methods, never instance state.
interface TransactionalEmailEvidencePort {
  findExistingSend(templateSlug: string, outboxEventId: string): Promise<boolean>;
  sendReturnApprovedNotice(...args: never[]): Promise<EmailSendOutcome>;
  sendReturnRejectedNotice(...args: never[]): Promise<EmailSendOutcome>;
  sendOrderConfirmation(...args: never[]): Promise<EmailSendOutcome>;
  sendCheckoutRecovery(input: { outboxEventId: string }): Promise<EmailSendOutcome>;
  sendOrderPaidConfirmation(...args: never[]): Promise<EmailSendOutcome>;
  sendPaymentFailedNotice(...args: never[]): Promise<EmailSendOutcome>;
  sendCheckoutExpiredNotice(...args: never[]): Promise<EmailSendOutcome>;
  sendOrderCanceledNotice(...args: never[]): Promise<EmailSendOutcome>;
  sendOrderRefundedNotice(...args: never[]): Promise<EmailSendOutcome>;
  sendShipmentDispatchedNotice(...args: never[]): Promise<EmailSendOutcome>;
  sendShipmentDeliveredNotice(...args: never[]): Promise<EmailSendOutcome>;
  sendShipmentExceptionNotice(...args: never[]): Promise<EmailSendOutcome>;
}

/** Adds confirmed-send evidence only for recovery mail. Other email methods and dedupe retain their binding.
 * The selected transport must preserve the outbox event's idempotency on ambiguous retries.
 * Acceptance is evidence for this exact transport profile, including a selected captured profile. */
export function withCheckoutRecoverySendEvidence<Port extends TransactionalEmailEvidencePort>(
  emailPort: Port,
  evidence: { recordConfirmedSend(eventId: string, deliveryReference: string): Promise<void> },
) {
  return {
    findExistingSend: (templateSlug: string, outboxEventId: string) => emailPort.findExistingSend(templateSlug, outboxEventId),
    sendReturnApprovedNotice: (...args: Parameters<Port['sendReturnApprovedNotice']>) => emailPort.sendReturnApprovedNotice(...args),
    sendReturnRejectedNotice: (...args: Parameters<Port['sendReturnRejectedNotice']>) => emailPort.sendReturnRejectedNotice(...args),
    sendOrderConfirmation: (...args: Parameters<Port['sendOrderConfirmation']>) => emailPort.sendOrderConfirmation(...args),
    async sendCheckoutRecovery(input: Parameters<Port['sendCheckoutRecovery']>[0]) {
      const outcome = await emailPort.sendCheckoutRecovery(input);
      const classified = classifyEmailSendOutcome(Object.assign({}, outcome, { resendId: outcome.messageId }));
      if (classified.sentAtEligible) {
        await evidence.recordConfirmedSend(input.outboxEventId, outcome.messageId ?? `confirmed:${input.outboxEventId}`);
      }
      return outcome;
    },
    sendOrderPaidConfirmation: (...args: Parameters<Port['sendOrderPaidConfirmation']>) => emailPort.sendOrderPaidConfirmation(...args),
    sendPaymentFailedNotice: (...args: Parameters<Port['sendPaymentFailedNotice']>) => emailPort.sendPaymentFailedNotice(...args),
    sendCheckoutExpiredNotice: (...args: Parameters<Port['sendCheckoutExpiredNotice']>) => emailPort.sendCheckoutExpiredNotice(...args),
    sendOrderCanceledNotice: (...args: Parameters<Port['sendOrderCanceledNotice']>) => emailPort.sendOrderCanceledNotice(...args),
    sendOrderRefundedNotice: (...args: Parameters<Port['sendOrderRefundedNotice']>) => emailPort.sendOrderRefundedNotice(...args),
    sendShipmentDispatchedNotice: (...args: Parameters<Port['sendShipmentDispatchedNotice']>) => emailPort.sendShipmentDispatchedNotice(...args),
    sendShipmentDeliveredNotice: (...args: Parameters<Port['sendShipmentDeliveredNotice']>) => emailPort.sendShipmentDeliveredNotice(...args),
    sendShipmentExceptionNotice: (...args: Parameters<Port['sendShipmentExceptionNotice']>) => emailPort.sendShipmentExceptionNotice(...args),
  };
}
