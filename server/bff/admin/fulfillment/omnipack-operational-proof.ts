import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createOmnipackOperationalProofHandler } from "../../../domains/fulfillment/omnipackOperationalProofHandler.js";
import { createSupabaseOmnipackOperationalProofPort } from "../../../adapters/supabase/fulfillmentOperationalProof.js";
import type { FulfillmentEvidenceSupabaseClient } from "../../../adapters/supabase/fulfillmentEvidencePorts.js";
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

  return createOmnipackOperationalProofHandler({
    proofPort: createSupabaseOmnipackOperationalProofPort(
      auth.client as unknown as FulfillmentEvidenceSupabaseClient,
    ),
    authorizeAdmin: () => authorizeFulfillmentAdmin(auth.client, auth.accessToken, ["admin"]),
  })(req, res);
}

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/omnipack-operational-proof",
  domain: "fulfillment",
  surface: "admin",
  risk: "read",
}, handler);
