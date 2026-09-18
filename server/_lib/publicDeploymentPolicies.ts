import type { VercelRequest, VercelResponse } from "./types/vercel.js";
import { readProviderActivationConfig } from "../infra/providerReadiness.js";
import { readObservedEnvironment } from "./observability/environment.js";

export type DeploymentRouteOptions = {
  route: string;
  domain: string;
  surface: "admin" | "customer" | "health" | "hidden" | "public" | "webhook";
  risk: "fail_closed" | "health" | "mutation" | "provider" | "read" | "validation_mutation";
};
export type DeploymentRouteDecision = { allowed: boolean; reason?: "adopter_policy_required" };

export function evaluateDeploymentRoutePolicy(options: DeploymentRouteOptions, _req?: Pick<VercelRequest, "headers">, _env?: Record<string, string | undefined>): DeploymentRouteDecision {
  const blocked = options.surface === "webhook" || ["fail_closed", "mutation", "provider", "validation_mutation"].includes(options.risk);
  return blocked ? { allowed: false, reason: "adopter_policy_required" } : { allowed: true };
}
export const deploymentStagingEnabled = (env: Record<string, string | undefined>): boolean => readObservedEnvironment(env) === "staging";

export function enforceDeploymentRoutePolicy(
  options: DeploymentRouteOptions,
  _req: Pick<VercelRequest, "headers">,
  res: VercelResponse,
): boolean {
  const decision = evaluateDeploymentRoutePolicy(options);
  if (decision.allowed) return true;
  res.setHeader?.("Content-Type", "application/json");
  res.setHeader?.("Cache-Control", "no-store");
  res.status(503).json({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Deployment policy blocked this route", details: { reason: decision.reason, route: options.route } } });
  return false;
}

export interface FakturowniaGateResult { allowed: boolean; failures: string[] }
const disabledGate = (_env: Record<string, string | undefined>): FakturowniaGateResult => ({ allowed: false, failures: ["adopter_policy_required"] });
export const readFakturowniaDemoPreviewGate = disabledGate;
export const readFakturowniaProductionGate = disabledGate;
export const readFakturowniaActivationGate = disabledGate;
export function readFakturowniaReadinessConfig(env: Record<string, string | undefined>) {
  return readProviderActivationConfig({ providerKind: "fakturownia", enabled: false, requiredEnv: ["FAKTUROWNIA_API_TOKEN", "FAKTUROWNIA_BASE_URL"], env });
}

export type EgressMode = "production" | "sandbox_direct" | "sandbox_sink" | "drop";
export type EmailEnvironmentTag = "production" | "non_production";
export const EMAIL_ENVIRONMENT_TAG_NAME = "openlup_env";
export interface EgressDecision { mode: EgressMode; recipient: string | null; intendedRecipient: string; reason: string; apiKeyOverride?: string; blockedReason?: string }
export function resolveEmailEnvironmentTag(_env: Record<string, string | undefined> = process.env): EmailEnvironmentTag { return "non_production"; }
export function resolveEgressMode(env: Record<string, string | undefined>, intendedRecipient: string): EgressDecision {
  const sink = (env.COMMS_SANDBOX_SINK_ADDRESS ?? "").trim();
  return sink
    ? { mode: "sandbox_sink", recipient: sink, intendedRecipient, reason: "public_default_sink", ...(env.RESEND_SANDBOX_API_KEY?.trim() ? { apiKeyOverride: env.RESEND_SANDBOX_API_KEY.trim() } : {}) }
    : { mode: "drop", recipient: null, intendedRecipient, reason: "public_default_drop" };
}
