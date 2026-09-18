import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAdminInventoryStockAdjustmentHandler } from "../../../domains/inventory/inventoryHandlers.js";
import {
  resolveAdminInventoryRuntimeBinding,
  type AdminInventoryRuntimeBinding,
} from "../../../runtime/inventory/adminInventoryBinding.js";

type Env = Record<string, string | undefined>;
type BindingResolver = (req: VercelRequest, env: Env) => AdminInventoryRuntimeBinding | null;

export function createAdminInventoryStockAdjustmentRouteHandler(
  resolveBinding: BindingResolver = resolveAdminInventoryRuntimeBinding,
  env: Env = process.env,
) {
  return function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const binding = resolveBinding(req, env);
    if (!binding) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin inventory is not configured");
      return Promise.resolve();
    }

    return createAdminInventoryStockAdjustmentHandler({
      inventoryPort: binding.mutationPort,
      authorizeAdmin: binding.authorizeAdmin,
      mutationsEnabled: binding.mutationsEnabled,
    })(req, res);
  };
}

const handler = createAdminInventoryStockAdjustmentRouteHandler();

export default withObservedRoute({
  route: "/api/bff/admin/inventory/stock-adjustment",
  domain: "inventory",
  surface: "admin",
  risk: "mutation",
}, handler);
