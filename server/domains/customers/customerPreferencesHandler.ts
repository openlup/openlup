import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CUSTOMER_PREFERENCES_CONTRACT_VERSION,
  customerPaymentPreferenceUpsertRequestSchema,
  customerPaymentPreferenceUpsertResponseSchema,
  customerPaymentPreferencesResponseSchema,
} from "../../../src/domains/customers/contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerPaymentPreferencesPort } from "./ports.js";

export interface CustomerPaymentPreferencesDeps {
  preferencesPort: CustomerPaymentPreferencesPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerPaymentPreferencesHandler({
  preferencesPort,
  authenticateUser,
}: CustomerPaymentPreferencesDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "PATCH") {
      sendMethodNotAllowed(res, ["GET", "PATCH"]);
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

    if (req.method === "GET") {
      await handleGet(res, authentication.userId, preferencesPort);
      return;
    }

    await handlePatch(req, res, authentication.userId, preferencesPort);
  };
}

async function handleGet(
  res: VercelResponse,
  userId: string,
  preferencesPort: CustomerPaymentPreferencesPort,
): Promise<void> {
  try {
    const preferences = await preferencesPort.listPaymentPreferences(userId);
    if (!preferences) {
      sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
      return;
    }

    const response = customerPaymentPreferencesResponseSchema.safeParse({
      contractVersion: CUSTOMER_PREFERENCES_CONTRACT_VERSION,
      preferences,
    });
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Customer preferences returned invalid response");
      return;
    }

    sendBffSuccess(res, response.data);
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer preferences read failed");
  }
}

async function handlePatch(
  req: VercelRequest,
  res: VercelResponse,
  userId: string,
  preferencesPort: CustomerPaymentPreferencesPort,
): Promise<void> {
  const request = customerPaymentPreferenceUpsertRequestSchema.safeParse(req.body);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid customer preference request", {
      details: request.error.flatten(),
    });
    return;
  }

  try {
    const preference = await preferencesPort.upsertPaymentPreference(userId, request.data);
    if (!preference) {
      sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
      return;
    }

    const response = customerPaymentPreferenceUpsertResponseSchema.safeParse({
      contractVersion: CUSTOMER_PREFERENCES_CONTRACT_VERSION,
      preference,
    });
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Customer preference returned invalid response");
      return;
    }

    sendBffSuccess(res, response.data);
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer preference update failed");
  }
}
