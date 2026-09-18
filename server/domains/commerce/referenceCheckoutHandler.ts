import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  REFERENCE_CHECKOUT_V1,
  referenceCheckoutRequestSchema,
  referenceCheckoutResponseSchema,
  type CheckoutCommandV1,
} from "../../../src/domains/commerce/checkoutCommandContracts.js";
import {
  CommerceRuntimeConflictError,
  CommerceRuntimePersistenceError,
  type CheckoutCommandRuntimeResult,
} from "../../../src/domains/commerce/runtimePorts.js";

export interface ReferenceCheckoutHandlerDeps {
  startCheckout: (command: CheckoutCommandV1) => Promise<CheckoutCommandRuntimeResult>;
  checkRateLimit: (req: HttpRequest, command: CheckoutCommandV1) => Promise<{ allowed: boolean }>;
  checkRiskBlocklist?: (req: HttpRequest, command: CheckoutCommandV1) => Promise<{ blocked: boolean }>;
  admitProfile: (command: CheckoutCommandV1) => boolean;
}

/**
 * This handler is intentionally anonymous: it creates checkout identity from
 * the submitted neutral command through the existing CP1-0 persistence port.
 * It never accepts a client, subject, settlement implementation, or service
 * credential from the browser.
 */
export function createReferenceCheckoutHandler({
  startCheckout,
  checkRateLimit,
  checkRiskBlocklist,
  admitProfile,
}: ReferenceCheckoutHandlerDeps) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = referenceCheckoutRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid reference checkout request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      if (!admitProfile(request.data.command)) {
        sendBffError(res, "BAD_REQUEST", "Checkout command does not match the active reference profile");
        return;
      }
      if (!(await checkRateLimit(req, request.data.command)).allowed) {
        sendBffError(res, "RATE_LIMITED", "Reference checkout rate limit exceeded");
        return;
      }
      if (checkRiskBlocklist && (await checkRiskBlocklist(req, request.data.command)).blocked) {
        sendBffError(res, "FORBIDDEN", "Reference checkout cannot be completed");
        return;
      }

      // Settlement is owned by the shared paid-order service, not by this
      // handler: it is present exactly when that service settled the attempt,
      // and absent when the runtime is still awaiting or already refused it.
      const result = await startCheckout(request.data.command);
      const settled = result.settlement;
      const response = referenceCheckoutResponseSchema.safeParse({
        version: REFERENCE_CHECKOUT_V1,
        orderId: result.runtime.runtime.orderId,
        clientId: result.runtime.runtime.clientId,
        paymentIntentId: result.runtime.runtime.payment.paymentIntentId,
        paymentAttemptId: result.runtime.runtime.payment.paymentAttemptId,
        paymentStatus: settled?.paymentResult.status ?? result.runtime.runtime.payment.status,
        paymentAttemptStatus: settled
          ? "succeeded"
          : result.runtime.runtime.payment.attemptStatus,
        replayed: result.persistence.replayed ||
          result.runtime.runtime.finalizedReplayed ||
          (settled?.paymentResult.replayed ?? false),
        total: result.runtime.runtime.total,
      });
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Reference checkout returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data, { contractVersion: REFERENCE_CHECKOUT_V1 });
    } catch (error) {
      if (error instanceof CommerceRuntimeConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }
      if (error instanceof CommerceRuntimePersistenceError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference checkout persistence failed");
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Reference checkout failed");
    }
  };
}
