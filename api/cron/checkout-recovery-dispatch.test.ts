import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import handler from "./checkout-recovery-dispatch.js";

// Thin Vercel entrypoint: it must delegate to the cron runner and forward the
// runner's {status, body} to the response. With no CRON_SECRET configured the
// runner returns 503 — we assert the entrypoint pipes that through unchanged.
describe("checkout-recovery-dispatch entrypoint", () => {
  it("forwards the cron runner's status + body to the response", async () => {
    vi.stubEnv("CRON_SECRET", ""); // force the runner's deterministic 503 path
    const json = vi.fn();
    const status = vi.fn(() => ({ json }) as unknown as VercelResponse);
    const res = { status } as unknown as VercelResponse;
    const req = { method: "GET", headers: {} } as unknown as VercelRequest;

    await handler(req, res);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    vi.unstubAllEnvs();
  });
});
