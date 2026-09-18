import { describe, expect, it } from "vitest";
import {
  adminSurveyResponsesRequestSchema,
  adminSurveyResponsesResponseSchema,
  researchSurveySubmitRequestSchema,
  researchSurveySubmitResponseSchema,
} from "./contracts.js";

describe("marketing research survey response contracts", () => {
  it("coerces read request query params and validates response rows", () => {
    expect(
      adminSurveyResponsesRequestSchema.parse({
        surveyType: "producer",
        limit: "50",
      }),
    ).toEqual({ surveyType: "producer", page: 0, pageSize: 50 });
    expect(
      adminSurveyResponsesRequestSchema.parse({
        surveyType: "consumer",
        page: "2",
        pageSize: "25",
      }),
    ).toEqual({ surveyType: "consumer", page: 2, pageSize: 25 });

    expect(
      adminSurveyResponsesResponseSchema.parse({
        rows: [
          {
            id: "row-1",
            created_at: "2026-05-14T07:00:00.000Z",
            response_data: {
              screen1_role: "Founder",
              screen5_usage_combined: ["Food", "Treats"],
              screen13_opt_in: true,
            },
          },
        ],
        totalCount: 1,
        page: 0,
        pageSize: 50,
      }).rows[0].response_data,
    ).toMatchObject({ screen1_role: "Founder" });
  });

  it("defaults and bounds the row limit", () => {
    expect(
      adminSurveyResponsesRequestSchema.parse({ surveyType: "consumer" }),
    ).toEqual({ surveyType: "consumer", page: 0, pageSize: 50 });

    expect(
      adminSurveyResponsesRequestSchema.safeParse({
        surveyType: "producer",
        pageSize: "0",
      }).success,
    ).toBe(false);
    expect(
      adminSurveyResponsesRequestSchema.safeParse({
        surveyType: "producer",
        pageSize: "101",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown survey types and non-json response payloads", () => {
    expect(
      adminSurveyResponsesRequestSchema.safeParse({
        surveyType: "partner",
        limit: "50",
      }).success,
    ).toBe(false);

    expect(
      adminSurveyResponsesResponseSchema.safeParse({
        rows: [
          {
            id: "row-1",
            created_at: "2026-05-14T07:00:00.000Z",
            response_data: Number.NaN,
          },
        ],
        totalCount: 1,
        page: 0,
        pageSize: 50,
      }).success,
    ).toBe(false);
  });

  it("validates public survey response submissions", () => {
    expect(
      researchSurveySubmitRequestSchema.parse({
        surveyType: "producer",
        responseData: {
          screen1_role: "Founder",
          screen13_opt_in: true,
        },
      }),
    ).toEqual({
      surveyType: "producer",
      responseData: {
        screen1_role: "Founder",
        screen13_opt_in: true,
      },
    });

    expect(
      researchSurveySubmitRequestSchema.safeParse({
        surveyType: "producer",
        responseData: {},
      }).success,
    ).toBe(false);

    expect(researchSurveySubmitResponseSchema.parse({ ok: true, id: "row-1" }))
      .toEqual({ ok: true, id: "row-1" });
  });
});
