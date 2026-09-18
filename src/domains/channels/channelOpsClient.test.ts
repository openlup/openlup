import { afterEach, describe, expect, it, vi } from "vitest";
import {
  channelIngestNeedsAttention,
  channelOrderOpsResponseSchema,
  getAdminChannelOrderOps,
} from "./channelOpsClient.js";

const ok = {
  contractVersion: "channels.ops.v1",
  orderId: "order-1",
  channel: { slug: "sim-market", displayName: "Simulator market", status: "active" },
  ingest: {
    ledgerId: "ledger-1",
    status: "done",
    externalOrderRef: "SIM-1001",
    externalOrderRevision: "r1",
    lastError: null,
    updatedAt: "2026-08-14T09:00:00.000Z",
  },
  openQuarantineCount: 0,
};

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: { ok: boolean; status: number; body: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("channel operations client", () => {
  it("accepts the full answer and a storefront order alike", () => {
    expect(channelOrderOpsResponseSchema.safeParse(ok).success).toBe(true);
    expect(
      channelOrderOpsResponseSchema.safeParse({
        ...ok,
        channel: null,
        ingest: null,
      }).success,
    ).toBe(true);
  });

  it("refuses a negative drawer count", () => {
    expect(
      channelOrderOpsResponseSchema.safeParse({ ...ok, openQuarantineCount: -1 }).success,
    ).toBe(false);
  });

  it("names only the statuses where a run stopped and waits for a person", () => {
    expect(channelIngestNeedsAttention("blocked_stock")).toBe(true);
    expect(channelIngestNeedsAttention("quarantined")).toBe(true);
    expect(channelIngestNeedsAttention("failed")).toBe(true);
    expect(channelIngestNeedsAttention("done")).toBe(false);
    expect(channelIngestNeedsAttention("reserved")).toBe(false);
    // An order with no ledger row is not "in trouble"; it has no run at all.
    expect(channelIngestNeedsAttention(undefined)).toBe(false);
    expect(channelIngestNeedsAttention(null)).toBe(false);
  });

  it("sends the bearer token and the order id, and parses the envelope", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: { ok: true, data: ok } });
    await expect(getAdminChannelOrderOps("token-1", "order 1")).resolves.toEqual({
      kind: "ok",
      data: ok,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain("orderId=order%201");
    expect(init.headers.Authorization).toBe("Bearer token-1");
  });

  it("throws on a refused read rather than returning an empty panel", async () => {
    stubFetch({ ok: false, status: 403, body: { ok: false } });
    await expect(getAdminChannelOrderOps("token-1", "order-1")).rejects.toThrow(/403/);
  });

  it("throws when the envelope says ok but carries no data", async () => {
    stubFetch({ ok: true, status: 200, body: { ok: false, data: ok } });
    await expect(getAdminChannelOrderOps("token-1", "order-1")).rejects.toThrow();
  });

  // A deployment that has switched the feature off refuses every call, and that refusal is a
  // decision rather than an outage. It has to survive the trip to the caller as one.
  it("reports a switched-off deployment as disabled instead of throwing", async () => {
    stubFetch({
      ok: false,
      status: 503,
      body: {
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Channel operations are disabled",
          details: { reason: "feature_flag_disabled" },
        },
      },
    });
    await expect(getAdminChannelOrderOps("token-1", "order-1")).resolves.toEqual({
      kind: "disabled",
    });
  });

  // The whole risk of the quiet path: a real upstream failure answers 503 too, and must not be
  // mistaken for the switched-off one on the strength of the status alone.
  it("still throws on a 503 that names no reason", async () => {
    stubFetch({
      ok: false,
      status: 503,
      body: { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "Upstream is down" } },
    });
    await expect(getAdminChannelOrderOps("token-1", "order-1")).rejects.toThrow(/503/);
  });

  it("still throws on a 503 that names a different reason", async () => {
    stubFetch({
      ok: false,
      status: 503,
      body: {
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Invalid channel operations response",
          details: { reason: "invalid_response" },
        },
      },
    });
    await expect(getAdminChannelOrderOps("token-1", "order-1")).rejects.toThrow(/503/);
  });
});
