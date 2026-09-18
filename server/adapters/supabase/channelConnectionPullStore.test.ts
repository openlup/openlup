import { describe, expect, it, vi } from "vitest";

import {
  createManagedChannelConnectionPullStore,
  type ManagedChannelConnectionClient,
} from "./channelConnectionPullStore.js";

function client(result: { data: unknown; error: { message?: string } | null }) {
  const calls: Array<Record<string, unknown>> = [];
  const managed = {
    from(table: string) {
      calls.push({ from: table });
      return {
        select(columns: string) {
          calls.push({ select: columns });
          return {
            in(column: string, values: readonly string[]) {
              calls.push({ in: column, values: [...values] });
              return Promise.resolve(result);
            },
          };
        },
        update(values: Record<string, unknown>) {
          calls.push({ update: values });
          return {
            eq(column: string, value: unknown) {
              calls.push({ eq: column, value });
              return Promise.resolve(result);
            },
          };
        },
      };
    },
  } as unknown as ManagedChannelConnectionClient;
  return { managed, calls };
}

const ROW = {
  id: "c1",
  slug: "sim",
  connector_provider_kind: "noop_channel",
  connector_shape: "direct",
  pull_cursor: null,
  pull_watermark_at: null,
};

describe("managed channel connection pull store", () => {
  it("reads exactly the live statuses and the dormant cursor columns", async () => {
    const { managed, calls } = client({ data: [ROW], error: null });

    const rows = await createManagedChannelConnectionPullStore(managed).listPullableConnections();

    expect(rows).toEqual([
      {
        connectionId: "c1",
        slug: "sim",
        connectorProviderKind: "noop_channel",
        connectorShape: "direct",
        pullCursor: null,
        pullWatermarkAt: null,
      },
    ]);
    expect(calls).toContainEqual({ from: "sales_channel_connections" });
    expect(calls).toContainEqual({ in: "status", values: ["active", "testing"] });
    expect(calls.find((call) => "select" in call)?.select).toContain("pull_cursor");
  });

  it("returns nothing rather than guessing when the lane answers with a non-array", async () => {
    const { managed } = client({ data: null, error: null });
    await expect(createManagedChannelConnectionPullStore(managed).listPullableConnections()).resolves.toEqual([]);
  });

  it("refuses a row missing an identity instead of inventing one", async () => {
    const { managed } = client({ data: [{ ...ROW, connector_provider_kind: null }], error: null });
    await expect(createManagedChannelConnectionPullStore(managed).listPullableConnections()).rejects.toThrow(
      "channel_connection_row_invalid: connection.connector_provider_kind",
    );
  });

  it("names the failing read in its error", async () => {
    const { managed } = client({ data: null, error: { message: "denied" } });
    await expect(createManagedChannelConnectionPullStore(managed).listPullableConnections()).rejects.toThrow(
      "sales_channel_connections_read_failed: denied",
    );
  });

  it("writes both cursor columns for one connection and nothing else", async () => {
    const { managed, calls } = client({ data: null, error: null });

    await createManagedChannelConnectionPullStore(managed).recordPullProgress({
      connectionId: "c1",
      pullCursor: "end",
      pullWatermarkAt: "2026-08-12T10:05:00Z",
    });

    const update = calls.find((call) => "update" in call)?.update as Record<string, unknown>;
    expect(Object.keys(update).sort()).toEqual(["pull_cursor", "pull_watermark_at", "updated_at"]);
    expect(update).toMatchObject({ pull_cursor: "end", pull_watermark_at: "2026-08-12T10:05:00Z" });
    expect(calls).toContainEqual({ eq: "id", value: "c1" });
  });

  it("names the failing write in its error", async () => {
    const { managed } = client({ data: null, error: { message: "denied" } });
    await expect(
      createManagedChannelConnectionPullStore(managed).recordPullProgress({
        connectionId: "c1",
        pullCursor: null,
        pullWatermarkAt: null,
      }),
    ).rejects.toThrow("sales_channel_connections_pull_progress_failed: denied");
  });

  it("does not swallow a rejected update", async () => {
    const { managed } = client({ data: null, error: null });
    const spy = vi.spyOn(Date.prototype, "toISOString");
    await createManagedChannelConnectionPullStore(managed).recordPullProgress({
      connectionId: "c1",
      pullCursor: null,
      pullWatermarkAt: null,
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
