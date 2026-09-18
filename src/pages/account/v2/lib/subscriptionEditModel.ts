import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import type { SubscriptionCatalogProduct } from "@/domains/subscription/subscriptionCatalogContracts";

/**
 * Pure, render-free helpers backing the subscription self-service editors.
 *
 * The read model exposes lines keyed by `variantId`; the commerce
 * compatibility catalog keys the same variants by `slug` + allergen
 * conflicts. These helpers bridge the two so the UI stays thin and the
 * mapping logic is unit-testable without mounting React.
 *
 * The catalog product arrives as `@/domains/subscription/subscriptionCatalogContracts`
 * — a port declaring exactly the fields these helpers read. That keeps a commerce
 * import out of customer-visible UI, which the hidden-UI guardrail walls off, and
 * it no longer routes the account through the package composer to get there. The
 * composer proves its own richer item still satisfies the port.
 */

export type Subscription = CustomerAccountV2Response["subscriptions"][number];
export type SubscriptionLine = Subscription["lines"][number];
export type Pet = CustomerAccountV2Response["pets"][number];

const DAY_MS = 24 * 60 * 60 * 1000;
export const RESCHEDULE_MIN_DAYS = 3;
export const RESCHEDULE_MAX_DAYS = 60;

/** Earliest selectable next-cycle date: operational floor (now+3d). */
export function rescheduleLowerBound(now: Date, _editCutoffAt: string | null): Date {
  return new Date(now.getTime() + RESCHEDULE_MIN_DAYS * DAY_MS);
}

/** Latest selectable next-cycle date: now+60d. */
export function rescheduleUpperBound(now: Date): Date {
  return new Date(now.getTime() + RESCHEDULE_MAX_DAYS * DAY_MS);
}

/**
 * Calendar `disabled` predicate: blocks dates before the operational floor
 * and beyond the 60-day horizon. Edit-window/cycle locks gate opening the action.
 */
export function isRescheduleDateDisabled(
  now: Date,
  editCutoffAt: string | null,
): (date: Date) => boolean {
  const lower = rescheduleLowerBound(now, editCutoffAt);
  const upper = rescheduleUpperBound(now);
  return (date: Date): boolean => date.getTime() < lower.getTime() || date.getTime() > upper.getTime();
}

export function recipeLines(subscription: Subscription): SubscriptionLine[] {
  return subscription.lines
    .filter((line) => !line.isAddon)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function addonLines(subscription: Subscription): SubscriptionLine[] {
  return subscription.lines.filter((line) => line.isAddon);
}

/**
 * Localised "N recipes / M add-ons" summary built from the subscription lines, so the
 * count words are translated (the read model's packageSummary is English-only). Returns
 * null when there are no lines (caller shows its own fallback).
 */
export function packageSummaryLabel(
  lines: SubscriptionLine[],
  t: (key: string, options?: { count: number }) => string,
): string | null {
  const recipeCount = lines.filter((line) => !line.isAddon).length;
  const addonCount = lines.filter((line) => line.isAddon).length;
  if (recipeCount === 0 && addonCount === 0) return null;
  const base = "account:dashboard.panels.subscriptions";
  const parts: string[] = [];
  if (recipeCount > 0) parts.push(t(`${base}.recipeCount`, { count: recipeCount }));
  if (addonCount > 0) parts.push(t(`${base}.addonCount`, { count: addonCount }));
  return parts.join(" · ");
}

/** The recipe line a flavour swap targets (the first non-addon line). */
export function primaryRecipeLine(subscription: Subscription): SubscriptionLine | null {
  return recipeLines(subscription)[0] ?? null;
}

export function variantToSlug(
  products: SubscriptionCatalogProduct[],
): Map<string, string> {
  return new Map(products.map((product) => [product.variantId, product.slug]));
}

/** Catalog slug of the subscription's current primary recipe, if known. */
export function currentRecipeSlug(
  subscription: Subscription,
  products: SubscriptionCatalogProduct[],
): string | null {
  const line = primaryRecipeLine(subscription);
  if (!line) return null;
  return variantToSlug(products).get(line.variantId) ?? null;
}

export function addonVariantIds(subscription: Subscription): Set<string> {
  return new Set(addonLines(subscription).map((line) => line.variantId));
}

/** Resolve the pet whose allergens gate compatibility for a subscription. */
export function petForSubscription(
  subscription: Subscription,
  pets: Pet[],
): Pet | null {
  if (!subscription.petId) return null;
  return pets.find((pet) => pet.petId === subscription.petId) ?? null;
}

/** Current plan length (feeding_days) when the size constraint uses that kind. */
export function planLengthDays(subscription: Subscription): number | null {
  const constraint = subscription.sizeConstraint;
  if (constraint && constraint.kind === "feeding_days" && typeof constraint.value === "number") {
    return constraint.value;
  }
  return null;
}

// ── Mix line quantities ─────────────────────────────────────────────────────
// Independent per-line quantities: every operation touches exactly one line and
// the total is free to move. Model invariants: every stored entry sits in
// 1..MIX_LINE_MAX (never 0 — a line that would fall to 0 is removed instead),
// and at least one line always remains. The order-level minimum (MOQ) is NOT a
// model concern: it depends on a policy constant owned by the package-quantity
// policy and is enforced by the caller (stepper disabling) and by the server.

export interface RecipeMixEntry {
  variantId: string;
  qty: number;
}

export function recipeMixFromSubscription(subscription: Subscription): RecipeMixEntry[] {
  return recipeLines(subscription).map((line) => ({ variantId: line.variantId, qty: line.qty }));
}

export function recipeMixTotal(mix: readonly RecipeMixEntry[]): number {
  return mix.reduce((sum, entry) => sum + entry.qty, 0);
}

/** Hard per-line ceiling. The order-level minimum lives in the quantity policy, not here. */
export const MIX_LINE_MAX = 99;

/** +1 on `variantId` only, capped at {@link MIX_LINE_MAX}. No donor line. */
export function incrementRecipe(mix: RecipeMixEntry[], variantId: string): RecipeMixEntry[] {
  const target = mix.find((entry) => entry.variantId === variantId);
  if (!target || target.qty >= MIX_LINE_MAX) return mix;
  return mix.map((entry) =>
    entry.variantId === variantId ? { ...entry, qty: entry.qty + 1 } : entry,
  );
}

/**
 * -1 on `variantId` only. At qty 1 the decrement removes the line instead of
 * storing a zero — but never the last remaining line.
 */
export function decrementRecipe(mix: RecipeMixEntry[], variantId: string): RecipeMixEntry[] {
  const target = mix.find((entry) => entry.variantId === variantId);
  if (!target) return mix;
  if (target.qty <= 1) return removeRecipe(mix, variantId);
  return mix.map((entry) =>
    entry.variantId === variantId ? { ...entry, qty: entry.qty - 1 } : entry,
  );
}

/** Append a line at qty 1. No donor line, so the total grows by one. */
export function addRecipe(mix: RecipeMixEntry[], variantId: string): RecipeMixEntry[] {
  if (mix.some((entry) => entry.variantId === variantId)) return mix;
  return [...mix, { variantId, qty: 1 }];
}

/** Drop a line with no redistribution. Keeps at least one line. */
export function removeRecipe(mix: RecipeMixEntry[], variantId: string): RecipeMixEntry[] {
  if (mix.length <= 1 || !mix.some((entry) => entry.variantId === variantId)) return mix;
  return mix.filter((entry) => entry.variantId !== variantId);
}

/** Even split of `total` across the given recipes (remainder to the first ones). */
export function evenSplitMix(total: number, variantIds: readonly string[]): RecipeMixEntry[] {
  const count = variantIds.length;
  const base = Math.floor(total / count);
  let remainder = total - base * count;
  return variantIds.map((variantId) => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return { variantId, qty: base + extra };
  });
}
