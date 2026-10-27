import type { HttpRequest, HttpResponse } from "../../../http/index.js";
import type { BffResponder } from "../../../bff/index.js";
import {
  researchSurveySubmitRequestSchema,
  researchSurveySubmitResponseSchema,
} from "@openlup/core/marketing/research";
import type { MarketingResearchSurveySubmitPort } from "@openlup/core/marketing/research";

export interface ResearchSurveySubmitHandlerDeps {
  respond: BffResponder;
  submitPort: MarketingResearchSurveySubmitPort;
}

export function createResearchSurveySubmitHandler({
  respond,
  submitPort,
}: ResearchSurveySubmitHandlerDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = researchSurveySubmitRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid research survey response request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await submitPort.submitSurveyResponse(request.data, {
        headers: headersFromRequest(req),
      });
      const response = researchSurveySubmitResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Research survey submit returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Research survey submit failed");
    }
  };
}

function headersFromRequest(req: HttpRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}
