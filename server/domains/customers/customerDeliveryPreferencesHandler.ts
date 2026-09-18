import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CUSTOMER_DELIVERY_PREFERENCES_CONTRACT_VERSION,
  customerDeliveryPreferenceUpsertRequestSchema,
  customerDeliveryPreferenceUpsertResponseSchema,
  customerDeliveryPreferencesResponseSchema,
} from "../../../src/domains/customers/contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerDeliveryPreferencesPort } from "./ports.js";

export interface CustomerDeliveryPreferencesDeps {
  preferencesPort: CustomerDeliveryPreferencesPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerDeliveryPreferencesHandler({
  preferencesPort,
  authenticateUser,
}: CustomerDeliveryPreferencesDeps) {
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
  preferencesPort: CustomerDeliveryPreferencesPort,
): Promise<void> {
  try {
    const preferences = await preferencesPort.listDeliveryPreferences(userId);
    if (!preferences) {
      sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
      return;
    }

    const response = customerDeliveryPreferencesResponseSchema.safeParse({
      contractVersion: CUSTOMER_DELIVERY_PREFERENCES_CONTRACT_VERSION,
      preferences,
    });
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Customer delivery preferences returned invalid response");
      return;
    }

    sendBffSuccess(res, response.data);
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer delivery preferences read failed");
  }
}

async function handlePatch(
  req: VercelRequest,
  res: VercelResponse,
  userId: string,
  preferencesPort: CustomerDeliveryPreferencesPort,
): Promise<void> {
  const request = customerDeliveryPreferenceUpsertRequestSchema.safeParse(req.body);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid customer delivery preference request", {
      details: request.error.flatten(),
    });
    return;
  }

  try {
    const preference = await preferencesPort.upsertDeliveryPreference(userId, request.data);
    if (!preference) {
      sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
      return;
    }

    const response = customerDeliveryPreferenceUpsertResponseSchema.safeParse({
      contractVersion: CUSTOMER_DELIVERY_PREFERENCES_CONTRACT_VERSION,
      preference,
    });
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Customer delivery preference returned invalid response");
      return;
    }

    sendBffSuccess(res, response.data);
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer delivery preference update failed");
  }
}
