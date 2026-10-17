import { withObservedRoute } from "../_lib/observability/route.js";
import { createHealthHandler } from "@openlup/platform/bff";
import { bffResponder } from "../_lib/bff/response.js";
import {
  BFF_DOMAINS,
  bffHealthDataSchema,
} from "../../src/lib/bff/health.js";
import { emailPresentation } from "#email-presentation";
import {
  readRuntimeProvenance,
  type RuntimeProvenanceEnv,
} from "../_lib/observability/runtimeProvenance.js";
import {
  readHostedRuntimeCompatibility,
  type HostedRuntimeCompatibilityEnv,
} from "../adapters/vercel/runtimeProvenance.js";

const handler = createHealthHandler({
  responder: bffResponder,
  contract: bffHealthDataSchema,
  read: () => ({
    status: "ok",
    service: "openlup-bff",
    contractVersion: "2026-05-29.wave-2",
    domains: BFF_DOMAINS,
    ...resolveReleaseProvenance(),
    emailPresentationId: emailPresentation.id,
  }),
});

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
