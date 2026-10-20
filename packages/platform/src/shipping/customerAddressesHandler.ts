import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { BffResponder } from "../bff/index.js";
import type { CustomerAddressesDeps } from "./addressPorts.js";
import type { CustomerAddressSchemas } from "./addressSchemas.js";

export function createCustomerAddressesHandler({
  addressBookPort,
  addressMutationPort,
  authenticateUser,
}: CustomerAddressesDeps, schemas: CustomerAddressSchemas, responder: BffResponder) {
  const { customerAddressesResponseSchema, isMutationConflict } = schemas;
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method ?? "")) {
      sendMethodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
      return;
    }

    let authentication: Awaited<ReturnType<CustomerAddressesDeps["authenticateUser"]>>;
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
      }, schemas);
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
      if (isMutationConflict(error)) {
        sendBffError(res, "CONFLICT", error.message);
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer addresses request failed");
    }
  };
}

async function runAddressRequest(
  req: HttpRequest,
  userId: string,
  ports: Pick<CustomerAddressesDeps, "addressBookPort" | "addressMutationPort">,
  schemas: CustomerAddressSchemas,
) {
  const { customerAddressesRequestSchema, customerAddressDeleteRequestSchema, customerAddressUpsertRequestSchema } = schemas;
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
