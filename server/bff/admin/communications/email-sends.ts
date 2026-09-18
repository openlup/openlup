import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import {
  createCommunicationsAdminEmailSendsHandler,
} from "../../../domains/communications/adminEmailSendsHandler.js";
import { createSupabaseAdminCommunicationsGateway } from "../../../adapters/supabase/communicationsGateway.js";
import {
  authorizeAdminBooleanWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminServiceEnv,
} from "../../../_lib/admin-domain/auth.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminServiceEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  const communicationsGateway = createSupabaseAdminCommunicationsGateway(env);

  return createCommunicationsAdminEmailSendsHandler({
    readPort: communicationsGateway.emailSendsReadPort(),
    authorizeAdmin: () => authorizeAdmin(authClient, accessToken),
  })(req, res);
}

async function authorizeAdmin(
  client: Parameters<typeof authorizeAdminBooleanWithUser>[0],
  accessToken: string | null,
): Promise<boolean> {
  return authorizeAdminBooleanWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

export default withObservedRoute({
  route: "/api/bff/admin/communications/email-sends",
  domain: "communications",
  surface: "admin",
  risk: "mutation",
}, handler);
