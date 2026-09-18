import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import {
  createSupabaseCommerceReturnsPort,
  type CommerceReturnsRpcClient,
} from "./commerceReturnsPort.js";
import type { CommerceReturnsPort } from "../../domains/commerce/commerceReturnsPort.js";

export interface SupabaseAdminReturnsEnv {
  url: string;
  serviceRoleKey: string;
}

export interface SupabaseAdminReturnsGatewayOptions {
  clientFactory?: (env: SupabaseAdminReturnsEnv) => unknown;
}

export interface SupabaseAdminReturnsGateway {
  returnsPort: () => CommerceReturnsPort;
}

export function createSupabaseAdminReturnsGateway(
  env: SupabaseAdminReturnsEnv,
  options: SupabaseAdminReturnsGatewayOptions = {},
): SupabaseAdminReturnsGateway {
  let port: CommerceReturnsPort | null = null;

  return {
    returnsPort: () => {
      if (!port) {
        const client = (options.clientFactory ?? createServiceRoleClient)(env) as unknown as CommerceReturnsRpcClient;
        port = createSupabaseCommerceReturnsPort(client);
      }
      return port;
    },
  };
}
