import { describe, expect, it, vi } from "vitest";
import { BffClientError } from "@/lib/bff/client";
import { getAdminSurveyResponses } from "./adminSurveyResponsesClient";

describe("admin survey responses marketing research client", () => {
  it("reads survey rows with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            rows: [row()],
            totalCount: 1,
            page: 1,
            pageSize: 50,
          },
        }),
    });

    await getAdminSurveyResponses(
      "admin-token",
      { surveyType: "producer", page: 1, pageSize: 50 },
      { fetcher },
    );

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/api/bff/admin/marketing/research/survey-responses?surveyType=producer&page=1&pageSize=50",
    );
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
  });

  it("throws typed BFF errors and rejects malformed envelopes", async () => {
    const errorFetcher = vi.fn().mockResolvedValue({
      status: 401,
      json: () =>
        Promise.resolve({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Admin session required" },
        }),
    });

    await expect(
      getAdminSurveyResponses("admin-token", { surveyType: "consumer" }, { fetcher: errorFetcher }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const malformedFetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            rows: [{ ...row(), response_data: Number.NaN }],
            totalCount: 1,
            page: 0,
            pageSize: 50,
          },
        }),
    });

    await expect(
      getAdminSurveyResponses("admin-token", { surveyType: "producer" }, { fetcher: malformedFetcher }),
    ).rejects.toBeInstanceOf(BffClientError);
  });
});

function row() {
  return {
    id: "row-1",
    created_at: "2026-05-14T07:00:00.000Z",
    response_data: { screen1_role: "Founder" },
  };
}
