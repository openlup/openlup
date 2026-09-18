import type { RiskAdminReadPort, RiskAdminWritePort } from "../../../src/domains/risk/ports.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import {
  createSupabaseRiskAdminPort,
  type RiskAdminSupabaseClient,
} from "./riskAdminPort.js";

export interface SupabaseAdminRiskEnv {
  url: string;
  serviceRoleKey: string;
}

export interface SupabaseAdminRiskGatewayOptions {
  clientFactory?: (env: SupabaseAdminRiskEnv) => unknown;
}

export interface SupabaseAdminRiskGateway {
  readPort: () => RiskAdminReadPort;
  writePort: () => RiskAdminWritePort;
}

export function createSupabaseAdminRiskGateway(
  env: SupabaseAdminRiskEnv,
  options: SupabaseAdminRiskGatewayOptions = {},
): SupabaseAdminRiskGateway {
  let port: (RiskAdminReadPort & RiskAdminWritePort) | null = null;

  function getPort(): RiskAdminReadPort & RiskAdminWritePort {
    if (!port) {
      const client = (options.clientFactory ?? createServiceRoleClient)(env) as unknown as RiskAdminSupabaseClient;
      port = createSupabaseRiskAdminPort(client);
    }
    return port;
  }

  return {
    readPort: getPort,
    writePort: getPort,
  };
}
