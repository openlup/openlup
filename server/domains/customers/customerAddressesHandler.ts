import { createCustomerAddressesHandler as createHandler, type CustomerAddressSchemas } from "@openlup/platform/shipping";
import { bffResponder } from "../../_lib/bff/response.js";
import {
  customerAddressesRequestSchema,
  customerAddressesResponseSchema,
} from "../../../src/domains/customers/contracts.js";
import {
  customerAddressDeleteRequestSchema,
  customerAddressUpsertRequestSchema,
} from "../../../src/domains/customers/selfServiceContracts.js";
import { CustomerSelfServiceMutationConflictError } from "./customerSelfServiceErrors.js";

import type { VercelRequest } from "../../_lib/types/vercel.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerAddressBookPort, CustomerAddressMutationPort } from "./ports.js";

export interface CustomerAddressesDeps {
  addressBookPort: CustomerAddressBookPort;
  addressMutationPort?: CustomerAddressMutationPort;
  authenticateUser: (req: VercelRequest) => Promise<CustomerUserAuthenticationResult>;
}

const schemas: CustomerAddressSchemas = {
  customerAddressesRequestSchema, customerAddressesResponseSchema,
  customerAddressDeleteRequestSchema, customerAddressUpsertRequestSchema,
  isMutationConflict: (error): error is Error => error instanceof CustomerSelfServiceMutationConflictError,
};
export function createCustomerAddressesHandler(deps: CustomerAddressesDeps) {
  return createHandler(deps, schemas, bffResponder);
}
