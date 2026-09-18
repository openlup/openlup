import { beforeEach, describe, expect, it, vi } from "vitest";
import { BffClientError } from "@/lib/bff/client";
import {
  getAdminMarketingPrelaunchLeadDetail,
  getAdminMarketingPrelaunchLeads,
} from "./adminPrelaunchClient";

describe("marketing prelaunch admin client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads prelaunch leads through the admin BFF route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      data: { contractVersion: "2026-07-05.marketing-prelaunch-read-model", leads: [], totalCount: 0, page: 1, pageSize: 25 },
    })));

    await expect(getAdminMarketingPrelaunchLeads("token", {
      query: "jan",
      source: "tester",
      stage: "feedback_completed",
      page: 1,
      pageSize: 25,
    })).resolves.toMatchObject({ totalCount: 0 });

    const [path, init] = vi.mocked(fetch).mock.calls[0];
    expect(path).toBe("/api/bff/admin/marketing/prelaunch/leads?page=1&pageSize=25&query=jan&source=tester&stage=feedback_completed");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
  });

  it("reads prelaunch lead detail with an encoded source ref", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      data: { contractVersion: "2026-07-05.marketing-prelaunch-read-model", lead: null },
    })));

    await expect(getAdminMarketingPrelaunchLeadDetail("token", "testers:tester-1")).resolves.toMatchObject({ lead: null });

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/bff/admin/marketing/prelaunch/leads/testers%3Atester-1");
  });

  it("surfaces invalid BFF responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      data: { contractVersion: "bad" },
    })));

    await expect(getAdminMarketingPrelaunchLeads("token")).rejects.toBeInstanceOf(BffClientError);
  });
});
