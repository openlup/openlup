import { describe, expect, it, vi } from "vitest";
import { createSupabaseAdminSurveyResponsesPort } from "./adminSurveyResponsesPort.js";

describe("createSupabaseAdminSurveyResponsesPort", () => {
  it("reads paginated producer survey responses with total count", async () => {
    const client = createClient({
      data: [{ id: "row-1", created_at: "2026-05-14T07:00:00.000Z", response_data: { role: "founder" } }],
      count: 12,
      error: null,
    });

    await expect(
      createSupabaseAdminSurveyResponsesPort(client).getAdminSurveyResponses({
        surveyType: "producer",
        page: 1,
        pageSize: 50,
      }),
    ).resolves.toEqual({
      rows: [{ id: "row-1", created_at: "2026-05-14T07:00:00.000Z", response_data: { role: "founder" } }],
      totalCount: 12,
      page: 1,
      pageSize: 50,
    });

    expect(client.table).toBe("survey_responses_producer");
    expect(client.operations).toEqual([
      ["select", "id, created_at, response_data", { count: "exact" }],
      ["order", "created_at", { ascending: false }],
      ["range", 50, 99],
    ]);
  });

  it("reads consumer survey responses", async () => {
    const client = createClient({ data: [], count: 0, error: null });

    await createSupabaseAdminSurveyResponsesPort(client).getAdminSurveyResponses({
      surveyType: "consumer",
      page: 0,
      pageSize: 10,
    });

    expect(client.table).toBe("survey_responses_consumer");
  });
});

function createClient(result: {
  data: unknown[] | null;
  count: number | null;
  error: { message?: string } | null;
}) {
  const state = {
    table: "",
    operations: [] as unknown[][],
    from: vi.fn((table: string) => {
      state.table = table;
      const builder = {
        select: vi.fn((columns: string, options?: Record<string, unknown>) => {
          state.operations.push(["select", columns, options]);
          return builder;
        }),
        order: vi.fn((column: string, options?: Record<string, unknown>) => {
          state.operations.push(["order", column, options]);
          return builder;
        }),
        range: vi.fn((from: number, to: number) => {
          state.operations.push(["range", from, to]);
          return builder;
        }),
        then: vi.fn((resolve: (value: typeof result) => void) => {
          resolve(result);
        }),
      };
      return builder;
    }),
  };
  return state;
}
