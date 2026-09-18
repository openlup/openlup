import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAdminPlatformMeHandler } from "../../../domains/platform/adminMeHandler.js";
import {
  authenticateSupabasePlatformUser,
  createSupabaseAdminPlatformPort,
} from "../../../adapters/supabase/platform/adminPlatformPort.js";
import { createPlatformActorDataGateway, readBearerToken } from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const accessToken = readBearerToken(req);
  const gateway = createPlatformActorDataGateway(accessToken);
  if (!gateway) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  return gateway.asActor({ role: "authenticated" }, (client) =>
    createAdminPlatformMeHandler({
      platformPort: createSupabaseAdminPlatformPort(client as never),
      authenticateUser: () => authenticateSupabasePlatformUser(client as never, accessToken),
    })(req, res),
  );
}

export default withObservedRoute({
  route: "/api/bff/admin/platform/me",
  domain: "platform",
  surface: "admin",
  risk: "mutation",
}, handler);
