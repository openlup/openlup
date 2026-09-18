import type { BundleAllocationFailureCode } from "@openlup/core/pricing";

import type { AgentActorKind, RuleResult } from "../../lib/agent-domain/ruleResult.js";

/**
 * Bundle write rules — the named, enforced invariants of the agent-operable
 * bundle write path. These codes are the single vocabulary shared by the request
 * contracts, the pure rule predicates (`bundleRules.ts`), the service-role write
 * routines (which RAISE them) and the over-the-wire error taxonomy.
 *
 * The catalog domain is the reference for this shape
 * (`src/domains/commerce/catalogRuleCodes.ts`); the lifecycle subset is expressed
 * through the generic kit in `src/lib/agent-domain/`, and the codes stay here as
 * this domain's registry.
 */
export const BUNDLE_RULE_CODES = [
  // Machine (agent) actors compose, price and archive drafts, but may NOT
  // activate or deactivate. Enforced by the handler (allowedActorKinds) AND
  // re-derived + RAISEd inside the activate/deactivate routines.
  "DRAFT_ONLY_FOR_MACHINE",
  // A bundle with no components is not a bill of materials. Request-decidable on
  // the whole-set composition replace.
  "MIN_COMPONENTS",
  // Every component being an add-on leaves nothing that is always in the box.
  // At least one non-addon component is required. Request-decidable.
  "ADDON_ONLY_COMPOSITION",
  // One row per unit per bundle: multiplicity is the quantity, never a repeated
  // component. Request-decidable on the whole-set replace.
  "DUPLICATE_COMPONENT",
  // Creating a bundle whose code is already used is rejected (unique code).
  "CODE_TAKEN",
  // A composition entry naming a unit that does not exist is rejected.
  "COMPONENT_NOT_FOUND",
  // A component must itself be sellable: active AND sellable on its own. A bundle
  // must not become the only way an unsellable unit reaches a customer.
  "COMPONENT_NOT_SELLABLE",
  // Every component must be priced in the currency of the bundle's price list;
  // a mixed-currency bill of materials has no single reference total.
  "COMPONENT_CURRENCY_MISMATCH",
  // A bundle is never priced above the sum of its parts. Hard refusal, not a
  // warning: the discount framing is the product, and the kernel allocator
  // returns the same decision as one comparison.
  "TARGET_ABOVE_COMPONENT_SUM",
  // The target cannot cover every component's minimum payable amount.
  "TARGET_BELOW_FLOOR",
  // Activation requires an active target price on the bundle.
  "PRICE_REQUIRED_TO_SELL",
  // Activation requires a non-empty composition.
  "COMPOSITION_REQUIRED_TO_SELL",
  // Target-price changes INSERT a new price row and deactivate the old one; an
  // existing row is never mutated in place.
  "APPEND_ONLY_PRICE",
  // A bundle referenced by an order or a subscription is never hard-deleted;
  // removal is an archive (status flip).
  "NO_HARD_DELETE",
  // Restore is the inverse of archive: it applies only to an ARCHIVED bundle.
  "RESTORE_REQUIRES_ARCHIVED",
  // Deactivate (unpublish) applies only to a LIVE bundle.
  "DEACTIVATE_REQUIRES_ACTIVE",
  // Only the exploded fulfillment mode has a runtime. The stored column admits
  // the pre-packed mode so it never has to be widened; the refusal lives here.
  "FULFILLMENT_MODE_UNSUPPORTED",
  // A non-empty composition constraint is validated by the injected
  // CompositionRulesPort; its refusal surfaces under this code.
  "CONSTRAINT_VALIDATION_FAILED",
  // Clone reads its source before replaying a fresh draft; a missing source is
  // rejected before the replay.
  "CLONE_SOURCE_NOT_FOUND",
] as const;

export type BundleRuleCode = (typeof BUNDLE_RULE_CODES)[number];

/**
 * The two target-price codes are NOT re-derived here — they are the kernel
 * allocator's own failure vocabulary, projected onto this domain's registry.
 *
 * Declared as an exhaustive `Record` over `BundleAllocationFailureCode` on
 * purpose: when `@openlup/core/pricing` learns a new failure code, this object
 * stops compiling until the domain decides which rule it is. `REFERENCE_TOTAL_ZERO`
 * means the composition weighed nothing, which is the same condition
 * `MIN_COMPONENTS` names from the request side.
 */
export const BUNDLE_ALLOCATION_RULE_CODE: Record<BundleAllocationFailureCode, BundleRuleCode> = {
  REFERENCE_TOTAL_ZERO: "MIN_COMPONENTS",
  TARGET_ABOVE_COMPONENT_SUM: "TARGET_ABOVE_COMPONENT_SUM",
  TARGET_BELOW_FLOOR: "TARGET_BELOW_FLOOR",
};

/**
 * Which rules are decidable from the request alone (pure, pre-flight) and which
 * are state-dependent and authoritatively enforced by the write routine. This
 * documents intent and keeps the handler honest about what it can decide before
 * the write. `CONSTRAINT_VALIDATION_FAILED` is `port`: it is decided by the
 * injected `CompositionRulesPort`, which is neither the request nor the database.
 */
export const BUNDLE_RULE_ENFORCEMENT: Record<BundleRuleCode, "request" | "port" | "rpc"> = {
  DRAFT_ONLY_FOR_MACHINE: "request",
  MIN_COMPONENTS: "request",
  ADDON_ONLY_COMPOSITION: "request",
  DUPLICATE_COMPONENT: "request",
  FULFILLMENT_MODE_UNSUPPORTED: "request",
  CONSTRAINT_VALIDATION_FAILED: "port",
  CODE_TAKEN: "rpc",
  COMPONENT_NOT_FOUND: "rpc",
  COMPONENT_NOT_SELLABLE: "rpc",
  COMPONENT_CURRENCY_MISMATCH: "rpc",
  TARGET_ABOVE_COMPONENT_SUM: "rpc",
  TARGET_BELOW_FLOOR: "rpc",
  PRICE_REQUIRED_TO_SELL: "rpc",
  COMPOSITION_REQUIRED_TO_SELL: "rpc",
  APPEND_ONLY_PRICE: "rpc",
  NO_HARD_DELETE: "rpc",
  RESTORE_REQUIRES_ARCHIVED: "rpc",
  DEACTIVATE_REQUIRES_ACTIVE: "rpc",
  CLONE_SOURCE_NOT_FOUND: "rpc",
};

export type BundleActorKind = AgentActorKind;

export type BundleWriteOperation =
  | "create_draft"
  | "update_draft"
  | "set_composition"
  | "set_target_price"
  | "archive"
  | "restore"
  | "clone_draft"
  | "activate"
  | "deactivate";

/** The domain's rule result, projected from the generic kit `RuleResult`. */
export type BundleRuleResult = RuleResult<BundleRuleCode>;
