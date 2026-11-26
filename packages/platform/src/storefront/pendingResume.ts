import type { PaymentProviderFacts, PendingAction, StatusReading, StatusTransportBinding } from "./bindings.js";

/**
 * What to do with a pending action once its status has been read.
 *
 * - `reopen_embedded`: open the embedded action again with `actionToken`.
 * - `follow_redirect`: send the buyer to `url`, which they still have to visit.
 * - `wait_on_status`: wait on the purchase status, because a charge may be live.
 * - `unknown`: the status could not be read. Keep the marker, act on nothing
 *   and halt the submit.
 * - `no_action_keep_marker`: there is nothing to act on and no answer that the
 *   purchase is over. Keep the marker; the submit may proceed.
 * - `blocked_by_prior_attempt`: the buyer selected another provider while an
 *   attempt on `provider` is still open and that provider was not called yet.
 *   Keep the marker and halt the submit. `actionToken` is the open embedded
 *   action's token, or `null` when there is none.
 * - `discard`: the server answered that the purchase is over. Drop the marker;
 *   the submit may proceed.
 *
 * The union is open: members may be added in a minor release.
 * `applyPendingResume` reads a decision it does not know as `unknown`.
 *
 * @experimental
 */
export type PendingResumeDecision =
  | { kind: "reopen_embedded"; actionToken: string }
  | { kind: "follow_redirect"; url: string }
  | "wait_on_status"
  | "unknown"
  | "no_action_keep_marker"
  | { kind: "blocked_by_prior_attempt"; provider: string; actionToken: string | null }
  | "discard";

/**
 * Checks a pending action against its live status and returns one decision.
 *
 * A marker whose numeric `expiresAt` is at or before the current second of
 * `clock.now()` is expired: it returns `no_action_keep_marker` without reading
 * the status. Otherwise it calls `status.read` once with the same `pending`
 * object and decides with `decidePendingResume`, passing `selectedProvider`
 * unchanged. When the reading is neither `active` nor `terminal`, which
 * includes `checking` and a kind this version does not know, a `discard` or
 * `no_action_keep_marker` decision becomes `unknown`: only the server's answer
 * may drop the marker, and an unreadable status still halts the submit.
 *
 * An error the status binding raises propagates unchanged.
 *
 * @experimental
 */
export async function checkPendingResume<C extends PendingAction>(
  bindings: { status: StatusTransportBinding<C>; clock: { now: () => number }; providerFacts: PaymentProviderFacts },
  pending: C,
  selectedProvider?: string | null,
): Promise<PendingResumeDecision> {
  if (isExpired(pending, bindings.clock)) return "no_action_keep_marker";
  const reading = await bindings.status.read(pending);
  const decision = decidePendingResume(bindings, pending, reading, selectedProvider);
  const answered = reading.kind === "active" || reading.kind === "terminal";
  return !answered && (decision === "discard" || decision === "no_action_keep_marker") ? "unknown" : decision;
}

/**
 * Decides what to do with a pending action from one status reading. The first
 * matching rule wins:
 *
 * 1. A `terminal` reading: `discard`.
 * 2. The payment and action come from an `active` reading; any other reading
 *    carries neither.
 * 3. The open rail is the first of `providers` equal to the payment's
 *    `provider`; else the provider the action names, for an `embedded`,
 *    `other` or unknown action kind; else none.
 * 4. With an open rail, a `selectedProvider` that differs from it, an attempt
 *    status that is not in `retryableAttemptStatuses` (absent or `null` is
 *    not), and phase `action_issued`: `blocked_by_prior_attempt` with that
 *    provider and the embedded action's token, or `null`.
 * 5. An `embedded` marker, an `embedded` action of a provider in
 *    `reopenableEmbeddedProviders` and a non-empty token: `reopen_embedded`.
 * 6. A `redirect` marker and a `redirect` action: `follow_redirect`.
 * 7. Otherwise `no_action_keep_marker` for phase `action_issued`, else
 *    `wait_on_status`.
 *
 * An `actionKind` this version does not know acts as `none`, a phase it does
 * not know acts as `confirm_dispatched`, and an action kind it does not know
 * acts as `other`: it is never reopened or followed, while a provider it names
 * still counts in rule 3. Provider names are opaque strings compared exactly.
 *
 * @experimental
 */
export function decidePendingResume(
  bindings: { providerFacts: PaymentProviderFacts },
  pending: PendingAction,
  reading: StatusReading,
  selectedProvider?: string | null,
): PendingResumeDecision {
  if (reading.kind === "terminal") return "discard";
  const action = reading.kind === "active" ? reading.action : null;
  const payment = reading.kind === "active" ? reading.payment : null;
  const facts = bindings.providerFacts;
  const openRail = facts.providers.find(provider => provider === payment?.provider)
    ?? (action && action.kind !== "redirect" && "provider" in action ? action.provider : null);
  const priorAttemptAdmitted = payment?.attemptStatus != null
    && facts.retryableAttemptStatuses.includes(payment.attemptStatus);
  if (
    openRail
    && selectedProvider
    && openRail !== selectedProvider
    && !priorAttemptAdmitted
    && isActionIssued(pending)
  ) {
    return {
      kind: "blocked_by_prior_attempt",
      provider: openRail,
      actionToken: action?.kind === "embedded" ? action.actionToken ?? null : null,
    };
  }
  if (
    pending.actionKind === "embedded"
    && action?.kind === "embedded"
    && facts.reopenableEmbeddedProviders.some(provider => provider === action.provider)
    && action.actionToken
  ) {
    return { kind: "reopen_embedded", actionToken: action.actionToken };
  }
  if (pending.actionKind === "redirect" && action?.kind === "redirect") {
    return { kind: "follow_redirect", url: action.url };
  }
  return isActionIssued(pending) ? "no_action_keep_marker" : "wait_on_status";
}

/**
 * Turns a decision into exactly one effect and returns whether the submit must
 * stop:
 *
 * - `discard`: `discardMarker`, `false`.
 * - `no_action_keep_marker`: `keepMarker`, `false`.
 * - `unknown`: `cannotCheck`, `true`.
 * - `wait_on_status`: `waitOnStatus`, `true`.
 * - `blocked_by_prior_attempt`: `blockOnPriorAttempt({ provider, actionToken })`,
 *   `true`.
 * - `follow_redirect`: `followRedirect(url)`, `true`.
 * - `reopen_embedded`: `reopenAction(actionToken)`, `true`.
 * - A decision this version does not know: `cannotCheck`, `true`. It keeps the
 *   marker, acts on nothing and halts the submit.
 *
 * An error an effect raises propagates unchanged.
 *
 * @experimental
 */
export function applyPendingResume(
  decision: PendingResumeDecision,
  effects: {
    reopenAction: (actionToken: string) => void;
    followRedirect: (url: string) => void;
    waitOnStatus: () => void;
    discardMarker: () => void;
    keepMarker: () => void;
    blockOnPriorAttempt: (blocked: { provider: string; actionToken: string | null }) => void;
    cannotCheck: () => void;
  },
): boolean {
  if (decision === "discard") { effects.discardMarker(); return false; }
  if (decision === "no_action_keep_marker") { effects.keepMarker(); return false; }
  if (decision === "unknown") { effects.cannotCheck(); return true; }
  if (decision === "wait_on_status") { effects.waitOnStatus(); return true; }
  if (typeof decision === "object" && decision !== null) {
    if (decision.kind === "blocked_by_prior_attempt") {
      effects.blockOnPriorAttempt({ provider: decision.provider, actionToken: decision.actionToken });
      return true;
    }
    if (decision.kind === "follow_redirect") { effects.followRedirect(decision.url); return true; }
    if (decision.kind === "reopen_embedded") { effects.reopenAction(decision.actionToken); return true; }
  }
  effects.cannotCheck();
  return true;
}

function isExpired(pending: PendingAction, clock: { now: () => number }): boolean {
  return typeof pending.expiresAt === "number" && pending.expiresAt <= Math.floor(clock.now() / 1000);
}

/** A phase other than `action_issued`, absent or unknown, acts as `confirm_dispatched`. */
function isActionIssued(pending: PendingAction): boolean {
  return pending.phase === "action_issued";
}
