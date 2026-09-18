import { describe, expect, it, vi } from "vitest";
import { createAdminB2BInquiryPort } from "./adminB2BInquiryPort.js";

describe("createAdminB2BInquiryPort", () => {
  it("applies pagination, status filter, search, and new-count query", async () => {
    const client = createClient({
      rows: { data: [{ id: "b2b-1", company: "Acme", status: "new" }], count: null },
      total: { data: null, count: 7 },
      newRows: { data: null, count: 3 },
    });

    await expect(
      createAdminB2BInquiryPort(client).listB2BInquiries({
        status: "new",
        search: "acme",
        page: 2,
        pageSize: 25,
      }),
    ).resolves.toEqual({
      inquiries: [{ id: "b2b-1", company: "Acme", status: "new" }],
      totalCount: 7,
      newCount: 3,
    });

    expect(client.queries.map((query) => query.operations)).toEqual([
      [
        ["select", expect.stringContaining("business_email"), undefined],
        ["order", "created_at", { ascending: false }],
        ["range", 50, 74],
        ["eq", "status", "new"],
        ["or", "company.ilike.%acme%,business_email.ilike.%acme%,first_name.ilike.%acme%,last_name.ilike.%acme%"],
      ],
      [
        ["select", "*", { count: "exact", head: true }],
        ["eq", "status", "new"],
        ["or", "company.ilike.%acme%,business_email.ilike.%acme%,first_name.ilike.%acme%,last_name.ilike.%acme%"],
      ],
      [
        ["select", "*", { count: "exact", head: true }],
        ["eq", "status", "new"],
      ],
    ]);
  });

  it("updates B2B inquiry status by id", async () => {
    const client = createClient({
      rows: { data: null, count: null },
      total: { data: null, count: null },
      newRows: { data: null, count: null },
    });

    await expect(
      createAdminB2BInquiryPort(client).updateB2BInquiryStatus({
        id: "b2b-1",
        status: "closed_lost",
      }),
    ).resolves.toEqual({ updated: true });

    expect(client.queries[0]?.operations).toEqual([
      ["update", { status: "closed_lost" }],
      ["eq", "id", "b2b-1"],
    ]);
  });
});

function createClient(results: {
  rows: QueryResult;
  total: QueryResult;
  newRows: QueryResult;
}) {
  const queued = [results.rows, results.total, results.newRows];
  const state = {
    queries: [] as Array<{ operations: unknown[][] }>,
    from: vi.fn((table: string) => {
      expect(table).toBe("b2b_inquiries");
      const query = { operations: [] as unknown[][] };
      state.queries.push(query);
      const builder = {
        select: vi.fn((columns: string, options?: Record<string, unknown>) => {
          query.operations.push(["select", columns, options]);
          return builder;
        }),
        order: vi.fn((column: string, options?: Record<string, unknown>) => {
          query.operations.push(["order", column, options]);
          return builder;
        }),
        range: vi.fn((from: number, to: number) => {
          query.operations.push(["range", from, to]);
          return builder;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          query.operations.push(["eq", column, value]);
          return builder;
        }),
        or: vi.fn((pattern: string) => {
          query.operations.push(["or", pattern]);
          return builder;
        }),
        update: vi.fn((values: Record<string, unknown>) => {
          query.operations.push(["update", values]);
          return builder;
        }),
        then: vi.fn((resolve: (result: QueryResult) => void) => {
          resolve(queued.shift() ?? { data: null, count: null, error: null });
        }),
      };
      return builder;
    }),
  };
  return state;
}

interface QueryResult {
  data: unknown;
  count: number | null;
  error?: { message?: string } | null;
}
