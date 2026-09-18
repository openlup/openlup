import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import { createTpayHttpClient } from "../../infra/tpay/tpayHttpClient.js";
import {
  isCanonicalTpayProductionCallbackUrl,
  isTpayProductionOpenApiBaseUrl,
  isTpaySandboxOpenApiBaseUrl,
} from "../../infra/tpay/tpayEnvironment.js";
import { createTpaySimulatorClient } from "../../infra/tpay/tpaySimulatorClient.js";
import {
  createTpayPaymentExecutionAdapter,
  PROVIDER_KIND,
} from "./tpayPaymentExecutionAdapter.js";
import type { PaymentProviderCapabilityDescriptor } from "@openlup/core/payment";

/**
 * What renewal orchestration may do with a stored method of this provider,
 * stated as capabilities rather than as an identity to compare against.
 *
 * Every value here restates behaviour this provider ALREADY has on the
 * off-session renewal path; nothing reads this descriptor yet.
 */
export const unattendedChargeCapability: PaymentProviderCapabilityDescriptor = {
  providerKind: PROVIDER_KIND,
  // The mandate model is local DB evidence, read before a durable provider
  // attempt exists so a consent that cannot be charged unattended enters
  // customer repair instead of being mislabelled an indeterminate charge.
  requiresStoredMandateEvidence: true,
  // Only a model O mandate permits a variable amount without the payer
  // confirming each charge. Absent or unknown is NOT model O: fail closed.
  assessMandate: (snapshot) => snapshot.recurringModel === "O"
    ? { chargeable: true }
    : { chargeable: false, blockReason: "mandate_model_unsupported_for_unattended_charge" },
  // Re-registering this rail's alias needs the payer to type a short-lived
  // authorisation code. Declared because the rail can do it, not because any
  // client drives it today: the repair surface offers only handoffs it
  // implements, so this one is filtered rather than rendered.
  captureFlows: [{ kind: "scheme_alias_registration", handoff: "payer_supplied_code" }],
  unattendedChargeFlow: "recurring_charge",
  payerContext: { requiresPayerBlock: true, customerRefFallsBackToContactEmail: true },
  methodHealth: {
    requiresCustomerRef: false,
    requiredMethodKind: "blik_payid",
    requiresPayerContact: true,
  },
  mandateUpsertIsSubscriptionScoped: true,
  // Measured, not assumed: a refused charge on this rail leaves the readback's
  // own status non-terminal and reports the refusal per attempt, which is how a
  // production renewal polled as pending for 33h on 2026-08-12 with the reason
  // available the whole time. Six hours is a deliberately quiet first value for
  // a rail whose unattended charges normally settle in seconds; it is a
  // suspicion threshold for a human, never grounds to terminalize.
  terminalOutcomeReporting: { kind: "attempt_records", silenceBecomesSuspectAfterMinutes: 360 },
};

export interface TpayAdapterFactoryResult {
  adapter: PaymentExecutionPort;
  mode: "sandbox" | "simulator" | "verified_test" | "production";
}

export function buildTpayAdapterIfEnabled(
  env: Record<string, string | undefined>,
): TpayAdapterFactoryResult | null {
  if (env.PAYMENTS_TPAY_ENABLED !== "true") return null;
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
    const urls = readSimulatorUrls(env);
    if (!urls) return null;
    return {
      mode: "simulator",
      adapter: createTpayPaymentExecutionAdapter({
        client: createTpaySimulatorClient(),
        notificationUrl: urls.notificationUrl,
        successUrl: urls.successUrl,
        errorUrl: urls.errorUrl,
        oneClickEnabled,
        aliasRegistrationOnCodeEnabled,
        modelOActivationEnabled,
      }),
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
    if (![notificationUrl, successUrl, errorUrl].every(isCanonicalTpayProductionCallbackUrl)) {
      return null;
    }
  }

  return {
    mode: productionEnabled ? "production" : verifiedTestEnabled ? "verified_test" : "sandbox",
    adapter: createTpayPaymentExecutionAdapter({
      client: createTpayHttpClient({ baseUrl, clientId, clientSecret }),
      notificationUrl,
      successUrl,
      errorUrl,
      oneClickEnabled,
      aliasRegistrationOnCodeEnabled,
      modelOActivationEnabled,
    }),
  };
}

function readSimulatorUrls(env: Record<string, string | undefined>): {
  notificationUrl: string;
  successUrl: string;
  errorUrl: string;
} | null {
  const origin = previewOrigin(env);
  const successUrl = env.TPAY_SUCCESS_URL ?? (origin ? `${origin}/skomponuj-pakiet/platnosc` : null);
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
