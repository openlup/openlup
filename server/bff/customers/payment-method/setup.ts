import { withObservedRoute } from "../../../_lib/observability/route.js";
import { customerAuthUiEnabled, subscriptionMutationsEnabled } from "../../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import {
  createCustomerPaymentMethodSetupHandler,
  type StripeSetupIntentInput,
  type StripeSetupIntentResult,
} from "../../../domains/customers/customerPaymentMethodSetupHandler.js";
import { createSupabaseCustomerPaymentMethodSetupPort } from "../../../adapters/supabase/customerPaymentMethodSetupPort.js";
import { buildStripeApiClientIfEnabled } from "../../../infra/stripe/buildStripeApiClientIfEnabled.js";
import {
  authenticateCustomerUser,
  createCustomerClients,
  readBearerToken,
  readCustomerSelfServiceEnv,
} from "../shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!cardUpdateEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Card update is disabled", {
      details: { feature: "customer-payment-method-setup", reason: "feature_flag_disabled" },
    });
    return;
  }

  const env = readCustomerSelfServiceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Card update is not configured", {
      details: { feature: "customer-payment-method-setup", requiredEnv: "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY" },
    });
    return;
  }

  const stripeClient = buildStripeApiClientIfEnabled(process.env);
  if (!stripeClient) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Stripe is not configured for card update", {
      details: { feature: "customer-payment-method-setup", requiredEnv: "STRIPE_PROVIDER_ENABLED+STRIPE_SECRET_KEY" },
    });
    return;
  }

  const accessToken = readBearerToken(req);
  const clients = createCustomerClients(env, accessToken);

  const createSetupIntent = async (input: StripeSetupIntentInput): Promise<StripeSetupIntentResult> => {
    const intent = await stripeClient.createSetupIntent(
      { customer: input.customer, usage: "off_session", metadata: input.metadata },
      { idempotencyKey: input.idempotencyKey },
    );
    if (!intent.client_secret) throw new Error("Stripe SetupIntent missing client_secret");
    return { setupIntentId: intent.id, clientSecret: intent.client_secret };
  };

  return createCustomerPaymentMethodSetupHandler({
    enabled: cardUpdateEnabled,
    authenticateUser: () => authenticateCustomerUser(clients.customerClient, accessToken),
    setupPort: createSupabaseCustomerPaymentMethodSetupPort(clients.serviceClient),
    createSetupIntent,
    ensureCustomer: ({ clientId, metadata, idempotencyKey }) => {
      if (!stripeClient.ensureCustomer) throw new Error("Stripe ensureCustomer unavailable");
      return stripeClient.ensureCustomer({ clientId, metadata }, { idempotencyKey });
    },
  })(req, res);
}

function cardUpdateEnabled(): boolean {
  return customerAuthUiEnabled() && subscriptionMutationsEnabled();
}

export default withObservedRoute({
  route: "/api/bff/customers/payment-method/setup",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_V2_W12_CUSTOMER_AUTH_UI", "COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED"],
}, handler);
