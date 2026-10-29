import {
  createAdminRiskCasesListHandler as createList,
  createAdminRiskCaseDetailHandler as createDetail,
  createAdminRiskCaseDecisionHandler as createDecision,
} from "@openlup/platform/risk/server";
import { bffResponder } from "../../_lib/bff/response.js";

export function createAdminRiskCasesListHandler(deps: Omit<Parameters<typeof createList>[0], "respond">) {
  return createList({ ...deps, respond: bffResponder });
}
export function createAdminRiskCaseDetailHandler(deps: Omit<Parameters<typeof createDetail>[0], "respond">) {
  return createDetail({ ...deps, respond: bffResponder });
}
export function createAdminRiskCaseDecisionHandler(deps: Omit<Parameters<typeof createDecision>[0], "respond">) {
  return createDecision({ ...deps, respond: bffResponder });
}
