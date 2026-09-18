import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminCatalogDataPort } from "./adminCatalog.js";
import { CatalogRpcError } from "../../domains/commerce/adminCatalogDataPort.js";
import type { UpdateCatalogDraftRequest } from "../../../src/domains/commerce/adminCatalogContracts.js";

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  allergens: string[] | null;
  marketing_content: Record<string, unknown> | null;
}

interface SkuRow {
  product_id: string;
  sku: string;
  unit_form_code: string | null;
  net_weight_g: number;
  kcal_per_unit: number | null;
  pet_type: string;
}

function currentProduct(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "prod-1",
    slug: "duck",
    name: "Duck",
    allergens: ["duck"],
    marketing_content: { content: { species: "dog" } },
    ...overrides,
  };
}

function currentSku(overrides: Partial<SkuRow> = {}): SkuRow {
  return {
    product_id: "prod-1",
    sku: "OPENLUP-DOG-DUCK-CAN-400G",
    unit_form_code: "can",
    net_weight_g: 400,
    kcal_per_unit: 480,
    pet_type: "dog",
    ...overrides,
  };
}

/**
 * Fake Supabase client recording the upsert RPC args and serving the seeded
 * product/sku rows for the read queries.
 */
function makeClient(seed: { products: ProductRow[]; skus: SkuRow[] }) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve({
        data: { slug: args.p_slug, productId: "prod-1", idempotent: false, dryRun: args.p_mode === "dry_run" },
        error: null,
      });
    },
    from(table: string) {
      let rows = (table === "catalog_products"
        ? [...seed.products]
        : [...seed.skus]) as unknown as Array<Record<string, unknown>>;
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        order() {
          return builder;
        },
        then(onFulfilled: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve(onFulfilled({ data: rows, error: null }));
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, rpcCalls };
}

function updateRequest(updates: UpdateCatalogDraftRequest["updates"]): UpdateCatalogDraftRequest {
  return { mode: "commit", slug: "duck", updates };
}

describe("supabaseAdminCatalogDataPort.updateDraft (fetch-merge)", () => {
  it("merges partial fields onto the current draft and replays the full upsert", async () => {
    const { client, rpcCalls } = makeClient({ products: [currentProduct()], skus: [currentSku()] });
    const port = createSupabaseAdminCatalogDataPort(client);

    await port.updateDraft("admin-1", updateRequest({ name: "Duck Deluxe", kcalPerUnit: 510 }));

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("admin_upsert_catalog_draft");
    expect(rpcCalls[0].args).toMatchObject({
      p_actor_id: "admin-1",
      p_slug: "duck",
      p_name: "Duck Deluxe", // updated
      p_kcal_per_unit: 510, // updated
      p_species: "dog", // preserved from current
      p_unit: "can", // preserved
      p_sku: "OPENLUP-DOG-DUCK-CAN-400G", // preserved
      p_net_weight_g: 400, // not in the partial -> preserved
      p_allergens: ["duck"], // preserved
      p_mode: "commit",
    });
  });

  it("preserves unspecified fields and overlays only allergens when that is the partial", async () => {
    const { client, rpcCalls } = makeClient({ products: [currentProduct()], skus: [currentSku()] });
    const port = createSupabaseAdminCatalogDataPort(client);

    await port.updateDraft("admin-1", updateRequest({ allergens: ["duck", "salmon"] }));

    expect(rpcCalls[0].args).toMatchObject({
      p_name: "Duck", // preserved
      p_allergens: ["duck", "salmon"], // updated
      p_net_weight_g: 400,
      p_kcal_per_unit: 480,
    });
  });

  it("passes the dry_run mode through to the upsert RPC", async () => {
    const { client, rpcCalls } = makeClient({ products: [currentProduct()], skus: [currentSku()] });
    const port = createSupabaseAdminCatalogDataPort(client);

    const result = await port.updateDraft("admin-1", { mode: "dry_run", slug: "duck", updates: { name: "X" } });

    expect(rpcCalls[0].args.p_mode).toBe("dry_run");
    expect(result.dryRun).toBe(true);
  });

  it("throws P0002 (NOT_FOUND) when the product does not exist", async () => {
    const { client } = makeClient({ products: [], skus: [] });
    const port = createSupabaseAdminCatalogDataPort(client);

    await expect(port.updateDraft("admin-1", updateRequest({ name: "X" }))).rejects.toMatchObject({
      sqlstate: "P0002",
    });
  });

  it("throws P0002 when the product has no SKU", async () => {
    const { client } = makeClient({ products: [currentProduct()], skus: [] });
    const port = createSupabaseAdminCatalogDataPort(client);

    await expect(port.updateDraft("admin-1", updateRequest({ name: "X" }))).rejects.toBeInstanceOf(
      CatalogRpcError,
    );
  });

  it("throws P0001 (ambiguous) when the product has more than one SKU", async () => {
    const { client } = makeClient({
      products: [currentProduct()],
      skus: [currentSku(), currentSku({ sku: "OPENLUP-DOG-DUCK-CAN-800G" })],
    });
    const port = createSupabaseAdminCatalogDataPort(client);

    await expect(port.updateDraft("admin-1", updateRequest({ name: "X" }))).rejects.toMatchObject({
      sqlstate: "P0001",
    });
  });
});

describe("supabaseAdminCatalogDataPort lifecycle RPCs (marshaling)", () => {
  it("archive/restore/deactivate call their RPC with the actor, slug, mode and key", async () => {
    const cases = [
      { method: "archiveProduct", rpc: "admin_archive_catalog_product" },
      { method: "restoreProduct", rpc: "admin_restore_catalog_product" },
      { method: "deactivateProduct", rpc: "admin_deactivate_catalog_product" },
    ] as const;
    for (const { method, rpc } of cases) {
      const { client, rpcCalls } = makeClient({ products: [], skus: [] });
      const port = createSupabaseAdminCatalogDataPort(client);
      await port[method]("admin-1", {
        mode: "commit",
        slug: "duck",
        idempotencyKey: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      });
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].name).toBe(rpc);
      expect(rpcCalls[0].args).toMatchObject({
        p_actor_id: "admin-1",
        p_slug: "duck",
        p_mode: "commit",
        p_idempotency_key: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      });
    }
  });

  it("normalizes a thrown RPC error into a CatalogRpcError carrying the SQLSTATE", async () => {
    const client = {
      rpc() {
        return Promise.resolve({ data: null, error: { code: "P0001", message: "restore_requires_archived" } });
      },
    } as unknown as SupabaseClient;
    const port = createSupabaseAdminCatalogDataPort(client);
    await expect(
      port.restoreProduct("admin-1", { mode: "commit", slug: "duck" }),
    ).rejects.toMatchObject({ sqlstate: "P0001", pgMessage: "restore_requires_archived" });
  });

  it("clone reads the source via the read port and replays the upsert RPC with the new slug + sku", async () => {
    const products: ProductRow[] = [currentProduct()];
    const skus: SkuRow[] = [currentSku()];
    const { client, rpcCalls } = makeClient({ products, skus });
    const port = createSupabaseAdminCatalogDataPort(client);

    await port.cloneDraft("admin-1", {
      mode: "commit",
      sourceSlug: "duck",
      slug: "duck-copy",
      sku: "OPENLUP-DOG-DUCKCOPY-CAN-400G",
    });

    const upsert = rpcCalls.find((c) => c.name === "admin_upsert_catalog_draft");
    expect(upsert).toBeDefined();
    expect(upsert?.args).toMatchObject({
      p_actor_id: "admin-1",
      p_slug: "duck-copy", // NEW slug
      p_sku: "OPENLUP-DOG-DUCKCOPY-CAN-400G", // NEW sku
      p_name: "Duck", // copied from source
      p_mode: "commit",
    });
  });

  it("clone rejects a target slug that already exists (no silent in-place edit)", async () => {
    const products: ProductRow[] = [currentProduct(), currentProduct({ id: "prod-2", slug: "duck-copy", name: "Duck Copy" })];
    const skus: SkuRow[] = [currentSku()];
    const { client, rpcCalls } = makeClient({ products, skus });
    const port = createSupabaseAdminCatalogDataPort(client);

    await expect(
      port.cloneDraft("admin-1", {
        mode: "commit",
        sourceSlug: "duck",
        slug: "duck-copy", // already exists
        sku: "OPENLUP-DOG-DUCKCOPY-CAN-400G",
      }),
    ).rejects.toMatchObject({ sqlstate: "P0001", pgMessage: "clone_target_slug_exists" });
    // never reached the upsert RPC
    expect(rpcCalls.find((c) => c.name === "admin_upsert_catalog_draft")).toBeUndefined();
  });

  it("clone surfaces a missing source as NOT_FOUND (P0002)", async () => {
    const { client } = makeClient({ products: [], skus: [] });
    const port = createSupabaseAdminCatalogDataPort(client);
    await expect(
      port.cloneDraft("admin-1", {
        mode: "commit",
        sourceSlug: "ghost",
        slug: "ghost-copy",
        sku: "OPENLUP-DOG-GHOST-CAN-400G",
      }),
    ).rejects.toMatchObject({ sqlstate: "P0002" });
  });
});
