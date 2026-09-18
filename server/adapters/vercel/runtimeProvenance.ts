import {
  normalizeRuntimeDeploymentUrl,
  normalizeRuntimeReleaseSha,
  type RuntimeProvenanceCompatibility,
} from "../../_lib/observability/runtimeProvenance.js";

const HOSTED_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}(?:::[A-Za-z0-9._-]{1,32}){1,3}$/;

export const HOSTED_RUNTIME_MARKER_KEY = "VERCEL";
export const HOSTED_RELEASE_SHA_ENV_KEY = "VERCEL_GIT_COMMIT_SHA";
export const HOSTED_DEPLOYMENT_URL_ENV_KEY = "VERCEL_URL";
export const HOSTED_REQUEST_ID_HEADER = "x-vercel-id";
export const HOSTED_CLIENT_ADDRESS_HEADER = "x-real-ip";
export const HOSTED_CRON_SCHEDULE_HEADER = "x-vercel-cron-schedule";
export const HOSTED_SCHEDULED_TRIGGER_SOURCE = "vercel_cron_scheduled";
export const HOSTED_MANUAL_TRIGGER_SOURCE = "vercel_cron_manual";

type HeaderMap = Record<string, string | string[] | undefined>;

export type HostedRuntimeCompatibilityEnv = Record<string, string | undefined>;

type HostedTriggerSource =
  | typeof HOSTED_MANUAL_TRIGGER_SOURCE
  | typeof HOSTED_SCHEDULED_TRIGGER_SOURCE;

export type HostedCronProvenance = {
  triggerSource: HostedTriggerSource;
  cronSchedule: string | null;
};

/** Maps this named host adapter's runtime inputs into neutral compatibility facts. */
export function readHostedRuntimeCompatibility(
  env: HostedRuntimeCompatibilityEnv = process.env,
): RuntimeProvenanceCompatibility {
  return {
    releaseSha: normalizeRuntimeReleaseSha(env[HOSTED_RELEASE_SHA_ENV_KEY]) ?? undefined,
    deploymentUrl: normalizeRuntimeDeploymentUrl(hostedDeploymentUrl(env[HOSTED_DEPLOYMENT_URL_ENV_KEY])) ?? undefined,
  };
}

/** Returns host provenance only inside the host runtime that owns this adapter. */
export function readHostedRequestId(
  headers: HeaderMap,
  env: HostedRuntimeCompatibilityEnv = process.env,
): string | null {
  if (env[HOSTED_RUNTIME_MARKER_KEY] !== "1") return null;
  const requestId = readHeader(headers, HOSTED_REQUEST_ID_HEADER);
  return requestId && HOSTED_REQUEST_ID.test(requestId) ? requestId : null;
}

/**
 * Reports whether a browser-reported reference is this host's own request ID.
 * Self-gated: outside the host runtime the shape carries no provenance at all.
 */
export function isHostedRequestId(
  value: unknown,
  env: HostedRuntimeCompatibilityEnv = process.env,
): value is string {
  if (env[HOSTED_RUNTIME_MARKER_KEY] !== "1") return false;
  return typeof value === "string" && HOSTED_REQUEST_ID.test(value);
}

/**
 * Returns the platform's own view of the client address, read only inside the
 * host runtime that owns this adapter. The trust assumption — that the platform
 * overwrites this header at its edge — is recorded in the observability runbook.
 */
export function readHostedClientAddress(
  headers: HeaderMap,
  env: HostedRuntimeCompatibilityEnv = process.env,
): string | null {
  if (env[HOSTED_RUNTIME_MARKER_KEY] !== "1") return null;
  return readHeader(headers, HOSTED_CLIENT_ADDRESS_HEADER);
}

/** Converts the named host's schedule header into neutral cron metadata. */
export function readHostedCronProvenance(headers: HeaderMap): HostedCronProvenance {
  const cronSchedule = readHeader(headers, HOSTED_CRON_SCHEDULE_HEADER);
  return {
    cronSchedule,
    triggerSource: cronSchedule ? HOSTED_SCHEDULED_TRIGGER_SOURCE : HOSTED_MANUAL_TRIGGER_SOURCE,
  };
}

function hostedDeploymentUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
}

function readHeader(headers: HeaderMap, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.find((entry) => entry.trim())?.trim() ?? null;
  return null;
}
