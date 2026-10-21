// Shared PaymentExecutionPort contract (Provider Entry Gate, F1).
//
// The SAME minimal assertion set runs against payment execution adapters that
// can be exercised with fake/no-op clients. It intentionally stays app-side:
// current execution input still contains downstream provider extensions, so
// exporting this from public core would make provider coupling look neutral.
// `.testFixtures.ts` keeps vitest from collecting this as a standalone suite.

import { describe, expect, it } from "vitest";
import {
  paymentExecutionBaseContractInput,
  validatePaymentExecutionContractResult,
  type PaymentExecutionContractResult,
  type PaymentExecutionBaseInput,
} from "@openlup/core/testing";
import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";
import { describeDunningConformanceKit } from "./dunningConformanceKit.testFixtures.js";

export { paymentExecutionBaseContractInput } from "@openlup/core/testing";

export const paymentExecutionContractInput = {
  ...paymentExecutionBaseContractInput,
  orderRef: "order_contract",
} satisfies PaymentExecutionBaseInput & { orderRef: string };

export type PaymentExecutionPortContractResult = PaymentExecutionContractResult;

export interface PaymentExecutionPortContractSubject<
  TInput extends PaymentExecutionBaseInput,
  TResult extends PaymentExecutionPortContractResult,
> {
  execute(input: TInput): Promise<TResult>;
}

export interface PaymentExecutionPortContractScenario<
  TInput extends PaymentExecutionBaseInput = typeof paymentExecutionContractInput,
  TResult extends PaymentExecutionPortContractResult = PaymentExecutionPortContractResult,
> {
  name: string;
  expectedProvider: string;
  allowedNextActionKinds?: readonly string[];
  input: TInput;
  sensitiveValues?: readonly string[];
  assertResult?: (context: { input: TInput; result: TResult }) => void | Promise<void>;
}

export interface PaymentExecutionPortContractSuiteOptions<
  TInput extends PaymentExecutionBaseInput = typeof paymentExecutionContractInput,
  TResult extends PaymentExecutionPortContractResult = PaymentExecutionPortContractResult,
> {
  name: string;
  createSubject: () => PaymentExecutionPortContractSubject<TInput, TResult>;
  scenarios: readonly PaymentExecutionPortContractScenario<TInput, TResult>[];
}

/**
 * The unattended-charge conformance matrix (Provider Entry Gate, F1 seed).
 *
 * One scenario set that every payment execution adapter used for off-session
 * renewal must satisfy, run against the adapter's OWN test doubles and against
 * its published capability descriptor, so the two cannot drift apart. It is
 * deliberately small: these are the behaviours the renewal and dunning rails
 * already depend on, not a wish list.
 */
/**
 * The neutral result plus the one app-side fact this matrix reads: whether a
 * callback is still promised. It is not in the core contract because it is a
 * saga expectation rather than a provider fact.
 */
export type UnattendedChargeResult = PaymentExecutionPortContractResult & {
  webhookExpected?: boolean;
};

export interface UnattendedChargeConformanceSubject<
  TInput extends PaymentExecutionBaseInput = typeof paymentExecutionContractInput,
  TResult extends UnattendedChargeResult = UnattendedChargeResult,
> {
  name: string;
  capability: PaymentProviderCapabilityDescriptor;
  /** Charge input WITHOUT `providerFlow`; the matrix supplies the declared flow. */
  chargeInput: Omit<TInput, "providerFlow">;
  /** A port whose provider refuses the charge with a code it can read neutrally. */
  createSoftDecliningPort: () => PaymentExecutionPortContractSubject<TInput, TResult>;
  /** A port that fails for any reason that is NOT decline evidence. */
  createNonDeclineFailurePort: () => PaymentExecutionPortContractSubject<TInput, TResult>;
  /** Stored consent this provider may charge unattended. */
  chargeableMandate: Parameters<PaymentProviderCapabilityDescriptor["assessMandate"]>[0];
  /** Stored consent it may not, or null when this provider judges no consent model. */
  unchargeableMandate: Parameters<PaymentProviderCapabilityDescriptor["assessMandate"]>[0] | null;
  /**
   * Whether a refused charge publishes a handle a later provider callback can
   * correlate to. Declared per subject rather than asserted uniformly BECAUSE
   * the rails currently disagree, and a matrix that hid that would be lying.
   */
  declineCorrelation: "withheld" | "published";
}

export function describeUnattendedChargeConformance<
  TInput extends PaymentExecutionBaseInput = typeof paymentExecutionContractInput,
  TResult extends UnattendedChargeResult = UnattendedChargeResult,
>(subject: UnattendedChargeConformanceSubject<TInput, TResult>): void {
  const chargeInput = () => ({
    ...subject.chargeInput,
    providerFlow: subject.capability.unattendedChargeFlow,
  } as unknown as TInput);

  describe(`unattended charge conformance: ${subject.name}`, () => {
    it("reports a refusal as a decline with a neutral reading instead of raising", async () => {
      const result = await subject.createSoftDecliningPort().execute(chargeInput());

      // Binds the descriptor to the rail: a registry key that does not match the
      // identity the adapter emits would route renewals by the wrong rules.
      expect(result.provider).toBe(subject.capability.providerKind);
      expect(result.providerDecline?.code).toBeTruthy();
      expect(result.providerDecline?.neutralReasonHints).toEqual(expect.arrayContaining([expect.any(String)]));
      // Terminal transitions belong to the control plane, which reads the decline.
      expect(result.attemptStatus).toBe("processing");
    });

    it("promises no webhook for a charge already refused inside the call", async () => {
      const result = await subject.createSoftDecliningPort().execute(chargeInput());

      expect(result.webhookExpected).toBe(false);
    });

    it("publishes the declared correlation posture for a refused charge", async () => {
      const result = await subject.createSoftDecliningPort().execute(chargeInput());
      const handles = [result.providerAttemptId, result.providerSessionId];

      expect(handles.every((handle) => handle === null))
        .toBe(subject.declineCorrelation === "withheld");
    });

    it("raises a non-decline failure rather than inventing decline evidence", async () => {
      await expect(subject.createNonDeclineFailurePort().execute(chargeInput())).rejects.toThrow();
    });

    it("judges stored consent through its capability, before any provider call", () => {
      expect(subject.capability.assessMandate(subject.chargeableMandate))
        .toEqual({ chargeable: true });
      expect(subject.capability.requiresStoredMandateEvidence)
        .toBe(subject.unchargeableMandate !== null);

      if (subject.unchargeableMandate === null) return;
      expect(subject.capability.assessMandate(subject.unchargeableMandate)).toEqual({
        chargeable: false,
        blockReason: "mandate_model_unsupported_for_unattended_charge",
      });
    });

    describeDunningConformanceKit(subject, chargeInput);
  });
}

export function describePaymentExecutionPortContract<
  TInput extends PaymentExecutionBaseInput = typeof paymentExecutionContractInput,
  TResult extends PaymentExecutionPortContractResult = PaymentExecutionPortContractResult,
>(options: PaymentExecutionPortContractSuiteOptions<TInput, TResult>): void {
  describe(`PaymentExecutionPort contract: ${options.name}`, () => {
    for (const scenario of options.scenarios) {
      it(`${scenario.name}: returns normalized attempt facts without leaking sensitive provider values`, async () => {
        const input = scenario.input;
        const result = await options.createSubject().execute(input);
        const validation = validatePaymentExecutionContractResult({
          input,
          result,
          expectedProvider: scenario.expectedProvider,
          allowedNextActionKinds: scenario.allowedNextActionKinds,
          sensitiveValues: scenario.sensitiveValues,
        });

        expect(validation.issues).toEqual([]);
        expect(validation.ok).toBe(true);

        await scenario.assertResult?.({ input, result });
      });
    }
  });
}
