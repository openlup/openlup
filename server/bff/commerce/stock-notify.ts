import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import {
  createSupabaseStockNotifyRateLimitPort,
  type StockNotifyRateLimitClient,
} from "../../_lib/rate-limit/stockNotifyRateLimit.js";
import { createStockNotifyHandler } from "../../domains/commerce/stockNotifyHandler.js";
import { createSupabaseStockNotifySubscribePort } from "../../adapters/supabase/commerce/stockNotifySubscribe.js";
import { readCommerceServiceDataGateway } from "./serviceDataGateway.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Fail-closed flag check FIRST, before any service-role client work, per the
  // hidden-preview discipline: a flag-OFF deploy never touches Supabase.
  if (!backInStockEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Back-in-stock notifications are disabled", {
      details: {
        feature: "back_in_stock",
        featureFlag: "COMMERCE_BACK_IN_STOCK_ENABLED",
        reason: "feature_flag_disabled",
      },
    });
    return;
  }

  const gateway = readCommerceServiceDataGateway();
  if (!gateway) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Back-in-stock notifications are not configured", {
      details: {
        feature: "back_in_stock",
        requiredBoundary: "subscribe_product_stock_notification",
        requiredEnv: "SUPABASE_SERVICE_ROLE_KEY",
      },
    });
    return;
  }

  return gateway.asService((client) =>
    createStockNotifyHandler({
      rateLimitPort: createSupabaseStockNotifyRateLimitPort(
        client as StockNotifyRateLimitClient,
      ),
      subscribePort: createSupabaseStockNotifySubscribePort(
        client as Parameters<typeof createSupabaseStockNotifySubscribePort>[0],
      ),
    })(req, res),
  );
}

function backInStockEnabled(): boolean {
  return process.env.COMMERCE_BACK_IN_STOCK_ENABLED === "true";
}

export default withObservedRoute({
  route: "/api/bff/commerce/stock-notify",
  domain: "commerce",
  surface: "hidden",
  risk: "mutation",
  featureFlags: ["COMMERCE_BACK_IN_STOCK_ENABLED"],
}, handler);
