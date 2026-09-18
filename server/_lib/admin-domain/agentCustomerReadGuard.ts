/**
 * GENERIC AGENT-OPERABLE DOMAIN KIT — domain-neutral home (`api/_lib/admin-domain/`).
 *
 * Actor-kind-aware governance for agent-operable CUSTOMER reads (clients + OMS).
 * Wave 7a. The customer read BFF routes are consumed by BOTH the human admin UI
 * and the machine MCP agent. Governance is keyed strictly on `isMachineActor`
 * (re-derived from `admin_users.is_machine_actor` upstream, never trusted from the
 * caller): humans behave EXACTLY as before — no flag gate, no masking, no audit;
 * the machine/agent path is flag-gated, PII-masked on broad search surfaces, and
 * non-repudiably audited.
 *
 * Neutral home: imports nothing from `src/domains/*` / `api/domains/*`.
 */

export const AGENT_CUSTOMER_READ_FLAG = "COMMERCE_AGENT_CUSTOMER_READ_ENABLED";

/** Reads the kill-switch for the machine/agent customer-read path. */
export function commerceAgentCustomerReadEnabled(): boolean {
  return process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED === "true";
}

/**
 * Flag gate, machine-only. Humans are never blocked (the feature flag is a
 * kill-switch for the AGENT path, not the human admin UI). A blocked machine read
 * lets the caller send the catalog-style disabled envelope (UPSTREAM_UNAVAILABLE +
 * { reason: "feature_flag_disabled", featureFlag: AGENT_CUSTOMER_READ_FLAG }).
 */
export function enforceAgentCustomerRead(input: {
  isMachineActor: boolean;
  flagEnabled: boolean;
}): { blocked: boolean } {
  return { blocked: input.isMachineActor && !input.flagEnabled };
}

/**
 * Minimal structural Supabase client — only `record_admin_audit_event` is needed.
 * Mirrors `AdminPromotionsSupabaseClient` so any service-role client satisfies it.
 */
export interface AgentAuditClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface AgentCustomerReadAuditEntry {
  actorId: string;
  route: string;
  query: Record<string, unknown>;
  customerIds: string[];
}

/**
 * Best-effort non-repudiable audit of a machine customer read through the frozen
 * `record_admin_audit_event` RPC. Records entity_type/action `customer_read`,
 * source `mcp_agent`, and the read parameters in `new_value`. Never throws — an
 * audit failure must not fail the read; it is logged via `onError`.
 *
 * Humans are NOT audited: this is only called when `isMachineActor` is true.
 */
export async function auditAgentCustomerRead(
  client: AgentAuditClient,
  entry: AgentCustomerReadAuditEntry,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    const { error } = await client.rpc("record_admin_audit_event", {
      p_actor_id: entry.actorId,
      p_action: "customer_read",
      p_source: "mcp_agent",
      p_entity_type: "customer_read",
      p_entity_id: null,
      p_old: null,
      p_new: {
        route: entry.route,
        query: entry.query,
        customer_ids: entry.customerIds,
      },
    });
    if (error) onError?.(error);
  } catch (error) {
    onError?.(error);
  }
}

// SHAPED AFTER the SQL maskers the same response already applies to a search
// preview (`commerce_oms_mask_email` / `commerce_oms_mask_phone`), so one response
// cannot show the same address or number at two redaction levels. Where the two
// disagree on HOW MUCH to reveal, these keep the stricter bound — a gate may
// deliver less than SQL, never more:
//   * local part: 1 char here, 2 in SQL;
//   * a 1-4 character input: last character here, last 3 digits in SQL.
// Both are idempotent over the SQL output, which is what lets the gate re-mask a
// preview SQL already masked.

/** email → `j***@x.com`: first local char + the domain; no local part or no domain → fully redacted. */
export function maskEmail(value: string | null | undefined): string | null {
  if (value == null) return value ?? null;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const at = trimmed.indexOf("@");
  // No domain, or an empty local part: nothing here is safe to keep.
  if (at <= 0) return "[redacted]";
  // Only the segment up to a second "@" — a malformed address must not smuggle
  // the rest of itself through the "domain" half.
  const domain = trimmed.slice(at + 1).split("@")[0];
  return `${trimmed.slice(0, 1)}***@${domain}`;
}

/** phone → `***123`: the last 3 digits only; the country prefix is not a free reveal. */
export function maskPhone(value: string | null | undefined): string | null {
  if (value == null) return value ?? null;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const digits = trimmed.replace(/\D+/g, "");
  if (!digits) return null;
  if (trimmed.length <= 4) return `***${trimmed.slice(-1)}`;
  return `***${digits.slice(-3)}`;
}

/** A candidate row carrying maskable customer PII (clients search surface). */
export interface MaskableCustomerPii {
  email?: string | null;
  phone?: string | null;
}

/**
 * Mask the email/phone on each candidate of a search result, in place-safe
 * fashion (returns a shallow-cloned result + cloned candidate rows). A no-op when
 * `mask` is false (the human path), so the human response is byte-identical.
 */
export function maskClientSearchPii<
  TCandidate extends MaskableCustomerPii,
  TResult extends { candidates: TCandidate[] },
>(result: TResult, mask: boolean): TResult {
  if (!mask) return result;
  return {
    ...result,
    candidates: result.candidates.map((candidate) => ({
      ...candidate,
      email: maskEmail(candidate.email),
      phone: maskPhone(candidate.phone),
    })),
  };
}
