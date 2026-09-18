import { Buffer } from "node:buffer";

import {
  CUSTOMER_DIAGNOSTIC_INGEST_CONTRACT_VERSION,
  customerDiagnosticIngestRequestSchema,
} from "../../../src/domains/observability/customerJourneyDiagnostics.js";
import { isHostedRequestId } from "../../adapters/vercel/runtimeProvenance.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { acceptsReportedRequestId } from "../../_lib/observability/requestId.js";
import { readOrCreateObservedRequestContext } from "../../_lib/observability/requestContext.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  CustomerDiagnosticConflictError,
  ingestCustomerDiagnostic,
} from "../../domains/observability/customerDiagnosticHistory.js";
import {
  CustomerDiagnosticDisabledError,
  CustomerDiagnosticConfigurationError,
  CustomerDiagnosticOriginError,
  CustomerDiagnosticUnauthorizedError,
  resolveCustomerDiagnosticHistoryBinding,
  type CustomerDiagnosticHistoryBinding,
} from "../../runtime/observability/customerDiagnosticHistoryBinding.js";

const MAX_BODY_BYTES = 1_024;
type Env = Record<string, string | undefined>;

interface Options {
  env?: Env;
  resolveBinding?: (req: VercelRequest, env: Env) => CustomerDiagnosticHistoryBinding;
  createCredential?: () => string;
}

export function createCustomerDiagnosticEventsRoute(options: Options = {}) {
  const env = options.env ?? process.env;
  const resolveBinding = options.resolveBinding ?? resolveCustomerDiagnosticHistoryBinding;
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const parsed = customerDiagnosticIngestRequestSchema.safeParse(readBody(req));
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer diagnostic observation");
      return;
    }
    try {
      const binding = resolveBinding(req, env);
      const abuseKeyHash = binding.ingressAbuseKey();
      const identity = await binding.authenticateCustomer();
      const result = await binding.run((port) => ingestCustomerDiagnostic(port, withAcceptedReference(parsed.data, env), {
        ...identity,
        abuseKeyHash,
        ingestRequestId: readOrCreateObservedRequestContext(req).requestId,
      }, { createCredential: options.createCredential }));
      if (result.outcome === "rate_limited") {
        sendBffError(res, "RATE_LIMITED", "Customer diagnostics quota reached");
        return;
      }
      sendBffSuccess(res, {
        contractVersion: CUSTOMER_DIAGNOSTIC_INGEST_CONTRACT_VERSION,
        persistence: "committed" as const,
        segmentCredential: result.segmentCredential,
        deduplicated: result.deduplicated,
      });
    } catch (error) {
      if (error instanceof CustomerDiagnosticOriginError) {
        sendBffError(res, "FORBIDDEN", "Customer diagnostic origin rejected");
      } else if (error instanceof CustomerDiagnosticUnauthorizedError) {
        sendBffError(res, "UNAUTHORIZED", "Customer diagnostic authentication rejected");
      } else if (error instanceof CustomerDiagnosticConflictError) {
        sendBffError(res, "CONFLICT", "Customer diagnostic event conflicts with its prior value");
      } else if (error instanceof CustomerDiagnosticDisabledError || error instanceof CustomerDiagnosticConfigurationError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer diagnostic history unavailable");
      } else {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer diagnostic persistence unknown");
      }
    }
  };
}

type IngestRequest = ReturnType<typeof customerDiagnosticIngestRequestSchema.parse>;

/**
 * The event is always stored; only a reference outside the closed vocabulary is
 * dropped, so the browser cannot park free text in a retained diagnostic row.
 */
function withAcceptedReference(request: IngestRequest, env: Env): IngestRequest {
  if (request.relatedRequestId === undefined) return request;
  if (acceptsReportedRequestId(request.relatedRequestId, (value) => isHostedRequestId(value, env))) {
    return request;
  }
  const { relatedRequestId: _dropped, ...accepted } = request;
  return accepted;
}

function readBody(req: VercelRequest): unknown {
  const body = req.body;
  const declared = requestHeader(req, "content-length");
  if (declared.present && (!declared.value || !/^\d+$/.test(declared.value) || Number(declared.value) > MAX_BODY_BYTES)) return null;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return null;
    try { return JSON.parse(body); } catch { return null; }
  }
  try {
    const serialized = JSON.stringify(body);
    return serialized && Buffer.byteLength(serialized, "utf8") <= MAX_BODY_BYTES ? body : null;
  } catch {
    return null;
  }
}

function requestHeader(req: VercelRequest, name: string): { present: boolean; value: string | null } {
  const entry = Object.entries(req.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  if (!entry) return { present: false, value: null };
  if (typeof value === "string") return { present: true, value: value.trim() };
  if (Array.isArray(value) && value.length === 1) return { present: true, value: value[0]?.trim() ?? null };
  return { present: true, value: null };
}

export default withObservedRoute({
  route: "/api/bff/platform/customer-diagnostic-events",
  domain: "observability",
  surface: "public",
  risk: "validation_mutation",
  featureFlags: ["COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED"],
}, createCustomerDiagnosticEventsRoute());
