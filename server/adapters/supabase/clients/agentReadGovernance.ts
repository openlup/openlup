import { createServiceRoleClient } from "../../../_lib/admin-domain/auth.js";
import {
  commerceAgentCustomerReadEnabled,
  type AgentAuditClient,
} from "../../../_lib/admin-domain/agentCustomerReadGuard.js";
import type { ClientsAgentReadGovernance } from "../../../domains/clients/agentCustomerReadGovernance.js";

export interface ClientsAgentReadGovernanceEnv {
  url: string;
  serviceRoleKey: string;
}

export interface ClientsAgentReadGovernanceGatewayOptions {
  clientFactory?: (env: ClientsAgentReadGovernanceEnv) => unknown;
}

export function createClientsAgentReadGovernance(
  env: ClientsAgentReadGovernanceEnv,
  options: ClientsAgentReadGovernanceGatewayOptions = {},
): ClientsAgentReadGovernance {
  const auditClient = (options.clientFactory ?? createServiceRoleClient)(env) as unknown as AgentAuditClient;
  return {
    flagEnabled: commerceAgentCustomerReadEnabled(),
    auditClient,
  };
}
