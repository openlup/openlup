import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  withCatalogAdmissionFence,
  withSelectedCatalogAdmissionFence,
} from "../../src/catalog/catalogAdmissionFence.js";

type QueryArg = string | { text: string; values: unknown[]; query_timeout?: number; queryMode?: "extended" };

class FakeFenceClient extends EventEmitter {
  readonly releases: Array<boolean | undefined> = [];
  readonly queries: string[] = [];
  private readonly handler: (sql: string, values: unknown[] | undefined, client: FakeFenceClient) => Promise<{ rows: Record<string, unknown>[] }>;

  constructor(handler: (sql: string, values: unknown[] | undefined, client: FakeFenceClient) => Promise<{ rows: Record<string, unknown>[] }>) {
    super();
    this.handler = handler;
  }

  async query<Row extends Record<string, unknown>>(
    request: QueryArg,
    values?: unknown[],
  ): Promise<{ rows: Row[] }> {
    const sql = typeof request === "string" ? request : request.text;
    const args = typeof request === "string" ? values : request.values;
    this.queries.push(sql);
    return (await this.handler(sql, args, this)) as { rows: Row[] };
  }

  release(discard?: boolean): void {
    this.releases.push(discard);
  }
}

const snapshotRow = {
  xmax: "100",
  xip: [],
  primary: true,
  role: "checkout_owner",
  login: "checkout_owner",
};

function defaultWriterHandler(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
  if (sql.includes("pg_settings")) {
    return Promise.resolve({ rows: [{ statement: "0", lock_ms: 0 }] });
  }
  if (sql.includes("pg_current_xact_id")) {
    return Promise.resolve({ rows: [{ xid: "99", pid: 42 }] });
  }
  if (sql.includes("commerce_order_draft_receipts")) {
    return Promise.resolve({ rows: [] });
  }
  if (sql.includes("catalog_admission_runtime_checkout")) {
    return Promise.resolve({ rows: [{ result: { kind: "locked" } }] });
  }
  if (sql.includes("pg_current_snapshot")) {
    return Promise.resolve({ rows: [snapshotRow] });
  }
  if (sql.includes("clock_timestamp")) {
    return Promise.resolve({ rows: [{ instant: "2020-01-01T00:00:00.000Z" }] });
  }
  return Promise.resolve({ rows: [] });
}

const baseLegacyInput = {
  key: "checkout-00000001",
  clientId: "11111111-1111-4111-8111-111111111111",
  skuIds: ["22222222-2222-4222-8222-222222222222"],
  revisionIds: ["33333333-3333-4333-8333-333333333333"],
  priceListId: "44444444-4444-4444-8444-444444444444",
  timeoutMs: 2_000,
};

const baseSelectedInput = {
  key: "checkout-00000001",
  clientId: "11111111-1111-4111-8111-111111111111",
  timeoutMs: 2_000,
};

const baseSelectedScope = {
  skuIds: [
    "22222222-2222-4222-8222-222222222222",
    "55555555-5555-4555-8555-555555555555",
  ] as const,
  skuRevisionId: "33333333-3333-4333-8333-333333333333",
  priceListId: "44444444-4444-4444-8444-444444444444",
};

describe("catalogAdmissionFence probe early release", () => {
  it("releases probe and detaches its error listener before read() starts in legacy mode without double-releasing", async () => {
    const writer = new FakeFenceClient(sql => defaultWriterHandler(sql));
    const probe = new FakeFenceClient(() => Promise.resolve({ rows: [snapshotRow] }));
    const clients = [writer, probe];
    const pool = { connect: async () => clients.shift()! };

    let probeReleasesAtReadStart = -1;
    let probeErrorListenersAtReadStart = -1;

    const outcome = await withCatalogAdmissionFence(pool, baseLegacyInput, async (_db, instant) => {
      probeReleasesAtReadStart = probe.releases.length;
      probeErrorListenersAtReadStart = probe.listenerCount("error");
      // Attach a dummy error listener to simulate pg-pool idle handling after release;
      // emitting an error on the released probe must not affect the active writer.
      probe.on("error", () => {});
      probe.emit("error", new Error("unrelated idle probe error"));
      return instant;
    });

    expect(outcome).toBe("2020-01-01T00:00:00.000Z");
    expect(probeReleasesAtReadStart).toBe(1);
    expect(probeErrorListenersAtReadStart).toBe(0);
    expect(probe.releases).toEqual([false]);
    expect(writer.releases).toEqual([false]);
    expect(writer.listenerCount("error")).toBe(0);
  });

  it("releases probe and detaches its error listener before read() starts in selected mode without double-releasing", async () => {
    const writer = new FakeFenceClient(sql => defaultWriterHandler(sql));
    const probe = new FakeFenceClient(() => Promise.resolve({ rows: [snapshotRow] }));
    const clients = [writer, probe];
    const pool = { connect: async () => clients.shift()! };

    let probeReleasesAtReadStart = -1;
    let probeErrorListenersAtReadStart = -1;

    const outcome = await withSelectedCatalogAdmissionFence(
      pool,
      baseSelectedInput,
      baseSelectedScope,
      async (_db, instant, receiptPresent) => {
        probeReleasesAtReadStart = probe.releases.length;
        probeErrorListenersAtReadStart = probe.listenerCount("error");
        return { instant, receiptPresent };
      },
      () => undefined,
    );

    expect(outcome).toEqual({ instant: "2020-01-01T00:00:00.000Z", receiptPresent: false });
    expect(probeReleasesAtReadStart).toBe(1);
    expect(probeErrorListenersAtReadStart).toBe(0);
    expect(probe.releases).toEqual([false]);
    expect(writer.releases).toEqual([false]);
    expect(writer.listenerCount("error")).toBe(0);
  });

  it("destroys probe exactly once on probe query error without double-releasing", async () => {
    const writer = new FakeFenceClient(sql => defaultWriterHandler(sql));
    const probe = new FakeFenceClient(() => Promise.reject(new Error("probe_query_failed")));
    const clients = [writer, probe];
    const pool = { connect: async () => clients.shift()! };

    await expect(
      withCatalogAdmissionFence(pool, baseLegacyInput, async () => "unreachable"),
    ).rejects.toThrow("catalog_admission_fence_unavailable");

    expect(probe.releases).toEqual([true]);
    expect(probe.listenerCount("error")).toBe(0);
    expect(writer.queries).toContain("ROLLBACK");
    expect(writer.releases).toEqual([false]);
    expect(writer.listenerCount("error")).toBe(0);
  });

  it("destroys probe exactly once when fence budget expires during in-flight probe query", async () => {
    let settleProbe!: (error: Error) => void;
    const writer = new FakeFenceClient(sql => defaultWriterHandler(sql));
    const probe = new FakeFenceClient(
      () => new Promise((_resolve, reject) => { settleProbe = reject; }),
    );
    const clients = [writer, probe];
    const pool = { connect: async () => clients.shift()! };

    await expect(
      withCatalogAdmissionFence(pool, { ...baseLegacyInput, timeoutMs: 25 }, async () => "unreachable"),
    ).rejects.toThrow("catalog_admission_fence_unavailable");

    expect(probe.releases).toEqual([true]);
    expect(probe.listenerCount("error")).toBe(0);

    // Settling the abandoned probe query afterwards must not double-release probe.
    settleProbe(new Error("connection_closed_after_destroy"));
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(probe.releases).toEqual([true]);
    expect(probe.listenerCount("error")).toBe(0);
    expect(writer.releases).toEqual([true]);
    expect(writer.listenerCount("error")).toBe(0);
  });

  it("releases probe cleanly in outer finally when prepare fails before probing", async () => {
    const writer = new FakeFenceClient(sql => defaultWriterHandler(sql));
    const probe = new FakeFenceClient(() => Promise.resolve({ rows: [snapshotRow] }));
    const clients = [writer, probe];
    const pool = { connect: async () => clients.shift()! };

    await expect(
      withCatalogAdmissionFence(
        pool,
        baseLegacyInput,
        async () => "unreachable",
        { prelock: async () => { throw new Error("catalog_admission_roster_archived"); } },
      ),
    ).rejects.toThrow("catalog_admission_roster_archived");

    expect(probe.queries).toEqual([]);
    expect(probe.releases).toEqual([false]);
    expect(probe.listenerCount("error")).toBe(0);
    expect(writer.queries).toContain("ROLLBACK");
    expect(writer.releases).toEqual([false]);
    expect(writer.listenerCount("error")).toBe(0);
  });
});
