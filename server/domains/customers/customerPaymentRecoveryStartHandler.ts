import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerPaymentRecoveryStartRequestSchema,
  customerPaymentRecoveryStartResponseSchema,
} from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerPaymentRecoveryStartPort } from "./ports.js";

export interface CustomerPaymentRecoveryStartDeps {
  paymentRecoveryStartPort: CustomerPaymentRecoveryStartPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerPaymentRecoveryStartHandler({
  paymentRecoveryStartPort,
  authenticateUser,
}: CustomerPaymentRecoveryStartDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    let authentication: CustomerUserAuthenticationResult;
    try {
      authentication = await authenticateUser(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer authentication failed");
      return;
    }

    if (authentication.ok === false) {
      sendBffError(res, authentication.code, authentication.message);
      return;
    }

    const request = customerPaymentRecoveryStartRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer payment recovery start request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await paymentRecoveryStartPort.startPaymentRecovery(authentication.userId, request.data);
      if (!result) {
        sendBffError(res, "FORBIDDEN", "No customer subscription linked to this session");
        return;
      }

      const response = customerPaymentRecoveryStartResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer payment recovery start returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer payment recovery start failed");
    }
  };
}
