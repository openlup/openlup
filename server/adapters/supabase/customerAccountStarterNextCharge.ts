import type { CustomerAccountV2Response } from "../../../src/domains/customers/accountV2Contracts.js";
import {
  quoteLinesListAnchorMinor,
  resolveStarterUpcomingCharge,
  upcomingCycle,
} from "../../domains/subscription/starterPackCharge.js";
import { starterPackMarkerSchema, type StarterPackMarker } from "../../domains/subscription/starterPackCycle.js";
import { storedQuoteLine } from "./subscription/starterPackCycle.js";

type Row = Record<string, unknown>;
type ReadResult = { data: unknown; error: unknown };

/** The two `in`-filtered reads this module makes; any PostgREST-shaped client fits. */
export interface StarterNextChargeClient {
  from(table: string): {
    select(columns: string): {
      in(
        column: string,
        values: string[],
      ): PromiseLike<ReadResult> & { order(column: string, options: { ascending: boolean }): PromiseLike<ReadResult> };
    };
  };
}
type Subscription = CustomerAccountV2Response["subscriptions"][number];
type NextCharge = NonNullable<Subscription["nextCharge"]>;

/**
 * The customer panel's "next charge": the amount the renewal engine will charge
 * for the next cycle, computed by the SAME function the engine charges with
 * (`server/domains/subscription/starterPackCharge.ts`). Only a starter-pack
 * subscription can differ from its regular recurring price, so only those cost
 * a read (cycles + raw line pricing, two queries for the whole account);
 * everyone else's next charge IS the recurring price.
 *
 * Never throws. A starter subscription whose cycles or lines could not be read
 * states no next charge at all (null) rather than the regular price, which is
 * not what the engine would charge for a starter cycle.
 */
export async function readStarterNextCharges(
  serviceClient: StarterNextChargeClient,
  rows: Row[],
): Promise<Map<string, StarterNextChargeInput>> {
  const result = new Map<string, StarterNextChargeInput>();
  for (const row of rows) {
    // A cancelled subscription has no next charge to state; it shows its regular price.
    if (row.starter_pack === null || row.starter_pack === undefined || row.status === "cancelled") continue;
    const marker = starterPackMarkerSchema.safeParse(row.starter_pack);
    if (!marker.success) continue;
    result.set(String(row.id), {
      marker: marker.data,
      templateVersion: Number(row.template_version ?? 0),
      cadenceDays: Number(row.cadence_days ?? 0),
      cycles: [],
      listAnchorMinor: null,
      linesRead: false,
      cyclesRead: false,
    });
  }
  const ids = [...result.keys()];
  if (ids.length === 0) return result;
  try {
    const [cycles, lines] = await Promise.all([
      serviceClient
        .from("subscription_cycles")
        .select("subscription_id, cycle_number, status, pricing_snapshot")
        .in("subscription_id", ids)
        .order("cycle_number", { ascending: true }),
      serviceClient.from("subscription_lines").select("subscription_id, line_metadata").in("subscription_id", ids),
    ]);
    if (!cycles.error) {
      for (const entry of result.values()) entry.cyclesRead = true;
      for (const cycle of (cycles.data ?? []) as Row[]) {
        const entry = result.get(String(cycle.subscription_id));
        if (entry && typeof cycle.cycle_number === "number") {
          entry.cycles.push({
            cycleNumber: cycle.cycle_number,
            status: String(cycle.status ?? ""),
            pricingSnapshot: cycle.pricing_snapshot,
          });
        }
      }
    }
    if (!lines.error) {
      for (const entry of result.values()) entry.linesRead = true;
      const byId = new Map<string, unknown[]>();
      for (const line of (lines.data ?? []) as Row[]) {
        const list = byId.get(String(line.subscription_id)) ?? [];
        list.push(storedQuoteLine(line.line_metadata));
        byId.set(String(line.subscription_id), list);
      }
      for (const [id, quoteLines] of byId) {
        const entry = result.get(id);
        if (entry) entry.listAnchorMinor = quoteLinesListAnchorMinor(quoteLines);
      }
    }
  } catch {
    // Keep what was read; an entry missing either read states no next charge.
  }
  return result;
}

export interface StarterNextChargeInput {
  marker: StarterPackMarker;
  templateVersion: number;
  cadenceDays: number;
  cycles: Array<{ cycleNumber: number; status: string; pricingSnapshot?: unknown }>;
  listAnchorMinor: number | null;
  /** False when a read failed: the cycle number or list evidence would be a guess. */
  linesRead: boolean;
  cyclesRead: boolean;
}

/**
 * The next charge shown to the customer, for the cycle number the engine will
 * use (`upcomingCycle`), with the discount an open cycle's retry will keep. A starter subscription whose cycles or lines
 * could not be read states nothing (null) rather than an amount priced off half
 * the evidence; the panel then shows only the regular package price.
 */
export function nextCharge(
  recurringPrice: Subscription["recurringPrice"],
  starter: StarterNextChargeInput | undefined,
): NextCharge | null {
  if (!recurringPrice) return null;
  const regular: NextCharge = { totalGross: recurringPrice.totalGross, starterStage: null };
  if (!starter) return regular;
  if (!starter.linesRead || !starter.cyclesRead) return null;
  const upcoming = upcomingCycle(starter.cycles);
  const charge = resolveStarterUpcomingCharge({
    marker: starter.marker,
    templateVersion: starter.templateVersion,
    cadenceDays: starter.cadenceDays,
    cycleNumber: upcoming.cycleNumber,
    retriedCycleDiscountMinor: upcoming.retriedCycleDiscountMinor,
    currentLines: {
      subtotalMinor: recurringPrice.subtotalGross.amountMinor,
      listAnchorMinor: starter.listAnchorMinor,
    },
  });
  if (!charge) return regular;
  return {
    totalGross: { amountMinor: charge.totalMinor, currency: recurringPrice.totalGross.currency },
    starterStage: charge.stage,
  };
}
