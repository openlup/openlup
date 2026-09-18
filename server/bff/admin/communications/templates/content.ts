import { withObservedRoute } from "../../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import { sendBffError } from "../../../../_lib/bff/response.js";
import { createCommunicationsAdminTemplateContentHandler } from "../../../../domains/communications/adminTemplatesHandler.js";
import { createSupabaseCommunicationsActorGateway } from "../../../../adapters/supabase/communicationsGateway.js";
import {
  authorizeAdminBooleanWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAuthEnv,
} from "../../../../_lib/admin-domain/auth.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminAuthEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const client = createAdminAuthClient(env, accessToken);
  const templatesPort = createSupabaseCommunicationsActorGateway(client).templatesPort();

  return createCommunicationsAdminTemplateContentHandler({
    readPort: templatesPort,
    writePort: templatesPort,
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
  route: "/api/bff/admin/communications/templates/content",
  domain: "communications",
  surface: "admin",
  risk: "mutation",
}, handler);
