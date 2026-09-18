export interface DormantOutboxEventType {
  eventType: string;
  owner: string;
  reason: string;
}

export const DORMANT_OUTBOX_EVENT_TYPES: readonly DormantOutboxEventType[] = [
  {
    eventType: "commerce.subscription_payment.requested",
    owner: "commerce/payments",
    reason: "PSP subscription payment command has no production-ready outbox handler yet.",
  },
  {
    eventType: "commerce.payment_attempt.requested",
    owner: "commerce/payments",
    reason: "One-time payment-attempt command remains owned by the payment control plane.",
  },
  {
    eventType: "commerce.subscription_payment.retry_requested",
    owner: "commerce/recovery",
    reason: "Payment-recovery retry command has no dispatcher handler yet.",
  },
  {
    // The dormancy is still true: this command has no dispatcher handler and is
    // not how a subscription resumes. The second half of the `reason` sentence
    // is not. Expired resume IS wired -- both the redeem boundary and the
    // customer self-service `resume` action run it synchronously through
    // `subscription_resume_after_expired_dunning`.
    //
    // The stale half stays because this string is not prose: the DB-parity
    // guardrail asserts the migration text contains it character-for-character,
    // so rewriting it here without a migration turns the guard red. The correct
    // reading of the rail is in docs/SUBSCRIPTION_ORIENTATION.md.
    eventType: "commerce.subscription.resume_requested",
    owner: "commerce/recovery",
    reason:
      "Historical expired-recovery resume command has no dispatcher handler; current generic setup/redeem fails closed until snapshot-aware resume is wired.",
  },
  {
    // The legacy R0 dynamic-prefix producer ('commerce.return.' || NEW.status) stays
    // registered here: that literal still lives in the 20260706110000 migration text
    // and the contract guardrail. R1 (20260708130000_commerce_returns_promote_runtime)
    // narrows the live trigger to emit explicit commerce.return.approved/rejected
    // literals, which are runtime-promoted in KNOWN_OUTBOX_EVENT_TYPES; the remaining
    // lifecycle statuses stay un-emitted until their handlers land in R2+.
    eventType: "commerce.return.",
    owner: "commerce/returns",
    reason:
      "Commerce Returns R0 (commerce_returns_outbox) emits commerce.return.<status> but its handlers land in R1+; the producer is dormant until then.",
  },
  // NOTE: commerce.checkout_recovery was dormant in W2; W3 added the runtime email
  // handler, so it is now registered (KNOWN_OUTBOX_EVENT_TYPES) and its dormant seed
  // is removed by 20260708110000_checkout_recovery_promote_runtime.sql.
] as const;

export const DORMANT_OUTBOX_EVENT_TYPE_NAMES = DORMANT_OUTBOX_EVENT_TYPES.map(
  (entry) => entry.eventType,
);

export const DORMANT_OUTBOX_EXACT_EVENT_TYPE_NAMES = DORMANT_OUTBOX_EVENT_TYPE_NAMES
  .filter((eventType) => !eventType.endsWith("."));

export const DORMANT_OUTBOX_PREFIX_EVENT_TYPE_NAMES = DORMANT_OUTBOX_EVENT_TYPE_NAMES
  .filter((eventType) => eventType.endsWith("."));

export function isDormantOutboxEventType(eventType: string): boolean {
  return DORMANT_OUTBOX_EVENT_TYPE_NAMES.some((dormantType) =>
    dormantType.endsWith(".") ? eventType.startsWith(dormantType) : eventType === dormantType
  );
}
