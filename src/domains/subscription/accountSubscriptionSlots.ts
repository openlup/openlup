/**
 * Which subscription, if any, currently occupies a subject's slot.
 *
 * A subscription platform that lets one account hold several subjects — one per
 * animal, child, vehicle, desk, whatever the deployment sells for — needs one
 * answer to "does this subject already have a plan?", and needs it in exactly
 * two places: the surface that offers a new plan, and the surface that labels an
 * existing one. Two call sites reading two different status sets is how an
 * account ends up paying twice for the same subject.
 *
 * The two predicates below are that single answer. They read only the fields the
 * account contract already publishes, so no deployment vocabulary is involved in
 * deciding the question — only in naming the subject, which the contract does.
 */
/**
 * The only two fields these predicates read.
 *
 * Declared here as a structural port rather than imported from the account
 * contract on purpose: a domain module may not reach into another domain's
 * internals (`src/lib/architectureGuardrails.test.ts`), and this question does
 * not need the account's full response shape — it needs an owner reference and
 * a status. Both predicates are generic over it, so a caller passing its own
 * richer subscription type gets that same type back and keeps every other field.
 */
export interface SubscriptionSlotOccupant {
  /**
   * The subject this subscription belongs to. The field name is fixed by the
   * already-publishable account contract, which this port must match
   * structurally; it is not this module's choice of vocabulary.
   */
  petId?: string | null;
  status: string;
}

/**
 * Statuses that mean a subject already occupies a live subscription slot.
 * ⛔ GUARD set — do NOT narrow. `pending_activation` (an unpaid remnant left by
 * an abandoned checkout) MUST stay here: it is what stops an account opening a
 * second subscription for the same subject.
 */
const OCCUPYING_SUB_STATUSES = new Set(["active", "paused", "pending_activation"]);

/**
 * Statuses that mean a subscription is *paid and live* — worthy of an "active
 * subscription" label in the UI. Deliberately narrower than
 * {@link OCCUPYING_SUB_STATUSES}: `pending_activation` still occupies the
 * duplicate-guard slot but is unpaid, so it must be shown as "finish payment",
 * never as an active subscription. DISPLAY-only — never feed this to the guard.
 */
const ACTIVE_LABEL_SUB_STATUSES = new Set(["active", "paused"]);

/**
 * The live (active/paused/pending) subscription occupying a subject's slot, or
 * null. Single source of truth for the duplicate-subscription guard — used by
 * both the seed (to force one-time) and the subject picker (to badge + steer).
 */
export function liveSubscriptionForSubject<Subscription extends SubscriptionSlotOccupant>(
  subscriptions: readonly Subscription[],
  subjectId: string,
): Subscription | null {
  return (
    subscriptions.find(
      (sub) => sub.petId === subjectId && OCCUPYING_SUB_STATUSES.has(sub.status),
    ) ?? null
  );
}

/**
 * Whether an occupying subscription should be presented as *active and paid*.
 * Returns false for `pending_activation` (occupies the guard slot but is
 * unpaid), so the picker can show "finish payment" instead of "already active".
 * DISPLAY decision only — the duplicate guard still keys off
 * {@link liveSubscriptionForSubject}.
 */
export function isActivePaidSubscription(
  subscription: SubscriptionSlotOccupant | null,
): boolean {
  return subscription !== null && ACTIVE_LABEL_SUB_STATUSES.has(subscription.status);
}
