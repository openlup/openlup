import { withObservedRoute } from "../../../_lib/observability/route.js";
import { createChannelWebhookRoute } from "./_handler.js";
import { NOOP_CHANNEL_CONNECTOR_KIND } from "../../../adapters/noop_channel/noopChannelConnectorAdapter.js";

// The simulator connector's webhook rail. Thin on purpose: everything a channel webhook does lives
// in `_handler.ts`, so the only thing this file decides is WHICH connector this path speaks for.
//
// It is the first mounted channel webhook and it settles nothing. The registry refuses the
// simulator kind wherever a simulated settlement must not be believed, so this route answers
// `connector_unavailable` in production even with the flag on and a valid token.

export default withObservedRoute(
  {
    route: "/api/bff/channels/webhooks/simulator",
    domain: "channels",
    surface: "webhook",
    risk: "provider",
    featureFlags: ["CHANNEL_INGEST_WEBHOOK_ENABLED"],
  },
  createChannelWebhookRoute(NOOP_CHANNEL_CONNECTOR_KIND),
);
