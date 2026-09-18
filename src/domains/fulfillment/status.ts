import type { DhlTrackingEvents, FulfillmentDisplayStatus } from "./types.js";

const SHIPMENT_SORT_ORDER: Record<FulfillmentDisplayStatus, number> = {
  shipped: 0,
  in_transit: 1,
  delivered: 2,
};

export function mapDhlTrackingStatus(events: DhlTrackingEvents): "delivered" | "in_transit" | null {
  const codes = events.codes.map((code) => code.toUpperCase());
  const descriptionText = events.descriptions.join(" ").toLowerCase();

  for (const code of codes) {
    if (code === "DOR" || code.startsWith("DOR_") || code === "PPDOR") return "delivered";
  }

  for (const keyword of deliveredKeywords) {
    if (descriptionText.includes(keyword)) return "delivered";
  }

  if (codes.length > 0 && codes.every((code) => code === "EDWP")) return null;

  for (const code of codes) {
    if (transitExactCodes.has(code)) return "in_transit";
    if (transitPrefixes.some((prefix) => code.startsWith(prefix))) return "in_transit";
  }

  for (const keyword of transitKeywords) {
    if (descriptionText.includes(keyword)) return "in_transit";
  }

  return null;
}

export function fulfillmentDisplayStatus(status: string): FulfillmentDisplayStatus {
  if (status === "shipped" || status === "in_transit") return status;
  return "delivered";
}

export function dhlPublicTrackingUrl(trackingNumber: string): string {
  return `https://www.dhl.com/pl-pl/home/tracking/tracking-parcel.html?submit=1&tracking-id=${encodeURIComponent(trackingNumber)}`;
}

export function shipmentDate(input: {
  status: string;
  statusUpdatedAt: string | null;
  deliveredAt: string | null;
}): string | null {
  if (fulfillmentDisplayStatus(input.status) === "delivered") {
    return input.deliveredAt ?? input.statusUpdatedAt ?? null;
  }
  return input.statusUpdatedAt ?? null;
}

export function shipmentSortKey(input: {
  status: string;
  statusUpdatedAt: string | null;
  deliveredAt: string | null;
}): number {
  const displayStatus = fulfillmentDisplayStatus(input.status);
  const group = SHIPMENT_SORT_ORDER[displayStatus];
  const date = shipmentDate(input);
  const time = date ? new Date(date).getTime() : 0;

  return group === 2 ? group * 1e15 - time : group * 1e15 + (1e15 - time);
}

const deliveredKeywords = [
  "doręczon",
  "doręcze",
  "doręczy",
  "delivered",
  "odebrana przez odbiorc",
  "dostarczono",
  "dostarczenie",
  "wręczon",
];

const transitExactCodes = new Set([
  "DWP",
  "PSZ",
  "TRM",
  "TRM2",
  "SORT",
  "WEJPL",
  "WYJPL",
  "LK",
  "LP",
  "ZA",
  "ZAIT",
  "SAS",
  "SOB",
  "REZ",
  "PNK",
  "PNPT",
  "PO18",
  "PSHOP",
  "BRG",
  "CC",
  "OWL",
  "OP",
]);

const transitPrefixes = ["AWI_", "OP_", "OWL_", "SP_", "BRG_"];

const transitKeywords = [
  "odebrana od nadawcy",
  "w drodze",
  "transit",
  "sortown",
  "magazyn",
  "terminal",
  "przyjęt",
  "nadano",
  "przekazan",
  "w trakcie",
  "transport",
  "oczekuje na odbiór",
  "u kuriera",
];
