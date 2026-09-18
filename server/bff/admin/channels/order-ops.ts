import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import { createAdminChannelOpsHandler } from "../../../domains/channels/adminChannelOpsHandler.js";
import { createAdminChannelsGateway } from "../../../adapters/supabase/adminChannelsGateway.js";
import { channelIngestWebhookEnabled } from "../../channels/webhooks/_handler.js";
import {
  authorizeCommerceAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
} from "../commerce/shared.js";

/**
 * The one channel-operations read: where the ingest run for an order got to, and how deep the
 * quarantine drawer is on the surface it came from.
 *
 * It is gated by the ingest flag rather than by one of its own. A deployment that has never turned
 * ingest on has no ledger rows and no drawer, so a second flag would only be a second thing to
 * forget; a deployment that HAS turned it on wants the panel from the same moment.
 */
function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Channel operations are not configured");
    return Promise.resolve();
  }
  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);
  // The route never sees a data client. The gateway owns the elevated construction and hands back
  // one ready read port, which is what `adminBffServiceRoleBoundary` requires of every
  // non-commerce admin route.
  const gateway = createAdminChannelsGateway(env);

  return createAdminChannelOpsHandler({
    readPort: gateway.opsReadPort(),
    authorizeAdmin: () => authorizeCommerceAdminWithUser(authClient, accessToken),
    enabled: channelIngestWebhookEnabled(),
  })(req, res);
}

export default withObservedRoute(
  {
    route: "/api/bff/admin/channels/order-ops",
    domain: "channels",
    surface: "admin",
    risk: "read",
    featureFlags: ["CHANNEL_INGEST_WEBHOOK_ENABLED"],
  },
  handler,
);
