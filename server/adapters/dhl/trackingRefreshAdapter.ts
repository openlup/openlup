import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import { CARRIER_ENV_KEYS } from "../../infra/dhl/adminDhlSoap.js";
import { createTrackingRefreshAction } from "./trackingRefreshAction.js";
import { SCHEDULED_CRON_DRIVER } from "./trackingJobLedger.js";
import { sendStatusEmailInProcess } from "./edgeHandlerRuntimeLoader.js";

export type TrackingRefreshDriver = typeof SCHEDULED_CRON_DRIVER | "manual_admin";

export type TrackingRefreshRequest = {
  authorizationToken?: string | null;
  driver: TrackingRefreshDriver;
  triggerSource: string;
  cronSchedule?: string | null;
};

export type TrackingRefreshResult = {
  status: number;
  body: Record<string, unknown>;
};

export type TrackingRuntimeEnv = Record<string, string | undefined>;

export type TrackingRefreshRunner = (
  request: TrackingRefreshRequest,
  env?: TrackingRuntimeEnv,
  fetchImpl?: typeof fetch,
) => Promise<TrackingRefreshResult>;

export type DhlTrackingRefreshDriver = TrackingRefreshDriver;
export type DhlTrackingRefreshRequest = TrackingRefreshRequest;
export type DhlTrackingRefreshResult = TrackingRefreshResult;
export type DhlTrackingRuntimeEnv = TrackingRuntimeEnv;
export type DhlTrackingRefreshRunner = TrackingRefreshRunner;

type CarrierServiceCredentials = { url: string; serviceRoleKey: string };
type CarrierProviderCredentials = { username: string; password: string };

export const runTrackingRefresh: TrackingRefreshRunner = async (
  request,
  env = process.env,
  fetchImpl = fetch,
) => {
  const service = resolveCarrierService(env);
  if (!service) {
    return { status: 500, body: { error: "supabase_service_role_not_configured" } };
  }
  const credentials = resolveCarrierCredentials(env);
  if (!credentials) {
    return { status: 500, body: { error: "dhl_credentials_not_configured" } };
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    "x-job-driver": request.driver,
  });
  if (request.authorizationToken) {
    headers.set("Authorization", `Bearer ${request.authorizationToken}`);
  }
  const action = createTrackingRefreshAction({
    createClient: () => createServiceRoleClient(service) as never,
    fetchImpl,
    callSendEmailImpl: (testerId, templateSlug, source) =>
      sendStatusEmailInProcess({
        serviceRoleKey: service.serviceRoleKey,
        testerId,
        templateSlug,
        source,
        env,
        fetchImpl,
      }),
    providerUsername: credentials.username,
    providerPassword: credentials.password,
    cronSecret: env.CRON_SECRET ?? "",
  });

  const response = await action(new Request("https://openlup.local/dhl-tracking-refresh", {
    method: "POST",
    headers,
    body: JSON.stringify({
      driver: request.driver,
      trigger_source: request.triggerSource,
      cron_schedule: request.cronSchedule ?? null,
    }),
  }));

  return {
    status: response.status,
    body: await readJsonSafely(response),
  };
};

export const runDhlTrackingRefresh = runTrackingRefresh;

function resolveCarrierService(env: TrackingRuntimeEnv): CarrierServiceCredentials | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && serviceRoleKey ? { url, serviceRoleKey } : null;
}

function resolveCarrierCredentials(env: TrackingRuntimeEnv): CarrierProviderCredentials | null {
  const username = env[CARRIER_ENV_KEYS.username];
  const password = env[CARRIER_ENV_KEYS.password];
  return username && password ? { username, password } : null;
}

async function readJsonSafely(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { raw: text.slice(0, 500) };
  }
}
