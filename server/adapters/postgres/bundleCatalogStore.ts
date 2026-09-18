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
import type { PgQueryExecutor } from "./queryBuilder.js";
import {
  LIST_SQL,
  COUNT_SQL,
  DETAIL_SQL,
  COMPONENT_SQL,
  FEED_COMPONENT_SQL,
  PRICE_SQL,
  OWN_LIST_SQL,
  CURRENCY_LIST_SQL,
  FEED_SQL,
  HISTORY_SQL,
  HISTORY_COUNT_SQL,
} from "./bundleCatalogQueries.js";


/**
 * Direct-Postgres adapter for the bundle read port. A real adapter: it renders the
 * joins itself, against the same three relations both chains declare, and reads no
 * row the port's contract does not name.
 *
 * It goes through no transaction lane and switches no role. A read needs no
 * principal, and the public platform manifest declares no managed role to switch
 * into; the port contract has no write operation, so read-only is a property of
 * the shape rather than a promise in a comment.
 *
 * The one place the two chains genuinely differ is the operator trail: this chain
 * reads the neutral `catalog_bundle_write_events` ledger the platform forward
 * created, because it has no audit table and no operator registry to name.
 */

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
}

interface PriceRow {
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
}

interface WriteEventRow {
  id: string;
  bundle_code: string;
  action: string;
  before_state: unknown;
  after_state: unknown;
  created_at: string;
}

export function createPostgresBundleCatalogStore(
  executor: PgQueryExecutor,
): BundleCatalogReadPort {
  async function rows<T>(sql: string, values: unknown[]): Promise<T[]> {
    // A driver failure becomes the port's own read error, so a caller sees the
    // same distinction between "found nothing" and "could not ask" on both chains.
    const result = await executor.query(sql, values).catch((error: unknown) => {
      throw new BundleCatalogReadError(error instanceof Error ? error.message : String(error));
    });
    return (result.rows ?? []) as unknown as T[];
  }

  async function components(bundleId: string, priceListId: string | null) {
    return (await rows<ComponentRow>(COMPONENT_SQL, [bundleId, priceListId])).map(toComponent);
  }

  async function selectPriceList(
    bundleId: string,
    input: GetBundleInput,
  ): Promise<{ id: string; currency: string } | null> {
    const list = input.currency
      ? await rows<{ id: string; currency: string }>(CURRENCY_LIST_SQL, [input.currency])
      : await rows<{ id: string; currency: string }>(OWN_LIST_SQL, [bundleId, input.mode ?? null]);
    return list[0] ?? null;
  }

  return {
    async listBundles(input: ListBundlesInput): Promise<ListBundlesResult> {
      const filter = [input.status, input.query ?? null];
      const [page, counted] = await Promise.all([
        rows<BundleRow>(LIST_SQL, [...filter, input.limit, input.offset]),
        rows<{ total: string | number }>(COUNT_SQL, filter),
      ]);
      return { bundles: page.map(toSummary), total: Number(counted[0]?.total ?? page.length) };
    },

    async getBundle(input: GetBundleInput): Promise<BundleDetail | null> {
      const bundle = (await rows<BundleRow>(DETAIL_SQL, [input.code]))[0];
      if (!bundle) return null;
      const list = await selectPriceList(bundle.id, input);
      const [componentRows, priceRows] = await Promise.all([
        components(bundle.id, list?.id ?? null),
        rows<PriceRow>(PRICE_SQL, [bundle.id]),
      ]);
      return {
        ...toSummary(bundle),
        compositionConstraint: toConstraint(bundle.composition_constraint),
        metadata: bundle.metadata ?? {},
        components: componentRows,
        prices: priceRows.map(toPrice),
        resolvedCurrency: list?.currency ?? null,
        resolvedPriceListId: list?.id ?? null,
      };
    },

    async listActiveBundleCompositions(
      input: { currency?: string } = {},
    ): Promise<ActiveBundleComposition[]> {
      // A bundle may carry several active prices (a scheduled successor); the feed
      // takes the newest window per bundle, which is what the ORDER BY already put first.
      const selected = new Map<string, ActiveBundleRow>();
      for (const row of await rows<ActiveBundleRow>(FEED_SQL, [input.currency ?? null])) {
        if (!selected.has(row.id)) selected.set(row.id, row);
      }
      if (selected.size === 0) return [];

      const chosen = [...selected.values()];
      const byBundle = groupComponents(
        await rows<ComponentRow>(FEED_COMPONENT_SQL, [
          chosen.map((row) => row.id),
          chosen.map((row) => row.price_list_id),
        ]),
      );
      return chosen.map((row) => ({
        code: row.code,
        title: row.title,
        fulfillmentMode: row.fulfillment_mode,
        currency: row.currency,
        targetPriceMinor: row.target_price_minor,
        mode: row.mode,
        components: byBundle.get(row.id) ?? [],
      }));
    },

    async listBundleHistory(input: BundleHistoryInput): Promise<BundleHistoryResult> {
      const [page, counted] = await Promise.all([
        rows<WriteEventRow>(HISTORY_SQL, [input.code, input.limit, input.offset]),
        rows<{ total: string | number }>(HISTORY_COUNT_SQL, [input.code]),
      ]);
      return {
        // This chain has no operator registry, so it can record WHICH principal
        // wrote but never what kind of actor it was; both fields stay null rather
        // than being invented from the principal id.
        events: page.map((row) => ({
          id: row.id,
          action: row.action,
          actorKind: null,
          actorEmail: null,
          entityId: row.bundle_code,
          oldValue: row.before_state ?? null,
          newValue: row.after_state ?? null,
          occurredAt: row.created_at,
        })),
        total: Number(counted[0]?.total ?? page.length),
      };
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
