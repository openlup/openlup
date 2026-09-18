import { describe, expect, it, vi } from "vitest";
import { searchAdminClients } from "./adminClientSearchClient";

function fetcherReturning(candidates: unknown[]) {
  return vi.fn().mockResolvedValue({
    status: 200,
    json: () => Promise.resolve({
      ok: true,
      data: {
        contractVersion: "clients.customer_360.v2",
        candidates,
        totalCount: candidates.length,
        page: 0,
        pageSize: 20,
      },
    }),
  });
}

describe("searchAdminClients", () => {
  it("sends every filter as a query parameter under the admin bearer token", async () => {
    const fetcher = fetcherReturning([]);

    await searchAdminClients(
      "access-token",
      { query: "ada@example.test", page: 2, pageSize: 20, lifecycleStage: "customer" },
      { fetcher },
    );

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-token");
    const params = new URLSearchParams(url.split("?")[1]);
    expect(Object.fromEntries(params)).toEqual({
      query: "ada@example.test", page: "2", pageSize: "20", lifecycleStage: "customer",
    });
  });

  it("rejects a response that does not satisfy the portable contract", async () => {
    const fetcher = fetcherReturning([{ subject: { subjectId: "only-an-id" } }]);

    await expect(searchAdminClients(
      "access-token",
      { query: "ada", page: 0, pageSize: 20, lifecycleStage: "all" },
      { fetcher },
    )).rejects.toThrow();
  });
});
