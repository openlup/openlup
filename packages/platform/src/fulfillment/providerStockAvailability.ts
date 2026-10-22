import type { FulfillmentStockSyncPort, LocalStock } from "./contracts/index.js";
type StockLine = Awaited<ReturnType<FulfillmentStockSyncPort["readLocalInventoryStock"]>>[number];
export function aggregateAtpCompatibleStock(lines: readonly StockLine[], now: Date): Map<string, LocalStock> {
  const requestedAt = now.toISOString();
  const balances = new Map<string, LocalStock>();
  for (const line of lines.filter((item) => isAtpUsable(item, requestedAt))) {
    const current = balances.get(line.skuRef) ?? emptyLocal(line.skuRef);
    current.onHand += line.quantity.onHand;
    current.reserved += line.quantity.reserved;
    current.unavailable += line.quantity.unavailable;
    current.safetyStock += line.quantity.safetyStock;
    balances.set(line.skuRef, current);
  }
  return balances;
}

/** Cap the host-local movement window at UTC today, preserving donor overlap. */
export function stockMovementWindow(
  cursor: { lastMovementOccurredAt: string | null; lastStockSyncedAt: string | null } | null,
  now: Date,
  timeZone: string,
): { startLocalDate: string; endLocalDate: string } {
  const startAt = new Date(cursor?.lastMovementOccurredAt ?? cursor?.lastStockSyncedAt ?? now.toISOString());
  const safeStartAt = Number.isNaN(startAt.getTime()) ? now : startAt;
  const endLocalDate = minDate(localDate(now, timeZone), utcDate(now));
  return {
    startLocalDate: minDate(localDate(safeStartAt, timeZone), endLocalDate),
    endLocalDate,
  };
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

function isAtpUsable(line: StockLine, requestedAt: string): boolean {
  if (!line.fulfillable || line.locationStatus !== "active") return false;
  if (line.lotStatus && line.lotStatus !== "available") return false;
  if (line.expiresAt && Date.parse(line.expiresAt) <= Date.parse(requestedAt)) return false;
  return true;
}

function emptyLocal(sku: string): LocalStock {
  return { skuRef: sku, onHand: 0, reserved: 0, unavailable: 0, safetyStock: 0 };
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}
