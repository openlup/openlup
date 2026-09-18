import { type CatalogActorKind, type CatalogRuleResult } from "./catalogRuleCodes.js";
import { assertActivateNotMachineActor } from "../../lib/agent-domain/lifecycleRules.js";

/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain rules.
 *
 * Pure, request-checkable catalog write rules. Only the rules decidable from the
 * request alone live here — today that is the actor/lifecycle gate (a machine
 * actor may not activate), now expressed via the generic kit predicate
 * `assertActivateNotMachineActor`. The DB-stateful rules
 * (PRICE_REQUIRED_TO_SELL, NO_HARD_DELETE, APPEND_ONLY_PRICE, SLUG_TAKEN) are
 * authoritatively enforced in the service-role RPCs; this layer never duplicates
 * their decision, it only fast-fails the obvious actor case so a confused/
 * compromised agent is rejected before the RPC. The RPC re-derives actor kind
 * from `admin_users` and RAISEs regardless — defense-in-depth, not the boundary.
 */
export function evaluateCatalogWriteRules(input: {
  operation: string;
  actorKind: CatalogActorKind;
}): CatalogRuleResult {
  const violations: CatalogRuleResult["violations"] = [];

  // Positive publish gate (request layer): machine actors are confined to drafts.
  const activateViolation = assertActivateNotMachineActor(input);
  if (activateViolation) violations.push(activateViolation);

  return { ok: violations.length === 0, violations };
}
