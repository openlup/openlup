import type { CheckoutRecoveryPaymentResolution, CheckoutRecoveryPaymentResolver, PaymentProviderRecoveryProvider } from "./contracts/repair.js";
import type { PaymentVerifyReadPort, VerifiableAttemptSnapshot, PaymentProviderReconciliationPort } from "./contracts/reconciliation.js";
import { terminalAmountMismatch } from "./paymentProviderReconciliationEvidence.js";
import { toClaimedAttemptShape, verifyPaymentAttemptNow } from "./paymentVerifyNowService.js";

const LIVE_ATTEMPT_STATUSES = new Set(["sent_to_provider", "requires_action", "processing", "created"]);

export function createCheckoutRecoveryPaymentResolver(deps: {
  readPort: PaymentVerifyReadPort;
  applyPort: Pick<PaymentProviderReconciliationPort, "applyTerminalResult">;
  providers: Partial<Record<string, PaymentProviderRecoveryProvider>>;
  now?: () => Date;
}): CheckoutRecoveryPaymentResolver {
  const now = deps.now ?? (() => new Date());
  return {
    async resolve(input) {
      if (!input.paymentIntentId) return { kind: "retry_new" };
      const snapshot = await deps.readPort.readVerifiableAttempt({
        orderId: input.orderId,
        paymentIntentId: input.paymentIntentId,
      });
      if (!snapshot) {
        return input.intentStatus === "created" || input.intentStatus === "failed"
          ? { kind: "retry_new" }
          : { kind: "awaiting_provider" };
      }
      return resolveSnapshot(snapshot, deps, now);
    },
  };
}

async function resolveSnapshot(
  snapshot: VerifiableAttemptSnapshot,
  deps: {
    readPort: PaymentVerifyReadPort;
    applyPort: Pick<PaymentProviderReconciliationPort, "applyTerminalResult">;
    providers: Partial<Record<string, PaymentProviderRecoveryProvider>>;
  },
  now: () => Date,
): Promise<CheckoutRecoveryPaymentResolution> {
  if (snapshot.attemptStatus === "succeeded" || snapshot.intentStatus === "succeeded") {
    return { kind: "paid" };
  }
  if (snapshot.attemptStatus === "failed" || snapshot.intentStatus === "failed") {
    return { kind: "retry_new" };
  }
  if (!LIVE_ATTEMPT_STATUSES.has(snapshot.attemptStatus)) {
    return { kind: "awaiting_provider" };
  }

  const provider = deps.providers[snapshot.provider];
  const providerPaymentId = provider?.resolvePaymentReference(snapshot) ?? null;
  if (!provider || !providerPaymentId) return { kind: "awaiting_provider" };
  const attempt = toClaimedAttemptShape(snapshot, providerPaymentId);

  try {
    // Every caller of this resolver is a buyer holding a recovery link open, so
    // an intent still waiting for its first payment method is one they can be
    // handed back — not one to close under them and replace.
    const recovery = await provider.readRecoveryPayment({
      providerPaymentId,
      attempt,
      purpose: "active_checkout",
    });
    if (
      recovery.manualReviewRequired
      || !recovery.identityMatches
      || !recovery.configuredMoneyMatches
    ) {
      return { kind: "manual_review" };
    }
    if (recovery.clientAction) {
      return { kind: "resume_existing", clientAction: recovery.clientAction };
    }
    if (recovery.status.status === "pending" || recovery.status.status === "unknown") {
      return { kind: "awaiting_provider" };
    }
    if (terminalAmountMismatch(attempt, recovery.status)) {
      return { kind: "manual_review" };
    }

    const verified = await verifyPaymentAttemptNow({
      snapshot,
      applyPort: deps.applyPort,
      providers: deps.providers,
      providerPaymentId,
      providerStatus: recovery.status,
      now,
    });
    if (verified.status !== "succeeded" && verified.status !== "failed") {
      return { kind: "awaiting_provider" };
    }

    const current = await deps.readPort.readVerifiableAttempt({
      orderId: snapshot.orderId,
      paymentIntentId: snapshot.paymentIntentId,
    });
    if (current?.attemptStatus === "succeeded" || current?.intentStatus === "succeeded") {
      return { kind: "paid" };
    }
    if (current?.attemptStatus === "failed" || current?.intentStatus === "failed") {
      return { kind: "retry_new" };
    }
    return verified.status === "succeeded" ? { kind: "paid" } : { kind: "retry_new" };
  } catch {
    return { kind: "awaiting_provider" };
  }
}
