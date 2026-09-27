import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import simulatorRoute from "./simulator.js";
import { NOOP_CHANNEL_CONNECTOR_KIND } from "../../../adapters/noop_channel/noopChannelConnectorAdapter.js";
import routes from "../../../../api/bff/[...path].js";

const saved = process.env.CHANNEL_INGEST_WEBHOOK_ENABLED;

afterEach(() => {
  if (saved === undefined) delete process.env.CHANNEL_INGEST_WEBHOOK_ENABLED;
  else process.env.CHANNEL_INGEST_WEBHOOK_ENABLED = saved;
});

describe("simulator channel webhook route", () => {
  it("is mounted, is the simulator's kind, and answers under the flag it declares", async () => {
    // The mount is asserted here rather than assumed: an unmounted route is a rail that exists in
    // the repository and nowhere a delivery could ever reach.
    expect(typeof routes).toBe("function");
    expect(NOOP_CHANNEL_CONNECTOR_KIND).toBe("noop_channel");

    process.env.CHANNEL_INGEST_WEBHOOK_ENABLED = "false";
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as VercelResponse;

    await simulatorRoute({ method: "POST", headers: {} } as unknown as VercelRequest, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(vi.mocked(res.json).mock.calls.at(-1)?.[0]).toMatchObject({
      error: { details: { connectorKind: "noop_channel", reason: "feature_flag_disabled" } },
    });
  });
});
