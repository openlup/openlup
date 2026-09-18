import { withObservedRoute } from "../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../_lib/bff/response.js";
import {
  BFF_DOMAINS,
  bffHealthDataSchema,
} from "../../src/lib/bff/health.js";
import { emailPresentation } from "../../src/domains/communications/email/deploymentEmailPresentation.js";
import {
  readRuntimeProvenance,
  type RuntimeProvenanceEnv,
} from "../_lib/observability/runtimeProvenance.js";
import {
  readHostedRuntimeCompatibility,
  type HostedRuntimeCompatibilityEnv,
} from "../adapters/vercel/runtimeProvenance.js";

function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, ["GET"]);
    return;
  }

  const provenance = resolveReleaseProvenance();
  const result = bffHealthDataSchema.safeParse({
    status: "ok",
    service: "openlup-bff",
    contractVersion: "2026-05-29.wave-2",
    domains: BFF_DOMAINS,
    ...provenance,
    emailPresentationId: emailPresentation.id,
  });

  if (!result.success) {
    sendBffError(res, "INTERNAL", "Health contract is invalid");
    return;
  }

  sendBffSuccess(
    res,
    result.data,
    {
      contractVersion: result.data.contractVersion,
    },
  );
}

export function resolveReleaseProvenance(
  env: RuntimeProvenanceEnv & HostedRuntimeCompatibilityEnv = process.env,
) {
  return readRuntimeProvenance(env, readHostedRuntimeCompatibility(env));
}

/** @deprecated Prefer resolveReleaseProvenance so release and deployment stay paired. */
export function resolveReleaseSha(
  env: RuntimeProvenanceEnv & HostedRuntimeCompatibilityEnv = process.env,
): string | null {
  return resolveReleaseProvenance(env).releaseSha;
}

export default withObservedRoute({
  route: "/api/bff/health",
  domain: "health",
  surface: "health",
  risk: "health",
}, handler);
