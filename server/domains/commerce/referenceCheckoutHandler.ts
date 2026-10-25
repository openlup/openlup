import { createReferenceCheckoutHandler as create } from "@openlup/platform/commerce/server";
import type { HttpRequest } from "../../_lib/types/http.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { referenceCheckoutRequestSchema, referenceCheckoutResponseSchema, type CheckoutCommandV1 } from "../../../src/domains/commerce/checkoutCommandContracts.js";
import type { CheckoutCommandRuntimeResult } from "../../../src/domains/commerce/runtimePorts.js";
export interface ReferenceCheckoutHandlerDeps {
  startCheckout: (command: CheckoutCommandV1) => Promise<CheckoutCommandRuntimeResult>;
  checkRateLimit: (req: HttpRequest, command: CheckoutCommandV1) => Promise<{ allowed: boolean }>;
  checkRiskBlocklist?: (req: HttpRequest, command: CheckoutCommandV1) => Promise<{ blocked: boolean }>;
  admitProfile: (command: CheckoutCommandV1) => boolean;
}

export function createReferenceCheckoutHandler(deps: ReferenceCheckoutHandlerDeps) { return create({ ...deps, responder: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, requestSchema: referenceCheckoutRequestSchema, responseSchema: referenceCheckoutResponseSchema }); }
