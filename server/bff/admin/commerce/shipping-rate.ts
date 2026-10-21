import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createShippingBindings } from "@openlup/platform/shipping";
import { bffResponder } from "../../../_lib/bff/response.js";
import { resolveAdmin } from "../../../domains/commerce/adminPromotionsHandler.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../../src/domains/commerce/types.js";
import { adminSetShippingRateRequestSchema, adminSetShippingRateResponseSchema, adminShippingRateResponseSchema } from "../../../../src/domains/commerce/adminPromotionsContracts.js";
import {
  createSupabaseAdminPromotionsDataPort,
  type AdminPromotionsSupabaseClient,
} from "../../../adapters/supabase/adminPromotions.js";
import {
  authorizeCommerceAdminWithUser,
  createAdminAuthClient,
  createServiceRoleClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
} from "./shared.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin shipping rate is not configured");
    return Promise.resolve();
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const serviceClient = createServiceRoleClient(env);

  const binding = createShippingBindings({ dataKind: "supabase", responder: bffResponder,
    createManagedStore: () => ({ shippingRateDataPort: createSupabaseAdminPromotionsDataPort(serviceClient as unknown as AdminPromotionsSupabaseClient) }),
    rate: { authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken), resolveAdmin,
      schemas: { contractVersion: COMMERCE_CONTRACT_VERSION, adminSetShippingRateRequestSchema, adminSetShippingRateResponseSchema, adminShippingRateResponseSchema } },
  });
  if (!binding.handlers.rate) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin shipping rate is not configured");
    return Promise.resolve();
  }
  return binding.handlers.rate(req, res);
}

export default withObservedRoute(
  {
    route: "/api/bff/admin/commerce/shipping-rate",
    domain: "commerce",
    surface: "admin",
    risk: "mutation",
  },
  handler,
);
