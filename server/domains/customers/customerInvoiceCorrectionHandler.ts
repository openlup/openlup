import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerInvoiceCorrectionRequestSchema,
  customerInvoiceCorrectionResponseSchema,
} from "../../../src/domains/customers/accountV2Contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerInvoiceCorrectionPort } from "./ports.js";

export interface CustomerInvoiceCorrectionDeps {
  invoiceCorrectionPort: CustomerInvoiceCorrectionPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerInvoiceCorrectionHandler({
  invoiceCorrectionPort,
  authenticateUser,
}: CustomerInvoiceCorrectionDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    let authentication: CustomerUserAuthenticationResult;
    try {
      authentication = await authenticateUser(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer authentication failed");
      return;
    }
    if (authentication.ok === false) return sendBffError(res, authentication.code, authentication.message);

    const parsed = customerInvoiceCorrectionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid invoice correction request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await invoiceCorrectionPort.requestInvoiceCorrection(authentication.userId, parsed.data);
      if (!result) return sendBffError(res, "NOT_FOUND", "Customer invoice was not found");
      const response = customerInvoiceCorrectionResponseSchema.safeParse(result);
      if (!response.success) {
        return sendBffError(res, "INVALID_RESPONSE", "Invoice correction returned invalid response");
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Invoice correction request failed");
    }
  };
}
