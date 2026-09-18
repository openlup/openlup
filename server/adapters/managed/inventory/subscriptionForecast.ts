import {
  buildSubscriptionInventoryForecast,
  type InventoryProviderStockLine,
} from "../../../../src/domains/inventory/forecast.js";
import type {
  AdminInventorySubscriptionForecastRequest,
  InventoryForecastDemandLine,
  InventoryForecastSupplyLine,
  InventoryStockLine,
  InventorySubscriptionForecastResponse,
} from "../../../../src/domains/inventory/contracts.js";
import { InventoryPersistenceError } from "../../../../src/domains/inventory/ports.js";
import type { ManagedInventoryClient } from "./inventoryPort.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function readSubscriptionForecast(
  client: ManagedInventoryClient,
  request: AdminInventorySubscriptionForecastRequest,
): Promise<InventorySubscriptionForecastResponse> {
  const generatedAt = new Date().toISOString();
  const [providerRows, subscriptionRows, reservationRows, stockRows, supplyRows] = await Promise.all([
    readRows<ProviderStockCurrentRow>(
      client
        .from("fulfillment_provider_stock_current")
        .select("catalog_sku_id, sku, provider_for_sale_quantity, last_synced_at, stale_after")
        .eq("provider_kind", "omnipack"),
      "OmniPack provider-current stock read failed",
    ),
    readRows<SubscriptionRow>(
      client
        .from("subscriptions")
        .select("id, status, cadence_days, next_cycle_at")
        .in("status", ["active", "paused", "cancelled"])
        .order("next_cycle_at", { ascending: true }),
      "Subscription forecast subscriptions read failed",
    ),
    readRows<InventoryReservationForecastRow>(
      client
        .from("inventory_reservations")
        .select("sku_id, quantity, metadata")
        .eq("status", "reserved"),
      "Subscription forecast reservations read failed",
    ),
    readRows<InventoryBalanceForecastRow>(stockQuery(client), "Subscription forecast stock read failed"),
    readRows<InventorySupplyPlanForecastRow>(
      client
        .from("inventory_supply_plans")
        .select("sku_id, quantity, expected_at, status")
        .order("expected_at", { ascending: true }),
      "Subscription forecast supply plans read failed",
    ),
  ]);

  const activeSubscriptions = subscriptionRows.filter((row) => row.status === "active");
  const activeForecastable = activeSubscriptions.filter((row) =>
    Boolean(row.next_cycle_at) && Number.isFinite(row.cadence_days) && row.cadence_days > 0
  );
  const subscriptionLines = await readSubscriptionLines(client, activeForecastable.map((row) => row.id));
  const skuMap = await readSkuMap(client, subscriptionLines.map((row) => row.variant_id));
  const lineMap = groupBy(subscriptionLines, (line) => line.subscription_id);

  return buildSubscriptionInventoryForecast({
    generatedAt,
    horizonDays: request.horizonDays,
    protectionDays: request.protectionDays,
    providerCurrent: providerRows.flatMap(mapProviderStock),
    openHardReservations: reservationRows
      .filter((row) => metadataProviderKind(row.metadata) === "omnipack")
      .map((row) => ({ skuId: row.sku_id, quantity: row.quantity })),
    stock: stockRows.map(mapStockRow),
    demand: buildDemand({
      subscriptions: activeForecastable,
      linesBySubscription: lineMap,
      skuMap,
      generatedAt,
      horizonDays: request.horizonDays,
    }),
    supply: supplyRows.flatMap(mapSupply),
    activeSubscriptionCount: activeSubscriptions.length,
    excludedSubscriptionCount: subscriptionRows.length - activeForecastable.length,
  });
}

async function readSubscriptionLines(
  client: ManagedInventoryClient,
  subscriptionIds: string[],
): Promise<SubscriptionLineForecastRow[]> {
  if (subscriptionIds.length === 0) return [];
  return readRows<SubscriptionLineForecastRow>(
    client
      .from("subscription_lines")
      .select("subscription_id, variant_id, qty")
      .in("subscription_id", subscriptionIds),
    "Subscription forecast subscription lines read failed",
  );
}

async function readSkuMap(client: ManagedInventoryClient, skuIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(skuIds.filter(Boolean))];
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const rows = await readRows<SkuRow>(
    client.from("catalog_skus").select("id, sku").in("id", ids),
    "Subscription forecast catalog SKU read failed",
  );
  for (const row of rows) map.set(row.id, row.sku);
  return map;
}

function buildDemand(input: {
  subscriptions: SubscriptionRow[];
  linesBySubscription: Map<string, SubscriptionLineForecastRow[]>;
  skuMap: Map<string, string>;
  generatedAt: string;
  horizonDays: number;
}): InventoryForecastDemandLine[] {
  const horizonAtMs = Date.parse(input.generatedAt) + input.horizonDays * DAY_MS;
  return input.subscriptions.flatMap((subscription) => {
    const lines = input.linesBySubscription.get(subscription.id) ?? [];
    const nextCycleAt = subscription.next_cycle_at ? new Date(subscription.next_cycle_at) : null;
    if (!nextCycleAt || Number.isNaN(nextCycleAt.getTime())) return [];

    const demand: InventoryForecastDemandLine[] = [];
    for (
      let dueAtMs = nextCycleAt.getTime();
      dueAtMs <= horizonAtMs;
      dueAtMs += subscription.cadence_days * DAY_MS
    ) {
      for (const line of lines) {
        if (line.qty <= 0) continue;
        demand.push({
          subscriptionId: subscription.id,
          subscriptionCycleId: null,
          skuId: line.variant_id,
          sku: input.skuMap.get(line.variant_id) ?? "unknown",
          quantity: line.qty,
          dueAt: new Date(dueAtMs).toISOString(),
          status: "planned",
        });
      }
    }
    return demand;
  });
}

async function readRows<T>(query: PromiseLike<ManagedQueryResult>, message: string): Promise<T[]> {
  const result = await query;
  if (result.error) throw new InventoryPersistenceError(message);
  return Array.isArray(result.data) ? result.data as T[] : [];
}

function stockQuery(client: ManagedInventoryClient) {
  return client
    .from("inventory_balances")
    .select(
      "sku_id, location_id, lot_id, on_hand, reserved, unavailable, incoming, safety_stock, catalog_skus!inventory_balances_sku_id_fkey!inner(sku), inventory_locations!inventory_balances_location_id_fkey!inner(code, kind, status, fulfillable), inventory_lots!inventory_balances_lot_id_fkey(lot_code, status, expires_at)",
    )
    .order("updated_at", { ascending: false });
}

function mapProviderStock(row: ProviderStockCurrentRow): InventoryProviderStockLine[] {
  if (!row.catalog_sku_id) return [];
  return [{
    skuId: row.catalog_sku_id,
    sku: row.sku,
    forSaleQuantity: row.provider_for_sale_quantity,
    lastSyncedAt: row.last_synced_at,
    staleAfter: row.stale_after,
  }];
}

function mapSupply(row: InventorySupplyPlanForecastRow): InventoryForecastSupplyLine[] {
  if (row.quantity <= 0 || !["planned", "received", "cancelled"].includes(row.status)) return [];
  return [{ skuId: row.sku_id, quantity: row.quantity, expectedAt: row.expected_at, status: row.status }];
}

function mapStockRow(row: InventoryBalanceForecastRow): InventoryStockLine {
  return {
    skuId: row.sku_id,
    sku: row.catalog_skus?.sku ?? "unknown",
    locationId: row.location_id,
    locationCode: row.inventory_locations?.code ?? "unknown",
    locationKind: row.inventory_locations?.kind ?? "virtual",
    locationStatus: row.inventory_locations?.status ?? "inactive",
    fulfillable: row.inventory_locations?.fulfillable ?? false,
    lotId: row.lot_id,
    lotCode: row.inventory_lots?.lot_code ?? null,
    lotStatus: row.inventory_lots?.status ?? null,
    expiresAt: row.inventory_lots?.expires_at ?? null,
    onHand: row.on_hand,
    reserved: row.reserved,
    unavailable: row.unavailable,
    incoming: row.incoming,
    safetyStock: row.safety_stock,
  };
}

function metadataProviderKind(value: unknown): string | null {
  return isRecord(value) && typeof value.providerKind === "string"
    ? value.providerKind.trim().toLowerCase()
    : null;
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    map.set(groupKey, [...(map.get(groupKey) ?? []), value]);
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ManagedQueryResult {
  data: unknown;
  error: { message?: string } | null;
}

interface ProviderStockCurrentRow {
  catalog_sku_id: string | null;
  sku: string;
  provider_for_sale_quantity: number;
  last_synced_at: string;
  stale_after: string;
}

interface SubscriptionRow {
  id: string;
  status: string;
  cadence_days: number;
  next_cycle_at: string | null;
}

interface SubscriptionLineForecastRow {
  subscription_id: string;
  variant_id: string;
  qty: number;
}

interface SkuRow {
  id: string;
  sku: string;
}

interface InventoryReservationForecastRow {
  sku_id: string;
  quantity: number;
  metadata: unknown;
}

interface InventorySupplyPlanForecastRow {
  sku_id: string;
  quantity: number;
  expected_at: string;
  status: "planned" | "received" | "cancelled";
}

interface InventoryBalanceForecastRow {
  sku_id: string;
  location_id: string;
  lot_id: string | null;
  on_hand: number;
  reserved: number;
  unavailable: number;
  incoming: number;
  safety_stock: number;
  catalog_skus?: { sku?: string } | null;
  inventory_locations?: {
    code?: string;
    kind?: InventoryStockLine["locationKind"];
    status?: InventoryStockLine["locationStatus"];
    fulfillable?: boolean;
  } | null;
  inventory_lots?: {
    lot_code?: string | null;
    status?: InventoryStockLine["lotStatus"];
    expires_at?: string | null;
  } | null;
}
