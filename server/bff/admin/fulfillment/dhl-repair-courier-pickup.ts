import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import {
  createFulfillmentDhlRepairCourierPickupHandler,
  isRetiredDhlRepairMutation,
} from "../../../domains/fulfillment/dhlShipmentHandler.js";
import { createDhlCourierRepairPort } from "../../../adapters/dhl/courierRepairAdapter.js";
import {
  authorizeFulfillmentAdmin,
  createFulfillmentAdminAuthContext,
} from "./shared.js";

const DEFAULT_DEPS = {
  createAuthContext: createFulfillmentAdminAuthContext,
  createPort: createDhlCourierRepairPort,
  authorizeAdmin: authorizeFulfillmentAdmin,
  createDomainHandler: createFulfillmentDhlRepairCourierPickupHandler,
};

export function createDhlRepairCourierPickupRoute(
  overrides: Partial<typeof DEFAULT_DEPS> = {},
) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (isRetiredDhlRepairMutation(req.body)) {
      sendBffError(res, "NOT_FOUND", "DHL courier pickup mutation is retired", {
        details: { reason: "direct_dhl_repair_mutation_retired" },
      });
      return;
    }
    const auth = deps.createAuthContext(req);
    if (!auth) {
      sendBffError(res, "INTERNAL", "Supabase environment is not configured");
      return;
    }

    return deps.createDomainHandler({
      shipmentPort: deps.createPort({ accessToken: auth.accessToken }),
      authorizeAdmin: () => deps.authorizeAdmin(auth.client, auth.accessToken, ["admin"]),
    })(req, res);
  };
}

const handler = createDhlRepairCourierPickupRoute();

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/dhl-repair-courier-pickup",
  domain: "fulfillment",
  surface: "admin",
  risk: "provider",
}, handler);
