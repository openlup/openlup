import { withObservedRoute } from "../../_lib/observability/route.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { readBearerToken } from "../../_lib/admin-domain/auth.js";
import {
  ACQUISITION_CASE_VIEW,
  acquisitionCaseActiveCountResponseSchema,
  acquisitionCaseListRequestSchema,
  acquisitionCaseListResponseSchema,
} from "../../../src/domains/clients/acquisitionCaseContracts.js";
import type { AcquisitionCaseFailureKind } from "../../domains/clients/acquisitionCasePorts.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import {
  resolveAdminAuthBinding,
  type AdminAuthBindingOptions,
} from "../../runtime/auth/adminAuthBinding.js";
import {
  resolveAcquisitionCaseRuntimeBinding,
  type AcquisitionCaseRuntimeBinding,
} from "../../runtime/clients/acquisitionCaseBinding.js";

type Env = Record<string, string | undefined>;
type HttpRequest = Parameters<typeof readBearerToken>[0];
type HttpResponse = Parameters<typeof sendBffError>[0];
type BindingResolver = () => Promise<AcquisitionCaseRuntimeBinding | null>;
type Authorize = (req: HttpRequest, res: HttpResponse) => Promise<string | null>;

interface RouteOptions {
  env?: Env;
  resolveBinding?: BindingResolver;
  authorize?: Authorize;
  adminAuthOptions?: AdminAuthBindingOptions;
}

export function createClientsTesterSignupDirectHandler(_options: RouteOptions = {}) {
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    // The portable acquisition admission is retired alongside the managed
    // public route. Reject before bundle selection, parsing, or binding lookup.
    unavailable(res);
  };
}

export function createAdminClientsTestersDirectHandler(options: RouteOptions = {}) {
  const env = options.env ?? process.env;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (!direct(env) || first(req.query.view) !== ACQUISITION_CASE_VIEW) return unavailable(res);
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const actorRef = await authorize(req, res, env, options);
    if (!actorRef) return;
    const request = acquisitionCaseListRequestSchema.safeParse({
      view: first(req.query.view), cursor: first(req.query.cursor), limit: integer(first(req.query.limit), 25),
    });
    if (!request.success) return badRequest(res, request.error.flatten());
    const binding = await bindingOrError(res, options.resolveBinding ?? (() => resolveAcquisitionCaseRuntimeBinding(env)));
    if (!binding) return;
    const result = await operationOrError(res, () => binding.handlers.list(actorRef, request.data));
    if (!result) return;
    if (result.ok === false) return failure(res, result.error.kind);
    const response = acquisitionCaseListResponseSchema.safeParse(result.value);
    if (!response.success) return invalidResponse(res);
    sendBffSuccess(res, response.data);
  };
}

export function createAdminTesterProgramStatusDirectHandler(_options: RouteOptions = {}) {
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    // Existing portable records can still be listed; transitions cannot resume
    // a permanently ended programme.
    unavailable(res);
  };
}

export function createTesterProgramActiveCountDirectHandler(options: RouteOptions = {}) {
  const env = options.env ?? process.env;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (!direct(env)) return unavailable(res);
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const binding = await bindingOrError(res, options.resolveBinding ?? (() => resolveAcquisitionCaseRuntimeBinding(env)));
    if (!binding) return;
    const result = await operationOrError(res, () => binding.handlers.activeCount());
    if (!result) return;
    if (result.ok === false) return failure(res, result.error.kind);
    const response = acquisitionCaseActiveCountResponseSchema.safeParse(result.value);
    if (!response.success) return invalidResponse(res);
    sendBffSuccess(res, response.data);
  };
}

async function authorize(req: HttpRequest, res: HttpResponse, env: Env, options: RouteOptions) {
  if (options.authorize) return options.authorize(req, res);
  return authorizeAcquisitionCaseAdmin(req, res, env, options.adminAuthOptions);
}

export async function authorizeAcquisitionCaseAdmin(
  req: HttpRequest,
  res: HttpResponse,
  env: Env = process.env,
  authOptions: AdminAuthBindingOptions = {},
): Promise<string | null> {
  const resolved = resolveAdminAuthBinding(env, authOptions);
  if (!resolved.binding) { authUnavailable(res); return null; }
  const token = readBearerToken(req);
  try {
    const result = await resolved.binding.run(token, (auth) => auth.authorize(token, { allowedRoles: ["admin"] }));
    if (result.ok === false) { sendBffError(res, result.code, result.message); return null; }
    return result.principalId;
  } catch { authUnavailable(res); return null; }
}

async function bindingOrError(res: HttpResponse, resolve: BindingResolver) {
  try { const binding = await resolve(); if (binding) return binding; } catch { /* fail closed below */ }
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition case service unavailable");
  return null;
}
async function operationOrError<T>(res: HttpResponse, operation: () => Promise<T>): Promise<T | null> {
  try { return await operation(); } catch { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition case service unavailable"); return null; }
}
function direct(env: Env): boolean { return getBundleDescriptor(resolveBundleId(env)).capabilities.data === "postgres"; }
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function integer(value: string | undefined, fallback: number): number { return value === undefined ? fallback : Number(value); }
function badRequest(res: HttpResponse, details?: unknown): void { sendBffError(res, "BAD_REQUEST", "Invalid acquisition case request", { details }); }
function unavailable(res: HttpResponse): void { sendBffError(res, "NOT_FOUND", "Acquisition case unavailable"); }
function authUnavailable(res: HttpResponse): void { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed"); }
function invalidResponse(res: HttpResponse): void { sendBffError(res, "INVALID_RESPONSE", "Acquisition case returned invalid response"); }
function failure(res: HttpResponse, kind: AcquisitionCaseFailureKind): void {
  if (kind === "invalid") return badRequest(res);
  if (kind === "conflict") return sendBffError(res, "CONFLICT", "Acquisition case request conflicts with prior state");
  if (kind === "rate_limited") return sendBffError(res, "RATE_LIMITED", "Acquisition submission rate limited");
  if (kind === "not_found") return unavailable(res);
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition case service unavailable");
}

export const clientsTesterSignup = withObservedRoute({ route: "/api/bff/clients/tester-signup", domain: "clients", surface: "public", risk: "validation_mutation" }, createClientsTesterSignupDirectHandler());
export const adminClientsTesters = withObservedRoute({ route: "/api/bff/admin/clients/testers", domain: "clients", surface: "admin", risk: "read", featureFlags: ["COMMERCE_AGENT_CUSTOMER_READ_ENABLED"] }, createAdminClientsTestersDirectHandler());
export const adminTesterProgramStatus = withObservedRoute({ route: "/api/bff/admin/tester-program/status", domain: "tester-program", surface: "admin", risk: "mutation" }, createAdminTesterProgramStatusDirectHandler());
export const testerProgramActiveCount = withObservedRoute({ route: "/api/bff/tester-program/active-count", domain: "tester-program", surface: "public", risk: "read" }, createTesterProgramActiveCountDirectHandler());
