import { describe, expect, it, vi } from "vitest";
import {
  getAdminB2BInquiries,
  updateAdminB2BInquiryStatus,
} from "./adminB2BInquiryClient";

describe("admin B2B inquiry client", () => {
  it("lists inquiries with query params and admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { inquiries: [b2bInquiry()], totalCount: 1, newCount: 1 },
    }));

    await getAdminB2BInquiries(
      "admin-token",
      { status: "new", search: "Acme", page: 1, pageSize: 50 },
      { fetcher },
    );

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/partners/b2b-inquiries?status=new&search=Acme&page=1&pageSize=50");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
  });

  it("updates inquiry status with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { updated: true },
    }));

    await updateAdminB2BInquiryStatus(
      "admin-token",
      { id: "inq-1", status: "qualified" },
      { fetcher },
    );

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/partners/b2b-inquiries/status");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(init.body).toBe(JSON.stringify({ id: "inq-1", status: "qualified" }));
  });
});

function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    json: () => Promise.resolve(body),
  } as Response;
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
