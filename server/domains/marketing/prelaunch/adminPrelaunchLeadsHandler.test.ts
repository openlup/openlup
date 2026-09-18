import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import type { MarketingPrelaunchReadPort } from "../../../../src/domains/marketing/prelaunch/ports.js";
import { createAdminPrelaunchLeadDetailHandler, createAdminPrelaunchLeadsHandler } from "./adminPrelaunchLeadsHandler.js";

describe("marketing prelaunch admin handlers", () => {
  it("returns prelaunch leads through the shared BFF envelope", async () => {
    const readPort = createPort(response());
    const res = createResponse();

    await createAdminPrelaunchLeadsHandler({ readPort, authorizeAdmin: vi.fn().mockResolvedValue(true) })(
      request("GET", { query: "jan", source: "tester", stage: "delivered", page: "1", pageSize: "10" }),
      res,
    );

    expect(readPort.listPrelaunchLeads).toHaveBeenCalledWith({
      query: "jan",
      source: "tester",
      stage: "delivered",
      page: 1,
      pageSize: 10,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: response() });
  });

  it("rejects non-read methods, missing admin session, and invalid detail refs", async () => {
    const method = createResponse();
    await createAdminPrelaunchLeadsHandler({ readPort: createPort(response()), authorizeAdmin: vi.fn() })(
      request("POST"),
      method,
    );

    const unauthorized = createResponse();
    await createAdminPrelaunchLeadsHandler({ readPort: createPort(response()), authorizeAdmin: vi.fn().mockResolvedValue(false) })(
      request("GET"),
      unauthorized,
    );

    const invalid = createResponse();
    await createAdminPrelaunchLeadDetailHandler({ readPort: createPort(response()), authorizeAdmin: vi.fn().mockResolvedValue(true) })(
      request("GET", { sourceRef: "client:client-1" }),
      invalid,
    );

    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("maps invalid port output and upstream failures to BFF errors", async () => {
    const invalid = createResponse();
    await createAdminPrelaunchLeadsHandler({ readPort: createPort({ contractVersion: "bad" }), authorizeAdmin: vi.fn().mockResolvedValue(true) })(
      request("GET"),
      invalid,
    );

    const failed = createResponse();
    await createAdminPrelaunchLeadsHandler({ readPort: createPort(new Error("Supabase unavailable")), authorizeAdmin: vi.fn().mockResolvedValue(true) })(
      request("GET"),
      failed,
    );

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function createPort(result: unknown): MarketingPrelaunchReadPort {
  return {
    listPrelaunchLeads: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    getPrelaunchLead: vi.fn().mockImplementation(async () => responseDetail()),
  };
}

function request(method: string, query: VercelRequest["query"] = {}): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function response() {
  return {
    contractVersion: "2026-07-05.marketing-prelaunch-read-model",
    leads: [],
    totalCount: 0,
    page: 1,
    pageSize: 10,
  };
}

function responseDetail() {
  return {
    contractVersion: "2026-07-05.marketing-prelaunch-read-model",
    lead: null,
  };
}
