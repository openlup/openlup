import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createFulfillmentProductReconciliationEvidenceHandler } from "../../../domains/fulfillment/productReconciliationEvidenceHandler.js";
import {
  createSupabaseProductReconciliationEvidencePort,
  type FulfillmentEvidenceSupabaseClient,
} from "../../../adapters/supabase/fulfillmentEvidencePorts.js";
import {
  authorizeFulfillmentAdmin,
  createFulfillmentAdminAuthContext,
} from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const auth = createFulfillmentAdminAuthContext(req);
  if (!auth) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  return createFulfillmentProductReconciliationEvidenceHandler({
    evidencePort: createSupabaseProductReconciliationEvidencePort(
      auth.client as unknown as FulfillmentEvidenceSupabaseClient,
    ),
    authorizeAdmin: () => authorizeFulfillmentAdmin(auth.client, auth.accessToken, ["admin"]),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/product-reconciliation-evidence",
  domain: "fulfillment",
  surface: "admin",
  risk: "read",
}, handler);
