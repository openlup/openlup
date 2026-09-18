import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  customerAddressesRequestSchema,
  customerAddressesResponseSchema,
} from "../../../src/domains/customers/contracts.js";
import {
  customerAddressDeleteRequestSchema,
  customerAddressUpsertRequestSchema,
} from "../../../src/domains/customers/selfServiceContracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import { CustomerSelfServiceMutationConflictError } from "./customerSelfServiceErrors.js";
import type { CustomerAddressBookPort, CustomerAddressMutationPort } from "./ports.js";

export interface CustomerAddressesDeps {
  addressBookPort: CustomerAddressBookPort;
  addressMutationPort?: CustomerAddressMutationPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

export function createCustomerAddressesHandler({
  addressBookPort,
  addressMutationPort,
  authenticateUser,
}: CustomerAddressesDeps) {
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
      const addressBook = await runAddressRequest(req, authentication.userId, {
        addressBookPort,
        addressMutationPort,
      });
      if (!addressBook) {
        sendBffError(res, "FORBIDDEN", "No customer account linked to this session");
        return;
      }

      const response = customerAddressesResponseSchema.safeParse(addressBook);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer addresses returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch (error) {
      if (error instanceof InvalidAddressRequest) {
        sendBffError(res, "BAD_REQUEST", error.message, {
          details: error.validation.flatten(),
        });
        return;
      }
      if (error instanceof CustomerSelfServiceMutationConflictError) {
        sendBffError(res, "CONFLICT", error.message);
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer addresses request failed");
    }
  };
}

async function runAddressRequest(
  req: VercelRequest,
  userId: string,
  ports: Pick<CustomerAddressesDeps, "addressBookPort" | "addressMutationPort">,
) {
  if (req.method === "GET") {
    const request = customerAddressesRequestSchema.safeParse(req.query ?? {});
    if (!request.success) throw new InvalidAddressRequest("Invalid customer addresses request", request.error);
    return ports.addressBookPort.getAddressBook(userId);
  }

  if (!ports.addressMutationPort) {
    throw new Error("Customer address mutations are not configured");
  }

  if (req.method === "DELETE") {
    const request = customerAddressDeleteRequestSchema.safeParse(req.body);
    if (!request.success) throw new InvalidAddressRequest("Invalid customer address delete request", request.error);
    return ports.addressMutationPort.deleteAddress(userId, request.data);
  }

  const request = customerAddressUpsertRequestSchema.safeParse(req.body);
  if (!request.success) throw new InvalidAddressRequest("Invalid customer address upsert request", request.error);
  return ports.addressMutationPort.upsertAddress(userId, request.data);
}

class InvalidAddressRequest extends Error {
  constructor(
    message: string,
    public readonly validation: { flatten: () => unknown },
  ) {
    super(message);
  }
}
