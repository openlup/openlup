import { beforeEach, describe, expect, it, vi } from "vitest";

// Structural request/response shapes rather than the platform's own types: this
// route only reads the request and writes status+json, and the deploy-provider
// type names are ratcheted surface tokens under api/.
type RouteRequest = { method: string; headers: Record<string, string>; query: Record<string, string> };
type RouteResponse = { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };

const runPlatformWatchdogRoute = vi.fn();
vi.mock("../../server/ops/platformWatchdog.js", () => ({
  runPlatformWatchdogRoute: (req: unknown) => runPlatformWatchdogRoute(req),
}));

const { default: handler, config } = await import("./platform-watchdog.js");
const invoke = (req: RouteRequest, res: RouteResponse) =>
  (handler as unknown as (a: unknown, b: unknown) => Promise<void>)(req, res);

function request(): RouteRequest {
  return { method: "POST", headers: {}, query: {} };
}

function createResponse(): RouteResponse {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("/api/ops/platform-watchdog", () => {
  beforeEach(() => {
    runPlatformWatchdogRoute.mockReset();
  });

  // The 2026-08-14 staging RED HOLD: at 30s the persisting tick sat on this
  // ceiling and returned a deterministic 504 that no retry could beat. The
  // cron-convention comparison lives in src/lib/platformWatchdogGuardrails.test.ts.
  it("declares the 60s function budget the persisting tick needs", () => {
    expect(config).toEqual({ maxDuration: 60 });
  });

  it("passes the request through and echoes the runner's status and body", async () => {
    const req = request();
    runPlatformWatchdogRoute.mockResolvedValue({ status: 200, body: { ok: true, firingCount: 0 } });
    const res = createResponse();

    await invoke(req, res);

    expect(runPlatformWatchdogRoute).toHaveBeenCalledWith(req);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, firingCount: 0 });
  });

  // The route is a thin adapter: it must not reinterpret a failing tick as a
  // success, so a non-200 runner result has to reach the caller unchanged.
  it("forwards a failure status without rewriting it", async () => {
    runPlatformWatchdogRoute.mockResolvedValue({ status: 502, body: { ok: false, error: "platform_watchdog_unavailable" } });
    const res = createResponse();

    await invoke(request(), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: "platform_watchdog_unavailable" });
  });
});
