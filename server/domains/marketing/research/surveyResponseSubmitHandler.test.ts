import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import type { MarketingResearchSurveySubmitPort } from "../../../../src/domains/marketing/research/ports.js";
import { createResearchSurveySubmitHandler } from "./surveyResponseSubmitHandler.js";

describe("marketing research survey response submit handler", () => {
  it("submits valid survey responses through the port", async () => {
    const submitPort = createSubmitPort({ ok: true, id: "survey-1" });
    const res = createResponse();

    await createResearchSurveySubmitHandler({ submitPort })(
      request("POST", {
        surveyType: "producer",
        responseData: { screen1_role: "Founder" },
      }),
      res,
    );

    expect(submitPort.submitSurveyResponse).toHaveBeenCalledWith(
      {
        surveyType: "producer",
        responseData: { screen1_role: "Founder" },
      },
      { headers: expect.any(Headers) },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { ok: true, id: "survey-1" } });
  });

  it("rejects invalid requests and unsupported methods", async () => {
    const submitPort = createSubmitPort({ ok: true });
    const invalid = createResponse();
    await createResearchSurveySubmitHandler({ submitPort })(
      request("POST", { surveyType: "producer", responseData: {} }),
      invalid,
    );

    const method = createResponse();
    await createResearchSurveySubmitHandler({ submitPort })(request("GET", undefined), method);

    expect(submitPort.submitSurveyResponse).not.toHaveBeenCalled();
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(method.status).toHaveBeenCalledWith(405);
  });

  it("maps invalid port output and upstream failures", async () => {
    const invalid = createResponse();
    await createResearchSurveySubmitHandler({
      submitPort: createSubmitPort({ ok: true, id: "" }),
    })(request("POST", validRequest()), invalid);

    const failed = createResponse();
    await createResearchSurveySubmitHandler({
      submitPort: createSubmitPort(new Error("database unavailable")),
    })(request("POST", validRequest()), failed);

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function createSubmitPort(result: unknown): MarketingResearchSurveySubmitPort {
  return {
    submitSurveyResponse: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function validRequest() {
  return {
    surveyType: "consumer",
    responseData: { screen1_pet_type: "Dog" },
  };
}

function request(method: string, body: unknown): VercelRequest {
  return {
    method,
    body,
    headers: {
      "user-agent": "test-agent",
      "x-forwarded-for": "127.0.0.1",
    },
  } as unknown as VercelRequest;
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
