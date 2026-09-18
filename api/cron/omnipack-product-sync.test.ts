import { describe, expect, it, vi } from "vitest";
import handler from "./omnipack-product-sync.js";

// The route handler is a thin delegate to runOmnipackProductSyncCron. With no CRON_SECRET in the
// test env it fails closed (500), which is enough to cover the handler wiring (status + json).
describe("omnipack-product-sync route handler", () => {
  it("delegates to the cron job and writes the status + JSON body", async () => {
    const json = vi.fn();
    const status = vi.fn((_code: number) => ({ json }));
    const req = { method: "GET", headers: {}, body: {}, query: {} } as never;
    const res = { status } as never;

    await handler(req, res);

    expect(status).toHaveBeenCalledTimes(1);
    expect(typeof (status.mock.calls[0]?.[0])).toBe("number");
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: expect.any(Boolean) }));
  });
});
