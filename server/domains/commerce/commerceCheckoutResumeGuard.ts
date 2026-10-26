import { createCheckoutResumeGuard } from "@openlup/platform/commerce/server";
import { checkoutResponseSchema } from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
export type { CheckoutResumeGuardDeps, QuoteLikeSnapshot } from "@openlup/platform/commerce/server";
export { selectedDeliveryMatches } from "@openlup/platform/commerce/server";
const core = createCheckoutResumeGuard<ConfiguratorIntent, ReturnType<typeof checkoutResponseSchema.parse>>({ responseSchema: checkoutResponseSchema, statusUrl: (orderId, paymentIntentId, clientId) => `/api/bff/commerce/payment-status?orderId=${encodeURIComponent(orderId)}&paymentIntentId=${encodeURIComponent(paymentIntentId)}&clientId=${encodeURIComponent(clientId)}` });
export const { resolveResumeOpenOrderResponse, buildSavedOrderResumeResponse } = core;
