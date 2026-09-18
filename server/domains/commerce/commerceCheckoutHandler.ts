import { mintCheckoutRefusalContinuation } from "./checkoutRefusalContinuation.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
} from "../../_lib/bff/response.js";
import {
  CHECKOUT_CONTRACT_VERSION,
} from "../../../src/domains/commerce/checkoutContracts.js";
import type {
  ConfiguratorIntentPersistencePort,
  CommerceQuotePort,
  CommerceOrderDraftWritePort,
  CommerceCustomerDefaultsReadPort,
} from "../../../src/domains/commerce/ports.js";
import type { PersonalizationOnPersistHook } from "./configuratorIntentPersistenceHandler.js";
import { applyCheckoutPersonalization } from "./checkoutPersonalizationMint.js";
import type { CommerceCheckoutRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";
import {
  orchestratePaidOrder,
  type CheckoutCompensationPort,
} from "./commerceCheckoutOrchestration.js";
import {
  createCheckoutTimingLogger,
  type CheckoutTimingOutcome,
} from "./commerceCheckoutTiming.js";
import { providerPayerFromRequest } from "./commerceCheckoutProviderPayment.js";
import {
  previewCheckoutDiagnosticsEnabled,
} from "./commerceDiagnostics.js";
import {
  buildCheckoutSuccessResponse,
  persistCheckoutIdentityOrRespond,
  respondToSavedPaymentMethodRejection,
  runBestEffortAccountLink,
} from "./commerceCheckoutHandlerHelpers.js";
import { resolveCheckoutQuoteGuard } from "./commerceCheckoutQuoteGuard.js";
import {
  resolveResumeOpenOrderResponse,
  type CheckoutResumeGuardDeps,
} from "./commerceCheckoutResumeGuard.js";
import { readCheckoutCustomerDefaults } from "./commerceCheckoutCustomerDefaults.js";
import type { CheckoutSavedPaymentMethodResolverPort } from "./savedPaymentMethodResolverPort.js";
import { resolveSavedTpayPaymentMethodForCheckout } from "./commerceCheckoutSavedPaymentMethod.js";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";
import { respondToCheckoutFailure } from "./commerceCheckoutFailureHandler.js";
import {
  admitCheckoutRequest,
  type CheckoutAdmissionDeps,
} from "./commerceCheckoutHandlerAdmission.js";
import {
  mintPaymentContinuationOnFreshAction,
  type CheckoutPaymentContinuationMinter,
} from "./checkoutPaymentContinuationCredential.js";
export type { CheckoutCompensationPort } from "./commerceCheckoutOrchestration.js";
export interface CommerceCheckoutHandlerDeps extends CheckoutResumeGuardDeps, CheckoutAdmissionDeps {
  persistencePort: ConfiguratorIntentPersistencePort;
  quotePort: CommerceQuotePort;
  orderDraftPort: CommerceOrderDraftWritePort;
  runtimePort: CommerceCheckoutRuntimePort;
  compensationPort: CheckoutCompensationPort;
  savedPaymentMethodResolverPort?: CheckoutSavedPaymentMethodResolverPort;
  customerDefaultsPort?: CommerceCustomerDefaultsReadPort;
  linkCustomerAccount?: (email: string) => Promise<void>;
  personalizationOnPersist?: PersonalizationOnPersistHook;
  mintPersonalizationCookies?: (clientId: string) => string[];
  subscriptionCheckoutContractEnabled?: () => boolean;
  dhlOnlyDeliveryEnabled?: () => boolean;
  verifyPromotionAcceptance?: Parameters<typeof resolveCheckoutQuoteGuard>[0]["verifyPromotionAcceptance"];
  promotionAcceptanceEnforced?: boolean;
  now?: () => Date;
  resolvePricingPolicy?: (
    request: CreateQuoteRequest,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
  resolvePricingEligibilityClientId?: (email: string) => Promise<string | null>;
  /** `COMMERCE_STARTER_PACK_ENABLED`; forwarded to the quote guard's starter lane. */
  starterPackEnabled?: () => boolean;
  /** Server-authoritative first-order re-check for the starter lane. */
  isFirstOrderEligible?: (clientId: string | null) => Promise<boolean>;
  mintPaymentContinuationCookie?: CheckoutPaymentContinuationMinter;
}
export function createCommerceCheckoutHandler({
  persistencePort,
  quotePort,
  orderDraftPort,
  runtimePort,
  compensationPort,
  savedPaymentMethodResolverPort,
  customerDefaultsPort,
  resumableOrderPort,
  resumeWindowMinutes,
  checkRateLimit,
  rateLimitMessage,
  checkRiskBlocklist,
  linkCustomerAccount,
  personalizationOnPersist,
  mintPersonalizationCookies,
  subscriptionCheckoutContractEnabled = () => false,
  dhlOnlyDeliveryEnabled = () => false,
  verifyPromotionAcceptance,
  promotionAcceptanceEnforced = false,
  now = () => new Date(),
  resolvePricingPolicy,
  resolvePricingEligibilityClientId,
  starterPackEnabled,
  isFirstOrderEligible,
  mintPaymentContinuationCookie,
}: CommerceCheckoutHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const timing = createCheckoutTimingLogger(req);
    let totalOutcome: CheckoutTimingOutcome = "error";
    try {
      const admission = await admitCheckoutRequest({
        req,
        res,
        deps: {
          checkRateLimit,
          rateLimitMessage,
          checkRiskBlocklist,
          subscriptionCheckoutContractEnabled,
          dhlOnlyDeliveryEnabled,
          promotionAcceptanceEnforced,
        },
        record: timing.record,
      });
      if (admission.kind === "responded") {
        totalOutcome = admission.outcome;
        return;
      }
      const { data, intent, checkoutKind } = admission;

      let pricingEligibilityClientId: string | null | undefined;
      if (resolvePricingEligibilityClientId) {
        try {
          pricingEligibilityClientId = await resolvePricingEligibilityClientId(intent.contact.email);
        } catch {
          sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout customer eligibility read failed", {
            details: { feature: "checkout", stage: "customer_eligibility" },
          });
          return;
        }
      }

      const identity = await persistCheckoutIdentityOrRespond({
        res,
        persistencePort,
        resumeGuardDeps: { resumableOrderPort, resumeWindowMinutes },
        intent,
        checkoutKind,
        now,
        previewDiagnosticsEnabled: previewCheckoutDiagnosticsEnabled(),
        recordPersistStage: (operation) => timing.record("persist_intent", operation),
      });
      if (identity.kind === "responded") {
        totalOutcome = identity.outcome;
        return;
      }
      const provisioned = identity.provisioned;

      if (personalizationOnPersist || mintPersonalizationCookies) {
        await applyCheckoutPersonalization({
          res,
          clientId: provisioned.clientId,
          ownerName: intent.contact.firstName ?? null,
          dogName: intent.petProfile.name ?? null,
          personalizationOnPersist,
          mintPersonalizationCookies,
        });
      }

      let paymentMethodRef: string | undefined;
      let paymentMethodAliasType: "UID" | "PAYID" | undefined;
      let paymentMethodRecurringModel: "O" | "M" | undefined;
      const savedMethodResult = await resolveSavedTpayPaymentMethodForCheckout({
        req,
        paymentExecution: data.paymentExecution,
        clientId: provisioned.clientId,
        savedPaymentMethodResolverPort,
        now,
        recordStage: timing.record,
      });
      if (savedMethodResult.kind === "rejected") {
        respondToSavedPaymentMethodRejection(res, savedMethodResult.reason);
        totalOutcome = "rejected";
        return;
      }
      if (savedMethodResult.kind === "resolved") {
        paymentMethodRef = savedMethodResult.paymentMethodRef;
        paymentMethodAliasType = savedMethodResult.paymentMethodAliasType;
        paymentMethodRecurringModel = savedMethodResult.paymentMethodRecurringModel;
      }

      let customerDefaultsSnapshot: Awaited<ReturnType<typeof readCheckoutCustomerDefaults>> = null;
      try {
        customerDefaultsSnapshot = await readCheckoutCustomerDefaults({
          port: customerDefaultsPort,
          clientId: provisioned.clientId,
          checkoutKind,
          recordStage: (operation) => timing.record("customer_defaults", operation),
        });
      } catch {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout customer defaults read failed", {
          details: { feature: "checkout", stage: "customer_defaults" },
        });
        return;
      }

      let acceptedQuoteSnapshot: Awaited<ReturnType<CommerceQuotePort["createQuote"]>> | null = null;
      try {
        const quoteGuard = await resolveCheckoutQuoteGuard({
          quotePort,
          intent,
          provisioned,
          checkoutKind,
          expectedQuote: data.expectedQuote,
          promotionAcceptanceToken: data.expectedQuote?.promotionAcceptanceToken,
          verifyPromotionAcceptance,
          recordQuoteStage: (operation) => timing.record("quote", operation),
          resolvePricingPolicy,
          pricingEligibilityClientId,
          starterPackEnabled,
          ...(isFirstOrderEligible
            ? {
                isFirstOrderEligible: () => isFirstOrderEligible(
                  pricingEligibilityClientId ?? provisioned.clientId,
                ),
              }
            : {}),
        });
        if (quoteGuard.kind === "price_changed") {
          if (quoteGuard.starterOfferRejection) {
            console.info(
              "checkout_starter_offer_rejected",
              JSON.stringify({ reason: quoteGuard.starterOfferRejection }),
            );
          }
          sendBffSuccess(res, quoteGuard.response, { contractVersion: CHECKOUT_CONTRACT_VERSION });
          totalOutcome = "rejected";
          return;
        }
        acceptedQuoteSnapshot = quoteGuard.quoteSnapshot;

        // Deliberately AFTER the quote. The duplicate-charge guard has to answer
        // "may I re-offer this order" against the money the buyer was just
        // shown, and before this it could only answer against the order alone —
        // which is how a changed cart got re-offered at its old total.
        const resumeResponse = await resolveResumeOpenOrderResponse({
          deps: { resumableOrderPort, resumeWindowMinutes },
          clientId: provisioned.clientId,
          checkoutKind,
          intent,
          acceptedQuote: quoteGuard.quoteSnapshot.quote,
          now,
        });
        if (resumeResponse) {
          sendBffSuccess(res, resumeResponse, { contractVersion: CHECKOUT_CONTRACT_VERSION });
          totalOutcome = "success";
          return;
        }

        const orchestrated = await orchestratePaidOrder({
          intent,
          provisioned,
          checkoutKind,
          quotePort,
          orderDraftPort,
          runtimePort,
          customerDefaultsSnapshot,
          paymentProvider: data.paymentProvider,
          paymentAttemptSequence: data.paymentAttemptSequence,
          returnContext: data.returnContext,
          paymentExecution: data.paymentExecution,
          declaredBankId: data.declaredBankId,
          paymentMethodRef, paymentMethodAliasType, paymentMethodRecurringModel,
          invoicePreference: data.invoicePreference,
          quoteSnapshot: quoteGuard.quoteSnapshot,
          providerPayer: providerPayerFromRequest(req, intent),
          onPaymentStarted: linkCustomerAccount
            ? async ({ email }) => {
                await runBestEffortAccountLink(linkCustomerAccount, email);
              }
            : undefined,
          recordStage: timing.record,
          now,
        });
        const response = buildCheckoutSuccessResponse({
          orchestrated,
          paymentProvider: data.paymentProvider,
          checkoutKind,
          intent,
          clientId: provisioned.clientId,
        });
        const continuationInput = {
          mint: mintPaymentContinuationCookie,
          res, journeyId: intent.idempotencyKey, clientId: provisioned.clientId,
          requestRail: data.paymentProvider, response, result: orchestrated,
        };
        mintPaymentContinuationOnFreshAction(continuationInput);
        mintCheckoutRefusalContinuation(continuationInput);
        sendBffSuccess(res, response, { contractVersion: CHECKOUT_CONTRACT_VERSION });
        totalOutcome = "success";
      } catch (error) {
        totalOutcome = await respondToCheckoutFailure({
          error,
          compensationPort,
          intent,
          res,
          quotePort,
          provisioned,
          checkoutKind,
          acceptedQuoteSnapshot,
          expectedQuote: data.expectedQuote,
          resolvePricingPolicy,
          recordQuote: (operation) => timing.record("quote", operation),
        });
        return;
      }
    } finally {
      timing.log("total", totalOutcome);
    }
  };
}
