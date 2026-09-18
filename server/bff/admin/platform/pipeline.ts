import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAdminPipelineReadHandler } from "../../../domains/platform/adminPipelineHandlers.js";
import { createSupabaseAdminPipelinePort } from "../../../adapters/supabase/platform/adminPipelinePort.js";
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
    createAdminPipelineReadHandler({
      pipelinePort: createSupabaseAdminPipelinePort(client as never),
      authorizeAdmin: () =>
        authorizePlatformAdmin(client as Parameters<typeof authorizePlatformAdmin>[0], accessToken),
    })(req, res),
  );
}

export default withObservedRoute({
  route: "/api/bff/admin/platform/pipeline",
  domain: "platform",
  surface: "admin",
  risk: "mutation",
}, handler);
