import type { ActivePaymentActionAuthority, CheckoutActivePaymentActionResolver, CheckoutActionReadProvider, PaymentRecoveryAction } from "./contracts/repair.js";
import type { PaymentVerifyReadPort, VerifiableAttemptSnapshot } from "./contracts/reconciliation.js";
import { toClaimedAttemptShape } from "./paymentVerifyNowService.js";

const LIVE_INTENT_STATUSES = new Set(["requires_action", "processing"]);
const LIVE_ATTEMPT_STATUSES = new Set(["sent_to_provider", "requires_action", "processing"]);

export function createCheckoutActivePaymentActionResolver(deps: {
  readPort: PaymentVerifyReadPort;
  providers: Partial<Record<string, CheckoutActionReadProvider>>;
  railHandoffKinds(rail: string): readonly ("redirect" | "client-confirmed")[];
}): CheckoutActivePaymentActionResolver {
  return {
    async readActiveAction(authority) {
      try {
        const initial = await deps.readPort.readVerifiableAttempt({
          orderId: authority.orderId,
          paymentIntentId: authority.paymentIntentId,
        });
        if (!matchesAuthority(initial, authority) || !isLive(initial)) return null;
        const provider = deps.providers[authority.executionRail];
        const providerPaymentId = provider?.resolvePaymentReference(initial) ?? null;
        if (!provider || !providerPaymentId) return null;
        const attempt = toClaimedAttemptShape(initial, providerPaymentId);
        const reading = await provider.readRecoveryPayment({
          providerPaymentId,
          attempt,
          purpose: "active_checkout",
        });
        if (
          !reading.clientAction
          || !actionMatchesRail(reading.clientAction, authority.executionRail, deps.railHandoffKinds)
          || reading.manualReviewRequired
          || !reading.identityMatches
          || !reading.configuredMoneyMatches
          || reading.status.status !== "pending"
        ) return null;

        const current = await deps.readPort.readVerifiableAttempt({
          orderId: authority.orderId,
          paymentIntentId: authority.paymentIntentId,
        });
        if (!sameCanonicalAttempt(initial, current) || !isLive(current)) return null;
        return reading.clientAction;
      } catch {
        return null;
      }
    },
  };
}

function matchesAuthority(
  snapshot: VerifiableAttemptSnapshot | null,
  authority: ActivePaymentActionAuthority,
): snapshot is VerifiableAttemptSnapshot {
  return Boolean(snapshot)
    && snapshot?.orderId === authority.orderId
    && snapshot.orderClientId === authority.clientId
    && snapshot.paymentIntentId === authority.paymentIntentId
    && snapshot.paymentAttemptId === authority.paymentAttemptId
    && snapshot.provider === authority.executionRail;
}

function isLive(snapshot: VerifiableAttemptSnapshot | null): snapshot is VerifiableAttemptSnapshot {
  return Boolean(snapshot)
    && LIVE_INTENT_STATUSES.has(snapshot?.intentStatus ?? "")
    && LIVE_ATTEMPT_STATUSES.has(snapshot?.attemptStatus ?? "");
}

function actionMatchesRail(
  action: PaymentRecoveryAction,
  rail: ActivePaymentActionAuthority["executionRail"],
  railHandoffKinds: (rail: string) => readonly ("redirect" | "client-confirmed")[],
): boolean {
  return action.provider === rail && railHandoffKinds(rail).includes(action.kind);
}

function sameCanonicalAttempt(
  before: VerifiableAttemptSnapshot,
  after: VerifiableAttemptSnapshot | null,
): after is VerifiableAttemptSnapshot {
  return Boolean(after)
    && after?.orderId === before.orderId
    && after.orderClientId === before.orderClientId
    && after.paymentIntentId === before.paymentIntentId
    && after.paymentAttemptId === before.paymentAttemptId
    && after.paymentId === before.paymentId
    && after.provider === before.provider
    && after.providerAttemptId === before.providerAttemptId
    && after.providerSessionId === before.providerSessionId
    && after.intentProviderPaymentId === before.intentProviderPaymentId
    && after.intentStatus === before.intentStatus
    && after.attemptStatus === before.attemptStatus
    && after.amountMinor === before.amountMinor
    && after.currency.toUpperCase() === before.currency.toUpperCase()
    && after.localUpdatedAt === before.localUpdatedAt;
}
