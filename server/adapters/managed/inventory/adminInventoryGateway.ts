import type {
  InventoryMutationPort,
  InventoryReadPort,
} from "../../../../src/domains/inventory/ports.js";
import { createServiceRoleClient } from "../../../_lib/admin-domain/auth.js";
import {
  createManagedInventoryPort,
  type ManagedInventoryClient,
} from "./inventoryPort.js";

export interface ManagedAdminInventoryEnv {
  url: string;
  serviceRoleKey: string;
}

export interface ManagedAdminInventoryGatewayOptions {
  clientFactory?: (env: ManagedAdminInventoryEnv) => unknown;
}

export interface ManagedAdminInventoryGateway {
  readPort: () => InventoryReadPort;
  mutationPort: () => InventoryMutationPort;
}

export function createManagedAdminInventoryGateway(
  env: ManagedAdminInventoryEnv,
  options: ManagedAdminInventoryGatewayOptions = {},
): ManagedAdminInventoryGateway {
  let port: (InventoryReadPort & InventoryMutationPort) | null = null;

  function getPort(): InventoryReadPort & InventoryMutationPort {
    if (!port) {
      const client = (options.clientFactory ?? createServiceRoleClient)(env) as unknown as ManagedInventoryClient;
      port = createManagedInventoryPort(client);
    }
    return port;
  }

  return {
    readPort: getPort,
    mutationPort: getPort,
  };
}
