import { createCustomerAccountMutationHandlers } from "@openlup/platform/account-support";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { bffResponder } from "../../_lib/bff/response.js";
import {
  customerProfileUpdateRequestSchema,
  customerProfileUpdateResponseSchema,
} from "../../../src/domains/customers/selfServiceContracts.js";
import {
  customerInvoiceCorrectionRequestSchema,
  customerInvoiceCorrectionResponseSchema,
} from "../../../src/domains/customers/accountV2Contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerProfileMutationPort } from "./ports.js";

export interface CustomerProfileDeps {
  profilePort: CustomerProfileMutationPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerProfileHandler({ profilePort, authenticateUser }: CustomerProfileDeps) {
  return createCustomerAccountMutationHandlers<VercelRequest, VercelResponse>(
    {
      port: {
        updateProfile: (userId, input) => profilePort.updateProfile(userId, input),
        requestInvoiceCorrection: async () => null,
        readEvents: async () => null,
      },
      authenticate: authenticateUser,
      messages: {
        authentication: "Customer authentication failed",
        profileInvalid: "Invalid customer profile request",
        correctionInvalid: "Invalid invoice correction request",
        unlinked: "No customer account linked to this session",
        invoiceMissing: "Customer invoice was not found",
        invalidResponse: "Customer profile returned invalid response",
        failed: "Customer profile update failed",
      },
    },
    {
      profileRequest: customerProfileUpdateRequestSchema,
      profileResponse: customerProfileUpdateResponseSchema,
      correctionRequest: customerInvoiceCorrectionRequestSchema,
      correctionResponse: customerInvoiceCorrectionResponseSchema,
    },
    bffResponder,
  ).profile;
}
