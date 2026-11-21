import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readPostgresCatalogMembershipPage, type CatalogMembershipPageInput } from "@openlup/platform/catalog";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { catalogueReadGrant, documentRow, fixture, graph, hash, insertGraph, installCatalogueReadGrants, installPublicationActors, json, membershipSignature,
  publicationDocuments, publicFunctionGrants, stageProductRows, transaction, type Graph } from "./catalogPublicationFixture.js";

const forward = "db/platform/migrations/20261124190000_catalog_quantity_serving.sql";
const membershipSql = "SELECT public.catalog_offer_memberships_page($1,$2::jsonb,$3,$4) AS result";
const filterOffer = "test:filter";
const emptyOffer = "test:known-empty";
let container: PostgresContainer, pool: Pool;

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-discovery-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue discovery requires PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  await pool.query("CREATE ROLE service_role; CREATE ROLE unrelated LOGIN");
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { baseline: { file: string }; forward: { file: string }[] };
  const position = manifest.forward.findIndex(unit => unit.file === forward);
  expect(position).toBeGreaterThan(0);
  const prefix = [manifest.baseline, ...manifest.forward.slice(0, position)];
  for (const { file } of prefix) {
    if (file === catalogueReadGrant) await installCatalogueReadGrants(pool);
    else await pool.query(readFileSync(file, "utf8"));
  }
  await pool.query(readFileSync(forward, "utf8"));
  await installPublicationActors(pool);
  await pool.query("CREATE TABLE public.membership_serialization_witness(id int PRIMARY KEY, value int); INSERT INTO public.membership_serialization_witness VALUES (1,0),(2,0)");
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

const fixedId = (index: number): ReturnType<typeof randomUUID> => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const byOffer = (offerVersion: string, mode: CatalogMembershipPageInput["mode"] = null) => ({ offerVersion, mode, limit: 1 });
async function headDigest() {
  return (await pool.query("SELECT public.catalog_publication_read_head()->>'headDigest' AS digest")).rows[0]!.digest as string;
}
async function page(input: CatalogMembershipPageInput, db: Pool | PoolClient = pool) {
  const value = await readPostgresCatalogMembershipPage(db, input);
  if ("outcome" in value) throw new Error(value.reason);
  return value;
}

async function seed(db: PoolClient, options: {
  code?: string; id?: ReturnType<typeof randomUUID>; offer?: string; admitted?: boolean; productActive?: boolean; skuActive?: boolean;
  oneTime?: boolean; subscription?: boolean; documentText?: string; registrationText?: string | Record<string, never>; extraSkuCount?: number; typedVolume?: boolean;
} = {}) {
  const issue = await graph(db, { ...fixture(), ...(options.id ? { skuId: options.id } : {}), skuCode: options.code }, null, true, { documentText: options.documentText, registrationText: options.registrationText });
  issue.product.status = options.productActive === false ? "draft" : "active";
  issue.facts.status = options.skuActive === false ? "draft" : "active";
  issue.facts.sellableStandalone = options.oneTime ?? true;
  issue.facts.sellableInSubscription = options.subscription ?? true;
  if (options.typedVolume) {
    issue.facts.netContent = { dimension: "volume", unit: "openlup:ml", unscaled: "50", scale: 0 };
    issue.facts.grossMass = { dimension: "mass", unit: "openlup:g", unscaled: "70", scale: 0 };
  }
  issue.facts.memberships = [{ offerVersion: options.offer ?? filterOffer, admitted: options.admitted ?? true }];
  await db.query("UPDATE public.catalog_products SET status=$2 WHERE id=$1", [issue.productId, issue.product.status]);
  await insertGraph(db, issue, { extraSkuCount: options.extraSkuCount, exactQuantity: options.typedVolume });
  return issue;
}

it("distinguishes legacy, governed empty and unreadable authority, and refuses unknown offers and old heads", async () => {
  await transaction(pool, db => stageProductRows(db, fixture()));
  await transaction(pool, async db => {
    const legacy = fixture();
    await db.query("SAVEPOINT orphan");
    await stageProductRows(db, legacy);
    await db.query("UPDATE public.catalog_skus SET publication_facts='{}' WHERE id=$1", [legacy.skuId]);
    expect((await db.query(membershipSql, [emptyOffer, null, 1, null])).rows[0]?.result)
      .toEqual({ kind: "refusal", reason: "inconsistent_evidence" });
    await db.query("ROLLBACK TO SAVEPOINT orphan");
  });
  expect(await page(byOffer(emptyOffer))).toEqual({ protocol: "legacy", headDigest: null, items: [], nextCursor: null });
  const legacyCursor = { skuId: fixedId(1), headDigest: "f".repeat(64), mode: null, offerVersion: emptyOffer };
  expect(await readPostgresCatalogMembershipPage(pool, { ...byOffer(emptyOffer), cursor: legacyCursor }))
    .toEqual({ outcome: "conflict", reason: "catalog_publication_head_moved", retryable: true });
  const denied = await transaction(pool, db => seed(db, { offer: emptyOffer, admitted: false }));
  expect(await page(byOffer(emptyOffer))).toEqual({ protocol: "governed", headDigest: await headDigest(), items: [], nextCursor: null });
  expect(await readPostgresCatalogMembershipPage(pool, byOffer("test:unknown"))).toMatchObject({ outcome: "validation_issue" });
  await transaction(pool, async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [denied.productId]);
    expect(await readPostgresCatalogMembershipPage(db, byOffer(emptyOffer))).toMatchObject({ outcome: "dependency_unavailable" });
    expect((await db.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    await db.query("ROLLBACK");
  });
  const staleOffer = "test:stale";
  await transaction(pool, async db => {
    await seed(db, { offer: staleOffer });
    await seed(db, { offer: staleOffer });
  });
  const previous = await page(byOffer(staleOffer));
  expect(previous.nextCursor).not.toBeNull();
  await transaction(pool, db => seed(db, { offer: "test:other-product" }));
  await transaction(pool, async db => {
    expect((await db.query(membershipSql, [staleOffer, previous.nextCursor, 1, null])).rows[0]?.result)
      .toEqual({ kind: "refusal", reason: "head_moved" });
    expect(await readPostgresCatalogMembershipPage(db, { ...byOffer(staleOffer), cursor: previous.nextCursor }))
      .toEqual({ outcome: "conflict", reason: "catalog_publication_head_moved", retryable: true });
    expect((await db.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
  });
});

it("preserves the caller savepoint and an acknowledged concurrent command after an unknown offer", async () => {
  await transaction(pool, db => seed(db, { offer: "test:registered" }));
  const calls = await transaction(pool, async db => {
    await db.query("SAVEPOINT caller_membership");
    let pause!: () => void, dispatch!: () => void;
    const paused = new Promise<void>(resolve => { pause = resolve; });
    const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql.startsWith("SELECT")) {
        pause();
        await dispatched;
      }
      return db.query(sql, args);
    });
    const read = readPostgresCatalogMembershipPage({ query }, byOffer("test:unknown"));
    await paused;
    try {
      const insert = await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES ('membership_caller_witness','retained')");
      expect(insert.rowCount).toBe(1);
    } finally {
      dispatch();
    }
    await expect(read).resolves.toMatchObject({ outcome: "validation_issue" });
    await db.query("RELEASE SAVEPOINT caller_membership");
    return query.mock.calls;
  });
  expect((await pool.query("SELECT value_text FROM public.commerce_settings WHERE key='membership_caller_witness'")).rows)
    .toEqual([{ value_text: "retained" }]);
  expect(calls).toEqual([["SELECT public.catalog_offer_memberships_page($1,$2,$3,$4) AS result", ["test:unknown", null, 1, null]]]);
});

it("filters before limit for each mode and resolves evidence only for emitted rows", async () => {
  await transaction(pool, async db => {
    await seed(db, { id: fixedId(1), admitted: false });
    await seed(db, { id: fixedId(2), productActive: false });
    await seed(db, { id: fixedId(3), skuActive: false });
    await seed(db, { id: fixedId(4), oneTime: false });
    await seed(db, { id: fixedId(5), subscription: false });
    await seed(db, { id: fixedId(6) });
    await seed(db, { id: fixedId(7) });
  });
  await transaction(pool, async db => {
    await db.query("SET LOCAL track_functions='pl'");
    for (const [mode, first] of [["one_time", 5], ["subscription", 4], [null, 4]] as const) {
      const query = byOffer(filterOffer, mode);
      const firstPage = await page(query, db);
      expect(firstPage.items.map(item => item.skuId)).toEqual([fixedId(first)]);
      expect(firstPage.nextCursor).toMatchObject({ skuId: fixedId(first), offerVersion: filterOffer, mode });
      const rest = await page({ ...query, cursor: firstPage.nextCursor, limit: 2 }, db);
      expect(rest.items.map(item => item.skuId)).toEqual([fixedId(first === 4 && mode === null ? 5 : 6),
        fixedId(first === 4 && mode === null ? 6 : 7)]);
      expect(Boolean(rest.nextCursor)).toBe(mode === null);
    }
    const lookupCount = await db.query(`SELECT calls FROM pg_stat_xact_user_functions WHERE funcname='catalog_publication_selected_evidence'`);
    expect(lookupCount.rows.map(row => Number(row.calls))).toEqual([9]);
  });
});

it.each([
  { change: "cleared", live: [] },
  { change: "denial", live: [{ offerVersion: "test:projection-denial", admitted: false }] },
  { change: "admission", live: [{ offerVersion: "test:projection-admission", admitted: true }] },
])("refuses a committed $change membership that differs from the seal", async ({ change, live }) => {
  const sealedOffer = `test:sealed-${change}`;
  const offer = live[0]?.offerVersion ?? sealedOffer;
  const input = byOffer(offer, change === "admission" ? "one_time" : null);
  const issue = await transaction(pool, db => seed(db, { offer: sealedOffer, oneTime: change !== "admission" }));
  const consistent = await page(byOffer(sealedOffer));
  expect(consistent.items.map(item => item.skuId)).toEqual([issue.skuId]);
  const update = (memberships: typeof live) => pool.query(
    "UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{memberships}',$2::jsonb) WHERE id=$1",
    [issue.skuId, json(memberships)],
  );
  await update(live);
  try {
    const drift = "catalog_publication_live_drift";
    expect(await readPostgresCatalogMembershipPage(pool, input))
      .toEqual({ outcome: "dependency_unavailable", reason: drift });
    await transaction(pool, async db => {
      expect((await db.query(membershipSql, [offer, null, 1, input.mode])).rows[0]?.result)
        .toEqual({ kind: "refusal", reason: "inconsistent_evidence", detail: drift });
      expect((await db.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    });
  } finally {
    await update([{ offerVersion: sealedOffer, admitted: true }]);
  }
  expect(await page(byOffer(sealedOffer))).toEqual(consistent);
});

it("rejects cross-offer and cross-mode cursors in adapter and SQL before authority", async () => {
  const cursorOffer = "test:cursor";
  const otherOffer = "test:cursor-other";
  await transaction(pool, async db => {
    await seed(db, { offer: cursorOffer });
    await seed(db, { offer: cursorOffer });
    await seed(db, { offer: otherOffer });
  });
  const original = await page(byOffer(cursorOffer, "one_time"));
  expect(original.nextCursor).not.toBeNull();
  for (const [offer, mode] of [[otherOffer, "one_time"], [cursorOffer, "subscription"]] as const) {
    const db = { query: vi.fn() };
    await expect(readPostgresCatalogMembershipPage(db, { ...byOffer(offer, mode), cursor: original.nextCursor })).resolves.toMatchObject({ outcome: "validation_issue" });
    expect(db.query).not.toHaveBeenCalled();
    await transaction(pool, async client => {
      expect((await client.query(membershipSql, [offer, original.nextCursor, 1, mode])).rows[0]?.result)
        .toEqual({ kind: "refusal", reason: "invalid_request" });
      expect((await client.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    });
  }
});

async function moveDocument(db: PoolClient, first: Graph) {
  const second = await graph(db, { productId: first.productId, skuId: first.skuId, draftId: first.draftId,
    skuCode: first.facts.code, documentId: randomUUID() }, first.head, false,
    { registerExisting: true, documentText: json(publicationDocuments.second) });
  second.document.revisionNo = 2;
  second.product.status = first.product.status;
  const payload = (await db.query("SELECT payload FROM public.catalog_draft_revisions WHERE draft_id=$1 AND revision=2", [first.draftId])).rows[0]!.payload;
  payload.product.documentRevision = second.document;
  payload.publication.operations[0].revisionNo = 2;
  const fingerprint = hash(json(payload));
  second.source.fingerprint = fingerprint;
  second.candidateDigest = hash(json(["catalog-candidate", 1, payload, [{ ...second.product.type, definitionDigest: hash("synthetic installed definition") }], first.head]));
  second.decision.candidateDigest = second.candidateDigest;
  // The fixture builder uses document revision 1. Advance the saved draft to revision 2.
  await db.query("SET LOCAL session_replication_role=replica");
  await db.query("UPDATE public.catalog_draft_revisions SET payload=$2,fingerprint=$3 WHERE draft_id=$1 AND revision=2", [first.draftId, payload, fingerprint]);
  await db.query("UPDATE public.catalog_draft_command_receipts SET fingerprint=$2 WHERE draft_id=$1 AND revision=2", [first.draftId, fingerprint]);
  await db.query("SET LOCAL session_replication_role=origin");
  await documentRow(db, second);
  const inherited = { skuId: first.skuId, revisionId: first.skuRevisionId, revision: 1, digest: hash(json(first.facts)) };
  await insertGraph(db, second, { inherit: inherited, existingDocument: true });
  return { second, inherited };
}

it("binds the new issue and document to the inherited SKU revision and refuses each damaged carrier", async () => {
  const ownOffer = "test:exact";
  const [first, { second, inherited }] = await transaction(pool, async db => {
    const first = await seed(db, { offer: ownOffer });
    return [first, await moveDocument(db, first)] as const;
  });
  expect((await page(byOffer(ownOffer))).items).toMatchObject([{ head: second.head, document: second.document, skuRevision: inherited }]);
  const substituted = json({ ...first.facts, title: "Substituted article" });
  await transaction(pool, db => seed(db, { offer: ownOffer }));
  for (const [sql, args] of [
    ["UPDATE public.catalog_publications SET digest=repeat('1',64) WHERE id=$1", [second.issueId]],
    ["UPDATE public.catalog_publications SET previous_id=NULL WHERE id=$1", [second.issueId]],
    ["DELETE FROM public.catalog_operator_receipts WHERE publication_id=$1", [second.issueId]],
    [`WITH replaced AS (UPDATE public.catalog_sku_revisions SET full_facts=$2 WHERE id=$1 RETURNING sku_id)
       UPDATE public.catalog_skus s SET publication_facts=$2::text::jsonb FROM replaced WHERE s.id=replaced.sku_id`,
    [first.skuRevisionId, substituted]],
    ["UPDATE public.catalog_operator_receipts SET result=$2 WHERE publication_id=$1", [second.issueId, "[".repeat(30_000) + "0" + "]".repeat(30_000)]],
    ["UPDATE public.catalog_operator_receipts SET fingerprint=repeat('f',64) WHERE publication_id=$1", [second.issueId]],
    ["UPDATE public.catalog_operator_receipts SET result=jsonb_set(result::jsonb,'{head,revision}','12')::text WHERE publication_id=$1", [second.issueId]],
    ["UPDATE public.catalog_product_document_revisions SET document_payload='{}' WHERE id=$1", [second.documentId]],
    [`WITH replaced AS (UPDATE public.catalog_sku_revisions SET full_facts=$2,digest=$3 WHERE id=$1 RETURNING sku_id)
       UPDATE public.catalog_skus s SET publication_facts=$2::text::jsonb FROM replaced WHERE s.id=replaced.sku_id`,
    [first.skuRevisionId, substituted, hash(substituted)]],
  ] as const) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(sql, [...args]);
      expect((await client.query(membershipSql, [ownOffer, null, 100, null])).rows[0]?.result)
        .toEqual({ kind: "refusal", reason: "inconsistent_evidence" });
      expect((await client.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
  expect((await page({ ...byOffer(ownOffer), limit: 100 })).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ head: second.head, document: second.document, skuRevision: inherited }),
  ]));
});

it.each(["null", "wrong identity", "extra field"] as const)(
  "refuses a %s receipt change before deferred admission and leaves the transaction usable", async damage => {
    const offer = `test:pending-receipt-${damage}`;
    await transaction(pool, async db => {
      const issue = await seed(db, { offer });
      const { rows: [row] } = await db.query<{ result: string }>(
        "SELECT result FROM public.catalog_operator_receipts WHERE publication_id=$1", [issue.issueId]);
      const receipt = JSON.parse(row!.result);
      expect(receipt.changes).toHaveLength(1);
      const [change] = receipt.changes;
      const bad = damage === "null" ? null : damage === "wrong identity"
        ? { ...change, variantId: randomUUID() } : { ...change, extra: true };
      await db.query("SAVEPOINT damaged_receipt");
      // Keep the issue's pending checks and restore its receipt before commit.
      await db.query("SET LOCAL session_replication_role=replica");
      await db.query("UPDATE public.catalog_operator_receipts SET result=$2 WHERE publication_id=$1",
        [issue.issueId, json({ ...receipt, changes: [bad] })]);
      await db.query("SET LOCAL session_replication_role=origin");
      expect((await db.query(membershipSql, [offer, null, 1, null])).rows[0]?.result)
        .toEqual({ kind: "refusal", reason: "inconsistent_evidence" });
      expect(await readPostgresCatalogMembershipPage(db, byOffer(offer)))
        .toMatchObject({ outcome: "dependency_unavailable" });
      expect((await db.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
      await db.query("ROLLBACK TO SAVEPOINT damaged_receipt");
      expect((await page({ ...byOffer(offer), limit: 100 }, db)).items.map(item => item.skuId)).toContain(issue.skuId);
    });
  },
);

it("refuses malformed registration bytes before deferred admission and leaves the transaction usable", async () => {
  const offer = "test:pending-document";
  await transaction(pool, async db => {
    await db.query("SAVEPOINT pending_document");
    await seed(db, { offer, documentText: "{}", registrationText: {} });
    expect((await db.query(membershipSql, [offer, null, 1, null])).rows[0]?.result)
      .toEqual({ kind: "refusal", reason: "inconsistent_evidence" });
    expect((await db.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    await db.query("ROLLBACK TO SAVEPOINT pending_document");
    await seed(db, { offer, documentText: "{}", registrationText: "{}" });
    expect((await page(byOffer(offer), db)).items).toHaveLength(1);
  });
  expect((await page(byOffer(offer))).items).toHaveLength(1);
});

it("prioritizes a sealed member when a legacy row takes over its old code", async () => {
  const offer = "test:sealed-claim";
  const sealed = await transaction(pool, db => seed(db, { offer }));
  await transaction(pool, async db => {
    await db.query("SAVEPOINT takeover");
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("UPDATE public.catalog_skus SET sku=$2 WHERE id=$1", [sealed.skuId, "renamed"]);
    await stageProductRows(db, fixture(), undefined, sealed.facts.code);
    expect(await readPostgresCatalogMembershipPage(db, byOffer(offer)))
      .toMatchObject({ outcome: "dependency_unavailable", reason: "catalog_publication_live_drift" });
    await db.query("UPDATE public.catalog_skus SET publication_facts=NULL WHERE id=$1", [sealed.skuId]);
    expect((await db.query(membershipSql, [offer, null, 1, null])).rows[0]?.result)
      .toEqual({ kind: "refusal", reason: "inconsistent_evidence" });
    await db.query("ROLLBACK TO SAVEPOINT takeover");
  });
});

it("authenticates the manifest before expanding the roster or deciding an offer is unknown", async () => {
  const issue = await transaction(pool, db => seed(db, { offer: "test:roster", extraSkuCount: 1 }));
  await transaction(pool, async db => {
    await db.query("SAVEPOINT truncated");
    await db.query("SET LOCAL session_replication_role=replica");
    const current = (await db.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [issue.issueId])).rows[0]!;
    const manifest = JSON.parse(current.canonical_state);
    expect(manifest.skus).toHaveLength(2);
    const duplicate = { ...manifest, skus: [manifest.skus[0], { ...manifest.skus[1], revisionId: manifest.skus[0].revisionId }] };
    manifest.skus = manifest.skus.filter((ref: { skuId: string }) => ref.skuId === issue.skuId);
    await db.query("UPDATE public.catalog_publications SET canonical_state=$2 WHERE id=$1", [issue.issueId, json(manifest)]);
    expect((await db.query(membershipSql, ["test:missing-roster-offer", null, 1, null])).rows[0]?.result)
      .toEqual({ kind: "refusal", reason: "inconsistent_evidence" });
    await db.query("ROLLBACK TO SAVEPOINT truncated");
    await db.query("SAVEPOINT duplicate_reference");
    await db.query("SET LOCAL session_replication_role=replica");
    const bytes = json(duplicate);
    await db.query("UPDATE public.catalog_publications SET canonical_state=$2,digest=$3 WHERE id=$1", [issue.issueId, bytes, hash(bytes)]);
    expect((await db.query(membershipSql, ["test:missing-roster-offer", null, 1, null])).rows[0]?.result)
      .toEqual({ kind: "refusal", reason: "inconsistent_evidence" });
    await db.query("ROLLBACK TO SAVEPOINT duplicate_reference");
  });
});

it("refuses invalid SQL request bounds and cursor shape as values before reading authority", async () => {
  const offer = "test:bounds";
  const sealed = await transaction(pool, db => seed(db, { offer }));
  const digest = await headDigest();
  await transaction(pool, async db => {
    expect((await db.query(membershipSql, [offer, null, 100, "subscription"])).rows[0]?.result)
      .toMatchObject({ kind: "page", value: { protocol: "governed" } });
    await db.query("SAVEPOINT bad_authority");
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [sealed.productId]);
    const cursor = { skuId: sealed.skuId, headDigest: digest, offerVersion: offer, mode: null };
    const invalidArguments: unknown[][] = [
      [offer, null, 0, null], [offer, null, 101, null], [offer, null, null, null],
      ["", null, 1, null], ["x".repeat(241), null, 1, null], [" padded ", null, 1, null], [null, null, 1, null],
      [offer, null, 1, "invalid"], [offer, "[]", 1, null], [offer, { ...cursor, extra: true }, 1, null],
      [offer, { ...cursor, skuId: "not-a-uuid" }, 1, null], [offer, { ...cursor, headDigest: Number("1".repeat(64)) }, 1, null],
      [offer, { ...cursor, headDigest: "f".repeat(63) }, 1, null],
      [offer, { ...cursor, offerVersion: "test:other" }, 1, null], [offer, { ...cursor, mode: "one_time" }, 1, null],
    ];
    for (const args of invalidArguments) {
      expect((await db.query(membershipSql, args)).rows[0]?.result).toEqual({ kind: "refusal", reason: "invalid_request" });
    }
    await db.query("ROLLBACK TO SAVEPOINT bad_authority");
  });
});

const typedSignature = "public.catalog_offer_memberships_page_v2(text,jsonb,integer,text)";
const helperSignatures = [
  "public.catalog_publication_read_json(text,text,integer)",
  "public.catalog_publication_read_manifest(uuid,text,text)",
  "public.catalog_publication_read_sku_revision(uuid,jsonb)",
  "public.catalog_publication_read_head()",
  "public.catalog_publication_selected_evidence(uuid,uuid)",
];

it("grants membership execution independently of effective helper and ledger privileges", async () => {
  const offer = "test:grants";
  await transaction(pool, db => seed(db, { offer }));
  expect(await publicFunctionGrants(pool, [membershipSignature, typedSignature, ...helperSignatures])).toEqual([]);
  for (const role of ["unrelated", "anon", "authenticated", "service_role", "openlup_catalog_publication", "postgres"]) {
    const canRead = role === "service_role" || role === "openlup_catalog_publication" || role === "postgres";
    const permissions = await pool.query(`SELECT name,has_function_privilege($1::name,name,'EXECUTE') AS allowed
      FROM unnest($2::text[]) name`, [role, [membershipSignature, typedSignature, ...helperSignatures]]);
    expect(permissions.rows).toEqual([membershipSignature, typedSignature, ...helperSignatures].map(name => ({
      name, allowed: role === "postgres" || (canRead && name === membershipSignature),
    })));
    const run = transaction(pool, async db => {
      await db.query(`SET LOCAL ROLE ${role}`);
      return readPostgresCatalogMembershipPage(db, byOffer(offer));
    });
    if (canRead) await expect(run).resolves.toMatchObject({ protocol: "governed" });
    else {
      await expect(run).resolves.toEqual({ outcome: "unauthorized", reason: "catalog_publication_read_not_authorized" });
      await expect(transaction(pool, async db => {
        await db.query(`SET LOCAL ROLE ${role}`);
        await db.query(membershipSql, [offer, null, 1, null]);
      })).rejects.toMatchObject({ code: "42501" });
    }
    if (role !== "postgres" && role !== "openlup_catalog_publication") for (const table of [
      "catalog_publications", "catalog_publication_heads", "catalog_sku_revisions", "catalog_operator_receipts",
    ]) await expect(transaction(pool, async db => {
      await db.query(`SET LOCAL ROLE ${role}`);
      await db.query(`SELECT * FROM public.${table} LIMIT 1`);
    })).rejects.toMatchObject({ code: "42501" });
  }
  for (const call of [
    "catalog_publication_read_json(NULL,NULL,NULL)",
    "catalog_publication_read_manifest(NULL,NULL,NULL)",
    "catalog_publication_read_sku_revision(NULL,NULL)",
    "catalog_publication_read_head()",
    "catalog_publication_selected_evidence(NULL,NULL)",
  ]) await expect(transaction(pool, async db => {
    await db.query("SET LOCAL ROLE openlup_catalog_publication");
    await db.query(`SELECT public.${call}`);
  })).rejects.toMatchObject({ code: "42501" });
});

it("maps internal function and relation denials to dependency unavailable", async () => {
  await transaction(pool, async db => {
    for (const grant of [false, true]) {
      await db.query("SAVEPOINT denied_dependency");
      await db.query(`ALTER FUNCTION ${membershipSignature} OWNER TO unrelated`);
      await db.query("GRANT EXECUTE ON FUNCTION public.catalog_publication_text_valid(jsonb,integer,boolean) TO unrelated");
      if (grant) await db.query("GRANT EXECUTE ON FUNCTION public.catalog_publication_read_head() TO unrelated");
      await db.query("SET LOCAL ROLE service_role");
      const observed = vi.fn();
      const result = await readPostgresCatalogMembershipPage({ query: (sql, args) => db.query(sql, args).catch(error => {
        observed(error);
        throw error;
      }) }, byOffer("test:grants"));
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({
        code: "42501", message: grant ? expect.stringMatching(/^permission denied for (table|relation)/u)
          : "permission denied for function catalog_publication_read_head",
      }));
      expect(result).toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_read_unavailable" });
      await db.query("ROLLBACK TO SAVEPOINT denied_dependency");
    }
  });
});

const transactionConflict = { outcome: "conflict", reason: "catalog_publication_transaction_conflict", retryable: true };

it("preserves a PostgreSQL serialization failure at execution", async () => {
  const db = await pool.connect();
  const observed = vi.fn();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await db.query("SELECT value FROM public.membership_serialization_witness WHERE id=1");
    await pool.query("UPDATE public.membership_serialization_witness SET value=value+1 WHERE id=1");
    const execution = await readPostgresCatalogMembershipPage({ query: (sql, args) => db.query(
      `WITH touched AS MATERIALIZED (SELECT id FROM public.membership_serialization_witness WHERE id=1 FOR UPDATE)
       SELECT result FROM touched CROSS JOIN (${sql}) AS membership`, args,
    ).catch(error => { observed(error.code); throw error; }) }, byOffer("test:serialization"));
    expect(execution).toEqual(transactionConflict);
    expect(observed).toHaveBeenCalledWith("40001");
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

it("preserves a PostgreSQL serialization failure at commit", async () => {
  const read = byOffer("test:serialization-commit");
  await transaction(pool, db => seed(db, { offer: read.offerVersion }));
  const first = await pool.connect(), second = await pool.connect();
  const observed = vi.fn();
  try {
    await first.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await second.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await first.query("SELECT value FROM public.membership_serialization_witness WHERE id=2");
    await second.query("SELECT value FROM public.membership_serialization_witness WHERE id=1");
    await first.query("UPDATE public.membership_serialization_witness SET value=value+1 WHERE id=1");
    await second.query("UPDATE public.membership_serialization_witness SET value=value+1 WHERE id=2");
    const commit = await readPostgresCatalogMembershipPage({ query: async (sql, args) => {
      const value = await second.query(sql, args);
      expect(value.rows[0]?.result).toMatchObject({ kind: "page" });
      await first.query("COMMIT");
      await second.query("COMMIT").catch(error => { observed(error.code); throw error; });
      return value;
    } }, read);
    expect(commit).toEqual(transactionConflict);
    expect(observed).toHaveBeenCalledWith("40001");
  } finally {
    await Promise.all([first.query("ROLLBACK"), second.query("ROLLBACK")]);
    first.release();
    second.release();
  }
});

it("MC5 checks the SQL bridge on writes and serves scoped typed evidence only through V2", async () => {
  const offer = "test:typed";
  const issue = await transaction(pool, db => seed(db, { offer, typedVolume: true }));
  await expect(pool.query("UPDATE public.catalog_skus SET net_weight_g=50 WHERE id=$1", [issue.skuId]))
    .rejects.toMatchObject({ code: "23514", constraint: "catalog_skus_legacy_net_grams_check" });
  const typedSql = "SELECT public.catalog_offer_memberships_page_v2($1,NULL,1,'one_time') AS result";
  for (const role of ["service_role", "openlup_catalog_publication"]) {
    await transaction(pool, async db => {
      await db.query(`SET LOCAL ROLE ${role}`);
      expect(await readPostgresCatalogMembershipPage(db, byOffer(offer, "one_time")))
        .toEqual({ outcome: "validation_issue", reason: "quantity_requires_v2" });
    });
  }
  expect((await pool.query(typedSql, [offer])).rows[0]?.result).toMatchObject({ kind: "page", value: {
    protocol: "governed", items: [{ skuId: issue.skuId, netWeightG: null, netContent: issue.facts.netContent, grossMass: issue.facts.grossMass }],
  } });
  for (const role of ["unrelated", "anon", "authenticated", "service_role", "openlup_catalog_publication"]) {
    await expect(transaction(pool, async db => {
      await db.query(`SET LOCAL ROLE ${role}`);
      await db.query(typedSql, [offer]);
    })).rejects.toMatchObject({ code: "42501" });
  }
});

it("refuses a sealed gram claim that agrees with the live column but disagrees with the installed definition", async () => {
  const issue = await transaction(pool, db => seed(db, { offer: "test:forged-bridge" }));
  await expect(transaction(pool, db => db.query(`UPDATE public.catalog_skus SET
    publication_facts=jsonb_set(jsonb_set(publication_facts,'{netContent,unscaled}','"125"'),'{netWeightG}','124'),
    net_content_unscaled=125, net_weight_g=124 WHERE id=$1`, [issue.skuId])))
    .rejects.toMatchObject({ code: "23514", constraint: "catalog_publication_facts_invalid" });
});
