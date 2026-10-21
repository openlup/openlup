import type { PgQueryExecutor } from "../data/index.js";
import { assertPrimaryUnitGtinAuthority, type CatalogSkuIdentifier } from "./contracts/foundation.js";
import { BundleCatalogReadError, type BundleCatalogReadPort, type BundleComponentRow, type BundleSummary, type GetBundleInput } from "./bundleCatalogReadPort.js";
import { uniqueBundlePrice, selectEffectiveBundleTargetPrice } from "./bundlePriceSelection.js";
import { COUNT_SQL } from "./bundleCatalogQueries.js";
import { LIST_SQL, DETAIL_SQL, COMPONENT_SQL, FEED_COMPONENT_SQL, PRICE_SQL, OWN_LIST_SQL, CURRENCY_LIST_SQL, FEED_SQL } from "./effectiveBundleCatalogQueries.js";

interface BundleRow {
  id: string;
  code: string;
  title: string;
  status: string;
  fulfillment_mode: string;
  updated_at: string;
  component_count: string | number;
  has_active_target_price: boolean;
  composition_constraint: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

interface ComponentRow {
  bundle_id: string;
  sku: string;
  title: string | null;
  product_slug: string;
  variant_id: string;
  quantity: number;
  is_addon: boolean;
  sort_order: number;
  reference_unit_price_minor: number | null;
  reference_price_count: number | string;
  sku_status: string;
  product_status: string;
  net_weight_g: number;
  sellable_standalone: boolean;
  sellable_in_subscription: boolean;
  document_ready: boolean;
  identifiers: CatalogSkuIdentifier[];
}

interface PriceRow {
  price_list_id: string;
  mode: string;
  target_price_minor: number;
  currency: string;
  amount_kind: string;
  active: boolean;
  valid_from: string;
  valid_to: string | null;
}

interface ActiveBundleRow {
  id: string;
  code: string;
  title: string;
  fulfillment_mode: string;
  mode: string;
  target_price_minor: number;
  price_list_id: string;
  currency: string;
  region_code: string;
}


/** Selected only by the explicit effective-authority option. */
export function createEffectiveBundleCatalogStore(executor: PgQueryExecutor, incumbent: BundleCatalogReadPort): BundleCatalogReadPort {
  async function rows<T>(sql: string, values: unknown[]): Promise<T[]> {
    const result = await executor.query(sql, values).catch((error: unknown) => {
      throw new BundleCatalogReadError(error instanceof Error ? error.message : String(error));
    });
    return (result.rows ?? []) as unknown as T[];
  }
  async function selectPriceList(bundleId: string, input: GetBundleInput): Promise<{ id: string; currency: string } | null> {
    const atTime = input.atTime ?? new Date().toISOString(), mode = input.mode ?? "one_time";
    const own = input.currency ? [] : await rows<{ id: string; currency: string; region_code: string; mode: string }>(OWN_LIST_SQL, [bundleId, mode, atTime]);
    const chosenPrice = uniqueBundlePrice(own, mode), chosen = chosenPrice ? [chosenPrice] : [];
    const currency = input.currency ?? chosen[0]?.currency;
    if (!currency) return null;
    const candidates = await rows<{ id: string; currency: string }>(CURRENCY_LIST_SQL, [currency, input.regionCode ?? chosen[0]?.region_code ?? null, atTime]);
    if (candidates.length > 1) throw new BundleCatalogReadError("bundle_price_list_ambiguous");
    if (chosen[0] && candidates[0] && chosen[0].id !== candidates[0].id) throw new BundleCatalogReadError("bundle_price_list_changed");
    return candidates[0] ?? null;
  }
  return {
    ...incumbent,
    async listBundles(input) {
      const filter = [input.status, input.query ?? null];
      const [page, counted] = await Promise.all([
        rows<BundleRow>(LIST_SQL, [...filter, input.limit, input.offset]),
        rows<{ total: string | number }>(COUNT_SQL, filter),
      ]);
      return { bundles: page.map(toSummary), total: Number(counted[0]?.total ?? page.length) };
    },
    async getBundle(input) {
      const bundle = (await rows<BundleRow>(DETAIL_SQL, [input.code]))[0];
      if (!bundle) return null;
      const atTime = input.atTime ?? new Date().toISOString();
      const list = await selectPriceList(bundle.id, { ...input, atTime });
      const [componentRows, priceRows] = await Promise.all([
        rows<ComponentRow>(COMPONENT_SQL, [bundle.id, list?.id ?? null, atTime, input.mode ?? "one_time"]).then(rows => rows.map(toComponent)),
        rows<PriceRow>(PRICE_SQL, [bundle.id]),
      ]);
      return {
        ...toSummary(bundle), compositionConstraint: toConstraint(bundle.composition_constraint), metadata: bundle.metadata ?? {},
        components: componentRows, prices: priceRows.map(toPrice),
        resolvedTargetPrice: selectEffectiveBundleTargetPrice(priceRows.map(row => ({ price: toPrice(row), priceListId: row.price_list_id })),
          { priceListId: list?.id ?? null, currency: list?.currency ?? null, mode: input.mode ?? "one_time", atTime }),
        resolvedCurrency: list?.currency ?? null, resolvedPriceListId: list?.id ?? null,
      };
    },
    async listActiveBundleCompositions(input = {}) {
      const atTime = input.atTime ?? new Date().toISOString(), mode = input.mode ?? "one_time";
      const feed = await rows<ActiveBundleRow>(FEED_SQL, [input.currency ?? null, input.regionCode ?? null, atTime, mode]);
      const selected = new Map<string, ActiveBundleRow>();
      const listReads = new Map<string, Promise<{ id: string }[]>>();
      for (const row of feed) {
        const same = feed.filter(candidate => candidate.id === row.id);
        const candidate = uniqueBundlePrice(same, mode)!;
        const key = `${row.currency}:${row.region_code}`;
        if (!listReads.has(key)) listReads.set(key, rows<{ id: string }>(CURRENCY_LIST_SQL, [row.currency, row.region_code ?? null, atTime]));
        const lists = await listReads.get(key)!;
        if (lists.length > 1) throw new BundleCatalogReadError("bundle_price_list_ambiguous");
        if (lists[0]?.id !== row.price_list_id) throw new BundleCatalogReadError("bundle_price_list_changed");
        selected.set(row.id, candidate);
      }
      if (!selected.size) return [];
      const chosen = [...selected.values()];
      const source = await rows<ComponentRow>(FEED_COMPONENT_SQL, [chosen.map(row => row.id), chosen.map(row => row.price_list_id), atTime, mode]);
      const byBundle = groupComponents(source);
      const sellable = chosen.filter(row => {
        const components = source.filter(component => component.bundle_id === row.id);
        return components.length > 0 && components.every(component => componentReady(component, mode));
      });
      return sellable.map(row => ({ code: row.code, title: row.title, fulfillmentMode: row.fulfillment_mode,
        currency: row.currency, targetPriceMinor: row.target_price_minor, mode: row.mode, components: byBundle.get(row.id) ?? [] }));
    },
  };
}

function groupComponents(rows: readonly ComponentRow[]): Map<string, BundleComponentRow[]> {
  const grouped = new Map<string, BundleComponentRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.bundle_id) ?? [];
    bucket.push(toComponent(row));
    grouped.set(row.bundle_id, bucket);
  }
  return grouped;
}

function toComponent(row: ComponentRow): BundleComponentRow {
  if (Number(row.reference_price_count) > 1) throw new BundleCatalogReadError("bundle_price_ambiguous");
  return {
    sku: row.sku,
    title: row.title ?? null,
    productSlug: row.product_slug,
    variantId: row.variant_id,
    quantity: Number(row.quantity),
    isAddon: row.is_addon === true,
    sortOrder: Number(row.sort_order),
    referenceUnitPriceMinor:
      row.reference_unit_price_minor === null || row.reference_unit_price_minor === undefined
        ? null
        : Number(row.reference_unit_price_minor),
  };
}

function toSummary(row: BundleRow): BundleSummary {
  return {
    code: row.code,
    title: row.title,
    status: row.status,
    fulfillmentMode: row.fulfillment_mode,
    componentCount: Number(row.component_count ?? 0),
    hasActiveTargetPrice: row.has_active_target_price === true,
    updatedAt: row.updated_at,
  };
}

function toPrice(row: PriceRow) {
  return {
    mode: row.mode,
    targetPriceMinor: Number(row.target_price_minor),
    currency: row.currency,
    amountKind: row.amount_kind,
    active: row.active === true,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? null,
  };
}

/** An empty envelope is stored as `{}`; that is "unconstrained", not a constraint. */
function toConstraint(value: Record<string, unknown> | null) {
  if (!value || typeof value.kind !== "string" || value.kind.trim() === "") return null;
  return {
    kind: value.kind,
    version: typeof value.version === "number" ? value.version : 0,
    data: (value.data ?? {}) as Record<string, unknown>,
  };
}

function componentReady(row: ComponentRow, mode: string): boolean {
  try { assertPrimaryUnitGtinAuthority(row.identifiers); } catch { return false; }
  return row.sku_status === "active" && row.product_status === "active" && row.document_ready === true
    && Number.isSafeInteger(row.net_weight_g) && row.net_weight_g > 0
    && (mode === "subscription" ? row.sellable_in_subscription : row.sellable_standalone)
    && row.reference_unit_price_minor !== null && Number.isSafeInteger(Number(row.reference_unit_price_minor))
    && Number(row.reference_unit_price_minor) > 0;
}
