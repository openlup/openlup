import { withObservedRoute } from "../../../../_lib/observability/route.js";
import { createOmnipackWebhookRoute } from "./_handler.js";

export default withObservedRoute({
  route: "/api/bff/fulfillment/webhooks/omnipack/order-processing",
  domain: "fulfillment",
  surface: "webhook",
  risk: "provider",
  featureFlags: ["COMMERCE_OMNIPACK_WEBHOOKS_ENABLED", "OMNIPACK_PROVIDER_ENABLED"],
}, createOmnipackWebhookRoute("order.processing_started"));
