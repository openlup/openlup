import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerAccountRequestSchema,
  customerAccountV2ResponseSchema,
} from "../../../src/domains/customers/accountV2Contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import {
  customerAccountReadFailureDetails,
  logCustomerAccountReadFailure,
} from "./customerAccountReadDiagnostics.js";
import type { CustomerAccountPort } from "./ports.js";

export interface CustomerAccountDeps {
  accountPort: CustomerAccountPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerAccountHandler({ accountPort, authenticateUser }: CustomerAccountDeps) {
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

    const request = customerAccountRequestSchema.safeParse(req.query ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer account request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const account = await accountPort.getAccount(authentication.userId);
      if (!account) {
        sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
        return;
      }

      const response = customerAccountV2ResponseSchema.safeParse(account);
      if (!response.success) {
        // Backstop: surface contract/DB drift in server logs (field paths + issue
        // codes only — never payload values) so a schema mismatch is diagnosable
        // instead of a silent "account unavailable" on the dashboard.
        console.error(
          "[customer-account] response failed contract validation:",
          JSON.stringify(
            response.error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
            })),
          ),
        );
        sendBffError(res, "INVALID_RESPONSE", "Customer account returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch (error) {
      logCustomerAccountReadFailure(error);
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer account read failed", {
        details: customerAccountReadFailureDetails(error),
      });
    }
  };
}
