import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { PartnersB2BInquiryAdminPort } from "../../../src/domains/partners/ports.js";
import {
  createPartnersAdminB2BInquiryListHandler,
  createPartnersAdminB2BInquiryStatusHandler,
} from "./adminB2BInquiryHandlers.js";
import type { PartnersAdminAuthorizationResult } from "./adminAuth.js";

describe("partners admin B2B inquiry handlers", () => {
  it("lists inquiries through the shared BFF envelope", async () => {
    const inquiryPort = createPort();
    const res = createResponse();

    await createPartnersAdminB2BInquiryListHandler({
      inquiryPort,
      authorizeAdmin: authorize(),
    })(request("GET", { status: "new", search: "Acme", page: "1", pageSize: "50" }), res);

    expect(inquiryPort.listB2BInquiries).toHaveBeenCalledWith({
      status: "new",
      search: "Acme",
      page: 1,
      pageSize: 50,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { inquiries: [b2bInquiry()], totalCount: 1, newCount: 1 },
    });
  });

  it("updates inquiry status through the shared BFF envelope", async () => {
    const inquiryPort = createPort();
    const res = createResponse();

    await createPartnersAdminB2BInquiryStatusHandler({
      inquiryPort,
      authorizeAdmin: authorize(),
    })(request("POST", {}, { id: "inq-1", status: "qualified" }), res);

    expect(inquiryPort.updateB2BInquiryStatus).toHaveBeenCalledWith({
      id: "inq-1",
      status: "qualified",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { updated: true },
    });
  });

  it("rejects unsupported methods, invalid payloads, and non-admin users", async () => {
    const method = createResponse();
    await createPartnersAdminB2BInquiryListHandler({
      inquiryPort: createPort(),
      authorizeAdmin: authorize(),
    })(request("POST"), method);

    const invalid = createResponse();
    await createPartnersAdminB2BInquiryStatusHandler({
      inquiryPort: createPort(),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { id: "inq-1", status: "invented" }), invalid);

    const unauthorized = createResponse();
    await createPartnersAdminB2BInquiryListHandler({
      inquiryPort: createPort(),
      authorizeAdmin: authorize({ ok: false, code: "UNAUTHORIZED", message: "Admin session required" }),
    })(request("GET"), unauthorized);

    const forbidden = createResponse();
    await createPartnersAdminB2BInquiryStatusHandler({
      inquiryPort: createPort(),
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
    })(request("POST", {}, { id: "inq-1", status: "qualified" }), forbidden);

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(forbidden.status).toHaveBeenCalledWith(403);
  });

  it("maps authorization, invalid output, and upstream failures", async () => {
    const authFailed = createResponse();
    await createPartnersAdminB2BInquiryListHandler({
      inquiryPort: createPort(),
      authorizeAdmin: vi.fn().mockRejectedValue(new Error("Auth unavailable")),
    })(request("GET"), authFailed);

    const invalid = createResponse();
    await createPartnersAdminB2BInquiryListHandler({
      inquiryPort: createPort({ inquiries: [{ ...b2bInquiry(), id: "" }], totalCount: 1, newCount: 1 }),
      authorizeAdmin: authorize(),
    })(request("GET"), invalid);

    const failed = createResponse();
    await createPartnersAdminB2BInquiryStatusHandler({
      inquiryPort: createPort(new Error("DB unavailable")),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { id: "inq-1", status: "qualified" }), failed);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function request(method: string, query = {}, body?: unknown): VercelRequest {
  return { method, query, body } as unknown as VercelRequest;
}

function authorize(
  result: PartnersAdminAuthorizationResult = { ok: true },
): () => Promise<PartnersAdminAuthorizationResult> {
  return vi.fn().mockResolvedValue(result);
}

function createPort(result?: unknown): PartnersB2BInquiryAdminPort {
  return {
    listB2BInquiries: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? { inquiries: [b2bInquiry()], totalCount: 1, newCount: 1 };
    }),
    updateB2BInquiryStatus: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? { updated: true };
    }),
  };
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

function b2bInquiry() {
  return {
    id: "inq-1",
    created_at: "2026-05-01T10:00:00.000Z",
    company: "Acme Foods",
    website: "https://acme.example",
    country: "DE",
    company_type: "Brand",
    revenue_bucket: "1M-5M",
    first_name: "Anna",
    last_name: "Nowak",
    business_email: "anna@acme.example",
    phone: "+48123",
    interests: ["private label"],
    notes: "Interested",
    ip_hash: "hash",
    pipedrive_deal_id: 123,
    status: "new",
  };
}
