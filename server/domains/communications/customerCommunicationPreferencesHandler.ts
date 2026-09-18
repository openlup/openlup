import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerCommunicationPreferencesResponseSchema,
  updateCustomerCommunicationPreferencesRequestSchema,
  type CustomerCommunicationPreferencesResponse,
} from "../../../src/domains/communications/customerPreferencesContracts.js";

type CustomerAuthenticationResult =
  | { ok: true; userId: string }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };

export interface CustomerCommunicationPreferencesPort {
  getPreferences(userId: string): Promise<CustomerCommunicationPreferencesResponse | null>;
  updatePreferences(
    userId: string,
    input: { marketingNewsletterConsent: boolean },
  ): Promise<CustomerCommunicationPreferencesResponse | null>;
}

export interface CustomerCommunicationPreferencesDeps {
  preferencesPort: CustomerCommunicationPreferencesPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerAuthenticationResult>;
}

export function createCustomerCommunicationPreferencesHandler({
  preferencesPort,
  authenticateUser,
}: CustomerCommunicationPreferencesDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "PATCH") {
      sendMethodNotAllowed(res, ["GET", "PATCH"]);
      return;
    }

    let authentication: CustomerAuthenticationResult;
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

    const body =
      req.method === "PATCH"
        ? updateCustomerCommunicationPreferencesRequestSchema.safeParse(req.body ?? {})
        : null;
    if (body && !body.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer communication preferences request", {
        details: body.error.flatten(),
      });
      return;
    }

    try {
      const preferences = body
        ? await preferencesPort.updatePreferences(authentication.userId, body.data)
        : await preferencesPort.getPreferences(authentication.userId);
      if (!preferences) {
        sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
        return;
      }

      const response = customerCommunicationPreferencesResponseSchema.safeParse(preferences);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer communication preferences returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer communication preferences failed");
    }
  };
}
