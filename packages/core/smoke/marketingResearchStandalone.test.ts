import { describe, expect, it } from "vitest";
import {
  adminSurveyResponsesRequestSchema,
  adminSurveyResponsesResponseSchema,
  researchSurveySubmitRequestSchema,
  researchSurveySubmitResponseSchema,
  type MarketingResearchSurveyResponsesReadPort,
  type MarketingResearchSurveySubmitPort,
} from "@openlup/core/marketing/research";

describe("marketing research standalone surface", () => {
  it("normalizes paginated survey response reads", () => {
    expect(
      adminSurveyResponsesRequestSchema.parse({
        surveyType: "consumer",
        limit: "250",
      }),
    ).toEqual({ surveyType: "consumer", page: 0, pageSize: 100 });

    expect(
      adminSurveyResponsesResponseSchema.parse({
        rows: [
          {
            id: "response-1",
            created_at: "2026-01-01T00:00:00.000Z",
            response_data: {
              segment: "example",
              scores: [1, 2, 3],
              optedIn: false,
            },
          },
        ],
        totalCount: 1,
        page: 0,
        pageSize: 100,
      }).rows[0].response_data,
    ).toEqual({ segment: "example", scores: [1, 2, 3], optedIn: false });
  });

  it("rejects non-json values and empty submit payloads", () => {
    expect(
      adminSurveyResponsesResponseSchema.safeParse({
        rows: [
          {
            id: "response-1",
            created_at: "2026-01-01T00:00:00.000Z",
            response_data: Number.NaN,
          },
        ],
        totalCount: 1,
        page: 0,
        pageSize: 50,
      }).success,
    ).toBe(false);

    expect(
      researchSurveySubmitRequestSchema.safeParse({
        surveyType: "producer",
        responseData: {},
      }).success,
    ).toBe(false);
  });

  it("keeps read and submit ports structural", async () => {
    const readPort: MarketingResearchSurveyResponsesReadPort = {
      async getAdminSurveyResponses(request) {
        return {
          rows: [],
          totalCount: 0,
          page: request.page,
          pageSize: request.pageSize,
        };
      },
    };
    const submitPort: MarketingResearchSurveySubmitPort = {
      async submitSurveyResponse(request) {
        return { ok: true, id: `survey-${request.surveyType}` };
      },
    };

    await expect(
      readPort.getAdminSurveyResponses(
        adminSurveyResponsesRequestSchema.parse({ surveyType: "producer" }),
      ),
    ).resolves.toMatchObject({ totalCount: 0, pageSize: 50 });

    await expect(
      submitPort.submitSurveyResponse(
        researchSurveySubmitRequestSchema.parse({
          surveyType: "consumer",
          responseData: { channel: "kiosk" },
        }),
      ),
    ).resolves.toEqual(researchSurveySubmitResponseSchema.parse({
      ok: true,
      id: "survey-consumer",
    }));
  });
});
