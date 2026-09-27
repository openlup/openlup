import { describe, expect, expectTypeOf, it } from "vitest";
import * as movedPaymentForm from "@/checkout/adapters/stripe/PaymentForm";
import * as movedRecoveryPaymentSetupForm from "@/checkout/adapters/stripe/RecoveryPaymentSetupForm";
import * as movedStripePaymentStep from "@/checkout/adapters/stripe/StripePaymentStep";
import * as movedUseStripePromise from "@/checkout/adapters/stripe/useStripePromise";
import type * as contracts from "@/domains/payment/paymentFormContracts";
import * as deprecatedPaymentForm from "./PaymentForm";
import * as deprecatedRecoveryPaymentSetupForm from "./RecoveryPaymentSetupForm";
import * as deprecatedStripePaymentStep from "./StripePaymentStep";
import * as deprecatedUseStripePromise from "./useStripePromise";

// Pins what each deprecated re-export in this directory hands an existing
// importer: exactly the value bindings its module exported before the move,
// each the very binding of the moved module, and each type-only name as the
// type that owns it now. The expectTypeOf pins do nothing at run time: the
// typecheck job (npm run oss:published-tree -- --typecheck) enforces them, not
// Vitest. ../deprecatedReExportRemoval.test.ts pins the @deprecated tag on every
// name; both go with the shims in openlup-source-preview/9.
const SHIMS = [
  { shim: "PaymentForm", deprecated: deprecatedPaymentForm, moved: movedPaymentForm, values: ["PaymentForm"] },
  { shim: "RecoveryPaymentSetupForm", deprecated: deprecatedRecoveryPaymentSetupForm, moved: movedRecoveryPaymentSetupForm, values: ["RecoveryPaymentSetupForm"] },
  { shim: "StripePaymentStep", deprecated: deprecatedStripePaymentStep, moved: movedStripePaymentStep, values: ["StripePaymentStep"] },
  {
    shim: "useStripePromise",
    deprecated: deprecatedUseStripePromise,
    moved: movedUseStripePromise,
    values: ["resetStripePromiseCacheForTests", "STRIPE_LOAD_TIMEOUT_MS", "useStripeLoader", "useStripePromise"],
  },
] as const;

describe("deprecated payment UI re-exports", () => {
  it.each(SHIMS)("$shim re-exports exactly its pre-move value bindings, unchanged", ({ deprecated, moved, values }) => {
    const shim = deprecated as Record<string, unknown>, owner = moved as Record<string, unknown>;
    expect(Object.keys(shim).sort()).toEqual([...values].sort());
    for (const name of values) {
      expect(shim[name]).toBeDefined();
      expect(shim[name]).toBe(owner[name]);
    }
  });

  it("re-exports each type-only name as the type that owns it now", () => {
    expectTypeOf<deprecatedPaymentForm.PaymentFormProps>().toEqualTypeOf<movedPaymentForm.PaymentFormProps>();
    expectTypeOf<deprecatedPaymentForm.PaymentFormCopy>().toEqualTypeOf<contracts.PaymentFormCopy>();
    expectTypeOf<deprecatedPaymentForm.PaymentFormSettlement>().toEqualTypeOf<contracts.PaymentFormSettlement>();
    expectTypeOf<deprecatedRecoveryPaymentSetupForm.RecoveryPaymentSetupFormProps>().toEqualTypeOf<movedRecoveryPaymentSetupForm.RecoveryPaymentSetupFormProps>();
    expectTypeOf<deprecatedRecoveryPaymentSetupForm.RecoveryPaymentSetupFormCopy>().toEqualTypeOf<contracts.RecoveryPaymentSetupFormCopy>();
    expectTypeOf<deprecatedStripePaymentStep.StripePaymentStepProps>().toEqualTypeOf<movedStripePaymentStep.StripePaymentStepProps>();
    expectTypeOf<deprecatedUseStripePromise.StripeLoadStatus>().toEqualTypeOf<movedUseStripePromise.StripeLoadStatus>();
    expectTypeOf<deprecatedUseStripePromise.StripeLoaderState>().toEqualTypeOf<movedUseStripePromise.StripeLoaderState>();
  });
});
