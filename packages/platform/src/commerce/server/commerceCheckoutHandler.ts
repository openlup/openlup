import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { ConfiguratorIntent, CheckoutKind, CommerceResumableOrderReadPort } from "../contracts/index.js";
import { CHECKOUT_CONTRACT_VERSION } from "../checkoutSchemas.js";
import type { CheckoutContinuationAction } from "./checkoutPaymentContinuationCredential.js";
import { providerPayerFromRequest } from "./commerceCheckoutProviderPayment.js";
import { runBestEffortAccountLink } from "./commerceCheckoutHandlerHelpers.js";
import type { ResolveSavedMethodResult } from "./commerceCheckoutSavedPaymentMethod.js";
import type { CheckoutTimingOutcome, CheckoutTimingStage } from "./commerceCheckoutTiming.js";
import type { CheckoutQuoteSnapshot, ExpectedCheckoutQuote } from "./checkoutQuoteTypes.js";
import type { OrchestratedCheckoutResult, CheckoutStageRecorder } from "./commercePaidOrderOrchestration.js";
import type { CheckoutExecutionProvider } from "./checkoutRuntimeTypes.js";
import type { CheckoutResumeGuardDeps } from "./commerceCheckoutResumeGuard.js";
interface CheckoutHandlerDependencies {
  persistencePort: unknown; quotePort: unknown; orderDraftPort: unknown; runtimePort: unknown; compensationPort: unknown;
  savedPaymentMethodResolverPort?: unknown; customerDefaultsPort?: unknown;
  resumableOrderPort?: CommerceResumableOrderReadPort; resumeWindowMinutes?: number;
  linkCustomerAccount?: (email: string) => Promise<void>;
  verifyPromotionAcceptance?: unknown; promotionAcceptanceEnforced?: boolean;
  now?: () => Date; resolvePricingPolicy?: unknown; resolvePricingEligibilityClientId?: (email: string) => Promise<string | null>;
  starterPackEnabled?: () => boolean; isFirstOrderEligible?: (clientId: string | null) => Promise<boolean>;
  offerPolicy?: unknown; starterTermsPort?: unknown;
  mintPaymentContinuationCookie?: unknown;
}
type RecordOperation = <T>(operation: () => Promise<T>) => Promise<T>;
interface CheckoutHandlerData<Intent> {
  intent: Intent; paymentProvider: CheckoutExecutionProvider; paymentAttemptSequence?: number;
  returnContext: "public" | "account"; paymentExecution?: unknown; declaredBankId?: string;
  invoicePreference: unknown; expectedQuote?: ExpectedCheckoutQuote & { promotionAcceptanceToken?: string };
}
export function createCommerceCheckoutHandler<Deps extends CheckoutHandlerDependencies, Intent extends ConfiguratorIntent, Provisioned extends { clientId: string }, Data extends CheckoutHandlerData<Intent>, Snapshot extends CheckoutQuoteSnapshot, Defaults, Result extends OrchestratedCheckoutResult<Snapshot>, Response extends { status: string; clientAction?: CheckoutContinuationAction }, MethodKind extends string = string, RecurringModel extends string = string>(bindings: {
  responder: BffResponder;
  mintPaymentContinuationOnFreshAction(input: { mint?: Deps["mintPaymentContinuationCookie"]; res: HttpResponse; journeyId: string; clientId: string; requestRail: string; response: Response; result: Result }): void;
  mintCheckoutRefusalContinuation(input: { mint?: Deps["mintPaymentContinuationCookie"]; res: HttpResponse; journeyId: string; clientId: string; requestRail: string; response: Response; result: Result }): void;
  createCheckoutTimingLogger(req: HttpRequest): { record: <T>(stage: CheckoutTimingStage, operation: () => Promise<T>) => Promise<T>; log(stage: CheckoutTimingStage, outcome: CheckoutTimingOutcome): void };
  previewCheckoutDiagnosticsEnabled(): boolean;
  admitCheckoutRequest(input: { req: HttpRequest; res: HttpResponse; deps: Deps; record: <T>(stage: "rate_limit" | "risk_blocklist", operation: () => Promise<T>) => Promise<T> }): Promise<{ kind: "accepted"; data: Data; intent: Intent; checkoutKind: CheckoutKind } | { kind: "responded"; outcome: "rejected" | "error" }>;
  persistCheckoutIdentityOrRespond(input: { res: HttpResponse; persistencePort: Deps["persistencePort"]; resumeGuardDeps: CheckoutResumeGuardDeps; intent: Intent; checkoutKind: CheckoutKind; now: () => Date; previewDiagnosticsEnabled: boolean; recordPersistStage: RecordOperation }): Promise<{ kind: "provisioned"; provisioned: Provisioned } | { kind: "responded"; outcome: "error" | "rejected" }>;
  resolveSavedPaymentMethodForCheckout(input: { req: HttpRequest; paymentExecution: Data["paymentExecution"]; clientId: string; savedPaymentMethodResolverPort: Deps["savedPaymentMethodResolverPort"]; now: () => Date; recordStage: <T>(stage: "payment_method_ref", operation: () => Promise<T>) => Promise<T> }): Promise<ResolveSavedMethodResult<MethodKind, RecurringModel>>;
  respondToSavedPaymentMethodRejection(res: HttpResponse, reason: Extract<ResolveSavedMethodResult, { kind: "rejected" }>["reason"]): void;
  readCheckoutCustomerDefaultsOrRespond(input: { res: HttpResponse; port: Deps["customerDefaultsPort"]; clientId: string; checkoutKind: CheckoutKind; recordStage: RecordOperation }): Promise<{ kind: "read"; snapshot: Defaults | null } | { kind: "responded" }>;
  resolveCheckoutQuoteOrContinuation(input: { quotePort: Deps["quotePort"]; intent: Intent; provisioned: Provisioned; deps: CheckoutResumeGuardDeps; invoicePreference: Data["invoicePreference"]; now: () => Date; offerPolicy: Deps["offerPolicy"]; starterTermsPort: Deps["starterTermsPort"]; checkoutKind: CheckoutKind; expectedQuote: Data["expectedQuote"]; promotionAcceptanceToken?: string; verifyPromotionAcceptance: Deps["verifyPromotionAcceptance"]; recordQuoteStage: RecordOperation; resolvePricingPolicy: Deps["resolvePricingPolicy"]; pricingEligibilityClientId?: string | null; starterPackEnabled?: () => boolean; isFirstOrderEligible?: () => Promise<boolean> }): Promise<{ kind: "accepted"; quoteSnapshot: Snapshot } | { kind: "price_changed"; response: Response; starterOfferRejection?: string } | { kind: "resumed"; response: Response }>;
  resolveResumeOpenOrderResponse(input: { deps: CheckoutResumeGuardDeps; clientId: string; checkoutKind: CheckoutKind; intent: Intent; acceptedQuote: Snapshot["quote"]; now: () => Date }): Promise<Response | null>;
  orchestratePaidOrder(input: { intent: Intent; provisioned: Provisioned; checkoutKind: CheckoutKind; quotePort: Deps["quotePort"]; orderDraftPort: Deps["orderDraftPort"]; runtimePort: Deps["runtimePort"]; customerDefaultsSnapshot: Defaults | null; paymentProvider: Data["paymentProvider"]; paymentAttemptSequence: Data["paymentAttemptSequence"]; returnContext: Data["returnContext"]; paymentExecution: Data["paymentExecution"]; declaredBankId: Data["declaredBankId"]; paymentMethodRef?: string; paymentMethodAliasType?: MethodKind; paymentMethodRecurringModel?: RecurringModel; invoicePreference: Data["invoicePreference"]; quoteSnapshot: Snapshot; providerPayer: ReturnType<typeof providerPayerFromRequest>; onPaymentStarted?: (event: { email: string }) => Promise<void>; recordStage: CheckoutStageRecorder; now: () => Date }): Promise<Result>;
  buildCheckoutSuccessResponse(input: { orchestrated: Result; paymentProvider: Data["paymentProvider"]; checkoutKind: CheckoutKind; intent: Intent; clientId: string }): Response;
  respondToCheckoutFailure(input: { error: unknown; compensationPort: Deps["compensationPort"]; intent: Intent; res: HttpResponse; quotePort: Deps["quotePort"]; provisioned: Provisioned; checkoutKind: CheckoutKind; acceptedQuoteSnapshot: Snapshot | null; expectedQuote: Data["expectedQuote"]; resolvePricingPolicy: Deps["resolvePricingPolicy"]; recordQuote: RecordOperation }): Promise<CheckoutTimingOutcome>;
}) {
  const { sendBffError, sendBffSuccess } = bindings.responder;
function createHandler(deps: Deps) {
const {
  persistencePort,
  quotePort,
  orderDraftPort,
  runtimePort,
  compensationPort,
  savedPaymentMethodResolverPort,
  customerDefaultsPort,
  resumableOrderPort,
  resumeWindowMinutes,
  linkCustomerAccount,
  verifyPromotionAcceptance,
  promotionAcceptanceEnforced = false,
  now = () => new Date(),
  resolvePricingPolicy,
  resolvePricingEligibilityClientId,
  starterPackEnabled,
  offerPolicy,
  starterTermsPort,
  isFirstOrderEligible,
  mintPaymentContinuationCookie,
} = deps;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    const timing = bindings.createCheckoutTimingLogger(req);
    let totalOutcome: CheckoutTimingOutcome = "error";
    try {
      const admission = await bindings.admitCheckoutRequest({
        req,
        res,
        deps,
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

      const identity = await bindings.persistCheckoutIdentityOrRespond({
        res,
        persistencePort,
        resumeGuardDeps: { resumableOrderPort, resumeWindowMinutes },
        intent,
        checkoutKind,
        now,
        previewDiagnosticsEnabled: bindings.previewCheckoutDiagnosticsEnabled(),
        recordPersistStage: (operation) => timing.record("persist_intent", operation),
      });
      if (identity.kind === "responded") {
        totalOutcome = identity.outcome;
        return;
      }
      const provisioned = identity.provisioned;

      let paymentMethodRef: string | undefined;
      let paymentMethodAliasType: MethodKind | undefined;
      let paymentMethodRecurringModel: RecurringModel | undefined;
      const savedMethodResult = await bindings.resolveSavedPaymentMethodForCheckout({
        req,
        paymentExecution: data.paymentExecution,
        clientId: provisioned.clientId,
        savedPaymentMethodResolverPort,
        now,
        recordStage: timing.record,
      });
      if (savedMethodResult.kind === "rejected") {
        bindings.respondToSavedPaymentMethodRejection(res, savedMethodResult.reason);
        totalOutcome = "rejected";
        return;
      }
      if (savedMethodResult.kind === "resolved") {
        paymentMethodRef = savedMethodResult.paymentMethodRef;
        paymentMethodAliasType = savedMethodResult.paymentMethodAliasType;
        paymentMethodRecurringModel = savedMethodResult.paymentMethodRecurringModel;
      }

      const defaults = await bindings.readCheckoutCustomerDefaultsOrRespond({ res, port: customerDefaultsPort, clientId: provisioned.clientId, checkoutKind, recordStage: (operation) => timing.record("customer_defaults", operation) });
      if (defaults.kind === "responded") return;
      const customerDefaultsSnapshot = defaults.snapshot;

      let acceptedQuoteSnapshot: Snapshot | null = null;
      try {
        const quoteGuard = await bindings.resolveCheckoutQuoteOrContinuation({
          quotePort,
          intent,
          provisioned,
          deps: { resumableOrderPort, resumeWindowMinutes },
          invoicePreference: data.invoicePreference,
          now,
          offerPolicy,
          starterTermsPort,
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
        if (quoteGuard.kind === "resumed") {
          sendBffSuccess(res, quoteGuard.response, { contractVersion: CHECKOUT_CONTRACT_VERSION });
          totalOutcome = "success";
          return;
        }
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
        const resumeResponse = await bindings.resolveResumeOpenOrderResponse({
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

        const orchestrated = await bindings.orchestratePaidOrder({
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
        const response = bindings.buildCheckoutSuccessResponse({
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
        bindings.mintPaymentContinuationOnFreshAction(continuationInput);
        bindings.mintCheckoutRefusalContinuation(continuationInput);
        sendBffSuccess(res, response, { contractVersion: CHECKOUT_CONTRACT_VERSION });
        totalOutcome = "success";
      } catch (error) {
        totalOutcome = await bindings.respondToCheckoutFailure({
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

return createHandler;
}
