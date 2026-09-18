import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CUSTOMER_PAYMENT_METHODS_CONTRACT_VERSION,
  customerPaymentMethodsResponseSchema,
} from "../../../src/domains/customers/contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerPaymentMethodsPort } from "./ports.js";

export interface CustomerPaymentMethodsDeps {
  paymentMethodsPort: CustomerPaymentMethodsPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerPaymentMethodsHandler({
  paymentMethodsPort,
  authenticateUser,
}: CustomerPaymentMethodsDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
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

    try {
      const paymentMethods = await paymentMethodsPort.listPaymentMethods(authentication.userId);
      if (!paymentMethods) {
        sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
        return;
      }

      const response = customerPaymentMethodsResponseSchema.safeParse({
        contractVersion: CUSTOMER_PAYMENT_METHODS_CONTRACT_VERSION,
        paymentMethods,
      });
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer payment methods returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer payment methods read failed");
    }
  };
}
