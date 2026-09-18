import type {
  CommerceFulfillmentMutationPort,
  CommerceFulfillmentReadPort,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import {
  createSupabaseCommerceFulfillmentPort,
  type CommerceFulfillmentSupabaseClient,
} from "./commerceFulfillmentPort.js";
type SupabaseAdminCommerceFulfillmentClient = CommerceFulfillmentSupabaseClient;

export interface SupabaseAdminCommerceFulfillmentEnv {
  url: string;
  serviceRoleKey: string;
}

export interface SupabaseAdminCommerceFulfillmentGatewayOptions {
  clientFactory?: typeof createServiceRoleClient;
  handoffPortDecorator?: (
    port: Pick<CommerceFulfillmentMutationPort, "handOffCommerceFulfillmentOrder">,
    client: SupabaseAdminCommerceFulfillmentClient,
  ) => Pick<CommerceFulfillmentMutationPort, "handOffCommerceFulfillmentOrder">;
}

export interface SupabaseAdminCommerceFulfillmentGateway {
  readPort: () => CommerceFulfillmentReadPort;
  mutationPort: () => CommerceFulfillmentMutationPort;
  handoffPort: () => Pick<CommerceFulfillmentMutationPort, "handOffCommerceFulfillmentOrder">;
}

export function createSupabaseAdminCommerceFulfillmentGateway(
  env: SupabaseAdminCommerceFulfillmentEnv,
  options: SupabaseAdminCommerceFulfillmentGatewayOptions = {},
): SupabaseAdminCommerceFulfillmentGateway {
  let client: SupabaseAdminCommerceFulfillmentClient | null = null;
  let basePort: (CommerceFulfillmentReadPort & CommerceFulfillmentMutationPort) | null = null;
  let handoffPort: Pick<CommerceFulfillmentMutationPort, "handOffCommerceFulfillmentOrder"> | null = null;

  function getClient(): SupabaseAdminCommerceFulfillmentClient {
    client ??= (options.clientFactory ?? createServiceRoleClient)(env) as unknown as SupabaseAdminCommerceFulfillmentClient;
    return client;
  }

  function getBasePort(): CommerceFulfillmentReadPort & CommerceFulfillmentMutationPort {
    basePort ??= createSupabaseCommerceFulfillmentPort(getClient());
    return basePort;
  }

  return {
    readPort: getBasePort,
    mutationPort: getBasePort,
    handoffPort: () => {
      if (handoffPort) return handoffPort;
      const fulfillmentPort = getBasePort();
      handoffPort = options.handoffPortDecorator
        ? options.handoffPortDecorator(fulfillmentPort, getClient())
        : fulfillmentPort;
      return handoffPort;
    },
  };
}
