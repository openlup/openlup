import { useCallback } from "react";
import type { NavigateFunction } from "react-router-dom";

import { submitCheckout } from "@/domains/commerce/commerceClient";
import type { CheckoutRequest } from "@/domains/commerce/checkoutContracts";
import type { PollerTerminalStatus } from "@/domains/payment/components/PaymentStatusPoller";
import type { PaymentFormSettlement } from "@/domains/payment/components/PaymentForm";

import type { StripePayState } from "@/checkout/adapters/SkomponujPakietStripePayPanel";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import { buildCheckoutIntent } from "./buildCheckoutIntent";
import { buildCheckoutInvoicePreference } from "./checkoutInvoicePreference";
import {
  buildTpayCheckoutRequestPatch,
  type TpayCheckoutDraft,
} from "@/checkout/adapters/tpayCheckoutDraft";
import { checkoutRequestOptionsForTpay } from "@/checkout/adapters/tpayCheckoutRequestOptions";
import { tpayCheckoutScaffoldingEnabled } from "@/checkout/adapters/tpayCheckoutFlags";
import { stripeCheckoutUiEnabled } from "@/checkout/adapters/stripeCheckoutFlags";
import { dhlOnlyDeliveryEnabled } from "@/checkout/composer/deliverySelectionFlags";
import {
  createCustomerDiagnosticActionKeyWhenEnabled,
  loadCustomerDiagnosticReporterWhenEnabled,
  subscriptionCheckoutContractEnabled,
} from "@/lib/flags";
import { checkoutDiagnosticSource, startCheckoutDiagnostic } from "@/lib/diagnostics/customerJourneyCheckoutProducer";
import {
  clearCheckoutAttemptKey,
  readCheckoutPaymentAttempt,
  getOrCreateCheckoutAttemptKey,
} from "./checkoutAttemptStore";
import { clearCheckoutContinuation } from "./checkoutNavigation";
import { isCheckoutDisabled } from "./checkoutDisabled";
import { isStockUnavailableCheckoutError } from "./checkoutStockUnavailable";
import {
  isJourneyConsumedCheckoutError,
  rotateConsumedJourneyRequest,
} from "./checkoutJourneyConsumed";
import { isProviderAttemptInFlightError } from "./checkoutProviderInFlight";
import { isCheckoutTimeoutError } from "./checkoutTimeout";
import { recoverAmbiguousCheckoutSubmit } from "./checkoutAmbiguousSubmit";
import { routeConfiguratorCheckoutResult } from "./checkoutSubmitResultRouting";
import type { CheckoutInlineWaitStart } from "./useConfiguratorPaymentWait";
import { useConfiguratorCheckoutResultRouting } from "@/checkout/adapters/useConfiguratorCheckoutResultRouting";
import type { ConfiguratorInlineRecoveryResultHandler, ConfiguratorWalletSettlementHandler } from "@/checkout/adapters/useConfiguratorCheckoutResultRouting";
import { useConfiguratorCheckoutTerminalRouting } from "./useConfiguratorCheckoutTerminalRouting";
import type { PriorAttemptController } from "./useConfiguratorCheckoutTerminalRouting";
import {
  PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  type ConfiguratorDraftScope,
} from "@/checkout/composer/configuratorDraftStore";
export interface ConfiguratorCheckoutPaths {
  thankYou: string;
  paymentFailed: string;
  paymentPath: string;
  /** Account host only: the in-shell payment terminal route (`/konto/zamowienie/status`). */
  accountStatusPath?: string;
  /** Account host only: retry target when no pollable payment context exists. */
  accountDashboardPath?: string;
}
export interface ConfiguratorCheckoutController {
  stripePay: StripePayState | null;
  /** Unmount the panel, keeping the continuation marker. For the host that owns
   * the panel's browser-history entry: a back press is not a cancellation. */
  closePaymentPanel: () => void;
  handleComplete: (data: ConfiguratorFormData, tpayDraft: TpayCheckoutDraft) => Promise<void>;
  handleInlineRecoveryResult: ConfiguratorInlineRecoveryResultHandler;
  onConfirmSettled: (status: PaymentFormSettlement) => void;
  onPollerTerminal: (status: PollerTerminalStatus) => void;
  handleWalletSettled: ConfiguratorWalletSettlementHandler;
  /**
   * The blocking state a submit raises when an attempt on another rail is still
   * open, plus the three routes out of it. `state` is null whenever the buyer is
   * free to submit.
   */
  priorAttempt: PriorAttemptController;
}
const detailsIncompleteError = () => new Error("checkout:errors.detailsIncomplete");
export function useConfiguratorCheckout(input: {
  navigate: NavigateFunction;
  lang: "pl" | "en";
  paths: ConfiguratorCheckoutPaths;
  onAccountOrderComplete?: (summary: { orderRef: string; petName: string; isSubscription: boolean }) => void;
  draftScope?: ConfiguratorDraftScope;
  /** Line γ seam: composition vocabulary for `buildCheckoutIntent`. */ knownCompositionSlugs: readonly string[];
  /**
   * Hand a code-entry wait back to the caller instead of navigating to the
   * status page. Supplied only by a host that can hold the wait in place;
   * omitted, every rail keeps the routing it has today.
   */
  onInlineWait?: (start: CheckoutInlineWaitStart) => void;
}): ConfiguratorCheckoutController {
  const {
    navigate,
    lang,
    paths, knownCompositionSlugs,
    onAccountOrderComplete,
    onInlineWait,
    draftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  } = input;
  const { thankYou, paymentFailed, paymentPath, accountStatusPath } = paths;
  // Account mode is signalled by the in-shell success callback (public flow untouched).
  const accountMode = Boolean(onAccountOrderComplete);

  const {
    stripePay, setStripePay: setEmbeddedPay, closePaymentPanel, resumeBeforeSubmit,
    onConfirmSettled, onPollerTerminal, priorAttempt, raisePriorAttemptFromRefusal,
  } = useConfiguratorCheckoutTerminalRouting({
      navigate,
      paths: { thankYou, paymentFailed, paymentPath },
      ...(accountMode && accountStatusPath ? { accountStatusPath } : {}),
      draftScope,
    });

  const handleComplete = useCallback(
    async (data: ConfiguratorFormData, tpayDraft: TpayCheckoutDraft) => {
      // Resume a delivered provider action — reopen the embedded panel, or wait
      // on the status page; stale terminal, expired and never-dispatched markers
      // all self-heal into a normal submit (`resumeBeforeSubmit`).
      // The buyer's CURRENT method goes in: the marker cannot know they changed
      // their mind, and without it this call reopened whatever action the server
      // still had — which is how a buyer who backed out of the card panel and
      // chose BLIK was shown the card modal again.
      if (await resumeBeforeSubmit(data.paymentMethod)) return;
      const subscriptionContractAvailable = subscriptionCheckoutContractEnabled();
      if (data.subscription && !subscriptionContractAvailable) {
        throw new Error("checkout:errors.subscriptionCheckoutUnavailable");
      }
      const candidateIntent = buildCheckoutIntent(data, {
        idempotencyKey: "checkout:pending",
        locale: lang,
        subscriptionCheckoutEnabled: subscriptionContractAvailable,
        deliverySelectionEnabled: true,
        dhlOnlyDeliveryEnabled: dhlOnlyDeliveryEnabled(),
        knownCompositionSlugs,
      });
      if (!candidateIntent) {
        throw detailsIncompleteError();
      }
      if (!data.checkoutQuoteExpectation) {
        throw new Error("checkout:errors.quoteUnavailable");
      }
      const intent = {
        ...candidateIntent,
        idempotencyKey: getOrCreateCheckoutAttemptKey(candidateIntent, data.checkoutQuoteExpectation),
      };
      const paymentAttempt = readCheckoutPaymentAttempt();
      const useStripe =
        stripeCheckoutUiEnabled() && import.meta.env.VITE_CHECKOUT_LOCAL_REHEARSAL !== "1";

      const tpayPatch = buildTpayCheckoutRequestPatch({
        enabled: tpayCheckoutScaffoldingEnabled(),
        paymentMethod: data.paymentMethod,
        draft: tpayDraft,
        checkoutMode: intent.mode,
      });
      if (!tpayPatch && data.paymentMethod !== "card") {
        throw detailsIncompleteError();
      }
      const invoicePreference = buildCheckoutInvoicePreference(data);
      if (invoicePreference === null) {
        throw new Error("business_invoice_lookup_required");
      }
      const checkoutRequest: CheckoutRequest = {
        intent,
        ...(invoicePreference ? { invoicePreference } : {}),
        ...(data.checkoutQuoteExpectation
          ? { expectedQuote: data.checkoutQuoteExpectation }
          : {}),
        // Account mode → server builds the in-shell return URL; inert on the embedded rail.
        ...(accountMode ? { returnContext: "account" as const } : {}),
        ...(tpayPatch ?? (useStripe ? { paymentProvider: "stripe" as const } : {})),
        // Retry needs its own attempt identity on the SAME order; 0 is inert.
        ...(paymentAttempt > 0 ? { paymentAttemptSequence: paymentAttempt } : {}),
      };
      const checkoutOptions = await checkoutRequestOptionsForTpay(tpayPatch);
      const diagnosticReporter = loadCustomerDiagnosticReporterWhenEnabled?.();
      const clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
      const checkoutDiagnostic = diagnosticReporter && clientActionKey
        ? startCheckoutDiagnostic(checkoutOptions.headers, diagnosticReporter, clientActionKey)
        : null;

      const routeCheckoutResult = (
        result: Parameters<typeof routeConfiguratorCheckoutResult>[0]["result"],
        source: "submit" | "ambiguous_readback",
        journeyId: string,
      ) => {
        routeConfiguratorCheckoutResult({
          result,
          source,
          journeyId,
          data,
          navigate,
          paths: { thankYou, paymentPath, ...(accountStatusPath ? { accountStatusPath } : {}) },
          accountMode,
          hasTpayPatch: Boolean(tpayPatch),
          useStripe,
          draftScope,
          setStripePay: setEmbeddedPay,
          ...(onAccountOrderComplete ? { onAccountOrderComplete } : {}),
          ...(onInlineWait ? { onInlineWait } : {}),
        });
      };

      let requestForAttempt = checkoutRequest;
      let rotatedConsumedJourney = false;
      let result: Awaited<ReturnType<typeof submitCheckout>>;
      for (;;) {
        try {
          result = await submitCheckout(requestForAttempt, checkoutOptions);
          break;
        } catch (err) {
          const diagnosticSource = checkoutDiagnosticSource(err);
          if (isCheckoutDisabled(err)) {
            // The checkout endpoint reported itself disabled (feature/dependency
            // flag off, or missing env). Historically this bounced to thank-you as
            // a silent flag-OFF fallback, but that shows a false success. Surface
            // the same in-place error as the null-intent case (parity with the
            // wallet path, PR 2056) instead of a fake order confirmation.
            throw checkoutDiagnostic?.failure(detailsIncompleteError(), "rejected", diagnosticSource) ?? detailsIncompleteError();
          }
          if (isStockUnavailableCheckoutError(err)) {
            clearCheckoutAttemptKey();
            clearCheckoutContinuation();
            throw checkoutDiagnostic?.failure(new Error("checkout:errors.stockUnavailable"), "rejected", diagnosticSource) ?? new Error("checkout:errors.stockUnavailable");
          }
          if (isJourneyConsumedCheckoutError(err)) {
            // This authoritative pre-provider response is the only condition
            // that may rotate a journey. The fresh request still flows through
            // every normal recovery branch below; a second consumed response is
            // deliberately terminal so a buggy server cannot create a retry loop.
            if (rotatedConsumedJourney) throw err;
            requestForAttempt = rotateConsumedJourneyRequest(
              candidateIntent,
              data.checkoutQuoteExpectation,
              requestForAttempt,
            );
            rotatedConsumedJourney = true;
            continue;
          }

          const ambiguousRecovery = await recoverAmbiguousCheckoutSubmit({
            error: err,
            request: requestForAttempt,
            options: checkoutOptions,
          });
          if (ambiguousRecovery?.kind === "recovered") {
            checkoutDiagnostic?.settle("unknown", diagnosticSource);
            routeCheckoutResult(ambiguousRecovery.response, "ambiguous_readback", requestForAttempt.intent.idempotencyKey);
            return;
          }
          if (ambiguousRecovery?.kind === "no_stable_identity") {
            throw checkoutDiagnostic?.failure(new Error("checkout:errors.paymentStatusUnknownNoIdentity"), "unknown", diagnosticSource) ?? new Error("checkout:errors.paymentStatusUnknownNoIdentity");
          }
          if (ambiguousRecovery?.kind === "in_flight") {
            // THE SEAM: every route into the anti-double-charge gate ends here, so
            // this is where the buyer gets the panel with the routes out rather than
            // a sentence with none. The message survives only as the fallback for a
            // marker that is gone, where the panel's controls resolve to nothing.
            if (raisePriorAttemptFromRefusal()) {
              return checkoutDiagnostic?.settle("rejected", diagnosticSource);
            }
            throw checkoutDiagnostic?.failure(new Error("checkout:errors.paymentInFlight"), "rejected", diagnosticSource) ?? new Error("checkout:errors.paymentInFlight");
          }
          if (ambiguousRecovery?.kind === "unknown") {
            throw checkoutDiagnostic?.failure(new Error("checkout:errors.paymentStatusUnknown"), "unknown", diagnosticSource) ?? new Error("checkout:errors.paymentStatusUnknown");
          }

          if (isProviderAttemptInFlightError(err) && raisePriorAttemptFromRefusal()) {
            return checkoutDiagnostic?.settle("rejected", diagnosticSource);
          }
          if (isProviderAttemptInFlightError(err)) {
            // Defensive fallback for a future recovery implementation: an attempt
            // row for this stable-key order is still open, so never rotate or post
            // again. The current helper returns the typed branch above.
            throw checkoutDiagnostic?.failure(new Error("checkout:errors.paymentInFlight"), "rejected", diagnosticSource) ?? new Error("checkout:errors.paymentInFlight");
          }
          if (isCheckoutTimeoutError(err)) {
            // Transient network stall (hung mobile connection). The journey-stable key
            // may already name an order, so surface the bounded uncertain-state
            // message rather than inviting another payment or a generic failure.
            throw checkoutDiagnostic?.failure(new Error("checkout:errors.timeout"), "timeout", diagnosticSource) ?? new Error("checkout:errors.timeout");
          }
          throw checkoutDiagnostic?.failure(err, "unknown") ?? err;
        }
      }
      checkoutDiagnostic?.settle("succeeded");
      routeCheckoutResult(result, "submit", requestForAttempt.intent.idempotencyKey);
    },
    [navigate, lang, paymentPath, thankYou, onAccountOrderComplete, onInlineWait, accountMode, accountStatusPath, draftScope, resumeBeforeSubmit],
  );

  const { handleWalletSettled, handleInlineRecoveryResult } = useConfiguratorCheckoutResultRouting({
    navigate, paths, accountMode, draftScope, setEmbeddedPay, raisePriorAttemptFromRefusal,
    ...(onAccountOrderComplete ? { onAccountOrderComplete } : {}),
    ...(onInlineWait ? { onInlineWait } : {}),
  });

  return {
    stripePay, closePaymentPanel, handleComplete, onConfirmSettled, onPollerTerminal,
    handleWalletSettled, handleInlineRecoveryResult, priorAttempt,
  };
}
