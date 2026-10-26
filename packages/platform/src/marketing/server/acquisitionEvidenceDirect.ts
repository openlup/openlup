import { acquisitionNewsletterConsentEventSchema, acquisitionSurveyListQuerySchema, acquisitionSurveySubmitSchema } from "../acquisitionEvidenceSchemas.js";
import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { AcquisitionEvidenceFailure } from "../contracts/index.js";
import type { AcquisitionEvidenceDirectDeps, AcquisitionEvidenceBindingResolver } from "./directPorts.js";

export function createAcquisitionSurveySubmitDirectHandler(options: AcquisitionEvidenceDirectDeps) {
  const { respond, resolveBinding } = options;
  const { sendBffSuccess, sendMethodNotAllowed } = respond;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const request = acquisitionSurveySubmitSchema.safeParse(req.body);
    const idempotencyKey = firstHeader(req.headers["idempotency-key"]);
    if (!request.success || !idempotencyKey) return badRequest(res, respond, request.success ? undefined : request.error.flatten());
    const binding = await bindingOrError(res, respond, resolveBinding); if (!binding) return;
    const result = await safeOperation(() => binding.submitSurvey({ ...request.data, idempotencyKey }));
    if (!result) return unavailable(res, respond);
    if (result.ok === false) return failure(res, respond, result.error.kind);
    sendBffSuccess(res, result.value);
  };
}

export function createAcquisitionSurveyListDirectHandler(options: AcquisitionEvidenceDirectDeps) {
  const { respond, authorize, resolveBinding } = options;
  const { sendBffSuccess, sendMethodNotAllowed } = respond;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const actorReference = await authorize(req, res); if (!actorReference) return;
    const request = acquisitionSurveyListQuerySchema.safeParse({
      view: first(req.query.view), surveyType: first(req.query.surveyType), limit: first(req.query.limit) ?? "50",
    });
    if (!request.success) return badRequest(res, respond, request.error.flatten());
    const binding = await bindingOrError(res, respond, resolveBinding); if (!binding) return;
    const result = await safeOperation(() => binding.listSurveys({ ...request.data, actorReference }));
    if (!result) return unavailable(res, respond);
    if (result.ok === false) return failure(res, respond, result.error.kind);
    sendBffSuccess(res, result.value);
  };
}

export function createAcquisitionNewsletterConsentDirectHandler(options: AcquisitionEvidenceDirectDeps) {
  const { respond, resolveBinding } = options;
  const { sendBffSuccess } = respond;
  return async (value: unknown, res: HttpResponse): Promise<void> => {
    const request = acquisitionNewsletterConsentEventSchema.safeParse(value);
    if (!request.success) return badRequest(res, respond, request.error.flatten());
    const binding = await bindingOrError(res, respond, resolveBinding); if (!binding) return;
    const result = await safeOperation(() => binding.applyNewsletterConsent(request.data));
    if (!result) return unavailable(res, respond);
    if (result.ok === false) return failure(res, respond, result.error.kind);
    sendBffSuccess(res, result.value);
  };
}

async function bindingOrError(res: HttpResponse, respond: BffResponder, resolve: AcquisitionEvidenceBindingResolver) {
  try { const binding = await resolve(); if (binding) return binding; }
  catch { /* fail closed below */ }
  unavailable(res, respond); return null;
}
async function safeOperation<T>(work: () => Promise<T>): Promise<T | null> {
  try { return await work(); } catch { return null; }
}
function failure(res: HttpResponse, respond: BffResponder, kind: AcquisitionEvidenceFailure): void {
  if (kind === "invalid") return badRequest(res, respond);
  if (kind === "not_found") return respond.sendBffError(res, "NOT_FOUND", "Acquisition evidence subject not found");
  if (kind === "conflict") return respond.sendBffError(res, "CONFLICT", "Acquisition evidence request conflicts with prior state");
  unavailable(res, respond);
}
function badRequest(res: HttpResponse, respond: BffResponder, details?: unknown): void {
  respond.sendBffError(res, "BAD_REQUEST", "Invalid acquisition evidence request", { details });
}
function unavailable(res: HttpResponse, respond: BffResponder): void {
  respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition evidence service unavailable");
}
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function firstHeader(value: string | string[] | undefined): string | undefined { return first(value); }
