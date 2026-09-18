import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../../_lib/bff/response.js";
import {
  adminSurveyResponsesRequestSchema,
  adminSurveyResponsesResponseSchema,
} from "../../../../src/domains/marketing/research/contracts.js";
import type { MarketingResearchSurveyResponsesReadPort } from "../../../../src/domains/marketing/research/ports.js";

export interface AdminSurveyResponsesHandlerDeps {
  readPort: MarketingResearchSurveyResponsesReadPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createAdminSurveyResponsesHandler({
  readPort,
  authorizeAdmin,
}: AdminSurveyResponsesHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const authorized = await authorize(req, res, authorizeAdmin);
    if (!authorized) return;

    const request = adminSurveyResponsesRequestSchema.safeParse({
      surveyType: firstQueryValue(req.query.surveyType),
      page: firstQueryValue(req.query.page),
      pageSize: firstQueryValue(req.query.pageSize),
      limit: firstQueryValue(req.query.limit),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid survey responses request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await readPort.getAdminSurveyResponses(request.data);
      const response = adminSurveyResponsesResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Survey responses returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Survey responses read failed");
    }
  };
}

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>,
): Promise<boolean> {
  try {
    if (await authorizeAdmin(req)) return true;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return false;
  }

  sendBffError(res, "UNAUTHORIZED", "Admin session required");
  return false;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
