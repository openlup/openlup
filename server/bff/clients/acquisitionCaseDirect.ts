import { createAcquisitionCaseListDirectHandler, createAcquisitionCaseActiveCountDirectHandler } from "@openlup/platform/marketing/server";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { bffResponder, sendBffError, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { readBearerToken } from "../../_lib/admin-domain/auth.js";
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

export function createAdminTesterProgramStatusDirectHandler(_options: RouteOptions = {}) {
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    // Existing portable records can still be listed; transitions cannot resume
    // a permanently ended programme.
    unavailable(res);
  };
}

export function createAdminClientsTestersDirectHandler(options: RouteOptions = {}) {
  const env = options.env ?? process.env;
  return createAcquisitionCaseListDirectHandler({
    respond: bffResponder,
    authorize: (req, res) => authorize(req, res, env, options),
    resolveBinding: () => (options.resolveBinding ?? (() => resolveAcquisitionCaseRuntimeBinding(env)))(),
    isDirect: () => direct(env),
  });
}

export function createTesterProgramActiveCountDirectHandler(options: RouteOptions = {}) {
  const env = options.env ?? process.env;
  return createAcquisitionCaseActiveCountDirectHandler({
    respond: bffResponder,
    authorize: (req, res) => authorize(req, res, env, options),
    resolveBinding: () => (options.resolveBinding ?? (() => resolveAcquisitionCaseRuntimeBinding(env)))(),
    isDirect: () => direct(env),
  });
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

function direct(env: Env): boolean { return getBundleDescriptor(resolveBundleId(env)).capabilities.data === "postgres"; }
function unavailable(res: HttpResponse): void { sendBffError(res, "NOT_FOUND", "Acquisition case unavailable"); }
function authUnavailable(res: HttpResponse): void { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed"); }
export const clientsTesterSignup = withObservedRoute({ route: "/api/bff/clients/tester-signup", domain: "clients", surface: "public", risk: "validation_mutation" }, createClientsTesterSignupDirectHandler());
export const adminClientsTesters = withObservedRoute({ route: "/api/bff/admin/clients/testers", domain: "clients", surface: "admin", risk: "read", featureFlags: ["COMMERCE_AGENT_CUSTOMER_READ_ENABLED"] }, createAdminClientsTestersDirectHandler());
export const adminTesterProgramStatus = withObservedRoute({ route: "/api/bff/admin/tester-program/status", domain: "tester-program", surface: "admin", risk: "mutation" }, createAdminTesterProgramStatusDirectHandler());
export const testerProgramActiveCount = withObservedRoute({ route: "/api/bff/tester-program/active-count", domain: "tester-program", surface: "public", risk: "read" }, createTesterProgramActiveCountDirectHandler());
