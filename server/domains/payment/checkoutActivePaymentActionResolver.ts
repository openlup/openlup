import type {
  PaymentProviderRecoveryProvider,
  ProviderRecoveryAction,
} from "./checkoutRecoveryPaymentResolver.js";
import {
  toClaimedAttemptShape,
  type PaymentVerifyReadPort,
  type VerifiableAttemptSnapshot,
} from "./paymentVerifyNowService.js";
import {
  PSP_PROVIDER_KINDS,
  type PspProviderKind,
} from "../../../src/domains/payment/pspIntegrationPlan.js";

export interface ActivePaymentActionAuthority {
  orderId: string;
  clientId: string;
  paymentIntentId: string;
  paymentAttemptId: string;
  executionRail: PspProviderKind;
}

export interface CheckoutActivePaymentActionResolver {
  readActiveAction(authority: ActivePaymentActionAuthority): Promise<ProviderRecoveryAction | null>;
}

export type CheckoutActionReadProvider = Pick<
  PaymentProviderRecoveryProvider,
  "resolvePaymentReference" | "readRecoveryPayment"
>;

const LIVE_INTENT_STATUSES = new Set(["requires_action", "processing"]);
const LIVE_ATTEMPT_STATUSES = new Set(["sent_to_provider", "requires_action", "processing"]);

export function createCheckoutActivePaymentActionResolver(deps: {
  readPort: PaymentVerifyReadPort;
  providers: Partial<Record<string, CheckoutActionReadProvider>>;
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
          || !actionMatchesRail(reading.clientAction, authority.executionRail)
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

export function projectCheckoutActionReadProviders(
  registry: Partial<Record<string, PaymentProviderRecoveryProvider>>,
): Partial<Record<string, CheckoutActionReadProvider>> {
  return Object.fromEntries(PSP_PROVIDER_KINDS.flatMap((rail) => {
    const adapter = registry[rail];
    return adapter
      ? [[rail, {
          resolvePaymentReference: adapter.resolvePaymentReference.bind(adapter),
          readRecoveryPayment: adapter.readRecoveryPayment.bind(adapter),
        }]]
      : [];
  }));
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
  action: ProviderRecoveryAction,
  rail: ActivePaymentActionAuthority["executionRail"],
): boolean {
  return rail === PSP_PROVIDER_KINDS[0]
    ? action.kind === "provider_embedded" && action.provider === PSP_PROVIDER_KINDS[0]
    : action.kind === "redirect";
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
