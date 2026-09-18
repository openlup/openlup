import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  CatalogHistoryEvent,
  CatalogHistoryRequest,
  CatalogPriceEntry,
  CatalogProductDetail,
  CatalogProductSummary,
  CatalogSkuDetail,
  ListCatalogProductsRequest,
} from "../../../src/domains/commerce/adminCatalogReadContracts.js";
import { CatalogRpcError } from "../../domains/commerce/adminCatalogDataPort.js";
import { catalogEnergyPerUnit, readProductEnergyPer100g } from "../catalogCurrentDocumentPayload.js";
import type {
  AdminCatalogReadDataPort,
  CatalogHistoryResult,
  ListCatalogProductsResult,
} from "../../../src/domains/commerce/adminCatalogReadContracts.js";

/**
 * @agent-domain-reference
 * Raw row shapes the catalog READ adapter selects from Supabase, co-located here
 * so the adapter file stays self-contained and the CI coverage guard (which
 * requires every changed server/*.ts file to have executable lines) is satisfied
 * without a standalone type-only file. These mirror the service-role SELECT
 * column lists in the functions below.
 */
interface CatalogProductRow {
  id: string;
  slug: string;
  status: string;
  name: string;
  allergens: string[] | null;
  marketing_content: Record<string, unknown> | null;
  current_document_revision_id: string | null;
}

interface CatalogSkuRow {
  id: string;
  product_id: string;
  sku: string;
  status: string;
  pet_type: string | null;
  title: string | null;
  net_weight_g: number | null;
  format_code: string | null;
  unit_form_code: string | null;
  gtin: string | null;
}

interface PriceEntryRow {
  variant_id: string;
  mode: string;
  unit_price_minor: number;
  active: boolean;
  valid_from: string | null;
  valid_to: string | null;
  price_lists: { currency: string | null } | { currency: string | null }[] | null;
}

interface AuditRow {
  id: string;
  action: string;
  actor_kind: string | null;
  actor_email: string | null;
  source: string | null;
  entity_type: string | null;
  entity_id: string | null;
  old_value: unknown;
  new_value: unknown;
  occurred_at: string;
}

/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain READ adapter.
 *
 * Supabase (service-role) read adapter. Plain SELECTs over catalog_products /
 * catalog_skus / price_entries / price_lists / admin_audit_events. Service-role
 * bypasses RLS (same trust posture as the write RPCs), so draft/archived rows are
 * visible — the admin/agent view, not the storefront's active-only one. */
export function createSupabaseAdminCatalogReadDataPort(
  client: SupabaseClient,
): AdminCatalogReadDataPort {
  return {
    async list(input: ListCatalogProductsRequest): Promise<ListCatalogProductsResult> {
      const allProducts = await fetchProductRows(client, input);
      const skusByProduct = await fetchSkusByProductId(
        client,
        allProducts.map((p) => p.id),
      );
      // petType is a SKU attribute (pet_type): keep only products with ≥1 matching SKU.
      const products = input.petType
        ? allProducts.filter((p) =>
            (skusByProduct.get(p.id) ?? []).some((s) => s.pet_type === input.petType),
          )
        : allProducts;
      const productIds = products.map((p) => p.id);
      const activePriceVariantIds = await fetchActivePriceVariantIds(client, productIds, skusByProduct);

      const total = products.length;
      const page = products.slice(input.offset, input.offset + input.limit);
      const summaries: CatalogProductSummary[] = page.map((product) => {
        const skus = skusByProduct.get(product.id) ?? [];
        const hasActivePrice = skus.some((s) => activePriceVariantIds.has(s.id));
        return {
          slug: product.slug,
          name: product.name,
          status: product.status,
          species: readSpecies(product.marketing_content),
          skuCount: skus.length,
          hasActivePrice,
        };
      });
      return { products: summaries, total };
    },

    async get(slug: string): Promise<CatalogProductDetail> {
      const { data, error } = await client
        .from("catalog_products")
        .select("id, slug, status, name, allergens, marketing_content, current_document_revision_id")
        .eq("slug", slug);
      if (error) throw new CatalogRpcError(undefined, error.message ?? "catalog_products read failed");
      const product = ((data ?? []) as unknown as CatalogProductRow[])[0];
      if (!product) throw new CatalogRpcError("P0002", "catalog_product_not_found");
      const skus = (await fetchSkusByProductId(client, [product.id])).get(product.id) ?? [];
      const priceEntriesByVariant = await fetchPriceEntriesByVariant(client, skus.map((s) => s.id));
      // Per-unit energy comes from the published document, never from the stale
      // per-unit column this projection stopped selecting (catalogRead.ts, BACKEND.md):
      // a number MCP `catalog__get` shows that the storefront denies is worse than null.
      const energyPer100g = await readProductEnergyPer100g(client as never, product);
      const skuDetails: CatalogSkuDetail[] = skus.map((sku) => ({
        sku: sku.sku,
        status: sku.status,
        petType: sku.pet_type ?? null,
        title: sku.title ?? null,
        netWeightGrams: sku.net_weight_g ?? null,
        formatCode: sku.format_code ?? null,
        unitFormCode: sku.unit_form_code ?? null,
        kcalPerUnit: catalogEnergyPerUnit(energyPer100g, sku.net_weight_g ?? undefined),
        gtin: sku.gtin ?? null,
        priceEntries: priceEntriesByVariant.get(sku.id) ?? [],
      }));

      const hasActivePrice = skuDetails.some((s) => s.priceEntries.some((p) => p.active));
      const publishBlockers: string[] = [];
      if (skuDetails.length === 0) publishBlockers.push("no_skus");
      if (!hasActivePrice) publishBlockers.push("price_required_to_sell");

      return {
        slug: product.slug,
        name: product.name,
        status: product.status,
        species: readSpecies(product.marketing_content),
        allergens: Array.isArray(product.allergens) ? product.allergens : [],
        marketingContent: isRecord(product.marketing_content) ? product.marketing_content : null,
        skus: skuDetails,
        readyToPublish: hasActivePrice,
        publishBlockers,
      };
    },

    async history(input: CatalogHistoryRequest): Promise<CatalogHistoryResult> {
      // Audit trail for a product: rows whose entity_id is the slug OR any of the
      // product's sku codes (set-price/archive audits key on the sku). Newest first.
      const skus = await fetchSkuCodesBySlug(client, input.slug);
      const entityIds = [input.slug, ...skus];

      const { data, error, count } = await client
        .from("admin_audit_events")
        .select(
          "id, action, actor_kind, actor_email, source, entity_type, entity_id, old_value, new_value, occurred_at",
          { count: "exact" },
        )
        .in("entity_id", entityIds)
        .order("occurred_at", { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);
      if (error) throw new CatalogRpcError(undefined, error.message ?? "admin_audit_events read failed");

      const rows = (data ?? []) as unknown as AuditRow[];
      const events: CatalogHistoryEvent[] = rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorKind: row.actor_kind ?? null,
        actorEmail: row.actor_email ?? null,
        source: row.source ?? null,
        entityType: row.entity_type ?? null,
        entityId: row.entity_id ?? null,
        oldValue: row.old_value ?? null,
        newValue: row.new_value ?? null,
        occurredAt: row.occurred_at,
      }));
      return { events, total: count ?? events.length };
    },
  };
}

async function fetchProductRows(
  client: SupabaseClient,
  input: ListCatalogProductsRequest,
): Promise<CatalogProductRow[]> {
  let query = client
    .from("catalog_products")
    .select("id, slug, status, name, allergens, marketing_content, current_document_revision_id")
    .order("slug", { ascending: true });
  if (input.status !== "all") query = query.eq("status", input.status);
  if (input.query) {
    const term = `%${input.query}%`;
    query = query.or(`slug.ilike.${term},name.ilike.${term}`);
  }
  const { data, error } = await query;
  if (error) throw new CatalogRpcError(undefined, error.message ?? "catalog_products read failed");
  let rows = (data ?? []) as unknown as CatalogProductRow[];
  // species lives in marketing_content (no column); petType filters on the SKU's
  // pet_type and is applied after the SKU fetch (see list()), so only species is
  // post-filtered here.
  if (input.species) {
    rows = rows.filter((r) => readSpecies(r.marketing_content) === input.species);
  }
  return rows;
}

async function fetchSkusByProductId(
  client: SupabaseClient,
  productIds: string[],
): Promise<Map<string, CatalogSkuRow[]>> {
  const byProduct = new Map<string, CatalogSkuRow[]>();
  if (productIds.length === 0) return byProduct;
  const { data, error } = await client
    .from("catalog_skus")
    .select(
      "id, product_id, sku, status, pet_type, title, net_weight_g, format_code, unit_form_code, gtin",
    )
    .in("product_id", productIds);
  if (error) throw new CatalogRpcError(undefined, error.message ?? "catalog_skus read failed");
  for (const row of (data ?? []) as unknown as CatalogSkuRow[]) {
    const bucket = byProduct.get(row.product_id) ?? [];
    bucket.push(row);
    byProduct.set(row.product_id, bucket);
  }
  return byProduct;
}

async function fetchSkuCodesBySlug(client: SupabaseClient, slug: string): Promise<string[]> {
  const { data: products, error: pErr } = await client
    .from("catalog_products")
    .select("id")
    .eq("slug", slug);
  if (pErr) throw new CatalogRpcError(undefined, pErr.message ?? "catalog_products read failed");
  const productId = ((products ?? []) as { id: string }[])[0]?.id;
  if (!productId) return [];
  const { data, error } = await client
    .from("catalog_skus")
    .select("sku")
    .eq("product_id", productId);
  if (error) throw new CatalogRpcError(undefined, error.message ?? "catalog_skus read failed");
  return ((data ?? []) as { sku: string }[]).map((r) => r.sku);
}

async function fetchActivePriceVariantIds(
  client: SupabaseClient,
  productIds: string[],
  skusByProduct: Map<string, CatalogSkuRow[]>,
): Promise<Set<string>> {
  const variantIds = productIds.flatMap((id) => (skusByProduct.get(id) ?? []).map((s) => s.id));
  const result = new Set<string>();
  if (variantIds.length === 0) return result;
  const { data, error } = await client
    .from("price_entries")
    .select("variant_id")
    .eq("active", true)
    .in("variant_id", variantIds);
  if (error) throw new CatalogRpcError(undefined, error.message ?? "price_entries read failed");
  for (const row of (data ?? []) as { variant_id: string }[]) result.add(row.variant_id);
  return result;
}

async function fetchPriceEntriesByVariant(
  client: SupabaseClient,
  variantIds: string[],
): Promise<Map<string, CatalogPriceEntry[]>> {
  const byVariant = new Map<string, CatalogPriceEntry[]>();
  if (variantIds.length === 0) return byVariant;
  const { data, error } = await client
    .from("price_entries")
    .select("variant_id, mode, unit_price_minor, active, valid_from, valid_to, price_lists!price_entries_price_list_id_fkey(currency)")
    .in("variant_id", variantIds)
    .order("valid_from", { ascending: false });
  if (error) throw new CatalogRpcError(undefined, error.message ?? "price_entries read failed");
  for (const row of (data ?? []) as unknown as PriceEntryRow[]) {
    const bucket = byVariant.get(row.variant_id) ?? [];
    bucket.push({
      mode: row.mode,
      unitPriceMinor: row.unit_price_minor,
      currency: readCurrency(row.price_lists),
      active: row.active,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    });
    byVariant.set(row.variant_id, bucket);
  }
  return byVariant;
}

function readCurrency(joined: PriceEntryRow["price_lists"]): string | null {
  if (!joined) return null;
  const row = Array.isArray(joined) ? joined[0] : joined;
  return row?.currency ?? null;
}

function readSpecies(marketingContent: Record<string, unknown> | null): string | null {
  const content = isRecord(marketingContent) ? marketingContent.content : null;
  if (isRecord(content) && typeof content.species === "string" && content.species.length > 0) {
    return content.species;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
