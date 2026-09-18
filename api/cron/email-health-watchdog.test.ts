import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock("../_cron/emailHealthWatchdogJob.js", () => ({ runEmailHealthWatchdogCron: runMock }));

function createResponse() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res as unknown as VercelResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe("email-health-watchdog cron wrapper", () => {
  it("forwards the job result status and body to the response", async () => {
    runMock.mockResolvedValue({ status: 503, body: { ok: false, breaches: [{ code: "failure_ratio" }] } });
    const { default: handler } = await import("./email-health-watchdog.ts");
    const res = createResponse();

    await handler({ method: "GET", headers: {} } as unknown as VercelRequest, res);

    expect(runMock).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ ok: false, breaches: [{ code: "failure_ratio" }] });
  });
});
