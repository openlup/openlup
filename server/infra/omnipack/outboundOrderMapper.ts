import { readProviderActivationConfig } from "../providerReadiness.js";
export {
  buildOmnipackOutboundOrderEvidence,
  buildOmnipackOutboundOrderPayload,
  OmnipackOutboundOrderPayloadError,
  type OmnipackOutboundDeliveryKind,
  type OmnipackOutboundDeliverySelection,
  type OmnipackOutboundOrderInput,
  type OmnipackOutboundOrderPayload,
} from "../../_lib/omnipackOutboundOrderPayload.js";

export const OMNIPACK_STAGE_BASE_URL = "https://api.stage.omnipack.tech";
export const OMNIPACK_PRODUCTION_BASE_URL = "https://api.omnipack.tech";

export const OMNIPACK_REQUIRED_ENV = [
  "OMNIPACK_USERNAME",
  "OMNIPACK_PASSWORD",
  "OMNIPACK_BASE_URL",
  "OMNIPACK_ENV",
  "OMNIPACK_WEBHOOK_TOKEN",
] as const;

export type OmnipackEnvironment = "stage" | "production";
export type OmnipackSalesLimitMode = "off" | "warn" | "block";

export interface OmnipackCredentialGate {
  providerKind: "omnipack";
  requestedEnvironment: OmnipackEnvironment | "unknown";
  baseUrl: string | null;
  dispatchEnabled: boolean;
  stockSyncEnabled: boolean;
  observabilityEnabled: boolean;
  salesLimitMode: OmnipackSalesLimitMode;
  stageSmokeBlocked: boolean;
  liveDispatchBlocked: boolean;
  readiness: ReturnType<typeof readProviderActivationConfig>;
}

export function readOmnipackReadinessConfig(env: Record<string, string | undefined>) {
  const gate = readOmnipackCredentialGate(env);
  return gate.readiness;
}

export function readOmnipackCredentialGate(env: Record<string, string | undefined>): OmnipackCredentialGate {
  const dispatchEnabled =
    env.COMMERCE_OMNIPACK_DISPATCH_ENABLED === "true" &&
    env.OMNIPACK_PROVIDER_ENABLED === "true";
  const stockSyncEnabled =
    env.COMMERCE_OMNIPACK_STOCK_SYNC_ENABLED === "true" &&
    env.OMNIPACK_PROVIDER_ENABLED === "true";
  const requestedEnvironment = readOmnipackEnvironment(env.OMNIPACK_ENV);
  const baseUrl = env.OMNIPACK_BASE_URL ?? defaultOmnipackBaseUrl(requestedEnvironment);
  const readiness = readProviderActivationConfig({
    providerKind: "omnipack",
    enabled: dispatchEnabled || stockSyncEnabled,
    requiredEnv: [...OMNIPACK_REQUIRED_ENV],
    env,
  });
  const missingEnv = missingRequiredEnv(readiness);

  return {
    providerKind: "omnipack",
    requestedEnvironment,
    baseUrl,
    dispatchEnabled,
    stockSyncEnabled,
    observabilityEnabled:
      env.COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED === "true" &&
      env.OMNIPACK_PROVIDER_ENABLED === "true",
    salesLimitMode: readSalesLimitMode(env.COMMERCE_INVENTORY_SALES_LIMIT_MODE),
    stageSmokeBlocked: missingEnv.length > 0 || requestedEnvironment !== "stage",
    liveDispatchBlocked: missingEnv.length > 0 || requestedEnvironment !== "production" || dispatchEnabled !== true,
    readiness,
  };
}

function readOmnipackEnvironment(value: string | undefined): OmnipackEnvironment | "unknown" {
  if (value === "stage" || value === "production") return value;
  return "unknown";
}

function defaultOmnipackBaseUrl(environment: OmnipackEnvironment | "unknown"): string | null {
  if (environment === "stage") return OMNIPACK_STAGE_BASE_URL;
  if (environment === "production") return OMNIPACK_PRODUCTION_BASE_URL;
  return null;
}

function readSalesLimitMode(value: string | undefined): OmnipackSalesLimitMode {
  if (value === "warn" || value === "block") return value;
  return "off";
}

function missingRequiredEnv(readiness: ReturnType<typeof readProviderActivationConfig>): string[] {
  return readiness.requiredEnv.filter((key) => !readiness.presentEnv[key]);
}
