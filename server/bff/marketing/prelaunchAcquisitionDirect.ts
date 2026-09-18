import {
  PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
  PRELAUNCH_ACQUISITION_VIEW,
  prelaunchAcquisitionDetailRequestSchema,
  prelaunchAcquisitionDetailResponseSchema,
  prelaunchAcquisitionListRequestSchema,
  prelaunchAcquisitionListResponseSchema,
  type PrelaunchAcquisitionLead,
} from "../../../src/domains/marketing/prelaunch/contracts.js";
import type { AcquisitionCaseProjection } from "../../../src/domains/clients/acquisitionCaseContracts.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type * as HttpTypes from "../../_lib/types/vercel.js";
import type { AcquisitionCaseFailureKind } from "../../domains/clients/acquisitionCasePorts.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import { authorizeAcquisitionCaseAdmin } from "../clients/acquisitionCaseDirect.js";
import {
  resolveAcquisitionCaseRuntimeBinding,
  type AcquisitionCaseRuntimeBinding,
} from "../../runtime/clients/acquisitionCaseBinding.js";

type Env = Record<string, string | undefined>;
type HttpRequest = HttpTypes.VercelRequest;
type HttpResponse = HttpTypes.VercelResponse;
type BindingResolver = () => Promise<AcquisitionCaseRuntimeBinding | null>;
type Authorize = (req: HttpRequest, res: HttpResponse) => Promise<string | null>;

interface Options {
  env?: Env;
  resolveBinding?: BindingResolver;
  authorize?: Authorize;
}

export function isDirectPrelaunchAcquisitionBundle(env: Env = process.env): boolean {
  return getBundleDescriptor(resolveBundleId(env)).capabilities.data === "postgres";
}

export function isPrelaunchAcquisitionListView(req: HttpRequest): boolean {
  return first(req.query.view) === PRELAUNCH_ACQUISITION_VIEW;
}

export function isPrelaunchAcquisitionSourceRef(req: HttpRequest): boolean {
  return prelaunchAcquisitionDetailRequestSchema.safeParse({ sourceRef: first(req.query.sourceRef) }).success;
}

export function createPrelaunchAcquisitionListHandler(options: Options = {}) {
  const env = options.env ?? process.env;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const actorRef = await authorize(req, res, env, options.authorize);
    if (!actorRef) return;
    const request = prelaunchAcquisitionListRequestSchema.safeParse({
      view: first(req.query.view),
      cursor: first(req.query.cursor),
      limit: first(req.query.limit) ?? "25",
    });
    if (!request.success) return badRequest(res, request.error.flatten());
    const binding = await bindingOrError(res, options.resolveBinding ?? (() => resolveAcquisitionCaseRuntimeBinding(env)));
    if (!binding) return;
    const result = await operationOrError(res, () => binding.handlers.list(actorRef, {
      view: "acquisition_case_v1",
      ...(request.data.cursor ? { cursor: request.data.cursor } : {}),
      limit: request.data.limit,
    }));
    if (!result) return;
    if (result.ok === false) return failure(res, result.error.kind);
    const response = prelaunchAcquisitionListResponseSchema.safeParse({
      contractVersion: PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
      leads: result.value.cases.map(toLead),
      nextCursor: result.value.nextCursor,
    });
    if (!response.success) return invalidResponse(res);
    sendBffSuccess(res, response.data);
  };
}

export function createPrelaunchAcquisitionDetailHandler(options: Options = {}) {
  const env = options.env ?? process.env;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const actorRef = await authorize(req, res, env, options.authorize);
    if (!actorRef) return;
    const request = prelaunchAcquisitionDetailRequestSchema.safeParse({
      sourceRef: first(req.query.sourceRef),
    });
    if (!request.success) return badRequest(res, request.error.flatten());
    const binding = await bindingOrError(res, options.resolveBinding ?? (() => resolveAcquisitionCaseRuntimeBinding(env)));
    if (!binding) return;
    const result = await operationOrError(res, () => binding.handlers.get(actorRef, request.data.sourceRef));
    if (!result) return;
    if (result.ok === false) return failure(res, result.error.kind);
    const response = prelaunchAcquisitionDetailResponseSchema.safeParse({
      contractVersion: PRELAUNCH_ACQUISITION_CONTRACT_VERSION,
      lead: toLead(result.value),
    });
    if (!response.success) return invalidResponse(res);
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

async function authorize(
  req: HttpRequest,
  res: HttpResponse,
  env: Env,
  override?: Authorize,
): Promise<string | null> {
  return override ? override(req, res) : authorizeAcquisitionCaseAdmin(req, res, env);
}

async function bindingOrError(res: HttpResponse, resolve: BindingResolver) {
  try {
    const binding = await resolve();
    if (binding) return binding;
  } catch { /* fail closed below */ }
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Prelaunch acquisition service unavailable");
  return null;
}

async function operationOrError<T>(res: HttpResponse, operation: () => Promise<T>): Promise<T | null> {
  try { return await operation(); }
  catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Prelaunch acquisition service unavailable");
    return null;
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function badRequest(res: HttpResponse, details?: unknown): void {
  sendBffError(res, "BAD_REQUEST", "Invalid prelaunch acquisition request", { details });
}

function invalidResponse(res: HttpResponse): void {
  sendBffError(res, "INVALID_RESPONSE", "Prelaunch acquisition returned invalid response");
}

function failure(res: HttpResponse, kind: AcquisitionCaseFailureKind): void {
  if (kind === "invalid") return badRequest(res);
  if (kind === "not_found") return sendBffError(res, "NOT_FOUND", "Prelaunch acquisition case not found");
  if (kind === "conflict") return sendBffError(res, "CONFLICT", "Prelaunch acquisition request conflicts with prior state");
  if (kind === "rate_limited") return sendBffError(res, "RATE_LIMITED", "Prelaunch acquisition request rate limited");
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Prelaunch acquisition service unavailable");
}
