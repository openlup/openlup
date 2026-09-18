import type { VercelResponse } from "../types/vercel.js";
import { sendBffError } from "../bff/response.js";
import type { AgentReason } from "../../../src/lib/agent-domain/lifecycleRules.js";

/**
 * GENERIC AGENT-OPERABLE DOMAIN KIT — domain-neutral home (`api/_lib/admin-domain/`).
 *
 * The RPC-error → BFF-envelope map shared by every agent-operable domain. The
 * service-role write RPC is the rule authority; this only translates the
 * SQLSTATE it RAISEd into a stable BFF code + reason. Lifted from the catalog
 * reference's `sendCatalogError`/`CatalogRpcError`.
 *
 * Neutral home: imports nothing from `src/domains/*` / `api/domains/*`.
 */

/**
 * Error carrying the Postgres SQLSTATE + message a write RPC RAISEd, so the
 * handler can map it to the BFF envelope (42501 → FORBIDDEN, P0001 →
 * CONFLICT/rule, P0002 → NOT_FOUND, 23505 → already-exists). A domain's
 * `CatalogRpcError`-style class extends this so the map handles it uniformly.
 */
export class DomainRpcError extends Error {
  constructor(
    readonly sqlstate: string | undefined,
    readonly pgMessage: string,
    /** Optional named token a RAISE carries (e.g. `publish_requires_human`). */
    readonly raiseToken?: AgentReason,
  ) {
    super(pgMessage);
    this.name = "DomainRpcError";
  }
}

/**
 * Translate a thrown write-RPC error into the BFF envelope. Behaviour-identical
 * to the catalog reference's `sendCatalogError`: known SQLSTATEs map to stable
 * codes carrying `{ reason }`; everything else (and any non-RPC throw) becomes
 * `UPSTREAM_UNAVAILABLE` with the caller's `failureMessage`. A known RAISE never
 * maps to a retryable code.
 */
export function mapRpcError(
  res: VercelResponse,
  error: unknown,
  failureMessage = "Write failed",
): void {
  if (error instanceof DomainRpcError) {
    const reason = error.pgMessage;
    switch (error.sqlstate) {
      case "42501": // actor_required / actor_unknown / publish_requires_human
        sendBffError(res, "FORBIDDEN", reason, { details: { reason } });
        return;
      case "P0001": // rule violation (e.g. price_required_to_sell)
        sendBffError(res, "CONFLICT", reason, { details: { reason } });
        return;
      case "P0002": // not found (sku / product / price list)
        sendBffError(res, "NOT_FOUND", reason, { details: { reason } });
        return;
      case "23505": // unique violation (slug / sku already exists)
        sendBffError(res, "CONFLICT", "already_exists", {
          details: { reason: "already_exists" },
        });
        return;
      default:
        break;
    }
  }
  sendBffError(res, "UPSTREAM_UNAVAILABLE", failureMessage);
}
