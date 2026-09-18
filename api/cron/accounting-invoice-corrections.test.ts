import { describe, expect, it, vi } from "vitest";

const runAccountingCron = vi.fn(async () => ({
  status: 200,
  body: { ok: true, checked: 1, updated: 1 },
}));

vi.mock("../_cron/accountingJobRunner.js", () => ({ runAccountingCron }));

describe("accounting invoice corrections cron endpoint", () => {
  it("delegates to the invoice-correction accounting cron kind", async () => {
    const { default: handler, config } = await import("./accounting-invoice-corrections.js");
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const req = { method: "POST", headers: {} };
    const res = { status };

    await handler(req as never, res as never);

    expect(config).toEqual({ maxDuration: 60 });
    expect(runAccountingCron).toHaveBeenCalledWith(req, "invoice-correction");
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true, checked: 1, updated: 1 });
  });
});
