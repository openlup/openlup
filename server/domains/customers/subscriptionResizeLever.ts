import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";

export function readPositiveInt(value: unknown): number | null {
  const number = Math.trunc(Number(value));
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function readResizeLever(value: unknown): { kind: string; value: unknown } {
  const lever = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!lever || typeof lever.kind !== "string" || lever.kind.trim().length === 0) {
    throw new Error("subscription_reprice_invalid_resize_lever");
  }
  return { kind: lever.kind, value: lever.value };
}

export function normalizeResizeLever(
  lever: { kind: string; value: unknown },
  payloadCadenceDays: unknown,
  currentCadenceDays: number,
): { kind: string; value: unknown } {
  if (lever.kind !== "portionMode") return lever;
  const value = lever.value && typeof lever.value === "object" && !Array.isArray(lever.value)
    ? lever.value as Record<string, unknown>
    : { portionMode: lever.value };
  return { kind: lever.kind, value: { planDays: readPositiveInt(payloadCadenceDays) ?? currentCadenceDays, ...value } };
}

export function resolveBundleCadence(
  sourceAction: string | undefined,
  requestedCadenceDays: number | null,
  currentCadenceDays: number,
  sizeConstraint: CreateQuoteRequest["sizeConstraint"],
): {
  cadenceDays: number;
  resizeLeverKind: "planLength" | "planLengthConstraint";
  requiresPlanResize: boolean;
  preservesFixedTotal: boolean;
} {
  const nominalPlanDays = readNominalPlanDays(sizeConstraint) ?? currentCadenceDays;
  const comparesToNominalPlan = sourceAction === "update_package_template";
  const planChanged = requestedCadenceDays !== null && requestedCadenceDays !== (
    comparesToNominalPlan ? nominalPlanDays : currentCadenceDays
  );
  // The customer package editor (rewritten to `update_bundle` by the generic
  // bundle-actions flag) never resizes on a cadence change: the requested
  // per-line quantities are authoritative and only the delivery cadence plus
  // the nominal plan-length stamp move. This mirrors the flag-OFF
  // `quotePackageEdit` path, so both modes of one customer action agree.
  // Genuine `update_bundle` / `resize_bundle` callers keep the sizing resize.
  const requiresPlanResize = planChanged && !comparesToNominalPlan;
  return {
    cadenceDays: planChanged && requestedCadenceDays !== null ? requestedCadenceDays : currentCadenceDays,
    resizeLeverKind: requiresPlanResize ? "planLength" : "planLengthConstraint",
    requiresPlanResize,
    preservesFixedTotal: sourceAction === "update_recipe_mix" ||
      requestedCadenceDays === null || !planChanged,
  };
}

export function readNominalPlanDays(constraint: CreateQuoteRequest["sizeConstraint"]): number | null {
  if (constraint?.kind !== "feeding_days") return null;
  const value = Number(constraint.value);
  return Number.isInteger(value) && value > 0 ? value : null;
}
