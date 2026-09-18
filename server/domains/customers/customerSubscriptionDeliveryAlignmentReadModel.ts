import type { CustomerDeliveryAlignment } from "../../../src/domains/customers/accountV2Contracts.js";

export type DeliveryAlignmentRow = Record<string, unknown>;
export type DeliveryAlignmentRowsReader = (subscriptionIds: string[]) => Promise<DeliveryAlignmentRow[]>;

/**
 * Reads only customer-safe current cases. An aligned case remains current while
 * its aligned schedule is still the subscription's next schedule; once a paid
 * cycle advances `next_cycle_at`, the historical ledger row disappears from UI.
 */
export async function readSubscriptionDeliveryAlignments(
  readRows: DeliveryAlignmentRowsReader | undefined,
  nextCycleAtBySubscription: ReadonlyMap<string, string | null>,
): Promise<Map<string, CustomerDeliveryAlignment>> {
  const subscriptionIds = [...nextCycleAtBySubscription.keys()].filter(Boolean);
  if (!readRows || subscriptionIds.length === 0) return new Map();
  return mapCurrentDeliveryAlignments(await readRows(subscriptionIds), nextCycleAtBySubscription);
}

export function mapCurrentDeliveryAlignments(
  rows: DeliveryAlignmentRow[],
  nextCycleAtBySubscription: ReadonlyMap<string, string | null>,
): Map<string, CustomerDeliveryAlignment> {
  const result = new Map<string, CustomerDeliveryAlignment>();
  for (const row of rows) {
    const subscriptionId = text(row.subscription_id);
    if (!subscriptionId || result.has(subscriptionId)) continue;
    const state = text(row.state);
    if (state === "protected") {
      result.set(subscriptionId, { state });
      continue;
    }
    if (state === "aligned" && sameInstant(
      nullableText(row.aligned_next_cycle_at),
      nextCycleAtBySubscription.get(subscriptionId) ?? null,
    )) {
      result.set(subscriptionId, { state });
    }
  }
  return result;
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
