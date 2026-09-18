import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import handler, { config } from "./outbox-prune.js";
import { runOutboxPruneCron } from "../_cron/outboxPruneJob.js";

vi.mock("../_cron/outboxPruneJob.js", () => ({
  runOutboxPruneCron: vi.fn(async () => ({ status: 202, body: { ok: true, compacted: 1 } })),
}));

describe("outbox-prune route", () => {
  it("keeps the Vercel duration budget pinned", () => {
    expect(config.maxDuration).toBe(60);
  });

  it("delegates to the prune job and writes the HTTP response", async () => {
    const req = { method: "POST", headers: {}, query: {} } as VercelRequest;
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(),
    } as unknown as VercelResponse;

    await handler(req, res);

    expect(runOutboxPruneCron).toHaveBeenCalledWith(req);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ ok: true, compacted: 1 });
  });
});
