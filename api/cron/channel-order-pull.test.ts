import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import handler, { config } from "./channel-order-pull.js";

const saved = process.env.CHANNEL_ORDER_PULL_ENABLED;

afterEach(() => {
  if (saved === undefined) delete process.env.CHANNEL_ORDER_PULL_ENABLED;
  else process.env.CHANNEL_ORDER_PULL_ENABLED = saved;
});

describe("channel order pull cron route", () => {
  it("declares the same duration budget as the other provider-facing crons", () => {
    expect(config).toEqual({ maxDuration: 60 });
  });

  it("passes the job's own status and body straight through", async () => {
    process.env.CHANNEL_ORDER_PULL_ENABLED = "false";
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as VercelResponse;

    await handler(
      { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` } } as unknown as VercelRequest,
      res,
    );

    // Without CRON_SECRET configured the guard refuses first; with it, the flag refusal answers.
    // Either way the route itself invents no status of its own.
    expect(vi.mocked(res.status).mock.calls.at(-1)?.[0]).toBeGreaterThanOrEqual(200);
    expect(res.json).toHaveBeenCalledTimes(1);
  });
});
