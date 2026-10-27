import { createAdminSurveyResponsesHandler as createHandler, type AdminSurveyResponsesHandlerDeps as HandlerDeps } from "@openlup/platform/marketing/server";
import { bffResponder } from "../../../_lib/bff/response.js";
export type AdminSurveyResponsesHandlerDeps = Omit<HandlerDeps, "respond">;
export function createAdminSurveyResponsesHandler(deps: AdminSurveyResponsesHandlerDeps) {
  return createHandler({ ...deps, respond: bffResponder });
}
