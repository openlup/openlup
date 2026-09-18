import { withObservedRoute } from "../../_lib/observability/route.js";
import {
  providerPaymentsEnabled,
  tpayEnabled,
  tpayProductionModeEnabled,
  tpaySandboxEnabled,
  tpaySimulatorEnabled,
  tpayVerifiedTestModeEnabled,
} from "../../_lib/config/featureFlags.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { createTpayChannelsHandler } from "../../domains/commerce/tpayChannelsHandler.js";
import { createTpayHttpClient } from "../../infra/tpay/tpayHttpClient.js";
import {
  isTpayProductionOpenApiBaseUrl,
  isTpaySandboxOpenApiBaseUrl,
} from "../../infra/tpay/tpayEnvironment.js";
import { createTpaySimulatorClient } from "../../infra/tpay/tpaySimulatorClient.js";

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!tpayChannelsEnabled()) {
    return createTpayChannelsHandler({
      channelsPort: { async listPaymentChannels() { return []; } },
      enabled: tpayChannelsEnabled,
    })(req, res);
  }

  if (tpaySimulatorEnabled()) {
    return createTpayChannelsHandler({
      channelsPort: createTpaySimulatorClient(),
      enabled: tpayChannelsEnabled,
    })(req, res);
  }

  const env = readTpayEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Tpay payment channels are not configured", {
      details: {
        feature: "tpay-channels",
        requiredEnv: "TPAY_API_BASE_URL,TPAY_CLIENT_ID,TPAY_CLIENT_SECRET",
      },
    });
    return Promise.resolve();
  }
  return createTpayChannelsHandler({
    channelsPort: createTpayHttpClient(env),
    enabled: tpayChannelsEnabled,
  })(req, res);
}

function tpayChannelsEnabled(): boolean {
  return providerPaymentsEnabled()
    && tpayEnabled()
    && readTpayChannelsMode() !== null;
}

function readTpayEnv(): { baseUrl: string; clientId: string; clientSecret: string } | null {
  const baseUrl = process.env.TPAY_API_BASE_URL;
  const clientId = process.env.TPAY_CLIENT_ID;
  const clientSecret = process.env.TPAY_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret) return null;
  const mode = readTpayChannelsMode();
  if (mode === "sandbox" && !isTpaySandboxOpenApiBaseUrl(baseUrl)) return null;
  if (mode === "verified_test") {
    if (process.env.TPAY_VERIFIED_TEST_MODE_CONFIRMED !== "true") return null;
    if (!isTpayProductionOpenApiBaseUrl(baseUrl)) return null;
  }
  if (mode === "production") {
    if (process.env.TPAY_PRODUCTION_CONFIRMED !== "true") return null;
    if (!isTpayProductionOpenApiBaseUrl(baseUrl)) return null;
  }
  return { baseUrl, clientId, clientSecret };
}

function readTpayChannelsMode(): "sandbox" | "simulator" | "verified_test" | "production" | null {
  const sandboxEnabled = tpaySandboxEnabled();
  const simulatorEnabled = tpaySimulatorEnabled();
  const verifiedTestEnabled = tpayVerifiedTestModeEnabled();
  const productionEnabled = tpayProductionModeEnabled();
  if ([sandboxEnabled, simulatorEnabled, verifiedTestEnabled, productionEnabled].filter(Boolean).length !== 1) {
    return null;
  }
  if (simulatorEnabled) return "simulator";
  if (productionEnabled) return "production";
  return verifiedTestEnabled ? "verified_test" : "sandbox";
}

export default withObservedRoute({
  route: "/api/bff/commerce/tpay-channels",
  domain: "commerce",
  surface: "hidden",
  risk: "read",
  featureFlags: [
    "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
    "PAYMENTS_TPAY_ENABLED",
    "PAYMENTS_TPAY_SANDBOX_ENABLED",
    "PAYMENTS_TPAY_SIMULATOR_ENABLED",
    "PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED",
    "PAYMENTS_TPAY_PRODUCTION_ENABLED",
  ],
}, handler);
