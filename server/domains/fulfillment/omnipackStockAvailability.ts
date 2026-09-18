import type { InventoryStockLine } from "../../../src/domains/inventory/contracts.js";
import type { OmnipackLocalInventoryBalance } from "./omnipackStockSyncContracts.js";

const OMNIPACK_LOCAL_TIME_ZONE = "Europe/Warsaw";

export function aggregateAtpCompatibleStock(lines: InventoryStockLine[], now: Date): Map<string, OmnipackLocalInventoryBalance> {
  const requestedAt = now.toISOString();
  const balances = new Map<string, OmnipackLocalInventoryBalance>();
  for (const line of lines.filter((item) => isAtpUsable(item, requestedAt))) {
    const current = balances.get(line.sku) ?? emptyLocal(line.sku);
    current.onHand += line.onHand;
    current.reserved += line.reserved;
    current.unavailable += line.unavailable;
    current.safetyStock += line.safetyStock;
    balances.set(line.sku, current);
  }
  return balances;
}

// OmniPack rejects an endLocalDate it considers to be in the future (400
// ERR_DATE_INVALID). Its "today" follows UTC, while our window dates are
// Europe/Warsaw local — so every night between 22:00Z and 00:00Z (Warsaw
// already on tomorrow's date) the hourly sync failed and self-healed at UTC
// midnight (observed nightly 21–23 Jul 2026, including with a fresh 2-day
// cursor). Cap the end date at the UTC calendar date: Warsaw is never behind
// UTC, movements stamped in Warsaw's first two hours are picked up by the
// next post-UTC-midnight run, and the cursor re-queries from the last
// observed movement either way.
export function stockMovementWindow(
  cursor: { lastMovementOccurredAt: string | null; lastStockSyncedAt: string | null } | null,
  now: Date,
): { startLocalDate: string; endLocalDate: string } {
  const startAt = new Date(cursor?.lastMovementOccurredAt ?? cursor?.lastStockSyncedAt ?? now.toISOString());
  const safeStartAt = Number.isNaN(startAt.getTime()) ? now : startAt;
  const endLocalDate = minDate(localDate(now), utcDate(now));
  return {
    startLocalDate: minDate(localDate(safeStartAt), endLocalDate),
    endLocalDate,
  };
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

function isAtpUsable(line: InventoryStockLine, requestedAt: string): boolean {
  if (!line.fulfillable || line.locationStatus !== "active") return false;
  if (line.lotStatus && line.lotStatus !== "available") return false;
  if (line.expiresAt && Date.parse(line.expiresAt) <= Date.parse(requestedAt)) return false;
  return true;
}

function emptyLocal(sku: string): OmnipackLocalInventoryBalance {
  return { sku, onHand: 0, reserved: 0, unavailable: 0, safetyStock: 0 };
}

function localDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: OMNIPACK_LOCAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}
