import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerMeRequestSchema,
  customerMeResponseSchema,
} from "../../../src/domains/customers/contracts.js";
import type { CustomerMePort } from "./ports.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";

export interface CustomerMeDeps {
  mePort: CustomerMePort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

/**
 * GET /api/bff/customers/me — hidden passwordless customer profile read (W12.1).
 * Mirrors the admin platform `me` handler: bearer-scoped to the caller's own
 * auth user, so it leaks no email existence. The route gates the feature flag +
 * env before this handler ever runs.
 */
export function createCustomerMeHandler({ mePort, authenticateUser }: CustomerMeDeps) {
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

    const request = customerMeRequestSchema.safeParse(req.query ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer me request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await mePort.getCustomerMe(authentication.userId);
      if (!result) {
        sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
        return;
      }

      const response = customerMeResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer me returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer me read failed");
    }
  };
}
