import { withObservedRoute } from "../../_lib/observability/route.js";
import { providerPaymentsEnabled } from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { createCommercePaymentVerifyHandler } from "../../domains/payment/paymentVerifyNowHandler.js";
import {
  createSupabasePaymentVerifyNowPort,
  type PaymentVerifySupabaseClient,
} from "../../adapters/supabase/payment/paymentVerifyNow.js";
import {
  createSupabasePaymentProviderReconciliationPort,
} from "../../adapters/supabase/payment/paymentProviderReconciliation.js";
import { createPaymentProviderReadbackRegistry } from "../../runtime/paymentProviderReadbackRegistry.js";
import { readCommerceServiceDataGateway } from "./serviceDataGateway.js";

// Buyer-triggered provider readback after a client-side confirm failure: the
// server reads the live provider state and (only for a terminal result)
// applies it through the reconciliation apply RPC. See
// paymentVerifyNowHandler for the trust and idempotency model.
function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!providerPaymentsEnabled()) {
    return createCommercePaymentVerifyHandler({
      readPort: { async readVerifiableAttempt() { return null; } },
      applyPort: { applyTerminalResult() { throw new Error("payments_disabled"); } },
      providers: {},
      mutationsEnabled: providerPaymentsEnabled,
    })(req, res);
  }

  const gateway = readCommerceServiceDataGateway();
  if (!gateway) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Provider payment verify is not configured", {
      details: {
        feature: "payment-verify",
        requiredEnv: "SUPABASE_SERVICE_ROLE_KEY",
      },
    });
    return Promise.resolve();
  }

  const providers = createPaymentProviderReadbackRegistry(process.env);
  return gateway.asService((client) =>
    createCommercePaymentVerifyHandler({
      readPort: createSupabasePaymentVerifyNowPort(client as unknown as PaymentVerifySupabaseClient),
      applyPort: createSupabasePaymentProviderReconciliationPort(
        client as unknown as Parameters<typeof createSupabasePaymentProviderReconciliationPort>[0],
      ),
      providers,
      mutationsEnabled: providerPaymentsEnabled,
    })(req, res),
  );
}

export default withObservedRoute({
  route: "/api/bff/commerce/payment-verify",
  domain: "commerce",
  surface: "hidden",
  risk: "mutation",
  featureFlags: ["COMMERCE_PROVIDER_PAYMENTS_ENABLED"],
}, handler);
