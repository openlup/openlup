import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import handler, { config } from "./customer-diagnostic-prune.js";
import {
  CUSTOMER_DIAGNOSTIC_PRUNE_BACKSTOP_HEADER,
  runCustomerDiagnosticPrune,
} from "../../server/runtime/observability/customerDiagnosticPruneRuntime.js";

vi.mock("../../server/runtime/observability/customerDiagnosticPruneRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/runtime/observability/customerDiagnosticPruneRuntime.js")>()),
  runCustomerDiagnosticPrune: vi.fn(async () => ({ status: 200, body: { ok: true, deleted: 3 } })),
}));

function response() {
  const res = { status: vi.fn(() => res), json: vi.fn() };
  return res as unknown as VercelResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function request(headers: Record<string, string | string[]> = {}, method = "POST"): VercelRequest {
  return { method, headers, query: {} } as unknown as VercelRequest;
}

describe("customer-diagnostic-prune route", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.mocked(runCustomerDiagnosticPrune).mockClear(); });

  it("keeps the single hosting duration budget the capability contract pins", () => {
    expect(config).toEqual({ maxDuration: 60 });
  });

  it("relays the shared cron guard's denials verbatim, including the poker's 503 shape", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const missingSecret = response();
    await handler(request(), missingSecret);
    expect(missingSecret.status).toHaveBeenCalledWith(503);
    expect(missingSecret.json).toHaveBeenCalledWith({ ok: false, error: "cron_secret_required" });

    vi.stubEnv("CRON_SECRET", "prune-secret");
    const wrongMethod = response();
    await handler(request({}, "DELETE"), wrongMethod);
    expect(wrongMethod.status).toHaveBeenCalledWith(405);
    expect(wrongMethod.json).toHaveBeenCalledWith({ ok: false, error: "method_not_allowed" });

    const unauthorized = response();
    await handler(request({ authorization: "Bearer wrong" }), unauthorized);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(unauthorized.json).toHaveBeenCalledWith({ ok: false, error: "unauthorized" });

    expect(runCustomerDiagnosticPrune).not.toHaveBeenCalled();
  });

  it("relays the poker's two headers — the backstop mode and its scheduler source", async () => {
    vi.stubEnv("CRON_SECRET", "prune-secret");
    const res = response();
    await handler(request({
      authorization: "Bearer prune-secret",
      [CUSTOMER_DIAGNOSTIC_PRUNE_BACKSTOP_HEADER]: ["freshness"],
      "x-scheduler-source": "github_actions_poker_schedule",
    }), res);

    expect(runCustomerDiagnosticPrune).toHaveBeenCalledWith({
      backstopMode: "freshness", schedulerSource: "github_actions_poker_schedule",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, deleted: 3 });
  });

  it("passes absent headers through as no backstop and no attribution", async () => {
    vi.stubEnv("CRON_SECRET", "prune-secret");
    vi.mocked(runCustomerDiagnosticPrune).mockResolvedValueOnce({ status: 500, body: { ok: false } });
    const res = response();
    await handler(request({ authorization: "Bearer prune-secret" }), res);

    expect(runCustomerDiagnosticPrune).toHaveBeenCalledWith({
      backstopMode: undefined, schedulerSource: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
