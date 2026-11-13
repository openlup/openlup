import type { PaymentAdapterConformanceSubject } from "./contracts/conformance.js";
import type { PaymentAttemptPort, PaymentExecutionEnvelope } from "./contracts/adapter.js";
import type { ScriptedPaymentOutcome } from "./testing/index.js";
import type { PaymentMoney, PaymentVerifyNormalizePort } from "./contracts/evidence.js";

export type PaymentWebhookFixture = {
  input: Parameters<PaymentVerifyNormalizePort["verifyAndNormalize"]>[0];
  expected: Awaited<ReturnType<PaymentVerifyNormalizePort["verifyAndNormalize"]>>;
};
export type PaymentTransportScenario = "timeout-before-dispatch" | "provider-5xx-before-dispatch"
  | "timeout-after-dispatch" | "redelivery-409";

export type PaymentTransportFixture = {
  execute: () => Promise<PaymentExecutionEnvelope>;
  /** The injected scripted fake's log: the runner checks the intended fault ran. */
  calls: readonly { kind: ScriptedPaymentOutcome<unknown>["kind"] }[];
};

/** Adapter authors supply signed original bytes and bind the shared scripted fake
 * to their injected client. Each transport callback must execute the real adapter.
 * These offline probes establish no durable-store or provider qualification.
 */
export interface PaymentAdapterSafetyScenarios {
  transport: Record<PaymentTransportScenario, PaymentTransportFixture>;
  /** One successful execution per declared currency and capture family, plus an
   * unattended attempt (or a refused invocation when unattended is unsupported). */
  capabilityInputs: readonly Parameters<PaymentAttemptPort["execute"]>[0][];
  /** An otherwise valid request with a currency outside the declared set. */
  unsupportedCurrencyInput: Parameters<PaymentAttemptPort["execute"]>[0];
  /** Omit required payer/method context; adapters with required context must supply it. */
  missingRequiredInput?: Parameters<PaymentAttemptPort["execute"]>[0];
  webhooks: Record<"valid" | "duplicate" | "signatureMismatch" | "partialAmount" | "zeroAmount"
    | "missingAmount" | "missingCurrency" | "chargeback", PaymentWebhookFixture>;
  partialMoney: PaymentMoney;
}

/** Existing baseline callers remain valid; supply safety for the complete kit. */
export type PaymentAdapterTestSubject = PaymentAdapterConformanceSubject & {
  verification: readonly PaymentWebhookFixture[];
  safety?: PaymentAdapterSafetyScenarios;
};
