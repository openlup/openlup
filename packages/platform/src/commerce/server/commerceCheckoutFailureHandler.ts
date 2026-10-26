import type { HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import { CHECKOUT_CONTRACT_VERSION } from "../checkoutSchemas.js";
import type { CheckoutKind, ConfiguratorIntent as NeutralIntent } from "../contracts/index.js";
import type { CommerceQuotePort } from "../ports.js";
import type { PricingPolicySnapshot } from "../../pricing/index.js";
import type { CheckoutQuoteSnapshot } from "./checkoutQuoteTypes.js";
import { safeCommerceDiagnosticValue } from "./commerceDiagnostics.js";
import { AcquisitionTermsError } from "../../pricing/index.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
import { tryCompensate, type CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
import { checkoutOrchestrationFailureDetails } from "./commerceDiagnostics.js";
import type { CheckoutTimingOutcome } from "./commerceCheckoutTiming.js";
import { CheckoutOfferRefusedError } from "./checkoutOfferPolicyPort.js";
import { isJourneyConsumedCheckoutConflict, isStockUnavailableCheckoutConflict, START_RUNTIME_SIMPLE_CONFLICTS } from "./checkoutConflictClassifiers.js";
export function createCheckoutFailureHandler<Intent extends NeutralIntent, Provisioned, Request, Snapshot extends CheckoutQuoteSnapshot>(bindings: {
  responder: BffResponder; logProviderFailure(error: unknown): void;
  respondQuoteFailure(res: HttpResponse, error: unknown): boolean;
  previewDiagnosticsEnabled(): boolean;
  respondToPromotionCodePriceChange(input: { res: HttpResponse; quotePort: CommerceQuotePort<Request, Snapshot, import("../../pricing/index.js").CreateQuoteOptions>; intent: Intent; provisioned: Provisioned; checkoutKind: CheckoutKind; acceptedQuoteSnapshot: Snapshot | null; expectedQuote?: { totalGross: { amountMinor: number; currency: string }; pricingPolicy?: PricingPolicySnapshot }; resolvePricingPolicy?: (request: Request) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>; recordQuote: <T>(operation: () => Promise<T>) => Promise<T> }): Promise<boolean>;
}) {
  const { sendBffError } = bindings.responder;

type CheckoutFailureInput = {
  error: unknown;
  compensationPort: CheckoutCompensationPort;
  intent: Intent;
  res: HttpResponse;
  quotePort: CommerceQuotePort<Request, Snapshot, import("../../pricing/index.js").CreateQuoteOptions>;
  provisioned: Provisioned;
  checkoutKind: CheckoutKind;
  acceptedQuoteSnapshot: Snapshot | null;
  expectedQuote?: {
    totalGross: { amountMinor: number; currency: string };
    pricingPolicy?: PricingPolicySnapshot;
  };
  resolvePricingPolicy?: (
    request: Request,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
  recordQuote: <T>(operation: () => Promise<T>) => Promise<T>;
}

async function respondToCheckoutFailure(
  input: CheckoutFailureInput,
): Promise<CheckoutTimingOutcome> {
  const { error, compensationPort, intent } = input;
  bindings.logProviderFailure(error);

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

  if (error instanceof AcquisitionTermsError && bindings.respondQuoteFailure(input.res, error)) return "rejected";

  // Raised by the quote guard before any order draft exists, so there is nothing
  // to compensate.
  if (error instanceof CheckoutOfferRefusedError) {
    sendBffError(input.res, "CONFLICT", "Checkout offer refused", {
      details: { feature: "checkout", stage: "quote", reason: error.reason },
    });
    return "rejected";
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
  if (error instanceof CheckoutOrchestrationError && error.reason === "inventory_admission_busy") {
    sendBffError(input.res, "UPSTREAM_UNAVAILABLE", "Inventory admission temporarily unavailable", {
      details: { feature: "checkout", stage: "start_runtime", reason: "inventory_admission_busy" },
    });
    return "error";
  }
  if (error instanceof CheckoutOrchestrationError && error.orderIdForCompensation) {
    await tryCompensate(compensationPort, intent.idempotencyKey, error.orderIdForCompensation);
  }
  if (
    error instanceof CheckoutOrchestrationError &&
    (error.reason === "promotion_code_price_changed" || error.reason === "acquisition_terms_changed")
  ) {
    const responded = await bindings.respondToPromotionCodePriceChange({
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
    details: checkoutOrchestrationFailureDetails(cause, bindings.previewDiagnosticsEnabled()),
  });
  return "error";
}

return { respondToCheckoutFailure };
}
