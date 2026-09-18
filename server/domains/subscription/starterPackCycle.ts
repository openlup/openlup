import { z } from "zod";

/**
 * Starter-pack acquisition marker: the neutral half.
 *
 * The marker is written once, by the provisional-checkout creation step, and is
 * immutable thereafter. Everything here derives from it; no phase is stored, so
 * nothing in this file writes anything back.
 *
 * Deliberately fail-closed: a stored marker that does not parse THROWS rather
 * than degrading to "ordinary renewal". A silently ignored marker would charge
 * an acquisition customer the undiscounted delivery-2 amount, which is worse
 * than a failed renewal run that pages. The parse itself, the state read and
 * the graduation call live behind `StarterPackCyclePort`, implemented for the
 * managed composition in
 * `server/adapters/supabase/subscription/starterPackCycle.ts`.
 */

/**
 * `schemaVersion` is the string "1", matching the migration's
 * `starter_pack->>'schemaVersion' = '1'` CHECK. One canonical spelling, so a
 * marker that satisfies the database also satisfies this schema.
 */
export const starterPackMarkerSchema = z.object({
  schemaVersion: z.literal("1"),
  starterIntervalDays: z.number().int().min(7).max(28),
  basisTemplateVersion: z.number().int().min(1),
  delivery2: z.object({
    discountBps: z.number().int().min(0).max(10_000),
    discountMinor: z.number().int().min(0),
    basisSubtotalMinor: z.number().int().min(0),
  }),
  graduation: z.object({
    cadenceDays: z.union([z.literal(14), z.literal(28)]),
    sizeConstraint: z.record(z.string(), z.unknown()).optional(),
    lines: z
      .array(
        z.object({
          sku: z.string().min(1),
          qty: z.number().int().min(1),
          sortOrder: z.number().int().min(0),
          isAddon: z.boolean(),
          quoteLine: z.record(z.string(), z.unknown()),
        }),
      )
      .min(1),
  }),
});

export type StarterPackMarker = z.infer<typeof starterPackMarkerSchema>;

export type StarterPhase = "none" | "delivery2" | "graduate_full" | "graduate_cadence_only";

/** Cadences a customer can actually pick; a starter interval never lands here. */
const NORMAL_CADENCE_DAYS = [14, 21, 28];

export class StarterPackMarkerError extends Error {
  readonly subscriptionId: string;

  constructor(message: string, subscriptionId: string) {
    super(message);
    this.name = "StarterPackMarkerError";
    this.subscriptionId = subscriptionId;
  }
}

export function deriveStarterPhase({
  marker,
  cycleNumber,
  templateVersion,
  cadenceDays,
}: {
  marker: StarterPackMarker | null;
  cycleNumber: number;
  templateVersion: number;
  cadenceDays: number;
}): StarterPhase {
  if (!marker) return "none";
  if (cycleNumber === 2) return "delivery2";
  if (cycleNumber < 3) return "none";
  if (templateVersion === marker.basisTemplateVersion) return "graduate_full";
  // The template already moved (a customer edit landed before graduation ran),
  // so the mix is the customer's own and must not be overwritten. The cadence
  // may still be the acquisition delivery-2 interval, which nobody chose.
  if (
    cadenceDays === marker.starterIntervalDays &&
    !NORMAL_CADENCE_DAYS.includes(cadenceDays)
  ) {
    return "graduate_cadence_only";
  }
  return "none";
}

/**
 * Delivery 2's discount. The exact minor amount frozen at checkout is used only
 * when the basis it was computed against still holds; otherwise the agreed rate
 * is re-applied to the actual subtotal. Clamped so the order stays chargeable.
 */
export function resolveDelivery2DiscountMinor({
  marker,
  templateVersion,
  subtotalMinor,
}: {
  marker: StarterPackMarker;
  templateVersion: number;
  subtotalMinor: number;
}): number {
  const exact =
    templateVersion === marker.basisTemplateVersion &&
    subtotalMinor === marker.delivery2.basisSubtotalMinor;
  const raw = exact
    ? marker.delivery2.discountMinor
    : Math.round((subtotalMinor * marker.delivery2.discountBps) / 10_000);
  const ceiling = Math.max(0, subtotalMinor - 100);
  return Math.min(Math.max(0, raw), ceiling);
}


/** Every condition `subscription_apply_starter_graduation` RAISEs on. */
const RAISED_CONDITIONS = [
  "open_cycle", "unknown_sku", "invalid_cadence", "invalid_lines", "invalid_input", "invalid_mode",
];

/**
 * The raised condition behind a failed graduation, read back out of the
 * transport error's message. The RPC raises with a bare condition name and
 * PostgREST hands that message through verbatim, but the typed error surface
 * carries only `message` — DETAIL and HINT never arrive — so the message is the
 * only place the condition exists on this side.
 */
export function starterGraduationCondition(message: string): string {
  const condition = /subscription_starter_graduation_([a-z_]+)/.exec(message)?.[1] ?? "";
  if (RAISED_CONDITIONS.includes(condition)) return condition;
  // Not an RPC raise: the fail-closed marker parse threw before the call.
  return message.includes("starter_pack failed schema validation") ? "marker_unreadable" : "other";
}

/**
 * A failed graduation's message, shaped so the renewal run's `error` field
 * attributes it without a database query (SR-1 REQ-2).
 *
 * The renewal cron's `rowErrorReasonKey` keys the durable `row_errors:<key>=<n>`
 * summary on the text AFTER THE LAST ": " in the message, so the condition and
 * the subscription id go there and the original transport text is bracketed
 * ahead of it. The key that reaches `platform_job_runs.error` is then
 * `starter_graduation_<condition>_<subscription id>`, inside the 80-character
 * budget that helper truncates at.
 */
export function starterGraduationFailureMessage(subscriptionId: string, error: unknown): string {
  const original = error instanceof Error ? error.message : String(error);
  const condition = starterGraduationCondition(original);
  return `starter graduation failed [${original}]: starter_graduation_${condition} ${subscriptionId}`;
}

/** Marker + the two current subscription facts the phase decision reads. */
export interface StarterPackState {
  marker: StarterPackMarker | null;
  templateVersion: number;
  cadenceDays: number;
}

export interface StarterPackCyclePreparation {
  phase: StarterPhase;
  /** Non-null only for `delivery2`. */
  discountTotalGrossMinor: number | null;
  /** True when graduation ran, so the template and lines must be re-read. */
  reload: boolean;
  provenance: Record<string, unknown> | null;
}

export interface StarterPackCyclePreparationInput {
  subscriptionId: string;
  cycleNumber: number;
  state: StarterPackState;
  subtotalMinor: number;
}

/**
 * Neutral starter-pack cycle operations the renewal snapshot builder needs.
 *
 * Both members are stated in business terms, so a composition can satisfy them
 * with any store: reading the frozen marker plus the current template/cadence,
 * and preparing the cycle (delivery-2 discount, or an idempotent graduation).
 * The managed implementation lives in
 * `server/adapters/supabase/subscription/starterPackCycle.ts`.
 */
export interface StarterPackCyclePort {
  loadStarterPackState(subscriptionId: string): Promise<StarterPackState>;
  prepareStarterPackCycle(
    input: StarterPackCyclePreparationInput,
  ): Promise<StarterPackCyclePreparation>;
}
