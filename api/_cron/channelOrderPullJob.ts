import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { authorizeCron } from "./authorizeCron.js";
import { claimJobRun, finishJobRun } from "./platformJobRunner.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import { noopSettlementAllowed } from "../../server/_lib/observability/environment.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import {
  createManagedChannelIngestChannelRead,
  createManagedChannelIngestStore,
  type ManagedChannelIngestClient,
} from "../../server/adapters/supabase/channelIngestStore.js";
import {
  createManagedChannelIngestRails,
  type ManagedChannelRailsClient,
} from "../../server/adapters/supabase/channelIngestRails.js";
import {
  createManagedChannelConnectionPullStore,
  type ChannelConnectionPullPort,
  type ChannelConnectionPullRow,
  type ManagedChannelConnectionClient,
} from "../../server/adapters/supabase/channelConnectionPullStore.js";
import {
  createChannelWebhookPort,
  resolveChannelOrderSource,
} from "../../server/runtime/channelIngest/channelIngestComposition.js";
import { ChannelIngestUnavailableError } from "../../server/domains/channels/channelWebhookHandler.js";
import type { ChannelWebhookPort } from "../../server/domains/channels/channelWebhookHandler.js";
import type { ChannelOrderSourcePort } from "../../src/domains/channels/ports.js";
import { PLATFORM_ACCEPTED_CURRENCIES } from "../../src/lib/currency/platformCurrency.js";

// The poll shape of channel order ingest — the rail that exists because a webhook is never the only
// delivery guarantee a marketplace gives you.
//
// IT IS A SKELETON, AND IT IS DEFAULT-OFF IN EVERY ENVIRONMENT. The loop, the cursor and the
// quarantine of unmapped signals are real; the only connector it can resolve today is the
// simulator, and only where a simulated settlement may be believed. Its `platform_job_controls`
// row seeds `enabled = false` in both chains, so the schedule can exist without the job ever
// running until a person flips it.
//
// THE CURSOR ADVANCES ONLY ON A FULLY HANDLED PAGE. A page whose orders could not be ingested must
// be polled again, so `pull_cursor` is written only when every order in it reached a terminal
// answer. Advancing on a partial page would silently skip orders that were never created — the one
// failure a poller can cause that no ledger row would record.

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  CHANNEL_ORDER_PULL_ENABLED?: string;
};

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

export const CHANNEL_ORDER_PULL_JOB_NAME = "channel-order-pull";

const JOB_LEASE_SECONDS = 120;
const PULL_LIMIT = 50;
const HANDLER_TIMEOUT_MS = 50_000;

export interface ChannelOrderPullResult {
  ok: boolean;
  connections: number;
  pulled: number;
  settled: number;
  replayed: number;
  quarantined: number;
  blocked: number;
  refused: number;
  unavailable: number;
  reason?: string;
}

export interface ChannelOrderPullDeps {
  connections: ChannelConnectionPullPort;
  ingest: ChannelWebhookPort;
  /** Injected so the scan can be driven against a stand-in connector in a test. */
  resolveOrderSource: (connectorKind: string) => ChannelOrderSourcePort;
}

export async function runChannelOrderPullCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const denied = authorizeCron(req, env);
  if (denied) return denied;

  if (env.CHANNEL_ORDER_PULL_ENABLED !== "true") {
    return { status: 200, body: { ok: true, skipped: true, reason: "channel_order_pull_disabled" } };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) return { status: 503, body: { ok: false, error: "supabase_env_required" } };

  const simulatorAllowed = noopSettlementAllowed(env);

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(
      client as never,
      CHANNEL_ORDER_PULL_JOB_NAME,
      "vercel_cron",
      JOB_LEASE_SECONDS,
    );
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HANDLER_TIMEOUT_MS);
    const result = await runSafely(() =>
      runChannelOrderPullScan(
        {
          connections: createManagedChannelConnectionPullStore(client as ManagedChannelConnectionClient),
          ingest: createChannelWebhookPort({
            store: createManagedChannelIngestStore(client as ManagedChannelIngestClient),
            channels: createManagedChannelIngestChannelRead(client as ManagedChannelIngestClient),
            // THE SAME RAILS THE WEBHOOK ROUTE BINDS, from the same factory and the same client.
            // A channel that pulls has to handle exactly what a channel that pushes handles:
            // without this the poll would answer `channel_ingest_rails_unbound` for every order on
            // every page, never advance the cursor, and re-poll the same orders forever while the
            // webhook for the same channel settled them. The bundle catalogue seam rides along,
            // which is what lets a pulled BUNDLE line explode instead of quarantining.
            rails: createManagedChannelIngestRails(client as ManagedChannelRailsClient),
            acceptedCurrencies: PLATFORM_ACCEPTED_CURRENCIES,
            noopSettlementForbidden: !simulatorAllowed,
          }),
          resolveOrderSource: (kind) => resolveChannelOrderSource(kind, simulatorAllowed),
        },
        controller.signal,
      ),
    );
    clearTimeout(timeout);

    try {
      await finishJobRun(
        client as never,
        CHANNEL_ORDER_PULL_JOB_NAME,
        lease.runId,
        result.ok ? "success" : "failed",
        {
          checked: result.pulled,
          updated: result.settled,
          failures: result.refused + result.unavailable,
          skipped: false,
          reason: result.reason,
        },
        { driver: "vercel_cron", connections: result.connections, quarantined: result.quarantined },
      );
    } catch (error) {
      console.error("[channel-order-pull] finish_job_run_failed", safeMessage(error));
    }

    return { status: result.ok ? 200 : 502, body: result as unknown as Record<string, unknown> };
  });
}

export async function runChannelOrderPullScan(
  deps: ChannelOrderPullDeps,
  signal: AbortSignal,
): Promise<ChannelOrderPullResult> {
  const result = emptyResult();

  let connections: readonly ChannelConnectionPullRow[];
  try {
    connections = await deps.connections.listPullableConnections();
  } catch (error) {
    return { ...result, ok: false, reason: safeMessage(error) };
  }
  result.connections = connections.length;

  for (const connection of connections) {
    if (signal.aborted) {
      result.ok = false;
      result.reason = "aborted";
      break;
    }
    let orders: ChannelOrderSourcePort;
    try {
      orders = deps.resolveOrderSource(connection.connectorProviderKind);
    } catch (error) {
      // A connection whose connector this deployment cannot resolve is not a fault of the poll: it
      // is a registry row nothing can serve. It is counted and skipped, never retried into a loop.
      result.unavailable += 1;
      result.reason ??= safeMessage(error);
      continue;
    }

    try {
      await pullConnection(deps, connection, orders, signal, result);
    } catch (error) {
      result.ok = false;
      result.reason = safeMessage(error);
    }
  }

  return result;
}

async function pullConnection(
  deps: ChannelOrderPullDeps,
  connection: ChannelConnectionPullRow,
  orders: ChannelOrderSourcePort,
  signal: AbortSignal,
  result: ChannelOrderPullResult,
): Promise<void> {
  // An aggregator connection fans out to N surfaces; a direct connection IS its surface and
  // addresses none. Same call, both shapes — which is the property the connector port was given.
  const surfaces =
    connection.connectorShape === "aggregator"
      ? (await orders.listChannelBindings({ connectionRef: connection.connectionId, signal })).map(
          (binding) => binding.channelExternalRef,
        )
      : [null];

  for (const channelExternalRef of surfaces) {
    const page = await orders.pullOrders({
      connectionRef: connection.connectionId,
      channelExternalRef,
      since: connection.pullWatermarkAt,
      cursor: connection.pullCursor,
      limit: PULL_LIMIT,
      signal,
    });
    result.pulled += page.orders.length;

    let pageFullyHandled = true;
    for (const order of page.orders) {
      try {
        countOutcome(result, (await deps.ingest.ingestOrder(order)).kind);
      } catch (error) {
        if (!(error instanceof ChannelIngestUnavailableError)) throw error;
        result.unavailable += 1;
        result.reason ??= error.reason;
        pageFullyHandled = false;
      }
    }

    // Surfaced, never dropped: an unknown wire token is filed as operator work rather than being
    // discarded with the page it arrived in.
    for (const unmapped of page.unmapped) {
      await deps.ingest.quarantineSignal({
        providerEventId: `${connection.slug}:${unmapped.vocabulary}`,
        signal: unmapped,
      });
      result.quarantined += 1;
    }

    if (!pageFullyHandled) {
      result.ok = false;
      continue;
    }
    await deps.connections.recordPullProgress({
      connectionId: connection.connectionId,
      pullCursor: page.nextCursor,
      pullWatermarkAt: page.watermarkAt,
    });
  }
}

function countOutcome(result: ChannelOrderPullResult, kind: string): void {
  if (kind === "settled") result.settled += 1;
  else if (kind === "replayed") result.replayed += 1;
  else if (kind === "quarantined") result.quarantined += 1;
  else if (kind === "blocked_stock") result.blocked += 1;
  else result.refused += 1;
}

function emptyResult(): ChannelOrderPullResult {
  return {
    ok: true,
    connections: 0,
    pulled: 0,
    settled: 0,
    replayed: 0,
    quarantined: 0,
    blocked: 0,
    refused: 0,
    unavailable: 0,
  };
}

async function runSafely(
  operation: () => Promise<ChannelOrderPullResult>,
): Promise<ChannelOrderPullResult> {
  try {
    return await operation();
  } catch (error) {
    return { ...emptyResult(), ok: false, reason: safeMessage(error) };
  }
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}
