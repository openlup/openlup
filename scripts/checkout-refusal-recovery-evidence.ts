export function assertCheckoutRefusalRecoveryAttemptIdentity({ scenario, moneyEvidence, status }) {
  const expectedPaymentAttemptId = moneyEvidence?.paymentAttempt?.id;
  if (typeof expectedPaymentAttemptId !== "string" || expectedPaymentAttemptId.length === 0) {
    throw new Error(`${scenario}: money evidence active payment attempt id is missing`);
  }
  if (status?.payment?.paymentAttemptId !== expectedPaymentAttemptId) {
    throw new Error(`${scenario}: payment-status payment attempt id does not match money evidence`);
  }
  if (status?.recoveryGuidance?.paymentAttemptId !== expectedPaymentAttemptId) {
    throw new Error(`${scenario}: recovery guidance payment attempt id does not match money evidence`);
  }
}
