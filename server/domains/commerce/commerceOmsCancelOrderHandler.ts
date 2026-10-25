import * as oms from "@openlup/platform/commerce/server";
import { sendBffError,sendBffSuccess,sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest,VercelResponse } from "../../_lib/types/vercel.js";
import type { BaseDeps } from "./commerceOmsHandlers.js";
export function createAdminCommerceOrderCancelHandler(deps: Omit<Parameters<typeof oms.createAdminCommerceOrderCancelHandler<VercelResponse>>[0], "authorizeAdmin" | "respond" | "readGate"> & BaseDeps) {
 return (req: VercelRequest, res: VercelResponse) => oms.createAdminCommerceOrderCancelHandler({ ...deps, authorizeAdmin: () => deps.authorizeAdmin(req), respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed } })(req, res);
}
