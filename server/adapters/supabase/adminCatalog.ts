import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ActivateCatalogProductRequest,
  ArchiveCatalogSkuRequest,
  CreateCatalogDraftRequest,
  SetCatalogPriceRequest,
  UpdateCatalogDraftRequest,
} from "../../../src/domains/commerce/adminCatalogContracts.js";
import type {
  ArchiveCatalogProductRequest,
  CloneCatalogDraftRequest,
  DeactivateCatalogProductRequest,
  RestoreCatalogProductRequest,
} from "../../../src/domains/commerce/adminCatalogLifecycleContracts.js";
import {
  type AdminCatalogDataPort,
  type CatalogWriteResult,
  CatalogRpcError,
} from "../../domains/commerce/adminCatalogDataPort.js";
import { buildCloneCreatePayload, loadCloneSource } from "./adminCatalogClone.js";

/**
 * @agent-domain-reference
 * REFERENCE IMPLEMENTATION — the canonical agent-operable domain Supabase adapter.
 *
 * Supabase (service-role) adapter — one RPC call per write op. The RPC enforces
 * every rule; this layer only marshals args and normalizes the result/error. */
export function createSupabaseAdminCatalogDataPort(client: SupabaseClient): AdminCatalogDataPort {
  async function callRpc(name: string, args: Record<string, unknown>): Promise<CatalogWriteResult> {
    const { data, error } = await client.rpc(name, args);
    if (error) {
      throw new CatalogRpcError(error.code, error.message ?? "catalog rpc failed");
    }
    const row = (data ?? {}) as Record<string, unknown>;
    return {
      idempotent: row.idempotent === true,
      dryRun: row.dryRun === true,
      slug: typeof row.slug === "string" ? row.slug : undefined,
      sku: typeof row.sku === "string" ? row.sku : undefined,
      productId: typeof row.productId === "string" ? row.productId : undefined,
    };
  }

  function upsertDraftRpc(
    actorId: string,
    product: CreateCatalogDraftRequest["product"],
    mode: CreateCatalogDraftRequest["mode"],
    idempotencyKey: string | undefined,
  ): Promise<CatalogWriteResult> {
    return callRpc("admin_upsert_catalog_draft", {
      p_actor_id: actorId,
      p_slug: product.slug,
      p_name: product.name,
      p_species: product.species,
      p_unit: product.unit,
      p_sku: product.sku,
      p_net_weight_g: product.netWeightGrams,
      p_kcal_per_unit: product.kcalPerUnit,
      p_allergens: product.allergens,
      p_mode: mode,
      p_idempotency_key: idempotencyKey ?? null,
    });
  }

  return {
    upsertDraft(actorId, input: CreateCatalogDraftRequest) {
      return upsertDraftRpc(actorId, input.product, input.mode, input.idempotencyKey);
    },
    async updateDraft(actorId, input: UpdateCatalogDraftRequest) {
      // Fetch-merge-upsert: the upsert RPC is full-payload, so read the current
      // structural state, overlay the supplied partial fields, and replay it
      // through the same RPC (security boundary). dry_run still resolves the current
      // state, then the RPC validates without mutating.
      const current = await loadCurrentDraft(client, input.slug);
      const merged: CreateCatalogDraftRequest["product"] = {
        slug: input.slug,
        species: current.species,
        unit: current.unit,
        sku: current.sku,
        name: input.updates.name ?? current.name,
        netWeightGrams: input.updates.netWeightGrams ?? current.netWeightGrams,
        kcalPerUnit: input.updates.kcalPerUnit ?? current.kcalPerUnit,
        allergens: input.updates.allergens ?? current.allergens,
      };
      return upsertDraftRpc(actorId, merged, input.mode, input.idempotencyKey);
    },
    setPrice(actorId, input: SetCatalogPriceRequest) {
      return callRpc("admin_set_catalog_price", {
        p_actor_id: actorId,
        p_sku: input.sku,
        p_price_mode: input.price.mode,
        p_unit_price_minor: input.price.unitPriceMinor,
        p_currency: input.price.currency,
        p_mode: input.mode,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
    },
    archiveSku(actorId, input: ArchiveCatalogSkuRequest) {
      return callRpc("admin_archive_catalog_sku", {
        p_actor_id: actorId,
        p_sku: input.sku,
        p_mode: input.mode,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
    },
    activateProduct(actorId, input: ActivateCatalogProductRequest) {
      return callRpc("admin_activate_catalog_product", {
        p_actor_id: actorId,
        p_slug: input.slug,
        p_mode: input.mode,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
    },
    archiveProduct(actorId, input: ArchiveCatalogProductRequest) {
      return callRpc("admin_archive_catalog_product", {
        p_actor_id: actorId,
        p_slug: input.slug,
        p_mode: input.mode,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
    },
    restoreProduct(actorId, input: RestoreCatalogProductRequest) {
      return callRpc("admin_restore_catalog_product", {
        p_actor_id: actorId,
        p_slug: input.slug,
        p_mode: input.mode,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
    },
    deactivateProduct(actorId, input: DeactivateCatalogProductRequest) {
      return callRpc("admin_deactivate_catalog_product", {
        p_actor_id: actorId,
        p_slug: input.slug,
        p_mode: input.mode,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
    },
    async cloneDraft(actorId, input: CloneCatalogDraftRequest) {
      // NO new RPC: read the source (P0002 if missing) and replay a fresh draft
      // through admin_upsert_catalog_draft with the caller's new slug + sku. Born
      // draft. dry_run still resolves the source, then the RPC validates without
      // mutating.
      const source = await loadCloneSource(client, input.sourceSlug);
      // Clone must create a NEW product. If the target slug already exists (incl.
      // cloning onto the source itself), the upsert's ON CONFLICT would silently
      // EDIT that product instead of cloning — reject loudly with a CONFLICT.
      const targetExists = await loadCloneSource(client, input.slug).then(
        () => true,
        (cause: unknown) => {
          if (cause instanceof CatalogRpcError && cause.sqlstate === "P0002") return false;
          throw cause;
        },
      );
      if (targetExists) {
        throw new CatalogRpcError("P0001", "clone_target_slug_exists");
      }
      const product = buildCloneCreatePayload(source, input);
      return upsertDraftRpc(actorId, product, input.mode, input.idempotencyKey);
    },
  };
}

type CurrentDraftStructural = CreateCatalogDraftRequest["product"];

interface CatalogProductRow {
  id: string;
  name: string;
  allergens: string[] | null;
  marketing_content: Record<string, unknown> | null;
}

interface CatalogSkuRow {
  sku: string;
  unit_form_code: string | null;
  net_weight_g: number;
  kcal_per_unit: number | null;
  pet_type: string;
}

/**
 * Read the current structural payload of a draft product for the fetch-merge update
 * path. Species comes from the canonical `marketing_content.content.species` (the
 * upsert RPC stores it lowercased); structural numerics + sku/unit come from the
 * product's SKU. Throws P0002 when the product/SKU is missing and P0001 when the
 * product has more than one SKU (the agent-write create path is 1:1, so an
 * ambiguous multi-SKU product cannot be partially updated through this route).
 */
async function loadCurrentDraft(
  client: SupabaseClient,
  slug: string,
): Promise<CurrentDraftStructural> {
  const { data: products, error: productError } = await client
    .from("catalog_products")
    .select("id, name, allergens, marketing_content")
    .eq("slug", slug);
  if (productError) {
    throw new CatalogRpcError(undefined, productError.message ?? "catalog_products read failed");
  }
  const product = ((products ?? []) as unknown as CatalogProductRow[])[0];
  if (!product) {
    throw new CatalogRpcError("P0002", "catalog_product_not_found");
  }

  const { data: skus, error: skuError } = await client
    .from("catalog_skus")
    .select("sku, unit_form_code, net_weight_g, kcal_per_unit, pet_type")
    .eq("product_id", product.id);
  if (skuError) {
    throw new CatalogRpcError(undefined, skuError.message ?? "catalog_skus read failed");
  }
  const skuRows = (skus ?? []) as unknown as CatalogSkuRow[];
  if (skuRows.length === 0) {
    throw new CatalogRpcError("P0002", "catalog_sku_not_found");
  }
  if (skuRows.length > 1) {
    throw new CatalogRpcError("P0001", "catalog_update_ambiguous_sku");
  }
  const sku = skuRows[0];

  return {
    slug,
    name: product.name,
    species: (readSpecies(product.marketing_content) ?? sku.pet_type) as CurrentDraftStructural["species"],
    unit: (sku.unit_form_code ?? "can") as CurrentDraftStructural["unit"],
    sku: sku.sku,
    netWeightGrams: sku.net_weight_g,
    kcalPerUnit: sku.kcal_per_unit ?? 0,
    allergens: Array.isArray(product.allergens) ? product.allergens : [],
  };
}

function readSpecies(marketingContent: Record<string, unknown> | null): string | null {
  const content = marketingContent?.content;
  if (content && typeof content === "object" && "species" in content) {
    const species = (content as Record<string, unknown>).species;
    if (typeof species === "string" && species.length > 0) return species;
  }
  return null;
}
