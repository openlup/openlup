import {
  createStripePaymentReconciliationProvider,
  type StripePaymentIntentReader,
} from "../adapters/stripe/stripePaymentReconciliationProvider.js";
import { createTpayPaymentReconciliationProvider } from "../adapters/tpay/tpayPaymentReconciliationProvider.js";
import type {
  PaymentProviderReconciliationProvider,
  ReconciliationProviderKind,
} from "../domains/payment/paymentProviderReconciliationWorker.js";
import type {
  PaymentProviderRecoveryProvider,
} from "../domains/payment/checkoutRecoveryPaymentResolver.js";
import type { StripePayoutSettlementReader } from "../domains/accounting/stripePayoutSettlementSync.js";
import { createStripeApiClient } from "../infra/stripe/stripeApiClient.js";
import {
  isCanonicalTpayProductionCallbackUrl,
  isTpayProductionOpenApiBaseUrl,
  isTpaySandboxOpenApiBaseUrl,
} from "../infra/tpay/tpayEnvironment.js";
import { createTpayHttpClient } from "../infra/tpay/tpayHttpClient.js";
import { createTpaySimulatorClient } from "../infra/tpay/tpaySimulatorClient.js";
import { assertStripeKeyMode } from "../infra/providerReadiness.js";

export type PaymentProviderReadbackRegistry<
  Provider extends PaymentProviderReconciliationProvider = PaymentProviderReconciliationProvider,
> = Partial<
  Record<ReconciliationProviderKind, Provider>
>;

export function createPaymentProviderReadbackRegistry(
  env: Record<string, string | undefined>,
): PaymentProviderReadbackRegistry<PaymentProviderRecoveryProvider> {
  const providers: PaymentProviderReadbackRegistry<PaymentProviderRecoveryProvider> = {};
  const stripe = createStripeProvider(env);
  if (stripe) providers.stripe = stripe;
  const tpay = createTpayProvider(env);
  if (tpay) providers.tpay = tpay;
  return providers;
}

/**
 * Accounting may block fiscal issuance on a confirmed provider mismatch, so a
 * local simulator is never authoritative evidence. Payment reconciliation can
 * still use the simulator in its own non-fiscal workflow.
 */
export function createAccountingPaymentProviderReadbackRegistry(
  env: Record<string, string | undefined>,
): PaymentProviderReadbackRegistry {
  const providers = createPaymentProviderReadbackRegistry(env);
  if (env.PAYMENTS_TPAY_SIMULATOR_ENABLED === "true") delete providers.tpay;
  return providers;
}

export function createStripePayoutSettlementReader(
  env: Record<string, string | undefined>,
): StripePayoutSettlementReader | null {
  if (env.STRIPE_PROVIDER_ENABLED !== "true" || !env.STRIPE_SECRET_KEY) return null;
  assertStripeKeyMode(env.STRIPE_SECRET_KEY, env);
  return createStripeApiClient({ secretKey: env.STRIPE_SECRET_KEY });
}

function createStripeProvider(
  env: Record<string, string | undefined>,
): PaymentProviderRecoveryProvider | null {
  if (env.STRIPE_PROVIDER_ENABLED !== "true" || !env.STRIPE_SECRET_KEY) return null;
  assertStripeKeyMode(env.STRIPE_SECRET_KEY, env);
  return createStripePaymentReconciliationProvider(
    createStripeApiClient({ secretKey: env.STRIPE_SECRET_KEY }) as StripePaymentIntentReader,
  );
}

function createTpayProvider(
  env: Record<string, string | undefined>,
): PaymentProviderRecoveryProvider | null {
  if (env.PAYMENTS_TPAY_ENABLED !== "true") return null;
  const sandboxEnabled = env.PAYMENTS_TPAY_SANDBOX_ENABLED === "true";
  const simulatorEnabled = env.PAYMENTS_TPAY_SIMULATOR_ENABLED === "true";
  const verifiedTestEnabled = env.PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED === "true";
  const productionEnabled = env.PAYMENTS_TPAY_PRODUCTION_ENABLED === "true";
  if ([sandboxEnabled, simulatorEnabled, verifiedTestEnabled, productionEnabled].filter(Boolean).length !== 1) return null;
  if (simulatorEnabled) return createTpayPaymentReconciliationProvider(createTpaySimulatorClient());

  const baseUrl = env.TPAY_API_BASE_URL;
  const clientId = env.TPAY_CLIENT_ID;
  const clientSecret = env.TPAY_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret) return null;
  if (sandboxEnabled && !isTpaySandboxOpenApiBaseUrl(baseUrl)) return null;
  if (verifiedTestEnabled) {
    if (env.TPAY_VERIFIED_TEST_MODE_CONFIRMED !== "true") return null;
    if (!isTpayProductionOpenApiBaseUrl(baseUrl)) return null;
  }
  if (productionEnabled) {
    if (env.TPAY_PRODUCTION_CONFIRMED !== "true") return null;
    if (!isTpayProductionOpenApiBaseUrl(baseUrl)) return null;
    const callbackUrls = [env.TPAY_NOTIFICATION_URL, env.TPAY_SUCCESS_URL, env.TPAY_ERROR_URL];
    if (!callbackUrls.every((value) => value && isCanonicalTpayProductionCallbackUrl(value))) return null;
  }
  return createTpayPaymentReconciliationProvider(createTpayHttpClient({ baseUrl, clientId, clientSecret }));
}
