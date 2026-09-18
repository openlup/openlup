import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createAdminChannelOpsHandler,
  type AdminChannelOpsReadPort,
} from "./adminChannelOpsHandler.js";

function capture() {
  const out: { statusCode: number; body: Record<string, unknown> } = { statusCode: 200, body: {} };
  const res = {
    setHeader() {},
    status(code: number) {
      out.statusCode = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      out.body = body;
    },
  };
  return { res: res as unknown as VercelResponse, out };
}

function request(query: Record<string, unknown> = { orderId: "order-1" }, method = "GET") {
  return { method, headers: {}, query } as unknown as VercelRequest;
}

function port(overrides: Partial<AdminChannelOpsReadPort> = {}): AdminChannelOpsReadPort {
  return {
    readOrderChannel: vi.fn(async () => ({
      channelId: "channel-1",
      slug: "sim-market",
      displayName: "Simulator market",
      status: "active",
    })),
    readOrderIngest: vi.fn(async () => ({
      ledgerId: "ledger-1",
      status: "done",
      externalOrderRef: "SIM-1001",
      externalOrderRevision: "r1",
      lastError: null,
      updatedAt: "2026-08-14T09:00:00.000Z",
    })),
    countOpenQuarantine: vi.fn(async () => 3),
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    readPort: port(),
    authorizeAdmin: async () => ({ ok: true, userId: "actor-1" }),
    enabled: true,
    ...overrides,
  } as Parameters<typeof createAdminChannelOpsHandler>[0];
}

describe("admin channel operations read", () => {
  it("answers the ledger row and the drawer depth for a channel order", async () => {
    const { res, out } = capture();
    await createAdminChannelOpsHandler(deps())(request(), res);

    expect(out.statusCode).toBe(200);
    expect(out.body.data).toEqual({
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
      openQuarantineCount: 3,
    });
  });

  // A storefront order is the common case and it is not an error.
  it("answers 200 with a null channel for an order no surface sent", async () => {
    const readOrderIngest = vi.fn();
    const { res, out } = capture();
    await createAdminChannelOpsHandler(
      deps({ readPort: port({ readOrderChannel: vi.fn(async () => null), readOrderIngest }) }),
    )(request(), res);

    expect(out.statusCode).toBe(200);
    expect((out.body.data as { channel: unknown }).channel).toBeNull();
    // And it does not go looking for a ledger row that cannot exist.
    expect(readOrderIngest).not.toHaveBeenCalled();
  });

  it("reports a channel order with no ledger row rather than smoothing it over", async () => {
    const { res, out } = capture();
    await createAdminChannelOpsHandler(
      deps({ readPort: port({ readOrderIngest: vi.fn(async () => null) }) }),
    )(request(), res);

    const data = out.body.data as { channel: unknown; ingest: unknown };
    expect(data.channel).not.toBeNull();
    expect(data.ingest).toBeNull();
  });

  it("carries the last error of a halted run", async () => {
    const { res, out } = capture();
    await createAdminChannelOpsHandler(
      deps({
        readPort: port({
          readOrderIngest: vi.fn(async () => ({
            ledgerId: "ledger-1",
            status: "blocked_stock",
            externalOrderRef: "SIM-1002",
            externalOrderRevision: null,
            lastError: "inventory_reservation_insufficient_available_stock",
            updatedAt: "2026-08-14T09:00:00.000Z",
          })),
        }),
      }),
    )(request(), res);

    const ingest = (out.body.data as { ingest: { status: string; lastError: string } }).ingest;
    expect(ingest.status).toBe("blocked_stock");
    expect(ingest.lastError).toContain("insufficient_available_stock");
  });

  it("is a read: anything but GET is refused", async () => {
    const { res, out } = capture();
    await createAdminChannelOpsHandler(deps())(request({ orderId: "order-1" }, "POST"), res);
    expect(out.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("refuses an unauthenticated caller before it reads anything", async () => {
    const readOrderChannel = vi.fn();
    const { res, out } = capture();
    await createAdminChannelOpsHandler(
      deps({ authorizeAdmin: async () => ({ ok: false }), readPort: port({ readOrderChannel }) }),
    )(request(), res);

    expect(out.statusCode).toBeGreaterThanOrEqual(400);
    expect(readOrderChannel).not.toHaveBeenCalled();
  });

  it("refuses when the ingest feature is off", async () => {
    const { res, out } = capture();
    await createAdminChannelOpsHandler(deps({ enabled: false }))(request(), res);
    expect(out.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("requires an order id", async () => {
    const { res, out } = capture();
    await createAdminChannelOpsHandler(deps())(request({}), res);
    expect(out.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("refuses to ship a response that does not satisfy its own contract", async () => {
    const { res, out } = capture();
    await createAdminChannelOpsHandler(
      deps({
        readPort: port({
          countOpenQuarantine: vi.fn(async () => -1 as unknown as number),
        }),
      }),
    )(request(), res);
    expect(out.statusCode).toBeGreaterThanOrEqual(400);
  });
});
