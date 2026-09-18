import { withObservedRoute } from "../../../_lib/observability/route.js";
import { customerAuthUiEnabled, pspRecoveryEnabled, subscriptionMutationsEnabled } from "../../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import {
  createPaymentRecoveryRedeemHandler,
} from "../../../domains/subscription/paymentRecoveryHandler.js";
import {
  createSupabaseSubscriptionRecoveryPort,
  type PaymentRecoverySupabaseClient,
} from "../../../adapters/supabase/subscription/subscriptionRecovery.js";
import {
  authenticateCustomerUser,
  createCustomerClients,
  readBearerToken,
  readCustomerSelfServiceEnv,
} from "../shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!paymentRecoveryEnabled()) {
    return createPaymentRecoveryRedeemHandler({
      enabled: paymentRecoveryEnabled,
      authenticateCustomer: async () => ({ ok: false }),
      recoveryPort: emptyPort(),
    })(req, res);
  }

  const env = readCustomerSelfServiceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Payment recovery is not configured", {
      details: { feature: "payment-recovery", requiredEnv: "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY" },
    });
    return;
  }

  const accessToken = readBearerToken(req);
  const clients = createCustomerClients(env, accessToken);

  return createPaymentRecoveryRedeemHandler({
    enabled: paymentRecoveryEnabled,
    authenticateCustomer: () => authenticateCustomerUser(clients.customerClient, accessToken),
    recoveryPort: createSupabaseSubscriptionRecoveryPort(clients.serviceClient as unknown as PaymentRecoverySupabaseClient),
  })(req, res);
}

function paymentRecoveryEnabled(): boolean {
  return customerAuthUiEnabled() &&
    subscriptionMutationsEnabled() &&
    pspRecoveryEnabled();
}

function emptyPort() {
  return {
    async findTokenEvidenceByHash() {
      throw new Error("Payment recovery port unavailable");
    },
    async recordSubscriptionPaymentRecovery() {
      throw new Error("Payment recovery port unavailable");
    },
  };
}

export default withObservedRoute({
  route: "/api/bff/customers/payment-recovery/redeem",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_PSP_RECOVERY_ENABLED","COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED","COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
