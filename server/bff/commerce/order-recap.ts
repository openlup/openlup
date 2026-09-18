import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { createCommerceOrderRecapHandler } from "../../domains/commerce/commerceOrderRecapHandler.js";
import {
  createSupabaseOrderRecapPort,
  type OrderRecapSupabaseClient,
} from "../../adapters/supabase/commerce/orderRecap.js";
import { readCommerceServiceDataGateway } from "./serviceDataGateway.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!providerPaymentsEnabled()) {
    return createCommerceOrderRecapHandler({
      recapPort: { async getOrderRecap() { return null; } },
      mutationsEnabled: providerPaymentsEnabled,
    })(req, res);
  }

  const gateway = readCommerceServiceDataGateway();
  if (!gateway) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Order recap is not configured", {
      details: {
        feature: "order-recap",
        requiredEnv: "SUPABASE_SERVICE_ROLE_KEY",
      },
    });
    return Promise.resolve();
  }

  return gateway.asService((client) =>
    createCommerceOrderRecapHandler({
      recapPort: createSupabaseOrderRecapPort(client as unknown as OrderRecapSupabaseClient),
      mutationsEnabled: providerPaymentsEnabled,
    })(req, res),
  );
}

function providerPaymentsEnabled(): boolean {
  return process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED === "true";
}

export default withObservedRoute({
  route: "/api/bff/commerce/order-recap",
  domain: "commerce",
  surface: "hidden",
  risk: "read",
  featureFlags: ["COMMERCE_PROVIDER_PAYMENTS_ENABLED"],
}, handler);
