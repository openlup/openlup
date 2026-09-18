import { withObservedRoute } from "../../../_lib/observability/route.js";
import { customerAuthUiEnabled, pspRecoveryEnabled, subscriptionMutationsEnabled } from "../../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import {
  createPaymentRecoverySetupHandler,
  type StripeSetupIntentCallback,
} from "../../../domains/payment/paymentRecoverySetupHandler.js";
import {
  createSupabaseSubscriptionRecoveryPort,
  type PaymentRecoverySupabaseClient,
} from "../../../adapters/supabase/subscription/subscriptionRecovery.js";
import { createDunningCaseDisplayFactsPort } from "../../../adapters/dunningFailureClassPort.js";
import { buildStripeApiClientIfEnabled } from "../../../infra/stripe/buildStripeApiClientIfEnabled.js";
import {
  authenticateCustomerUser,
  createCustomerClients,
  readBearerToken,
  readCustomerSelfServiceEnv,
} from "../shared.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!paymentRecoveryEnabled()) {
    return createPaymentRecoverySetupHandler({
      enabled: paymentRecoveryEnabled,
      authenticateCustomer: async () => ({ ok: false }),
      recoveryPort: emptyPort(),
      createSetupIntent: emptyCreateSetupIntent,
      ensureCustomer: emptyEnsureCustomer,
    })(req, res);
  }

  const env = readCustomerSelfServiceEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Payment recovery is not configured", {
      details: { feature: "payment-recovery", requiredEnv: "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY" },
    });
    return;
  }

  const stripeClient = buildStripeApiClientIfEnabled(process.env);
  if (!stripeClient) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Stripe is not configured for recovery", {
      details: { feature: "payment-recovery", requiredEnv: "STRIPE_PROVIDER_ENABLED+STRIPE_SECRET_KEY" },
    });
    return;
  }

  const accessToken = readBearerToken(req);
  const clients = createCustomerClients(env, accessToken);

  const createSetupIntent: StripeSetupIntentCallback = async ({ customer, metadata, idempotencyKey }) => {
    const intent = await stripeClient.createSetupIntent(
      { customer, usage: "off_session", metadata },
      { idempotencyKey },
    );
    if (!intent.client_secret) {
      throw new Error("Stripe SetupIntent missing client_secret");
    }
    return {
      setupIntentId: intent.id,
      clientSecret: intent.client_secret,
      replayed: false,
    };
  };

  return createPaymentRecoverySetupHandler({
    enabled: paymentRecoveryEnabled,
    authenticateCustomer: () => authenticateCustomerUser(clients.customerClient, accessToken),
    recoveryPort: createSupabaseSubscriptionRecoveryPort(clients.serviceClient as unknown as PaymentRecoverySupabaseClient),
    caseDisplayFacts: createDunningCaseDisplayFactsPort(clients.serviceClient as never),
    createSetupIntent,
    ensureCustomer: ({ clientId, metadata, idempotencyKey }) => {
      if (!stripeClient.ensureCustomer) throw new Error("Stripe ensureCustomer unavailable");
      return stripeClient.ensureCustomer({ clientId, metadata }, { idempotencyKey });
    },
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
    async resolveRecoveryCaseSubscription() {
      throw new Error("Payment recovery port unavailable");
    },
  };
}

const emptyCreateSetupIntent: StripeSetupIntentCallback = async () => {
  throw new Error("Stripe SetupIntent callback unavailable");
};

const emptyEnsureCustomer = async (): Promise<string> => {
  throw new Error("Stripe ensureCustomer unavailable");
};

export default withObservedRoute({
  route: "/api/bff/customers/payment-recovery/setup-method",
  domain: "customers",
  surface: "customer",
  risk: "mutation",
  featureFlags: ["COMMERCE_PSP_RECOVERY_ENABLED","COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED","COMMERCE_V2_W12_CUSTOMER_AUTH_UI"],
}, handler);
