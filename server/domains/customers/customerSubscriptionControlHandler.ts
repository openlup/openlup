import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import { customerSubscriptionControlResponseSchema } from "../../../src/domains/customers/subscriptionControlContracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerSubscriptionControlPort } from "./ports.js";

export interface CustomerSubscriptionControlDeps {
  controlPort: CustomerSubscriptionControlPort;
  authenticateUser: (
    req: VercelRequest,
  ) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerSubscriptionControlHandler({
  controlPort,
  authenticateUser,
}: CustomerSubscriptionControlDeps) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
  ): Promise<void> {
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
      const snapshot = await controlPort.getSnapshot(authentication.userId);
      if (!snapshot) {
        sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
        return;
      }
      const response = customerSubscriptionControlResponseSchema.safeParse(snapshot);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer subscription control returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer subscription control read failed");
    }
  };
}
