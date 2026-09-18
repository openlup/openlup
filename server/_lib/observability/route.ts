import { enforceDeploymentRoutePolicy } from "#deployment-route-policy";
import { safeDetailReason, safeDetailSupportCode } from "./safeLogDetails.js";
import type { VercelRequest, VercelResponse } from "../types/vercel.js";
import { readObservedEnvironment, type ObservedEnvironment } from "./environment.js";
import { installObservedRequestContext, readOrCreateObservedRequestContext } from "./requestContext.js";
import type { BffErrorCode } from "../../../src/lib/bff/contracts.js";

export { sanitizeObservedReason, sanitizeObservedSupportCode } from "./safeLogDetails.js";

export type ObservedRouteSurface =
  | "admin"
  | "customer"
  | "health"
  | "hidden"
  | "public"
  | "webhook";

export type ObservedRouteRisk =
  | "fail_closed"
  | "health"
  | "mutation"
  | "provider"
  | "read"
  | "validation_mutation";

export interface ObservedRouteOptions {
  route: string;
  domain: string;
  surface: ObservedRouteSurface;
  risk: ObservedRouteRisk;
  featureFlags?: readonly string[];
}

export interface ObservedRouteLog {
  level: "error" | "info";
  event: "bff_route";
  request_id: string;
  environment: ObservedEnvironment;
  route: string;
  method: string;
  status: number;
  duration_ms: number;
  domain: string;
  surface: ObservedRouteSurface;
  risk: ObservedRouteRisk;
  auth_kind: "bearer" | "none" | "unknown";
  outcome: "error" | "exception" | "success";
  error_code?: BffErrorCode;
  reason?: string;
  policy_reason?: string;
  support_code?: string;
  feature_flag_state?: Record<string, "disabled" | "enabled">;
}

interface ObservedResponseState {
  status: number | null;
  errorCode?: BffErrorCode;
  reason?: string;
  policyReason?: string;
  supportCode?: string;
  featureFlagNames: Set<string>;
}

interface BffErrorBody {
  ok?: unknown;
  error?: {
    code?: unknown;
    details?: unknown;
  };
}

type RouteHandler = (req: VercelRequest, res: VercelResponse) => void | Promise<void>;

export function withObservedRoute(
  options: ObservedRouteOptions,
  handler: RouteHandler,
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return function observedRouteHandler(
    req: VercelRequest,
    res: VercelResponse,
  ): Promise<void> {
    installObservedRequestContext(req, res);
    const startedAt = Date.now();
    const state: ObservedResponseState = {
      status: readInitialStatus(res),
      featureFlagNames: new Set(options.featureFlags ?? []),
    };
    observeResponse(res, state);

    try {
      if (!enforceDeploymentRoutePolicy(options, req, res)) {
        emitRouteLog(options, req, state, startedAt, "success");
        return Promise.resolve();
      }

      const result = handler(req, res);
      if (isPromise(result)) {
        return result.then(
          () => {
            emitRouteLog(options, req, state, startedAt, "success");
          },
          (error: unknown) => {
            if (!state.status || state.status < 500) state.status = 500;
            emitRouteLog(options, req, state, startedAt, "exception");
            throw error;
          },
        );
      }
      emitRouteLog(options, req, state, startedAt, "success");
      return Promise.resolve();
    } catch (error) {
      if (!state.status || state.status < 500) state.status = 500;
      emitRouteLog(options, req, state, startedAt, "exception");
      return Promise.reject(error);
    }
  };
}

function observeResponse(res: VercelResponse, state: ObservedResponseState): void {
  const originalStatus = res.status;
  const originalJson = res.json;

  res.status = copyFunctionMetadata(((code: number) => {
    state.status = code;
    return originalStatus.call(res, code);
  }) as VercelResponse["status"], originalStatus);

  res.json = copyFunctionMetadata(((body: unknown) => {
    observeBody(body, state);
    return originalJson.call(res, body);
  }) as VercelResponse["json"], originalJson);

  if (typeof res.send === "function") {
    const originalSend = res.send;
    res.send = copyFunctionMetadata(((body: string | Buffer | object) => {
      observeBody(body, state);
      return originalSend.call(res, body);
    }) as VercelResponse["send"], originalSend);
  }

  if (typeof res.redirect === "function") {
    const originalRedirect = res.redirect;
    res.redirect = copyFunctionMetadata(((statusOrUrl: number | string, maybeUrl?: string) => {
      if (typeof statusOrUrl === "number") {
        state.status = statusOrUrl;
        const redirectWithStatus = originalRedirect as (
          this: VercelResponse,
          status: number,
          url: string,
        ) => VercelResponse;
        return redirectWithStatus.call(res, statusOrUrl, maybeUrl ?? "");
      }

      if (!state.status) state.status = 307;
      const redirectWithUrl = originalRedirect as (
        this: VercelResponse,
        url: string,
      ) => VercelResponse;
      return redirectWithUrl.call(res, statusOrUrl);
    }) as VercelResponse["redirect"], originalRedirect);
  }
}

function observeBody(body: unknown, state: ObservedResponseState): void {
  const errorBody = body as BffErrorBody;
  if (!errorBody || typeof errorBody !== "object" || errorBody.ok !== false) return;

  const code = errorBody.error?.code;
  if (isBffErrorCode(code)) state.errorCode = code;

  observeSafeDetails(errorBody.error?.details, state);
}

function observeSafeDetails(details: unknown, state: ObservedResponseState): void {
  if (!details || typeof details !== "object" || Array.isArray(details)) return;

  const record = details as Record<string, unknown>;
  state.supportCode = safeDetailSupportCode(record.supportCode ?? record.support_code)
    ?? state.supportCode;

  state.reason = safeDetailReason(record.reason) ?? state.reason;
  // `reason` is one string for both caller-side pricing-policy refusals, so on
  // its own it cannot say a buyer's browser sent no assignment key. Same
  // closed-set sanitizer, so an unexpected value is redacted, never published.
  state.policyReason = safeDetailReason(record.policyReason) ?? state.policyReason;

  const featureFlag = record.featureFlag;
  if (typeof featureFlag === "string" && featureFlag.trim()) {
    state.featureFlagNames.add(featureFlag);
  }

  const requiredFlags = record.requiredFlags;
  if (Array.isArray(requiredFlags)) {
    for (const flag of requiredFlags) {
      if (typeof flag === "string" && flag.trim()) state.featureFlagNames.add(flag);
    }
  }
}

function emitRouteLog(
  options: ObservedRouteOptions,
  req: VercelRequest,
  state: ObservedResponseState,
  startedAt: number,
  completion: "exception" | "success",
): void {
  const status = state.status ?? 200;
  const outcome = completion === "exception" ? "exception" : status >= 400 ? "error" : "success";
  const log: ObservedRouteLog = {
    level: completion === "exception" ? "error" : "info",
    event: "bff_route",
    request_id: readOrCreateObservedRequestContext(req).requestId,
    environment: readObservedEnvironment(process.env),
    route: options.route,
    method: req.method ?? "UNKNOWN",
    status,
    duration_ms: Math.max(0, Date.now() - startedAt),
    domain: options.domain,
    surface: options.surface,
    risk: options.risk,
    auth_kind: readAuthKind(req),
    outcome,
    ...(state.errorCode ? { error_code: state.errorCode } : {}),
    ...(state.reason ? { reason: state.reason } : {}),
    ...(state.policyReason ? { policy_reason: state.policyReason } : {}),
    ...(state.supportCode ? { support_code: state.supportCode } : {}),
    ...(state.featureFlagNames.size > 0
      ? { feature_flag_state: buildFeatureFlagState(state.featureFlagNames) }
      : {}),
  };

  const line = JSON.stringify(log);
  if (log.level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function readInitialStatus(res: VercelResponse): number | null {
  return typeof res.statusCode === "number" && res.statusCode > 0 ? res.statusCode : null;
}

function readAuthKind(req: VercelRequest): ObservedRouteLog["auth_kind"] {
  const authorization = readHeader(req, "authorization");
  if (!authorization) return "none";
  return authorization.toLowerCase().startsWith("bearer ") ? "bearer" : "unknown";
}

function readHeader(req: VercelRequest, name: string): string | null {
  const headers = req.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => entry.trim());
    return first ?? null;
  }
  return null;
}

function buildFeatureFlagState(
  featureFlagNames: Set<string>,
): Record<string, "disabled" | "enabled"> | undefined {
  if (featureFlagNames.size === 0) return undefined;

  return Object.fromEntries(
    [...featureFlagNames].sort().map((flag) => [
      flag,
      process.env[flag] === "true" ? "enabled" : "disabled",
    ]),
  );
}

function isPromise(value: void | Promise<void>): value is Promise<void> {
  return Boolean(value && typeof (value as Promise<void>).then === "function");
}

function copyFunctionMetadata<T extends object>(target: T, source: T): T {
  for (const key of Reflect.ownKeys(source)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) Object.defineProperty(target, key, descriptor);
  }
  return target;
}

function isBffErrorCode(value: unknown): value is BffErrorCode {
  return typeof value === "string" && [
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "CONFLICT",
    "RATE_LIMITED",
    "UPSTREAM_UNAVAILABLE",
    "INTERNAL",
    "INVALID_RESPONSE",
  ].includes(value);
}
