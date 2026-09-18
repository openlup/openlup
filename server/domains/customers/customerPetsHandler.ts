import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerPetCreateRequestSchema,
  customerPetDeleteRequestSchema,
  customerPetMutationResponseSchema,
  customerPetsResponseSchema,
  customerPetUpdateRequestSchema,
} from "../../../src/domains/customers/selfServiceContracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import { CustomerSelfServiceMutationConflictError } from "./customerSelfServiceErrors.js";
import type { CustomerPetsPort } from "./ports.js";

export interface CustomerPetsDeps {
  petsPort: CustomerPetsPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerPetsHandler({ petsPort, authenticateUser }: CustomerPetsDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method ?? "")) {
      sendMethodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
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

    try {
      if (req.method === "GET") {
        const result = await petsPort.listPets(authentication.userId);
        return sendPets(res, result);
      }

      if (req.method === "POST") {
        const parsed = customerPetCreateRequestSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalid(res, "Invalid customer pet create request", parsed.error);
        const result = await petsPort.createPet(authentication.userId, parsed.data);
        return sendPet(res, result);
      }

      if (req.method === "PATCH") {
        const parsed = customerPetUpdateRequestSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalid(res, "Invalid customer pet update request", parsed.error);
        const result = await petsPort.updatePet(authentication.userId, parsed.data);
        return sendPet(res, result);
      }

      const parsed = customerPetDeleteRequestSchema.safeParse(req.body);
      if (!parsed.success) return sendInvalid(res, "Invalid customer pet delete request", parsed.error);
      const result = await petsPort.removePet(authentication.userId, parsed.data);
      return sendPet(res, result);
    } catch (error) {
      if (error instanceof CustomerSelfServiceMutationConflictError) {
        sendBffError(res, "CONFLICT", error.message);
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer pets request failed");
    }
  };
}

function sendPets(res: VercelResponse, result: Awaited<ReturnType<CustomerPetsPort["listPets"]>>): void {
  if (!result) return sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
  const response = customerPetsResponseSchema.safeParse(result);
  if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Customer pets returned invalid response");
  sendBffSuccess(res, response.data);
}

function sendPet(
  res: VercelResponse,
  result: Awaited<ReturnType<CustomerPetsPort["createPet"]>>,
): void {
  if (!result) return sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
  const response = customerPetMutationResponseSchema.safeParse(result);
  if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Customer pet returned invalid response");
  sendBffSuccess(res, response.data);
}

function sendInvalid(res: VercelResponse, message: string, error: { flatten: () => unknown }): void {
  sendBffError(res, "BAD_REQUEST", message, { details: error.flatten() });
}
