import { createCheckoutHandlerHelpers } from "@openlup/platform/commerce/server";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { checkoutResponseSchema, type CheckoutResponse } from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import { checkoutClientAction } from "./commerceCheckoutProviderPayment.js";
import { resolveResumeOpenOrderResponse } from "./commerceCheckoutResumeGuard.js";
export { subscriptionResponse, runBestEffortAccountLink } from "@openlup/platform/commerce/server";
export function isDhlCourierDelivery(intent: ConfiguratorIntent): boolean {
  const delivery = intent.selectedDelivery;
  return (
    delivery.kind === "courier" &&
    (!delivery.providerKind || delivery.providerKind === "dhl") &&
    delivery.carrierKind === "dhl" &&
    delivery.service === "dhl_courier_standard" &&
    !delivery.providerRef &&
    !delivery.pickupPoint
  );
}

const core = createCheckoutHandlerHelpers<ConfiguratorIntent, ConfiguratorIntentPersistenceResponse, CreateQuoteResponse, CheckoutResponse>({ checkoutClientAction, responder: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, responseSchema: checkoutResponseSchema, resolveResumeOpenOrderResponse, statusUrl: (orderId, paymentIntentId, clientId) => `/api/bff/commerce/payment-status?orderId=${encodeURIComponent(orderId)}&paymentIntentId=${encodeURIComponent(paymentIntentId)}&clientId=${encodeURIComponent(clientId)}` });
export const { persistCheckoutIdentityOrRespond, respondToSavedPaymentMethodRejection, buildCheckoutSuccessResponse, respondToProvisionIdentityConflict } = core;
