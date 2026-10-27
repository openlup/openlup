import { createAdminAlertsOverviewHandler as createOverview } from "@openlup/platform/operations/server";
import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
export type { AdminAlertsReadPort } from "@openlup/platform/operations/server";
export function createAdminAlertsOverviewHandler(deps: Parameters<typeof createOverview>[0]) {
  return createOverview({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}
