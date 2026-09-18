import { getCommercePaymentStatus } from "@/domains/commerce/commerceClient";
import { PSP_PROVIDER_KINDS, type PspProviderKind } from "@/domains/payment/pspIntegrationPlan";
import { RETRYABLE_ATTEMPT_STATUSES } from "@/domains/payment/paymentControlTypes";
import { BffClientError } from "@/lib/bff/client";
import type {
  PaymentStatusResponse,
} from "@/domains/commerce/checkoutContracts";
import type { PaymentStatusContinuationRequest } from "@/domains/commerce/paymentContinuationContracts";

import type {
  CheckoutContinuationContext,
  CheckoutContinuationPhase,
} from "./checkoutNavigation";

/**
 * The persisted continuation marker is a P0 duplicate-charge guard: on remount
 * (refresh / returning to the tab / re-submit) we resume the in-flight order
 * rather than minting a second PaymentIntent.
 *
 * The marker must NOT outlive the order it points to. Once the order reaches a
 * terminal payment state, resuming it strands the buyer on the status / thank-you
 * page for an ALREADY-COMPLETED order instead of letting them start a fresh one —
 * the bug is most visible in the account flow, where the buyer freely navigates back
 * to the pet picker to order again. This validates the marker against the live order
 * status so the guard self-heals (out-of-band settle, abandonment, tab switch).
 *
 * ⛔ Returns the DECISION, never a boolean. This used to be a predicate
 * (`isPendingResumable`) that computed the decision and then threw it away, so
 * every caller could do only one thing with a resumable marker: send the buyer to
 * the status poller. For a `reopen_embedded` marker that is the wrong thing and
 * the mechanism behind the 2026-08-27 checkout dead end's terminal declines — the poller
 * escalates to a live provider read, and an intent the buyer never confirmed
 * reads as `requires_payment_method`, which normalizes to `failed`.
 */
export async function resolvePendingResume(
  pending: CheckoutContinuationContext,
  selectedProvider?: PspProviderKind | null,
): Promise<PendingResumeDecision> {
  // Still settled before any request is spent - that cost property is owner-approved.
  // Only the VERDICT changed: a local clock is not an answer about the payment. Past
  // the TTL the cron USUALLY owns the attempt, but the claim window is 15-45 minutes
  // with a batch cap and a pending read re-queues, so the marker survives its own
  // expiry rather than costing a still-open attempt its route back.
  if (isContinuationExpired(pending)) return "no_action_keep_marker";
  const result = await readPendingContinuation(pending);
  const decision = decidePendingResume(pending, result, selectedProvider);
  // ⛔ "I could not read the status" is not the same answer as "the server said
  // there is nothing here", and only the second one may destroy the marker.
  // `decidePendingResume` collapses both onto `discard` for an `action_issued`
  // marker, which is right about the WAIT (nothing can be settling) and wrong
  // about the marker: dropping it deletes the only route back to the action the
  // server already issued, while the anti-double-charge gate goes on refusing
  // every re-submit for the rest of the reconciliation window. One dropped
  // packet would cost the buyer their whole checkout. So a transport blip is
  // surfaced as its own outcome and the marker survives it.
  // An unreadable status must still HALT the submit, which the keep-marker answer
  // does not; both collapse in the tail, so both are lifted back here.
  const keptOrDropped = decision === "discard" || decision === "no_action_keep_marker";
  return result.kind === "checking" && keptOrDropped ? "unknown" : decision;
}

/**
 * Has this marker outlived the window in which it can still be true?
 *
 * Past it the payment reconciliation cron owns the attempt, so continuing to act
 * on the marker offers the buyer a wait on something already being terminalized
 * elsewhere. Checked BEFORE the status lookup: an expired marker is a local fact
 * and costs no request to establish.
 *
 * A marker written before expiries existed carries no `expiresAt`. It is read as
 * un-expired rather than as expired-by-default, because the phase check below is
 * the safety property and this one is only its bound.
 */
export function isContinuationExpired(
  pending: CheckoutContinuationContext,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return typeof pending.expiresAt === "number" && pending.expiresAt <= nowSeconds;
}

/**
 * A marker with no phase predates phases. Read it as `confirm_dispatched` — the
 * half that keeps today's behaviour — so an in-flight charge from before the
 * deploy is never abandoned by a rule it could not have been written under.
 */
export function continuationPhase(pending: CheckoutContinuationContext): CheckoutContinuationPhase {
  return pending.phase ?? "confirm_dispatched";
}

export type PendingResumeDecision =
  | { kind: "reopen_embedded"; clientSecret: string }
  | { kind: "follow_redirect"; url: string }
  | "wait_on_status"
  /** The status could not be read. KEEP the marker and act on nothing. */
  | "unknown"
  /**
   * Nothing to act on, and no answer that it is over. ⛔ Deliberately NOT `discard`:
   * an answer about the ACTION says nothing about the attempt row the gate reads, so
   * destroying the marker on it left the buyer with neither the action nor the status
   * page. The submit proceeds as before; the marker survives for the refusal seam.
   */
  | "no_action_keep_marker"
  /**
   * The buyer wants a different rail, and an attempt on the old one is still open.
   *
   * ⛔ This value does NOT mean the old attempt was superseded, and it used to be
   * named as though it did. Nothing in the browser can supersede it: the
   * anti-double-charge gate admits a second provider call only when the intent's
   * `active_attempt_id` names an attempt in `blocked_preflight | failed |
   * cancelled | expired`, and it reads that pointer rather than any idempotency
   * key. Moving the browser's attempt sequence only suffixes a prepare key, so the
   * previous shape of this decision - drop the marker, bump the sequence, let the
   * submit through - sent the buyer into `provider_attempt_in_flight` with the one
   * artifact that could have routed them out already destroyed.
   *
   * So the honest answer is to stop the submit and say so. `provider` names the
   * rail the open attempt belongs to, and `clientSecret` is how the buyer finishes
   * it in place when the live action can be reopened at all.
   */
  | {
    kind: "blocked_by_prior_attempt";
    provider: PspProviderKind;
    clientSecret: string | null;
  }
  | "discard";

/** The five things a resume decision can ever mean, named once. */
export type PendingResumeEffects = {
  reopenAction: (clientSecret: string) => void;
  /** Leave for the URL the action names — the buyer still has to visit it. */
  followRedirect: (url: string) => void;
  waitOnStatus: () => void;
  /** The server ANSWERED that there is nothing here. */
  discardMarker: () => void;
  /** Answered, but with nothing to act on: keep the marker, act on nothing. */
  keepMarker: () => void;
  /**
   * The buyer chose a rail the open attempt does not belong to. KEEP the marker -
   * it is the only artifact that can still reach either the live action or the
   * status page - and surface the choice instead of spending the submit on a
   * refusal. Only the submit path can ever receive this: the mount path names no
   * selection, so the decision cannot arise there.
   */
  blockOnPriorAttempt: (blocked: {
    provider: PspProviderKind;
    clientSecret: string | null;
  }) => void;
  /** The status could not be read: keep the marker, act on nothing. */
  cannotCheck: () => void;
};

/**
 * Turn a decision into exactly ONE effect; return whether the marker was acted
 * on, which is what a submit needs in order to stop.
 *
 * ⛔ Sharing the resolver was not enough. Both resume moments already called
 * `resolvePendingResume` and then each re-implemented this mapping — and they
 * disagreed: mount obeyed `follow_redirect` by leaving for the URL, while submit
 * let it fall through a `decision !== "discard"` test into the status poller and
 * DROPPED the URL, parking the buyer on a wait for a payment only that page
 * could complete. One decision must mean one thing, so the branch on a decision
 * lives here and nowhere else.
 */
export function applyPendingResume(
  decision: PendingResumeDecision,
  effects: PendingResumeEffects,
): boolean {
  if (decision === "discard") { effects.discardMarker(); return false; }
  // FALSE like `discard` - the submit goes on - without destroying the one artifact
  // that routes the buyer if the gate then refuses it.
  if (decision === "no_action_keep_marker") { effects.keepMarker(); return false; }
  if (decision === "unknown") { effects.cannotCheck(); return true; }
  if (decision === "wait_on_status") { effects.waitOnStatus(); return true; }
  // Returns TRUE: the submit STOPS. Letting it through is what spends the buyer's
  // press on a `provider_attempt_in_flight` refusal, and the marker is retained
  // because it carries the only ids that reach the action or the status page.
  if (decision.kind === "blocked_by_prior_attempt") {
    effects.blockOnPriorAttempt({
      provider: decision.provider,
      clientSecret: decision.clientSecret,
    });
    return true;
  }
  if (decision.kind === "follow_redirect") { effects.followRedirect(decision.url); return true; }
  effects.reopenAction(decision.clientSecret);
  return true;
}

/**
 * What to do with a marker whose live status has just been read.
 *
 * The one rule worth stating plainly: when the status carries no action this
 * marker can act on, PHASE decides — not the transport. `action_issued` means
 * the provider was never called, so nothing can be settling and there is nothing
 * to wait for; sending that buyer to the status poller is what produced a
 * terminal `failed` on an order nobody attempted to pay, because the poller
 * escalates to a live provider read and an unconfirmed intent reads as
 * `requires_payment_method`, which normalizes to `failed`. Dropping the marker
 * instead returns the buyer to the card form, where a re-submit reuses the same
 * journey-stable idempotency key and therefore the same order and intent.
 *
 * ⚠️ That last sentence is about the KEY, not about success: the re-submit
 * addresses the same order, but while the attempt row is open the
 * anti-double-charge gate answers `provider_attempt_in_flight` until the
 * reconciliation cron closes it. So `discard` is only ever correct on an answer
 * from the server — see `resolvePendingResume` for why an unreadable status is
 * routed to `unknown` and keeps the marker instead.
 *
 * `confirm_dispatched` keeps the wait: there a charge genuinely may be live, and
 * an unsettled provider call is exactly what the poller exists for.
 */
export function decidePendingResume(
  pending: CheckoutContinuationContext,
  result: PendingContinuationResult,
  /**
   * The rail the buyer wants NOW, or null/undefined when nobody has chosen since
   * this marker was written. Supplied only by the submit path: at mount the buyer
   * has made no new choice, so omitting it there is what keeps both resume moments
   * deciding the same thing about the same facts.
   */
  selectedProvider?: PspProviderKind | null,
): PendingResumeDecision {
  if (result.kind === "terminal") return "discard";
  const action = result.kind === "active" ? result.response.nextAction : null;
  const payment = result.kind === "active" ? result.response.payment : null;
  // The buyer changed rails and this action was never committed to, so nothing can
  // be settling on it: `action_issued` means the intent has no payment method.
  // Reopening it here is what showed a card modal to a buyer who had just picked
  // BLIK. `confirm_dispatched` falls through untouched - there a charge may be
  // live, and what the buyer has since clicked cannot make it not be.
  //
  // ⛔ The open rail comes from `payment.provider`, never `action.provider`, which
  // is withheld unless the codec's claims match and only names the embedded rail -
  // making every code-entry marker invisible here. RETRYABLE_ATTEMPT_STATUSES is
  // admission gate's OWN set: sitting in it means the server admits the next call,
  // so blocking refuses what the server allows (the 2026-09-02 P0). Fail-closed.
  const openRail = PSP_PROVIDER_KINDS.find((kind) => kind === payment?.provider)
    ?? (action && "provider" in action ? action.provider : null);
  const priorAttemptAdmitted = payment?.attemptStatus != null
    && (RETRYABLE_ATTEMPT_STATUSES as readonly string[]).includes(payment.attemptStatus);
  if (
    openRail
    && selectedProvider
    && openRail !== selectedProvider
    && !priorAttemptAdmitted
    && continuationPhase(pending) === "action_issued"
  ) {
    return {
      kind: "blocked_by_prior_attempt",
      provider: openRail,
      clientSecret: action?.kind === "provider_embedded" ? action.clientSecret ?? null : null,
    };
  }
  if (
    pending.actionKind === "embedded"
    && action?.kind === "provider_embedded"
    && action.provider === PSP_PROVIDER_KINDS[0]
    && action.clientSecret
  ) {
    return { kind: "reopen_embedded", clientSecret: action.clientSecret };
  }
  if (pending.actionKind === "redirect" && action?.kind === "redirect") {
    return { kind: "follow_redirect", url: action.url };
  }
  return continuationPhase(pending) === "action_issued" ? "no_action_keep_marker" : "wait_on_status";
}

export type PendingContinuationResult =
  | { kind: "active"; response: PaymentStatusResponse }
  | { kind: "checking" }
  | { kind: "terminal" };

export async function readPendingContinuation(
  pending: CheckoutContinuationContext,
): Promise<PendingContinuationResult> {
  try {
    const statusRequest: PaymentStatusContinuationRequest = {
      orderId: pending.orderId,
      paymentIntentId: pending.paymentIntentId,
      clientId: pending.clientId,
      journeyId: pending.journeyId,
    };
    const response = await getCommercePaymentStatus(statusRequest);
    return response.status === "paid" ||
        response.status === "failed" ||
        response.status === "expired"
      ? { kind: "terminal" }
      : { kind: "active", response };
  } catch (error) {
    // A DEFINITIVE 404/403 means the order no longer exists or isn't ours: fail
    // CLOSED (drop the marker, let the caller mint a fresh order) so a transient
    // lookup error after a real `paid` can't strand the buyer resuming a completed
    // order. A network/transport blip (no BffClientError, or a 5xx) stays fail-OPEN
    // and resumes — the payment-status page re-checks and self-heals from there.
    if (error instanceof BffClientError && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) {
      return { kind: "terminal" };
    }
    return { kind: "checking" };
  }
}
