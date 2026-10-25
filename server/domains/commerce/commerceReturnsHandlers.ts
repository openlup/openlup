// Reference-application binding: preserve observed BFF response context.
import {
  createCustomerReturnRequestHandler as createCustomer,
  createAdminReturnApproveHandler as createApprove,
  createAdminReturnRejectHandler as createReject,
} from "@openlup/platform/commerce/server";
import { bffResponder } from "../../_lib/bff/response.js";
import { returnRequestCreateSchema, type CommerceReturnsPort } from "./commerceReturnsPort.js";

export function createCustomerReturnRequestHandler(deps: Omit<Parameters<typeof createCustomer>[0], "responder" | "requestSchema" | "port"> & {
  port: Pick<CommerceReturnsPort, "createRequest">;
}) {
  return createCustomer({ ...deps, responder: bffResponder, requestSchema: returnRequestCreateSchema });
}
export function createAdminReturnApproveHandler(deps: Omit<Parameters<typeof createApprove>[0], "responder">) {
  return createApprove({ ...deps, responder: bffResponder });
}
export function createAdminReturnRejectHandler(deps: Omit<Parameters<typeof createReject>[0], "responder">) {
  return createReject({ ...deps, responder: bffResponder });
}
