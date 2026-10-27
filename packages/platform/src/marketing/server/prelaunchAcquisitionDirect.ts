import {
  PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
  prelaunchAcquisitionDetailRequestSchema,
  prelaunchAcquisitionDetailResponseSchema,
  prelaunchAcquisitionListRequestSchema,
  prelaunchAcquisitionListResponseSchema,
  type PrelaunchAcquisitionLead,
} from "../prelaunchAcquisitionSchemas.js";
import type { AcquisitionCaseProjection } from "../contracts/index.js";
import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { AcquisitionCaseFailureKind } from "../contracts/index.js";
import type { PrelaunchAcquisitionDirectDeps, AcquisitionCaseBindingResolver } from "./directPorts.js";

export function createPrelaunchAcquisitionListHandler(options: PrelaunchAcquisitionDirectDeps) {
  const { respond, authorize, resolveBinding } = options;
  const { sendBffSuccess, sendMethodNotAllowed } = respond;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const actorRef = await authorize(req, res);
    if (!actorRef) return;
    const request = prelaunchAcquisitionListRequestSchema.safeParse({
      view: first(req.query.view),
      cursor: first(req.query.cursor),
      limit: first(req.query.limit) ?? "25",
    });
    if (!request.success) return badRequest(res, respond, request.error.flatten());
    const binding = await bindingOrError(res, respond, resolveBinding);
    if (!binding) return;
    const result = await operationOrError(res, respond, () => binding.handlers.list(actorRef, {
      view: "acquisition_case_v1",
      ...(request.data.cursor ? { cursor: request.data.cursor } : {}),
      limit: request.data.limit,
    }));
    if (!result) return;
    if (result.ok === false) return failure(res, respond, result.error.kind);
    const response = prelaunchAcquisitionListResponseSchema.safeParse({
      contractVersion: PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
      leads: result.value.cases.map(toLead),
      nextCursor: result.value.nextCursor,
    });
    if (!response.success) return invalidResponse(res, respond);
    sendBffSuccess(res, response.data);
  };
}

export function createPrelaunchAcquisitionDetailHandler(options: PrelaunchAcquisitionDirectDeps) {
  const { respond, authorize, resolveBinding } = options;
  const { sendBffSuccess, sendMethodNotAllowed } = respond;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const actorRef = await authorize(req, res);
    if (!actorRef) return;
    const request = prelaunchAcquisitionDetailRequestSchema.safeParse({
      sourceRef: first(req.query.sourceRef),
    });
    if (!request.success) return badRequest(res, respond, request.error.flatten());
    const binding = await bindingOrError(res, respond, resolveBinding);
    if (!binding) return;
    const result = await operationOrError(res, respond, () => binding.handlers.get(actorRef, request.data.sourceRef));
    if (!result) return;
    if (result.ok === false) return failure(res, respond, result.error.kind);
    const response = prelaunchAcquisitionDetailResponseSchema.safeParse({
      contractVersion: PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
      lead: toLead(result.value),
    });
    if (!response.success) return invalidResponse(res, respond);
    sendBffSuccess(res, response.data);
  };
}

function toLead(value: AcquisitionCaseProjection): PrelaunchAcquisitionLead {
  return {
    sourceRef: value.caseRef,
    contactRef: value.contactRef,
    sourceKind: value.sourceKind,
    consent: value.consent,
    addressReference: value.addressReference,
    state: value.state,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

async function bindingOrError(res: HttpResponse, respond: BffResponder, resolve: AcquisitionCaseBindingResolver) {
  try {
    const binding = await resolve();
    if (binding) return binding;
  } catch { /* fail closed below */ }
  respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Prelaunch acquisition service unavailable");
  return null;
}

async function operationOrError<T>(res: HttpResponse, respond: BffResponder, operation: () => Promise<T>): Promise<T | null> {
  try { return await operation(); }
  catch {
    respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Prelaunch acquisition service unavailable");
    return null;
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function badRequest(res: HttpResponse, respond: BffResponder, details?: unknown): void {
  respond.sendBffError(res, "BAD_REQUEST", "Invalid prelaunch acquisition request", { details });
}

function invalidResponse(res: HttpResponse, respond: BffResponder): void {
  respond.sendBffError(res, "INVALID_RESPONSE", "Prelaunch acquisition returned invalid response");
}

function failure(res: HttpResponse, respond: BffResponder, kind: AcquisitionCaseFailureKind): void {
  if (kind === "invalid") return badRequest(res, respond);
  if (kind === "not_found") return respond.sendBffError(res, "NOT_FOUND", "Prelaunch acquisition case not found");
  if (kind === "conflict") return respond.sendBffError(res, "CONFLICT", "Prelaunch acquisition request conflicts with prior state");
  if (kind === "rate_limited") return respond.sendBffError(res, "RATE_LIMITED", "Prelaunch acquisition request rate limited");
  respond.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Prelaunch acquisition service unavailable");
}
