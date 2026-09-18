import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { readBearerToken } from "../../../_lib/admin-domain/auth.js";
import { createFulfillmentLowStockEvidenceHandler } from "../../../domains/fulfillment/lowStockEvidenceHandler.js";
import {
  createSupabaseLowStockEvidencePort,
  type FulfillmentEvidenceSupabaseClient,
} from "../../../adapters/supabase/fulfillmentEvidencePorts.js";
import {
  authorizeFulfillmentAdmin,
  createFulfillmentAdminAuthContext,
} from "./shared.js";
import { resolveAdminAuthBinding } from "../../../runtime/auth/adminAuthBinding.js";
import { resolveFulfillmentEvidenceBinding } from "../../../runtime/fulfillment/fulfillmentConvergenceBinding.js";
import { resolveBundleId } from "../../../domains/platform-runtime/platformKernel.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (resolveBundleId(process.env) === "node-postgres") {
    return handleDirect(req, res);
  }
  const auth = createFulfillmentAdminAuthContext(req);
  if (!auth) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  return createFulfillmentLowStockEvidenceHandler({
    evidencePort: createSupabaseLowStockEvidencePort(
      auth.client as unknown as FulfillmentEvidenceSupabaseClient,
    ),
    authorizeAdmin: () => authorizeFulfillmentAdmin(auth.client, auth.accessToken, ["admin"]),
  })(req, res);
}

async function handleDirect(req: VercelRequest, res: VercelResponse): Promise<void> {
  const accessToken = readBearerToken(req);
  const auth = resolveAdminAuthBinding(process.env);
  if (!auth.binding) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return;
  }
  try {
    await auth.binding.run(accessToken, async (port) => {
      const authorization = await port.authorize(accessToken, { allowedRoles: ["admin"] });
      if (authorization.ok === false) {
        sendBffError(res, authorization.code, authorization.message);
        return;
      }
      const evidence = resolveFulfillmentEvidenceBinding(process.env);
      if (!evidence.binding) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Fulfillment evidence is unavailable");
        return;
      }
      await evidence.binding.run((evidencePort) => createFulfillmentLowStockEvidenceHandler({
        evidencePort,
        authorizeAdmin: async () => true,
      })(req, res));
    });
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Fulfillment evidence is unavailable");
  }
}

export default withObservedRoute({
  route: "/api/bff/admin/fulfillment/low-stock-evidence",
  domain: "fulfillment",
  surface: "admin",
  risk: "read",
}, handler);
