import * as oms from "@openlup/platform/commerce/server";
import { sendBffError,sendBffSuccess,sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest,VercelResponse } from "../../_lib/types/vercel.js";
import type { BaseDeps } from "./commerceOmsHandlers.js";
export function createAdminCommerceOrderMarkRefundedHandler(deps: Omit<Parameters<typeof oms.createAdminCommerceOrderMarkRefundedHandler<VercelResponse>>[0], "authorizeAdmin" | "respond" | "readGate"> & BaseDeps) {
 return (req: VercelRequest, res: VercelResponse) => oms.createAdminCommerceOrderMarkRefundedHandler({ ...deps, authorizeAdmin: () => deps.authorizeAdmin(req), respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed } })(req, res);
}
