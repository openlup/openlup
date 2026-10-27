import { createResearchSurveySubmitHandler as createHandler, type ResearchSurveySubmitHandlerDeps as HandlerDeps } from "@openlup/platform/marketing/server";
import { bffResponder } from "../../../_lib/bff/response.js";
export type ResearchSurveySubmitHandlerDeps = Omit<HandlerDeps, "respond">;
export function createResearchSurveySubmitHandler(deps: ResearchSurveySubmitHandlerDeps) {
  return createHandler({ ...deps, respond: bffResponder });
}
