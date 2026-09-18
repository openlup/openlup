import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../../_lib/bff/response.js";
import {
  researchSurveySubmitRequestSchema,
  researchSurveySubmitResponseSchema,
} from "../../../../src/domains/marketing/research/contracts.js";
import type { MarketingResearchSurveySubmitPort } from "../../../../src/domains/marketing/research/ports.js";

export interface ResearchSurveySubmitHandlerDeps {
  submitPort: MarketingResearchSurveySubmitPort;
}

export function createResearchSurveySubmitHandler({
  submitPort,
}: ResearchSurveySubmitHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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

function headersFromRequest(req: VercelRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}
