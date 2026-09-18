import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { createCustomerDiagnosticsRoute } from "./customer-diagnostics.js";

const operatorId = "11111111-1111-4111-8111-111111111111";
const query = { mode: "search", from: "2026-09-10T00:00:00Z", to: "2026-09-11T00:00:00Z" };
function fixture({ machine = false, allowed = true, gate = true, failAudit = false, contractVersion = "customer-diagnostic-history.v1" } = {}) {
  const search = vi.fn(async () => {
    if (failAudit) throw new Error("database audit denied: private internal text");
    return contractVersion === "customer-diagnostic-history.v2"
      ? { contractVersion, segments: [], groups: [] }
      : { contractVersion, coverageVersion: "purchase-auth-account.v1", segments: [], groups: [] };
  });
  const readSegment = vi.fn().mockResolvedValue(null);
  const overview = vi.fn().mockResolvedValue({
    contractVersion: "customer-diagnostic-history.v2",
    sourceHealth: { read: "available", delivery: "unknown" },
    loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
    windowCoverage: "full", evidencePresence: "observed",
    retainedFrom: null, truncated: false, nextCursor: null, groups: [],
  });
  const resolveHistory = vi.fn(() => ({ run: async (work: (port: unknown) => unknown) => work({ search, readSegment, overview }) }));
  const authorize = vi.fn().mockResolvedValue(allowed
    ? { ok: true, principalId: operatorId, isMachineActor: machine }
    : { ok: false, code: "FORBIDDEN", message: "Forbidden" });
  const resolveAuth = () => ({ binding: { run: async (_token: unknown, work: (auth: unknown) => unknown) => work({ authorize }) } });
  const route = createCustomerDiagnosticsRoute({
    env: { COMMERCE_AGENT_CUSTOMER_READ_ENABLED: String(gate) },
    resolveAuth: resolveAuth as never, resolveHistory: resolveHistory as never,
  });
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  const req = { method: "GET", headers: { authorization: "Bearer synthetic", "x-contract-version": contractVersion }, query } as unknown as VercelRequest;
  return { route, req, res, search, readSegment, overview, authorize, resolveHistory };
}

describe("privileged customer diagnostic reads", () => {
  it.each([false, true])("returns no data when atomic audit/read fails (machine=%s)", async (machine) => {
    const f = fixture({ machine, failAudit: true });
    await f.route(f.req, f.res);
    expect(f.res.status).toHaveBeenCalledWith(503);
    expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ details: { reason: "audit_unavailable" } }) }));
    expect(JSON.stringify(vi.mocked(f.res.json).mock.calls)).not.toContain("private internal");
  });
  it("checks admin and machine gate before opening diagnostic storage", async () => {
    for (const options of [{ allowed: false }, { machine: true, gate: false }]) {
      const f = fixture(options);
      await f.route(f.req, f.res);
      expect(f.resolveHistory).not.toHaveBeenCalled();
      expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    }
  });
  it("defaults absent contract selection to the retained v1 shape and RPC", async () => {
    const f = fixture();
    delete (f.req.headers as Record<string, string>)["x-contract-version"];
    await f.route(f.req, f.res);
    expect(f.search).toHaveBeenCalledWith({ mode: "search", contractVersion: "customer-diagnostic-history.v1", windowStart: query.from, windowEnd: query.to, pageSize: 10, operatorId });
    expect(f.res.status).toHaveBeenCalledWith(200);
    expect(f.res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
  it("passes the explicit mixed-history v2 contract through to the read port and response", async () => {
    const f = fixture({ contractVersion: "customer-diagnostic-history.v2" });
    await f.route(f.req, f.res);
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ contractVersion: "customer-diagnostic-history.v2", operatorId }));
    expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ contractVersion: "customer-diagnostic-history.v2" }),
    }));
  });
  it("requires v2 before binding diagnostic storage for the global overview", async () => {
    for (const contractVersion of [undefined, "customer-diagnostic-history.v1"]) {
      const f = fixture();
      if (contractVersion === undefined) delete (f.req.headers as Record<string, string>)["x-contract-version"];
      else f.req.headers["x-contract-version"] = contractVersion;
      f.req.query = { mode: "overview", from: query.from, to: query.to };
      await f.route(f.req, f.res);
      expect(f.resolveHistory).not.toHaveBeenCalled();
      expect(f.res.status).toHaveBeenCalledWith(400);
    }
  });
  it("reads the global overview through the explicit v2 contract", async () => {
    const f = fixture({ contractVersion: "customer-diagnostic-history.v2" });
    f.req.query = { mode: "overview", from: query.from, to: query.to, pageSize: "5", cursor: "10" };
    await f.route(f.req, f.res);
    expect(f.overview).toHaveBeenCalledWith({
      contractVersion: "customer-diagnostic-history.v2", windowStart: query.from, windowEnd: query.to,
      pageSize: 5, cursor: "10", operatorId,
    });
    expect(f.res.status).toHaveBeenCalledWith(200);
    expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contractVersion: "customer-diagnostic-history.v2" }),
      meta: expect.objectContaining({ contractVersion: "customer-diagnostic-history.v2" }),
    }));
  });
  it("rejects a non-numeric overview cursor before authentication or diagnostic binding", async () => {
    const f = fixture({ contractVersion: "customer-diagnostic-history.v2" });
    f.req.query = { mode: "overview", from: query.from, to: query.to, cursor: "opaque" };
    await f.route(f.req, f.res);
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.resolveHistory).not.toHaveBeenCalled();
    expect(f.res.status).toHaveBeenCalledWith(400);
  });
  it("returns an exhausted overview page as observed evidence", async () => {
    const f = fixture({ contractVersion: "customer-diagnostic-history.v2" });
    f.req.query = { mode: "overview", from: query.from, to: query.to, cursor: "100" };
    await f.route(f.req, f.res);
    expect(f.overview).toHaveBeenCalledWith(expect.objectContaining({ cursor: "100" }));
    expect(f.res.status).toHaveBeenCalledWith(200);
    expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ evidencePresence: "observed", groups: [] }),
    }));
  });
  it("distinguishes expired/unavailable segment from an empty successful history", async () => {
    const f = fixture();
    f.req.query = { mode: "history", segmentId: operatorId };
    await f.route(f.req, f.res);
    expect(f.readSegment).toHaveBeenCalledWith({ mode: "history", contractVersion: "customer-diagnostic-history.v1", segmentId: operatorId, pageSize: 50, operatorId });
    expect(f.res.status).toHaveBeenCalledWith(404);
  });
  it("rejects mutation methods and broad/malformed lookup before reading", async () => {
    const f = fixture();
    f.req.method = "POST";
    await f.route(f.req, f.res);
    expect(f.res.status).toHaveBeenCalledWith(405);
    f.req.method = "GET";
    f.req.query = { ...query, email: "forbidden@example.test" };
    await f.route(f.req, f.res);
    expect(f.res.status).toHaveBeenCalledWith(400);
    expect(f.resolveHistory).not.toHaveBeenCalled();
  });
  it("rejects an unsupported or repeated contract version before opening diagnostic storage", async () => {
    const f = fixture();
    f.req.headers["x-contract-version"] = "customer-diagnostic-history.v3";
    await f.route(f.req, f.res);
    expect(f.resolveHistory).not.toHaveBeenCalled();
    expect(f.res.status).toHaveBeenCalledWith(400);

    const repeated = fixture();
    repeated.req.headers["x-contract-version"] = ["customer-diagnostic-history.v1", "customer-diagnostic-history.v2"];
    await repeated.route(repeated.req, repeated.res);
    expect(repeated.resolveHistory).not.toHaveBeenCalled();
    expect(repeated.res.status).toHaveBeenCalledWith(400);
  });
});
