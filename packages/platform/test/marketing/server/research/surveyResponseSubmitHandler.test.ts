import { createBffResponder } from "../../../../src/bff/index.js";
const respond = createBffResponder();
import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../../../src/http/index.js";
import type { MarketingResearchSurveySubmitPort } from "@openlup/core/marketing/research";
import { createResearchSurveySubmitHandler } from "../../../../src/marketing/server/research/surveyResponseSubmitHandler.js";

describe("marketing research survey response submit handler", () => {
  it("submits valid survey responses through the port", async () => {
    const submitPort = createSubmitPort({ ok: true, id: "survey-1" });
    const res = createResponse();

    await createResearchSurveySubmitHandler({ respond, submitPort })(
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
    await createResearchSurveySubmitHandler({ respond, submitPort })(
      request("POST", { surveyType: "producer", responseData: {} }),
      invalid,
    );

    const method = createResponse();
    await createResearchSurveySubmitHandler({ respond, submitPort })(request("GET", undefined), method);

    expect(submitPort.submitSurveyResponse).not.toHaveBeenCalled();
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(method.status).toHaveBeenCalledWith(405);
  });

  it("maps invalid port output and upstream failures", async () => {
    const invalid = createResponse();
    await createResearchSurveySubmitHandler({ respond,
      submitPort: createSubmitPort({ ok: true, id: "" }),
    })(request("POST", validRequest()), invalid);

    const failed = createResponse();
    await createResearchSurveySubmitHandler({ respond,
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
    responseData: { response_category: "Option A" },
  };
}

function request(method: string, body: unknown): HttpRequest {
  return {
    method,
    body,
    headers: {
      "user-agent": "test-agent",
      "x-forwarded-for": "127.0.0.1",
    },
  } as unknown as HttpRequest;
}

function createResponse(): HttpResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as HttpResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
