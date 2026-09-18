import type {
  AdminCatalogSkuPack,
  AdminCatalogSkuPacksItem,
} from "../../../src/domains/catalog/contracts.js";
import type { CatalogSkuPacksReadPort } from "../../../src/domains/catalog/ports.js";

const PACKS_TABLE = "catalog_sku_eans";
const PACKS_COLUMNS = "sku, ean, kind, quantity, is_primary, source";

interface PackRow {
  sku: string;
  ean: string;
  kind: string;
  quantity: number;
  is_primary: boolean;
  source: string;
}

type PacksQueryResult = PromiseLike<{
  data: PackRow[] | null;
  error: { message?: string } | null;
}>;

interface PacksQuery extends PacksQueryResult {
  select(columns: string): PacksQuery;
  order(column: string, options: { ascending: boolean }): PacksQuery;
}

export interface CatalogSkuPacksSupabaseClient {
  from(table: typeof PACKS_TABLE): PacksQuery;
}

export function createSupabaseCatalogSkuPacksPort(
  client: CatalogSkuPacksSupabaseClient,
): CatalogSkuPacksReadPort {
  return {
    async getCatalogSkuPacks() {
      const { data, error } = await client
        .from(PACKS_TABLE)
        .select(PACKS_COLUMNS)
        .order("sku", { ascending: true })
        .order("is_primary", { ascending: false });
      if (error) throw new Error(error.message ?? "catalog_sku_packs_query_failed");

      const bySku = new Map<string, AdminCatalogSkuPacksItem>();
      let totalPacks = 0;
      for (const row of data ?? []) {
        if (!row.sku || !row.ean) continue;
        const item = bySku.get(row.sku) ?? { sku: row.sku, packs: [] };
        item.packs.push(toPack(row));
        bySku.set(row.sku, item);
        totalPacks += 1;
      }

      return { skus: [...bySku.values()], totalPacks };
    },
  };
}

function toPack(row: PackRow): AdminCatalogSkuPack {
  return {
    ean: String(row.ean),
    kind: row.kind === "collective" ? "collective" : "unit",
    quantity: row.quantity,
    isPrimary: row.is_primary === true,
    source: row.source === "omnipack" ? "omnipack" : "local",
  };
}
