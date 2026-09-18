import { describe, expect, it } from "vitest";

import {
  CurrentDocumentPayloadReadError,
  createPostgresCurrentDocumentPayloadReadPort,
  createSupabaseCurrentDocumentPayloadReadPort,
  type CurrentDocumentCondition,
} from "./catalogCurrentDocumentPayload.js";
import type { PgQueryExecutor } from "./postgres/queryBuilder.js";
import type { CatalogSkuEnvelopeSupabaseClient } from "./supabase/catalogSkuEnvelope.js";

const CONDITIONS: CurrentDocumentCondition[] = [
  {
    productId: "11111111-1111-4111-8111-111111111111",
    slug: "beef",
    currentDocumentRevisionId: "33333333-3333-4333-8333-333333333333",
  },
  {
    productId: "22222222-2222-4222-8222-222222222222",
    slug: "lamb",
    currentDocumentRevisionId: "44444444-4444-4444-8444-444444444444",
  },
];

const PRODUCTS = CONDITIONS.map((condition) => ({
  id: condition.productId,
  slug: condition.slug,
  status: "active",
  current_document_revision_id: condition.currentDocumentRevisionId,
}));
const REVISIONS = CONDITIONS.map((condition, index) => ({
  id: condition.currentDocumentRevisionId,
  product_id: condition.productId,
  revision_no: index + 1,
  schema_id: "openlup.product-document.v1",
  document_payload: { id: `document-${index + 1}` },
  digest: `${index + 1}`.repeat(64),
}));

describe("current document payload adapter", () => {
  it("returns an ordered guarded payload batch with fixed managed and portable query counts", async () => {
    const managed = supabaseClient();
    const portable = postgresExecutor();

    const [managedResult, portableResult] = await Promise.all([
      createSupabaseCurrentDocumentPayloadReadPort(managed.client).readCurrentDocuments(CONDITIONS),
      createPostgresCurrentDocumentPayloadReadPort(portable.client).readCurrentDocuments(CONDITIONS),
    ]);

    expect(managedResult).toEqual(portableResult);
    expect(managedResult).toMatchObject([
      { product: { id: CONDITIONS[0]!.productId, slug: "beef" }, revision: { id: CONDITIONS[0]!.currentDocumentRevisionId } },
      { product: { id: CONDITIONS[1]!.productId, slug: "lamb" }, revision: { id: CONDITIONS[1]!.currentDocumentRevisionId } },
    ]);
    expect(managed.calls).toHaveLength(2);
    expect(managed.calls.map((call) => call.table).sort()).toEqual([
      "catalog_product_document_revisions",
      "catalog_products",
    ]);
    expect(portable.calls).toHaveLength(1);
    expect(portable.calls[0]!.values).toEqual([[CONDITIONS[0]!.productId, CONDITIONS[1]!.productId]]);
  });

  it("uses no query for an empty batch", async () => {
    const managed = supabaseClient();
    const portable = postgresExecutor();

    await expect(createSupabaseCurrentDocumentPayloadReadPort(managed.client).readCurrentDocuments([])).resolves.toEqual([]);
    await expect(createPostgresCurrentDocumentPayloadReadPort(portable.client).readCurrentDocuments([])).resolves.toEqual([]);
    expect(managed.calls).toHaveLength(0);
    expect(portable.calls).toHaveLength(0);
  });

  it("keeps payload query counts constant for a 500-product page", async () => {
    const scale = scaleRows(500);
    const managed = supabaseClient({ products: scale.products, revisions: scale.revisions });
    const portable = postgresExecutor({ products: scale.products, revisions: scale.revisions });

    const [managedResult, portableResult] = await Promise.all([
      createSupabaseCurrentDocumentPayloadReadPort(managed.client).readCurrentDocuments(scale.conditions),
      createPostgresCurrentDocumentPayloadReadPort(portable.client).readCurrentDocuments(scale.conditions),
    ]);

    expect(managedResult).toHaveLength(500);
    expect(portableResult).toEqual(managedResult);
    expect(managed.calls).toHaveLength(2);
    expect(portable.calls).toHaveLength(1);
  });

  it("refuses a current-pointer move instead of returning an older payload", async () => {
    const movedProducts = [
      { ...PRODUCTS[0]!, current_document_revision_id: "55555555-5555-4555-8555-555555555555" },
      PRODUCTS[1]!,
    ];
    const managed = supabaseClient({ products: movedProducts });
    const portable = postgresExecutor({ products: movedProducts });

    for (const read of [
      createSupabaseCurrentDocumentPayloadReadPort(managed.client).readCurrentDocuments(CONDITIONS),
      createPostgresCurrentDocumentPayloadReadPort(portable.client).readCurrentDocuments(CONDITIONS),
    ]) {
      await expect(read).rejects.toMatchObject({
        name: CurrentDocumentPayloadReadError.name,
        code: "catalog_authority_changed",
      });
    }
  });
});

interface ManagedCall { table: string; values: readonly unknown[] }

function supabaseClient(input: {
  products?: readonly Record<string, unknown>[];
  revisions?: readonly Record<string, unknown>[];
} = {}): { calls: ManagedCall[]; client: CatalogSkuEnvelopeSupabaseClient } {
  const calls: ManagedCall[] = [];
  const rowsByTable: Record<string, readonly Record<string, unknown>[]> = {
    catalog_products: input.products ?? PRODUCTS,
    catalog_product_document_revisions: input.revisions ?? REVISIONS,
  };
  return {
    calls,
    client: {
      from(table: string) {
        const selected: { column: string; values: readonly unknown[] }[] = [];
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          gt() { return builder; },
          or() { return builder; },
          order() { return builder; },
          limit() { return builder; },
          in(column: string, values: readonly unknown[]) { selected.push({ column, values }); return builder; },
          then(resolve: (value: { data: readonly Record<string, unknown>[]; error: null }) => unknown) {
            calls.push({ table, values: selected.flatMap(({ values }) => values) });
            const rows = (rowsByTable[table] ?? []).filter((row) => (
              selected.every(({ column, values }) => values.includes(row[column]))
            ));
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return builder;
      },
    } as unknown as CatalogSkuEnvelopeSupabaseClient,
  };
}

function postgresExecutor(input: {
  products?: readonly Record<string, unknown>[];
  revisions?: readonly Record<string, unknown>[];
} = {}): {
  calls: Array<{ values: unknown[] }>;
  client: PgQueryExecutor;
} {
  const calls: Array<{ values: unknown[] }> = [];
  const products = input.products ?? PRODUCTS;
  const revisions = input.revisions ?? REVISIONS;
  return {
    calls,
    client: {
      async query(_text, values = []) {
        calls.push({ values });
        const requestedProductIds = new Set(values[0] as string[]);
        return {
          rows: products
            .filter((product) => requestedProductIds.has(String(product.id)))
            .map((product) => {
              const revision = revisions.find((candidate) => candidate.id === product.current_document_revision_id);
              return {
                product_id: product.id,
                product_slug: product.slug,
                product_status: product.status,
                current_document_revision_id: product.current_document_revision_id,
                revision_id: revision?.id ?? null,
                revision_product_id: revision?.product_id ?? null,
                revision_no: revision?.revision_no ?? null,
                revision_schema_id: revision?.schema_id ?? null,
                revision_document_payload: revision?.document_payload ?? null,
                revision_digest: revision?.digest ?? null,
              };
            }),
        };
      },
    },
  };
}

function scaleRows(count: number): {
  conditions: CurrentDocumentCondition[];
  products: Array<Record<string, unknown>>;
  revisions: Array<Record<string, unknown>>;
} {
  const conditions: CurrentDocumentCondition[] = [];
  const products: Array<Record<string, unknown>> = [];
  const revisions: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= count; index += 1) {
    const productId = `product-${String(index).padStart(4, "0")}`;
    const revisionId = `revision-${String(index).padStart(4, "0")}`;
    conditions.push({ productId, slug: `formula-${index}`, currentDocumentRevisionId: revisionId });
    products.push({
      id: productId,
      slug: `formula-${index}`,
      status: "active",
      current_document_revision_id: revisionId,
    });
    revisions.push({
      id: revisionId,
      product_id: productId,
      revision_no: 1,
      schema_id: "openlup.product-document.v1",
      document_payload: { index },
      digest: index.toString(16).padStart(64, "0"),
    });
  }
  return { conditions, products, revisions };
}
