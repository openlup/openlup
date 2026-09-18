import type { AgentActorKind, RuleResult } from "./ruleResult.js";

/**
 * GENERIC AGENT-OPERABLE DOMAIN KIT — domain-neutral home (`src/lib/agent-domain/`).
 *
 * The lifecycle invariants every agent-operable domain inherits, and the pure
 * predicates that encode the ONE that is decidable from the request alone
 * (a machine actor may not activate/publish). The remaining lifecycle invariants
 * — append-only price, archive-not-hard-delete, price-required-to-sell — are
 * DB-stateful and authoritatively enforced inside the service-role RPC; the kit
 * never duplicates their decision, it only names their codes and surfaces the
 * RPC's RAISE via `mapRpcError`.
 *
 * Neutral home: do NOT import from `src/domains/*` / `api/domains/*`.
 */

/** Lifecycle markers a head may need to drop. The MCP generator drops every tool
 *  carrying one (agents are draft-only); a human React head keeps `LIFECYCLE_ACTIVATE`
 *  and `LIFECYCLE_DEACTIVATE` (publish-state transitions are human-gated). */
export type LifecycleMarker = "LIFECYCLE_ACTIVATE" | "LIFECYCLE_DEACTIVATE" | "HARD_DELETE";

/** Lifecycle rule codes the kit knows by name. A domain's own rule-code union
 *  includes these plus its domain-specific codes. */
export type LifecycleRuleCode =
  | "DRAFT_ONLY_FOR_MACHINE"
  | "NO_HARD_DELETE"
  | "APPEND_ONLY_PRICE";

/**
 * `AgentReason` — the over-the-wire reason taxonomy carried on
 * `error.details.reason`. A known reason NEVER maps to `retryable: true`
 * (invariant 5). Open string so a domain RPC can RAISE its own message, but the
 * named members are the stable, machine-handled ones.
 */
export type AgentReason =
  | "actor_required"
  | "actor_unknown"
  | "actor_kind_not_allowed"
  | "publish_requires_human"
  | "draft_only_for_machine"
  | "price_required_to_sell"
  | "not_found"
  | "already_exists"
  | "feature_flag_disabled"
  | (string & {});

/**
 * Request-decidable lifecycle gate: a machine actor is confined to drafts and may
 * not activate. Returns the violated code or `null`. This is the request-layer
 * fast-fail; the RPC re-derives `actor_kind` from `admin_users` and RAISEs `42501`
 * regardless.
 */
export function assertActivateNotMachineActor(input: {
  operation: string;
  actorKind: AgentActorKind;
}): "DRAFT_ONLY_FOR_MACHINE" | null {
  return input.operation === "activate" && input.actorKind === "machine"
    ? "DRAFT_ONLY_FOR_MACHINE"
    : null;
}

/**
 * Compose the request-decidable lifecycle predicates into a `RuleResult`. A
 * domain's `rules` typically delegates here for the lifecycle subset and adds its
 * own request-checkable rules on top.
 */
export function evaluateLifecycleRules<TRuleCode extends string = LifecycleRuleCode>(input: {
  operation: string;
  actorKind: AgentActorKind;
}): RuleResult<TRuleCode> {
  const violations: TRuleCode[] = [];
  const activateViolation = assertActivateNotMachineActor(input);
  if (activateViolation) violations.push(activateViolation as TRuleCode);
  return { ok: violations.length === 0, violations };
}
