import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
import { createCustomerMeHandler as createHandler, type CustomerMeDeps as IdentityCustomerMeDeps } from "@openlup/platform/identity";
import { customerMeResponseSchema } from "../../../src/domains/customers/contracts.js";
export type CustomerMeDeps = Omit<IdentityCustomerMeDeps, "responseSchema">;
export function createCustomerMeHandler(deps: CustomerMeDeps) {
  return createHandler({ responseRequestId: (res) => readObservedResponseContext(res)?.requestId, ...deps, responseSchema: customerMeResponseSchema });
}
