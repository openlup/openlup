import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAdminInventoryAtpCheckHandler } from "../../../domains/inventory/inventoryHandlers.js";
import {
  resolveAdminInventoryRuntimeBinding,
  type AdminInventoryRuntimeBinding,
} from "../../../runtime/inventory/adminInventoryBinding.js";

type Env = Record<string, string | undefined>;
type BindingResolver = (req: VercelRequest, env: Env) => AdminInventoryRuntimeBinding | null;

export function createAdminInventoryAtpCheckRouteHandler(
  resolveBinding: BindingResolver = resolveAdminInventoryRuntimeBinding,
  env: Env = process.env,
) {
  return function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const binding = resolveBinding(req, env);
    if (!binding) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin inventory is not configured");
      return Promise.resolve();
    }

    return createAdminInventoryAtpCheckHandler({
      inventoryPort: binding.readPort,
      authorizeAdmin: binding.authorizeAdmin,
    })(req, res);
  };
}

const handler = createAdminInventoryAtpCheckRouteHandler();

export default withObservedRoute({
  route: "/api/bff/admin/inventory/atp-check",
  domain: "inventory",
  surface: "admin",
  risk: "mutation",
}, handler);
