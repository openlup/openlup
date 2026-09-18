import { createSupabasePaymentRecoveryGuidancePort, type PaymentRecoveryGuidanceClient } from "../../adapters/supabase/commerce/paymentRecoveryGuidance.js";
import { createSupabaseCheckoutRecoveryTokenPort, type CheckoutRecoveryTokenSupabaseClient } from "../../adapters/supabase/commerce/checkoutRecoveryToken.js";
import { createPaymentRecoveryEvidenceNormalizer } from "../../adapters/paymentRecoveryGuidance.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { providerPaymentsEnabled } from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { createCommercePaymentStatusHandler } from "../../domains/commerce/commercePaymentStatusHandler.js";
import {
  createSupabasePaymentStatusPort,
  type PaymentStatusSupabaseClient,
} from "../../adapters/supabase/commerce/paymentStatus.js";
import { readCommerceServiceDataGateway } from "./serviceDataGateway.js";
import {
  createCheckoutPaymentContinuationCodec,
} from "../../domains/commerce/checkoutPaymentContinuationCredential.js";
import {
  createCheckoutActivePaymentActionResolver,
  projectCheckoutActionReadProviders,
} from "../../domains/payment/checkoutActivePaymentActionResolver.js";
import {
  createSupabasePaymentVerifyNowPort as createPaymentReadPort,
  type PaymentVerifySupabaseClient as PaymentReadClient,
} from "../../adapters/supabase/payment/paymentVerifyNow.js";
import { createPaymentProviderReadbackRegistry } from "../../runtime/paymentProviderReadbackRegistry.js";

// W6: representative migration of an inline service-role client factory to the
// DataGatewayPort.asService seam. The gateway builds a byte-identical elevated client (same option
// shape), so this read path is unchanged; the win is one canonical client-construction site.
function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!providerPaymentsEnabled()) {
    return createCommercePaymentStatusHandler({
      statusPort: { async getPaymentStatus() { return null; } },
      mutationsEnabled: providerPaymentsEnabled,
    })(req, res);
  }

  const gateway = readCommerceServiceDataGateway();
  if (!gateway) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Provider payment status is not configured", {
      details: {
        feature: "payment-status",
        requiredEnv: "SUPABASE_SERVICE_ROLE_KEY",
      },
    });
    return Promise.resolve();
  }

  return gateway.asService((client) => {
    // The signing secret is the only thing that can withhold the continuation
    // now. Absent, the codec is null, no action is ever handed back, and the
    // browser's marker stays `action_issued` — which it discards on refresh
    // rather than waiting on. Fail-closed with no buyer-visible failure.
    const codec = createCheckoutPaymentContinuationCodec(
      process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET,
    );
    const activeActionResolver = codec
      ? createCheckoutActivePaymentActionResolver({
          readPort: createPaymentReadPort(client as unknown as PaymentReadClient),
          providers: projectCheckoutActionReadProviders(
            createPaymentProviderReadbackRegistry(process.env),
          ),
        })
      : undefined;
    return createCommercePaymentStatusHandler({
      statusPort: createSupabasePaymentStatusPort(client as unknown as PaymentStatusSupabaseClient),
      mutationsEnabled: providerPaymentsEnabled,
      readContinuationClaims: codec
        ? (cookieHeader) => codec.verifyCookieHeader(cookieHeader)
        : undefined,
      activeActionResolver,
      recoveryGuidance: {
        port: createSupabasePaymentRecoveryGuidancePort(client as unknown as PaymentRecoveryGuidanceClient, createPaymentRecoveryEvidenceNormalizer()),
        tokenPort: createSupabaseCheckoutRecoveryTokenPort(client as unknown as CheckoutRecoveryTokenSupabaseClient),
      },
    })(req, res);
  });
}

export default withObservedRoute({
  route: "/api/bff/commerce/payment-status",
  domain: "commerce",
  surface: "hidden",
  risk: "read",
  featureFlags: ["COMMERCE_PROVIDER_PAYMENTS_ENABLED"],
}, handler);
