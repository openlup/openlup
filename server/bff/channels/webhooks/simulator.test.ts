import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import simulatorRoute from "./simulator.js";
import { NOOP_CHANNEL_CONNECTOR_KIND } from "../../../adapters/noop_channel/noopChannelConnectorAdapter.js";
import { routes } from "../../../../api/bff/[...path].js";

const saved = process.env.CHANNEL_INGEST_WEBHOOK_ENABLED;

afterEach(() => {
  if (saved === undefined) delete process.env.CHANNEL_INGEST_WEBHOOK_ENABLED;
  else process.env.CHANNEL_INGEST_WEBHOOK_ENABLED = saved;
});

describe("simulator channel webhook route", () => {
  it("has no default mount and refuses before ingesting request data", async () => {
    expect(routes).toEqual([]);
    expect(NOOP_CHANNEL_CONNECTOR_KIND).toBe("noop_channel");

    process.env.CHANNEL_INGEST_WEBHOOK_ENABLED = "false";
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as VercelResponse;

    const touched = vi.fn(() => { throw new Error("ingest body read"); });
    const req = { method: "POST", headers: {} };
    Object.defineProperty(req, "body", { get: touched });
    await simulatorRoute(req as unknown as VercelRequest, res);
    expect(touched).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(503);
    expect(vi.mocked(res.json).mock.calls.at(-1)?.[0]).toMatchObject({
      error: { details: { reason: "adopter_policy_required" } },
    });
  });
});
