import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAdminInventorySubscriptionForecastHandler } from "../../../domains/inventory/inventoryHandlers.js";
import {
  resolveAdminInventoryRuntimeBinding,
  type AdminInventoryRuntimeBinding,
} from "../../../runtime/inventory/adminInventoryBinding.js";

type Env = Record<string, string | undefined>;
type BindingResolver = (req: VercelRequest, env: Env) => AdminInventoryRuntimeBinding | null;

export function createAdminInventorySubscriptionForecastRouteHandler(
  resolveBinding: BindingResolver = resolveAdminInventoryRuntimeBinding,
  env: Env = process.env,
) {
  return function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const binding = resolveBinding(req, env);
    if (!binding) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin inventory is not configured");
      return Promise.resolve();
    }

    return createAdminInventorySubscriptionForecastHandler({
      inventoryPort: binding.readPort,
      authorizeAdmin: binding.authorizeAdmin,
    })(req, res);
  };
}

const handler = createAdminInventorySubscriptionForecastRouteHandler();

export default withObservedRoute({
  route: "/api/bff/admin/inventory/subscription-forecast",
  domain: "inventory",
  surface: "admin",
  risk: "read",
}, handler);
