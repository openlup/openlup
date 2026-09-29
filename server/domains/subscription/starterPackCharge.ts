import {
  STARTER_MIN_PAYABLE_MINOR,
  starterDelivery2TargetMinor,
} from "../../../src/domains/commerce/starterOfferPolicy.js";
import { deriveStarterPhase, type StarterPackMarker } from "./starterPackCycle.js";

/**
 * The amount a starter-pack subscription will be charged for an upcoming cycle.
 *
 * ONE computation for every consumer: the renewal engine charges with it, and
 * the account panel and the lifecycle emails state it. A second implementation
 * anywhere is how a customer is shown one number and charged another.
 *
 * The delivery-2 promise is "-35% off the catalog LIST price" (see
 * `src/domains/commerce/starterOfferPolicy.ts`). The discount is therefore never
 * a rate applied to the band subtotal, which already carries its own smaller
 * subscription discount; it is the gap between that subtotal and 65% of list.
 *
 * Pure and total: nothing here throws. A renewal must never stop because a line
 * lacks price evidence, so a missing list anchor degrades to the pre-existing
 * band-rate formula, which can only under-charge.
 */

/**
 * Which basis produced a delivery-2 discount. The engine logs a non-frozen one;
 * it is never stored, because a snapshot field would change the order fingerprint.
 */
export type StarterDelivery2Basis = "frozen" | "list_anchor" | "band_rate_fallback" | "retried_cycle";

export interface StarterDelivery2Discount {
  discountMinor: number;
  basis: StarterDelivery2Basis;
}

/**
 * Delivery 2's discount for the lines actually being delivered.
 *
 * - Subtotal equal to the frozen basis: the composition is the one priced at
 *   checkout, so the frozen amount stands. `template_version` is deliberately
 *   not consulted: a win-back reactivation bumps it without touching a line,
 *   and a list-price change since checkout does not reprice an unchanged
 *   package.
 * - Otherwise, with the lines' list anchor: `subtotal - ceil(65% x list)`.
 * - Otherwise: the marker's rate on the band subtotal (legacy lines only).
 *
 * Always clamped so at least `STARTER_MIN_PAYABLE_MINOR` stays payable.
 */
export function resolveStarterDelivery2Discount({
  marker,
  subtotalMinor,
  listAnchorMinor,
  retriedCycleDiscountMinor = null,
}: {
  marker: StarterPackMarker;
  subtotalMinor: number;
  listAnchorMinor: number | null;
  /** A re-driven cycle keeps the discount its first attempt was priced with. */
  retriedCycleDiscountMinor?: number | null;
}): StarterDelivery2Discount {
  let raw: number;
  let basis: StarterDelivery2Basis;
  if (retriedCycleDiscountMinor !== null) {
    raw = retriedCycleDiscountMinor;
    basis = "retried_cycle";
  } else if (subtotalMinor === marker.delivery2.basisSubtotalMinor) {
    raw = marker.delivery2.discountMinor;
    basis = "frozen";
  } else if (listAnchorMinor !== null && listAnchorMinor > 0) {
    raw = subtotalMinor - starterDelivery2TargetMinor(listAnchorMinor);
    basis = "list_anchor";
  } else {
    raw = Math.round((subtotalMinor * marker.delivery2.discountBps) / 10_000);
    basis = "band_rate_fallback";
  }
  const ceiling = Math.max(0, subtotalMinor - STARTER_MIN_PAYABLE_MINOR);
  return { discountMinor: Math.min(Math.max(0, Math.trunc(raw)), ceiling), basis };
}

/**
 * The delivery-2 discount a cycle was first priced with, read from the pricing
 * snapshot stored on the cycle (`provenance.starterPack.discountMinor`). A
 * retried cycle must rebuild its snapshots byte for byte: the cycle-order RPC
 * fingerprints them and refuses a retry whose snapshots differ, so a cycle
 * priced under an earlier rule keeps that rule's amount. Null when the snapshot
 * carries no delivery-2 provenance.
 */
export function retriedStarterDiscountMinor(pricingSnapshot: unknown): number | null {
  const provenance = (pricingSnapshot as { provenance?: unknown } | null | undefined)?.provenance;
  const starter = (provenance as { starterPack?: unknown } | null | undefined)?.starterPack;
  if (!starter || typeof starter !== "object") return null;
  const record = starter as Record<string, unknown>;
  if (record.reasonCode !== "starter_pack_delivery_2") return null;
  const amount = record.discountMinor;
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

/**
 * The catalog list total of stored quote lines: the sum of each line's
 * `base_unit` pricing component (unit list price x quantity). `null` when any
 * line carries no such component, so a partial sum is never mistaken for list.
 */
export function quoteLinesListAnchorMinor(quoteLines: readonly unknown[]): number | null {
  if (quoteLines.length === 0) return null;
  let total = 0;
  for (const line of quoteLines) {
    const amount = baseUnitAmountMinor(line);
    if (amount === null) return null;
    total += amount;
  }
  return total;
}

function baseUnitAmountMinor(line: unknown): number | null {
  if (!line || typeof line !== "object") return null;
  const components = (line as Record<string, unknown>).pricingComponents;
  if (!Array.isArray(components)) return null;
  let found: number | null = null;
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    const record = component as Record<string, unknown>;
    if (record.componentType !== "base_unit") continue;
    const amount = record.amountMinor;
    // Zero is a real list price (a free addon); only a missing or negative one is no evidence.
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
    found = (found ?? 0) + amount;
  }
  return found;
}

/** The frozen steady package: unit count and band subtotal. */
export function starterGraduationTotals(
  marker: StarterPackMarker,
): { units: number; subtotalMinor: number } | null {
  let units = 0;
  let subtotalMinor = 0;
  for (const line of marker.graduation.lines) {
    units += line.qty;
    const subtotal = line.quoteLine.lineSubtotalGross;
    const amount =
      subtotal && typeof subtotal === "object"
        ? (subtotal as Record<string, unknown>).amountMinor
        : undefined;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    subtotalMinor += amount;
  }
  return { units, subtotalMinor };
}

/**
 * Cycle statuses the renewal engine still charges. A cycle in one of them keeps
 * its own number when the engine re-drives it, so the upcoming charge is that
 * cycle, not the next one. `subscription_list_due_for_renewal` hides the
 * subscription while such a cycle exists, so at most one is open.
 */
const OPEN_CYCLE_STATUSES = new Set(["planned", "payment_pending", "payment_failed", "retry_scheduled"]);

/**
 * The number the renewal engine will give the upcoming cycle: the open cycle's
 * own number (lowest, so the answer is stable whatever order the rows arrive
 * in), else the highest existing number + 1.
 */
export function upcomingCycleNumber(cycles: ReadonlyArray<{ cycleNumber: number; status: string }>): number {
  return upcomingCycle(cycles).cycleNumber;
}

/**
 * The upcoming cycle as the renewal engine will build it: its number, and for
 * an open (re-driven) cycle the delivery-2 discount its first attempt stored,
 * which the engine keeps on retry. Surfaces that state the amount pass that
 * discount on, so they state what the retry will charge.
 */
export function upcomingCycle(
  cycles: ReadonlyArray<{ cycleNumber: number; status: string; pricingSnapshot?: unknown }>,
): { cycleNumber: number; retriedCycleDiscountMinor: number | null } {
  let open: (typeof cycles)[number] | null = null;
  let highest = 0;
  for (const cycle of cycles) {
    if (!Number.isFinite(cycle.cycleNumber)) continue;
    if (cycle.cycleNumber > highest) highest = cycle.cycleNumber;
    if (OPEN_CYCLE_STATUSES.has(cycle.status) && (open === null || cycle.cycleNumber < open.cycleNumber)) {
      open = cycle;
    }
  }
  return open
    ? { cycleNumber: open.cycleNumber, retriedCycleDiscountMinor: retriedStarterDiscountMinor(open.pricingSnapshot) }
    : { cycleNumber: highest + 1, retriedCycleDiscountMinor: null };
}

export interface StarterUpcomingCharge {
  stage: "delivery2" | "graduation";
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  /** Set for delivery 2 only. */
  delivery2Basis: StarterDelivery2Basis | null;
}

/**
 * What the upcoming cycle will be charged, or `null` when the starter pack does
 * not price it (an ordinary cycle, or a graduation that keeps the customer's own
 * lines — then the current lines ARE the charge).
 *
 * `cycleNumber` is the number the renewal engine will give the cycle: the open
 * retry cycle's own number, else the highest existing number + 1.
 */
export function resolveStarterUpcomingCharge(input: {
  marker: StarterPackMarker | null;
  templateVersion: number;
  cadenceDays: number;
  cycleNumber: number;
  currentLines: { subtotalMinor: number; listAnchorMinor: number | null };
  /** The open cycle's stored delivery-2 discount (`upcomingCycle`); null for a new cycle. */
  retriedCycleDiscountMinor?: number | null;
}): StarterUpcomingCharge | null {
  const { marker, currentLines } = input;
  const phase = deriveStarterPhase({
    marker,
    cycleNumber: input.cycleNumber,
    templateVersion: input.templateVersion,
    cadenceDays: input.cadenceDays,
  });
  if (!marker) return null;
  if (phase === "delivery2") {
    const { discountMinor, basis } = resolveStarterDelivery2Discount({
      marker,
      subtotalMinor: currentLines.subtotalMinor,
      listAnchorMinor: currentLines.listAnchorMinor,
      retriedCycleDiscountMinor: input.retriedCycleDiscountMinor ?? null,
    });
    return {
      stage: "delivery2",
      subtotalMinor: currentLines.subtotalMinor,
      discountMinor,
      totalMinor: currentLines.subtotalMinor - discountMinor,
      delivery2Basis: basis,
    };
  }
  if (phase === "graduate_full") {
    const totals = starterGraduationTotals(marker);
    if (totals === null) return null;
    return {
      stage: "graduation",
      subtotalMinor: totals.subtotalMinor,
      discountMinor: 0,
      totalMinor: totals.subtotalMinor,
      delivery2Basis: null,
    };
  }
  return null;
}
