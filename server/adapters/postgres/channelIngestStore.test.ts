import { describe, expect, it, vi } from "vitest";

import {
  ChannelIngestCapabilityUnavailableError,
  createPostgresChannelIngestStore,
} from "./channelIngestStore.js";
import { readChannelOrderFixture } from "../noop_channel/noopChannelConnectorAdapter.js";

type Query = { text: string; values?: unknown[] };

const ledgerPayload = {
  contractVersion: "channels.ingest.v0",
  ingest: {
    id: "ledger-1",
    status: "received",
    orderId: null,
    clientId: null,
    shippingAddressId: null,
    paymentIntentId: null,
    externalOrderRevision: "r1",
    conflict: null,
    eventReplayed: false,
    replayed: false,
  },
};

/**
 * A pool stand-in that answers the one shape the gateway's query builder produces for an RPC. The
 * point of the test is the adapter's argument mapping and its refusals, not node-postgres.
 */
function createPoolFactory(rows: unknown[]) {
  const queries: Query[] = [];
  const client = {
    query: vi.fn(async (text: unknown, values?: unknown[]) => {
      const sql = typeof text === "string" ? text : String((text as { text?: string })?.text ?? "");
      queries.push({ text: sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return { rows: [] };
      return { rows };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => {}) };
  return { poolFactory: () => pool as never, queries, pool };
}

describe("direct-postgres channel ingest store", () => {
  it("calls the ledger boundary and maps its reply", async () => {
    const { poolFactory, queries } = createPoolFactory([{ channel_ingest_record_inbound_event: ledgerPayload }]);
    const store = createPostgresChannelIngestStore({ connectionString: "postgres://x" }, { poolFactory });

    const ledger = await store.recordInboundEvent({
      channelId: "ca-1",
      externalOrderRef: "SIM-1001",
      externalOrderRevision: "r1",
      providerEventId: "sim-evt-1001",
      normalized: readChannelOrderFixture("order-well-formed.json"),
    });
    await store.close();

    expect(ledger.id).toBe("ledger-1");
    expect(queries.some((query) => query.text.includes("channel_ingest_record_inbound_event"))).toBe(
      true,
    );
  });

  it("advances the ledger through the platform boundary", async () => {
    const { poolFactory, queries } = createPoolFactory([
      {
        channel_ingest_advance: {
          ...ledgerPayload,
          ingest: { ...ledgerPayload.ingest, status: "reserved" },
        },
      },
    ]);
    const store = createPostgresChannelIngestStore({ connectionString: "postgres://x" }, { poolFactory });

    const ledger = await store.advanceLedger({ ledgerId: "ledger-1", toStatus: "reserved" });
    await store.close();

    expect(ledger.status).toBe("reserved");
    expect(queries.some((query) => query.text.includes("channel_ingest_advance"))).toBe(true);
  });

  it("files a quarantine row through the platform boundary", async () => {
    const { poolFactory } = createPoolFactory([
      {
        channel_ingest_quarantine: {
          quarantine: { id: "q-1", reason: "money_mismatch", status: "open", vocabulary: "TOTAL" },
        },
      },
    ]);
    const store = createPostgresChannelIngestStore({ connectionString: "postgres://x" }, { poolFactory });

    const row = await store.quarantine({
      channelId: "ca-1",
      connectionId: null,
      providerEventId: "evt-1",
      externalOrderRef: "EXT-1",
      vocabulary: "TOTAL",
      reason: "money_mismatch",
      payload: {},
    });
    await store.close();

    expect(row).toEqual({ id: "q-1", reason: "money_mismatch", status: "open", vocabulary: "TOTAL" });
  });

  // The two capabilities the platform catalogue does not author. Refusing by name is the whole
  // contract: a fabricated id here would be discovered by a customer, not by a test.
  it.each([
    ["upsertBuyer", "channel_ingest_upsert_buyer"] as const,
    ["createChannelOrder", "commerce_create_channel_order"] as const,
  ])("refuses %s by name rather than fabricating a result", async (method, capability) => {
    const { poolFactory } = createPoolFactory([]);
    const store = createPostgresChannelIngestStore({ connectionString: "postgres://x" }, { poolFactory });

    const call =
      method === "upsertBuyer"
        ? store.upsertBuyer({ ledgerId: "ledger-1", buyer: {} as never, shipTo: {} as never })
        : store.createChannelOrder({ idempotencyKey: "k".repeat(12), ledgerId: "ledger-1" });

    await expect(call).rejects.toBeInstanceOf(ChannelIngestCapabilityUnavailableError);
    await expect(call).rejects.toMatchObject({ capability });
    await store.close();
  });

  it("names the missing rail in the refusal, so the gap is legible at the call site", async () => {
    const error = new ChannelIngestCapabilityUnavailableError("commerce_create_channel_order");

    expect(error.message).toContain("platform migration catalogue");
    expect(error.message).toContain("payment-control rail");
  });

  it("raises a named failure carrying the sqlstate when the rpc refuses", async () => {
    const { poolFactory, pool } = createPoolFactory([]);
    const client = await pool.connect();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (text: unknown) => {
      const sql = typeof text === "string" ? text : String((text as { text?: string })?.text ?? "");
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return { rows: [] };
      const failure = new Error("channel_ingest_status_regression") as Error & { code?: string };
      failure.code = "22023";
      throw failure;
    });
    const store = createPostgresChannelIngestStore({ connectionString: "postgres://x" }, { poolFactory });

    await expect(store.advanceLedger({ ledgerId: "ledger-1", toStatus: "received" })).rejects.toThrow(
      /channel_ingest_status_regression/,
    );
    await store.close();
  });
});
