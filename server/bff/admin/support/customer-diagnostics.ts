import {
  customerDiagnosticHistoryContractVersionSchema,
  customerDiagnosticLookupSchema,
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1,
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2,
} from "../../../../src/domains/observability/customerJourneyDiagnostics.js";
import { readBearerToken } from "../../../_lib/admin-domain/auth.js";
import { enforceAgentCustomerRead } from "../../../_lib/admin-domain/agentCustomerReadGuard.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { resolveAdminAuthBinding } from "../../../runtime/auth/adminAuthBinding.js";
import { resolveCustomerDiagnosticHistoryBinding } from "../../../runtime/observability/customerDiagnosticHistoryBinding.js";

type Env = Record<string, string | undefined>;
export function createCustomerDiagnosticsRoute(options: {
  env?: Env;
  resolveAuth?: typeof resolveAdminAuthBinding;
  resolveHistory?: typeof resolveCustomerDiagnosticHistoryBinding;
} = {}) {
  const env = options.env ?? process.env;
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const requestedContractVersion = singleHeader(req.headers?.["x-contract-version"]);
    const contractVersion = customerDiagnosticHistoryContractVersionSchema.safeParse(
      requestedContractVersion === undefined ? CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1 : requestedContractVersion,
    );
    if (!contractVersion.success) return sendBffError(res, "BAD_REQUEST", "Unsupported diagnostic history contract version");
    const query = customerDiagnosticLookupSchema.safeParse(req.query ?? {});
    if (!query.success) return sendBffError(res, "BAD_REQUEST", "Invalid diagnostic query");
    if (query.data.mode === "overview" && contractVersion.data !== CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2) {
      return sendBffError(res, "BAD_REQUEST", "Diagnostic overview requires contract version v2");
    }
    const accessToken = readBearerToken(req);
    const auth = (options.resolveAuth ?? resolveAdminAuthBinding)(env);
    if (!auth.binding) return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Diagnostic authorization unavailable");
    try {
      await auth.binding.run(accessToken, async (port) => {
        const actor = await port.authorize(accessToken, { allowedRoles: ["admin"] });
        if (actor.ok === false) return sendBffError(res, actor.code, actor.message);
        if (enforceAgentCustomerRead({
          isMachineActor: actor.isMachineActor,
          flagEnabled: env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED === "true",
        }).blocked) return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Diagnostic machine reads disabled", {
          details: { reason: "feature_flag_disabled" },
        });
        const history = (options.resolveHistory ?? resolveCustomerDiagnosticHistoryBinding)(req, env);
        // The database checks the active operator and commits its retained audit
        // in the same transaction as the read; no best-effort audit fallback.
        const result = await history.run(async (diagnostics) => {
          if (query.data.mode === "search") {
            const { from, to, ...filters } = query.data;
            return diagnostics.search({ ...filters, contractVersion: contractVersion.data, windowStart: from, windowEnd: to, operatorId: actor.principalId });
          }
          if (query.data.mode === "overview") {
            const { from, to, mode: _mode, ...filters } = query.data;
            return diagnostics.overview({ ...filters, contractVersion: CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2, windowStart: from, windowEnd: to, operatorId: actor.principalId });
          }
          return diagnostics.readSegment({ ...query.data, contractVersion: contractVersion.data, operatorId: actor.principalId });
        });
        if (result === null) return sendBffError(res, "NOT_FOUND", "Diagnostic segment unavailable or expired");
        sendBffSuccess(res, result, { contractVersion: contractVersion.data });
      });
    } catch {
      // Never leak SQL, filters, credentials, or partial data on an audit failure.
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Diagnostic read or audit unavailable", {
        details: { reason: "audit_unavailable" },
      });
    }
  };
}

function singleHeader(value: string | string[] | undefined): string | null | undefined {
  return Array.isArray(value) ? null : value;
}

export default withObservedRoute({
  route: "/api/bff/admin/support/customer-diagnostics", domain: "observability",
  surface: "admin", risk: "read",
  featureFlags: ["COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED", "COMMERCE_AGENT_CUSTOMER_READ_ENABLED"],
}, createCustomerDiagnosticsRoute());
