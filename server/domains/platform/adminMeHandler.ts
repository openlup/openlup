import { createAdminPlatformMeHandler as createHandler, type AdminPlatformMeDeps } from "@openlup/platform/identity";
import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
export type { AdminPlatformMeDeps } from "@openlup/platform/identity";
export function createAdminPlatformMeHandler(deps: AdminPlatformMeDeps) {
  return createHandler({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}
