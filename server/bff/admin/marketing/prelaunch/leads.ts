import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import {
  authorizeAdminBooleanWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAuthEnv,
} from "../../../../_lib/admin-domain/auth.js";
import { createAdminPrelaunchLeadsHandler } from "../../../../domains/marketing/prelaunch/adminPrelaunchLeadsHandler.js";
import {
  createSupabaseAdminPrelaunchLeadsPort,
  type AdminPrelaunchSupabaseClient,
} from "../../../../adapters/supabase/marketing/adminPrelaunchLeadsPort.js";
import {
  createPrelaunchAcquisitionListHandler,
  isDirectPrelaunchAcquisitionBundle,
  isPrelaunchAcquisitionListView,
} from "../../../marketing/prelaunchAcquisitionDirect.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (isDirectPrelaunchAcquisitionBundle()) {
    if (isPrelaunchAcquisitionListView(req)) {
      return createPrelaunchAcquisitionListHandler()(req, res);
    }
    sendBffError(res, "NOT_FOUND", "Prelaunch acquisition view unavailable");
    return;
  }
  const env = readSupabaseAdminAuthEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const client = createAdminAuthClient(env, accessToken);

  return createAdminPrelaunchLeadsHandler({
    readPort: createSupabaseAdminPrelaunchLeadsPort(client as unknown as AdminPrelaunchSupabaseClient),
    authorizeAdmin: () => authorizeAdmin(client, accessToken),
  })(req, res);
}

async function authorizeAdmin(
  client: Parameters<typeof authorizeAdminBooleanWithUser>[0],
  accessToken: string | null,
): Promise<boolean> {
  return authorizeAdminBooleanWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export default withObservedRoute({
  route: "/api/bff/admin/marketing/prelaunch/leads",
  domain: "marketing",
  surface: "admin",
  risk: "read",
}, handler);
