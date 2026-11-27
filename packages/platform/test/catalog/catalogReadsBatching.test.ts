import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPostgresCatalogDraftStoreV4 } from "../../src/catalog/catalogDraftStore.js";
import { createPostgresCatalogPublicationReads } from "../../src/catalog/catalogPublicationReads.js";
import { CatalogDraftStoreError } from "../../src/catalog/draftPorts.js";
import { publicationDigest, publicationJson } from "../../src/catalog/publicationCodec.js";
import { CATALOG_PUBLICATION_LIMITS } from "../../src/catalog/publicationContracts.js";
import type { CatalogDraftPayloadV3, CatalogDraftPublicationStoredRecord } from "../../src/catalog/contracts/draftV3.js";
import type { PgQueryExecutor } from "../../src/data/index.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (prefix: number, index: number) =>
  `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;

function draftRecord(index: number): CatalogDraftPublicationStoredRecord {
  const productId = uuid(1, index);
  const skuId = uuid(2, index);
  const draftId = uuid(3, index);
  const documentId = uuid(4, index);
  const netContent = { dimension: "mass" as const, unit: "openlup:g", unscaled: "100", scale: 0 };
  const payload: CatalogDraftPayloadV3 = {
    schemaVersion: 3,
    product: {
      id: productId,
      type: { key: "example:article", version: 1 },
      dimensions: [],
      slug: `article-${index}`,
      primarySkuId: skuId,
      sharedContent: {
        schemaVersion: 1,
        catalogAction: "create",
        document: { names: { en: `Synthetic ${index}` } },
        presentation: { routePath: { en: `/article-${index}` } },
        offerMemberships: [],
        requestedModes: [{ skuCode: `ARTICLE-${index}`, modes: [] }],
        publicationSkus: [{ skuCode: `ARTICLE-${index}`, title: `Synthetic ${index}`, minQuantity: 1, isAddon: false, facts: {} }],
      },
    },
    skus: [{
      id: skuId,
      productId,
      code: `ARTICLE-${index}`,
      options: {},
      netContent,
      identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit" }],
    }],
    publication: {
      kind: "release",
      evidence: {},
      operations: [{ op: "create_product", productId, productSlug: `article-${index}`, name: `Synthetic ${index}` }],
    },
  };
  return {
    draftId,
    productId,
    revision: index,
    status: "open",
    commandKey: `draft:${index}`,
    fingerprint: sha256(`draft:${index}`),
    actorId: "operator:synthetic",
    createdAt: "2020-01-01T00:00:00Z",
    payload,
  };
}

function publicationRow(productId: string, revision: number, changesCount = 1) {
  const publicationId = uuid(10, revision);
  const documentId = uuid(20, revision);
  const skuId = uuid(30, revision);
  const skuRevisionId = uuid(40, revision);
  const draftId = uuid(50, revision);
  const actorId = uuid(60, 1);
  const documentDigest = sha256(`doc:${revision}`);
  const documentRef = `example:doc:${revision}`;
  const document = {
    id: documentId,
    productId,
    revisionNo: revision,
    schemaId: "example:document.v1",
    documentRef,
    sourceRef: "example:source",
    digest: documentDigest,
  };
  const commandKey = `publish:${revision}`;
  const fingerprint = sha256(commandKey);
  const manifest = {
    schemaVersion: 2 as const,
    product: {
      id: productId,
      slug: "example-article",
      name: "Example article",
      status: "active" as const,
      type: { key: "example:article", version: 1 },
      axes: [],
      attributes: {},
      primarySkuId: skuId,
      document,
      presentation: {},
      source: { draftId, revision, commandKey: `draft:${revision}`, fingerprint: sha256(`draft:${revision}`) },
      content: {
        schemaVersion: 1 as const,
        catalogAction: "create" as const,
        presentation: {},
        offerMemberships: [],
        requestedModes: [{ skuCode: `SKU-${revision}`, modes: [] }],
        publicationSkus: [{ skuCode: `SKU-${revision}`, title: "Example", minQuantity: 1, isAddon: false, facts: {} }],
      },
    },
    skus: [{
      skuId,
      revisionId: skuRevisionId,
      revision: 1,
      digest: sha256(`sku:${revision}`),
    }],
  };
  const canonicalState = publicationJson(manifest);
  const digest = publicationDigest(manifest);
  const committedAt = `2020-01-01T00:00:0${revision}.000000Z`;
  const head = { publicationId, revision, documentDigest };
  const skuCode = changesCount > 1 ? `SKU-${revision}-${"A".repeat(140)}` : `SKU-${revision}`;
  const changes = Array.from({ length: changesCount }, (_, idx) => ({
    productId,
    variantId: idx === 0 ? skuId : uuid(70 + revision, idx),
    sku: skuCode,
    state: "active" as const,
    variantRevision: 1,
    publicationHead: head,
    draftRef: { draftId, revision },
  }));
  const receipt = {
    schemaVersion: 2 as const,
    productId,
    previousHead: null,
    head,
    publicationDigest: digest,
    commandKey,
    fingerprint,
    actorId,
    committedAt,
    changes,
  };
  return {
    id: publicationId,
    product_id: productId,
    revision,
    canonical_state: canonicalState,
    digest,
    result: publicationJson(receipt),
    receipt_publication_id: publicationId,
    command_key: commandKey,
    command_fingerprint: fingerprint,
    actor_id: actorId,
    committed_at: committedAt,
    document_digest: documentDigest,
    document_reference: document,
    head,
  };
}

describe("createPostgresCatalogDraftStoreV4.list batching", () => {
  it("runs 1 query for an empty page and 2 queries for a multi-item page while preserving order", async () => {
    const records = [1, 2, 3, 4, 5].map(draftRecord);
    const summaries = records.map(({ payload: _payload, ...summary }) => summary);
    const calls: { sql: string; values: unknown[] | undefined }[] = [];

    const emptyClient: PgQueryExecutor = {
      async query(sql, values) {
        calls.push({ sql, values });
        return { rows: [{ result: { items: [], nextCursor: null } }], rowCount: 1 };
      },
    };
    const emptyPage = await createPostgresCatalogDraftStoreV4(emptyClient).list({ limit: 10 }, "operator:synthetic");
    expect(emptyPage).toEqual({ items: [], nextCursor: null });
    expect(calls).toHaveLength(1);

    calls.length = 0;
    const batchedClient: PgQueryExecutor = {
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.includes("catalog_draft_list")) {
          return { rows: [{ result: { items: summaries, nextCursor: null } }], rowCount: 1 };
        }
        if (sql.includes("catalog_draft_get") && sql.includes("unnest")) {
          expect(values).toEqual([
            summaries.map(s => s.draftId),
            summaries.map(s => s.revision),
            null,
          ]);
          return {
            rows: records.map((record, idx) => ({ ord: idx + 1, result: record })),
            rowCount: records.length,
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const page = await createPostgresCatalogDraftStoreV4(batchedClient).list({ limit: 10 }, "operator:synthetic");
    expect(page.items).toEqual(records);
    expect(page.nextCursor).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("preserves refusal mapping and response validation on batched draft reads", async () => {
    const records = [1, 2].map(draftRecord);
    const summaries = records.map(({ payload: _payload, ...summary }) => summary);

    const unauthorizedClient: PgQueryExecutor = {
      async query(sql) {
        if (sql.includes("catalog_draft_list")) {
          return { rows: [{ result: { items: summaries, nextCursor: null } }], rowCount: 1 };
        }
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      },
    };
    await expect(createPostgresCatalogDraftStoreV4(unauthorizedClient).list({ limit: 10 }, "operator:synthetic"))
      .rejects.toMatchObject({ refusal: { outcome: "unauthorized", reason: "operator_required" } });

    const mismatchedOrdClient: PgQueryExecutor = {
      async query(sql) {
        if (sql.includes("catalog_draft_list")) {
          return { rows: [{ result: { items: summaries, nextCursor: null } }], rowCount: 1 };
        }
        return {
          rows: [{ ord: 2, result: records[0] }, { ord: 1, result: records[1] }],
          rowCount: 2,
        };
      },
    };
    await expect(createPostgresCatalogDraftStoreV4(mismatchedOrdClient).list({ limit: 10 }, "operator:synthetic"))
      .rejects.toThrow(CatalogDraftStoreError);
  });
});

describe("createPostgresCatalogPublicationReads.reads.history batching", () => {
  it("batches page rows and manifest verification into O(1) queries per page", async () => {
    const productId = uuid(99, 1);
    const allRows = [4, 3, 2, 1].map(rev => publicationRow(productId, rev));
    const latest = allRows[0]!;
    const calls: { sql: string; values: unknown[] | undefined }[] = [];

    const db: PgQueryExecutor = {
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.startsWith("SET TRANSACTION")) return { rows: [], rowCount: 0 };
        if (sql.includes("current_setting('transaction_isolation')")) return { rows: [{ admitted: true }], rowCount: 1 };
        if (sql.includes("catalog_publication_assert_head")) {
          return { rows: [{ id: latest.id, product_exists: true, admitted: true }], rowCount: 1 };
        }
        if (sql.includes("WHERE p.id=$1::uuid")) {
          return { rows: [latest], rowCount: 1 };
        }
        if (sql.includes("WHERE p.product_id=$1 AND p.revision<=$2")) {
          return { rows: allRows, rowCount: allRows.length };
        }
        if (sql.includes("unnest") && sql.includes("catalog_publication_manifest_text")) {
          const digests = (values?.[2] ?? []) as string[];
          return {
            rows: digests.map((_, idx) => ({ ord: idx + 1, verified: true })),
            rowCount: digests.length,
          };
        }
        if (sql.includes("catalog_publication_manifest_text")) {
          return { rows: [{ catalog_publication_manifest_text: "{}" }], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };

    const reader = createPostgresCatalogPublicationReads({
      transactions: { run: work => work(db) },
      authorizeHuman: async () => ({ ok: false }),
    });
    const page = await reader.reads.history(productId, null);
    expect(page).toMatchObject({
      outcome: "page",
      nextCursor: null,
      receipts: allRows.map(r => ({ head: r.head })),
    });
    // 2 tx setup + 3 currentIssue + 1 joined page query + 1 batched manifest check = 7 queries regardless of N.
    expect(calls).toHaveLength(7);
    const batchedManifestCalls = calls.filter(c => c.sql.includes("unnest") && c.sql.includes("catalog_publication_manifest_text"));
    expect(batchedManifestCalls).toHaveLength(1);
    expect(batchedManifestCalls[0]!.values?.[2]).toEqual(allRows.map(r => r.digest));
  });

  it("preserves byte-cap short-circuiting and missing-receipt refusal", async () => {
    const productId = uuid(99, 2);
    // Each row's receipt is ~4.7 MiB (within 8 MiB receiptBytes), so 3 rows fit in 16 MiB historyBytes and row 4 triggers short-circuit.
    const allRows = [5, 4, 3, 2, 1].map(rev => publicationRow(productId, rev, 9_500));
    const latest = allRows[0]!;
    let batchedDigests: string[] = [];

    const db: PgQueryExecutor = {
      async query(sql, values) {
        if (sql.startsWith("SET TRANSACTION")) return { rows: [], rowCount: 0 };
        if (sql.includes("current_setting('transaction_isolation')")) return { rows: [{ admitted: true }], rowCount: 1 };
        if (sql.includes("catalog_publication_assert_head")) {
          return { rows: [{ id: latest.id, product_exists: true, admitted: true }], rowCount: 1 };
        }
        if (sql.includes("WHERE p.id=$1::uuid")) return { rows: [latest], rowCount: 1 };
        if (sql.includes("WHERE p.product_id=$1 AND p.revision<=$2")) return { rows: allRows, rowCount: allRows.length };
        if (sql.includes("unnest") && sql.includes("catalog_publication_manifest_text")) {
          batchedDigests = (values?.[2] ?? []) as string[];
          return { rows: batchedDigests.map((_, idx) => ({ ord: idx + 1, verified: true })), rowCount: batchedDigests.length };
        }
        if (sql.includes("catalog_publication_manifest_text")) return { rows: [{ catalog_publication_manifest_text: "{}" }], rowCount: 1 };
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };

    const reader = createPostgresCatalogPublicationReads({
      transactions: { run: work => work(db) },
      authorizeHuman: async () => ({ ok: false }),
    });
    const page = await reader.reads.history(productId, null);
    expect(page.outcome).toBe("page");
    if (page.outcome !== "page") throw new Error("expected page");
    expect(page.receipts).toHaveLength(3);
    expect(page.receipts.map(r => r.head.revision)).toEqual([5, 4, 3]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(Buffer.byteLength(publicationJson(page))).toBeLessThanOrEqual(CATALOG_PUBLICATION_LIMITS.historyBytes);
    // Row 1 (index 4) was never checked after byte-cap break on index 3.
    expect(batchedDigests).toEqual([allRows[0]!.digest, allRows[1]!.digest, allRows[2]!.digest, allRows[3]!.digest]);

    // Missing receipt (LEFT JOIN miss) must refuse with catalog_publication_read_invalid.
    const missingReceiptRows = [{ ...allRows[0]!, receipt_publication_id: null, result: null }];
    const missingDb: PgQueryExecutor = {
      async query(sql, values) {
        if (sql.includes("WHERE p.product_id=$1 AND p.revision<=$2")) return { rows: missingReceiptRows, rowCount: 1 };
        return db.query(sql, values);
      },
    };
    const missingReader = createPostgresCatalogPublicationReads({
      transactions: { run: work => work(missingDb) },
      authorizeHuman: async () => ({ ok: false }),
    });
    expect(await missingReader.reads.history(productId, null)).toMatchObject({
      outcome: "dependency_unavailable",
      reason: "catalog_publication_read_invalid",
    });
  });
});
