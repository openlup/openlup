import { createAcquisitionSurveySubmitDirectHandler, createAcquisitionSurveyListDirectHandler, createAcquisitionNewsletterConsentDirectHandler } from "@openlup/platform/marketing/server";
import { bffResponder } from "../../../_lib/bff/response.js";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";
import { authorizeAcquisitionCaseAdmin } from "../../clients/acquisitionCaseDirect.js";
import { getBundleDescriptor, resolveBundleId } from "../../../domains/platform-runtime/platformKernel.js";
import { resolveAcquisitionEvidenceBinding } from "../../../runtime/marketing/acquisitionEvidenceBinding.js";
type Env = Record<string, string | undefined>;

export function isDirectAcquisitionEvidenceBundle(env: Env = process.env): boolean {
  return getBundleDescriptor(resolveBundleId(env)).capabilities.data === "postgres";
}

export function isAcquisitionSurveyView(req: HttpRequest): boolean {
  return (object(req.body)?.view ?? first(req.query.view)) === "acquisition_survey_v1";
}

function dependencies(env: Env) {
  return {
    respond: bffResponder,
    authorize: (req: HttpRequest, res: HttpResponse) => authorizeAcquisitionCaseAdmin(req, res, env),
    resolveBinding: () => resolveAcquisitionEvidenceBinding(env),
  };
}
export async function handleAcquisitionSurveySubmit(req: HttpRequest, res: HttpResponse, env: Env = process.env): Promise<void> {
  return createAcquisitionSurveySubmitDirectHandler(dependencies(env))(req, res);
}
export async function handleAcquisitionSurveyList(req: HttpRequest, res: HttpResponse, env: Env = process.env): Promise<void> {
  return createAcquisitionSurveyListDirectHandler(dependencies(env))(req, res);
}
export async function handleAcquisitionNewsletterConsent(value: unknown, res: HttpResponse, env: Env = process.env): Promise<void> {
  return createAcquisitionNewsletterConsentDirectHandler(dependencies(env))(value, res);
}
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
