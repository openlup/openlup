import { withObservedRoute } from "../../_lib/observability/route.js";
import { dbBackedQuoteEnabled, starterPackEnabled } from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import { createCommerceCustomerEligibilityHandler } from "../../domains/commerce/commerceCustomerEligibilityHandler.js";
import {
  resolveQuoteCustomerEligibility,
  type QuoteCustomerEligibilityClient,
} from "../../adapters/supabase/quoteCustomerEligibility.js";
import {
  createManagedCommercePromoDataPort,
  type PromoDataClient,
} from "../../adapters/supabase/promotionClaims.js";
import {
  createSupabaseCustomerEligibilityRateLimitPort,
  type CustomerEligibilityRateLimitClient,
} from "../../_lib/rate-limit/customerEligibilityRateLimit.js";
import { readCommerceServiceDataGateway } from "./serviceDataGateway.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!eligibilityLookupEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer eligibility lookup is disabled", {
      details: {
        feature: "customer_eligibility",
        featureFlag: "COMMERCE_V2_W2_PRICING_RESOLVER",
      },
    });
    return Promise.resolve();
  }

  const gateway = readCommerceServiceDataGateway();
  if (!gateway) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer eligibility lookup is not configured", {
      details: {
        feature: "customer_eligibility",
        requiredEnv: "SUPABASE_SERVICE_ROLE_KEY",
      },
    });
    return Promise.resolve();
  }

  return gateway.asService((client) => {
    const promoDataPort = createManagedCommercePromoDataPort(
      client as unknown as PromoDataClient,
    );
    const rateLimitPort = createSupabaseCustomerEligibilityRateLimitPort(
      client as unknown as CustomerEligibilityRateLimitClient,
    );
    return createCommerceCustomerEligibilityHandler({
      resolveCustomerEligibility: ({ email }) =>
        resolveQuoteCustomerEligibility(
          client as unknown as QuoteCustomerEligibilityClient,
          { customerEligibilityContext: { email } } as CreateQuoteRequest,
        ),
      countPaidOrdersByMode: (clientId) => promoDataPort.countPaidOrdersByMode(clientId),
      checkRateLimit: (request, email) =>
        rateLimitPort.check({ headers: request.headers, email }),
      starterPackEnabled,
    })(req, res);
  });
}

function eligibilityLookupEnabled(): boolean {
  return dbBackedQuoteEnabled();
}

export default withObservedRoute(
  {
    route: "/api/bff/commerce/customer-eligibility",
    domain: "commerce",
    surface: "hidden",
    risk: "read",
    // Metadata only. `COMMERCE_V2_W2_PRICING_RESOLVER` gates the whole route
    // (see `eligibilityLookupEnabled`); `COMMERCE_STARTER_PACK_ENABLED` gates
    // only the additive `starterOffer` field, inside the handler.
    featureFlags: ["COMMERCE_V2_W2_PRICING_RESOLVER", "COMMERCE_STARTER_PACK_ENABLED"],
  },
  handler,
);
