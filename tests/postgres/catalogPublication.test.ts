import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { catalogPublicationAdmissionRefusal, createPostgresCatalogPublicationReads } from "../../server/adapters/postgres/catalogPublicationReads.js";
import { actorId, hash, json, installPublicationActors, transaction, fixture, graph, insertGraph, decisionRow,
  decisionReceipt, documentRow, skuRow } from "./catalogPublicationFixture.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const migration = "db/platform/migrations/20261123150000_catalog_publication.sql";
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
  await pool.query(readFileSync(migration, "utf8"));
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
    value.decisionFingerprint = hash(json([value.decision, actorId]));
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
  expect(await readers.readbackV2(issued.first.head)).toMatchObject({ outcome: "page", head: issued.first.head, items: [{ facts: { title: "Article 1" } }] });
  expect(await readers.receipt({ productId: data.productId, commandKey: issued.first.commandKey }, admin)).toEqual({ outcome: "found", receipt: issued.receipt });
  expect(await readers.reads.history(data.productId, null)).toMatchObject({ outcome: "page", receipts: [{ head: issued.second.head }, { head: issued.first.head }] });
  for (const kind of ["account", "order", "fulfilment"] as const) {
    const binding = { kind, sourceId: randomUUID(), lineId: randomUUID(), productId: data.productId, skuId: data.skuId,
      skuRevisionId: issued.first.skuRevisionId, publicationId: issued.first.issueId, documentRevisionId: data.documentId };
    expect(await readers.resolveRetained(binding, readers.authorizeReadScope("owner"))).toMatchObject({ outcome: "found", head: issued.first.head, sku: { title: "Article 1" } });
    expect(await readers.resolveRetained(binding, readers.authorizeReadScope("other"))).toEqual({ outcome: "unauthorized", reason: "retained_read_not_authorized" });
  }
  await pool.query("UPDATE public.catalog_products SET name='Later draft name' WHERE id=$1", [data.productId]);
  expect(await readers.reads.current(data.productId)).toEqual({ outcome: "conflict", reason: "head_conflict" });
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
    .toEqual({ outcome: "validation_issue", reason: "catalog_publication_query_invalid" });
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

it("refuses an owner truncation that would reopen an issued SKU slot", async () => {
  const issue = await transaction(pool, async db => {
    const value = await graph(db, fixture());
    await insertGraph(db, value);
    return value;
  });
  await expect(transaction(pool, async db => {
    await db.query("TRUNCATE public.catalog_sku_revisions");
    throw Error("Truncation was accepted");
  })).rejects.toMatchObject({ code: "0A000", detail: expect.stringContaining("catalog_publications") });
  expect((await publicationReader().readbackV2(issue.head)).outcome).toBe("page");
});

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
    const decisionKey = "revoke:1";
    const decision = { ...issue.decision, commandKey: decisionKey, action: "revoke" as const, reason: "Approval withdrawn" };
    const revoked = { ...issue, approvalId: randomUUID(), decisionKey, decision, decisionFingerprint: hash(json([decision, actorId])), time: times.revoked };
    await decisionReceipt(db, revoked);
    await decisionRow(db, revoked);
    await insertGraph(db, { ...issue, time: times.committed }, { approvalTime: issue.time });
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_candidate_invalid" });
  await transaction(pool, async db => insertGraph(db, await graph(db, data)));
});

it("refuses a backdated revocation that would change a saved publication's approval", async () => {
  const issue = await transaction(pool, async db => {
    const value = await graph(db, fixture());
    await insertGraph(db, value);
    return value;
  });
  const decisionKey = "revoke:1";
  const decision = { ...issue.decision, commandKey: decisionKey, action: "revoke" as const, reason: "Approval withdrawn" };
  const revoke = { ...issue, approvalId: randomUUID(), decisionKey, decision, decisionFingerprint: hash(json([decision, actorId])) };
  await expect(transaction(pool, async db => {
    await decisionReceipt(db, revoke);
    await decisionRow(db, revoke);
  })).rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_candidate_invalid" });
  expect((await publicationReader().readbackV2(issue.head)).outcome).toBe("page");
});

it("cannot issue against an approval snapshot taken before a concurrent revocation", async () => {
  const issue = await transaction(pool, db => graph(db, fixture()));
  const decisionKey = "revoke:1";
  const decision = { ...issue.decision, commandKey: decisionKey, action: "revoke" as const, reason: "Approval withdrawn" };
  const revoke = { ...issue, approvalId: randomUUID(), decisionKey, decision, decisionFingerprint: hash(json([decision, actorId])) };
  const publisher = await pool.connect();
  try {
    await publisher.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await publisher.query("SELECT revision FROM public.catalog_draft_heads WHERE draft_id=$1", [issue.draftId]);
    await transaction(pool, async db => {
      await decisionReceipt(db, revoke);
      await decisionRow(db, revoke);
    });
    await insertGraph(publisher, issue);
    await expect(publisher.query("COMMIT")).rejects.toMatchObject({ code: "40001" });
  } finally {
    await publisher.query("ROLLBACK");
    publisher.release();
  }
});

function publicationReader() {
  return createPostgresCatalogPublicationReads({
    transactions: { run: work => transaction(pool, work) },
    authorizeHuman: async () => ({ ok: false }),
  });
}
