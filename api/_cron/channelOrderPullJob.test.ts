import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import {
  CHANNEL_ORDER_PULL_JOB_NAME,
  runChannelOrderPullCron,
  runChannelOrderPullScan,
  type ChannelOrderPullDeps,
} from "./channelOrderPullJob.js";
import { ChannelIngestUnavailableError } from "../../server/domains/channels/channelWebhookHandler.js";
import { createNoopChannelConnectorAdapter } from "../../server/adapters/noop_channel/noopChannelConnectorAdapter.js";
import type { ChannelConnectionPullRow } from "../../server/adapters/supabase/channelConnectionPullStore.js";

const { mockClaim, mockFinish } = vi.hoisted(() => ({ mockClaim: vi.fn(), mockFinish: vi.fn() }));

vi.mock("./platformJobRunner.js", () => ({ claimJobRun: mockClaim, finishJobRun: mockFinish }));

const ENV = {
  CRON_SECRET: "secret",
  CHANNEL_ORDER_PULL_ENABLED: "true",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  NODE_ENV: "test",
};

afterEach(() => {
  mockClaim.mockReset();
  mockFinish.mockReset();
});

function request(headers: Record<string, string> = { authorization: "Bearer secret" }, method = "POST") {
  return { method, headers } as unknown as VercelRequest;
}

const CONNECTION: ChannelConnectionPullRow = {
  connectionId: "c1",
  slug: "sim",
  connectorProviderKind: "noop_channel",
  connectorShape: "direct",
  pullCursor: null,
  pullWatermarkAt: null,
};

function deps(overrides: Partial<ChannelOrderPullDeps> = {}): ChannelOrderPullDeps {
  return {
    connections: {
      listPullableConnections: vi.fn(async () => [CONNECTION]),
      recordPullProgress: vi.fn(async () => undefined),
    },
    ingest: {
      ingestOrder: vi.fn(async () => ({
        kind: "settled" as const,
        ledgerId: "l",
        orderId: "o",
        paymentIntentId: "p",
      })),
      quarantineSignal: vi.fn(async () => ({ quarantineId: "q" })),
    },
    resolveOrderSource: () => createNoopChannelConnectorAdapter().orders,
    ...overrides,
  };
}

const live = () => new AbortController().signal;

describe("channel order pull cron entrypoint", () => {
  it("refuses an unauthenticated call before anything is claimed", async () => {
    const result = await runChannelOrderPullCron(request({}), ENV);
    expect(result.status).toBe(401);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("refuses a method outside the cron allowlist", async () => {
    expect((await runChannelOrderPullCron(request({ authorization: "Bearer secret" }, "DELETE"), ENV)).status).toBe(405);
  });

  it("refuses when no cron secret is configured", async () => {
    expect((await runChannelOrderPullCron(request(), { ...ENV, CRON_SECRET: undefined })).status).toBe(503);
  });

  it("skips with a named reason while the flag is off, without claiming a run", async () => {
    const result = await runChannelOrderPullCron(request(), { ...ENV, CHANNEL_ORDER_PULL_ENABLED: "false" });

    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "channel_order_pull_disabled" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("requires the service-role environment before claiming a run", async () => {
    const result = await runChannelOrderPullCron(request(), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: undefined });

    expect(result).toMatchObject({ status: 503, body: { error: "supabase_env_required" } });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("honours the job-control refusal and does no work", async () => {
    mockClaim.mockResolvedValue({ acquired: false, runId: null, reason: "job_disabled" });
    const gateway = () => ({ asService: (work: (client: unknown) => Promise<unknown>) => work({}) });

    const result = await runChannelOrderPullCron(request(), ENV, gateway as never);

    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "job_disabled" });
    expect(mockClaim).toHaveBeenCalledWith(expect.anything(), CHANNEL_ORDER_PULL_JOB_NAME, "vercel_cron", 120);
    expect(mockFinish).not.toHaveBeenCalled();
  });
});

// The rails the SAGA borrows are bound by composition, not by the scan, so nothing in the scan's
// own tests can see whether the cron actually binds them. This drives the real
// `runChannelOrderPullCron` composition against a stand-in client and pins the one observable
// difference: an unbound rails slot refuses EVERY order with `channel_ingest_rails_unbound` before
// it reads anything, so the page is never fully handled and the cursor never advances. Wave B7
// bound the webhook route's rails and, until this case existed, left the poll path unbound - which
// would have meant a live channel settling on push and stalling forever on poll.
describe("channel order pull composition", () => {
  function stubClient(rpcCalls: string[]) {
    const connections = [
      {
        id: "c1",
        slug: "sim",
        connector_provider_kind: "noop_channel",
        connector_shape: "direct",
        pull_cursor: null,
        pull_watermark_at: null,
      },
    ];
    const query = {
      select: () => query,
      // The pull store's list terminates on `.in(...)`; everything else the composition reaches for
      // resolves to "no row", which is enough to get past the rails slot and no further.
      in: () => Promise.resolve({ data: connections, error: null }),
      eq: () => query,
      order: () => query,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      then: (onfulfilled: (value: unknown) => unknown) =>
        Promise.resolve(onfulfilled({ data: [], error: null, count: 0 })),
    };
    return {
      from: () => query,
      rpc: (name: string) => {
        rpcCalls.push(name);
        return Promise.resolve({ data: null, error: { message: "stub" } });
      },
    };
  }

  it("binds the saga's rails, so an order is refused on its own merits rather than as unavailable", async () => {
    mockClaim.mockResolvedValue({ acquired: true, runId: "run-1" });
    mockFinish.mockResolvedValue(undefined);
    const rpcCalls: string[] = [];
    const gateway = () => ({
      asService: (work: (client: unknown) => Promise<unknown>) => work(stubClient(rpcCalls)),
    });

    const result = await runChannelOrderPullCron(request(), ENV, gateway as never);
    const body = result.body as { unavailable: number; reason?: string; pulled: number };

    expect(body.pulled).toBeGreaterThan(0);
    // The load-bearing assertion. Unbound rails answer this, and nothing else does.
    expect(body.reason).not.toBe("channel_ingest_rails_unbound");
    expect(body.unavailable).toBe(0);
  });
});

describe("channel order pull scan", () => {
  it("drives the simulator end to end and advances the cursor on a fully handled page", async () => {
    const injected = deps();

    const result = await runChannelOrderPullScan(injected, live());

    // THREE order fixtures now: the two this job was written against, plus the BUNDLE-line order
    // (`SIM-1003`) wave B7 added to the simulator. The simulator still withholds the redelivery
    // fixture from a pull on purpose, so the page is three rather than four.
    expect(result).toMatchObject({ ok: true, connections: 1, pulled: 3, settled: 3, unavailable: 0 });
    // The simulator surfaces one unknown-vocabulary signal on every pull; it is filed, never dropped.
    expect(result.quarantined).toBe(1);
    expect(injected.connections.recordPullProgress).toHaveBeenCalledWith({
      connectionId: "c1",
      pullCursor: "end",
      pullWatermarkAt: "2026-08-12T10:05:00Z",
    });
  });

  // "Fully handled" is a claim about the WHOLE page, so it is worth naming what is in the page
  // rather than only counting it: a fixture that stopped being pulled would keep `pulled` honest
  // by accident while silently dropping an order shape from the poll path's coverage.
  it("hands every pulled order to ingest, the bundle one included", async () => {
    const injected = deps();

    await runChannelOrderPullScan(injected, live());

    const ingested = (injected.ingest.ingestOrder as unknown as { mock: { calls: [{ externalOrderRef: string; lines: { sellable: { kind: string } }[] }][] } })
      .mock.calls.map(([order]) => order);
    expect(ingested.map((order) => order.externalOrderRef).sort()).toEqual([
      "SIM-1001",
      "SIM-1002",
      "SIM-1003",
    ]);
    // The bundle line reaches the poll path in its wire shape — unexpanded, because expansion is
    // the saga's step, not the poller's.
    const bundled = ingested.find((order) => order.externalOrderRef === "SIM-1003");
    expect(bundled?.lines.map((line) => line.sellable.kind)).toEqual(["bundle"]);
  });

  it("does NOT advance the cursor when an order in the page could not be ingested", async () => {
    const injected = deps({
      ingest: {
        ingestOrder: async () => {
          throw new ChannelIngestUnavailableError("channel_ingest_rails_unbound");
        },
        quarantineSignal: vi.fn(async () => ({ quarantineId: "q" })),
      },
    });

    const result = await runChannelOrderPullScan(injected, live());

    expect(result).toMatchObject({ ok: false, reason: "channel_ingest_rails_unbound" });
    expect(result.unavailable).toBeGreaterThan(0);
    expect(injected.connections.recordPullProgress).not.toHaveBeenCalled();
  });

  it("counts a connection whose connector cannot be resolved and keeps going", async () => {
    const injected = deps({
      connections: {
        listPullableConnections: async () => [CONNECTION, { ...CONNECTION, connectionId: "c2" }],
        recordPullProgress: vi.fn(async () => undefined),
      },
      resolveOrderSource: () => {
        throw new Error("Unknown channel connector: some_marketplace");
      },
    });

    const result = await runChannelOrderPullScan(injected, live());

    expect(result.unavailable).toBe(2);
    expect(result.ok).toBe(true);
    expect(injected.connections.recordPullProgress).not.toHaveBeenCalled();
  });

  it("fans an aggregator connection out over its discovered surfaces", async () => {
    const orders = createNoopChannelConnectorAdapter().orders;
    const listChannelBindings = vi.fn(orders.listChannelBindings);
    const injected = deps({
      connections: {
        listPullableConnections: async () => [{ ...CONNECTION, connectorShape: "aggregator" }],
        recordPullProgress: vi.fn(async () => undefined),
      },
      resolveOrderSource: () => ({ ...orders, listChannelBindings }),
    });

    await runChannelOrderPullScan(injected, live());

    expect(listChannelBindings).toHaveBeenCalledWith(expect.objectContaining({ connectionRef: "c1" }));
  });

  it("stops on an aborted signal without touching another connection", async () => {
    const controller = new AbortController();
    controller.abort();
    const injected = deps();

    const result = await runChannelOrderPullScan(injected, controller.signal);

    expect(result).toMatchObject({ ok: false, reason: "aborted", pulled: 0 });
    expect(injected.ingest.ingestOrder).not.toHaveBeenCalled();
  });

  it("reports a listing failure as a failed run rather than throwing", async () => {
    const result = await runChannelOrderPullScan(
      deps({
        connections: {
          listPullableConnections: async () => {
            throw new Error("registry unreachable");
          },
          recordPullProgress: vi.fn(),
        },
      }),
      live(),
    );

    expect(result).toMatchObject({ ok: false, reason: "registry unreachable", connections: 0 });
  });
});
