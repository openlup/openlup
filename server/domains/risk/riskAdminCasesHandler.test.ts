import { describe, expect, it } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createAdminRiskCaseDecisionHandler,
  createAdminRiskCaseDetailHandler,
  createAdminRiskCasesListHandler,
} from "./riskAdminCasesHandler.js";
import type { RiskAdminReadPort, RiskAdminWritePort } from "../../../src/domains/risk/ports.js";

function mockRes() {
  const out: { statusCode: number; body: Record<string, unknown> } = { statusCode: 200, body: {} };
  const res = {
    setHeader() {},
    status(code: number) { out.statusCode = code; return res; },
    json(b: Record<string, unknown>) { out.body = b; },
  };
  return { res: res as unknown as VercelResponse, out };
}

function req(method: string, extra: Partial<VercelRequest> = {}): VercelRequest {
  return { method, headers: {}, query: {}, body: {}, ...extra } as unknown as VercelRequest;
}

const okAuth = async () => ({ ok: true as const, userId: "admin-1" });
const denyAuth = async () => ({ ok: false as const, code: "UNAUTHORIZED" as const, message: "no" });
const readPort = {} as RiskAdminReadPort;
const writePort = {} as RiskAdminWritePort;

describe("admin risk cases handler guards", () => {
  it("list rejects a non-GET method", async () => {
    const { res, out } = mockRes();
    await createAdminRiskCasesListHandler({ authorizeAdmin: okAuth, riskPort: readPort })(req("POST"), res);
    expect(out.statusCode).toBe(405);
  });

  it("list blocks an unauthorized caller", async () => {
    const { res, out } = mockRes();
    await createAdminRiskCasesListHandler({ authorizeAdmin: denyAuth, riskPort: readPort })(req("GET"), res);
    expect(out.statusCode).toBeGreaterThanOrEqual(401);
  });

  it("detail rejects a non-GET method", async () => {
    const { res, out } = mockRes();
    await createAdminRiskCaseDetailHandler({ authorizeAdmin: okAuth, riskPort: readPort })(req("POST"), res);
    expect(out.statusCode).toBe(405);
  });

  it("decision rejects a non-POST method", async () => {
    const { res, out } = mockRes();
    await createAdminRiskCaseDecisionHandler({ authorizeAdmin: okAuth, riskPort: writePort, mutationsEnabled: () => true })(req("GET"), res);
    expect(out.statusCode).toBe(405);
  });

  it("decision is forbidden when mutations are disabled", async () => {
    const { res, out } = mockRes();
    await createAdminRiskCaseDecisionHandler({ authorizeAdmin: okAuth, riskPort: writePort, mutationsEnabled: () => false })(req("POST"), res);
    expect(out.statusCode).toBe(403);
  });
});
