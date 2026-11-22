import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import {
  isCanonicalTpayProductionCallbackUrl,
  isTpayProductionOpenApiBaseUrl,
  isTpaySandboxOpenApiBaseUrl,
} from "../../infra/tpay/tpayEnvironment.js";
import { createTpaySimulatorClient } from "../../infra/tpay/tpaySimulatorClient.js";
import { toCorePaymentProviderCapability } from "@openlup/platform/payments";
import {
  createTpayHttpClient,
  createTpayPaymentExecutionAdapter,
  tpayPaymentCapabilities,
} from "@openlup/platform/payments/tpay";
import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";

/** Package protocol facts plus this host's existing repair and payer fallback policy. */
export const unattendedChargeCapability: PaymentProviderCapabilityDescriptor = toCorePaymentProviderCapability(
  tpayPaymentCapabilities,
  {
    captureFlows: [{ kind: "scheme_alias_registration", handoff: "payer_supplied_code" }],
    payerContext: { ...tpayPaymentCapabilities.payerContext, customerRefFallsBackToContactEmail: true },
  },
);

export interface TpayAdapterPresentationOptions {
  simulatorSuccessPath?: string;
  accountReturnPath?: string;
  accountSubjectQueryParam?: string;
  fallbackPayerName?: string;
}

interface ResolvedTpayPresentationOptions {
  simulatorSuccessPath: string;
  accountReturnPath: string;
  accountSubjectQueryParam: string;
  fallbackPayerName: string;
}

const DEFAULT_TPAY_PRESENTATION: ResolvedTpayPresentationOptions = {
  simulatorSuccessPath: "/checkout/payment",
  accountReturnPath: "/account/order/status",
  accountSubjectQueryParam: "subject",
  fallbackPayerName: "Customer",
};

function resolvePresentationOptions(
  env: Record<string, string | undefined>,
  options?: TpayAdapterPresentationOptions,
): ResolvedTpayPresentationOptions {
  return {
    simulatorSuccessPath: options?.simulatorSuccessPath?.trim()
      || env.TPAY_SIMULATOR_SUCCESS_PATH?.trim()
      || DEFAULT_TPAY_PRESENTATION.simulatorSuccessPath,
    accountReturnPath: options?.accountReturnPath?.trim()
      || env.TPAY_ACCOUNT_RETURN_PATH?.trim()
      || DEFAULT_TPAY_PRESENTATION.accountReturnPath,
    accountSubjectQueryParam: options?.accountSubjectQueryParam?.trim()
      || env.TPAY_ACCOUNT_SUBJECT_QUERY_PARAM?.trim()
      || DEFAULT_TPAY_PRESENTATION.accountSubjectQueryParam,
    fallbackPayerName: options?.fallbackPayerName?.trim()
      || env.TPAY_FALLBACK_PAYER_NAME?.trim()
      || DEFAULT_TPAY_PRESENTATION.fallbackPayerName,
  };
}

export interface TpayAdapterFactoryResult {
  adapter: PaymentExecutionPort;
  mode: "sandbox" | "simulator" | "verified_test" | "production";
}

export function buildTpayAdapterIfEnabled(
  env: Record<string, string | undefined>,
  presentation?: TpayAdapterPresentationOptions,
): TpayAdapterFactoryResult | null {
  if (env.PAYMENTS_TPAY_ENABLED !== "true") return null;
  const resolvedPresentation = resolvePresentationOptions(env, presentation);
  const sandboxEnabled = env.PAYMENTS_TPAY_SANDBOX_ENABLED === "true";
  const simulatorEnabled = env.PAYMENTS_TPAY_SIMULATOR_ENABLED === "true";
  const verifiedTestEnabled = env.PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED === "true";
  const productionEnabled = env.PAYMENTS_TPAY_PRODUCTION_ENABLED === "true";
  const modelOActivationEnabled = env.VITE_PAYMENTS_TPAY_BLIK_MODEL_O_ENABLED === "true";
  const oneClickEnabled = env.PAYMENTS_TPAY_BLIK_ONE_CLICK_ENABLED === "true";
  const aliasRegistrationOnCodeEnabled = env.PAYMENTS_TPAY_BLIK_ALIAS_REGISTRATION_ON_CODE_ENABLED === "true";
  const enabledModeCount = [sandboxEnabled, simulatorEnabled, verifiedTestEnabled, productionEnabled]
    .filter(Boolean).length;
  if (enabledModeCount !== 1) return null;
  if (simulatorEnabled) {
    const urls = readSimulatorUrls(env, resolvedPresentation.simulatorSuccessPath);
    if (!urls) return null;
    return {
      mode: "simulator",
      adapter: createReferenceTpayAdapter({
        client: createTpaySimulatorClient(),
        notificationUrl: urls.notificationUrl,
        successUrl: urls.successUrl,
        errorUrl: urls.errorUrl,
        oneClickEnabled,
        aliasRegistrationOnCodeEnabled,
        modelOActivationEnabled,
      }, resolvedPresentation),
    };
  }

  const notificationUrl = env.TPAY_NOTIFICATION_URL;
  const successUrl = env.TPAY_SUCCESS_URL;
  const errorUrl = env.TPAY_ERROR_URL;
  const baseUrl = env.TPAY_API_BASE_URL;
  const clientId = env.TPAY_CLIENT_ID;
  const clientSecret = env.TPAY_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret || !notificationUrl || !successUrl || !errorUrl) {
    return null;
  }
  if (sandboxEnabled && !isTpaySandboxOpenApiBaseUrl(baseUrl)) return null;
  if (verifiedTestEnabled) {
    if (env.TPAY_VERIFIED_TEST_MODE_CONFIRMED !== "true") return null;
    if (!isTpayProductionOpenApiBaseUrl(baseUrl)) return null;
  }
  if (productionEnabled) {
    // Live-settlement mode. Fail closed unless the operator has explicitly
    // confirmed production, the client points at the production Open API host,
    // and every callback URL is a direct canonical-host HTTPS URL (a redirect
    // would drop Tpay's POSTed JWS notification body). The staging/preview
    // posture guards (findLiveProviderEnv, guard-production-rollout-build) block
    // this mode outside confirmed production.
    if (env.TPAY_PRODUCTION_CONFIRMED !== "true") return null;
    if (!isTpayProductionOpenApiBaseUrl(baseUrl)) return null;
    if (![notificationUrl, successUrl, errorUrl].every((value) => isCanonicalTpayProductionCallbackUrl(value))) {
      return null;
    }
  }

  return {
    mode: productionEnabled ? "production" : verifiedTestEnabled ? "verified_test" : "sandbox",
    adapter: createReferenceTpayAdapter({
      client: createTpayHttpClient({ baseUrl, clientId, clientSecret }),
      notificationUrl,
      successUrl,
      errorUrl,
      oneClickEnabled,
      aliasRegistrationOnCodeEnabled,
      modelOActivationEnabled,
    }, resolvedPresentation),
  };
}

function readSimulatorUrls(
  env: Record<string, string | undefined>,
  simulatorSuccessPath: string,
): {
  notificationUrl: string;
  successUrl: string;
  errorUrl: string;
} | null {
  const origin = previewOrigin(env);
  const successUrl = env.TPAY_SUCCESS_URL ?? (origin ? `${origin}${simulatorSuccessPath}` : null);
  const errorUrl = env.TPAY_ERROR_URL ?? successUrl;
  const notificationUrl = env.TPAY_NOTIFICATION_URL ?? (origin ? `${origin}/api/bff/payment/webhooks/tpay-simulator` : null);
  return successUrl && errorUrl && notificationUrl ? { successUrl, errorUrl, notificationUrl } : null;
}

function previewOrigin(env: Record<string, string | undefined>): string | null {
  // Neutral self-host origin (node-* bundles) wins over the configured customer-facing
  // origin, which in turn wins over the Vercel-injected fallback: VERCEL_URL is the raw
  // per-deployment preview hostname (e.g. openlup-hidden-preview-<hash>-....vercel.app),
  // never the canonical domain a customer's browser is actually on, so it must be the
  // last resort rather than shadow an explicitly configured origin.
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/+$/, "");
  if (env.CUSTOMER_AUTH_REDIRECT_ORIGIN) return env.CUSTOMER_AUTH_REDIRECT_ORIGIN.replace(/\/+$/, "");
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL.replace(/^https?:\/\//, "")}`;
  return null;
}

/** Keep host presentation outside the contributed protocol implementation. */
function createReferenceTpayAdapter(
  options: Parameters<typeof createTpayPaymentExecutionAdapter>[0],
  presentation: ResolvedTpayPresentationOptions,
): PaymentExecutionPort {
  const resolvePayer: Parameters<typeof createTpayPaymentExecutionAdapter>[0]["resolvePayer"] = (input) =>
    input.payer ?? (input.customerRef ? { email: input.customerRef, name: presentation.fallbackPayerName } : null);
  const baseAdapter = createTpayPaymentExecutionAdapter({ ...options, resolvePayer });
  const bindAccount = (input: Parameters<PaymentExecutionPort["execute"]>[0]) => createTpayPaymentExecutionAdapter({
    ...options,
    resolvePayer,
    client: {
      ...options.client,
      createTransaction: transaction => options.client.createTransaction({
        ...transaction,
        successUrl: referenceReturnUrl(transaction.successUrl, options.successUrl, input, presentation),
        errorUrl: referenceReturnUrl(transaction.errorUrl, options.errorUrl, input, presentation),
        simulatorContext: transaction.simulatorContext
          ? { ...transaction.simulatorContext, returnPath: input.returnPath ?? presentation.accountReturnPath } : transaction.simulatorContext,
      }),
    },
  });
  return {
    validateInput: input => baseAdapter.validateInput?.({ ...input, subjectId: input.subjectId }),
    async execute(input) {
      const adapter = input.returnContext === "account" ? bindAccount(input) : baseAdapter;
      return await adapter.execute({ ...input, subjectId: input.subjectId }) as Awaited<ReturnType<PaymentExecutionPort["execute"]>>;
    },
  };
}

function referenceReturnUrl(
  value: string,
  baseUrl: string,
  input: Parameters<PaymentExecutionPort["execute"]>[0],
  presentation: ResolvedTpayPresentationOptions,
): string {
  if (input.returnContext !== "account") return value;
  const url = new URL(value);
  url.pathname = input.returnPath ?? presentation.accountReturnPath;
  // Preserve the host's original query and insertion order, including any
  // pre-existing subject/order keys; only the host owns localized subject scope.
  url.search = new URL(baseUrl).search;
  if (input.orderId) url.searchParams.set("orderId", input.orderId);
  url.searchParams.set("paymentIntentId", input.paymentIntentId);
  if (input.clientId) url.searchParams.set("clientId", input.clientId);
  if (input.subjectId) url.searchParams.set(presentation.accountSubjectQueryParam, input.subjectId);
  url.searchParams.set("order", input.orderRef);
  return url.toString();
}
