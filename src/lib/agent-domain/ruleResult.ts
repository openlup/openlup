import { z } from "../validation/zod.js";

/**
 * GENERIC AGENT-OPERABLE DOMAIN KIT — domain-neutral home (`src/lib/agent-domain/`).
 *
 * Request-contract primitives shared by every agent-operable admin domain: the
 * mode/idempotency fields a mutation request carries, and the shape a pure
 * request-rule check returns. These are lifted verbatim from the catalog
 * reference (Wave 4) so a second domain reuses them instead of re-deriving them.
 *
 * Do NOT import anything from `src/domains/*` or `api/domains/*` here — the
 * `kitIsDomainNeutral` guardrail fails the build if a neutral home does.
 */

/** Who is performing the write — a human admin or a machine (agent) actor. */
export type AgentActorKind = "human" | "machine";

/**
 * Result of the pure, request-checkable rule pass. Generic over the domain's
 * rule-code union so a confused/compromised request is rejected before the RPC,
 * while the RPC stays the authority (defense-in-depth, not the boundary).
 */
export interface RuleResult<TRuleCode extends string> {
  ok: boolean;
  violations: TRuleCode[];
}

/**
 * Every mutation carries `mode` (commit | dry_run) so the same request can be
 * validated then rolled back, and an optional `idempotencyKey` so a replay
 * short-circuits to the original outcome. Spread into a domain's request schema:
 * `z.object({ ...adminModeFields, ...idempotencyKeyField, ... })`.
 */
export const adminModeFields = {
  mode: z.enum(["commit", "dry_run"]).default("commit"),
} as const;

export const idempotencyKeyField = {
  idempotencyKey: z.guid().optional(),
} as const;

/** The validated `mode` value (`"commit"` by default). */
export type AdminWriteMode = z.infer<typeof adminModeFields.mode>;

/**
 * Pagination fields a READ request carries. Query-string params arrive as strings,
 * so these coerce: `limit` is 1..100 (default 50), `offset` is ≥0 (default 0).
 * Spread into a domain's read request schema:
 * `z.object({ ...filters, ...paginationFields })`.
 */
export const paginationFields = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
} as const;
