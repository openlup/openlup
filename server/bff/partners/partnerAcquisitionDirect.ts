import {
  PARTNER_ACQUISITION_VIEW,
  partnerAcquisitionIdempotencyKeySchema,
  partnerAcquisitionListRequestSchema,
  partnerAcquisitionListResponseSchema,
  partnerAcquisitionTransitionRequestSchema,
  partnerAcquisitionTransitionResponseSchema,
  partnersB2BInquirySubmitRequestSchema,
  partnersB2BInquirySubmitResponseSchema,
} from "../../../src/domains/partners/contracts.js";
import type {
  PartnerAcquisitionFailureKind,
  PartnerAcquisitionPort,
} from "../../../src/domains/partners/ports.js";
import { readBearerToken } from "../../_lib/admin-domain/auth.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type * as HttpTypes from "../../_lib/types/vercel.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import { resolveAdminAuthBinding, type AdminAuthBindingOptions } from "../../runtime/auth/adminAuthBinding.js";
import { resolvePartnerAcquisitionBinding } from "../../runtime/partners/partnerAcquisitionBinding.js";

type Env = Record<string, string | undefined>;
type HttpRequest = HttpTypes.VercelRequest;
type HttpResponse = HttpTypes.VercelResponse;
type PortResolver = () => Promise<PartnerAcquisitionPort | null>;
interface Options {
  env?: Env;
  resolvePort?: PortResolver;
  authOptions?: AdminAuthBindingOptions;
}

export function isDirectPartnerAcquisitionBundle(env: Env = process.env): boolean {
  return getBundleDescriptor(resolveBundleId(env)).capabilities.data === "postgres";
}

export function createPartnerAcquisitionSubmitHandler(options: Options = {}) {
  const env = options.env ?? process.env;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const request = partnersB2BInquirySubmitRequestSchema.safeParse(req.body);
    const idempotencyKey = idempotency(req);
    const requesterKey = requester(req);
    if (!request.success || !idempotencyKey || !requesterKey) return badRequest(res, request.success ? undefined : request.error.flatten());
    const port = await portOrError(res, options.resolvePort ?? (() => resolvePartnerAcquisitionBinding(env)));
    if (!port) return;
    const result = await operationOrError(res, () => port.submit({
      idempotencyKey,
      requesterKey,
      policyVersion: "partner-inquiry-request-v1",
      sourcePath: "/partners/b2b-inquiries",
      acceptedAt: new Date().toISOString(),
      request: request.data,
    }));
    if (!result) return;
    if (result.ok === false) return failure(res, result.error.kind);
    const response = partnersB2BInquirySubmitResponseSchema.safeParse({
      success: true,
      id: result.value.caseRef,
    });
    if (!response.success) return invalidResponse(res);
    sendBffSuccess(res, response.data);
  };
}

export function createPartnerAcquisitionListHandler(options: Options = {}) {
  const env = options.env ?? process.env;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const actorRef = await authorize(req, res, env, options.authOptions);
    if (!actorRef) return;
    const request = partnerAcquisitionListRequestSchema.safeParse({
      view: first(req.query.view),
      cursor: first(req.query.cursor),
      limit: first(req.query.limit) ?? "25",
    });
    if (!request.success) return badRequest(res, request.error.flatten());
    const port = await portOrError(res, options.resolvePort ?? (() => resolvePartnerAcquisitionBinding(env)));
    if (!port) return;
    const result = await operationOrError(res, () => port.list({ ...request.data, actorRef }));
    if (!result) return;
    if (result.ok === false) return failure(res, result.error.kind);
    const response = partnerAcquisitionListResponseSchema.safeParse(result.value);
    if (!response.success) return invalidResponse(res);
    sendBffSuccess(res, response.data);
  };
}

export function createPartnerAcquisitionTransitionHandler(options: Options = {}) {
  const env = options.env ?? process.env;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const actorRef = await authorize(req, res, env, options.authOptions);
    if (!actorRef) return;
    const request = partnerAcquisitionTransitionRequestSchema.safeParse(req.body);
    const idempotencyKey = idempotency(req);
    if (!request.success || !idempotencyKey) return badRequest(res, request.success ? undefined : request.error.flatten());
    const port = await portOrError(res, options.resolvePort ?? (() => resolvePartnerAcquisitionBinding(env)));
    if (!port) return;
    const result = await operationOrError(res, () => port.transition({
      actorRef,
      idempotencyKey,
      request: request.data,
    }));
    if (!result) return;
    if (result.ok === false) return failure(res, result.error.kind);
    const response = partnerAcquisitionTransitionResponseSchema.safeParse({
      updated: true,
      acquisitionCase: result.value,
      replayed: result.replayed === true,
    });
    if (!response.success) return invalidResponse(res);
    sendBffSuccess(res, response.data);
  };
}

export function isPartnerAcquisitionView(req: HttpRequest): boolean {
  return first(req.query.view) === PARTNER_ACQUISITION_VIEW;
}

async function authorize(
  req: HttpRequest,
  res: HttpResponse,
  env: Env,
  authOptions: AdminAuthBindingOptions = {},
): Promise<string | null> {
  const resolved = resolveAdminAuthBinding(env, authOptions);
  if (!resolved.binding) { authUnavailable(res); return null; }
  const token = readBearerToken(req);
  try {
    const result = await resolved.binding.run(token, (auth) => auth.authorize(token, { allowedRoles: ["admin"] }));
    if (result.ok === false) { sendBffError(res, result.code, result.message); return null; }
    return result.principalId;
  } catch {
    authUnavailable(res);
    return null;
  }
}

async function portOrError(res: HttpResponse, resolve: PortResolver): Promise<PartnerAcquisitionPort | null> {
  try {
    const port = await resolve();
    if (port) return port;
  } catch { /* fail closed below */ }
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Partner acquisition service unavailable");
  return null;
}

async function operationOrError<T>(res: HttpResponse, operation: () => Promise<T>): Promise<T | null> {
  try { return await operation(); }
  catch { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Partner acquisition service unavailable"); return null; }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function header(req: HttpRequest, name: string): string | null {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? null : value?.trim() || null;
}
function idempotency(req: HttpRequest): string | null {
  const parsed = partnerAcquisitionIdempotencyKeySchema.safeParse(header(req, "idempotency-key"));
  return parsed.success ? parsed.data : null;
}
function requester(req: HttpRequest): string | null {
  const forwarded = header(req, "x-forwarded-for")?.split(",")[0]?.trim();
  const value = forwarded || req.socket?.remoteAddress?.trim().toLowerCase();
  return value ? value.slice(0, 64) : null;
}
function badRequest(res: HttpResponse, details?: unknown): void {
  sendBffError(res, "BAD_REQUEST", "Invalid partner acquisition request", { details });
}
function authUnavailable(res: HttpResponse): void {
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
}
function invalidResponse(res: HttpResponse): void {
  sendBffError(res, "INVALID_RESPONSE", "Partner acquisition returned invalid response");
}
function failure(res: HttpResponse, kind: PartnerAcquisitionFailureKind): void {
  if (kind === "invalid") return badRequest(res);
  if (kind === "conflict") return sendBffError(res, "CONFLICT", "Partner acquisition conflicts with prior state");
  if (kind === "rate_limited") return sendBffError(res, "RATE_LIMITED", "Partner acquisition rate limited");
  if (kind === "not_found") return sendBffError(res, "NOT_FOUND", "Partner acquisition case not found");
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Partner acquisition service unavailable");
}
