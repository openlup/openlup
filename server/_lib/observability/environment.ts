export type ObservedEnvironment =
  | "development"
  | "preview"
  | "production"
  | "staging"
  | "unknown";

/**
 * The three environment keys this seam translates. They are exported because the
 * key names are part of the seam's contract: anything that has to *set* them
 * (composition roots, harnesses, tests) should read them from here instead of
 * duplicating a vendor- or brand-spelled literal of its own.
 */
export const APPLICATION_ENVIRONMENT_KEY = "APP_ENVIRONMENT";
export const LEGACY_APPLICATION_ENVIRONMENT_KEY = "openlup_ENVIRONMENT";
export const HOST_ENVIRONMENT_KEY = "VERCEL_ENV";
export const readHiddenPreviewEnabled = (env: Record<string, string | undefined>) => env.HIDDEN_SANDBOX_PREVIEW_ENABLED === "true";

const OBSERVED_ENVIRONMENTS = new Set<ObservedEnvironment>([
  "development",
  "preview",
  "production",
  "staging",
]);

function normalizeMarker(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function readNormalizedEnvironmentMarkers(env: Record<string, string | undefined>) {
  return {
    neutralApplication: normalizeMarker(env[APPLICATION_ENVIRONMENT_KEY]),
    application: normalizeMarker(env[LEGACY_APPLICATION_ENVIRONMENT_KEY]),
    host: normalizeMarker(env[HOST_ENVIRONMENT_KEY]),
  };
}

export function readObservedEnvironment(
  env: Record<string, string | undefined>,
): ObservedEnvironment {
  const { neutralApplication, application, host: vercel } = readNormalizedEnvironmentMarkers(env);
  if (neutralApplication !== undefined) {
    return OBSERVED_ENVIRONMENTS.has(neutralApplication as ObservedEnvironment)
      ? neutralApplication as ObservedEnvironment
      : "unknown";
  }
  if (application === "production" || application === "staging") return application;
  if (vercel === "production" || vercel === "preview" || vercel === "development") return vercel;
  return "unknown";
}

/**
 * True only for a non-empty neutral marker whose value is outside the public
 * contract. Callers that can produce an external side effect use this to keep
 * an operator typo from falling through to a permissive legacy default.
 */
export function invalidApplicationEnvironmentMarkerPresent(
  env: Record<string, string | undefined>,
): boolean {
  const { neutralApplication } = readNormalizedEnvironmentMarkers(env);
  return neutralApplication !== undefined &&
    !OBSERVED_ENVIRONMENTS.has(neutralApplication as ObservedEnvironment);
}

/**
 * True when any neutral, compatibility, or host marker names
 * production. Production always wins: classification precedence and an
 * explicit local or test capability marker never downgrade a runtime that
 * declares itself production.
 */
export function productionEnvironmentMarkerPresent(
  env: Record<string, string | undefined>,
): boolean {
  const { neutralApplication, application, host } = readNormalizedEnvironmentMarkers(env);
  return neutralApplication === "production" ||
    application === "production" ||
    host === "production";
}

/**
 * True when this deployment declares itself production AND its operator has
 * baked the explicit rollout confirmation. Two keys, both deliberate: the first
 * says WHAT this runtime is, the second says the operator meant to run real
 * customer traffic on it. Silence in either fails closed.
 *
 * The production half is `productionEnvironmentMarkerPresent`, so an adopter's
 * own application marker counts exactly as much as a hosting provider's. That
 * is the whole difference from the inline test this replaced: the confirmation
 * semantics are unchanged, only the question "who is allowed to say
 * production" is answered by the seam instead of by one vendor's key.
 */
export function productionRolloutConfirmed(
  env: Record<string, string | undefined>,
): boolean {
  return productionEnvironmentMarkerPresent(env) && env.PRODUCTION_ROLLOUT_CONFIRMED === "true";
}

/**
 * True when nothing in the environment says what this runtime is: no recognized
 * application or hosting marker, and no explicit local/test capability marker.
 * Safety decisions must fail closed here, because a misconfigured self-hosted
 * deployment is indistinguishable from an unconfigured developer machine.
 */
export function unlabelledEnvironment(env: Record<string, string | undefined>): boolean {
  return readObservedEnvironment(env) === "unknown" &&
    !productionEnvironmentMarkerPresent(env) &&
    !explicitLocalRuntime(env);
}

/**
 * True when the runtime must be treated as a deployment rather than a developer
 * machine. An explicit hosting marker says so directly, and a production marker
 * wins over any local/test marker; otherwise silence is read as "deployed", so a
 * loopback origin is refused instead of being handed to a remote recipient. Only
 * an explicit local/test marker on a non-production runtime opts out.
 */
export function deployedRuntimeAssumed(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL || env.VERCEL_URL) return true;
  if (productionEnvironmentMarkerPresent(env)) return true;
  return !explicitLocalRuntime(env);
}

function explicitLocalRuntime(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "test" || env.LOCAL_BFF === "1";
}

/**
 * Decides whether a no-op payment adapter may settle an order without a real
 * provider charge. Unknown hosted environments fail closed. Local execution is
 * allowed only through an explicit development capability marker, and an
 * application or hosting production marker always wins over those markers.
 */
export function noopSettlementAllowed(env: Record<string, string | undefined>): boolean {
  if (productionEnvironmentMarkerPresent(env)) return false;
  return !unlabelledEnvironment(env);
}
