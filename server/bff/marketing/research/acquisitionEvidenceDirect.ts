import {
  acquisitionNewsletterConsentEventSchema,
  acquisitionSurveyListQuerySchema,
  acquisitionSurveySubmitSchema,
} from "../../../../src/domains/marketing/research/acquisitionEvidenceContracts.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";
import { authorizeAcquisitionCaseAdmin } from "../../clients/acquisitionCaseDirect.js";
import type { AcquisitionEvidenceFailure } from "../../../domains/marketing/research/acquisitionEvidencePorts.js";
import { getBundleDescriptor, resolveBundleId } from "../../../domains/platform-runtime/platformKernel.js";
import { resolveAcquisitionEvidenceBinding } from "../../../runtime/marketing/acquisitionEvidenceBinding.js";

type Env = Record<string, string | undefined>;

export function isDirectAcquisitionEvidenceBundle(env: Env = process.env): boolean {
  return getBundleDescriptor(resolveBundleId(env)).capabilities.data === "postgres";
}

export function isAcquisitionSurveyView(req: HttpRequest): boolean {
  return (object(req.body)?.view ?? first(req.query.view)) === "acquisition_survey_v1";
}

export async function handleAcquisitionSurveySubmit(
  req: HttpRequest, res: HttpResponse, env: Env = process.env,
): Promise<void> {
  if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
  const request = acquisitionSurveySubmitSchema.safeParse(req.body);
  const idempotencyKey = firstHeader(req.headers["idempotency-key"]);
  if (!request.success || !idempotencyKey) return badRequest(res, request.success ? undefined : request.error.flatten());
  const binding = await bindingOrError(res, env); if (!binding) return;
  const result = await safeOperation(() => binding.submitSurvey({ ...request.data, idempotencyKey }));
  if (!result) return unavailable(res);
  if (result.ok === false) return failure(res, result.error.kind);
  sendBffSuccess(res, result.value);
}

export async function handleAcquisitionSurveyList(
  req: HttpRequest, res: HttpResponse, env: Env = process.env,
): Promise<void> {
  if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
  const actorReference = await authorizeAcquisitionCaseAdmin(req, res, env); if (!actorReference) return;
  const request = acquisitionSurveyListQuerySchema.safeParse({
    view: first(req.query.view), surveyType: first(req.query.surveyType), limit: first(req.query.limit) ?? "50",
  });
  if (!request.success) return badRequest(res, request.error.flatten());
  const binding = await bindingOrError(res, env); if (!binding) return;
  const result = await safeOperation(() => binding.listSurveys({ ...request.data, actorReference }));
  if (!result) return unavailable(res);
  if (result.ok === false) return failure(res, result.error.kind);
  sendBffSuccess(res, result.value);
}

export async function handleAcquisitionNewsletterConsent(
  value: unknown, res: HttpResponse, env: Env = process.env,
): Promise<void> {
  const request = acquisitionNewsletterConsentEventSchema.safeParse(value);
  if (!request.success) return badRequest(res, request.error.flatten());
  const binding = await bindingOrError(res, env); if (!binding) return;
  const result = await safeOperation(() => binding.applyNewsletterConsent(request.data));
  if (!result) return unavailable(res);
  if (result.ok === false) return failure(res, result.error.kind);
  sendBffSuccess(res, result.value);
}

async function bindingOrError(res: HttpResponse, env: Env) {
  try { const binding = await resolveAcquisitionEvidenceBinding(env); if (binding) return binding; }
  catch { /* fail closed below */ }
  unavailable(res); return null;
}
async function safeOperation<T>(work: () => Promise<T>): Promise<T | null> {
  try { return await work(); } catch { return null; }
}
function failure(res: HttpResponse, kind: AcquisitionEvidenceFailure): void {
  if (kind === "invalid") return badRequest(res);
  if (kind === "not_found") return sendBffError(res, "NOT_FOUND", "Acquisition evidence subject not found");
  if (kind === "conflict") return sendBffError(res, "CONFLICT", "Acquisition evidence request conflicts with prior state");
  unavailable(res);
}
function badRequest(res: HttpResponse, details?: unknown): void {
  sendBffError(res, "BAD_REQUEST", "Invalid acquisition evidence request", { details });
}
function unavailable(res: HttpResponse): void {
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition evidence service unavailable");
}
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function firstHeader(value: string | string[] | undefined): string | undefined { return first(value); }
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
