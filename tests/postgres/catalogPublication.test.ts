import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import type { CatalogHistoryResult, CatalogPublicationJson, CatalogPublicationRefusal } from "@openlup/platform/catalog/contracts";
import { afterAll, beforeAll, expect, expectTypeOf, it } from "vitest";
import { createPostgresCatalogPublicationReads } from "../../server/adapters/postgres/catalogPublicationReads.js";
import { publicationWireVectors } from "@openlup/platform/catalog/testing";
import { nativeCatalogPublication, type CatalogPublicationManifestV2 } from "@openlup/platform/catalog";
import { actorId, hash, json, installPublicationActors, transaction, fixture, graph, insertGraph, decisionRow,
  decisionReceipt, documentRow, skuRow, sealedState, stageProductRows, invalidReceiptResults, type Graph } from "./catalogPublicationFixture.js";
import { assertConnectedCatalogPublications, captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { installOmsHuman } from "./omsHumanAdmission.fixture.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const { catalogPublicationAdmissionRefusal, publicationJson, SKU_PAGE_DEPTH, limits: CATALOG_PUBLICATION_LIMITS } = nativeCatalogPublication;

const migration = "db/platform/migrations/20261123190000_catalog_publication.sql";
let pool: Pool;
let container: PostgresContainer;

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-publication-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Publication witnesses require PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
    baseline: { file: string }; forward: { file: string }[];
  };
  for (const { file } of [manifest.baseline, ...manifest.forward.filter(unit => unit.file < migration)]) {
    await pool.query(readFileSync(file, "utf8"));
  }
  const sql = readFileSync(migration, "utf8");
  await pool.query(sql).catch((error: Error & { position?: string; where?: string }) => {
    const line = sql.slice(0, Number(error.position) - 1).split("\n").length;
    throw new Error('Publication forward ' + (error.position ? 'line ' + line : 'setup') + ': ' + error.message + (error.where ? ' (' + error.where + ')' : ''), { cause: error });
  });
  await installPublicationActors(pool);
}, postgresSetupTimeoutMs);

afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

it.each(["child-first", "parent-first"] as const)("admits a complete %s issue at COMMIT", async order => {
  const data = fixture();
  await transaction(pool, async db => insertGraph(db, await graph(db, data), order === "child-first" ? { order } : {}));
  const rows = await pool.query("SELECT revision FROM public.catalog_publication_heads WHERE product_id=$1", [data.productId]);
  expect(rows.rows).toEqual([{ revision: 1 }]);
});

it.each([
  ["sourceRef", "example:wrong-source"],
  ["revisionNo", 99],
] as const)("rejects a rehashed same-UUID %s mismatch at COMMIT", async (field, value) => {
  await expect(transaction(pool, async db => {
    const issue = await graph(db, fixture());
    issue.product.document = { ...issue.document, [field]: value };
    await insertGraph(db, issue, { order: "child-first" });
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_document_invalid" });
});

it("binds registration provenance to its own receipted draft", async () => {
  const data = fixture();
  const unrelatedDraft = randomUUID();
  let staged = false;
  const refused = await transaction(pool, async db => {
    const issue = await graph(db, data);
    const { rows: [revision] } = await db.query(
      "SELECT payload FROM public.catalog_draft_revisions WHERE draft_id=$1 AND revision=1", [data.draftId],
    );
    const payload = { ...revision.payload, publication: { ...revision.payload.publication, operations: [] } };
    const source = { ...issue.source, draftId: unrelatedDraft, fingerprint: hash(json(payload)) };
    // A product has one head. The retained revision can still claim this product.
    await db.query("INSERT INTO public.catalog_draft_heads(draft_id,product_id,revision,status) VALUES($1,$2,1,'open')",
      [unrelatedDraft, randomUUID()]);
    await db.query("INSERT INTO public.catalog_draft_revisions(draft_id,revision,product_id,status,payload,command_key,fingerprint,actor_id) VALUES($1,1,$2,'open',$3,$4,$5,'test-fixture')",
      [unrelatedDraft, data.productId, json(payload), source.commandKey, source.fingerprint]);
    await db.query("INSERT INTO public.catalog_draft_command_receipts(draft_id,command_key,fingerprint,revision) VALUES($1,$2,$3,1)",
      [unrelatedDraft, source.commandKey, source.fingerprint]);
    await documentRow(db, { ...issue, source });
    await insertGraph(db, issue, { existingDocument: true });
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  expect(catalogPublicationAdmissionRefusal(refused)).toMatchObject({ reason: "publication_content_changed" });
  expect((await pool.query("SELECT id FROM public.catalog_products WHERE id=$1", [data.productId])).rows).toEqual([]);
  expect((await pool.query("SELECT draft_id FROM public.catalog_draft_heads WHERE draft_id=ANY($1::uuid[])", [[data.draftId, unrelatedDraft]])).rows).toEqual([]);
});

it.each([false, true])("binds issuing document provenance even with an older registration (previous issue: %s)", async existing => {
  const data = fixture();
  const older = await transaction(pool, async db => {
    const candidate = await graph(db, data);
    if (existing) await insertGraph(db, candidate);
    else await documentRow(db, candidate);
    return candidate;
  });
  let staged = false;
  const refusal = await transaction(pool, async db => {
    const issuing = await graph(db, data, existing ? older.head : null, false, { draftRevision: 2, registerExisting: true });
    await insertGraph(db, issuing, { existingDocument: true });
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  expect(catalogPublicationAdmissionRefusal(refusal)).toMatchObject({ reason: "publication_content_changed" });
  expect((await pool.query("SELECT revision FROM public.catalog_draft_heads WHERE draft_id=$1", [data.draftId])).rows)
    .toEqual([{ revision: 1 }]);
  expect((await pool.query("SELECT revision FROM public.catalog_publications WHERE product_id=$1", [data.productId])).rows)
    .toEqual(existing ? [{ revision: 1 }] : []);
  expect((await pool.query("SELECT provenance->>'draftRevision' AS revision FROM public.catalog_product_document_revisions WHERE id=$1", [data.documentId])).rows)
    .toEqual([{ revision: "1" }]);
});

it.each(["origin registration bytes", "authored document"] as const)("refuses contradictory %s even when the issuing registration matches", async kind => {
  const data = fixture();
  const origin = await transaction(pool, async db => {
    const contradiction = { label: "different authored bytes" };
    const older = await graph(db, data, null, true, kind === "origin registration bytes"
      ? { registrationText: json(contradiction) } : { authoredDocument: contradiction });
    await documentRow(db, older);
    return older;
  });
  let staged = false;
  const error = await transaction(pool, async db => {
    const issuing = await graph(db, data, null, false, { draftRevision: 2, retainedSource: origin.source });
    await insertGraph(db, issuing, { existingDocument: true });
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_content_changed" });
  expect((await pool.query("SELECT id FROM public.catalog_publications WHERE product_id=$1", [data.productId])).rows).toEqual([]);
  expect((await pool.query("SELECT command_key FROM public.catalog_operator_receipts WHERE scope_id=$1", [data.productId])).rows).toEqual([]);
  expect((await pool.query("SELECT revision FROM public.catalog_draft_heads WHERE draft_id=$1", [data.draftId])).rows).toEqual([{ revision: 1 }]);
});

it("refuses a registration whose original text is a JSON object instead of a string", async () => {
  const data = fixture();
  let staged = false;
  const error = await transaction(pool, async db => {
    const issue = await graph(db, data, null, true, { documentText: "{}", registrationText: {} });
    expect(issue.document.digest).toBe(hash("{}"));
    await insertGraph(db, issue);
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_content_changed" });
  expect((await pool.query("SELECT id FROM public.catalog_publications WHERE product_id=$1", [data.productId])).rows).toEqual([]);
  expect((await pool.query("SELECT id FROM public.catalog_products WHERE id=$1", [data.productId])).rows).toEqual([]);
});

const jsonDepth = (value: unknown, depth = 0): number => value !== null && typeof value === "object"
  ? Math.max(depth, ...Object.values(value).map(item => jsonDepth(item, depth + 1))) : depth;

it.each([48, 49])("starts the candidate at the released draft's own depth for a deepest value at %i", async deepest => {
  const data = fixture();
  // The authored document sits at depth 3 and its value at 4; each array adds one level.
  // The deepest value is an empty object, which the released draft encoder accepts at depth 48.
  let nested: unknown = {};
  for (let level = 4; level < deepest; level++) nested = [nested];
  const document = { value: nested };
  let staged = false;
  const error = await transaction(pool, async db => {
    const issue = await graph(db, data, null, true, { documentText: json(document), authoredDocument: document });
    const { rows: [draft] } = await db.query("SELECT payload FROM public.catalog_draft_revisions WHERE draft_id=$1", [data.draftId]);
    expect(jsonDepth(draft.payload)).toBe(deepest);
    await insertGraph(db, issue);
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  const issued = await pool.query("SELECT revision FROM public.catalog_publications WHERE product_id=$1", [data.productId]);
  const approvals = await pool.query("SELECT action FROM public.catalog_publication_decisions WHERE product_id=$1", [data.productId]);
  if (deepest === 48) {
    expect(error).toBeUndefined();
    expect(issued.rows).toEqual([{ revision: 1 }]);
    expect(approvals.rows).toEqual([{ action: "approve" }]);
  } else {
    expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_approval_invalid" });
    expect(issued.rows).toEqual([]);
    expect(approvals.rows).toEqual([]);
  }
});

it.each([
  ["receipt", { receipt: "omit" }, "catalog_publication_receipt_invalid"],
  ["receipt timestamp", { receipt: "timestamp" }, "catalog_publication_receipt_invalid"],
  ["head", { head: "omit" }, "catalog_publication_head_invalid"],
  ["roster", { roster: "omit" }, "catalog_publication_sku_revision_invalid"],
] as const)("rejects invalid %s at COMMIT and rolls back the graph", async (_label, options, constraint) => {
  const data = fixture();
  await expect(transaction(pool, async db => {
    await insertGraph(db, await graph(db, data), options);
  })).rejects.toMatchObject({ code: "23514", constraint });
  expect((await pool.query("SELECT id FROM public.catalog_products WHERE id=$1", [data.productId])).rowCount).toBe(0);
});

it("the original receipt is unchanged after a late owner SKU insert is refused", async () => {
  const data = fixture();
  const issued = await transaction(pool, async db => {
    const value = await graph(db, data);
    await insertGraph(db, value);
    return value;
  });
  const readers = createPostgresCatalogPublicationReads({
    transactions: { run: work => transaction(pool, work) },
    authorizeHuman: async () => ({ ok: true, userId: actorId, role: "admin", isMachineActor: false }),
  });
  const admin = (await readers.authorize(null))!;
  const readReceipt = () => readers.receipt({ productId: issued.productId, commandKey: issued.commandKey }, admin);
  const original = await readReceipt();
  expect(original).toMatchObject({ outcome: "found", receipt: { head: issued.head } });
  const newId = randomUUID(), code = `sku-${newId}`;
  await expect(transaction(pool, async db => {
    await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,net_weight_g) VALUES($1,$2,$3,'Extra','draft',100)",
      [newId, issued.productId, code]);
    await skuRow(db, { ...issued, skuId: newId, skuRevisionId: randomUUID(), facts: { ...issued.facts, id: newId, code } }, 2);
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_issue_sealed" });
  expect(await readReceipt()).toEqual(original);
});

it.each([
  ["publication", "UPDATE public.catalog_publications SET issued_count=issued_count WHERE product_id=$1"],
  ["SKU revision", "UPDATE public.catalog_sku_revisions SET issue_ordinal=issue_ordinal WHERE product_id=$1"],
  ["receipt", "UPDATE public.catalog_operator_receipts SET result=result WHERE scope_id=$1 AND kind='publish'"],
  ["decision", "DELETE FROM public.catalog_publication_decisions WHERE product_id=$1"],
] as const)("refuses owner mutation of a saved %s at COMMIT", async (_relation, mutation) => {
  const data = fixture();
  await transaction(pool, async db => insertGraph(db, await graph(db, data)));
  const result = await transaction(pool, async db => {
    expect((await db.query(mutation, [data.productId])).rowCount).toBe(1);
  }).catch((error: unknown) => error);
  expect(catalogPublicationAdmissionRefusal(result)).toEqual({
    outcome: "validation_issue", reason: "publication_requires_new_revision",
    message: "Saved publication details cannot be changed. Reload the product and prepare a new publication.",
  });
});

it("the deferred head guard rejects deleting a committed head", async () => {
  const data = fixture();
  await transaction(pool, async db => insertGraph(db, await graph(db, data)));
  await expect(transaction(pool, async db => {
    await db.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [data.productId]);
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_head_invalid" });
});

it("the deferred receipt guard rejects a decision receipt without a decision", async () => {
  await expect(transaction(pool, async db => {
    await decisionReceipt(db, await graph(db, fixture()));
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_receipt_invalid" });
});

it("the deferred decision guard rejects a malformed candidate even with a matching receipt", async () => {
  await expect(transaction(pool, async db => {
    const value = await graph(db, fixture());
    // Both sides agree about the false digest.
    value.candidateDigest = hash("wrong");
    value.decision.candidateDigest = value.candidateDigest;
    await decisionReceipt(db, value);
    await decisionRow(db, value);
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_candidate_invalid" });
});

it("binds canonical key order and number spelling to the retained wire", async () => {
  const text = json({ "10": true, "2": true, a: { "\uE000": 1e-7, "𐀀": 1e20, sample: 1e-6 }, z: 1e21 });
  const result = await pool.query("SELECT public.catalog_publication_canonical($1::jsonb,0) AS value", [text]);
  expect(result.rows).toEqual([{ value: text }]);
});

it.each([2_097_152, 2_097_153])("enforces the exact SKU wire boundary at %i UTF-8 bytes", async bytes => {
  const data = fixture();
  const write = transaction(pool, async db => {
    const issue = await graph(db, data);
    issue.facts.facts.zzPadding = "é";
    issue.facts.facts.zzPadding += "x".repeat(bytes - Buffer.byteLength(json(issue.facts)));
    expect(Buffer.byteLength(json(issue.facts))).toBe(bytes);
    await insertGraph(db, issue);
  });
  if (bytes === 2_097_152) {
    await write;
    expect((await pool.query("SELECT octet_length(full_facts) AS n FROM public.catalog_sku_revisions WHERE sku_id=$1", [data.skuId])).rows).toEqual([{ n: bytes }]);
  } else {
    await expect(write).rejects.toMatchObject({ code: "23514", constraint: "catalog_sku_revisions_full_facts_check" });
  }
});

it("rejects an unused pointer capability at COMMIT through the typed mapper", async () => {
  const data = fixture();
  const issued = await transaction(pool, async db => {
    const issue = await graph(db, data);
    await insertGraph(db, issue);
    return issue;
  });
  const error = await transaction(pool, async db => {
    await db.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)",
      [data.productId, data.documentId, issued.fingerprint]);
  }).catch((error: unknown) => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({
    outcome: "validation_issue", reason: "publication_content_not_saved", message: expect.stringContaining("retry"),
  });
});

it("verifies current, history, recovery and accepted retained A after B with an unrelated legacy document above both", async () => {
  const data = fixture();
  const issued = await transaction(pool, async db => {
    const first = await graph(db, data);
    const receipt = await insertGraph(db, first);
    const second = await graph(db, data, first.head);
    await insertGraph(db, second, { order: "child-first" });
    await db.query(`INSERT INTO public.catalog_product_document_revisions
      (id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest)
      VALUES($1,$2,99,'example:legacy','example:later','{}','example:other','{}',$3)`, [randomUUID(), data.productId, hash("legacy")]);
    return { first, second, receipt };
  });
  let failure: unknown;
  const readers = createPostgresCatalogPublicationReads({
    transactions: { run: work => transaction(pool, work).catch(error => { failure = error; throw error; }) },
    authorizeHuman: async () => ({ ok: true, userId: actorId, role: "admin", isMachineActor: false }),
    acceptedSource: async (_db, context: string, binding) => context === "owner" ? binding : "unauthorized",
  });
  const admin = (await readers.authorize("owner"))!;
  const current = await readers.reads.current(data.productId);
  expect(current, failure instanceof Error ? failure.message : undefined).toMatchObject({ outcome: "found", head: issued.second.head, documentRef: "example:ref" });
  expect(await readers.readbackV2(issued.first.head)).toMatchObject({ outcome: "page", head: issued.first.head, items: [{ facts: { title: "Article" } }] });
  expect(await readers.receipt({ productId: data.productId, commandKey: issued.first.commandKey }, admin)).toEqual({ outcome: "found", receipt: issued.receipt });
  expect(await readers.reads.history(data.productId, null)).toMatchObject({ outcome: "page", receipts: [{ head: issued.second.head }, { head: issued.first.head }] });
  for (const kind of ["account", "order", "fulfilment"] as const) {
    const binding = { kind, sourceId: randomUUID(), lineId: randomUUID(), productId: data.productId, skuId: data.skuId,
      skuRevisionId: issued.first.skuRevisionId, publicationId: issued.first.issueId, documentRevisionId: data.documentId };
    expect(await readers.resolveRetained(binding, readers.authorizeReadScope("owner"))).toMatchObject({ outcome: "found", head: issued.first.head, sku: { title: "Article" } });
    expect(await readers.resolveRetained(binding, readers.authorizeReadScope("other"))).toEqual({ outcome: "unauthorized", reason: "retained_read_not_authorized",
      message: "This account cannot read the retained revision. Use the account, order or fulfilment that owns it." });
  }
  await pool.query("UPDATE public.catalog_products SET name='Later draft name' WHERE id=$1", [data.productId]);
  expect(await readers.reads.current(data.productId)).toEqual({ outcome: "conflict", reason: "head_conflict",
    message: "The current product or a SKU differs from the prepared publication. Reload the product and prepare it again." });
  expect(await readers.readbackV2(issued.first.head)).toMatchObject({ outcome: "page", head: issued.first.head });
});

it("checks the graph again after SET CONSTRAINTS switches back to deferred", async () => {
  const error = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    await insertGraph(db, issue);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("SET CONSTRAINTS ALL DEFERRED");
    await db.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [issue.productId]);
  }).catch((error: unknown) => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ outcome: "validation_issue", reason: "publication_changed" });
});

it("inherits the exact predecessor roster with zero issued revisions and rejects a superseded reference", async () => {
  const data = fixture();
  const { first, second, third } = await transaction(pool, async db => {
    const first = await graph(db, data);
    await insertGraph(db, first);
    const second = await graph(db, data, first.head);
    await insertGraph(db, second);
    const third = await graph(db, data, second.head);
    const receipt = await insertGraph(db, third, { inherit: {
      skuId: data.skuId, revisionId: second.skuRevisionId, revision: second.revision, digest: hash(json(second.facts)),
    } });
    expect(receipt.changes).toEqual([]);
    return { first, second, third };
  });
  expect((await pool.query("SELECT count(*)::int AS n FROM public.catalog_sku_revisions WHERE publication_id=$1", [third.issueId])).rows)
    .toEqual([{ n: 0 }]);
  await expect(transaction(pool, async db => {
    const fourth = await graph(db, data, third.head);
    await insertGraph(db, fourth, { inherit: {
      skuId: data.skuId, revisionId: first.skuRevisionId, revision: first.revision, digest: hash(json(first.facts)),
    } });
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_sku_revision_invalid" });
  await expect(transaction(pool, async db => {
    const fourth = await graph(db, data, third.head);
    fourth.product.primarySkuId = randomUUID();
    await insertGraph(db, fourth, { inherit: {
      skuId: data.skuId, revisionId: second.skuRevisionId, revision: second.revision, digest: hash(json(second.facts)),
    } });
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_sku_revision_invalid" });
  expect((await pool.query("SELECT publication_id FROM public.catalog_publication_heads WHERE product_id=$1", [data.productId])).rows)
    .toEqual([{ publication_id: third.issueId }]);
});

it.each([
  ["whitespace", (state: string) => ` ${state}`],
  ["embedded document", (state: string) => {
    const parsed = JSON.parse(state);
    parsed.product.content.document = {};
    return json(parsed);
  }],
] as const)("rejects rehashed %s in the publication wire at COMMIT", async (_label, rawState) => {
  const error = await transaction(pool, async db => {
    const issued = await graph(db, fixture());
    await insertGraph(db, issued, { rawState });
  }).catch((error: unknown) => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ outcome: "validation_issue", reason: "publication_details_invalid" });
});

it("serializes first issuance against a legacy pointer update with an older snapshot", async () => {
  const data = fixture();
  const first = await transaction(pool, async db => {
    const staged = await graph(db, data);
    await documentRow(db, staged);
    return staged;
  });
  const otherDocument = randomUUID();
  await pool.query(`INSERT INTO public.catalog_product_document_revisions
    (id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest)
    VALUES($1,$2,2,'example:legacy','example:other','{}','example:other','{}',$3)`, [otherDocument, data.productId, hash("other")]);

  const legacy = await pool.connect();
  try {
    await legacy.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await legacy.query("SELECT current_document_revision_id FROM public.catalog_products WHERE id=$1", [data.productId]);
    await expect(transaction(pool, db => insertGraph(db, first, { existingDocument: true, omitProductProjection: true })))
      .rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_document_invalid" });
    await transaction(pool, db => insertGraph(db, first, { existingDocument: true }));
    await expect(legacy.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1", [data.productId, otherDocument]))
      .rejects.toMatchObject({ code: "40001" });
  } finally {
    await legacy.query("ROLLBACK");
    legacy.release();
  }
  expect((await pool.query("SELECT current_document_revision_id FROM public.catalog_products WHERE id=$1", [data.productId])).rows)
    .toEqual([{ current_document_revision_id: data.documentId }]);
});

it("budgets a real continuation for a full-fact page and returns the terminal page exactly", async () => {
  const issued = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    issue.facts.facts.zzPadding = "é";
    issue.facts.facts.zzPadding += "x".repeat(2_097_152 - Buffer.byteLength(json(issue.facts)));
    await insertGraph(db, issue, { extraSkuCount: 3 });
    return issue;
  });
  const reader = createPostgresCatalogPublicationReads({
    transactions: { run: work => transaction(pool, work) },
    authorizeHuman: async () => ({ ok: false }),
  });
  const first = await reader.readbackV2(issued.head);
  expect(first).toMatchObject({ outcome: "page", nextCursor: expect.any(String) });
  if (first.outcome !== "page") throw new Error(first.reason);
  expect(first.items).toHaveLength(3);
  const last = await reader.readbackV2(issued.head, first.nextCursor);
  expect(last).toMatchObject({ outcome: "page", nextCursor: null });
  if (last.outcome !== "page") throw new Error(last.reason);
  expect(last.items).toHaveLength(1);
  expect(new Set([...first.items, ...last.items].map(item => item.reference.skuId)).size).toBe(4);
  const foreign = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    await insertGraph(db, issue);
    return issue.head;
  });
  const invalidContinuation = {
    outcome: "validation_issue", reason: "candidate_invalid",
    message: "Restart from the first page or reuse the continuation returned for this product.",
  };
  expect(await reader.readbackV2(issued.head, "!")).toEqual(invalidContinuation);
  expect(await reader.readbackV2(foreign, first.nextCursor)).toEqual(invalidContinuation);
});

it.each(["malformed", "foreign"] as const)("preserves the typed history remedy for a %s cursor", async kind => {
  expectTypeOf<Exclude<CatalogHistoryResult, { outcome: "page" }>>().toExtend<CatalogPublicationRefusal>();
  const productId = randomUUID();
  const cursor = kind === "malformed" ? "!" : Buffer.from(json({
    schemaVersion: 1, kind: "history", productId: randomUUID(), highWater: 2, before: 2,
  })).toString("base64url");
  expect(await publicationReader().reads.history(productId, cursor)).toEqual({
    outcome: "validation_issue", reason: "candidate_invalid",
    message: "Restart from the first page or reuse the continuation returned for this product.",
  });
});

it("gives the caller a remedy for a publication head with revision zero", async () => {
  const reader = publicationReader();
  const head = { publicationId: randomUUID(), documentDigest: hash("document"), revision: 0 };
  const refusal = { outcome: "validation_issue", reason: "candidate_invalid",
    message: "Reload the product and use the publication identifiers returned for it." };
  expect(await reader.reads.readback(head)).toEqual(refusal);
  expect(await reader.readbackV2(head)).toEqual(refusal);
});

it.each([
  ["a changed digest", (head: Graph["head"]) => ({ ...head, documentDigest: hash("another document") }),
    { outcome: "conflict", reason: "head_conflict" }, "head_conflict",
    "The selected publication head does not match the saved publication. Reload the product and select its publication again."],
  ["an absent publication", (head: Graph["head"]) => ({ ...head, publicationId: randomUUID() }),
    { outcome: "unsupported", reason: "publication_not_supported" }, "catalog_publication_absent",
    "The selected publication does not exist. Reload the product and select one of its publications."],
] as const)("gives the caller a remedy on both exact reads for %s", async (_kind, select, released, exactReason, message) => {
  const issued = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    await insertGraph(db, issue);
    return issue.head;
  });
  const reader = publicationReader();
  const head = select(issued);
  expect(await reader.reads.readback(head)).toEqual({ ...released, message });
  expect(await reader.readbackV2(head)).toEqual({ outcome: released.outcome, reason: exactReason, message });
  expect(await reader.readbackV2(issued)).toMatchObject({ outcome: "page", head: issued });
});

it.each(["current", "history"] as const)("tells the caller how to proceed with a product that has no publication through %s", async entry => {
  const data = fixture();
  await transaction(pool, db => stageProductRows(db, data));
  const { reads } = publicationReader();
  expect(entry === "current" ? await reads.current(data.productId) : await reads.history(data.productId, null)).toEqual({
    outcome: "unsupported", reason: "publication_not_supported",
    message: "This product has no publication yet. Publish a revision of the product before reading its publication.",
  });
});

it("uses the exact significant UTF-8 bytes of the recovery command key", async () => {
  const commandKey = ` ${"é".repeat(99)} `;
  const { productId, receipt } = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    issue.commandKey = commandKey;
    issue.fingerprint = hash(commandKey);
    return { productId: issue.productId, receipt: await insertGraph(db, issue) };
  });
  const reader = createPostgresCatalogPublicationReads({
    transactions: { run: work => transaction(pool, work) },
    authorizeHuman: async () => ({ ok: true, userId: actorId, role: "admin", isMachineActor: false }),
  });
  const actor = (await reader.authorize(null))!;
  expect(Buffer.byteLength(commandKey)).toBe(200);
  expect(await reader.receipt({ productId, commandKey }, actor)).toEqual({ outcome: "found", receipt });
  expect(await reader.receipt({ productId, commandKey: commandKey.trim() }, actor)).toEqual({ outcome: "absent" });
  expect(await reader.receipt({ productId, commandKey: commandKey + " " }, actor))
    .toMatchObject({ outcome: "validation_issue", reason: "candidate_invalid" });
});

it("admits a decision and its companion before the product exists", async () => {
  const data = fixture();
  await transaction(pool, async db => {
    const issue = await graph(db, data, null, false);
    await decisionRow(db, issue);
    await decisionReceipt(db, issue);
  });
  const result = await pool.query(`SELECT d.action,p.id AS product FROM public.catalog_publication_decisions d
    LEFT JOIN public.catalog_products p ON p.id=d.product_id WHERE d.product_id=$1`, [data.productId]);
  expect(result.rows).toEqual([{ action: "approve", product: null }]);
});

it("refuses a decision and receipt with a noncanonical spelling of the actual predecessor", async () => {
  const data = fixture();
  const previous = await transaction(pool, async db => {
    const issue = await graph(db, data);
    await insertGraph(db, issue);
    return issue.head;
  });
  const candidate = await transaction(pool, db => graph(db, data, previous));
  const alias = previous.publicationId.replace(/^([a-f0-9]{4})([a-f0-9]{4})-([a-f0-9]{4})-/u, "$1-$2$3-");
  expect(alias).not.toBe(previous.publicationId);
  expect((await pool.query("SELECT $1::uuid::text AS id", [alias])).rows).toEqual([{ id: previous.publicationId }]);
  const candidateRef = candidate.candidateRef.replace(previous.publicationId, alias);
  const decision = { ...candidate, candidateRef, decision: { ...candidate.decision, candidateRef } };
  let staged = false;
  const error = await transaction(pool, async db => {
    await decisionRow(db, decision);
    await decisionReceipt(db, decision);
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_approval_invalid" });
  expect((await pool.query("SELECT id FROM public.catalog_publication_decisions WHERE id=$1", [candidate.approvalId])).rows).toEqual([]);
  expect((await pool.query("SELECT command_key FROM public.catalog_operator_receipts WHERE scope_id=$1 AND command_key=$2",
    [data.productId, candidate.decisionKey])).rows).toEqual([]);
});

it.each([10_000, 10_001])("applies the issuance roster limit to a sealed approval with %i pairs", async count => {
  const data = fixture();
  const candidate = await transaction(pool, db => graph(db, data, null, false));
  const digest = hash(json(candidate.facts));
  const pairs = Array.from({ length: count - 1 }, (_, n) => ({
    skuId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, digest,
  }));
  pairs.push({ skuId: candidate.skuId, digest });
  const seal = sealedState(candidate.product, pairs);
  let staged = false;
  const error = await transaction(pool, async db => {
    await decisionRow(db, candidate, seal);
    await decisionReceipt(db, candidate, seal);
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  const decisions = await pool.query("SELECT id FROM public.catalog_publication_decisions WHERE product_id=$1", [data.productId]);
  const receipts = await pool.query("SELECT command_key FROM public.catalog_operator_receipts WHERE scope_id=$1", [data.productId]);
  if (count === 10_000) {
    expect(error).toBeUndefined();
    expect(decisions.rows).toEqual([{ id: candidate.approvalId }]);
    expect(receipts.rows).toEqual([{ command_key: candidate.decisionKey }]);
  } else {
    expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({
      reason: "publication_roster_limit", message: expect.stringContaining("Put additional SKUs on another product"),
    });
    expect(decisions.rows).toEqual([]);
    expect(receipts.rows).toEqual([]);
  }
});

it.each(["duplicate", "reversed", "empty", "missing primary"] as const)(
  "refuses a sealed approval with a %s roster before the product exists", async shape => {
    const data = fixture();
    const candidate = await transaction(pool, db => graph(db, data, null, false));
    const member = { skuId: candidate.skuId, digest: hash(json(candidate.facts)) };
    const other = { ...member, skuId: randomUUID() };
    const rosters = {
      duplicate: [member, member],
      reversed: [member, other].sort((left, right) => left.skuId < right.skuId ? 1 : -1),
      empty: [],
      "missing primary": [other],
    };
    const seal = json({ schemaVersion: 2, product: candidate.product, skus: rosters[shape] });
    const error = await transaction(pool, async db => {
      await decisionRow(db, candidate, seal);
      await decisionReceipt(db, candidate, seal);
    }).catch(error => error);
    expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({
      reason: "publication_approval_state_invalid",
      message: expect.stringContaining("Prepare the publication again."),
    });
    expect((await pool.query("SELECT id FROM public.catalog_publication_decisions WHERE product_id=$1", [data.productId])).rows).toEqual([]);
    expect((await pool.query("SELECT command_key FROM public.catalog_operator_receipts WHERE scope_id=$1", [data.productId])).rows).toEqual([]);
  },
);

it("retains one document value and refuses a different value with the same recorded reference", async () => {
  const result = await pool.query(`SELECT attname FROM pg_attribute WHERE
    attrelid='public.catalog_product_document_revisions'::regclass AND attname IN ('document_payload','canonical_text')
    AND NOT attisdropped ORDER BY attname`);
  expect(result.rows).toEqual([{ attname: "document_payload" }]);
  await expect(transaction(pool, async db => {
    const issue = await graph(db, fixture());
    await documentRow(db, issue, json({ label: "different content" }));
    await insertGraph(db, issue, { existingDocument: true });
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_document_invalid" });
});
it.each([
  ["unknown product field", { extraField: true }, "publication_details_invalid"],
  ["axes", { axes: ["Size"] }, "publication_axes_invalid"],
  ["attribute type", { attributes: { capacity: 5 } }, "publication_attributes_invalid"],
  ["presentation carrier", { presentation: { document: { title: "Sample" } } }, "publication_content_invalid"],
] as const)("refuses %s at the shared product decoder", async (_label, change, reason) => {
  const error = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    await insertGraph(db, issue, { rawState: text => {
      const manifest = JSON.parse(text);
      Object.assign(manifest.product, change);
      return json(manifest);
    } });
  }).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason });
});

it.each([
  ["unsupported purchase mode", { requestedModes: [{ skuCode: "item", modes: ["weekly"] }] }, "one-time purchase or subscription"],
  ["duplicate SKU intents", { offerMemberships: Array(2).fill({ skuCode: "item", offerVersion: "example:offer", admitted: true }) }, "once per SKU"],
  ["unknown SKU intent field", { publicationSkus: [{ skuCode: "item", title: "Item", minQuantity: 1, isAddon: false, facts: {}, extra: true }] }, "title, order minimum"],
  ["nested document in presentation", { presentation: { document: { title: "Sample" } } }, "presentation fields"],
  ["descending advertised weights", { presentation: { advertisedWeightsG: [200, 100] } }, "presentation fields"],
  ["an advertised weight above 9,999,999 grams", { presentation: { advertisedWeightsG: [10_000_000] } }, "presentation fields"],
  ["nested facts in an intent", { publicationSkus: [{ skuCode: "item", title: "Item", minQuantity: 1, isAddon: false, facts: { document: {} } }] }, "valid facts"],
] as const)("refuses %s at the shared content decoder", async (_label, change, repair) => {
  const error = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    await insertGraph(db, issue, { rawState: text => {
      const manifest = JSON.parse(text);
      Object.assign(manifest.product.content, change);
      return json(manifest);
    } });
  }).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_content_invalid", message: expect.stringContaining(repair) });
});

it.each([
  ["invalid GTIN", { identifiers: [{ scheme: "gs1:gtin", issuer: "example:issuer", value: "96385075",
    packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null }] }, "publication_gtin_invalid"],
  ["251 two-unit title characters", { title: "🎈".repeat(251) }, "publication_sku_title_invalid"],
] as const)("refuses %s at the shared SKU decoder", async (_label, change, reason) => {
  const error = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    await insertGraph(db, issue, { rawFacts: text => {
      const facts = { ...JSON.parse(text), ...change };
      return json(facts);
    } });
  }).catch(error => error);
  expect(error).toMatchObject({ code: "23514" });
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason });
});

it.each([
  ["100.0 grams at scale 1", { dimension: "mass", unit: "openlup:g", unscaled: "1000", scale: 1 }],
  ["100 millilitres", { dimension: "volume", unit: "openlup:ml", unscaled: "100", scale: 0 }],
] as const)("refuses %s of net content with the whole-gram publication remedy", async (_label, netContent) => {
  const error = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    issue.facts.netContent = { ...netContent };
    await insertGraph(db, issue);
    // The live quantity agrees with the approved one; only the unit or scale is unsupported.
    await db.query(`UPDATE public.catalog_skus SET net_content_dimension=$2,net_content_unit=$3,
      net_content_unscaled=$4,net_content_scale=$5 WHERE id=$1`,
    [issue.skuId, netContent.dimension, netContent.unit, netContent.unscaled, netContent.scale]);
  }).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toEqual({ outcome: "validation_issue", reason: "publication_net_weight_unsupported",
    message: "Net content must be expressed in whole grams at scale 0 to publish. Other units cannot be published yet." });
});

it("admits the same typed presentation, valid GTIN, axes and SKU intents the reader decodes", async () => {
  const head = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    issue.product.axes = ["size"];
    issue.product.attributes = { capacity: [true, "medium"], name: { en: "Item" } };
    issue.product.content.presentation = { title: "🎈".repeat(250), routePath: { "en-US": "/item" }, advertisedWeightsG: [100, 9_999_999] };
    issue.product.content.requestedModes = [{ skuCode: issue.facts.code, modes: ["one_time", "subscription"] }];
    issue.facts.facts = { sizes: [{ quantity: 3 }] };
    issue.facts.identifiers = [{ scheme: "gs1:gtin", issuer: "example:issuer", value: "96385074", packagingLevel: "unit",
      quantity: 1, isPrimary: true, label: null, sourceRef: null }];
    await insertGraph(db, issue);
    return issue.head;
  });
  expect(await publicationReader().readbackV2(head)).toMatchObject({ outcome: "page", items: [{ facts: { identifiers: [{ value: "96385074" }], facts: { sizes: [{ quantity: 3 }] } } }] });
});

it.each([0, 1])("checks the real singleton page byte boundary with %i extra bytes", async extra => {
  let head: Awaited<ReturnType<typeof graph>>["head"] | undefined;
  const result = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    head = issue.head;
    const facts = Object.fromEntries(Array.from({ length: 4096 }, (_, number) => [`note${number}`, ""]));
    issue.product.content.publicationSkus = [{ skuCode: issue.facts.code, title: "Item", isAddon: false, minQuantity: 1, facts }];
    const reference = { skuId: issue.skuId, revisionId: issue.skuRevisionId, revision: 1, digest: hash(json(issue.facts)) };
    const base = Buffer.byteLength(json({ outcome: "page", schemaVersion: 2, head, product: issue.product,
      items: [{ reference, facts: issue.facts }], nextCursor: null }));
    let remaining = CATALOG_PUBLICATION_LIMITS.pageBytes - base + extra;
    for (const key of Object.keys(facts)) {
      const count = Math.min(2048, remaining);
      facts[key] = "x".repeat(count);
      remaining -= count;
    }
    expect(remaining).toBe(0);
    await insertGraph(db, issue);
  }).catch(error => error);
  if (extra) expect(catalogPublicationAdmissionRefusal(result)).toMatchObject({ reason: "publication_details_too_large" });
  else {
    expect(result).toBeUndefined();
    const page = await publicationReader().readbackV2(head!);
    expect(page.outcome).toBe("page");
    expect(Buffer.byteLength(json(page))).toBe(CATALOG_PUBLICATION_LIMITS.pageBytes);
  }
}, 60_000);

it("binds every issued SKU to the exact publication draft even when another draft source is valid", async () => {
  await expect(transaction(pool, async db => {
    const data = fixture();
    const first = await graph(db, data);
    await insertGraph(db, first);
    const second = await graph(db, data, first.head);
    second.facts.source = first.source;
    await insertGraph(db, second);
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_sku_revision_invalid" });
});

it("refuses issuance after a receipted revocation and permits an active approval", async () => {
  const data = fixture();
  await expect(transaction(pool, async db => {
    const issue = await graph(db, data);
    const { rows: [times] } = await db.query(`SELECT
      to_char($1::timestamptz AT TIME ZONE 'UTC' + interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revoked,
      to_char($1::timestamptz AT TIME ZONE 'UTC' + interval '2 seconds','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS committed`, [issue.time]);
    const revoked = changeDecision(issue, "revoke", "revoke:1", randomUUID());
    await insertDecision(db, { ...revoked, time: times.revoked });
    await insertGraph(db, { ...issue, time: times.committed }, { approvalTime: issue.time });
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_approval_missing" });
  await transaction(pool, async db => insertGraph(db, await graph(db, data)));
});

it("refuses an issue backdated between a committed approval and its later revocation", async () => {
  const data = fixture();
  const issue = await transaction(pool, async db => {
    const value = await graph(db, data);
    await decisionRow(db, value);
    await decisionReceipt(db, value);
    return value;
  });
  const { rows: [times] } = await pool.query(`SELECT
    to_char($1::timestamptz AT TIME ZONE 'UTC' + interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS issued,
    to_char($1::timestamptz AT TIME ZONE 'UTC' + interval '2 seconds','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revoked`, [issue.time]);
  const revoke = changeDecision(issue, "revoke", "revoke:1", randomUUID());
  await transaction(pool, db => insertDecision(db, { ...revoke, time: times.revoked }));
  let staged = false;
  const error = await transaction(pool, async db => {
    await insertGraph(db, { ...issue, time: times.issued }, { reuseApproval: true });
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_approval_missing" });
  expect((await pool.query("SELECT id FROM public.catalog_publications WHERE product_id=$1", [data.productId])).rows).toEqual([]);
  expect((await pool.query("SELECT current_document_revision_id AS id FROM public.catalog_products WHERE id=$1", [data.productId])).rows)
    .toEqual([{ id: null }]);
});

it.each(["at the approval instant", "one second later"] as const)("refuses revoking an issued candidate %s and says no action is needed", async when => {
  const issue = await transaction(pool, async db => {
    const value = await graph(db, fixture());
    await insertGraph(db, value);
    return value;
  });
  // The highest identifier orders the revocation after the approval at the same instant.
  const revoke = changeDecision(issue, "revoke", "revoke:1", "ffffffff-ffff-4fff-bfff-ffffffffffff");
  if (when === "one second later") revoke.time = (await pool.query(`SELECT to_char($1::timestamptz AT TIME ZONE 'UTC' + interval '1 second',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`, [issue.time])).rows[0].value;
  const error = await transaction(pool, db => insertDecision(db, revoke)).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toEqual({ outcome: "validation_issue", reason: "publication_candidate_already_issued",
    message: "This candidate is already issued; revoking it has no effect. No action is needed." });
  expect((await pool.query("SELECT action FROM public.catalog_publication_decisions WHERE product_id=$1 ORDER BY action", [issue.productId])).rows)
    .toEqual([{ action: "approve" }]);
  expect((await publicationReader().readbackV2(issue.head)).outcome).toBe("page");
});

it.each(["REPEATABLE READ", "READ COMMITTED"] as const)("cannot issue during %s after an independently committed revocation", async isolation => {
  const issue = await transaction(pool, async db => {
    const value = await graph(db, fixture());
    await decisionRow(db, value);
    await decisionReceipt(db, value);
    return value;
  });
  const revoke = changeDecision(issue, "revoke", "revoke:1", randomUUID());
  revoke.time = (await pool.query(`SELECT to_char($1::timestamptz AT TIME ZONE 'UTC' + interval '1 second',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`, [issue.time])).rows[0].value;
  const publisher = await pool.connect();
  try {
    await publisher.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await publisher.query("SELECT revision FROM public.catalog_draft_heads WHERE draft_id=$1", [issue.draftId]);
    await transaction(pool, db => insertDecision(db, revoke));
    await insertGraph(publisher, { ...issue, time: revoke.time }, { reuseApproval: true });
    await expect(publisher.query("COMMIT")).rejects.toMatchObject(isolation === "REPEATABLE READ"
      ? { code: "40001" } : { code: "23514", constraint: "catalog_publication_approval_missing" });
  } finally {
    await publisher.query("ROLLBACK");
    publisher.release();
  }
});

it("refuses retargeting and consuming a pointer authorization in its original transaction", async () => {
  const { issued, legacy } = await transaction(pool, async db => {
    const issued = await graph(db, fixture()), legacy = await graph(db, fixture());
    await insertGraph(db, issued);
    await documentRow(db, legacy);
    return { issued, legacy };
  });
  const alternate = randomUUID();
  await pool.query(`INSERT INTO public.catalog_product_document_revisions
    (id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest)
    VALUES($1,$2,2,'example:legacy','example:other','{}','example:other','{}',$3)`, [alternate, issued.productId, hash("alternate")]);
  const error = await transaction(pool, async db => {
    await db.query("INSERT INTO public.catalog_publication_pointer_capabilities VALUES(pg_current_xact_id(),$1,$2,$3)",
      [legacy.productId, legacy.documentId, issued.fingerprint]);
    await db.query("UPDATE public.catalog_publication_pointer_capabilities SET product_id=$1,revision_id=$2 WHERE product_id=$3",
      [issued.productId, alternate, legacy.productId]);
    await db.query("UPDATE public.catalog_products SET current_document_revision_id=$2 WHERE id=$1", [issued.productId, alternate]);
  }).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_content_not_saved" });
  expect((await pool.query("SELECT current_document_revision_id AS id FROM public.catalog_products WHERE id=$1", [issued.productId])).rows)
    .toEqual([{ id: issued.documentId }]);
});

it.each([
  ["product", "UPDATE public.catalog_products SET name='Drift' WHERE id=$1", "productId"],
  ["SKU", "UPDATE public.catalog_skus SET title='Drift' WHERE id=$1", "skuId"],
  ["SKU net weight", "UPDATE public.catalog_skus SET net_weight_g=200 WHERE id=$1", "skuId"],
] as const)("refuses live %s drift before the publication commits", async (_label, update, key) => {
  const error = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    await insertGraph(db, issue);
    await db.query(update, [issue[key]]);
  }).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_changed" });
});

it.each([
  ["escaped null product string", { rawState: (value: string) => value.replace('"Article"', '"\\u0000"') }, "publication_details_invalid"],
  ["escaped null SKU string", { rawFacts: (value: string) => value.replace('"Article"', '"\\u0000"') }, "publication_revision_invalid"],
  ["deeply nested product bytes", { rawState: (value: string) => `{"extra":${"[".repeat(30_000)}0${"]".repeat(30_000)},${value.slice(1)}` }, "publication_details_invalid"],
  ["deeply nested SKU bytes", { rawFacts: (value: string) => `{"extra":${"[".repeat(30_000)}0${"]".repeat(30_000)},${value.slice(1)}` }, "publication_revision_invalid"],
] as const)("returns a typed COMMIT refusal for %s", async (_label, options, reason) => {
  const error = await transaction(pool, async db => insertGraph(db, await graph(db, fixture()), options)).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason });
});

function publicationReader() {
  return createPostgresCatalogPublicationReads({
    transactions: { run: work => transaction(pool, work) },
    authorizeHuman: async () => ({ ok: false }),
  });
}

function changeDecision(value: Graph, action: "approve" | "revoke", key: string, id: Graph["approvalId"]): Graph {
  return { ...value, approvalId: id, decisionKey: key,
    decision: { ...value.decision, action, commandKey: key, reason: action === "revoke" ? "Approval withdrawn" : null } };
}
async function insertDecision(db: Parameters<typeof decisionRow>[0], value: Graph) {
  await decisionReceipt(db, value);
  await decisionRow(db, value);
}

it("binds issuance to the pre-product decision sequence and its exact active approval", async () => {
  const data = fixture();
  const original = await transaction(pool, db => graph(db, data, null, false));
  const approve = changeDecision(original, "approve", "first-approval", "11111111-1111-4111-8111-111111111111");
  const revoke = changeDecision(original, "revoke", "next-revocation", "22222222-2222-4222-8222-222222222222");
  const reapprove = changeDecision(original, "approve", "new-approval", "33333333-3333-4333-8333-333333333333");
  await expect(transaction(pool, db => insertDecision(db, revoke))).rejects.toMatchObject({ constraint: "catalog_publication_approval_missing" });
  await transaction(pool, db => insertDecision(db, approve));
  await expect(transaction(pool, db => insertDecision(db, reapprove))).rejects.toMatchObject({ constraint: "catalog_publication_approval_wrong" });
  await transaction(pool, async db => {
    // One instant, ordered by ID even when restore stages the rows in reverse.
    await insertDecision(db, reapprove);
    await insertDecision(db, revoke);
  });
  expect((await pool.query("SELECT id FROM public.catalog_products WHERE id=$1", [data.productId])).rowCount).toBe(0);
  await transaction(pool, db => stageProductRows(db, data));
  await expect(transaction(pool, db => insertGraph(db, approve, { reuseApproval: true })))
    .rejects.toMatchObject({ constraint: "catalog_publication_approval_wrong" });
  const saved = await transaction(pool, db => insertGraph(db, reapprove, { reuseApproval: true }));
  expect(saved.head).toEqual(original.head);
  expect(await publicationReader().readbackV2(original.head)).toMatchObject({ outcome: "page", product: { name: "Article" } });
});

it("refuses a rehashed first issue and matching live product with a name outside its approval", async () => {
  const error = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    const approval = sealedState(issue.product, [{ skuId: issue.skuId, digest: hash(json(issue.facts)) }]);
    issue.product.name = "Different title";
    await db.query("UPDATE public.catalog_products SET name=$2 WHERE id=$1", [issue.productId, issue.product.name]);
    await insertGraph(db, issue, { approvedState: approval });
  }).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_post_state_changed", message: expect.stringContaining("Prepare") });
});

const protectedTables = {
  catalog_publications: "id", catalog_sku_revisions: "id", catalog_publication_heads: "product_id",
  catalog_operator_receipts: "scope_id", catalog_publication_decisions: "id", catalog_publication_pointer_capabilities: "product_id",
} as const;
it.each(["admin-managed", "admin-operator"] as const)("denies runtime writes to all six publication relations in %s", async mode => {
  const store = await installOmsHuman(mode);
  try {
    await installPublicationActors(store.owner);
    const { issue, saved } = await transaction(store.owner, async db => {
      const issue = await graph(db, fixture());
      const saved = await insertGraph(db, issue);
      await insertDecision(db, await graph(db, fixture(), null, false));
      return { issue, saved };
    });
    const { rows: roles } = await store.runtime.query<{ role: string }>(`SELECT rolname AS role FROM pg_roles
      WHERE rolname=current_user OR pg_has_role(current_user,oid,'SET') OR rolname IN ('anon','authenticated','service_role')
      ORDER BY rolname`);
    expect(roles.map(row => row.role)).toEqual(expect.arrayContaining(["oms_r", "anon", "authenticated", "service_role", "platform_acquisition_runtime"]));
    for (const { role } of roles) {
      expect(role).toMatch(/^[a-z_][a-z0-9_]*$/u);
      await transaction(store.runtime, async db => {
        await db.query(`SET LOCAL ROLE "${role}"`);
        for (const [name, key] of Object.entries(protectedTables)) {
          const relation = `public.${name}`;
          const rights = (await db.query(`SELECT
            has_table_privilege($1,'INSERT,UPDATE,DELETE,TRUNCATE') AS table_write,
            has_any_column_privilege($1,'INSERT,UPDATE') AS column_write`, [relation])).rows[0];
          expect(rights).toEqual({ table_write: false, column_write: false });
          for (const statement of [`INSERT INTO ${relation} DEFAULT VALUES`, `UPDATE ${relation} SET ${key}=${key}`,
            `DELETE FROM ${relation}`, `TRUNCATE ${relation}`, `TRUNCATE ${relation} CASCADE`]) {
            await db.query("SAVEPOINT denied_write");
            await expect(db.query(statement), `${role} ${statement}`).rejects.toMatchObject({ code: "42501" });
            await db.query("ROLLBACK TO SAVEPOINT denied_write");
            await db.query("RELEASE SAVEPOINT denied_write");
          }
        }
        for (const suffix of ["", " CASCADE"]) {
          await db.query("SAVEPOINT denied_group");
          await expect(db.query("TRUNCATE public.catalog_publication_decisions, public.catalog_operator_receipts" + suffix))
            .rejects.toMatchObject({ code: "42501" });
          await db.query("ROLLBACK TO SAVEPOINT denied_group");
          await db.query("RELEASE SAVEPOINT denied_group");
        }
      });
    }
    expect((await store.owner.query("SELECT count(*)::int AS count FROM public.catalog_publication_decisions")).rows[0]).toEqual({ count: 2 });
    const reader = createPostgresCatalogPublicationReads({
      transactions: { run: work => transaction(store.owner, work) },
      authorizeHuman: async () => ({ ok: true, userId: actorId, role: "admin", isMachineActor: false }),
    });
    expect(await reader.reads.current(issue.productId)).toMatchObject({ outcome: "found", head: issue.head });
    await expect(reader.receipt({ productId: issue.productId, commandKey: issue.commandKey }, (await reader.authorize(null))!))
      .resolves.toEqual({ outcome: "found", receipt: saved });
    expect((await reader.readbackV2(issue.head)).outcome).toBe("page");
    const packet = await captureConnectedNativeStore({ sourceId: mode, catalogueId: store.inventory,
      maximumRows: 10_000, maximumBytes: 64 * 1024 * 1024,
      source: { withSnapshot: work => transaction(store.owner, async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return work({ query: (sql, values) => db.query(sql, values ? [...values] : undefined) });
      }) } });
    expect(packet.owned.find(table => table.table === "catalog_publication_decisions")?.rows).toHaveLength(2);
  } finally { await store.close(); }
}, 120_000);

it.each(["object", "serialized", "nested"] as const)("refuses a %s document carrier in retained SKU facts", async placement => {
  const error = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    const original = JSON.parse(issue.canonicalText);
    issue.facts.facts = placement === "nested" ? { summary: [{ payload: { canonicalText: issue.canonicalText } }] }
      : { document: placement === "object" ? original : issue.canonicalText };
    await insertGraph(db, issue);
  }).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_facts_invalid",
    message: expect.stringMatching(/Remove reserved document keys.*document only in its designated draft field/u) });
});

it("refuses a document carrier in the existing published SKU attributes field", async () => {
  const error = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    issue.facts.attributes = { document_payload: JSON.parse(issue.canonicalText) };
    await insertGraph(db, issue);
  }).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_facts_invalid",
    message: expect.stringMatching(/Remove reserved document keys.*document only in its designated draft field/u) });
});

it("uses the same depth 48 boundary for SQL admission and the TypeScript detail page", async () => {
  const { rows: [{ max_depth: maxDepth } = {}] } = await pool.query<{ max_depth: number }>(
    "SELECT public.catalog_publication_max_depth() AS max_depth",
  );
  expect(maxDepth).toBe(48);
  const containerAt = (depth: number, terminal: CatalogPublicationJson) =>
    Array.from({ length: depth - 5 }).reduce<CatalogPublicationJson>(child => [child], terminal);
  const detail = (depth: number) => ({ array: containerAt(depth, []), object: containerAt(depth, {}) });
  const head = await transaction(pool, async db => {
    const issue = await graph(db, fixture());
    issue.facts.facts = detail(48);
    await insertGraph(db, issue);
    return issue.head;
  });
  const page = await publicationReader().readbackV2(head);
  if (page.outcome !== "page") throw new Error(page.reason);
  expect(page.items[0]?.facts.facts).toEqual(detail(48));
  expect(() => publicationJson(page)).not.toThrow();
  const items = page.items.map(item => ({ ...item, facts: { ...item.facts, facts: detail(49) } }));
  expect(() => publicationJson({ ...page, items })).toThrow("draft_json_depth");

  const tooDeep = fixture();
  let staged = false;
  const refused = await transaction(pool, async db => {
    const issue = await graph(db, tooDeep);
    issue.facts.facts = detail(49);
    await insertGraph(db, issue);
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  expect(catalogPublicationAdmissionRefusal(refused)).toMatchObject({ reason: "publication_revision_invalid" });
  expect((await pool.query("SELECT id FROM public.catalog_products WHERE id=$1", [tooDeep.productId])).rows).toEqual([]);
});

it.each(["0001-01-01T00:00:00.000000Z", "9999-12-31T23:59:59.999999Z"])("admits UTC boundary %s for both timestamps", async time => {
  const issue = await transaction(pool, async db => {
    const staged = await graph(db, fixture());
    const issue = { ...staged, time };
    await insertGraph(db, issue);
    return issue;
  });
  const reader = createPostgresCatalogPublicationReads({ transactions: { run: work => transaction(pool, work) },
    authorizeHuman: async () => ({ ok: true, userId: actorId, role: "admin", isMachineActor: false }) });
  expect(await reader.receipt({ productId: issue.productId, commandKey: issue.commandKey }, (await reader.authorize(null))!))
    .toMatchObject({ outcome: "found", receipt: { committedAt: time } });
});

it.each(["10000-01-01T00:00:00Z", "0001-01-01 00:00:00+00 BC", "infinity"])("refuses %s at each named timestamp check", async time => {
  await expect(transaction(pool, async db => insertGraph(db, { ...await graph(db, fixture()), time })))
    .rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_committed_at_valid" });
  await expect(transaction(pool, async db => insertDecision(db, { ...await graph(db, fixture(), null, false), time })))
    .rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_decided_at_valid" });
});

it.each(["child-first", "parent-first"] as const)("types malformed publish receipt at COMMIT in %s order", async order => {
  const data = fixture();
  let staged = false;
  const error = await transaction(pool, async db => {
    await insertGraph(db, await graph(db, data), {
      ...(order === "child-first" ? { order } : {}), receiptResult: invalidReceiptResults["escaped NUL"],
    });
    staged = true;
  }).catch(error => error);
  expect(staged).toBe(true);
  expect(error).toMatchObject({ code: "23514", constraint: "catalog_publication_receipt_input_invalid" });
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_receipt_input_invalid" });
  expect((await pool.query("SELECT 1 FROM public.catalog_publications WHERE product_id=$1", [data.productId])).rows).toEqual([]);
});

it.each([["approve", "{'bad':true}"], ["revoke", '{"value":1e999999}']] as const)(
  "types malformed %s receipt bytes when making constraints immediate", async (kind, result) => {
    let staged = false;
    await expect(transaction(pool, async db => {
      await db.query("INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,result) VALUES($1,$2,'test',$3,$4,$5)",
        [kind, randomUUID(), hash("test"), actorId, result]);
      staged = true;
      await db.query("SET CONSTRAINTS catalog_receipts_issued IMMEDIATE");
    })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_receipt_input_invalid" });
    expect(staged).toBe(true);
  },
);

it("matches the shared publication boundary vectors in native SQL", async () => {
  const issue = await transaction(pool, db => graph(db, fixture()));
  for (const vector of publicationWireVectors) {
    const value = vector.apply(issue.facts);
    const jsonText = JSON.stringify(value);
    if (vector.targetBytes !== undefined) expect(Buffer.byteLength(jsonText), vector.name).toBe(vector.targetBytes);
    const probe = (body: string) => pool.query<{ canonical: string }>(
      "SELECT public.catalog_publication_sku_projection($1,$2,$3,$4::jsonb,false) AS canonical",
      [issue.skuId, issue.productId, issue.facts.code, body],
    );
    if (vector.valid) {
      const { rows } = await probe(jsonText);
      expect(rows[0]?.canonical, vector.name).toBe(publicationJson(value, CATALOG_PUBLICATION_LIMITS.skuBytes, SKU_PAGE_DEPTH));
      expect(() => publicationJson({ items: [{ facts: value }] }), vector.name).not.toThrow();
    } else if (vector.sqlNormalizesZero) {
      const { rows } = await probe(jsonText.replace('"zero":0', '"zero":-0'));
      expect(rows[0]?.canonical).toBe(publicationJson(JSON.parse(jsonText), CATALOG_PUBLICATION_LIMITS.skuBytes, SKU_PAGE_DEPTH));
    } else if (vector.targetBytes !== undefined) {
      await expect(probe(jsonText), vector.name).rejects.toMatchObject({ constraint: "catalog_publication_sku_revision_invalid" });
    } else {
      await expect(probe(jsonText), vector.name).rejects.toThrow();
    }
  }
});

it.each([
  ["invalid binding", "{}", "catalog_publication_receipt_invalid", "publication_incomplete"],
  ["invalid bytes", invalidReceiptResults["escaped NUL"], "catalog_publication_receipt_input_invalid", "publication_receipt_input_invalid"],
])("shares the %s receipt remedy between exact V2 reads and rollback", async (_label, result, constraint, reason) => {
  const issue = await transaction(pool, async db => {
    const result = await graph(db, fixture());
    await insertGraph(db, result);
    return result;
  });
  const { rows: [original] } = await pool.query<{ result: string }>(
    "SELECT result FROM public.catalog_operator_receipts WHERE scope_id=$1 AND kind='publish'", [issue.productId]);
  const replace = (value: string) => transaction(pool, async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("UPDATE public.catalog_operator_receipts SET result=$2 WHERE scope_id=$1 AND kind='publish'", [issue.productId, value]);
  });
  await replace(result);
  try {
    const reader = publicationReader();
    const rollback = catalogPublicationAdmissionRefusal({ code: "23514", constraint });
    expect(rollback?.reason).toBe(reason);
    const exact = await reader.readbackV2(issue.head);
    expect(exact).toEqual({ ...rollback, outcome: "dependency_unavailable" });
    if (constraint === "catalog_publication_receipt_input_invalid")
      expect(exact).toMatchObject({ message: expect.stringContaining("Restore the original result from a verified copy") });
    expect(await reader.reads.readback(issue.head)).toMatchObject({ reason: "publication_authority_unavailable" });
  } finally { await replace(original!.result); }
});

it.each([
  ["unchanged cache", ""],
  ["matching cache", ", publication_facts=jsonb_set(publication_facts,'{code}',to_jsonb($2::text))"],
  ["cleared cache", ", publication_facts=NULL"],
])("compares a live SKU rename with its sealed code with %s", async (_label, change) => {
  const issue = await transaction(pool, async db => {
    const result = await graph(db, fixture());
    await insertGraph(db, result);
    return result;
  });
  await transaction(pool, async db => {
    // Only the column-only variant requires bypassing the live row trigger.
    if (!change) await db.query("SET LOCAL session_replication_role=replica");
    await db.query(`UPDATE public.catalog_skus SET sku=$2${change} WHERE id=$1`, [issue.skuId, `renamed-${issue.skuId}`]);
  });
  try {
    const reader = publicationReader();
    const message = "A SKU code differs from its published identity. Restore the saved code or prepare a new SKU.";
    expect(await reader.reads.current(issue.productId)).toEqual({ outcome: "conflict", reason: "head_conflict", message });
    const failure = await transaction(pool, assertConnectedCatalogPublications).catch(error => error);
    expect(catalogPublicationAdmissionRefusal(failure)).toMatchObject({ reason: "publication_sku_identity_changed", message });
    expect(await reader.readbackV2(issue.head)).toMatchObject({ outcome: "page", items: [{ facts: { code: issue.facts.code } }] });
  } finally {
    await transaction(pool, async db => {
      await db.query("UPDATE public.catalog_skus SET sku=$2, publication_facts=$3 WHERE id=$1", [issue.skuId, issue.facts.code, json(issue.facts)]);
    });
  }
});

async function referencesFor(head: Graph["head"]) {
  return (JSON.parse((await pool.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [head.publicationId]))
    .rows[0].canonical_state) as CatalogPublicationManifestV2).skus;
}
// Run the 10,000-SKU stress test last so earlier whole-DB checks (assertConnectedCatalogPublications) do not scan its leftover SKUs.
// Temporary 600 s bound: on slower hosted runners this case exceeds 240 s, although it takes about 25 s locally.
// Most of its time is canonical JSON key ordering during publication admission at COMMIT. Restore 240_000 when
// the faster canonical JSON path for publication admission lands.
it("admits the maximum inherited observation roster and refuses one more SKU", async () => {
  const data = { ...fixture(), skuCode: randomUUID().padEnd(160, "x") };
  const first = await transaction(pool, async db => {
    const issue = await graph(db, data);
    issue.facts.status = "archived";
    await insertGraph(db, issue, { extraSkuCount: 9_998, maxCodes: true });
    return issue;
  });
  const inherited = await referencesFor(first.head);
  const latest = await transaction(pool, async db => {
    const issue = await graph(db, data, first.head);
    issue.facts.status = "archived";
    await insertGraph(db, issue, { inherited, onlyNew: true, extraSkuCount: 1, maxCodes: true });
    return issue;
  });
  const reader = publicationReader();
  const current = await reader.reads.current(data.productId);
  expect(current.outcome).toBe("found");
  if (current.outcome !== "found") throw Error("No maximum roster returned");
  expect(current.observations).toHaveLength(10_000);
  expect(current.observations.every(item => item.sku.length === 160 && item.state === "withdrawn")).toBe(true);
  const maxRevision = 2_147_483_647;
  const maxHead = { ...current.head, revision: maxRevision };
  const maxWire = { ...current, head: maxHead, documentRef: String.fromCharCode(1).repeat(240),
    observations: current.observations.map(item => ({ ...item, variantRevision: maxRevision, publicationHead: maxHead,
      draftRef: { ...item.draftRef!, revision: maxRevision } })) };
  expect(Buffer.byteLength(json(maxWire))).toBeLessThan(CATALOG_PUBLICATION_LIMITS.pageBytes);
  expect(await reader.reads.readback(latest.head)).toEqual(current);
  expect(await reader.readbackV2(latest.head)).toMatchObject({ outcome: "page",
    items: [{ reference: { skuId: current.observations[0]!.variantId } }, ...Array.from({ length: 99 }, () => expect.any(Object))] });
  const atLimit = await referencesFor(latest.head);
  const error = await transaction(pool, async db => insertGraph(db, await graph(db, data, latest.head),
    { inherited: atLimit, onlyNew: true, extraSkuCount: 1, maxCodes: true })).catch(error => error);
  expect(catalogPublicationAdmissionRefusal(error)).toMatchObject({ reason: "publication_roster_limit" });
  const replacement = await transaction(pool, async db => {
    const issue = await graph(db, data, latest.head);
    await insertGraph(db, issue, { inherited: atLimit, skuRevision: 2 });
    return issue;
  });
  expect(await reader.reads.current(data.productId)).toMatchObject({ outcome: "found", head: replacement.head });
}, 600_000);
