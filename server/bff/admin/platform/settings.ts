import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAdminSettingsReadHandler } from "../../../domains/platform/adminSettingsHandlers.js";
import { createSupabaseAdminSettingsPort } from "../../../adapters/supabase/platform/adminSettingsPort.js";
import {
  authorizePlatformAdmin,
  createPlatformActorDataGateway,
  readBearerToken,
} from "./shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const accessToken = readBearerToken(req);
  const gateway = createPlatformActorDataGateway(accessToken);
  if (!gateway) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  return gateway.asActor({ role: "authenticated" }, (client) =>
    createAdminSettingsReadHandler({
      settingsPort: createSupabaseAdminSettingsPort(client as never),
      authorizeAdmin: () =>
        authorizePlatformAdmin(client as Parameters<typeof authorizePlatformAdmin>[0], accessToken),
    })(req, res),
  );
}

export default withObservedRoute({
  route: "/api/bff/admin/platform/settings",
  domain: "platform",
  surface: "admin",
  risk: "mutation",
}, handler);
