import type {
  AdminShipmentsFilter,
  AdminShipmentsOverviewResponse,
} from "../../../src/domains/fulfillment/contracts.js";
import type { FulfillmentShipmentsOverviewPort } from "../../../src/domains/fulfillment/ports.js";

type ApprovedShipmentRow = AdminShipmentsOverviewResponse["approved"][number];
type PackingShipmentRow = AdminShipmentsOverviewResponse["packing"][number];
type ShippedShipmentRow = AdminShipmentsOverviewResponse["shipped"][number];
type TesterRow = ApprovedShipmentRow | PackingShipmentRow | ShippedShipmentRow;
type TesterQueryResult = PromiseLike<{
  data: TesterRow[] | null;
  error: { message?: string } | null;
  count?: number | null;
}>;

interface TesterQuery extends TesterQueryResult {
  select(columns: string, options?: { count?: "exact"; head?: boolean }): TesterQuery;
  in(column: string, values: readonly string[]): TesterQuery;
  order(column: string, options?: { ascending?: boolean }): TesterQuery;
  eq(column: string, value: unknown): TesterQuery;
  gte(column: string, value: unknown): TesterQuery;
}

export interface ShipmentsOverviewSupabaseClient {
  from(table: "testers"): TesterQuery;
}

const SHIPPED_HISTORY_STATUSES = [
  "shipped",
  "in_transit",
  "delivered",
  "feedback_mid",
  "feedback_final",
  "feedback_reminder",
  "completed",
] as const;

export function createSupabaseShipmentsOverviewPort(
  client: ShipmentsOverviewSupabaseClient,
): FulfillmentShipmentsOverviewPort {
  return {
    async getShipmentsOverview({ shippedFilter }) {
      let shippedQuery = client
        .from("testers")
        .select("id, first_name, last_name, city, status, status_updated_at, delivered_at, tracking_number, tracking_url")
        .in("status", SHIPPED_HISTORY_STATUSES)
        .order("status_updated_at", { ascending: false });
      const threshold = shippedFilterThreshold(shippedFilter);
      if (threshold) shippedQuery = shippedQuery.gte("status_updated_at", threshold);

      const [approved, packing, shippedToday, shipped] = await Promise.all([
        client
          .from("testers")
          .select("id, first_name, last_name, city, postal_code, dog_weight_kg, cat_weight_kg, pet_type")
          .eq("status", "approved")
          .order("created_at"),
        client
          .from("testers")
          .select("id, first_name, last_name, email, phone, street, city, postal_code, tracking_number, label_url, dhl_shipment_id, dhl_shipment_date")
          .eq("status", "packing")
          .order("created_at"),
        client
          .from("testers")
          .select("*", { count: "exact", head: true })
          .eq("status", "shipped")
          .gte("status_updated_at", startOfWarsawDayIso()),
        shippedQuery,
      ]);

      if (approved.error) throw approved.error;
      if (packing.error) throw packing.error;
      if (shippedToday.error) throw shippedToday.error;
      if (shipped.error) throw shipped.error;

      return {
        approved: (approved.data ?? []) as ApprovedShipmentRow[],
        packing: (packing.data ?? []) as PackingShipmentRow[],
        shippedToday: shippedToday.count ?? 0,
        shipped: ((shipped.data ?? []) as ShippedShipmentRow[]).map((row) => ({
          ...row,
          status: row.status ?? "shipped",
        })),
      };
    },
  };
}

function shippedFilterThreshold(filter: AdminShipmentsFilter): string | null {
  if (filter === "all") return null;
  if (filter === "today") return startOfWarsawDayIso();

  const date = new Date();
  date.setDate(date.getDate() - (filter === "7d" ? 7 : 30));
  return date.toISOString();
}

function startOfWarsawDayIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "1");
  let utcMillis = Date.UTC(value("year"), value("month") - 1, value("day"));

  for (let i = 0; i < 3; i += 1) {
    const rendered = warsawDateTimeParts(new Date(utcMillis));
    const renderedUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second,
    );
    const targetUtc = Date.UTC(value("year"), value("month") - 1, value("day"));
    const delta = renderedUtc - targetUtc;
    if (delta === 0) break;
    utcMillis -= delta;
  }

  return new Date(utcMillis).toISOString();
}

function warsawDateTimeParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}
