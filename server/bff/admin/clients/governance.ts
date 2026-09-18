import { readSupabaseAdminCommerceEnv } from "../../../_lib/admin-domain/auth.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import type { VercelResponse } from "../../../_lib/types/vercel.js";
import { createClientsAgentReadGovernance } from "../../../adapters/supabase/clients/agentReadGovernance.js";
import type { ClientsAgentReadGovernance } from "../../../domains/clients/agentCustomerReadGovernance.js";
import type { CustomerSupportJourneyGovernance } from "../../../runtime/support/customerJourneyBinding.js";

/**
 * Build the Wave 7a actor-kind-aware governance the clients read routes inject
 * into their handlers. Returns `undefined` when the service-role env is absent —
 * the handler then runs the unchanged human path (the upstream admin-role gate
 * still applies). The flag default-OFF means the machine path is blocked until
 * `COMMERCE_AGENT_CUSTOMER_READ_ENABLED=true`.
 */
export function buildClientsAgentReadGovernance(): ClientsAgentReadGovernance | undefined {
  const env = readSupabaseAdminCommerceEnv();
  if (!env) return undefined;
  return createClientsAgentReadGovernance(env);
}

export function buildCustomerSupportJourneyGovernance(
  env: Record<string, string | undefined>,
): CustomerSupportJourneyGovernance | undefined {
  return env.PLATFORM_BUNDLE === "node-postgres"
    ? { flagEnabled: env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED === "true" }
    : buildClientsAgentReadGovernance();
}

export function sendCustomerSupportAgentReadDisabled(res: VercelResponse): void {
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Agent customer reads are disabled", { details: {
    reason: "feature_flag_disabled", featureFlag: "COMMERCE_AGENT_CUSTOMER_READ_ENABLED",
  } });
}
