import { createCustomerAccountMutationHandlers } from "@openlup/platform/account-support";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { bffResponder } from "../../_lib/bff/response.js";
import {
  customerInvoiceCorrectionRequestSchema,
  customerInvoiceCorrectionResponseSchema,
} from "../../../src/domains/customers/accountV2Contracts.js";
import {
  customerProfileUpdateRequestSchema,
  customerProfileUpdateResponseSchema,
} from "../../../src/domains/customers/selfServiceContracts.js";
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
  return createCustomerAccountMutationHandlers<VercelRequest, VercelResponse>(
    {
      port: {
        updateProfile: async () => null,
        requestInvoiceCorrection: (userId, input) =>
          invoiceCorrectionPort.requestInvoiceCorrection(userId, input),
        readEvents: async () => null,
      },
      authenticate: authenticateUser,
      messages: {
        authentication: "Customer authentication failed",
        profileInvalid: "Invalid customer profile request",
        correctionInvalid: "Invalid invoice correction request",
        unlinked: "No customer account linked to this session",
        invoiceMissing: "Customer invoice was not found",
        invalidResponse: "Invoice correction returned invalid response",
        failed: "Invoice correction request failed",
      },
    },
    {
      profileRequest: customerProfileUpdateRequestSchema,
      profileResponse: customerProfileUpdateResponseSchema,
      correctionRequest: customerInvoiceCorrectionRequestSchema,
      correctionResponse: customerInvoiceCorrectionResponseSchema,
    },
    bffResponder,
  ).invoiceCorrection;
}
