import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerSubscriptionPreviewRequestSchema,
  customerSubscriptionPreviewResponseSchema,
} from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerSubscriptionPreviewPort } from "./ports.js";
import { CustomerSubscriptionActionConflictError } from "./customerSubscriptionActionHandler.js";

export interface CustomerSubscriptionPreviewDeps {
  subscriptionPreviewPort: CustomerSubscriptionPreviewPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerSubscriptionPreviewHandler({
  subscriptionPreviewPort,
  authenticateUser,
}: CustomerSubscriptionPreviewDeps) {
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

    const request = customerSubscriptionPreviewRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer subscription preview request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await subscriptionPreviewPort.previewAction(authentication.userId, request.data);
      if (!result) {
        sendBffError(res, "FORBIDDEN", "No customer subscription linked to this session");
        return;
      }

      const response = customerSubscriptionPreviewResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer subscription preview returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof CustomerSubscriptionActionConflictError) {
        sendBffError(res, error.code, error.message, { details: error.details });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer subscription preview failed");
    }
  };
}
