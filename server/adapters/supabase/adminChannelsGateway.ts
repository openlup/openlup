import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import type { AdminChannelOpsReadPort } from "../../domains/channels/adminChannelOpsHandler.js";
import {
  createSupabaseChannelOpsReadPort,
  type ChannelOpsQueryClient,
} from "./channelOpsReadPort.js";

// The channels admin gateway: it constructs the elevated client, and that is ALL it does.
//
// WHY THE ROUTE MAY NOT DO THIS ITSELF. A BFF route that builds its own service-role client holds
// an unrestricted, RLS-bypassing handle to the whole database for the length of the request, and
// every guard after that point is a promise rather than a boundary. `adminBffServiceRoleBoundary`
// makes that a rule with one grandfathered exception (`server/bff/admin/commerce/`), so a
// consolidated route receives ready PORTS and never sees a client. That is the shape the hardened
// inventory, risk, returns, accounting and communications routes already use.
//
// WHY IT SITS IN THE ADAPTER LAYER RATHER THAN IN `server/domains/channels/`. The inventory
// gateway this mirrors lives in its domain folder, and copying that placement was the first
// attempt — but `server/domains` carries a FROZEN persistence-boundary ratchet, and the two
// identifiers a gateway must name (the import of the client factory and its use as the default)
// are counted as SDK configuration by it. A new gateway there moves `sdkConfig` 34 -> 36, and that
// counter has no headroom: it is the measure of how much SDK knowledge the domain layer still
// carries, and it is meant to fall rather than grow. The inventory gateway predates the freeze and
// is inside the baseline; a new one cannot join it without loosening the invariant.
//
// So the SHAPE is mirrored exactly and only the ADDRESS differs, which costs the domain layer
// nothing and reads better anyway: every other client-constructing module in this wave already
// lives here, next to the adapter it wraps.
//
// THERE IS NOT A SINGLE DATA OPERATION IN THIS FILE, deliberately. The query surface stays in the
// adapter; this decides only WHICH client that adapter gets. A gateway that started issuing its own
// reads would be a second query surface for the same table.
//
// THE CLIENT IS BUILT LAZILY AND ONCE. A request that never reaches a read never builds one, and a
// request that reads twice does not build two.

export interface AdminChannelsGatewayEnv {
  url: string;
  serviceRoleKey: string;
}

export interface AdminChannelsGatewayOptions {
  /** Injection seam for tests; the default is the real elevated client factory. */
  clientFactory?: (env: AdminChannelsGatewayEnv) => unknown;
}

export interface AdminChannelsGateway {
  /** The channel-operations read: ledger status for one order, drawer depth for its channel. */
  opsReadPort: () => AdminChannelOpsReadPort;
}

export function createAdminChannelsGateway(
  env: AdminChannelsGatewayEnv,
  options: AdminChannelsGatewayOptions = {},
): AdminChannelsGateway {
  let port: AdminChannelOpsReadPort | null = null;

  function getOpsReadPort(): AdminChannelOpsReadPort {
    if (!port) {
      const client = (options.clientFactory ?? createServiceRoleClient)(
        env,
      ) as unknown as ChannelOpsQueryClient;
      port = createSupabaseChannelOpsReadPort(client);
    }
    return port;
  }

  return { opsReadPort: getOpsReadPort };
}
