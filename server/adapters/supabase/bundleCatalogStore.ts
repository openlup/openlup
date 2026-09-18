import {
  AUDIT_COLUMNS,
  BUNDLE_COLUMNS,
  COMPONENT_COLUMNS,
  PRICE_COLUMNS,
  first,
  isString,
  sortComponents,
  tally,
  toConstraint,
  toPrice,
  toSummary,
  type AuditRow,
  type BundleRow,
  type ComponentRow,
  type PriceEntryRow,
  type PriceRow,
} from "./bundleCatalogProjection.js";
import {
  BundleCatalogReadError,
} from "../../domains/bundle/bundleCatalogReadPort.js";
import type {
  ActiveBundleComposition,
  BundleCatalogReadPort,
  BundleComponentRow,
  BundleDetail,
  BundleHistoryInput,
  BundleHistoryResult,
  BundleSummary,
  GetBundleInput,
  ListBundlesInput,
  ListBundlesResult,
} from "../../domains/bundle/bundleCatalogReadPort.js";

/**
 * Managed-platform adapter for the bundle read port.
 *
 * It JOINS the catalogue itself — sku, product slug and the price list are
 * embedded selects on the same request — rather than composing a general catalog
 * read port. A bundle needs three columns of a unit and one number from a price
 * list; borrowing a port that answers a different question would have meant
 * re-filtering someone else's lifecycle rules on the way back.
 *
 * The client interface below is deliberately NARROW: it names only the query
 * operations this adapter performs. Nothing here imports a hosted SDK type, so the
 * adapter can be driven by a scripted double in the shared contract table and the
 * runtime binding is the only place a real client is cast into it.
 */

export interface BundleCatalogQueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
  count?: number | null;
}

export interface BundleCatalogQueryBuilder extends PromiseLike<BundleCatalogQueryResult> {
  select(columns: string, options?: Record<string, unknown>): BundleCatalogQueryBuilder;
  eq(column: string, value: unknown): BundleCatalogQueryBuilder;
  in(column: string, values: readonly unknown[]): BundleCatalogQueryBuilder;
  or(filter: string): BundleCatalogQueryBuilder;
  order(column: string, options?: { ascending?: boolean }): BundleCatalogQueryBuilder;
  range(from: number, to: number): BundleCatalogQueryBuilder;
  limit(count: number): BundleCatalogQueryBuilder;
}

export interface BundleCatalogQueryClient {
  from(table: string): BundleCatalogQueryBuilder;
}

export function createManagedBundleCatalogStore(
  client: BundleCatalogQueryClient,
): BundleCatalogReadPort {
  async function read<T>(builder: BundleCatalogQueryBuilder, what: string) {
    const result = await builder;
    if (result.error) throw new BundleCatalogReadError(result.error.message ?? `${what} read failed`);
    return { rows: (result.data ?? []) as T[], count: result.count ?? null };
  }

  async function componentsFor(
    bundleIds: readonly string[],
    listByBundle: ReadonlyMap<string, string>,
  ): Promise<Map<string, BundleComponentRow[]>> {
    if (bundleIds.length === 0) return new Map();
    const { rows } = await read<ComponentRow>(
      client.from("catalog_bundle_components").select(COMPONENT_COLUMNS).in("bundle_id", bundleIds),
      "catalog_bundle_components",
    );
    const listIds = [...new Set(listByBundle.values())];
    const prices = await referencePrices(rows, listIds);

    const grouped = new Map<string, BundleComponentRow[]>();
    for (const row of sortComponents(rows)) {
      const unit = first(row.catalog_skus);
      if (!unit) continue;
      const listId = listByBundle.get(row.bundle_id);
      const bucket = grouped.get(row.bundle_id) ?? [];
      bucket.push({
        sku: unit.sku,
        title: unit.title ?? null,
        productSlug: first(unit.catalog_products)?.slug ?? "",
        variantId: unit.id,
        quantity: Number(row.quantity),
        isAddon: row.is_addon === true,
        sortOrder: Number(row.sort_order),
        referenceUnitPriceMinor: listId ? (prices.get(`${listId}:${unit.id}`) ?? null) : null,
      });
      grouped.set(row.bundle_id, bucket);
    }
    return grouped;
  }

  /**
   * Resolve every component's reference price in one request: the lowest active
   * tier per (list, unit). A unit the list prices nothing for is simply absent,
   * which the caller reads back as `null`.
   */
  async function referencePrices(
    componentRows: readonly ComponentRow[],
    listIds: readonly string[],
  ): Promise<Map<string, number>> {
    const variantIds = [
      ...new Set(componentRows.map((row) => first(row.catalog_skus)?.id).filter(isString)),
    ];
    if (variantIds.length === 0 || listIds.length === 0) return new Map();
    const { rows } = await read<PriceEntryRow>(
      client
        .from("price_entries")
        .select("variant_id, price_list_id, unit_price_minor, min_qty")
        .in("variant_id", variantIds)
        .in("price_list_id", listIds)
        .eq("active", true),
      "price_entries",
    );
    const lowest = new Map<string, PriceEntryRow>();
    for (const row of rows) {
      const key = `${row.price_list_id}:${row.variant_id}`;
      const held = lowest.get(key);
      if (!held || Number(row.min_qty) < Number(held.min_qty)) lowest.set(key, row);
    }
    return new Map([...lowest].map(([key, row]) => [key, Number(row.unit_price_minor)]));
  }

  async function pricesFor(bundleIds: readonly string[]): Promise<PriceRow[]> {
    if (bundleIds.length === 0) return [];
    const { rows } = await read<PriceRow>(
      client.from("catalog_bundle_prices").select(PRICE_COLUMNS).in("bundle_id", bundleIds),
      "catalog_bundle_prices",
    );
    return rows;
  }

  async function listForCurrency(currency: string): Promise<{ id: string; currency: string } | null> {
    const { rows } = await read<{ id: string; currency: string }>(
      client
        .from("price_lists")
        .select("id, currency")
        .eq("currency", currency)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1),
      "price_lists",
    );
    return rows[0] ?? null;
  }

  return {
    async listBundles(input: ListBundlesInput): Promise<ListBundlesResult> {
      let query = client.from("catalog_bundles").select(BUNDLE_COLUMNS, { count: "exact" });
      if (input.status !== "all") query = query.eq("status", input.status);
      if (input.query) {
        query = query.or(`code.ilike.%${input.query}%,title.ilike.%${input.query}%`);
      }
      const { rows, count } = await read<BundleRow>(
        query.order("code").range(input.offset, input.offset + input.limit - 1),
        "catalog_bundles",
      );
      const ids = rows.map((row) => row.id);
      const [componentRows, priceRows] = await Promise.all([
        ids.length === 0
          ? Promise.resolve({ rows: [] as ComponentRow[] })
          : read<ComponentRow>(
              client.from("catalog_bundle_components").select("bundle_id").in("bundle_id", ids),
              "catalog_bundle_components",
            ),
        pricesFor(ids),
      ]);
      const counts = tally(componentRows.rows.map((row) => row.bundle_id));
      const active = new Set(priceRows.filter((row) => row.active).map((row) => row.bundle_id));
      return {
        bundles: rows.map((row) => toSummary(row, counts.get(row.id) ?? 0, active.has(row.id))),
        total: count ?? rows.length,
      };
    },

    async getBundle(input: GetBundleInput): Promise<BundleDetail | null> {
      const { rows } = await read<BundleRow>(
        client.from("catalog_bundles").select(BUNDLE_COLUMNS).eq("code", input.code).limit(1),
        "catalog_bundles",
      );
      const bundle = rows[0];
      if (!bundle) return null;

      const priceRows = await pricesFor([bundle.id]);
      const own = priceRows
        .filter((row) => row.active && (!input.mode || row.mode === input.mode))
        .sort((left, right) => (left.valid_from < right.valid_from ? 1 : -1))[0];
      const list = input.currency
        ? await listForCurrency(input.currency)
        : own
          ? { id: own.price_list_id, currency: first(own.price_lists)?.currency ?? "" }
          : null;

      const components = await componentsFor(
        [bundle.id],
        new Map(list ? [[bundle.id, list.id]] : []),
      );
      return {
        ...toSummary(
          bundle,
          components.get(bundle.id)?.length ?? 0,
          priceRows.some((row) => row.active),
        ),
        compositionConstraint: toConstraint(bundle.composition_constraint),
        metadata: bundle.metadata ?? {},
        components: components.get(bundle.id) ?? [],
        prices: priceRows.map(toPrice),
        resolvedCurrency: list?.currency || null,
        resolvedPriceListId: list?.id ?? null,
      };
    },

    async listActiveBundleCompositions(
      input: { currency?: string } = {},
    ): Promise<ActiveBundleComposition[]> {
      const { rows } = await read<BundleRow>(
        client.from("catalog_bundles").select(BUNDLE_COLUMNS).eq("status", "active").order("code"),
        "catalog_bundles",
      );
      if (rows.length === 0) return [];

      // Newest active window per bundle, in the requested currency when one is named.
      const chosen = new Map<string, PriceRow>();
      for (const price of (await pricesFor(rows.map((row) => row.id)))
        .filter((row) => row.active)
        .filter((row) => !input.currency || first(row.price_lists)?.currency === input.currency)
        .sort((left, right) => (left.valid_from < right.valid_from ? 1 : -1))) {
        if (!chosen.has(price.bundle_id)) chosen.set(price.bundle_id, price);
      }
      const sellable = rows.filter((row) => chosen.has(row.id));
      const components = await componentsFor(
        sellable.map((row) => row.id),
        new Map(sellable.map((row) => [row.id, chosen.get(row.id)?.price_list_id ?? ""])),
      );
      return sellable.map((row) => {
        const price = chosen.get(row.id) as PriceRow;
        return {
          code: row.code,
          title: row.title,
          fulfillmentMode: row.fulfillment_mode,
          currency: first(price.price_lists)?.currency ?? "",
          targetPriceMinor: Number(price.target_price_minor),
          mode: price.mode,
          components: components.get(row.id) ?? [],
        };
      });
    },

    async listBundleHistory(input: BundleHistoryInput): Promise<BundleHistoryResult> {
      const { rows, count } = await read<AuditRow>(
        client
          .from("admin_audit_events")
          .select(AUDIT_COLUMNS, { count: "exact" })
          .eq("entity_type", "catalog_bundle")
          .eq("entity_id", input.code)
          .order("occurred_at", { ascending: false })
          .range(input.offset, input.offset + input.limit - 1),
        "admin_audit_events",
      );
      return {
        events: rows.map((row) => ({
          id: row.id,
          action: row.action,
          actorKind: row.actor_kind ?? null,
          actorEmail: row.actor_email ?? null,
          entityId: row.entity_id ?? null,
          oldValue: row.old_value ?? null,
          newValue: row.new_value ?? null,
          occurredAt: row.occurred_at,
        })),
        total: count ?? rows.length,
      };
    },
  };
}
