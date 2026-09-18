import type { CheckoutKind } from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import type { VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import {
  CheckoutOrchestrationError,
  tryCompensate,
  type CheckoutCompensationPort,
} from "./commerceCheckoutOrchestration.js";
import type { CheckoutTimingOutcome } from "./commerceCheckoutTiming.js";
import {
  checkoutOrchestrationFailureDetails,
  safeCommerceDiagnosticValue,
} from "./commerceDiagnostics.js";
import {
  isJourneyConsumedCheckoutConflict,
  isStockUnavailableCheckoutConflict,
  START_RUNTIME_SIMPLE_CONFLICTS,
} from "./checkoutConflictClassifiers.js";
import { respondToPromotionCodePriceChange } from "./commerceCheckoutPromotionPriceChange.js";
import {
  CheckoutProviderAttemptFailure,
  logCheckoutProviderAttemptFailure,
} from "./commerceProviderAttemptFailure.js";

interface CheckoutFailureInput {
  error: unknown;
  compensationPort: CheckoutCompensationPort;
  intent: ConfiguratorIntent;
  res: VercelResponse;
  quotePort: CommerceQuotePort;
  provisioned: ConfiguratorIntentPersistenceResponse;
  checkoutKind: CheckoutKind;
  acceptedQuoteSnapshot: CreateQuoteResponse | null;
  expectedQuote?: {
    totalGross: { amountMinor: number; currency: string };
    pricingPolicy?: PricingPolicySnapshot;
  };
  resolvePricingPolicy?: (
    request: import("../../../src/domains/commerce/contracts.js").CreateQuoteRequest,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
  recordQuote: <T>(operation: () => Promise<T>) => Promise<T>;
}

export async function respondToCheckoutFailure(
  input: CheckoutFailureInput,
): Promise<CheckoutTimingOutcome> {
  const { error, compensationPort, intent } = input;
  if (error instanceof CheckoutProviderAttemptFailure) {
    logCheckoutProviderAttemptFailure(error);
  }

  // A prepared provider attempt is money-in-flight, even when the PSP request
  // threw. Its order can carry a reservation and provisional subscription, so
  // classify the existing client conflict before generic compensation. Payment
  // control reconciliation, never a browser retry, determines its outcome.
  for (const conflict of START_RUNTIME_SIMPLE_CONFLICTS) {
    if (conflict.match(error)) {
      sendBffError(input.res, "CONFLICT", conflict.message, {
        details: { feature: "checkout", stage: "start_runtime", reason: conflict.reason },
      });
      return "rejected";
    }
  }

  if (isStockUnavailableCheckoutConflict(error)) {
    if (error instanceof CheckoutOrchestrationError && error.orderIdForCompensation) {
      await tryCompensate(
        compensationPort,
        intent.idempotencyKey,
        error.orderIdForCompensation,
        { cancellationReason: "checkout_stock_unavailable" },
      );
    }
    sendBffError(input.res, "CONFLICT", "Stock unavailable", {
      details: { feature: "checkout", stage: "start_runtime", reason: "stock_unavailable" },
    });
    return "rejected";
  }
  if (isJourneyConsumedCheckoutConflict(error)) {
    // The journey key already finalized an order (completed out-of-band, e.g.
    // via a recovery link); this submit minted a fresh draft that can never
    // finalize under that key. Cancel the abandoned draft and tell the client
    // to rotate its journey key — retrying unrotated can never succeed.
    if (error instanceof CheckoutOrchestrationError && error.orderIdForCompensation) {
      await tryCompensate(
        compensationPort,
        intent.idempotencyKey,
        error.orderIdForCompensation,
        { cancellationReason: "checkout_journey_consumed" },
      );
    }
    sendBffError(input.res, "CONFLICT", "Checkout journey already completed", {
      details: { feature: "checkout", stage: "start_runtime", reason: "journey_consumed" },
    });
    return "rejected";
  }
  if (error instanceof CheckoutOrchestrationError && error.orderIdForCompensation) {
    await tryCompensate(compensationPort, intent.idempotencyKey, error.orderIdForCompensation);
  }
  if (
    error instanceof CheckoutOrchestrationError &&
    error.reason === "promotion_code_price_changed"
  ) {
    const responded = await respondToPromotionCodePriceChange({
      res: input.res,
      quotePort: input.quotePort,
      intent,
      provisioned: input.provisioned,
      checkoutKind: input.checkoutKind,
      acceptedQuoteSnapshot: input.acceptedQuoteSnapshot,
      expectedQuote: input.expectedQuote,
      resolvePricingPolicy: input.resolvePricingPolicy,
      recordQuote: input.recordQuote,
    });
    return responded ? "rejected" : "error";
  }
  const cause = safeCommerceDiagnosticValue(error instanceof Error ? error.message : String(error));
  const orderId = error instanceof CheckoutOrchestrationError ? error.orderIdForCompensation : null;
  console.error(
    "checkout_orchestration_failed",
    JSON.stringify({ message: cause, orderIdForCompensation: orderId }),
  );
  sendBffError(input.res, "UPSTREAM_UNAVAILABLE", "Checkout failed", {
    details: checkoutOrchestrationFailureDetails(cause),
  });
  return "error";
}
