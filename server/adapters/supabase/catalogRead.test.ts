import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import { catalogProductSchema } from "../../../src/domains/catalog/contracts.js";
import { createSupabaseCatalogReadPort } from "./catalogRead.js";

interface ProductRow {
  id: string;
  slug: string;
  status: string;
  name: string;
  description: string | null;
  ingredients: string[];
  allergens: string[];
  marketing_content: Record<string, unknown>;
}

interface SkuRow {
  id: string;
  product_id: string;
  sku: string;
  title: string;
  pet_type: string;
  status: string;
  net_weight_g: number;
  format_code: string | null;
  unit_form_code: string | null;
  is_addon: boolean;
  sellable_standalone: boolean;
  sellable_in_subscription: boolean;
  requires_pet_profile: boolean;
  min_order_qty: number;
}

interface FakeTableStub {
  rows: ProductRow[] | SkuRow[];
}

function makeProductRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    slug: "lamb",
    status: "active",
    name: "Lamb + EntoPro™ Recipe",
    description: "Complete wet pet food for adult dogs",
    ingredients: ["Jagnięcina", "EntoPro™"],
    allergens: ["lamb", "yeast"],
    marketing_content: {
      line_name: "Health & Longevity Diet",
      species: "Dog",
      format_marketing_copy: "Complete wet pet food for adult dogs",
    },
    ...overrides,
  };
}

function makeSkuRow(overrides: Partial<SkuRow> = {}): SkuRow {
  return {
    id: "10000000-0000-0000-0000-000000000001",
    product_id: "00000000-0000-0000-0000-000000000001",
    sku: "OPENLUP-DOG-LAMB-CAN-400G",
    title: "Lamb + EntoPro™ Recipe",
    pet_type: "dog",
    status: "active",
    net_weight_g: 400,
    format_code: "can",
    unit_form_code: "can",
    is_addon: false,
    sellable_standalone: true,
    sellable_in_subscription: true,
    requires_pet_profile: false,
    min_order_qty: 1,
    ...overrides,
  };
}

/** What each table was asked for, so a test can assert on the projection itself. */
const selectedColumns = new Map<string, string>();

function makeFakeClient(stubs: {
  catalog_products: ProductRow[];
  catalog_skus: SkuRow[];
}): SupabaseClient {
  selectedColumns.clear();
  const tables: Record<string, FakeTableStub> = {
    catalog_products: { rows: stubs.catalog_products },
    catalog_skus: { rows: stubs.catalog_skus },
  };

  function makeBuilder(table: string) {
    let scopedRows: Array<ProductRow | SkuRow> = [...tables[table].rows];

    const builder = {
      select(columns: string) {
        selectedColumns.set(table, columns);
        return builder;
      },
      eq(column: string, value: unknown) {
        scopedRows = scopedRows.filter(
          (row) => (row as unknown as Record<string, unknown>)[column] === value,
        );
        return builder;
      },
      then(onFulfilled: (value: { data: Array<unknown>; error: null }) => unknown) {
        return Promise.resolve(onFulfilled({ data: scopedRows, error: null }));
      },
    };

    return builder;
  }

  return {
    from(table: string) {
      return makeBuilder(table);
    },
  } as unknown as SupabaseClient;
}

describe("managed catalog read adapter", () => {
  it("returns a single product with its variants for listProducts()", async () => {
    const client = makeFakeClient({
      catalog_products: [makeProductRow()],
      catalog_skus: [makeSkuRow()],
    });
    const port = createSupabaseCatalogReadPort({ client });

    const products = await port.listProducts();

    expect(products).toHaveLength(1);
    expect(products[0].slug).toBe("lamb");
    expect(products[0].variants).toHaveLength(1);
    expect(products[0].variants[0].sku).toBe("OPENLUP-DOG-LAMB-CAN-400G");
    expect(products[0].variants[0].productSlug).toBe("lamb");
    expect(products[0].variants[0].netWeightGrams).toBe(400);
    expect(products[0].composition.allergenSlugs).toEqual(["lamb", "yeast"]);
    // Was 123 — the assembler's old column-based derivation, `round(492 / 400 * 100)`
    // off the retired per-unit energy column. This row carries no rich
    // `marketing_content.content`, so it takes the structural fallback, and that path
    // now has no energy authority to read: the document is the only one, and the
    // assembler is never handed a document. Null is the fail-closed answer, and it is
    // what the Postgres twin has always returned here, because its own projection
    // never selected the column either.
    expect(products[0].composition.kcalPer100g).toBeNull();
    expect(products[0].metadata.kcalPer100g).toBeNull();
  });

  it("never asks catalog_skus for the retired energy columns", async () => {
    // The assertion above only proves the value is null for THIS fixture. This one
    // proves the projection itself stopped asking, so re-adding either retired column
    // to SKU_COLUMNS.full — the way a stale energy would come back — fails here
    // rather than silently resurrecting a second energy authority.
    const client = makeFakeClient({
      catalog_products: [makeProductRow()],
      catalog_skus: [makeSkuRow()],
    });

    await createSupabaseCatalogReadPort({ client }).listProducts();

    const skuColumns = selectedColumns.get("catalog_skus") ?? "";
    expect(skuColumns).toContain("net_weight_g");
    expect(skuColumns).not.toContain("kcal_per_unit");
    expect(skuColumns).not.toContain("feeding_grams_per_unit");
  });

  it("hydrates the primary SKU from the first variant row", async () => {
    const client = makeFakeClient({
      catalog_products: [makeProductRow()],
      catalog_skus: [makeSkuRow()],
    });
    const port = createSupabaseCatalogReadPort({ client });

    const [product] = await port.listProducts();

    expect(product.primarySku.sku).toBe("OPENLUP-DOG-LAMB-CAN-400G");
    expect(product.primarySku.unit).toBe("can");
    expect(product.primarySku.pricing.status).toBe("not_configured");
  });

  it("uses a neutral placeholder SKU when a product has no SKU rows", async () => {
    const client = makeFakeClient({
      catalog_products: [makeProductRow({ slug: "beef" })],
      catalog_skus: [],
    });
    const port = createSupabaseCatalogReadPort({ client });

    const [product] = await port.listProducts();

    expect(product.primarySku.sku).toBe("CATALOG-BEEF-PLACEHOLDER");
    expect(product.primarySku.publicationStatus).toBe("coming_soon");
  });

  it("overlays live list prices when a pricing resolver is injected", async () => {
    // Port-level wiring: an injected resolver makes listProducts carry prices. The
    // pure join (incl. the no-entry/not_configured case) is in catalogPricingJoin.test.ts.
    const client = makeFakeClient({ catalog_products: [makeProductRow()], catalog_skus: [makeSkuRow()] });
    const pricingResolver: PricingResolverPort = {
      async resolvePrice(query) {
        expect(query.mode).toBe("one_time");
        return {
          variantId: query.variantId, mode: "one_time", matchedMinQty: 1,
          unitPriceMinor: 2490, amountKind: "gross", priceListId: "pl-1",
          priceEntryId: "pe-1", resolvedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    };
    const port = createSupabaseCatalogReadPort({ client, pricingResolver });

    const [product] = await port.listProducts();

    expect(product.primarySku.pricing.status).toBe("configured");
    expect(product.primarySku.pricing.listPrice).toEqual({ amountMinor: 2490, currency: "PLN" });
  });

  it("default (active-only) path excludes non-active products and SKUs", async () => {
    const client = makeFakeClient({
      catalog_products: [
        makeProductRow({ id: "p-active", slug: "lamb", status: "active" }),
        makeProductRow({ id: "p-draft", slug: "venison", status: "draft" }),
        makeProductRow({ id: "p-arch", slug: "beef", status: "archived" }),
      ],
      catalog_skus: [
        makeSkuRow({ id: "s-active", product_id: "p-active", status: "active" }),
        makeSkuRow({ id: "s-arch", product_id: "p-active", sku: "OPENLUP-DOG-LAMB-CAN-800G", status: "archived" }),
      ],
    });
    const port = createSupabaseCatalogReadPort({ client });

    const products = await port.listProducts();

    expect(products.map((p) => p.slug)).toEqual(["lamb"]);
    expect(products[0].variants.map((v) => v.sku)).toEqual(["OPENLUP-DOG-LAMB-CAN-400G"]);
  });

  it("includeArchived path returns draft/archived products and SKUs (cron + subscription re-pricer)", async () => {
    const client = makeFakeClient({
      catalog_products: [
        makeProductRow({ id: "p-active", slug: "lamb", status: "active" }),
        makeProductRow({ id: "p-arch", slug: "beef", status: "archived" }),
      ],
      catalog_skus: [
        makeSkuRow({ id: "s-active", product_id: "p-active", status: "active" }),
        makeSkuRow({ id: "s-arch", product_id: "p-arch", sku: "OPENLUP-DOG-BEEF-CAN-400G", status: "archived" }),
      ],
    });
    const port = createSupabaseCatalogReadPort({ client, includeArchived: true });

    const products = await port.listProducts();

    expect(products.map((p) => p.slug).sort()).toEqual(["beef", "lamb"]);
  });

  it("includeArchived:true also returns DRAFT products + SKUs (locks the unpublish->draft ripple)", async () => {
    // Lifecycle deactivate moves a product active->DRAFT (not archived). The cron
    // order-email + subscription re-pricer read includeArchived:true = "all statuses",
    // so a just-unpublished (draft) product must still resolve — locks that dependency.
    const client = makeFakeClient({
      catalog_products: [
        makeProductRow({ id: "p-active", slug: "lamb", status: "active" }),
        makeProductRow({ id: "p-draft", slug: "venison", status: "draft" }),
      ],
      catalog_skus: [
        makeSkuRow({ id: "s-active", product_id: "p-active", status: "active" }),
        makeSkuRow({ id: "s-draft", product_id: "p-draft", sku: "OPENLUP-DOG-VENISON-CAN-400G", status: "draft" }),
      ],
    });
    const port = createSupabaseCatalogReadPort({ client, includeArchived: true });

    const products = await port.listProducts();

    expect(products.map((p) => p.slug).sort()).toEqual(["lamb", "venison"]);
    expect(
      products.find((p) => p.slug === "venison")?.variants.map((v) => v.sku),
    ).toContain("OPENLUP-DOG-VENISON-CAN-400G");
  });

  it("getProductBySlug honors the active-only default (archived slug → null)", async () => {
    const client = makeFakeClient({
      catalog_products: [makeProductRow({ slug: "beef", status: "archived" })],
      catalog_skus: [],
    });
    expect(await createSupabaseCatalogReadPort({ client }).getProductBySlug("beef")).toBeNull();
    // ...but resolvable on the historical path.
    const archivedClient = makeFakeClient({
      catalog_products: [makeProductRow({ slug: "beef", status: "archived" })],
      catalog_skus: [makeSkuRow({ sku: "OPENLUP-DOG-BEEF-CAN-400G", status: "archived" })],
    });
    const found = await createSupabaseCatalogReadPort({
      client: archivedClient,
      includeArchived: true,
    }).getProductBySlug("beef");
    expect(found?.slug).toBe("beef");
  });

  it("returns null from getProductBySlug for an unknown slug", async () => {
    const client = makeFakeClient({
      catalog_products: [],
      catalog_skus: [],
    });
    const port = createSupabaseCatalogReadPort({ client });

    const product = await port.getProductBySlug("turkey");

    expect(product).toBeNull();
  });

  it("derives the allergen taxonomy with no product links when no products exist", async () => {
    const client = makeFakeClient({
      catalog_products: [],
      catalog_skus: [],
    });
    const port = createSupabaseCatalogReadPort({ client });

    const allergens = await port.listAllergens();

    // The taxonomy (slug/name/nameEn/category) is reference data and is always
    // present; product links derive from composition, so with no products every
    // allergen carries an empty `products` array (no longer the old W1 empty list).
    expect(allergens.length).toBeGreaterThan(0);
    expect(allergens.every((a) => a.products.length === 0)).toBe(true);
    expect(allergens.map((a) => a.slug)).toContain("salmon");
  });

  it("surfaces a meaningful error if the catalog_products query fails", async () => {
    const failingClient = {
      from() {
        return {
          select(_columns: string) {
            return this;
          },
          eq() {
            return this;
          },
          then(onFulfilled: (value: { data: null; error: { message: string } }) => unknown) {
            return Promise.resolve(
              onFulfilled({ data: null, error: { message: "boom" } }),
            );
          },
        };
      },
    } as unknown as SupabaseClient;

    const port = createSupabaseCatalogReadPort({ client: failingClient });
    await expect(port.listProducts()).rejects.toThrow(/catalog_products read failed: boom/);
  });
});

/**
 * The projection is the portability property of this read: a database answers a
 * SELECT only for columns it actually has, so asking for one it does not have
 * fails the entire listing rather than returning it poorer. These cases live in
 * this companion rather than in a file of their own because a second file would
 * repeat the import above, and that import is a counted token in a family whose
 * slack this wave has already spent.
 */
describe("read projection", () => {
  const build = createSupabaseCatalogReadPort;
  type Client = Parameters<typeof build>[0]["client"];

  function fake(rowsFor: (table: string) => unknown[]): {
    client: Client;
    columns: Record<string, string>;
  } {
    const columns: Record<string, string> = {};
    const client = {
      from(table: string) {
        const builder = {
          select(selected: string) {
            columns[table] = selected;
            return builder;
          },
          eq() {
            return builder;
          },
          then(onFulfilled: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve(onFulfilled({ data: rowsFor(table), error: null }));
          },
        };
        return builder;
      },
    } as unknown as Client;
    return { client, columns };
  }

  const NEUTRAL_UNIT_COLUMNS = "id, product_id, sku, title, status, net_weight_g, is_addon, "
    + "sellable_standalone, sellable_in_subscription, min_order_qty";

  it("asks the neutral projection for exactly the columns the platform manifest declares", async () => {
    const { client, columns } = fake(() => []);

    await build({ client, projection: "neutral" }).listProducts();

    expect(columns.catalog_products).toBe(
      "id, slug, status, name, description, ingredients, marketing_content");
    expect(columns.catalog_skus).toBe(NEUTRAL_UNIT_COLUMNS);
  });

  it("asks for no column the public platform manifest does not declare", async () => {
    // The portability property, asserted where the columns are actually observed:
    // a database answers a SELECT only for columns it has, so a neutral projection
    // that drifted outside the manifest would fail the whole listing on an
    // adopter's schema. The declared set is read from the MANIFEST rather than from
    // one migration by name, because attributes arrive as ALTER TABLE in later
    // forwards and a single-file reading would have gone stale at the first one.
    const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as
      { forward: { file: string }[] };
    const declared = (table: string): Set<string> => {
      const names = new Set<string>();
      for (const { file } of manifest.forward) {
        const sql = readFileSync(file, "utf8");
        const body = new RegExp(`CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1];
        for (const line of body?.split("\n") ?? []) {
          const name = /^\s{2}([a-z_]+)\s/.exec(line)?.[1];
          if (name) names.add(name);
        }
        const altered = new RegExp(`ALTER TABLE public\\.${table}\\n([\\s\\S]*?);`).exec(sql)?.[1];
        for (const added of (altered ?? "").matchAll(/ADD COLUMN ([a-z_]+)\s/g)) names.add(added[1]!);
      }
      return names;
    };
    const { client, columns } = fake(() => []);

    await build({ client, projection: "neutral" }).listProducts();

    for (const table of ["catalog_products", "catalog_skus"]) {
      const asked = columns[table]!.split(", ");
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.filter((column) => !declared(table).has(column))).toEqual([]);
    }
  });

  it("keeps the shipped projection strictly wider than the neutral one by default", async () => {
    const { client, columns } = fake(() => []);

    await build({ client }).listProducts();

    expect(columns.catalog_products).toContain("marketing_content");
    expect(columns.catalog_skus.split(", ").length).toBeGreaterThan(
      NEUTRAL_UNIT_COLUMNS.split(", ").length,
    );
  });

  it("assembles a product from a row that carries nothing but the neutral columns", async () => {
    const { client } = fake((table) =>
      table === "catalog_products"
        ? [{
            id: "10000000-0000-4000-8000-000000000001",
            slug: "reference-item",
            status: "active",
            name: "Reference Item",
            description: "A neutral row",
          }]
        : [{
            id: "10000000-0000-4000-8000-000000000002",
            product_id: "10000000-0000-4000-8000-000000000001",
            sku: "REFERENCE-ITEM-001",
            title: "Reference Item",
            status: "active",
            is_addon: false,
            sellable_standalone: true,
            sellable_in_subscription: false,
            min_order_qty: 1,
          }],
    );

    const [product] = await build({ client, projection: "neutral" }).listProducts();

    expect(product.slug).toBe("reference-item");
    expect(product.displayName).toBe("Reference Item");
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0].sku).toBe("REFERENCE-ITEM-001");
    expect(product.variants[0].netWeightGrams).toBe(0);
    expect(product.composition.allergenSlugs).toEqual([]);
    expect(product.composition.items).toEqual([]);
  });

  it("turns the declared attributes into the fields the response contract demands", async () => {
    // The five field paths the contract refused before the attribute forward, read
    // from the three columns both schemas now share. An entry that declares a share
    // is split; one that declares none stands as its own label, because the contract
    // has no empty option and inventing a share would be worse than repeating a word.
    const { client } = fake((table) =>
      table === "catalog_products"
        ? [{
            id: "10000000-0000-4000-8000-000000000001",
            slug: "reference-item",
            status: "active",
            name: "Reference Item",
            description: null,
            ingredients: ["Barley 40%", "Sunflower oil"],
            marketing_content: { line_name: "Reference Line", format_marketing_copy: "Boxed" },
          }]
        : [{
            id: "10000000-0000-4000-8000-000000000002",
            product_id: "10000000-0000-4000-8000-000000000001",
            sku: "REFERENCE-ITEM-001",
            title: "Reference Item",
            status: "active",
            net_weight_g: 400,
            is_addon: false,
            sellable_standalone: true,
            sellable_in_subscription: false,
            min_order_qty: 1,
          }],
    );

    const [product] = await build({ client, projection: "neutral" }).listProducts();

    expect(product.lineName).toBe("Reference Line");
    expect(product.metadata.format).toBe("Boxed");
    expect(product.variants[0].netWeightGrams).toBe(400);
    expect(product.composition.rawIngredients).toBe("Barley 40%, Sunflower oil");
    expect(product.composition.items).toEqual([
      { name: "Barley", pctText: "40%", percentage: 40, role: "", body: "", allergenSlugs: [] },
      { name: "Sunflower oil", pctText: "Sunflower oil", percentage: 0, role: "", body: "", allergenSlugs: [] },
    ]);
    expect(catalogProductSchema.safeParse(product).success).toBe(true);
  });
});
