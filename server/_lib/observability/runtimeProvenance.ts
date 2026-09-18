export type RuntimeProvenance = {
  releaseSha: string | null;
  deploymentUrl: string | null;
};

export type RuntimeProvenanceInput = {
  appReleaseSha?: string;
  appDeploymentUrl?: string;
  compatibilityReleaseSha?: string;
  compatibilityDeploymentUrl?: string;
  ssgBuildSha?: string;
  githubSha?: string;
};

export type RuntimeProvenanceEnv = {
  APP_RELEASE_SHA?: string;
  APP_DEPLOYMENT_URL?: string;
  GITHUB_SHA?: string;
  SSG_BUILD_SHA?: string;
};

export type RuntimeProvenanceCompatibility = {
  releaseSha?: string;
  deploymentUrl?: string;
};

/** Canonical neutral env names, exported so host composition roots do not duplicate them. */
export const APPLICATION_RELEASE_SHA_KEY = "APP_RELEASE_SHA";
export const APPLICATION_DEPLOYMENT_URL_KEY = "APP_DEPLOYMENT_URL";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Normalizes provider-neutral release facts. Provider adapters supply their
 * compatibility values, keeping vendor environment parsing outside this seam.
 */
export function resolveRuntimeProvenance(input: RuntimeProvenanceInput): RuntimeProvenance {
  return {
    releaseSha: resolveIdentifier(
      input.appReleaseSha,
      [input.compatibilityReleaseSha, input.ssgBuildSha, input.githubSha],
    ),
    deploymentUrl: resolveDeploymentUrl(
      input.appDeploymentUrl,
      input.compatibilityDeploymentUrl,
    ),
  };
}

/** Reads neutral runtime inputs and accepts an adapter's optional compatibility facts. */
export function readRuntimeProvenance(
  env: RuntimeProvenanceEnv = process.env,
  compatibility: RuntimeProvenanceCompatibility = {},
): RuntimeProvenance {
  return resolveRuntimeProvenance({
    appReleaseSha: env[APPLICATION_RELEASE_SHA_KEY],
    appDeploymentUrl: env[APPLICATION_DEPLOYMENT_URL_KEY],
    compatibilityReleaseSha: compatibility.releaseSha,
    compatibilityDeploymentUrl: compatibility.deploymentUrl,
    ssgBuildSha: env.SSG_BUILD_SHA,
    githubSha: env.GITHUB_SHA,
  });
}

function resolveIdentifier(primary: string | undefined, fallbacks: Array<string | undefined>): string | null {
  const explicit = normalizeExplicit(primary, normalizeRuntimeReleaseSha);
  if (explicit !== undefined) return explicit;

  for (const fallback of fallbacks) {
    const normalized = normalizeRuntimeReleaseSha(fallback);
    if (normalized) return normalized;
  }
  return null;
}

function resolveDeploymentUrl(primary: string | undefined, fallback: string | undefined): string | null {
  const explicit = normalizeExplicit(primary, normalizeRuntimeDeploymentUrl);
  if (explicit !== undefined) return explicit;
  return normalizeRuntimeDeploymentUrl(fallback);
}

/** `undefined` means unset/blank; `null` means a non-blank explicit refusal. */
function normalizeExplicit(
  value: string | undefined,
  normalize: (candidate: string | undefined) => string | null,
): string | null | undefined {
  if (!value?.trim()) return undefined;
  return normalize(value);
}

/** Normalizes a release identifier for a provider-neutral provenance record. */
export function normalizeRuntimeReleaseSha(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && SAFE_IDENTIFIER.test(normalized) ? normalized : null;
}

/** Normalizes a credential-free HTTP(S) deployment URL to its origin. */
export function normalizeRuntimeDeploymentUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
