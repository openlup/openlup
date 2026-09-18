import type { VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import {
  AGENT_CUSTOMER_READ_FLAG,
  auditAgentCustomerRead,
  enforceAgentCustomerRead,
  maskClientSearchPii,
  type AgentAuditClient,
  type MaskableCustomerPii,
} from "../../_lib/admin-domain/agentCustomerReadGuard.js";

/**
 * Per-request governance config the clients read routes inject into each handler.
 * Wave 7a — actor-kind-aware governance for agent-operable CUSTOMER reads. When
 * absent (or the actor is human) the handler runs the unchanged human path.
 */
export interface ClientsAgentReadGovernance {
  /** Whether the agent customer-read kill-switch is on. */
  flagEnabled: boolean;
  /** Service-role client used for the best-effort audit RPC. */
  auditClient: AgentAuditClient;
  /** Sink for best-effort audit failures (defaults to console.error). */
  onAuditError?: (error: unknown) => void;
}

type Authorization = { ok: true; userId?: string; isMachineActor?: boolean };

export interface AgentCustomerReadGate {
  /** True when a machine read was blocked by the disabled flag (envelope sent). */
  blocked: boolean;
  /** True when this is a machine actor (drives masking + audit). */
  isMachine: boolean;
  /** Best-effort audit of a machine read; no-op for humans. */
  audit: (customerIds: string[]) => Promise<void>;
  /** Mask a search/list result's PII when machine; identity for humans. */
  maskSearch: <
    TCandidate extends MaskableCustomerPii,
    TResult extends { candidates: TCandidate[] },
  >(
    result: TResult,
  ) => TResult;
}

/**
 * Resolve the actor-kind-aware gate for a customer read. Sends the disabled
 * envelope itself when a machine read is blocked (caller just returns on
 * `blocked`). Humans always pass through untouched.
 */
export function applyAgentCustomerReadGate(input: {
  authorization: Authorization;
  governance: ClientsAgentReadGovernance | undefined;
  res: VercelResponse;
  route: string;
  query: Record<string, unknown>;
}): AgentCustomerReadGate {
  const { authorization, governance, res, route, query } = input;
  const isMachine = authorization.isMachineActor === true;
  const actorId = authorization.userId;

  const passthrough: AgentCustomerReadGate = {
    blocked: false,
    isMachine,
    audit: async () => {},
    maskSearch: (result) => result,
  };

  // Human actors always pass through unchanged.
  if (!isMachine) return passthrough;

  // Machine actor with no governance (service-role env absent) → fail-closed.
  // Humans are unaffected; the human admin-role gate still applies.
  if (!governance) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Agent customer reads are disabled", {
      details: { reason: "feature_flag_disabled", featureFlag: AGENT_CUSTOMER_READ_FLAG },
    });
    return { ...passthrough, blocked: true };
  }

  if (enforceAgentCustomerRead({ isMachineActor: true, flagEnabled: governance.flagEnabled }).blocked) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Agent customer reads are disabled", {
      details: { reason: "feature_flag_disabled", featureFlag: AGENT_CUSTOMER_READ_FLAG },
    });
    return { ...passthrough, blocked: true };
  }

  const onError = governance.onAuditError ?? ((error: unknown) => console.error("agent_customer_read_audit_failed", error));
  return {
    blocked: false,
    isMachine: true,
    audit: async (customerIds) => {
      if (!actorId) return;
      await auditAgentCustomerRead(governance.auditClient, { actorId, route, query, customerIds }, onError);
    },
    maskSearch: (result) => maskClientSearchPii(result, true),
  };
}

/**
 * Authorization outcome shared by every clients-admin handler.
 *
 * The `ok` branch carries the resolved `userId` + DB-derived `isMachineActor` so
 * handlers can apply actor-kind-aware governance (Wave 7a). Both are optional for
 * back-compat: a route adapter (or test) that does not forward them yields the
 * human, un-gated path (no flag gate, no masking, no audit).
 *
 * It lived in the waitlist handler until the D18 sweep. It was never
 * waitlist-scoped — generic clients-admin search and detail handlers depend on
 * it — so it lives here, inside the governance seam those handlers already
 * import, outside the excluded perimeter, keeping the published tree compiling
 * standalone under D20.
 */
export type ClientsAdminAuthorizationResult =
  | { ok: true; userId?: string; isMachineActor?: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };
