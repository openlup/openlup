import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { projectPublishedCatalogOfferPage, readPostgresCatalogStorefrontPage } from "@openlup/platform/catalog";
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
const forward = "db/platform/migrations/20261129060000_catalog_publication_tax_assignments.sql";
const listing = "public.catalog_publication_read_head_manifests()";
const projection = "public.catalog_publication_tax_assignments(jsonb)";
const listSql = `SELECT * FROM ${listing}`;
const readSql = "SELECT public.catalog_publication_tax_assignments($1::jsonb) AS result";
const missingManifest = { code: "PCA01", message: "catalog_publication_head_manifest_missing" };
const plan = "/plan/skus", digestField = "/plan/expectedHeadDigest";
const refuse = (code: string, field: string, remedy: string) => ({ kind: "refused", code, field, remedy });
const invalid = refuse("tax_invalid_input", plan, "Supply the documented published SKU selection and its catalogue head digest, then repeat the read.");
const invalidDigest = { ...invalid, field: digestField };
const inconsistent = refuse("catalog_tax_assignment_evidence_invalid", plan, "Have the catalogue owner reconcile the original selection and publication evidence, then repeat the read.");
const moved = refuse("catalog_tax_assignment_head_changed", digestField, "Read the published selection again and request a fresh quote.");
const unpublished = refuse("catalog_tax_assignment_unpublished", plan, "Choose published merchandise or have the catalogue owner publish the intended SKU, then request a fresh quote.");
const missingClass = refuse("tax_class_missing", plan,
  "Choose published merchandise whose product type declares an active tax class, or have the catalogue owner publish replacement merchandise with such a type, then request a fresh quote.");
const fixedId = (n: number): ReturnType<typeof randomUUID> => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const badDigest = "f".repeat(64);
const selection = (skus: readonly Pair[], expectedHeadDigest: string | null = null) => ({ expectedHeadDigest, skus });
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
  version = 1, previous?: Graph, dialect: 2 | 3 = 2, options: { sellable?: boolean; staged?: boolean } = {}) {
  const { productId, skuId, draftId, documentId, skuCode } = data;
  const issue = await graph(db, { productId, skuId, draftId, documentId, skuCode: previous?.facts.code ?? skuCode },
    previous?.head, !previous && !options.staged,
    dialect === 3 ? { lifecycle: "draft" } : {});
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
  await insertGraph(db, issue, previous && { inherit: {
    skuId: previous.skuId, revisionId: previous.skuRevisionId, revision: 1, digest: hash(json(previous.facts)),
  } });
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

async function head(db: PgQueryExecutor = store.owner): Promise<string> {
  const { rows } = await db.query(`SELECT jsonb_agg(jsonb_build_array(h.product_id,h.publication_id,h.revision,p.digest)
    ORDER BY h.product_id)::text AS packet FROM public.catalog_publication_heads h
    JOIN public.catalog_publications p ON (p.product_id,p.id,p.revision)=(h.product_id,h.publication_id,h.revision)`);
  return hash(String(rows[0]!.packet));
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
  const revision = await head();
  const expected = { kind: "published", revision, assignments: sortRows([
    assigned(first, revision, "standard"), assigned(second, revision, "reduced"),
    { ...pair(classless), classState: "none", taxClassKey: null, assignmentRef: null },
  ]) };
  const pairs = [first, second, classless].map(pair);
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
    const revision = await head(db);
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
    [{ skus: {} }, invalidDigest], [{ expectedHeadDigest: {}, skus: {} }, invalidDigest],
    [selection([p], badDigest.toUpperCase()), invalidDigest], [selection([p], `${badDigest}\n`), invalidDigest],
    [{ expectedHeadDigest: null }, invalid], [{ expectedHeadDigest: null, skus: {} }, invalid],
    [selection([]), invalid], [selection(Array.from({ length: 51 }, (_, i) => ({ sku: `sku-${i}`, skuId: fixedId(i) }))), invalid],
    [{ expectedHeadDigest: null, skus: [{ ...p, other: true }] }, invalid], [selection([{ skuId: p.skuId } as Pair]), invalid],
    [{ expectedHeadDigest: null, skus: [null, p] }, invalid], [{ expectedHeadDigest: null, skus: [{ skuId: {}, sku: p.sku }] }, invalid],
    [selection([{ ...p, skuId: "AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA" }]), invalid],
    [selection([{ ...p, skuId: `${p.skuId}\n` }]), invalid], [selection([{ ...p, sku: "a".repeat(161) }]), invalid],
    [selection([{ ...p, sku: "" }]), invalid], [selection([{ ...p, sku: "x\n" }]), invalid],
    [selection([{ ...p, sku: "é" }]), invalid], [selection([p, { ...p, sku: "other" }]), invalid],
    [selection([p, { ...p, skuId: fixedId(99) }]), invalid],
  ] as const) expect(await read(store.runtime, input)).toStrictEqual(expected);
  expect(await read(store.runtime, selection(Array.from({ length: 50 }, (_, i) => ({
    skuId: fixedId(i + 100), sku: ".:_-".repeat(39) + String(i),
  }))))).toStrictEqual(unpublished);
});

it("orders head binding, row integrity, caller codes, missing membership and retired classes", async () => {
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
    expect(await read(db, selection([other]))).toStrictEqual(inconsistent);
    await db.query("UPDATE public.catalog_sku_revisions SET digest=$2 WHERE id=$1", [first.skuRevisionId, badDigest]);
    expect(await read(db, selection([p], badDigest))).toStrictEqual(moved);
    expect(await read(db, selection([p]))).toStrictEqual(inconsistent);
    await db.query("UPDATE public.catalog_publications SET digest=$2 WHERE id=$1", [second.issueId, badDigest]);
    expect(await read(db, selection([p], badDigest))).toStrictEqual(inconsistent);
  });
  expect(await read(store.runtime, selection([p]))).toStrictEqual({ kind: "published", revision: await head(), assignments: [assigned(first, await head(), "standard")] });
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
  const restored = await head();
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
  expect(result.rows.some(row => row.product_id === liveOnlyProductId)).toBe(false);
  for (const sql of [
    "UPDATE public.catalog_publication_heads SET revision=revision+1 WHERE product_id=$1",
    "UPDATE public.catalog_publication_heads SET publication_id=gen_random_uuid() WHERE product_id=$1",
    "ALTER TABLE public.catalog_publications ALTER COLUMN canonical_state DROP NOT NULL; UPDATE public.catalog_publications SET canonical_state=NULL WHERE product_id=$1",
  ]) await rollback(async db => {
    await db.query("SET LOCAL session_replication_role=replica");
    for (const statement of sql.split("; ")) {
      await db.query(statement, statement.includes("$1") ? [second.productId] : undefined);
    }
    for (const suffix of ["", " LIMIT 1"]) {
      await db.query("SAVEPOINT broken_head");
      await expect(db.query(listSql + suffix)).rejects.toMatchObject(missingManifest);
      await db.query("ROLLBACK TO SAVEPOINT broken_head; RELEASE SAVEPOINT broken_head");
    }
  });
});

async function listingDefinition(db: PgQueryExecutor = store.owner): Promise<string> {
  const { rows } = await db.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [listing]);
  return String(rows[0]!.definition);
}

it("maps only the exact listing exception after binding the verified head", async () => {
  for (const failure of [missingManifest, { ...missingManifest, message: "different failure" }, { ...missingManifest, code: "PCA02" }]) {
    await rollback(async db => {
      const original = await listingDefinition(db);
      await db.query(original.replace(/BEGIN[\s\S]+END;/u, `BEGIN RAISE EXCEPTION USING ERRCODE='${failure.code}', MESSAGE='${failure.message}'; END;`));
      expect(await read(db, selection([pair(first)], badDigest))).toStrictEqual(moved);
      if (failure === missingManifest) expect(await read(db, selection([pair(first)]))).toStrictEqual(inconsistent);
      else await expect(read(db, selection([pair(first)]))).rejects.toMatchObject(failure);
    });
  }
});

it("keeps the verified head and reused SKU revision in one read-committed statement snapshot", async () => {
  const original = await listingDefinition();
  const key = 694117, a = await store.runtime.connect(), b = await store.owner.connect();
  const request = selection([pair(first), pair(second)]);
  const oldDigest = await head();
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
    const newDigest = await head(b);
    expect(newDigest).not.toBe(oldDigest);
    const newReply = { kind: "published", revision: newDigest, assignments: [assigned(next, newDigest, "standard", first.skuRevisionId), assigned(second, newDigest, "reduced")] };
    await b.query("SELECT pg_advisory_unlock($1)", [key]);
    expect(await blocked).toStrictEqual(oldReply);
    expect(await read(a, request)).toStrictEqual(newReply);
    expect(newReply.assignments[0]!.assignmentRef.split(":").at(-1)).toBe(oldReply.assignments[0]!.assignmentRef.split(":").at(-1));
    expect(await read(a, selection([pair(first)], oldDigest))).toStrictEqual(moved);
    const manifest = (await b.query("SELECT canonical_state,digest FROM public.catalog_publications WHERE id=$1", [next.issueId])).rows[0]!;
    expect((await b.query(`${listSql} WHERE product_id=$1`, [first.productId])).rows).toStrictEqual([{
      ...manifest, product_id: first.productId, publication_id: next.issueId, publication_revision: next.revision,
    }]);
    first = { ...next, skuRevisionId: first.skuRevisionId };
  } finally {
    await b.query("ROLLBACK; SELECT pg_advisory_unlock_all()");
    await blocked?.catch(() => {});
    await a.query("ROLLBACK");
    a.release();
    try { await b.query(original); } finally { b.release(); }
  }
});

it("keeps catalogue readers private and grants only the projection to the qualified runtime", async () => {
  const attrs = await store.owner.query(`SELECT name,p.prosecdef,p.provolatile,p.proconfig, p.proowner::regrole::text AS owner,
    ARRAY(SELECT a.grantee::regrole::text||'='||a.privilege_type||':'||a.is_grantable::text
      FROM aclexplode(p.proacl) a WHERE a.grantee<>p.proowner ORDER BY a.grantee) AS grants
    FROM unnest($1::text[]) WITH ORDINALITY n(name,position) JOIN pg_proc p ON p.oid=name::regprocedure ORDER BY position`, [[listing, projection]]);
  expect(attrs.rows).toStrictEqual([listing, projection].map(name => ({ name, prosecdef: true, provolatile: "s",
    proconfig: ["search_path=pg_catalog, pg_temp"], owner: journeySelection.migrationLogin,
    grants: name === projection ? ["service_role=EXECUTE:false"] : [],
  })));
  const tables = await store.owner.query(`SELECT c.relowner::regrole::text AS owner FROM unnest($1::text[]) name JOIN pg_class c ON c.oid=name::regclass`,
    [["public.catalog_publication_heads", "public.catalog_publications", "public.catalog_type_versions", "public.catalog_tax_classes"]]);
  expect(tables.rows).toStrictEqual(Array.from({ length: 4 }, () => ({ owner: journeySelection.migrationLogin })));
  await expect(store.runtime.query(listSql)).rejects.toMatchObject({ code: "42501" });
  await expect(readPublishedSkuTaxAssignments(store.runtime, selection([pair(first)]))).resolves.toMatchObject({ kind: "published" });
  await rollback(async db => {
    await db.query("CREATE ROLE publication_observer LOGIN");
    for (const role of ["anon", "authenticated", "openlup_catalog_publication", "publication_observer", "service_role"]) {
      for (const [sql, args] of [[listSql, undefined], [readSql, [JSON.stringify(selection([pair(first)]))]]] as const) {
        await db.query("SAVEPOINT role_call");
        await db.query(`SET LOCAL ROLE ${role}`);
        if (role === "service_role" && sql === readSql) expect((await db.query(sql, [...args!])).rows[0]?.result.kind).toBe("published");
        else await expect(db.query(sql, args ? [...args] : undefined)).rejects.toMatchObject({ code: "42501" });
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
    expect((await db.runner.apply()).applied.slice(0, 1)).toStrictEqual([forward]);
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
  await sample.owner.query(`DROP FUNCTION ${projection},${listing}`);
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
        CROSS JOIN LATERAL aclexplode(p.proacl) acl WHERE p.oid IN ($1::regprocedure,$2::regprocedure) AND acl.grantee<>p.proowner`, [listing, projection]);
      expect(grants.rows).toStrictEqual([]);
      if (seeded) {
        const effective = await db.query(`SELECT role,name FROM unnest(ARRAY['anon','authenticated']) role,unnest($1::text[]) name
          WHERE has_function_privilege(role,name,'EXECUTE')`, [[listing, projection]]);
        expect(effective.rows).toStrictEqual([]);
      }
      await db.query("ROLLBACK");
    });
  } finally { await closePostgres(container, pool); }
}, postgresSetupTimeoutMs);

it("records the listing and projection cost with one and three retained publications per head", async () => {
  const template = await resources.targetTemplate("publication-cost");
  const sample = await template.clone("publication-cost");
  await installTypes(sample.owner);
  const db = await sample.owner.connect();
  const published: Graph[] = [];
  const headCount = 1_000;
  const notices: string[] = [];
  const collect = ({ message }: { message?: string }) => {
    if (message?.includes("catalog_publication_heads h") && message.includes("LEFT JOIN public.catalog_publications p")) {
      notices.push(message.slice(message.indexOf("\n") + 1));
    }
  };
  try {
    await db.query("BEGIN");
    await db.query(`LOAD 'auto_explain'; SET auto_explain.log_nested_statements=on; SET auto_explain.log_analyze=on;
      SET auto_explain.log_buffers=on; SET auto_explain.log_timing=off; SET auto_explain.log_format='json';
      SET auto_explain.log_level='notice'; SET client_min_messages='notice'`);
    for (let i = 0; i < headCount; i++) published.push(await publish(db));
    for (const history of [1, 3]) {
      if (history === 3) {
        for (const initial of published) {
          const next = await publish(db, initial, 1, initial);
          await publish(db, initial, 1, { ...next, skuRevisionId: initial.skuRevisionId, facts: initial.facts });
        }
      }
      await db.query("SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; ANALYZE public.catalog_publications; ANALYZE public.catalog_publication_heads");
      const { rows: [size] } = await db.query(`SELECT count(*)::int AS heads,
        sum(jsonb_array_length(p.canonical_state::jsonb->'skus'))::int AS roster,
        min(octet_length(p.canonical_state)) AS min_width, max(octet_length(p.canonical_state)) AS max_width,
        (SELECT count(*)::int FROM public.catalog_publications) AS publications
        FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON p.id=h.publication_id`);
      const listStart = performance.now();
      expect((await db.query(listSql)).rowCount).toBe(headCount);
      const listingMs = performance.now() - listStart;
      const selected = selection(published.slice(0, 50).map(pair));
      const projectStart = performance.now();
      expect(await read(db, selected)).toMatchObject({ kind: "published" });
      const projectionMs = performance.now() - projectStart;
      notices.length = 0;
      db.on("notice", collect);
      await db.query("SET auto_explain.log_min_duration=0");
      await db.query(listSql);
      await db.query("SET auto_explain.log_min_duration=-1");
      db.off("notice", collect);
      const plans = notices.map(plan => JSON.parse(plan) as unknown);
      const scansRetainedHistory = notices.some(plan => /"Node Type": "(?:Seq|Parallel Seq) Scan",(?:(?!"Node Type")[\s\S])*"Relation Name": "catalog_publications"/u.test(plan));
      expect(size).toMatchObject({ heads: headCount, roster: headCount, publications: headCount * history });
      console.info(JSON.stringify({ history, size, requested: selected.skus.length, listingMs, projectionMs, scansRetainedHistory, plans }));
    }
  } finally {
    db.off("notice", collect);
    await db.query("ROLLBACK");
    db.release();
  }
}, 600_000);
