import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import {
  customerMeRequestSchema,
  customerMeResponseSchema,
} from "./customerContracts.js";
import type { CustomerMePort } from "./customerPorts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";

export interface CustomerMeDeps extends IdentityResponseOptions {
  responseSchema: typeof customerMeResponseSchema;
  mePort: CustomerMePort;
  authenticateUser: (req: HttpRequest) => Promise<CustomerUserAuthenticationResult>;
}


export function createCustomerMeHandler({ mePort, authenticateUser, responseSchema, responseRequestId }: CustomerMeDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder({ responseRequestId });
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
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

      const response = responseSchema.safeParse(result);
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
