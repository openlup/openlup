import type { HttpRequest, HttpResponse } from "../../../http/index.js";
import type { BffResponder } from "../../../bff/index.js";
import {
  adminSurveyResponsesRequestSchema,
  adminSurveyResponsesResponseSchema,
} from "@openlup/core/marketing/research";
import type { MarketingResearchSurveyResponsesReadPort } from "@openlup/core/marketing/research";

export interface AdminSurveyResponsesHandlerDeps {
  respond: BffResponder;
  readPort: MarketingResearchSurveyResponsesReadPort;
  authorizeAdmin: (req: HttpRequest) => Promise<boolean>;
}

export function createAdminSurveyResponsesHandler({
  respond,
  readPort,
  authorizeAdmin,
}: AdminSurveyResponsesHandlerDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const authorized = await authorize(req, res, authorizeAdmin, respond);
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
  req: HttpRequest,
  res: HttpResponse,
  authorizeAdmin: (req: HttpRequest) => Promise<boolean>,
  respond: BffResponder,
): Promise<boolean> {
  const { sendBffError } = respond;
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
