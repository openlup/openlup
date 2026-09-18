import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerBillingProfileDeleteRequestSchema,
  customerBillingProfilesResponseSchema,
  customerBillingProfileUpsertRequestSchema,
} from "../../../src/domains/customers/accountV2Contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerBillingProfilesPort } from "./ports.js";

export interface CustomerBillingProfilesDeps {
  billingPort: CustomerBillingProfilesPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerBillingProfilesHandler({
  billingPort,
  authenticateUser,
}: CustomerBillingProfilesDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method ?? "")) {
      sendMethodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
      return;
    }
    const authentication = await authenticate(authenticateUser, req, res);
    if (!authentication) return;

    try {
      const result = await runBillingRequest(req, authentication.userId, billingPort);
      if (!result) return sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
      const response = customerBillingProfilesResponseSchema.safeParse(result);
      if (!response.success) {
        return sendBffError(res, "INVALID_RESPONSE", "Customer billing profiles returned invalid response");
      }
      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof InvalidBillingRequest) {
        sendBffError(res, "BAD_REQUEST", error.message, { details: error.validation?.flatten() });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer billing profiles request failed");
    }
  };
}

async function runBillingRequest(
  req: VercelRequest,
  userId: string,
  billingPort: CustomerBillingProfilesPort,
) {
  if (req.method === "GET") return billingPort.listBillingProfiles(userId);
  if (req.method === "DELETE") {
    const parsed = customerBillingProfileDeleteRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new InvalidBillingRequest("Invalid customer billing profile delete request", parsed.error);
    return billingPort.deleteBillingProfile(userId, parsed.data);
  }
  const parsed = customerBillingProfileUpsertRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new InvalidBillingRequest("Invalid customer billing profile upsert request", parsed.error);
  return billingPort.upsertBillingProfile(userId, parsed.data);
}

async function authenticate(
  authenticateUser: CustomerBillingProfilesDeps["authenticateUser"],
  req: VercelRequest,
  res: VercelResponse,
) {
  try {
    const authentication = await authenticateUser(req);
    if (authentication.ok === false) sendBffError(res, authentication.code, authentication.message);
    return authentication.ok ? authentication : null;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer authentication failed");
    return null;
  }
}

class InvalidBillingRequest extends Error {
  constructor(message: string, readonly validation?: { flatten: () => unknown }) {
    super(message);
  }
}
