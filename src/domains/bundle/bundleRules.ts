import { allocateBundleTargetPrice } from "@openlup/core/pricing";
import type { BundleComponentInput } from "@openlup/core/pricing";
import type { CompositionConstraint, CompositionRulesPort } from "@openlup/core/bundle";

import { assertActivateNotMachineActor } from "../../lib/agent-domain/lifecycleRules.js";
import {
  BUNDLE_ALLOCATION_RULE_CODE,
  type BundleActorKind,
  type BundleRuleResult,
} from "./bundleRuleCodes.js";

/**
 * Pure, request-checkable bundle write rules.
 *
 * Only what is decidable from the request alone lives here. The state-dependent
 * rules (code uniqueness, component existence/sellability/currency, the target
 * price against real component prices, the activation preconditions, append-only
 * pricing, archive-not-delete) are authoritatively enforced by the service-role
 * write routines; this layer never duplicates their decision, it only fast-fails
 * the cases a confused or compromised caller can be refused on cheaply. The
 * routine re-derives everything and RAISEs regardless — defense in depth, not the
 * boundary.
 */

/** The composition shape the request-layer rules can reason about. */
export interface BundleCompositionEntry {
  readonly sku: string;
  readonly quantity: number;
  readonly isAddon: boolean;
}

/** The only fulfillment mode with a runtime. The column admits more; this does not. */
export const SUPPORTED_BUNDLE_FULFILLMENT_MODES = ["virtual"] as const;

export type SupportedBundleFulfillmentMode = (typeof SUPPORTED_BUNDLE_FULFILLMENT_MODES)[number];

function isSupportedFulfillmentMode(mode: string): boolean {
  return (SUPPORTED_BUNDLE_FULFILLMENT_MODES as readonly string[]).includes(mode);
}

/**
 * The lifecycle/actor gate every operation passes. Machine actors are confined to
 * drafts: they may compose, price, archive, restore and clone, but neither
 * activate nor deactivate.
 */
export function evaluateBundleWriteRules(input: {
  operation: string;
  actorKind: BundleActorKind;
}): BundleRuleResult {
  const violations: BundleRuleResult["violations"] = [];

  const activateViolation = assertActivateNotMachineActor(input);
  if (activateViolation) violations.push(activateViolation);
  // `assertActivateNotMachineActor` only knows the publish direction it was written
  // for. Unpublish is the same class of transition and carries the same code.
  if (input.operation === "deactivate" && input.actorKind === "machine") {
    violations.push("DRAFT_ONLY_FOR_MACHINE");
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Whole-set composition rules, decidable from the replacement set alone: it must
 * carry at least one entry, at least one entry that is not an add-on, and no unit
 * twice (multiplicity is the quantity, never a repeated row).
 */
export function evaluateBundleComposition(components: readonly BundleCompositionEntry[]): BundleRuleResult {
  const violations: BundleRuleResult["violations"] = [];

  if (components.length === 0) violations.push("MIN_COMPONENTS");
  else if (components.every((component) => component.isAddon)) violations.push("ADDON_ONLY_COMPOSITION");

  const seen = new Set<string>();
  for (const component of components) {
    if (seen.has(component.sku)) {
      violations.push("DUPLICATE_COMPONENT");
      break;
    }
    seen.add(component.sku);
  }

  return { ok: violations.length === 0, violations };
}

/** The runtime refusal of every fulfillment mode the stored column admits but no code honours. */
export function evaluateBundleFulfillmentMode(mode: string): BundleRuleResult {
  return isSupportedFulfillmentMode(mode)
    ? { ok: true, violations: [] }
    : { ok: false, violations: ["FULFILLMENT_MODE_UNSUPPORTED"] };
}

/**
 * Project the kernel allocator's decision onto this domain's rule vocabulary.
 *
 * The allocator (`@openlup/core/pricing`) owns the arithmetic and the two
 * refusals a target price can earn; this maps its failure code through the
 * exhaustive `BUNDLE_ALLOCATION_RULE_CODE` table so the codes cannot drift apart.
 * It is pure: the caller supplies the component reference prices it already holds.
 * The authority for a committed write remains the write routine, which holds the
 * live prices.
 */
export function evaluateBundleTargetPrice(input: {
  components: readonly BundleComponentInput[];
  targetPriceMinor: number;
  minimumUnitPayableMinor?: number;
}): BundleRuleResult {
  const outcome = allocateBundleTargetPrice({
    components: input.components,
    targetPriceMinor: input.targetPriceMinor,
    ...(input.minimumUnitPayableMinor === undefined
      ? {}
      : { minimumUnitPayableMinor: input.minimumUnitPayableMinor }),
  });
  // Narrowed by presence rather than by the `ok` literal: the app compiler runs
  // without strictNullChecks, where a boolean-literal discriminant does not narrow.
  if (!("code" in outcome)) return { ok: true, violations: [] };
  return { ok: false, violations: [BUNDLE_ALLOCATION_RULE_CODE[outcome.code]] };
}

/** An empty envelope means "unconstrained"; there is nothing for the port to decide. */
export function isEmptyCompositionConstraint(constraint: CompositionConstraint | null | undefined): boolean {
  return !constraint || constraint.kind.trim() === "";
}

/**
 * Delegate a non-empty composition constraint to the injected rules port. The
 * platform stores the envelope and never interprets it, so this domain does not
 * either: it asks the adopter's port and reports the refusal under one code.
 */
export async function evaluateBundleCompositionConstraint(
  port: CompositionRulesPort | undefined,
  input: {
    readonly components: readonly BundleCompositionEntry[];
    readonly constraint: CompositionConstraint | null | undefined;
  },
): Promise<BundleRuleResult> {
  if (isEmptyCompositionConstraint(input.constraint) || !port) return { ok: true, violations: [] };
  const constraint = input.constraint as CompositionConstraint;
  const outcome = await port.validateComposition({
    coreLines: input.components
      .filter((component) => !component.isAddon)
      .map((component) => ({ variantId: component.sku, qty: component.quantity, isAddon: false })),
    addonLines: input.components
      .filter((component) => component.isAddon)
      .map((component) => ({ variantId: component.sku, qty: component.quantity, isAddon: true })),
    constraint,
  });
  return outcome.ok ? { ok: true, violations: [] } : { ok: false, violations: ["CONSTRAINT_VALIDATION_FAILED"] };
}
