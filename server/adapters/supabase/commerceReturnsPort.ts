// Reference-application facade; implementation is owned by @openlup/platform/commerce/server.
import { createSupabaseCommerceReturnsPort as createPort } from "@openlup/platform/commerce/server";
import type { ReturnRequestCreateInput } from "../../domains/commerce/commerceReturnsPort.js";
export type { CommerceReturnsRpcClient } from "@openlup/platform/commerce/server";
export const createSupabaseCommerceReturnsPort = createPort<ReturnRequestCreateInput["reasonCode"]>;
