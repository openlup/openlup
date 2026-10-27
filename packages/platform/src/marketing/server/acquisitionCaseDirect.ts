import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { AcquisitionCaseDirectDeps, AcquisitionCaseBindingResolver } from "./directPorts.js";
import { ACQUISITION_CASE_VIEW, acquisitionCaseActiveCountResponseSchema, acquisitionCaseListRequestSchema, acquisitionCaseListResponseSchema } from "../acquisitionCaseSchemas.js";
import type { AcquisitionCaseFailureKind } from "../contracts/index.js";

export function createAcquisitionCaseListDirectHandler(options: AcquisitionCaseDirectDeps) {
  const { respond, authorize, resolveBinding, isDirect } = options;
  const { sendBffSuccess, sendMethodNotAllowed } = respond;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (!isDirect() || first(req.query.view) !== ACQUISITION_CASE_VIEW) return unavailable(res, respond);
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const actorRef = await authorize(req, res);
    if (!actorRef) return;
    const request = acquisitionCaseListRequestSchema.safeParse({
      view: first(req.query.view), cursor: first(req.query.cursor), limit: integer(first(req.query.limit), 25),
    });
    if (!request.success) return badRequest(res, respond, request.error.flatten());
    const binding = await bindingOrError(res, respond, resolveBinding);
    if (!binding) return;
    const result = await operationOrError(res, respond, () => binding.handlers.list(actorRef, request.data));
    if (!result) return;
    if (result.ok === false) return failure(res, respond, result.error.kind);
    const response = acquisitionCaseListResponseSchema.safeParse(result.value);
    if (!response.success) return invalidResponse(res, respond);
    sendBffSuccess(res, response.data);
  };
}

export function createAcquisitionCaseActiveCountDirectHandler(options: AcquisitionCaseDirectDeps) {
  const { respond, resolveBinding, isDirect } = options;
  const { sendBffSuccess, sendMethodNotAllowed } = respond;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (!isDirect()) return unavailable(res, respond);
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const binding = await bindingOrError(res, respond, resolveBinding);
    if (!binding) return;
    const result = await operationOrError(res, respond, () => binding.handlers.activeCount());
    if (!result) return;
    if (result.ok === false) return failure(res, respond, result.error.kind);
    const response = acquisitionCaseActiveCountResponseSchema.safeParse(result.value);
    if (!response.success) return invalidResponse(res, respond);
    sendBffSuccess(res, response.data);
  };
}

async function bindingOrError(res: HttpResponse, respond: BffResponder, resolve: AcquisitionCaseBindingResolver) {
  try { const binding = await resolve(); if (binding) return binding; } catch { /* fail closed below */ }
  respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition case service unavailable");
  return null;
}
async function operationOrError<T>(res: HttpResponse, respond: BffResponder, operation: () => Promise<T>): Promise<T | null> {
  try { return await operation(); } catch { respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition case service unavailable"); return null; }
}
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function integer(value: string | undefined, fallback: number): number { return value === undefined ? fallback : Number(value); }
function badRequest(res: HttpResponse, respond: BffResponder, details?: unknown): void { respond.sendBffError(res, "BAD_REQUEST", "Invalid acquisition case request", { details }); }
function unavailable(res: HttpResponse, respond: BffResponder): void { respond.sendBffError(res, "NOT_FOUND", "Acquisition case unavailable"); }
function invalidResponse(res: HttpResponse, respond: BffResponder): void { respond.sendBffError(res, "INVALID_RESPONSE", "Acquisition case returned invalid response"); }
function failure(res: HttpResponse, respond: BffResponder, kind: AcquisitionCaseFailureKind): void {
  if (kind === "invalid") return badRequest(res, respond);
  if (kind === "conflict") return respond.sendBffError(res, "CONFLICT", "Acquisition case request conflicts with prior state");
  if (kind === "rate_limited") return respond.sendBffError(res, "RATE_LIMITED", "Acquisition submission rate limited");
  if (kind === "not_found") return unavailable(res, respond);
  respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition case service unavailable");
}

