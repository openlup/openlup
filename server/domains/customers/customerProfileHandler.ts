import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerProfileUpdateRequestSchema,
  customerProfileUpdateResponseSchema,
} from "../../../src/domains/customers/selfServiceContracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerProfileMutationPort } from "./ports.js";

export interface CustomerProfileDeps {
  profilePort: CustomerProfileMutationPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerProfileHandler({ profilePort, authenticateUser }: CustomerProfileDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "PATCH") {
      sendMethodNotAllowed(res, ["PATCH"]);
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

    const request = customerProfileUpdateRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer profile request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await profilePort.updateProfile(authentication.userId, request.data);
      if (!result) {
        sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
        return;
      }

      const response = customerProfileUpdateResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer profile returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer profile update failed");
    }
  };
}
