import type { ResolvedSavedPaymentMethod, SavedPaymentMethodRecurringModel } from "./savedPaymentMethodResolverPort.js";
import { mintCheckoutRefusalContinuation } from "./checkoutRefusalContinuation.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  bffResponder,
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import { readOrCreateObservedRequestContext } from "../../_lib/observability/requestContext.js";
import {
  CHECKOUT_CONTRACT_VERSION,
  type CheckoutKind,
  type CheckoutResponse,
  type checkoutRequestSchema,
} from "../../../src/domains/commerce/checkoutContracts.js";
import {
  commerceCustomerDefaultsSnapshotSchema,
  type CommerceCustomerDefaultsSnapshot,
} from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import {
  createCheckoutTimingLogger as createPlatformCheckoutTimingLogger,
  createCommerceCheckoutHandler as bindHandler,
  readCheckoutCustomerDefaultsOrRespond as readPlatformCheckoutCustomerDefaultsOrRespond,
  type CheckoutOfferPolicyPort as CoreCheckoutOfferPolicyPort,
} from "@openlup/platform/commerce/server";
import type {
  ConfiguratorIntentPersistencePort,
  CommerceQuotePort,
  CommerceOrderDraftWritePort,
  CommerceCustomerDefaultsReadPort,
} from "../../../src/domains/commerce/ports.js";
import type { CommerceCheckoutRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";
import {
  orchestratePaidOrder,
  type CheckoutCompensationPort,
  type OrchestratedCheckoutResult,
} from "./commerceCheckoutOrchestration.js";
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
import { resolveCheckoutQuoteOrContinuation } from "./commerceCheckoutContinuationTerms.js";
import { resolveCheckoutQuoteGuard } from "./commerceCheckoutQuoteGuard.js";
import {
  resolveResumeOpenOrderResponse,
  type CheckoutResumeGuardDeps,
} from "./commerceCheckoutResumeGuard.js";
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
  offerPolicy?: CoreCheckoutOfferPolicyPort<ConfiguratorIntent, CreateQuoteResponse["quote"]>;
  starterTermsPort?: import("../../../src/domains/commerce/starterTermsPort.js").StarterTermsPort;
  mintPaymentContinuationCookie?: CheckoutPaymentContinuationMinter;
}
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";

export function createCheckoutTimingLogger(req: VercelRequest) {
  return createPlatformCheckoutTimingLogger(readOrCreateObservedRequestContext(req).requestId, "/api/bff/commerce/checkout");
}

function readCheckoutCustomerDefaultsOrRespond(input: {
  port: CommerceCustomerDefaultsReadPort | undefined;
  clientId: string;
  checkoutKind: CheckoutKind;
  recordStage: <T>(operation: () => Promise<T>) => Promise<T>;
  res: VercelResponse;
}) {
  return readPlatformCheckoutCustomerDefaultsOrRespond(input, commerceCustomerDefaultsSnapshotSchema, bffResponder);
}
const createHandler = bindHandler<CommerceCheckoutHandlerDeps, ConfiguratorIntent, ConfiguratorIntentPersistenceResponse, ReturnType<typeof checkoutRequestSchema.parse>, CreateQuoteResponse, CommerceCustomerDefaultsSnapshot, OrchestratedCheckoutResult, CheckoutResponse, ResolvedSavedPaymentMethod["providerAliasType"], SavedPaymentMethodRecurringModel>({
  responder: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, mintPaymentContinuationOnFreshAction, mintCheckoutRefusalContinuation, createCheckoutTimingLogger, previewCheckoutDiagnosticsEnabled,
  admitCheckoutRequest, persistCheckoutIdentityOrRespond, resolveSavedPaymentMethodForCheckout: resolveSavedTpayPaymentMethodForCheckout, respondToSavedPaymentMethodRejection,
  readCheckoutCustomerDefaultsOrRespond, resolveCheckoutQuoteOrContinuation, resolveResumeOpenOrderResponse, orchestratePaidOrder, buildCheckoutSuccessResponse, respondToCheckoutFailure,
});
export function createCommerceCheckoutHandler(deps: CommerceCheckoutHandlerDeps) { return createHandler(deps); }
