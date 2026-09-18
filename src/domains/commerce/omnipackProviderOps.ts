import { currentParcel } from "../../lib/currentFulfillmentParcel.js";
import {
  parseTimestampOrZero,
  type OmsFulfillmentOrderRow,
  type OmsOmnipackDispatchRefRow,
  type OmsOmnipackStatusEvidenceRow,
} from "./omsFulfillmentSummary.js";

export const OMNIPACK_PROVIDER_OPS_STATUSES = [
  "none",
  "omnipack_dispatched_not_picked",
  "omnipack_picked_not_shipped",
  "omnipack_dispatch_failed",
] as const;

export const OMNIPACK_PROVIDER_OPS_SLA_STATUSES = [
  "ok",
  "watch",
  "breached",
  "paused_non_shipping_day",
] as const;

export type OmnipackProviderOpsStatus = (typeof OMNIPACK_PROVIDER_OPS_STATUSES)[number];
export type OmnipackProviderOpsSlaStatus = (typeof OMNIPACK_PROVIDER_OPS_SLA_STATUSES)[number];

export interface OmnipackProviderOpsSla {
  status: OmnipackProviderOpsSlaStatus;
  dispatchedAt: string | null;
  deadlineAt: string | null;
  remainingOperationalMinutes: number | null;
}

export interface OmnipackProviderOpsSummary {
  status: OmnipackProviderOpsStatus;
  providerOrderId: string | null;
  sla: OmnipackProviderOpsSla | null;
}

export interface OmnipackFulfillmentCalendarConfig {
  timeZone: string;
  targetOperationalHours: number;
  watchOperationalHours: number;
  operationalWeekdays: ReadonlySet<number>;
  pausedWeekday: number;
}

export const OMNIPACK_FULFILLMENT_CALENDAR: OmnipackFulfillmentCalendarConfig = {
  timeZone: "Europe/Warsaw",
  targetOperationalHours: 24,
  watchOperationalHours: 4,
  // JS weekday: 0 Sunday, 6 Saturday. Sunday is currently assumed operational.
  operationalWeekdays: new Set([0, 1, 2, 3, 4, 5]),
  pausedWeekday: 6,
};

export function deriveOmnipackProviderOps(input: {
  fulfillmentOrders: OmsFulfillmentOrderRow[];
  dispatchRefs?: OmsOmnipackDispatchRefRow[];
  statusEvidence?: OmsOmnipackStatusEvidenceRow[];
  now?: Date;
}): OmnipackProviderOpsSummary {
  // ⛔ The parcel that currently represents the order, never "the one that names this
  // provider". Once an order can carry a replacement, only the ORIGINAL parcel has a
  // `provider_kind` - the column is written by label creation, which a fresh replacement has
  // not reached - so preferring it made the whole provider-ops block, its provider order id
  // and its SLA clock describe the parcel that was lost. For a one-parcel order this is the
  // same row the old expression picked.
  const fulfillment = currentParcel(input.fulfillmentOrders);
  if (!fulfillment) return emptyOps();

  const dispatchRefs = (input.dispatchRefs ?? [])
    .filter((row) => row.fulfillment_order_id === fulfillment.id)
    .sort((a, b) => parseTimestampOrZero(b.updated_at ?? b.created_at) - parseTimestampOrZero(a.updated_at ?? a.created_at));
  const latestDispatch = dispatchRefs[0] ?? null;
  if (!latestDispatch) return emptyOps();

  if (latestDispatch.status === "failed") {
    return { status: "omnipack_dispatch_failed", providerOrderId: latestDispatch.provider_order_id ?? null, sla: null };
  }

  if (latestDispatch.status !== "created" || !latestDispatch.provider_order_id) return emptyOps();

  const evidence = (input.statusEvidence ?? [])
    .filter((row) => row.fulfillment_order_id === fulfillment.id)
    .sort((a, b) => parseTimestampOrZero(b.occurred_at ?? b.created_at) - parseTimestampOrZero(a.occurred_at ?? a.created_at));
  const evidenceLocalStatuses = new Set(evidence.map((row) => row.local_status).filter(Boolean));
  const isShipped =
    ["handed_over", "in_transit", "delivered"].includes(fulfillment.status ?? "")
    || ["in_transit", "delivered"].some((status) => evidenceLocalStatuses.has(status));
  if (isShipped) return { status: "none", providerOrderId: latestDispatch.provider_order_id, sla: null };

  const isPicked =
    fulfillment.status === "packed"
    || evidenceLocalStatuses.has("packed")
    || evidence.some((row) => row.provider_status === "picked" || row.provider_status === "packed");
  if (isPicked) {
    return { status: "omnipack_picked_not_shipped", providerOrderId: latestDispatch.provider_order_id, sla: null };
  }

  const dispatchedAt = latestDispatch.updated_at ?? latestDispatch.created_at ?? null;
  return {
    status: "omnipack_dispatched_not_picked",
    providerOrderId: latestDispatch.provider_order_id,
    sla: calculateOmnipackProviderOpsSla({
      dispatchedAt,
      now: input.now ?? new Date(),
    }),
  };
}

export function calculateOmnipackProviderOpsSla(input: {
  dispatchedAt: string | null;
  now?: Date;
  calendar?: OmnipackFulfillmentCalendarConfig;
}): OmnipackProviderOpsSla | null {
  if (!input.dispatchedAt) return null;
  const dispatchDate = new Date(input.dispatchedAt);
  if (Number.isNaN(dispatchDate.getTime())) return null;
  const now = input.now ?? new Date();
  const calendar = input.calendar ?? OMNIPACK_FULFILLMENT_CALENDAR;
  const targetMs = calendar.targetOperationalHours * 60 * 60 * 1000;
  const watchMs = calendar.watchOperationalHours * 60 * 60 * 1000;
  const deadline = addOperationalMs(dispatchDate, targetMs, calendar);
  const remainingMs = Math.max(0, operationalMsBetween(now, deadline, calendar));
  const status: OmnipackProviderOpsSlaStatus = isPausedNonShippingDay(now, calendar)
    ? "paused_non_shipping_day"
    : now.getTime() > deadline.getTime()
      ? "breached"
      : remainingMs <= watchMs
        ? "watch"
        : "ok";

  return {
    status,
    dispatchedAt: dispatchDate.toISOString(),
    deadlineAt: deadline.toISOString(),
    remainingOperationalMinutes: Math.ceil(remainingMs / 60_000),
  };
}

function addOperationalMs(start: Date, durationMs: number, calendar: OmnipackFulfillmentCalendarConfig): Date {
  let cursor = new Date(start);
  let remaining = durationMs;
  let guard = 0;
  while (remaining > 0 && guard < 30) {
    guard += 1;
    const boundary = nextLocalDayBoundary(cursor, calendar.timeZone);
    const segmentMs = Math.max(0, boundary.getTime() - cursor.getTime());
    if (!isPausedNonShippingDay(cursor, calendar)) {
      const consumed = Math.min(remaining, segmentMs);
      remaining -= consumed;
      cursor = new Date(cursor.getTime() + consumed);
    } else {
      cursor = boundary;
    }
  }
  return cursor;
}

function operationalMsBetween(start: Date, end: Date, calendar: OmnipackFulfillmentCalendarConfig): number {
  if (end.getTime() <= start.getTime()) return 0;
  let cursor = new Date(start);
  let total = 0;
  let guard = 0;
  while (cursor.getTime() < end.getTime() && guard < 30) {
    guard += 1;
    const boundary = nextLocalDayBoundary(cursor, calendar.timeZone);
    const segmentEnd = boundary.getTime() < end.getTime() ? boundary : end;
    if (!isPausedNonShippingDay(cursor, calendar)) {
      total += Math.max(0, segmentEnd.getTime() - cursor.getTime());
    }
    cursor = segmentEnd;
  }
  return total;
}

function isPausedNonShippingDay(value: Date, calendar: OmnipackFulfillmentCalendarConfig): boolean {
  const weekday = localWeekday(value, calendar.timeZone);
  return weekday === calendar.pausedWeekday || !calendar.operationalWeekdays.has(weekday);
}

function nextLocalDayBoundary(value: Date, timeZone: string): Date {
  const dayKey = localDayKey(value, timeZone);
  let low = value.getTime() + 1;
  let high = value.getTime() + 36 * 60 * 60 * 1000;
  while (localDayKey(new Date(high), timeZone) === dayKey) {
    high += 12 * 60 * 60 * 1000;
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (localDayKey(new Date(mid), timeZone) === dayKey) low = mid + 1;
    else high = mid;
  }
  return new Date(Math.round(high / 1000) * 1000);
}

function localDayKey(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

function localWeekday(value: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(value);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((candidate) => candidate.type === type)?.value ?? "";
}


function emptyOps(): OmnipackProviderOpsSummary {
  return { status: "none", providerOrderId: null, sla: null };
}
