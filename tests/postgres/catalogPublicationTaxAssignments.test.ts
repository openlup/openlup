import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { projectPublishedCatalogOfferPage, readPostgresCatalogStorefrontPage, type CatalogSkuRevisionRef } from "@openlup/platform/catalog";
import { readPublishedSkuTaxAssignments } from "@openlup/platform/commerce/server";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { installedAcquisitionPredecessors } from "../../examples/neutral-store/host/acquisition-predecessors.ts";
import { demonstrationMarker } from "../../examples/neutral-store/host/demonstration-marker.ts";
import { createNativeQuoteService } from "../../examples/neutral-store/host/quote-composition.ts";
import { applyDemoSeed } from "../../examples/neutral-store/installation/install.ts";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { journeySelection, storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { actorId, fixture, graph, hash, insertGraph, json, stageProductRows, transaction, type Graph } from "./catalogPublicationFixture.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";

vi.mock("@openlup/platform/commerce/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@openlup/platform/commerce/server")>();
  return { ...actual, readPublishedSkuTaxAssignments: vi.fn(actual.readPublishedSkuTaxAssignments) };
});

type Request = Parameters<typeof readPublishedSkuTaxAssignments>[1];
type Pair = Request["skus"][number];
const forward = `db/platform/migrations/${readdirSync("db/platform/migrations").find(file => file.endsWith("_catalog_publication_tax_assignments.sql"))}`;
const listing = "public.catalog_publication_read_head_manifests(uuid[])";
const locator = "public.catalog_publication_locate_sku_products(uuid[])";
const projection = "public.catalog_publication_tax_assignments(jsonb)";
const listSql = "SELECT * FROM public.catalog_publication_read_head_manifests()";
const filterSql = "SELECT * FROM public.catalog_publication_read_head_manifests($1::uuid[])";
const locateSql = "SELECT * FROM public.catalog_publication_locate_sku_products($1::uuid[])";
const readSql = "SELECT public.catalog_publication_tax_assignments($1::jsonb) AS result";
const missingManifest = { code: "PCA01", message: "catalog_publication_head_manifest_missing" };
const invalidEvidence = { code: "PCA03", message: "catalog_publication_selected_evidence_invalid" };
const plan = "/plan/skus", digestField = "/plan/expectedSelectionDigest";
const refuse = (code: string, field: string, remedy: string) => ({ kind: "refused", code, field, remedy });
const invalid = refuse("tax_invalid_input", plan, "Supply the documented published SKU selection and its selection digest, then repeat the read.");
const invalidDigest = { ...invalid, field: digestField };
const inconsistent = refuse("catalog_tax_assignment_evidence_invalid", plan, "Have the catalogue owner reconcile the original selection and publication evidence, then repeat the read.");
const moved = refuse("catalog_tax_assignment_head_changed", digestField, "Read the published selection again and request a fresh quote.");
const unpublished = refuse("catalog_tax_assignment_unpublished", plan, "Choose published merchandise or have the catalogue owner publish the intended SKU, then request a fresh quote.");
const missingClass = refuse("tax_class_missing", plan,
  "Choose published merchandise whose product type declares an active tax class, or have the catalogue owner publish replacement merchandise with such a type, then request a fresh quote.");
const fixedId = (n: number): ReturnType<typeof randomUUID> => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const badDigest = "f".repeat(64);
const selection = (skus: readonly Pair[], expectedSelectionDigest: string | null = null) => ({ expectedSelectionDigest, skus });
const pair = (issue: Graph) => ({ skuId: issue.skuId, sku: issue.facts.code });
const read = async (db: PgQueryExecutor, input: unknown) => (await db.query(readSql, [JSON.stringify(input)])).rows[0]?.result;
const sortRows = <T extends Pair>(rows: T[]) => rows.sort((a, b) => a.skuId.localeCompare(b.skuId));
const typeKey = "example:article";
const offerVersion = "example:offer";
const definition = (version: number) => hash(`Fixture type definition ${version}`);

const resources = storeJourneyResources({ isolatedCluster: true });
let store: JourneyInstallation;
let first: Graph;
let second: Graph;
let classless: Graph;
let liveOnly: Pair;
let liveOnlyProductId: string;

async function installTypes(db: PgQueryExecutor) {
  await db.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'publication@example.invalid')", [actorId]);
  await db.query(`INSERT INTO public.catalog_tax_classes VALUES ('standard','Standard','active'),('reduced','Reduced','active');
    INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
    SELECT principal_id,'admin','active','legacy',clock_timestamp() FROM public.platform_human_principals WHERE email='publication@example.invalid'`);
  for (const [version, body] of [
    [1, { taxClass: "standard" }], [2, { taxClass: "reduced" }], [3, {}],
    [4, { taxClass: null }], [5, { taxClass: {} }], [6, { taxClass: "𐀀".repeat(61) }], [7, { taxClass: "unknown" }],
  ] as const) {
    await db.query("INSERT INTO public.catalog_type_versions(type_key,version,definition,definition_digest,validator_ref) VALUES($1,$2,$3,$4,$5)",
      [typeKey, version, body, definition(version), `sha256:${hash("Fixture validator")}`]);
  }
}

async function publish(db: PoolClient, data: ReturnType<typeof fixture> & { skuCode?: string } = fixture(),
  version = 1, previous?: Graph, dialect: 2 | 3 = 2, options: { sellable?: boolean; staged?: boolean;
    lifecycle?: "active" | "withdrawn"; extraSkuCount?: number; inherited?: CatalogSkuRevisionRef[] } = {}) {
  const { productId, skuId, draftId, documentId, skuCode } = data;
  const issue = await graph(db, { productId, skuId, draftId, documentId, skuCode: previous?.facts.code ?? skuCode },
    previous?.head, !previous && !options.staged,
    dialect === 3 ? { lifecycle: options.lifecycle ?? "draft" } : {});
  const record = await db.query<{ payload: { product: { type: { key: string; version: number } } } }>(
    "SELECT payload FROM public.catalog_draft_revisions WHERE draft_id=$1 AND revision=$2", [data.draftId, issue.revision]);
  const payload = record.rows[0]!.payload;
  issue.product.type = payload.product.type = { key: typeKey, version };
  if (dialect === 3) issue.product.definitionDigest = definition(version);
  issue.source.fingerprint = hash(json(payload));
  issue.candidateDigest = hash(json(["catalog-candidate", 1, payload, [{ ...issue.product.type, definitionDigest: definition(version) }], previous?.head ?? null]));
  issue.decision.candidateDigest = issue.candidateDigest;
  await db.query("SET LOCAL session_replication_role=replica");
  await db.query("UPDATE public.catalog_draft_revisions SET payload=$3,fingerprint=$4 WHERE draft_id=$1 AND revision=$2",
    [data.draftId, issue.revision, payload, issue.source.fingerprint]);
  await db.query("UPDATE public.catalog_draft_command_receipts SET fingerprint=$3 WHERE draft_id=$1 AND revision=$2",
    [data.draftId, issue.revision, issue.source.fingerprint]);
  if (!previous) await db.query("UPDATE public.catalog_products SET type_version=$2 WHERE id=$1", [data.productId, version]);
  if (options.sellable) {
    issue.product.status = issue.facts.status = "active";
    issue.facts.sellableStandalone = issue.facts.sellableInSubscription = true;
    issue.facts.memberships = [{ offerVersion, admitted: true }];
    await db.query("UPDATE public.catalog_products SET status='active' WHERE id=$1", [productId]);
  }
  await db.query("SET LOCAL session_replication_role=origin");
  await insertGraph(db, issue, {
    extraSkuCount: options.extraSkuCount,
    inherited: options.inherited,
    inherit: previous && !options.inherited && !options.lifecycle ? {
      skuId: previous.skuId, revisionId: previous.skuRevisionId, revision: 1, digest: hash(json(previous.facts)),
    } : undefined,
  });
  return issue;
}

beforeAll(async () => {
  store = await resources.installation("published-tax-assignments");
  await installTypes(store.owner);
  expect((await store.owner.query(listSql)).rows).toEqual([]);
  expect(await read(store.runtime, selection([{ skuId: fixedId(100), sku: "unpublished" }]))).toStrictEqual(unpublished);
  [first, second, classless, liveOnly] = await transaction(store.owner, async db => {
    const legacy = { ...fixture(), skuCode: "live-only" };
    await stageProductRows(db, legacy);
    liveOnlyProductId = legacy.productId;
    return [
      await publish(db, { ...fixture(), productId: fixedId(1), skuId: fixedId(11) }),
      await publish(db, { ...fixture(), productId: fixedId(2), skuId: fixedId(12) }, 2, undefined, 3),
      await publish(db, { ...fixture(), productId: fixedId(3), skuId: fixedId(13) }, 3),
      { skuId: legacy.skuId, sku: legacy.skuCode },
    ];
  });
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

async function rollback<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await store.owner.connect();
  try { await db.query("BEGIN"); return await work(db); }
  finally { await db.query("ROLLBACK"); db.release(); }
}

async function selectionRevision(pairs: readonly Pair[], products: readonly Graph[], db: PgQueryExecutor = store.owner) {
  const { rows } = await db.query(`SELECT jsonb_build_array('catalog-tax-assignment-selection',1,
    ARRAY(SELECT unnest($1::uuid[]) ORDER BY 1),
    (SELECT jsonb_agg(jsonb_build_array(product_id,id,revision,digest) ORDER BY product_id)
     FROM public.catalog_publications WHERE id=ANY($2::uuid[])))::text AS packet`,
  [pairs.map(row => row.skuId), products.map(row => row.issueId)]);
  const packet = rows[0]?.packet;
  if (typeof packet !== "string") throw new Error("Missing selection packet");
  return hash(packet);
}

function assigned(issue: Graph, revision: string, taxClassKey: string, skuRevisionId = issue.skuRevisionId) {
  return { ...pair(issue), classState: "assigned", taxClassKey,
    assignmentRef: `catalog-assignment:${revision}:${issue.issueId}:${issue.revision}:${skuRevisionId}` };
}

const replaceManifest = (db: PgQueryExecutor, issue: Graph, path: string, value: unknown) => db.query(`
  UPDATE public.catalog_publications SET canonical_state=changed.body,digest=encode(sha256(convert_to(changed.body,'UTF8')),'hex')
  FROM (SELECT public.catalog_publication_canonical(jsonb_set(canonical_state::jsonb,$2::text[],$3::jsonb),0) body
    FROM public.catalog_publications WHERE id=$1) changed WHERE id=$1`, [issue.issueId, path, JSON.stringify(value)]);

it("projects both publication dialects in UUID order and preserves the closed classless row", async () => {
  const pairs = [first, second, classless].map(pair);
  const revision = await selectionRevision(pairs, [first, second, classless]);
  const expected = { kind: "published", revision, assignments: sortRows([
    assigned(first, revision, "standard"), assigned(second, revision, "reduced"),
    { ...pair(classless), classState: "none", taxClassKey: null, assignmentRef: null },
  ]) };
  const forwardOrder = await read(store.runtime, selection(pairs, revision));
  expect(forwardOrder).toStrictEqual(expected);
  expect(JSON.stringify(await read(store.runtime, selection([...pairs].reverse())))).toBe(JSON.stringify(forwardOrder));
  const unknown = { skuId: fixedId(99), sku: "missing" };
  for (const absent of [liveOnly, unknown]) expect(await read(store.runtime, selection([pair(first), absent]))).toStrictEqual(unpublished);
  await rollback(async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("UPDATE public.catalog_skus SET sku='unpublished-code' WHERE id=$1", [first.skuId]);
    await db.query("UPDATE public.catalog_publication_heads SET revision=2147483647 WHERE product_id=$1", [first.productId]);
    await db.query("UPDATE public.catalog_publications SET revision=2147483647 WHERE id=$1", [first.issueId]);
    const revision = await selectionRevision([pair(first)], [first], db);
    const row = assigned({ ...first, revision: 2147483647 }, revision, "standard");
    expect(row.assignmentRef).toHaveLength(168);
    expect(await read(db, selection([pair(first)]))).toStrictEqual({ kind: "published", revision, assignments: [row] });
    expect(await read(db, selection([{ skuId: first.skuId, sku: "unpublished-code" }]))).toStrictEqual(invalid);
  });
});

it("refuses closed input substitutions, bounds, duplicates and syntax in precedence order", async () => {
  const p = pair(first);
  for (const [input, expected] of [
    [null, invalid], [[], invalid], ["invalid", invalid], [{ other: true, skus: 0 }, invalid],
    [{ skus: {} }, invalidDigest], [{ expectedSelectionDigest: {}, skus: {} }, invalidDigest],
    [selection([p], badDigest.toUpperCase()), invalidDigest], [selection([p], `${badDigest}\n`), invalidDigest],
    [{ expectedSelectionDigest: null }, invalid], [{ expectedSelectionDigest: null, skus: {} }, invalid],
    [selection([]), invalid], [selection(Array.from({ length: 51 }, (_, i) => ({ sku: `sku-${i}`, skuId: fixedId(i) }))), invalid],
    [{ expectedSelectionDigest: null, skus: [{ ...p, other: true }] }, invalid], [selection([{ skuId: p.skuId } as Pair]), invalid],
    [{ expectedSelectionDigest: null, skus: [null, p] }, invalid], [{ expectedSelectionDigest: null, skus: [{ skuId: {}, sku: p.sku }] }, invalid],
    [selection([{ ...p, skuId: "AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA" }]), invalid],
    [selection([{ ...p, skuId: `${p.skuId}\n` }]), invalid], [selection([{ ...p, sku: "a".repeat(161) }]), invalid],
    [selection([{ ...p, sku: "" }]), invalid], [selection([{ ...p, sku: "x\n" }]), invalid],
    [selection([{ ...p, sku: "é" }]), invalid], [selection([p, { ...p, sku: "other" }]), invalid],
    [selection([p, { ...p, skuId: fixedId(99) }]), invalid], [selection([p, p]), invalid],
  ] as const) expect(await read(store.runtime, input)).toStrictEqual(expected);
  expect(await read(store.runtime, selection(Array.from({ length: 50 }, (_, i) => ({
    skuId: fixedId(i + 100), sku: ".:_-".repeat(39) + String(i),
  }))))).toStrictEqual(unpublished);
});

it("orders selection integrity, revision binding, retained evidence and business refusals", async () => {
  const p = pair(first), other = pair(second), wrong = { ...p, sku: "incorrect" };
  await rollback(async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("UPDATE public.catalog_tax_classes SET status='retired' WHERE key='standard'");
    expect(await read(db, selection([p]))).toStrictEqual(missingClass);
    expect(await read(db, selection([p, liveOnly]))).toStrictEqual(unpublished);
    expect(await read(db, selection([wrong, liveOnly]))).toStrictEqual(invalid);
    await db.query("DELETE FROM public.catalog_tax_classes WHERE key='reduced'");
    expect(await read(db, selection([wrong, other]))).toStrictEqual(inconsistent);
    expect(await read(db, selection([p, other]))).toStrictEqual(inconsistent);
    for (const value of [{ key: typeKey, version: 99 }, { key: typeKey, version: "1" }, { key: "bad", version: 1 },
      ...[4, 5, 6, 7].map(version => ({ key: typeKey, version }))]) {
      await replaceManifest(db, first, "{product,type}", value);
      expect(await read(db, selection([p]))).toStrictEqual(inconsistent);
    }
    await replaceManifest(db, first, "{product,type}", { key: typeKey, version: 1 });
    await replaceManifest(db, second, "{product,definitionDigest}", badDigest);
    expect(await read(db, selection([other], badDigest))).toStrictEqual(moved);
    expect(await read(db, selection([other]))).toStrictEqual(inconsistent);
    await db.query("UPDATE public.catalog_sku_revisions SET digest=$2 WHERE id=$1", [first.skuRevisionId, badDigest]);
    expect(await read(db, selection([p], badDigest))).toStrictEqual(moved);
    expect(await read(db, selection([p]))).toStrictEqual(inconsistent);
  });
  const revision = await selectionRevision([p], [first]);
  expect(await read(store.runtime, selection([p]))).toStrictEqual({ kind: "published", revision, assignments: [assigned(first, revision, "standard")] });
  expect(await read(store.runtime, selection([p], badDigest))).toStrictEqual(moved);
  expect(await read(store.runtime, selection([liveOnly]))).toStrictEqual(unpublished);
  const intended = { ...fixture(), skuCode: "pending-publication" };
  await transaction(store.owner, db => stageProductRows(db, intended, undefined, intended.skuCode));
  const intendedPair = { skuId: intended.skuId, sku: intended.skuCode };
  expect(await read(store.runtime, selection([intendedPair]))).toStrictEqual(unpublished);
  const replacement = await transaction(store.owner, async db => {
    await db.query("INSERT INTO public.catalog_type_versions(type_key,version,definition,definition_digest,validator_ref) VALUES($1,8,$2,$3,$4)",
      [typeKey, { taxClass: "reduced" }, definition(8), `sha256:${hash("Fixture validator")}`]);
    return publish(db, intended, 8, undefined, 2, { staged: true });
  });
  const restored = await selectionRevision([intendedPair], [replacement]);
  expect(await read(store.runtime, selection([intendedPair], restored))).toStrictEqual({ kind: "published", revision: restored,
    assignments: [assigned(replacement, restored, "reduced")] });
});

it("lists exact typed manifest coordinates as owner and refuses a late broken head even with a limit", async () => {
  const result = await store.owner.query(listSql);
  expect(result.fields.map(field => [field.name, field.dataTypeID])).toStrictEqual([
    ["product_id", 2950], ["canonical_state", 25], ["digest", 25], ["publication_id", 2950], ["publication_revision", 23],
  ]);
  const retained = await store.owner.query(`SELECT h.product_id,p.canonical_state,p.digest,h.publication_id,h.revision AS publication_revision
    FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON p.id=h.publication_id ORDER BY h.product_id`);
  expect(result.rows).toStrictEqual(retained.rows);
  expect((await store.owner.query(filterSql, [null])).rows).toStrictEqual(result.rows);
  expect((await store.owner.query(filterSql, [[]])).rows).toStrictEqual([]);
  expect((await store.owner.query(filterSql, [[second.productId, null, first.productId, first.productId, liveOnlyProductId, fixedId(999)]])).rows)
    .toStrictEqual(result.rows.filter(row => [first.productId, second.productId].includes(row.product_id)));
  const located = await store.owner.query(locateSql, [[second.skuId, null, first.skuId, first.skuId, liveOnly.skuId, fixedId(999)]]);
  expect(located.fields.map(field => [field.name, field.dataTypeID])).toStrictEqual([
    ["sku_id", 2950], ["product_id", 2950], ["publication_marked", 16],
  ]);
  expect(located.rows).toStrictEqual([
    { sku_id: first.skuId, product_id: first.productId, publication_marked: true },
    { sku_id: second.skuId, product_id: second.productId, publication_marked: true },
    { sku_id: fixedId(999), product_id: null, publication_marked: false },
    { sku_id: liveOnly.skuId, product_id: liveOnlyProductId, publication_marked: false },
  ].sort((a, b) => a.sku_id.localeCompare(b.sku_id)));
  for (const empty of [null, [], [null]]) expect((await store.owner.query(locateSql, [empty])).rows).toStrictEqual([]);
  for (const sql of [
    "UPDATE public.catalog_publication_heads SET revision=revision+1 WHERE product_id=$1",
    "UPDATE public.catalog_publication_heads SET publication_id=gen_random_uuid() WHERE product_id=$1",
    "ALTER TABLE public.catalog_publications ALTER COLUMN canonical_state DROP NOT NULL; UPDATE public.catalog_publications SET canonical_state=NULL WHERE product_id=$1",
    "ALTER TABLE public.catalog_publications DROP CONSTRAINT catalog_publications_digest_check; UPDATE public.catalog_publications SET digest='' WHERE product_id=$1",
  ]) await rollback(async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    for (const statement of sql.split("; ")) {
      await db.query(statement, statement.includes("$1") ? [second.productId] : undefined);
    }
    expect((await db.query(filterSql, [[first.productId]])).rows).toStrictEqual(result.rows.filter(row => row.product_id === first.productId));
    for (const [sql, args] of [[listSql, undefined], [filterSql + " LIMIT 1", [[first.productId, second.productId]]]] as const) {
      await db.query("SAVEPOINT broken_head");
      await expect(db.query(sql, args ? [...args] : undefined)).rejects.toMatchObject(missingManifest);
      await db.query("ROLLBACK TO SAVEPOINT broken_head; RELEASE SAVEPOINT broken_head");
    }
  });
});

async function listingDefinition(db: PgQueryExecutor = store.owner): Promise<string> {
  const { rows } = await db.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [listing]);
  return String(rows[0]!.definition);
}

it("maps only the exact catalogue exceptions before comparing a stale revision", async () => {
  for (const tuple of [missingManifest, invalidEvidence]) {
    for (const failure of [tuple, { ...tuple, message: "different failure" }, { ...tuple, code: "PCA02" }]) {
      await rollback(async db => {
        const original = await listingDefinition(db);
        await db.query(original.replace(/BEGIN[\s\S]+END;/u, `BEGIN RAISE EXCEPTION USING ERRCODE='${failure.code}', MESSAGE='${failure.message}'; END;`));
        const response = read(db, selection([pair(first)], badDigest));
        if (failure === tuple) expect(await response).toStrictEqual(inconsistent);
        else await expect(response).rejects.toMatchObject(failure);
      });
    }
  }
});

it("rejects a null SKU before routing the remaining selection", async () => {
  await rollback(async db => {
    await db.query(`CREATE OR REPLACE FUNCTION public.catalog_publication_locate_sku_products(p_sku_ids uuid[])
      RETURNS TABLE (sku_id uuid, product_id uuid, publication_marked boolean) LANGUAGE plpgsql STABLE AS $$
      BEGIN RAISE EXCEPTION 'Unexpected SKU routing'; END; $$`);
    await db.query(`SET LOCAL ROLE ${journeySelection.runtimeLogin}`);
    expect(await read(db, { expectedSelectionDigest: null, skus: [pair(first), null] })).toStrictEqual(invalid);
    await expect(read(db, selection([pair(first)]))).rejects.toMatchObject({ message: "Unexpected SKU routing" });
  });
});

it("refuses selected routing, head, manifest and roster contradictions ahead of a stale revision", async () => {
  const chosen = selection([pair(first)], badDigest);
  for (const [mutation, args] of [
    ["UPDATE public.catalog_skus SET publication_facts=NULL WHERE id=$1", [first.skuId]],
    ["UPDATE public.catalog_sku_revisions SET product_id=$2 WHERE sku_id=$1", [first.skuId, second.productId]],
    ["DELETE FROM public.catalog_sku_revisions WHERE sku_id=$1", [first.skuId]],
    ["DELETE FROM public.catalog_skus WHERE id=$1", [first.skuId]],
    ["UPDATE public.catalog_publication_heads SET revision=revision+1 WHERE product_id=$1", [first.productId]],
    ["UPDATE public.catalog_products SET publication_facts=NULL WHERE id=$1", [first.productId]],
    ["UPDATE public.catalog_products SET current_document_revision_id=NULL WHERE id=$1", [first.productId]],
    ["UPDATE public.catalog_publications SET canonical_state='{}' WHERE product_id=$1", [first.productId]],
  ] as const) {
    await rollback(async db => {
      await db.query("SET LOCAL session_replication_role=replica");
      await db.query(mutation, [...args]);
      expect(await read(db, chosen)).toStrictEqual(inconsistent);
    });
    expect(await read(store.runtime, chosen)).toStrictEqual(moved);
  }
  await rollback(async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    const inserted = { skuId: fixedId(98), sku: "live-only-governed" };
    await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,net_weight_g) VALUES($1,$2,$3,'Article','draft',100)",
      [inserted.skuId, first.productId, inserted.sku]);
    expect(await read(db, selection([inserted]))).toStrictEqual(unpublished);
    const { rows: [roster] } = await db.query("SELECT canonical_state::jsonb->'skus' AS refs FROM public.catalog_publications WHERE id=$1", [first.issueId]);
    await replaceManifest(db, first, "{skus}", [...roster!.refs, { skuId: inserted.skuId, revisionId: fixedId(97), revision: 1, digest: badDigest }]);
    expect(await read(db, selection([inserted], badDigest))).toStrictEqual(inconsistent);
    await replaceManifest(db, first, "{product,primarySkuId}", inserted.skuId);
    await replaceManifest(db, first, "{skus}", [{ skuId: inserted.skuId, revisionId: fixedId(97), revision: 1, digest: badDigest }]);
    expect(await read(db, chosen)).toStrictEqual(inconsistent);
  });
});

it("preserves the complete quote projection when catalogue-wide diagnostics find unrelated corruption", async () => {
  const input = selection([pair(first)]);
  const original = await read(store.runtime, input);
  expect(original).toMatchObject({ kind: "published" });
  await rollback(async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("UPDATE public.catalog_publications SET canonical_state='{}' WHERE id=$1", [second.issueId]);
    expect((await db.query("SELECT public.catalog_publication_read_head() AS result")).rows[0]?.result)
      .toStrictEqual({ kind: "refusal", reason: "inconsistent_evidence" });
    await db.query(`SET LOCAL ROLE ${journeySelection.runtimeLogin}`);
    expect(JSON.stringify(await read(db, input))).toBe(JSON.stringify(original));
    expect(await read(db, selection([pair(second)]))).toStrictEqual(inconsistent);
  });
});

it("keeps the verified head and reused SKU revision in one read-committed statement snapshot", async () => {
  const original = await listingDefinition();
  const key = 694117, a = await store.runtime.connect(), b = await store.owner.connect();
  const request = selection([pair(first), pair(second)]);
  const oldDigest = await selectionRevision(request.skus, [first, second]);
  const oldReply = { kind: "published", revision: oldDigest, assignments: [assigned(first, oldDigest, "standard"), assigned(second, oldDigest, "reduced")] };
  let blocked: Promise<unknown> | undefined;
  try {
    await b.query(original.replace("BEGIN\n", `BEGIN\n PERFORM pg_advisory_lock(${key});\n PERFORM pg_advisory_unlock(${key});\n`));
    await b.query("SELECT pg_advisory_lock($1)", [key]);
    await a.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const pid = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    blocked = read(a, request);
    void blocked.catch(() => {});
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const result = await b.query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=$1
        AND objid=$2 AND NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids($1))) AS waiting`, [pid, key]);
      waiting = result.rows[0]?.waiting === true;
      if (!waiting) await delay(20);
    }
    expect(waiting).toBe(true);
    await b.query("BEGIN");
    const next = await publish(b, first, 1, first);
    await b.query("COMMIT");
    const newDigest = await selectionRevision(request.skus, [next, second], b);
    expect(newDigest).not.toBe(oldDigest);
    const newReply = { kind: "published", revision: newDigest, assignments: [assigned(next, newDigest, "standard", first.skuRevisionId), assigned(second, newDigest, "reduced")] };
    await b.query("SELECT pg_advisory_unlock($1)", [key]);
    expect(await blocked).toStrictEqual(oldReply);
    expect(await read(a, request)).toStrictEqual(newReply);
    expect(newReply.assignments[0]!.assignmentRef.split(":").at(-1)).toBe(oldReply.assignments[0]!.assignmentRef.split(":").at(-1));
    expect(await read(a, selection(request.skus, oldDigest))).toStrictEqual(moved);
    const manifest = (await b.query("SELECT canonical_state,digest FROM public.catalog_publications WHERE id=$1", [next.issueId])).rows[0]!;
    expect((await b.query(filterSql, [[first.productId]])).rows).toStrictEqual([{
      ...manifest, product_id: first.productId, publication_id: next.issueId, publication_revision: next.revision,
    }]);
    await rollback(async db => {
      await db.query("SET LOCAL session_replication_role=replica");
      await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=$3 WHERE product_id=$1",
        [first.productId, first.issueId, first.revision]);
      await expect(db.query(filterSql + " LIMIT 1", [[first.productId, second.productId]])).rejects.toMatchObject(invalidEvidence);
    });
    first = { ...next, skuRevisionId: first.skuRevisionId };
  } finally {
    await b.query("ROLLBACK; SELECT pg_advisory_unlock_all()");
    await blocked?.catch(() => {});
    await a.query("ROLLBACK");
    a.release();
    try { await b.query(original); } finally { b.release(); }
  }
});

it("binds the exact SKU set and changes only with selected publication and manifest evidence", async () => {
  const a = await transaction(store.owner, db => publish(db, fixture(), 1, undefined, 2, { extraSkuCount: 2 }));
  const b = await transaction(store.owner, db => publish(db));
  const { rows: alternatives } = await store.owner.query<Pair>(`SELECT id AS "skuId",sku FROM public.catalog_skus
    WHERE product_id=$1 AND id<>$2 ORDER BY id`, [a.productId, a.skuId]);
  expect(alternatives).toHaveLength(2);
  const [x, y] = alternatives as [Pair, Pair];
  const chosen = [pair(a), pair(b), x];
  const initialRevision = await selectionRevision(chosen, [a, b]);
  const revisions = new Set<string>();
  for (const pairs of [chosen, [pair(a), pair(b)], [...chosen, y], [pair(a), pair(b), y]]) {
    const revision = await selectionRevision(pairs, [a, b]);
    expect(await read(store.runtime, selection(pairs, revision))).toMatchObject({ kind: "published", revision });
    if (pairs !== chosen) expect(await read(store.runtime, selection(pairs, initialRevision))).toStrictEqual(moved);
    revisions.add(revision);
  }
  expect(revisions.size).toBe(4);
  const input = selection(chosen, initialRevision);
  const initial = await read(store.runtime, input);
  expect(JSON.stringify(await read(store.runtime, selection([...chosen].reverse())))).toBe(JSON.stringify(initial));
  const unrelated = await transaction(store.owner, db => publish(db, fixture(), 1, undefined, 3, { lifecycle: "active" }));
  expect(JSON.stringify(await read(store.runtime, input))).toBe(JSON.stringify(initial));
  const republished = await transaction(store.owner, db => publish(db, unrelated, 1, unrelated, 3, { lifecycle: "active" }));
  expect(JSON.stringify(await read(store.runtime, input))).toBe(JSON.stringify(initial));
  const withdrawn = await transaction(store.owner, db => publish(db, unrelated, 1, republished, 3, { lifecycle: "withdrawn" }));
  expect(withdrawn.product.lifecycleState).toBe("withdrawn");
  expect(JSON.stringify(await read(store.runtime, input))).toBe(JSON.stringify(initial));

  const { rows: [manifest] } = await store.owner.query<{ refs: CatalogSkuRevisionRef[] }>(
    "SELECT canonical_state::jsonb->'skus' AS refs FROM public.catalog_publications WHERE id=$1", [a.issueId]);
  const nextA = await transaction(store.owner, db => publish(db, a, 1, a, 2, { inherited: manifest!.refs }));
  const revisionA = await selectionRevision(chosen, [nextA, b]);
  expect(revisionA).not.toBe(initialRevision);
  expect(await read(store.runtime, input)).toStrictEqual(moved);
  expect(await read(store.runtime, selection(chosen, revisionA))).toMatchObject({ kind: "published", revision: revisionA });
  const nextB = await transaction(store.owner, db => publish(db, b, 1, b));
  const revisionB = await selectionRevision(chosen, [nextA, nextB]);
  expect(revisionB).not.toBe(revisionA);
  expect(await read(store.runtime, selection(chosen, revisionA))).toStrictEqual(moved);
  const newer = await read(store.runtime, selection(chosen, revisionB));
  expect(newer).toMatchObject({ kind: "published", revision: revisionB });
  if (!newer || typeof newer !== "object" || !("assignments" in newer) || !Array.isArray(newer.assignments)) {
    throw new Error("Missing selection assignments");
  }
  const assignments = newer.assignments;

  await rollback(async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    await replaceManifest(db, nextB, "{product,name}", "Updated article");
    const revision = await selectionRevision(chosen, [nextA, nextB], db);
    expect(revision).not.toBe(revisionB);
    expect(await read(db, selection(chosen, revisionB))).toStrictEqual(moved);
    expect(await read(db, selection(chosen, revision))).toStrictEqual({ kind: "published", revision,
      assignments: assignments.map((row: { assignmentRef: string }) => ({ ...row, assignmentRef: row.assignmentRef.replace(revisionB, revision) })),
    });
  });
  expect(await read(store.runtime, selection(chosen, revisionB))).toStrictEqual(newer);
});

it("keeps catalogue readers private and grants only the projection to the qualified runtime", async () => {
  const attrs = await store.owner.query(`SELECT name,p.prosecdef,p.provolatile,p.proconfig, p.proowner::regrole::text AS owner,
    ARRAY(SELECT a.grantee::regrole::text||'='||a.privilege_type||':'||a.is_grantable::text
      FROM aclexplode(p.proacl) a WHERE a.grantee<>p.proowner ORDER BY a.grantee) AS grants
    FROM unnest($1::text[]) WITH ORDINALITY n(name,position) JOIN pg_proc p ON p.oid=name::regprocedure ORDER BY position`, [[listing, locator, projection]]);
  expect(attrs.rows).toStrictEqual([listing, locator, projection].map(name => ({ name, prosecdef: true, provolatile: "s",
    proconfig: ["search_path=pg_catalog, pg_temp"], owner: journeySelection.migrationLogin,
    grants: name === projection ? ["service_role=EXECUTE:false"] : [],
  })));
  const tables = await store.owner.query(`SELECT c.relowner::regrole::text AS owner FROM unnest($1::text[]) name JOIN pg_class c ON c.oid=name::regclass`,
    [["public.catalog_publication_heads", "public.catalog_publications", "public.catalog_type_versions", "public.catalog_tax_classes"]]);
  expect(tables.rows).toStrictEqual(Array.from({ length: 4 }, () => ({ owner: journeySelection.migrationLogin })));
  for (const [sql, args] of [[listSql, []], [filterSql, [null]], [locateSql, [[first.skuId]]]] as const) {
    await expect(store.runtime.query(sql, [...args])).rejects.toMatchObject({ code: "42501" });
  }
  await expect(readPublishedSkuTaxAssignments(store.runtime, selection([pair(first)]))).resolves.toMatchObject({ kind: "published" });
  await rollback(async db => {
    await db.query("CREATE ROLE publication_observer LOGIN");
    for (const role of ["anon", "authenticated", "openlup_catalog_publication", "publication_observer", "service_role"]) {
      for (const [sql, args] of [[listSql, []], [filterSql, [null]], [locateSql, [[first.skuId]]], [readSql, [JSON.stringify(selection([pair(first)]))]]] as const) {
        await db.query("SAVEPOINT role_call");
        await db.query(`SET LOCAL ROLE ${role}`);
        if (role === "service_role" && sql === readSql) expect((await db.query(sql, [...args])).rows[0]?.result.kind).toBe("published");
        else await expect(db.query(sql, [...args])).rejects.toMatchObject({ code: "42501" });
        await db.query("ROLLBACK TO SAVEPOINT role_call; RELEASE SAVEPOINT role_call");
      }
    }
  });
});

it("upgrades a populated qualified prefix and preserves retained and storefront bytes", async () => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as Parameters<typeof withPlatformCatalog>[0];
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
    const position = plan.forward.findIndex(unit => unit.file === forward);
    expect(position).toBeGreaterThan(0);
    plan.forward = plan.forward.slice(0, position);
  }
  const db = await withPlatformCatalog(manifest, root => installAccountMutations("separate", true, "publication-tax-prefix", root));
  try {
    await installTypes(db.owner);
    const issue = await transaction(db.owner, client => publish(client, fixture(), 1, undefined, 2, { sellable: true }));
    const retained = () => db.owner.query(`SELECT p.canonical_state,p.digest,r.full_facts,r.digest AS sku_digest
      FROM public.catalog_publications p JOIN public.catalog_sku_revisions r ON r.publication_id=p.id WHERE p.id=$1`, [issue.issueId]);
    const before = (await retained()).rows;
    expect(before).toHaveLength(1);
    const storefront = async () => {
      const response = await readPostgresCatalogStorefrontPage({ run: work => transaction(db.runtime, work) }, {
        offerVersion, currency: "XXX", regionCode: "XA", channel: "online", limit: 10,
      });
      expect(response).toMatchObject({ protocol: "governed", products: [{ skus: [{ skuCode: issue.facts.code }] }] });
      if (!("protocol" in response)) throw new Error("Fixture storefront was unavailable");
      const view = projectPublishedCatalogOfferPage(response, []);
      expect(view).toMatchObject({ protocol: "governed", products: [{ skus: [{ skuCode: issue.facts.code }] }] });
      expect(JSON.stringify(view)).not.toMatch(/taxClass|assignmentRef/u);
      return JSON.stringify([response, view]);
    };
    const storefrontBefore = await storefront();
    expect((await db.runner.apply()).applied).toStrictEqual([forward]);
    expect((await retained()).rows).toStrictEqual(before);
    expect(await read(db.runtime, selection([pair(issue)]))).toMatchObject({ kind: "published" });
    expect(await storefront()).toBe(storefrontBefore);
    expect(await db.runner.apply()).toStrictEqual({ applied: [] });
  } finally { await db.close(); }
}, postgresSetupTimeoutMs);

it("runs starter one-time and subscription quotes without calling the helper or projection", async () => {
  const template = await resources.targetTemplate("starter-quote-boundary");
  const sample = await template.clone("starter-quote-boundary");
  const config = structuredClone(configurations.coffee!);
  const scratch = mkdtempSync(join(tmpdir(), "openlup-starter-quote-"));
  const owner = await sample.owner.connect();
  try {
    const { rows: [target] } = await owner.query<{ name: string }>("SELECT quote_ident(current_database()) AS name");
    await owner.query(`COMMENT ON DATABASE ${target!.name} IS '${demonstrationMarker}'`);
    await applyDemoSeed(config, { connection: owner, installRole: journeySelection.migrationLogin,
      runtimeRole: journeySelection.runtimeLogin, catalogueBuildDirectory: scratch, close: async () => {} });
  } finally { owner.release(); rmSync(scratch, { recursive: true, force: true }); }
  const projectionCalls: string[] = [];
  const executor = { query(text: string, values?: unknown[]) {
    if (text.includes("catalog_publication_tax_assignments")) projectionCalls.push(text);
    return sample.runtime.query(text, values);
  } };
  const helper = vi.mocked(readPublishedSkuTaxAssignments);
  helper.mockClear();
  const quotes = createNativeQuoteService(executor, installedAcquisitionPredecessors(), { current: "fixture-only-acceptance-key-00000000000000" });
  const context = { config, actor: { customerRef: null, operatorRef: null }, commandKey: randomUUID() };
  const lines = [{ sku: config.offer.products[0]!.sku, quantity: 3 }];
  const atTime = new Date().toISOString();
  const run = async () => Promise.all((["one_time", "subscription"] as const).map(async mode => {
    const observed = await quotes.quote({ cart: { schemaVersion: 1, configuration: config.id, mode,
      cadenceDays: mode === "subscription" ? config.offer.defaultCadenceDays : null, lines }, acquisitionCapability: "subscription-acquisition.v1" }, context, undefined, atTime);
    expect(observed.snapshot.quote.context?.mode).toBe(mode);
    return JSON.stringify(observed.snapshot);
  }));
  await sample.owner.query(`DROP FUNCTION ${projection},${listing},${locator}`);
  const before = await run();
  await sample.owner.query(readFileSync(forward, "utf8"));
  expect(await run()).toStrictEqual(before);
  expect(helper).not.toHaveBeenCalled();
  expect(projectionCalls).toStrictEqual([]);
}, postgresSetupTimeoutMs);

it("applies with dormant roles and revokes seeded browser function defaults", async () => {
  const container = await runPostgresContainer({ name: `catalogue-tax-acl-${process.pid}`, password: randomUUID() });
  let pool: Pool | undefined;
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue ACL proof needs PostgreSQL");
    pool = new Pool({ connectionString: container.connectionString });
    const sql = readFileSync(forward, "utf8");
    const { baseline, forward: migrations } = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as Parameters<typeof withPlatformCatalog>[0];
    for (const { file } of [baseline, ...migrations.slice(0, migrations.findIndex(unit => unit.file === forward))]) {
      await pool.query(readFileSync(file, "utf8"));
    }
    expect((await pool.query("SELECT rolname FROM pg_roles WHERE rolname='service_role'")).rows).toStrictEqual([]);
    for (const seeded of [false, true]) await transaction(pool, async db => {
      if (seeded) {
        await db.query("ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated");
      } else {
        await db.query("DROP OWNED BY anon,authenticated; DROP ROLE anon,authenticated");
        expect((await db.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')")).rows).toStrictEqual([]);
      }
      await db.query(sql);
      expect((await db.query(listSql)).rows).toStrictEqual([]);
      const grants = await db.query(`SELECT acl.grantee::regrole::text AS role FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(p.proacl) acl WHERE p.oid=ANY($1::regprocedure[]) AND acl.grantee<>p.proowner`, [[listing, locator, projection]]);
      expect(grants.rows).toStrictEqual([]);
      if (seeded) {
        const effective = await db.query(`SELECT role,name FROM unnest(ARRAY['anon','authenticated']) role,unnest($1::text[]) name
          WHERE has_function_privilege(role,name,'EXECUTE')`, [[listing, locator, projection]]);
        expect(effective.rows).toStrictEqual([]);
      }
      await db.query("ROLLBACK");
    });
  } finally { await closePostgres(container, pool); }
}, postgresSetupTimeoutMs);

type PlanNode = {
  "Node Type": string;
  "Actual Loops": number;
  "Actual Rows": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Local Hit Blocks"?: number;
  "Local Read Blocks"?: number;
  Plans?: PlanNode[];
};
type ExecutedPlan = { "Query Text": string; Plan: PlanNode };
const catalogueScan = (node: PlanNode) => node["Node Type"].endsWith("Scan") && node["Relation Name"]?.startsWith("catalog_");

function catalogueWork(plans: ExecutedPlan[], large: boolean) {
  const relations = new Set<string>();
  let lower = 0, upper = 0;
  const lookups = {
    catalog_publication_heads: "product_id",
    catalog_publications: "product_id",
    catalog_sku_revisions: "sku_id|id",
  };
  const visit = (node: PlanNode, heapRelation?: string) => {
    const loops = node["Actual Loops"];
    if (!loops) return;
    const relation = node["Relation Name"] ?? heapRelation;
    const key = lookups[relation as keyof typeof lookups];
    if (large && key && (catalogueScan(node) || node["Node Type"] === "Bitmap Index Scan")) {
      if (node["Node Type"] !== "Bitmap Heap Scan") {
        expect(node["Index Cond"], JSON.stringify(node)).toMatch(new RegExp(`\\b(?:${key}) = `, "u"));
      }
    }
    if (catalogueScan(node)) {
      relations.add(relation!);
      for (const value of [node["Actual Rows"], node["Rows Removed by Filter"], node["Rows Removed by Index Recheck"]]) {
        if (value === undefined) continue;
        lower += loops === 1 ? value : Math.floor(loops * Math.max(0, value - 0.5));
        upper += loops === 1 ? value : Math.ceil(loops * (value + 0.5));
      }
    }
    for (const child of node.Plans ?? []) visit(child, relation);
  };
  for (const plan of plans) visit(plan.Plan);
  expect(relations).toEqual(new Set([
    "catalog_products", "catalog_skus", "catalog_publication_heads", "catalog_publications",
    "catalog_sku_revisions", "catalog_type_versions", "catalog_tax_classes",
  ]));
  return { lower, upper };
}

it("bounds executed catalogue work at two times across unrelated catalogue sizes and retention levels", async () => {
  const template = await resources.targetTemplate("publication-cost");
  const sample = await template.clone("publication-cost");
  await installTypes(sample.owner);
  const db = await sample.owner.connect();
  const notices: string[] = [];
  const collect = ({ message }: { message?: string }) => {
    if (message && /^duration:.*plan:/u.test(message)) notices.push(message.slice(message.indexOf("\n") + 1));
  };
  const selected: Graph[] = [];
  const unrelated: Graph[] = [];
  const addHistory = async (initial: Graph) => {
    const next = await publish(db, initial, 1, initial);
    await publish(db, initial, 1, { ...next, skuRevisionId: initial.skuRevisionId, facts: initial.facts });
  };
  try {
    await db.query("BEGIN");
    await db.query(`LOAD 'auto_explain'; SET LOCAL auto_explain.log_nested_statements=on; SET LOCAL auto_explain.log_analyze=on;
      SET LOCAL auto_explain.log_buffers=on; SET LOCAL auto_explain.log_timing=off; SET LOCAL auto_explain.log_format='json';
      SET LOCAL auto_explain.log_level='notice'; SET LOCAL client_min_messages='notice'`);
    for (let i = 0; i < 10; i++) selected.push(await publish(db, fixture(), 1, undefined, 2, { extraSkuCount: 4 }));
    const { rows: pairs } = await db.query<Pair>('SELECT id AS "skuId",sku FROM public.catalog_skus ORDER BY id');
    expect(pairs).toHaveLength(50);
    const revision = await selectionRevision(pairs, selected, db);
    const input = selection(pairs, revision);
    const statement = `SELECT public.catalog_publication_tax_assignments($fixture$${JSON.stringify(input)}$fixture$::jsonb) AS result`;
    for (let i = 0; i < 10; i++) unrelated.push(await publish(db));

    const measure = async (extraHeads: number, history: number) => {
      await db.query(`SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
        ANALYZE public.catalog_products; ANALYZE public.catalog_skus; ANALYZE public.catalog_publications;
        ANALYZE public.catalog_publication_heads; ANALYZE public.catalog_sku_revisions;
        ANALYZE public.catalog_type_versions; ANALYZE public.catalog_tax_classes`);
      const { rows: [size] } = await db.query(`SELECT count(*)::int AS heads,
        sum(jsonb_array_length(p.canonical_state::jsonb->'skus'))::int AS roster,
        min(octet_length(p.canonical_state)) AS min_width, max(octet_length(p.canonical_state)) AS max_width,
        (SELECT count(*)::int FROM public.catalog_publications) AS publications
        FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON p.id=h.publication_id`);
      expect(size).toMatchObject({ heads: 10 + extraHeads, roster: 50 + extraHeads, publications: 10 + extraHeads * history });
      await db.query(`SET LOCAL SESSION AUTHORIZATION ${journeySelection.runtimeLogin}`);
      expect((await db.query("SELECT current_user,session_user")).rows).toStrictEqual([
        { current_user: journeySelection.runtimeLogin, session_user: journeySelection.runtimeLogin },
      ]);
      await db.query("RESET SESSION AUTHORIZATION; SET LOCAL auto_explain.log_min_duration=0");
      await db.query(`SET LOCAL SESSION AUTHORIZATION ${journeySelection.runtimeLogin}`);
      notices.length = 0;
      db.on("notice", collect);
      const start = performance.now();
      let reply: unknown;
      try { reply = (await db.query(statement)).rows[0]?.result; }
      finally {
        try { await db.query("RESET SESSION AUTHORIZATION; SET LOCAL auto_explain.log_min_duration=-1"); }
        finally { db.off("notice", collect); }
      }
      const milliseconds = performance.now() - start;
      expect(reply).toMatchObject({ kind: "published", revision, assignments: { length: 50 } });
      const plans = notices.flatMap(notice => JSON.parse(notice) as ExecutedPlan[]);
      const top = plans.filter(plan => plan["Query Text"] === statement);
      expect(top, `Plan capture received ${plans.length} statements`).toHaveLength(1);
      const calls = (pattern: RegExp) => plans.filter(plan => pattern.test(plan["Query Text"])).length;
      expect(calls(/WITH ORDINALITY AS refs\(r,position\)/u)).toBe(selected.length);
      expect(calls(/FROM public\.catalog_sku_revisions WHERE id=CASE/u)).toBe(50);
      expect(calls(/catalog_publication_read_head\s*\(/u)).toBe(0);
      const buffers = Object.fromEntries(Object.entries(top[0]!.Plan).filter(([key]) => key.endsWith("Blocks")));
      return { reply, size, buffers, milliseconds, work: catalogueWork(plans, extraHeads === 1_000) };
    };

    const smallOne = await measure(10, 1);
    await db.query("SAVEPOINT one_retained");
    for (const initial of unrelated) await addHistory(initial);
    const smallThree = await measure(10, 3);
    await db.query("ROLLBACK TO SAVEPOINT one_retained; RELEASE SAVEPOINT one_retained");
    for (let i = 10; i < 1_000; i++) unrelated.push(await publish(db));
    const largeOne = await measure(1_000, 1);
    for (const initial of unrelated) await addHistory(initial);
    const largeThree = await measure(1_000, 3);

    for (const [history, small, large] of [[1, smallOne, largeOne], [3, smallThree, largeThree]] as const) {
      expect(JSON.stringify(large.reply)).toBe(JSON.stringify(small.reply));
      expect(small.work.lower).toBeGreaterThan(0);
      const ratio = large.work.upper / small.work.lower;
      expect(ratio).toBeLessThanOrEqual(2);
      const evidence = ({ size, buffers, milliseconds, work }: typeof small) => ({ size, buffers, milliseconds, work });
      console.info(JSON.stringify({ history, requested: pairs.length, small: evidence(small), large: evidence(large), ratio }));
    }
  } finally {
    db.off("notice", collect);
    await db.query("ROLLBACK");
    db.release();
  }
}, 600_000);
