import type {
  CanonicalPaymentControlEvent,
  PaymentAttemptAggregate,
  PaymentAttemptStatus,
  PaymentControlDecision,
  PaymentControlFailureReason,
  PaymentControlResult,
  PaymentIntentAggregate,
  PaymentIntentStatus,
} from "./paymentControlTypes.js";

const intentTransitions: Record<PaymentIntentStatus, readonly PaymentIntentStatus[]> = {
  created: ["requires_action", "processing", "failed", "expired", "cancelled"],
  requires_action: ["processing", "succeeded", "failed", "expired", "cancelled"],
  processing: ["requires_action", "succeeded", "failed", "expired", "cancelled"],
  failed: ["requires_action", "processing", "succeeded", "cancelled"],
  expired: ["requires_action", "processing", "succeeded", "cancelled"],
  cancelled: [],
  succeeded: ["refunded", "partially_refunded", "disputed"],
  partially_refunded: ["refunded", "disputed"],
  refunded: ["disputed"],
  disputed: [],
};

const attemptTransitions: Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]> = {
  created: ["blocked_preflight", "sent_to_provider", "requires_action", "processing", "failed", "cancelled", "expired"],
  blocked_preflight: ["failed", "cancelled", "expired"],
  sent_to_provider: ["requires_action", "processing", "succeeded", "failed", "cancelled", "expired"],
  requires_action: ["processing", "succeeded", "failed", "cancelled", "expired"],
  processing: ["requires_action", "succeeded", "failed", "cancelled", "expired"],
  failed: ["succeeded"],
  cancelled: ["succeeded"],
  expired: ["succeeded"],
  succeeded: [],
};

function success<T>(value: T): PaymentControlResult<T> {
  return { ok: true, value };
}

function failure(
  reason: PaymentControlFailureReason,
  message: string,
): PaymentControlResult<never> {
  return { ok: false, reason, message };
}

/** @beta */
export function canTransitionPaymentIntent(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
): boolean {
  return from === to || intentTransitions[from].includes(to);
}

/** @beta */
export function canTransitionPaymentAttempt(
  from: PaymentAttemptStatus,
  to: PaymentAttemptStatus,
): boolean {
  return from === to || attemptTransitions[from].includes(to);
}

/** @beta */
export function transitionPaymentIntent(input: {
  intent: PaymentIntentAggregate;
  to: PaymentIntentStatus;
  at: string;
  failureReason?: string | null;
}): PaymentControlResult<PaymentIntentAggregate> {
  if (!canTransitionPaymentIntent(input.intent.status, input.to)) {
    return failure("invalid_transition", `Cannot move payment intent from ${input.intent.status} to ${input.to}`);
  }

  return success({
    ...input.intent,
    status: input.to,
    updatedAt: input.at,
    failureReason: input.failureReason ?? (input.to === "failed" ? input.intent.failureReason ?? "provider_failed" : null),
  });
}

/** @beta */
export function transitionPaymentAttempt(input: {
  attempt: PaymentAttemptAggregate;
  to: PaymentAttemptStatus;
  at: string;
  providerAttemptId?: string | null;
  nextActionKind?: string | null;
  failureReason?: string | null;
}): PaymentControlResult<PaymentAttemptAggregate> {
  if (!canTransitionPaymentAttempt(input.attempt.status, input.to)) {
    return failure("invalid_transition", `Cannot move payment attempt from ${input.attempt.status} to ${input.to}`);
  }

  return success({
    ...input.attempt,
    status: input.to,
    updatedAt: input.at,
    providerAttemptId: input.providerAttemptId ?? input.attempt.providerAttemptId,
    nextActionKind: input.nextActionKind ?? input.attempt.nextActionKind ?? null,
    failureReason: input.failureReason ?? (input.to === "failed" ? input.attempt.failureReason ?? "provider_failed" : null),
  });
}

function assertEventTargetsActiveAttempt(input: {
  intent: PaymentIntentAggregate;
  attempt: PaymentAttemptAggregate;
}): PaymentControlResult<void> {
  if (input.attempt.intentId !== input.intent.id || input.intent.activeAttemptId !== input.attempt.id) {
    return failure("wrong_attempt", "Provider event must target the active local payment attempt");
  }
  return success(undefined);
}

function assertMoneyMatches(input: {
  intent: PaymentIntentAggregate;
  event: CanonicalPaymentControlEvent;
  exactAmount: boolean;
}): PaymentControlResult<void> {
  if (input.event.currency && input.event.currency !== input.intent.currency) {
    return failure("currency_mismatch", "Provider event currency does not match the local payment intent");
  }

  if (input.event.amountMinor === undefined) return success(undefined);
  if (input.exactAmount && input.event.amountMinor !== input.intent.amountMinor) {
    return failure("amount_mismatch", "Provider event amount does not match the local payment intent");
  }
  if (!input.exactAmount && (input.event.amountMinor < 1 || input.event.amountMinor > input.intent.amountMinor)) {
    return failure("amount_mismatch", "Refund amount must be positive and not exceed the original payment amount");
  }

  return success(undefined);
}

function buildDecision(input: {
  kind: PaymentControlDecision["kind"];
  reason: string;
  intent: PaymentIntentAggregate;
  attempt: PaymentAttemptAggregate;
}): PaymentControlResult<PaymentControlDecision> {
  return success(input);
}

/** @beta */
export function applyProviderPaymentEvent(input: {
  intent: PaymentIntentAggregate;
  attempt: PaymentAttemptAggregate;
  event: CanonicalPaymentControlEvent;
  seenProviderEventIds?: readonly string[];
}): PaymentControlResult<PaymentControlDecision> {
  if (input.seenProviderEventIds?.includes(input.event.providerEventId)) {
    return buildDecision({ kind: "noop", reason: "duplicate_provider_event", ...input });
  }

  const targetCheck = assertEventTargetsActiveAttempt(input);
  if (targetCheck.ok === false) return failure(targetCheck.reason, targetCheck.message);

  if (input.event.eventType === "payment.refunded") return applyRefundEvent(input);
  if (input.event.eventType === "payment.disputed") return applyDisputeEvent(input);

  const moneyCheck = assertMoneyMatches({ intent: input.intent, event: input.event, exactAmount: true });
  if (moneyCheck.ok === false) return failure(moneyCheck.reason, moneyCheck.message);

  if (input.event.eventType === "payment.succeeded") return applySuccessEvent(input);
  if (input.event.eventType === "payment.failed") return applyFailureEvent(input);
  return applyRequiresActionEvent(input);
}

function applyRequiresActionEvent(input: {
  intent: PaymentIntentAggregate;
  attempt: PaymentAttemptAggregate;
  event: CanonicalPaymentControlEvent;
}): PaymentControlResult<PaymentControlDecision> {
  const intent = transitionPaymentIntent({ intent: input.intent, to: "requires_action", at: input.event.occurredAt });
  const attempt = transitionPaymentAttempt({
    attempt: input.attempt,
    to: "requires_action",
    at: input.event.occurredAt,
    providerAttemptId: input.event.providerPaymentId,
    nextActionKind: input.event.nextActionKind ?? null,
  });
  if (intent.ok === false) return failure(intent.reason, intent.message);
  if (attempt.ok === false) return failure(attempt.reason, attempt.message);
  return buildDecision({ kind: "state_changed", reason: "provider_requires_action", intent: intent.value, attempt: attempt.value });
}

function applySuccessEvent(input: {
  intent: PaymentIntentAggregate;
  attempt: PaymentAttemptAggregate;
  event: CanonicalPaymentControlEvent;
}): PaymentControlResult<PaymentControlDecision> {
  if (["cancelled", "refunded", "partially_refunded", "disputed"].includes(input.intent.status)) {
    return failure("terminal_intent", `Cannot apply provider success after intent status ${input.intent.status}`);
  }
  if (input.intent.status === "succeeded" && input.attempt.status === "succeeded") {
    return buildDecision({ kind: "noop", reason: "already_succeeded", ...input });
  }

  const recovered = input.intent.status === "failed" || input.intent.status === "expired";
  const intent = transitionPaymentIntent({ intent: input.intent, to: "succeeded", at: input.event.occurredAt });
  const attempt = transitionPaymentAttempt({
    attempt: input.attempt,
    to: "succeeded",
    at: input.event.occurredAt,
    providerAttemptId: input.event.providerPaymentId,
    failureReason: null,
  });
  if (intent.ok === false) return failure(intent.reason, intent.message);
  if (attempt.ok === false) return failure(attempt.reason, attempt.message);
  return buildDecision({
    kind: recovered ? "late_success_recovered" : "state_changed",
    reason: recovered ? "late_success_after_failed_or_expired" : "provider_succeeded",
    intent: { ...intent.value, providerPaymentId: input.event.providerPaymentId },
    attempt: attempt.value,
  });
}

function applyFailureEvent(input: {
  intent: PaymentIntentAggregate;
  attempt: PaymentAttemptAggregate;
  event: CanonicalPaymentControlEvent;
}): PaymentControlResult<PaymentControlDecision> {
  if (["succeeded", "refunded", "partially_refunded", "disputed"].includes(input.intent.status)) {
    return buildDecision({ kind: "noop", reason: "ignored_failure_after_success_or_terminal", ...input });
  }

  const reason = input.event.failureReason ?? "provider_failed";
  const intent = transitionPaymentIntent({ intent: input.intent, to: "failed", at: input.event.occurredAt, failureReason: reason });
  const attempt = transitionPaymentAttempt({ attempt: input.attempt, to: "failed", at: input.event.occurredAt, failureReason: reason });
  if (intent.ok === false) return failure(intent.reason, intent.message);
  if (attempt.ok === false) return failure(attempt.reason, attempt.message);
  return buildDecision({ kind: "state_changed", reason: "provider_failed", intent: intent.value, attempt: attempt.value });
}

function applyRefundEvent(input: {
  intent: PaymentIntentAggregate;
  attempt: PaymentAttemptAggregate;
  event: CanonicalPaymentControlEvent;
}): PaymentControlResult<PaymentControlDecision> {
  if (!["succeeded", "partially_refunded", "refunded"].includes(input.intent.status)) {
    return failure("refund_requires_success", "Refund event requires a previously succeeded local payment intent");
  }
  const moneyCheck = assertMoneyMatches({ intent: input.intent, event: input.event, exactAmount: false });
  if (moneyCheck.ok === false) return failure(moneyCheck.reason, moneyCheck.message);
  const status = input.event.amountMinor === input.intent.amountMinor ? "refunded" : "partially_refunded";
  const intent = transitionPaymentIntent({ intent: input.intent, to: status, at: input.event.occurredAt });
  if (intent.ok === false) return failure(intent.reason, intent.message);
  return buildDecision({ kind: "state_changed", reason: "provider_refunded", intent: intent.value, attempt: input.attempt });
}

function applyDisputeEvent(input: {
  intent: PaymentIntentAggregate;
  attempt: PaymentAttemptAggregate;
  event: CanonicalPaymentControlEvent;
}): PaymentControlResult<PaymentControlDecision> {
  if (input.intent.status === "cancelled") {
    return failure("terminal_intent", "Cannot dispute a cancelled local payment intent");
  }
  const intent = transitionPaymentIntent({ intent: input.intent, to: "disputed", at: input.event.occurredAt });
  if (intent.ok === false) return failure(intent.reason, intent.message);
  return buildDecision({ kind: "state_changed", reason: "provider_disputed", intent: intent.value, attempt: input.attempt });
}
