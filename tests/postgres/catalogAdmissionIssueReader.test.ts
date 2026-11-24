import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CatalogSkuRevisionRef } from "@openlup/platform/catalog";
import registry from "../../config/reviewed-platform-forwards.json" with { type: "json" };
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady,
  type PostgresContainer } from "../helpers/postgresContainer.js";
import { captureStoreJourney, journeySelection, storeJourneyResources } from "../helpers/storeJourney.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";
import { documentRow, fixture, graph, hash, insertGraph, installAfter, installCatalogueReadGrants, installPublicationActors, json,
  publicationManifestText, transaction, type Graph } from "./catalogPublicationFixture.js";

const forward = registry.nativeStoreForwardClass.slots.find(slot => slot.path.endsWith("_catalog_admission_issue_reader.sql"))!.path;
const reader = "public.catalog_offer_memberships_page(text,jsonb,integer,text)";
const readerSql = "SELECT public.catalog_offer_memberships_page($1,$2,$3,$4)::pg_catalog.text AS result";
const profiles = ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const;
const password = "synthetic-reader";
type Db = Pool | PoolClient;
let container: PostgresContainer, pool: Pool;
const pools: Pool[] = [];

const fixedId = (index: number): ReturnType<typeof randomUUID> => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const refusal = (reason: string, detail?: string) => detail ? { kind: "refusal", reason, detail } : { kind: "refusal", reason };
const invalid = refusal("invalid_request");
const ineligible = refusal("invalid_request", "catalog_admission_selection_ineligible");
async function text(db: Db, args: unknown[], sql = readerSql) { return (await db.query(sql, args)).rows[0]!.result as string; }
async function read(db: Db, offer: unknown, cursor: unknown, limit: unknown = 100) {
  return JSON.parse(await text(db, [offer, cursor, limit, "admission_issue"]));
}
const login = (name: string) => {
  const url = new URL(container.connectionString); url.username = name; url.password = password;
  const value = new Pool({ connectionString: url.toString(), max: 2 }); pools.push(value); return value;
};

type Seed = { offer: string; id?: ReturnType<typeof randomUUID>; admitted?: boolean; productActive?: boolean; skuActive?: boolean; standalone?: boolean;
  subscription?: boolean; extra?: number; lifecycle?: true; also?: string };
async function seed(db: PoolClient, options: Seed) {
  const issue = await graph(db, { ...fixture(), ...(options.id ? { skuId: options.id } : {}) }, null, true,
    options.lifecycle ? { lifecycle: "active", subscriptionEligible: options.subscription ?? true } : {});
  if (!options.lifecycle) {
    issue.product.status = options.productActive === false ? "draft" : "active";
    issue.facts.status = options.skuActive === false ? "draft" : "active";
    issue.facts.sellableStandalone = options.standalone ?? true;
    issue.facts.sellableInSubscription = options.subscription ?? true;
    await db.query("UPDATE public.catalog_products SET status=$2 WHERE id=$1", [issue.productId, issue.product.status]);
  }
  issue.facts.memberships = [{ offerVersion: options.offer, admitted: options.admitted ?? true },
    ...(options.also ? [{ offerVersion: options.also, admitted: true }] : [])].sort((left, right) => left.offerVersion < right.offerVersion ? -1 : 1);
  await insertGraph(db, issue, { extraSkuCount: options.extra });
  return issue;
}

// Issue a later publication that keeps the given SKU revisions and moves the product to a new document.
async function carry(db: PoolClient, previous: Graph, original: Graph, refs: CatalogSkuRevisionRef[], revisionNo: number) {
  const next = await graph(db, { productId: original.productId, skuId: original.skuId, draftId: original.draftId,
    skuCode: original.facts.code, documentId: randomUUID() }, previous.head, false,
  { registerExisting: true, documentText: json({ label: `document ${revisionNo}` }) });
  next.document.revisionNo = revisionNo;
  next.product.status = original.product.status;
  const { payload } = (await db.query("SELECT payload FROM public.catalog_draft_revisions WHERE draft_id=$1 AND revision=$2",
    [original.draftId, next.revision])).rows[0]!;
  payload.product.documentRevision = next.document;
  payload.publication.operations[0].revisionNo = revisionNo;
  const fingerprint = hash(json(payload));
  next.source.fingerprint = fingerprint;
  next.candidateDigest = hash(json(["catalog-candidate", 1, payload,
    [{ ...next.product.type, definitionDigest: hash("synthetic installed definition") }], previous.head]));
  next.decision.candidateDigest = next.candidateDigest;
  await db.query("SET LOCAL session_replication_role=replica");
  await db.query("UPDATE public.catalog_draft_revisions SET payload=$3,fingerprint=$4 WHERE draft_id=$1 AND revision=$2",
    [original.draftId, next.revision, payload, fingerprint]);
  await db.query("UPDATE public.catalog_draft_command_receipts SET fingerprint=$3 WHERE draft_id=$1 AND revision=$2",
    [original.draftId, next.revision, fingerprint]);
  await db.query("SET LOCAL session_replication_role=origin");
  await documentRow(db, next);
  await insertGraph(db, next, { inherited: refs, onlyNew: true, existingDocument: true });
  return next;
}
const references = async (db: Db, head: Graph["head"]) =>
  (JSON.parse(await publicationManifestText(db as Pool, head)) as { skus: CatalogSkuRevisionRef[] }).skus;
const issueOf = (head: Graph["head"], productId: string, revisionId: string, kind = "compared") =>
  ({ kind, productId, ...head, skuRevisionId: revisionId });

// Earlier modes, including overlapping faults, a moved head, a foreign cursor and collation variants.
async function goldenMatrix(db: Db, offer: string, collation = true) {
  const results: string[] = [];
  const record = async (args: unknown[], sql = readerSql) => results.push(`${JSON.stringify(args)} ${await text(db, args, sql)}`);
  for (const mode of [null, "one_time", "subscription", "unknown", "", "ADMISSION_ISSUE", "admission_issue ", "Admission_issue"]) {
    const next = [null, "one_time", "subscription"].includes(mode)
      ? JSON.parse(await text(db, [offer, null, 1, mode])).value?.nextCursor ?? null : null;
    for (const args of [[offer, null, 1, mode], [offer, null, 100, mode], [offer, next, 1, mode], ["test:never-issued", null, 1, mode],
      ["", null, 0, mode], [offer, { skuId: "not-a-uuid" }, 101, mode], [offer, next && { ...next, headDigest: "f".repeat(64) }, 1, mode],
      [offer, next && { ...next, offerVersion: "test:other" }, 1, mode], [offer, { selectedSkuId: fixedId(1) }, 1, mode],
      [null, null, null, mode]]) await record(args);
  }
  if (collation) for (const mode of ["ADMISSION_ISSUE", "ONE_TIME", "one_time"]) {
    await record([offer, null, 1, mode], "SELECT public.catalog_offer_memberships_page($1,$2,$3,$4 COLLATE issue_ci)::pg_catalog.text AS result");
  }
  return results;
}

async function functionFacts(db: Db) {
  return (await db.query(`SELECT p.oid::pg_catalog.text AS oid, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile,
      p.proisstrict, p.proparallel, p.proconfig, p.proacl::pg_catalog.text AS acl, p.prorettype::pg_catalog.regtype::pg_catalog.text AS returns,
      pg_catalog.pg_get_function_arguments(p.oid) AS arguments, pg_catalog.md5(p.prosrc) AS source,
      (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.rolname, pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
        ORDER BY r.rolname) FROM pg_catalog.pg_roles r WHERE r.rolname !~ '^pg_') AS execute,
      (SELECT pg_catalog.count(*) FROM pg_catalog.pg_default_acl)::pg_catalog.int4 AS default_acls
    FROM pg_catalog.pg_proc p WHERE p.oid = $1::pg_catalog.regprocedure`, [reader])).rows[0] as Record<string, unknown>;
}
const withoutSource = ({ source: _source, ...facts }: Record<string, unknown>) => facts;

// The reader's own callees, read from the installed migration definitions.
function calleeNames() {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { baseline: { file: string }; forward: { file: string }[] };
  const bodies = new Map<string, string>();
  for (const { file } of [manifest.baseline, ...manifest.forward]) {
    for (const match of readFileSync(file, "utf8").matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_0-9]+)\([\s\S]*?\$\$([\s\S]*?)\$\$/gu)) {
      bodies.set(match[1]!, match[2]!);
    }
  }
  const seen = new Set<string>(), queue = ["catalog_offer_memberships_page"];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const call of (bodies.get(name) ?? "").matchAll(/public\.([a-z_0-9]+)\s*\(/gu)) if (bodies.has(call[1]!)) queue.push(call[1]!);
  }
  return [...seen].sort();
}

// Every transitive callee pins pg_temp last, belongs to the reader's owner and runs as its caller.
async function assertCalleeResolution(db: Db) {
  const rows = (await db.query(`SELECT p.proname, p.prosecdef, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
      (SELECT pg_catalog.substr(setting, 13) FROM pg_catalog.unnest(p.proconfig) AS setting
        WHERE pg_catalog.starts_with(setting, 'search_path=')) AS search_path
    FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::pg_catalog.regnamespace AND p.proname = ANY($1::pg_catalog.text[])
    ORDER BY p.proname`, [calleeNames()])).rows;
  expect(rows.map(row => row.proname)).toEqual(calleeNames());
  const owner = rows.find(row => row.proname === "catalog_offer_memberships_page")!.owner;
  for (const row of rows) {
    expect(row, row.proname).toMatchObject({ owner, prosecdef: row.proname === "catalog_offer_memberships_page",
      search_path: expect.stringMatching(/^(?:pg_catalog|pg_catalog, public), pg_temp$/u) });
  }
}

// Same-named temporary relations and value-rejecting temporary types ahead of the caller's path.
const shadowRelations = ["catalog_products", "catalog_skus", "catalog_publications", "catalog_publication_heads", "catalog_sku_revisions",
  "catalog_product_document_revisions", "catalog_operator_receipts", "catalog_publication_decisions", "catalog_draft_revisions",
  "catalog_draft_command_receipts", "catalog_sku_identifiers", "catalog_publication_pointer_capabilities", "platform_schema_migrations"];
async function readShadowed(caller: Pool, args: unknown[]) {
  const db = await caller.connect();
  try {
    await db.query("SET search_path = pg_temp, public, pg_catalog");
    for (const name of shadowRelations) await db.query(`CREATE TEMP TABLE ${name}(id pg_catalog.uuid)`);
    for (const type of ["jsonb", "text", "uuid"]) {
      await db.query(`CREATE DOMAIN pg_temp.${type} AS pg_catalog.${type} CHECK (VALUE IS NULL)`);
    }
    await expect(db.query("SELECT '{}'::jsonb")).rejects.toMatchObject({ code: "23514" });
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try { return JSON.parse(await text(db, args)); } finally { await db.query("ROLLBACK"); }
  } finally { db.release(true); }
}

// One RR READ ONLY page with the caller's own login, its session facts and the locks it holds.
async function readAsCaller(caller: Pool, observer: Db, args: unknown[]) {
  const db = await caller.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const session = (await db.query(`SELECT current_user = session_user AS own_login, pg_catalog.pg_backend_pid() AS pid,
      (SELECT rolsuper OR rolbypassrls OR rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user) AS elevated`)).rows[0]!;
    const result = JSON.parse(await text(db, args));
    const locks = (await observer.query(`SELECT locktype, mode FROM pg_catalog.pg_locks
      WHERE pid = $1 AND NOT (locktype = 'virtualxid' AND mode = 'ExclusiveLock') AND NOT (locktype = 'relation' AND mode = 'AccessShareLock')`,
    [session.pid])).rows;
    return { session: { own_login: session.own_login, elevated: session.elevated }, result, locks };
  } finally { await db.query("ROLLBACK"); db.release(); }
}

// The continuation binding as the reader computes it, used to build otherwise valid tokens.
async function binding(db: Db, offer: string, selection: string, limit: number, offset: number, headDigest: string) {
  return (await db.query(`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array($1::pg_catalog.text,
      pg_catalog.to_jsonb($2::pg_catalog.text), 'admission_issue'::pg_catalog.text, $3::pg_catalog.int4, $4::pg_catalog.int4,
      $5::pg_catalog.text)::pg_catalog.text, 'UTF8')), 'hex') AS value`, [offer, selection, limit, offset, headDigest])).rows[0]!.value as string;
}

// Per-transaction counters: helper calls, and rows read from the sealed revision table.
async function counters(db: PoolClient) {
  const row = (await db.query(`SELECT
      coalesce(pg_catalog.pg_stat_get_xact_function_calls($1::pg_catalog.regprocedure), 0) AS evidence,
      coalesce(pg_catalog.pg_stat_get_xact_function_calls($2::pg_catalog.regprocedure), 0) AS manifests,
      (SELECT t.seq_tup_read + coalesce(t.idx_tup_fetch, 0) FROM pg_catalog.pg_stat_xact_user_tables t
        WHERE t.relid = 'public.catalog_sku_revisions'::pg_catalog.regclass) AS revisions`,
  ["public.catalog_publication_selected_evidence(uuid,uuid)", "public.catalog_publication_read_manifest(uuid,text,text)"])).rows[0]!;
  return { evidence: Number(row.evidence), manifests: Number(row.manifests), revisions: Number(row.revisions) };
}
async function measure(db: PoolClient, offer: string, cursor: unknown, limit: number) {
  const before = await counters(db), result = await read(db, offer, cursor, limit), after = await counters(db);
  return { result, evidence: after.evidence - before.evidence, manifests: after.manifests - before.manifests,
    revisions: after.revisions - before.revisions };
}
// The selection refusal follows the roster, digest and offset steps and precedes page evidence.
async function rosterOnly(db: PoolClient, offer: string, limit: number) {
  const value = await measure(db, offer, { selectedSkuId: fixedId(999) }, limit);
  expect(value.result).toEqual(ineligible);
  return value;
}
async function headCount(db: PoolClient) {
  const heads = Number((await db.query("SELECT pg_catalog.count(*) FROM public.catalog_publication_heads")).rows[0]!.count);
  const before = await counters(db);
  await db.query("SELECT public.catalog_publication_read_head()");
  // read_head validates each current head manifest once.
  expect((await counters(db)).manifests - before.manifests).toBe(heads);
  return heads;
}
// A fresh superuser backend has no cached plans. Without sequential scans the row counter counts the reader's
// lookups, not a planner choice to scan a small table.
async function measuring(work: (db: PoolClient) => Promise<void>) {
  const own = new Pool({ connectionString: container.connectionString, max: 1 });
  const db = await own.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL track_functions = 'pl'");
    await db.query("SET LOCAL enable_seqscan = off");
    await work(db);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    db.release(true);
    await own.end();
  }
}

beforeAll(async () => {
  container = await runPostgresContainer({ name: `admission-issue-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Admission issue witnesses require PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  await pool.query(`CREATE ROLE service_role; CREATE ROLE unrelated LOGIN PASSWORD '${password}';
    CREATE ROLE issue_caller LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'; GRANT service_role TO issue_caller;
    CREATE COLLATION issue_ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { baseline: { file: string }; forward: { file: string }[] };
  const reads = "db/platform/migrations/20261124120000_catalog_publication_reads.sql";
  const readiness = "db/platform/migrations/20261124140000_catalog_publication_readiness.sql";
  for (const { file } of [manifest.baseline, ...manifest.forward.slice(0, manifest.forward.findIndex(unit => unit.file === reads))]) {
    await pool.query(readFileSync(file, "utf8"));
  }
  await pool.query(readFileSync(reads, "utf8"));
  await pool.query(readFileSync(readiness, "utf8"));
  await installCatalogueReadGrants(pool);
  await installPublicationActors(pool);
  await installAfter(pool, readiness, file => file === forward);
  await pool.query(`ALTER ROLE openlup_catalog_publication PASSWORD '${password}'`);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, [pool, ...pools]), postgresTeardownTimeoutMs);

// Replace the reader inside a transaction, compare the earlier modes before and after, then roll back.
async function acrossForward(matrix: (db: PoolClient) => Promise<string[]>, afterwards?: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const facts = await functionFacts(db), before = await matrix(db);
    expect(before.length).toBeGreaterThan(80);
    await db.query(readFileSync(forward, "utf8"));
    expect(await matrix(db)).toEqual(before);
    const replaced = await functionFacts(db);
    expect(withoutSource(replaced)).toEqual(withoutSource(facts));
    expect(replaced.source).not.toBe(facts.source);
    await afterwards?.(db);
  } finally { await db.query("ROLLBACK"); db.release(); }
}

it("keeps every earlier mode byte for byte with the same function identity, grants and settings", async () => {
  await acrossForward(db => goldenMatrix(db, "test:golden"), async db => {
    expect(await read(db, "test:golden", { selectedSkuId: fixedId(1) })).toEqual(refusal("unknown_offer"));
  });
  const golden = "test:golden";
  const [drifting, missingHead] = await transaction(pool, async db => {
    const first = await seed(db, { offer: golden, id: fixedId(1), extra: 1 });
    await seed(db, { offer: golden, id: fixedId(2), subscription: false });
    await seed(db, { offer: golden, id: fixedId(3), admitted: false });
    await seed(db, { offer: golden, id: fixedId(4), productActive: false });
    await seed(db, { offer: "test:denied-only", admitted: false });
    return [first, await seed(db, { offer: "test:golden-other" })];
  });
  await acrossForward(async db => {
    const results = [...await goldenMatrix(db, golden), ...await goldenMatrix(db, "test:denied-only", false)];
    await db.query("SAVEPOINT drift");
    await db.query("UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{memberships}','[]') WHERE id=$1", [drifting.skuId]);
    results.push(...(await goldenMatrix(db, golden, false)).slice(0, 30));
    await db.query("ROLLBACK TO SAVEPOINT drift");
    await db.query("SAVEPOINT missing_head");
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [missingHead.productId]);
    results.push(...(await goldenMatrix(db, golden, false)).slice(0, 30));
    await db.query("ROLLBACK TO SAVEPOINT missing_head");
    return results;
  });
  await pool.query(readFileSync(forward, "utf8"));
});

it("returns the original issue and the current head across two document carries, with least disclosure", async () => {
  const offer = "test:lineage";
  const seeded = await transaction(pool, async db => {
    const carried = await seed(db, { offer, id: fixedId(110) });
    const refs = await references(db, carried.head);
    const second = await carry(db, carried, carried, refs, 2);
    const third = await carry(db, second, carried, refs, 3);
    const denied = await seed(db, { offer, id: fixedId(111), admitted: false });
    const inactive = await seed(db, { offer, id: fixedId(112), productActive: false });
    const alternate = await seed(db, { offer, id: fixedId(113) });
    const standalone = await seed(db, { offer, id: fixedId(114), subscription: false });
    const governed = await seed(db, { offer, id: fixedId(115), lifecycle: true });
    const active = await graph(db, { ...fixture(), skuId: fixedId(116) }, null, true, { lifecycle: "active", subscriptionEligible: true });
    active.facts.memberships = [{ offerVersion: offer, admitted: true }];
    await insertGraph(db, active);
    const withdrawn = await graph(db, { productId: active.productId, skuId: active.skuId, draftId: active.draftId, documentId: active.documentId },
      active.head, true, { lifecycle: "withdrawn" });
    withdrawn.facts.memberships = active.facts.memberships;
    await insertGraph(db, withdrawn);
    const unrelated = await seed(db, { offer: "test:lineage-other", id: fixedId(117) });
    return { carried, third, denied, inactive, alternate, standalone, governed, withdrawn, unrelated };
  });
  const { carried, third, denied, inactive, alternate, standalone, governed, withdrawn } = seeded;
  expect(carried.document.digest).not.toBe(third.document.digest);
  const expectedIssues = (declaring: string) => [
    issueOf(carried.head, carried.productId, carried.skuRevisionId),
    issueOf(denied.head, denied.productId, denied.skuRevisionId), issueOf(inactive.head, inactive.productId, inactive.skuRevisionId),
    issueOf(alternate.head, alternate.productId, alternate.skuRevisionId),
    issueOf(standalone.head, standalone.productId, standalone.skuRevisionId), issueOf(governed.head, governed.productId, governed.skuRevisionId),
    issueOf(withdrawn.head, withdrawn.productId, withdrawn.skuRevisionId),
  ].map((issue, index) => [110, 111, 112, 113, 114, 115, 116][index] === Number(declaring.slice(-3)) ? { ...issue, kind: "declaring" } : issue);
  const heads = [[carried.productId, third.head], [denied.productId, denied.head], [inactive.productId, inactive.head],
    [alternate.productId, alternate.head], [standalone.productId, standalone.head], [governed.productId, governed.head],
    [withdrawn.productId, withdrawn.head]].map(([productId, head]) => ({ productId, ...(head as Graph["head"]) }))
    .sort((left, right) => left.productId < right.productId ? -1 : 1);
  for (const selection of [fixedId(110), fixedId(113), fixedId(115)]) {
    expect(await read(pool, offer, { selectedSkuId: selection })).toEqual({ kind: "page", value: {
      issues: expectedIssues(selection), consultedHeads: heads, rosterCount: 7, nextCursor: null } });
  }
  for (const selection of [fixedId(111), fixedId(112), fixedId(114), fixedId(116), fixedId(117), fixedId(999)]) {
    expect(await read(pool, offer, { selectedSkuId: selection }), selection).toEqual(ineligible);
  }
  // The other two audiences receive the same projection through the same owner boundary.
  const expected = await read(pool, offer, { selectedSkuId: fixedId(110) });
  for (const caller of [login("issue_caller"), login("openlup_catalog_publication")]) {
    expect((await readAsCaller(caller, pool, [offer, { selectedSkuId: fixedId(110) }, 100, "admission_issue"])).result).toEqual(expected);
  }
});

it("validates one closed input before reading and refuses each malformed or mismatched value", async () => {
  const offer = "test:inputs";
  const seeded = await transaction(pool, async db => [await seed(db, { offer, id: fixedId(201) }), await seed(db, { offer, id: fixedId(202) })]);
  const first = await read(pool, offer, { selectedSkuId: fixedId(201) }, 1);
  const token = first.value.nextCursor;
  expect(token).toEqual({ selectedSkuId: fixedId(201), offset: 1, offerVersion: offer, mode: "admission_issue",
    headDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), limit: 1, binding: await binding(pool, offer, fixedId(201), 1, 1, token.headDigest) });
  const continued = (change: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) =>
    ({ selectedSkuId: fixedId(201), continuation: { ...token, ...change }, ...outer });
  const { continuation: _drop, ...pageOne } = continued();
  const invalidRequests: [unknown, unknown, unknown][] = [
    [offer, null, 1], [offer, "null", 1], [offer, "[]", 1], [offer, {}, 1], [offer, { selectedSkuId: null }, 1],
    [offer, { selectedSkuId: "abcdef00-0000-4000-8000-000000000201".toUpperCase() }, 1], [offer, { selectedSkuId: 201 }, 1], [offer, { ...pageOne, extra: true }, 1],
    [offer, { ...pageOne, continuation: null }, 1], [offer, { ...pageOne, continuation: [] }, 1],
    [offer, continued({ extra: 1 }), 1], [offer, { ...pageOne, continuation: (({ limit: _limit, ...rest }) => rest)(token) }, 1],
    [offer, continued({ selectedSkuId: fixedId(202) }), 1], [offer, continued({}, { selectedSkuId: fixedId(202) }), 1],
    [offer, continued({ offerVersion: "test:other" }), 1], [offer, continued({ mode: "one_time" }), 1],
    [offer, continued({ limit: 2 }), 1], [offer, continued(), 2], [offer, continued({ limit: "1" }), 1],
    [offer, continued({ offset: 0 }), 1], [offer, continued({ offset: 500, limit: 100 }), 100], [offer, continued({ offset: 1.5 }), 1],
    [offer, continued({ offset: "1" }), 1], [offer, continued({ offset: 2, limit: 3 }), 3], [offer, continued({ offset: -1 }), 1],
    [offer, continued({ headDigest: token.headDigest.toUpperCase() }), 1], [offer, continued({ headDigest: "f".repeat(63) }), 1],
    [offer, { ...pageOne, continuation: (({ binding: _binding, ...rest }) => rest)(token) }, 1], [offer, continued({ binding: null }), 1],
    [offer, continued({ binding: token.binding.toUpperCase() }), 1], [offer, continued({ binding: "f".repeat(63) }), 1],
    // Shape refusals precede the digest step.
    [offer, continued({ limit: 101, headDigest: "f".repeat(64) }), 1], [offer, continued({ offset: 500, headDigest: "f".repeat(64) }), 1],
    [offer, pageOne, 0], [offer, pageOne, 101], [offer, pageOne, null], ["", pageOne, 1], [" padded", pageOne, 1],
    ["x".repeat(241), pageOne, 1], [`${"x".repeat(239)}\u{1F600}`, pageOne, 1], [null, pageOne, 1],
  ];
  for (const [offerValue, cursor, limit] of invalidRequests) {
    expect(await read(pool, offerValue, cursor, limit), JSON.stringify([offerValue, cursor, limit])).toEqual(invalid);
  }
  // A number written with a fractional part is mistyped even when its value is whole.
  expect(await read(pool, offer, JSON.stringify(continued()).replace('"offset":1,', '"offset":1.0,'), 1)).toEqual(invalid);
  for (const unknown of ["x".repeat(240), `${"x".repeat(238)}\u{1F600}`, "test:never-issued"]) {
    expect(await read(pool, unknown, pageOne, 1)).toEqual(refusal("unknown_offer"));
  }
  expect(await read(pool, offer, continued({ headDigest: "f".repeat(64) }), 1)).toEqual(refusal("head_moved"));
  // An aligned offset outside the roster is refused at the offset step, with a valid binding and a current digest.
  const outside = { offset: 2, binding: await binding(pool, offer, fixedId(201), 1, 2, token.headDigest) };
  expect(await read(pool, offer, continued(outside), 1)).toEqual(invalid);
  expect(await read(pool, offer, continued({ ...outside, headDigest: "f".repeat(64) }), 1)).toEqual(refusal("head_moved"));
  // A digest mismatch precedes the offset and selection checks.
  expect(await read(pool, offer, { selectedSkuId: fixedId(999), continuation: { ...token, selectedSkuId: fixedId(999), offset: 3, limit: 1,
    headDigest: "f".repeat(64) } }, 1)).toEqual(refusal("head_moved"));
  expect(await read(pool, offer, continued(), 1)).toMatchObject({ kind: "page", value: { rosterCount: 2, nextCursor: null,
    issues: [{ kind: "compared", skuRevisionId: seeded[1]!.skuRevisionId }] } });
  for (const [limit, count] of [[1, 2], [100, 2], [2, 2]] as const) {
    expect((await read(pool, offer, pageOne, limit)).value.issues).toHaveLength(Math.min(limit, count));
  }
  // Collation cannot reroute the mode: only the exact bytes take the admission branch.
  const collated = "SELECT public.catalog_offer_memberships_page($1,$2,$3,$4 COLLATE issue_ci)::pg_catalog.text AS result";
  expect(JSON.parse(await text(pool, [offer, pageOne, 1, "admission_issue"], collated))).toMatchObject({ kind: "page" });
  expect(JSON.parse(await text(pool, [offer, pageOne, 1, "ADMISSION_ISSUE"], collated))).toEqual(invalid);
});

type Token = { offset: number; headDigest: string; binding: string; limit: number };

it("enforces the roster and page caps before resolving evidence and walks a complete cursor chain", async () => {
  const offer = "test:caps";
  await measuring(async db => {
    const large = await seed(db, { offer, id: fixedId(300), extra: 499 });
    await seed(db, { offer: "test:caps-baseline", id: fixedId(302) });
    let token: Token | null = null, last: Token | null = null, offset = 0, declaring = 0;
    const revisions = new Set<string>();
    for (let page = 1; page <= 20; page++) {
      if (page === 20) last = token;
      const result = await read(db, offer, token === null ? { selectedSkuId: large.skuId } : { selectedSkuId: large.skuId, continuation: token }, 25);
      expect(result.value.rosterCount).toBe(500);
      expect(result.value.issues).toHaveLength(25);
      expect(result.value.consultedHeads).toEqual([{ productId: large.productId, ...large.head }]);
      for (const issue of result.value.issues) { revisions.add(issue.skuRevisionId); declaring += Number(issue.kind === "declaring"); }
      offset += 25;
      token = result.value.nextCursor;
      expect(token === null ? null : token.offset).toBe(page === 20 ? null : offset);
    }
    expect([revisions.size, declaring]).toEqual([500, 1]);
    // The genuine token issued for offset 475 serves the last page again.
    expect(last!.offset).toBe(475);
    expect((await read(db, offer, { selectedSkuId: large.skuId, continuation: last }, 25)).value)
      .toMatchObject({ rosterCount: 500, nextCursor: null, issues: expect.any(Array) });
    // An unaligned offset inside the roster, with a valid binding for it, is refused at the offset step after the digest.
    const at = async (offset: number, headDigest = last!.headDigest) => ({ selectedSkuId: large.skuId,
      continuation: { ...last, offset, headDigest, binding: await binding(db, offer, large.skuId, 25, offset, headDigest) } });
    for (const offset of [26, 490]) {
      expect(await read(db, offer, await at(offset), 25)).toEqual(invalid);
      expect(await read(db, offer, await at(offset, "f".repeat(64)), 25)).toEqual(refusal("head_moved"));
    }
    expect(await read(db, offer, await at(500), 25)).toEqual(invalid);
    // Both caps refuse before any evidence read: no helper call, manifest or sealed revision beyond the roster check.
    const heads = await headCount(db);
    const baseline = await rosterOnly(db, "test:caps-baseline", 25);
    expect({ evidence: baseline.evidence, manifests: baseline.manifests }).toEqual({ evidence: 0, manifests: heads });
    expect((await rosterOnly(db, offer, 25)).revisions).toBe(baseline.revisions);
    const pageCap = await measure(db, offer, { selectedSkuId: large.skuId }, 24);
    expect(pageCap.result).toEqual(refusal("inconsistent_evidence", "catalog_admission_page_cap_exceeded"));
    expect([pageCap.evidence, pageCap.manifests - heads, pageCap.revisions - baseline.revisions]).toEqual([0, 0, 0]);
    await seed(db, { offer, id: fixedId(301) });
    const capped = await headCount(db), cappedBaseline = await rosterOnly(db, "test:caps-baseline", 25);
    expect({ evidence: cappedBaseline.evidence, manifests: cappedBaseline.manifests }).toEqual({ evidence: 0, manifests: capped });
    for (const limit of [1, 25, 100]) {
      const over = await measure(db, offer, { selectedSkuId: large.skuId }, limit);
      expect(over.result).toEqual(refusal("inconsistent_evidence", "catalog_admission_membership_cap_exceeded"));
      expect([over.evidence, over.manifests - capped, over.revisions - cappedBaseline.revisions]).toEqual([0, 0, 0]);
    }
  });
}, 120_000);

it("binds each continuation to the request's offer, selection and page size and to its offset", async () => {
  const offer = "test:bind", twin = "test:bind-twin";
  await transaction(pool, async db => { for (let index = 210; index <= 215; index++) await seed(db, { offer, also: twin, id: fixedId(index) }); });
  const token: Token = (await read(pool, offer, { selectedSkuId: fixedId(210) }, 2)).value.nextCursor;
  expect(token).toMatchObject({ offset: 2, limit: 2, binding: await binding(pool, offer, fixedId(210), 2, 2, token.headDigest) });
  // The twin offer lists the same products, so it has the same head digest.
  expect((await read(pool, twin, { selectedSkuId: fixedId(210) }, 2)).value.nextCursor.headDigest).toBe(token.headDigest);
  expect(await read(pool, offer, { selectedSkuId: fixedId(210), continuation: token }, 2))
    .toMatchObject({ kind: "page", value: { rosterCount: 6, nextCursor: { offset: 4 } } });
  const rewrites: [string, string, Partial<Token> & Record<string, unknown>, number][] = [
    [offer, fixedId(211), { selectedSkuId: fixedId(211) }, 2], [twin, fixedId(210), { offerVersion: twin }, 2],
    [offer, fixedId(210), { limit: 1 }, 1], [offer, fixedId(210), { offset: 4 }, 2],
  ];
  for (const [at, selection, change, limit] of rewrites) {
    // Each consistent rewrite keeps the original binding and is refused without a page.
    const rewritten = { ...token, ...change };
    expect(await read(pool, at, { selectedSkuId: selection, continuation: rewritten }, limit), JSON.stringify(change)).toEqual(invalid);
    // With its own binding the same rewrite is served, so the binding alone refuses it.
    const rebound = { ...rewritten, binding: await binding(pool, at, selection, limit, rewritten.offset, rewritten.headDigest) };
    expect(await read(pool, at, { selectedSkuId: selection, continuation: rebound }, limit), JSON.stringify(change)).toMatchObject({ kind: "page" });
  }
});

it("reuses the head authentication and resolves only the page's sealed revisions", async () => {
  await measuring(async db => {
    // A fresh head that issued twenty members, read one member per page.
    const fresh = await seed(db, { offer: "test:fresh-head", id: fixedId(400), extra: 19 });
    // Five members issued by one earlier publication, read as one page under a later head.
    const earlier = await seed(db, { offer: "test:shared-issuer", id: fixedId(410), extra: 4 });
    const moved = await carry(db, earlier, earlier, await references(db, earlier.head), 2);
    await seed(db, { offer: "test:roster-baseline", id: fixedId(420) });
    const heads = await headCount(db);
    const baseline = await rosterOnly(db, "test:roster-baseline", 1);
    expect({ evidence: baseline.evidence, manifests: baseline.manifests }).toEqual({ evidence: 0, manifests: heads });
    // The roster reads do not depend on the offer, so one baseline serves both offers.
    for (const [offer, limit] of [["test:fresh-head", 1], ["test:shared-issuer", 5]] as const) {
      expect((await rosterOnly(db, offer, limit)).revisions).toBe(baseline.revisions);
    }
    const one = await measure(db, "test:fresh-head", { selectedSkuId: fixedId(400) }, 1);
    expect(one.result).toMatchObject({ kind: "page", value: { rosterCount: 20,
      issues: [issueOf(fresh.head, fresh.productId, fresh.skuRevisionId, "declaring")], consultedHeads: [{ productId: fresh.productId, ...fresh.head }] } });
    expect([one.evidence, one.manifests - heads, one.revisions - baseline.revisions]).toEqual([0, 0, 1]);
    const shared = await measure(db, "test:shared-issuer", { selectedSkuId: fixedId(410) }, 5);
    expect(shared.result.value.issues).toHaveLength(5);
    expect(new Set(shared.result.value.issues.map((issue: { publicationId: string }) => issue.publicationId))).toEqual(new Set([earlier.head.publicationId]));
    expect(shared.result.value.consultedHeads).toEqual([{ productId: earlier.productId, ...moved.head }]);
    // The shared earlier issuer is authenticated once.
    expect([shared.evidence, shared.manifests - heads, shared.revisions - baseline.revisions]).toEqual([0, 1, 5]);
    // The head's product-bound document no longer matches the head manifest; the document join is intact.
    await db.query("SAVEPOINT head_document");
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query("UPDATE public.catalog_product_document_revisions SET digest=$2 WHERE id=$1", [fresh.document.id, hash("damaged head document")]);
    await db.query("SET LOCAL session_replication_role=origin");
    expect(await read(db, "test:fresh-head", { selectedSkuId: fixedId(400) }, 1)).toEqual(refusal("inconsistent_evidence"));
    await db.query("ROLLBACK TO SAVEPOINT head_document");
    expect((await read(db, "test:fresh-head", { selectedSkuId: fixedId(400) }, 1)).kind).toBe("page");
  });
});

it("refuses each membership drift and earlier issue fault without a page", async () => {
  const offer = "test:faults";
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const issued = await seed(db, { offer, id: fixedId(800), extra: 1 });
    await carry(db, issued, issued, await references(db, issued.head), 2);
    const fresh = await seed(db, { offer, id: fixedId(801) });
    const outside = await seed(db, { offer: "test:faults-outside", id: fixedId(802) });
    const args = [offer, { selectedSkuId: fixedId(801) }, 100] as const;
    expect(await read(db, ...args)).toMatchObject({ kind: "page", value: { rosterCount: 3 } });
    const fault = async (name: string, damage: () => Promise<unknown>, expected: unknown) => {
      await db.query(`SAVEPOINT ${name}`);
      try {
        await damage();
        expect(await read(db, ...args), name).toEqual(expected);
      } finally { await db.query(`ROLLBACK TO SAVEPOINT ${name}`); }
      expect((await read(db, ...args)).kind, name).toBe("page");
    };
    const drift = refusal("inconsistent_evidence", "catalog_publication_live_drift");
    // A sealed member that the live catalogue no longer lists.
    await fault("sealed_only", () => db.query(`UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{memberships}','[]')
      WHERE id=$1`, [fixedId(801)]), drift);
    // A live member that its sealed revision does not list.
    await fault("live_only", () => db.query(`UPDATE public.catalog_skus SET publication_facts=jsonb_set(publication_facts,'{memberships}',$2::jsonb)
      WHERE id=$1`, [outside.skuId, json([{ offerVersion: offer, admitted: true }, { offerVersion: "test:faults-outside", admitted: true }])]), drift);
    // The earlier issuing manifest still authenticates but references another revision of the member.
    const issuingReference = async () => {
      await db.query("SET LOCAL session_replication_role=replica");
      await db.query(`WITH changed AS (
          SELECT public.catalog_publication_canonical(pg_catalog.jsonb_set(p.canonical_state::jsonb, '{skus}', (
            SELECT pg_catalog.jsonb_agg(CASE WHEN r->'skuId' = pg_catalog.to_jsonb($2::text)
              THEN pg_catalog.jsonb_set(r, '{digest}', pg_catalog.to_jsonb($3::text)) ELSE r END ORDER BY position)
            FROM pg_catalog.jsonb_array_elements(p.canonical_state::jsonb->'skus') WITH ORDINALITY AS refs(r, position))), 0) AS state
          FROM public.catalog_publications p WHERE p.id=$1)
        UPDATE public.catalog_publications p SET canonical_state=c.state,
          digest=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.state, 'UTF8')), 'hex') FROM changed c WHERE p.id=$1`,
      [issued.head.publicationId, fixedId(800), hash("another revision")]);
      await db.query("SET LOCAL session_replication_role=origin");
      expect((await db.query(`SELECT public.catalog_publication_read_manifest(product_id, canonical_state, digest) IS NOT NULL AS valid
        FROM public.catalog_publications WHERE id=$1`, [issued.head.publicationId])).rows).toEqual([{ valid: true }]);
    };
    await fault("issuing_reference", issuingReference, refusal("inconsistent_evidence"));
    // The earlier issuing publication's document no longer matches its manifest; the document join is intact.
    await fault("issuing_document", async () => {
      await db.query("SET LOCAL session_replication_role=replica");
      await db.query("UPDATE public.catalog_product_document_revisions SET digest=$2 WHERE id=$1", [issued.document.id, hash("damaged issue document")]);
      await db.query("SET LOCAL session_replication_role=origin");
    }, refusal("inconsistent_evidence"));
    // A head document mismatch on one product and a wrong earlier reference on another, applied in both orders.
    // Order among page faults is unobservable because they share one refusal value.
    const headDocument = async () => {
      await db.query("SET LOCAL session_replication_role=replica");
      await db.query("UPDATE public.catalog_product_document_revisions SET digest=$2 WHERE id=$1", [fresh.document.id, hash("damaged head document")]);
      await db.query("SET LOCAL session_replication_role=origin");
    };
    for (const [first, second] of [[headDocument, issuingReference], [issuingReference, headDocument]]) {
      await db.query("SAVEPOINT first_fault");
      await first!();
      await db.query("SAVEPOINT second_fault");
      await second!();
      expect(await read(db, ...args)).toEqual(refusal("inconsistent_evidence"));
      // Repairing either fault leaves the other, which still refuses alone; repairing both serves the page.
      await db.query("ROLLBACK TO SAVEPOINT second_fault");
      expect(await read(db, ...args)).toEqual(refusal("inconsistent_evidence"));
      await db.query("ROLLBACK TO SAVEPOINT first_fault");
      await db.query("RELEASE SAVEPOINT first_fault");
      expect((await read(db, ...args)).kind).toBe("page");
    }
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("completes a pinned REPEATABLE READ chain after a peer publication and refuses it in a fresh snapshot", async () => {
  const offer = "test:motion";
  const [left, right, outside] = await transaction(pool, async db => [await seed(db, { offer, id: fixedId(500) }),
    await seed(db, { offer, id: fixedId(501) }), await seed(db, { offer: "test:motion-other", id: fixedId(502) })]);
  const reader = await pool.connect();
  let next: unknown, moved!: Graph;
  try {
    await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const first = await read(reader, offer, { selectedSkuId: left.skuId }, 1);
    next = { selectedSkuId: left.skuId, continuation: first.value.nextCursor };
    await transaction(pool, async db => carry(db, outside, outside, await references(db, outside.head), 2));
    expect((await read(pool, offer, next, 1)).kind).toBe("page");
    moved = await transaction(pool, async db => carry(db, right, right, await references(db, right.head), 2));
    expect(await read(reader, offer, next, 1)).toEqual({ kind: "page", value: { rosterCount: 2, nextCursor: null,
      issues: [issueOf(right.head, right.productId, right.skuRevisionId)], consultedHeads: [{ productId: right.productId, ...right.head }] } });
    expect(moved.head).not.toEqual(right.head);
  } finally { await reader.query("ROLLBACK"); reader.release(); }
  // A fresh snapshot refuses the earlier chain, then serves a new chain from page one.
  expect(await read(pool, offer, next, 1)).toEqual(refusal("head_moved"));
  const restarted = { selectedSkuId: left.skuId, continuation: (await read(pool, offer, { selectedSkuId: left.skuId }, 1)).value.nextCursor };
  expect((await read(pool, offer, restarted, 1)).value.consultedHeads).toEqual([{ productId: right.productId, ...moved.head }]);
});

it("runs as each granted login in REPEATABLE READ READ ONLY, takes no explicit locks and ignores caller shadows", async () => {
  const offer = "test:lineage";
  const args = [offer, { selectedSkuId: fixedId(110) }, 100, "admission_issue"];
  const expected = await read(pool, offer, { selectedSkuId: fixedId(110) });
  const census = async () => (await pool.query(`SELECT pg_catalog.md5(pg_catalog.string_agg(xmin::text || ctid::text, ',' ORDER BY ctid)) AS rows
    FROM (SELECT xmin, ctid FROM public.catalog_publications UNION ALL SELECT xmin, ctid FROM public.catalog_sku_revisions
      UNION ALL SELECT xmin, ctid FROM public.catalog_skus UNION ALL SELECT xmin, ctid FROM public.catalog_products) census`)).rows;
  const rows = await census();
  for (const caller of [login("issue_caller"), login("openlup_catalog_publication")]) {
    expect(await readAsCaller(caller, pool, args)).toEqual({ session: { own_login: true, elevated: false }, result: expected, locks: [] });
    expect(await readShadowed(caller, args)).toEqual(expected);
    for (const helper of ["catalog_publication_selected_evidence(NULL,NULL)", "catalog_publication_read_head()"]) {
      await expect(caller.query(`SELECT public.${helper}`)).rejects.toMatchObject({ code: "42501" });
    }
  }
  await expect(login("issue_caller").query("SELECT 1 FROM public.catalog_publications LIMIT 1")).rejects.toMatchObject({ code: "42501" });
  await expect(login("unrelated").query(readerSql, args)).rejects.toMatchObject({ code: "42501" });
  expect(await census()).toEqual(rows);
  await assertCalleeResolution(pool);
  expect((await pool.query(`SELECT pg_catalog.has_schema_privilege('issue_caller','public','CREATE') AS caller,
    pg_catalog.has_schema_privilege('openlup_catalog_publication','public','CREATE') AS publication,
    EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
      WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE') AS anyone`)).rows)
    .toEqual([{ caller: false, publication: false, anyone: false }]);
});

// The upgraded installation keeps the earlier modes and installed identity; a fresh installation matches it.
it.each(profiles)("upgrades and serves admission issues on the installed %s rail", async profile => {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (manifest?.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
  const prefix = structuredClone(manifest);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) plan.forward = plan.forward.slice(0, plan.forward.findIndex(unit => unit.file === forward));
  const store = await withPlatformCatalog(prefix, root => installAccountMutations(profile, true, "admission-issue", root));
  const fresh = await installAccountMutations(profile, false, "admission-issue-fresh").catch(async error => { await store.close(); throw error; });
  const local: Pool[] = [];
  try {
    const offer = "test:rail";
    await installPublicationActors(store.owner);
    const [first, second] = await transaction(store.owner, async db => [await seed(db, { offer, id: fixedId(600) }),
      await seed(db, { offer, id: fixedId(601), admitted: false }), await seed(db, { offer, id: fixedId(602), extra: 1 })]);
    const callers = [store.runtime];
    const publication = (await store.owner.query("SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname='openlup_catalog_publication'")).rows[0];
    if (publication?.rolcanlogin) {
      await store.owner.query(`ALTER ROLE openlup_catalog_publication PASSWORD '${password}'`);
      const url = new URL((store.runtime.options as { connectionString: string }).connectionString);
      url.username = "openlup_catalog_publication"; url.password = password;
      const value = new Pool({ connectionString: url.toString(), max: 2 }); local.push(value); callers.push(value);
    }
    expect(callers).toHaveLength(profile === "bootstrap" || profile === "separate" ? 2 : 1);
    const privileges = async () => (await store.owner.query(`SELECT r.rolname, f.name,
        pg_catalog.has_function_privilege(r.oid, f.name, 'EXECUTE') AS execute
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.unnest($1::pg_catalog.text[]) AS f(name)
      WHERE r.rolname !~ '^pg_' ORDER BY 1, 2`, [[reader, "public.catalog_publication_selected_evidence(uuid,uuid)",
      "public.catalog_publication_read_head()", "public.catalog_publication_read_manifest(uuid,text,text)"]])).rows;
    const before = { facts: await functionFacts(store.owner), privileges: await privileges(),
      golden: await Promise.all(callers.map(caller => goldenMatrix(caller, offer, false))) };
    expect((await store.runner.apply()).applied[0]).toBe(forward);
    expect((await store.runner.apply()).applied).toEqual([]);
    const after = await functionFacts(store.owner);
    expect(withoutSource(after)).toEqual(withoutSource(before.facts));
    expect(await privileges()).toEqual(before.privileges);
    expect(await Promise.all(callers.map(caller => goldenMatrix(caller, offer, false)))).toEqual(before.golden);
    const { oid: _oid, ...installed } = await functionFacts(fresh.owner);
    expect(installed).toEqual((({ oid: _drop, ...rest }) => rest)(after));
    const args = [offer, { selectedSkuId: fixedId(600) }, 100, "admission_issue"];
    const expected = { kind: "page", value: expect.objectContaining({ rosterCount: 4, nextCursor: null }) };
    for (const caller of callers) {
      const observed = await readAsCaller(caller, store.owner, args);
      expect(observed).toEqual({ session: { own_login: true, elevated: profile === "legacy" }, result: expected, locks: [] });
      expect(observed.result.value.issues[0]).toEqual(issueOf(first.head, first.productId, first.skuRevisionId, "declaring"));
      expect(observed.result.value.issues[1]).toEqual(issueOf(second.head, second.productId, second.skuRevisionId));
      expect(await readShadowed(caller, args)).toEqual(observed.result);
    }
    await assertCalleeResolution(store.owner);
    // Neither the callers, their granted roles nor PUBLIC can create in the schema the helpers search.
    const names = [...await Promise.all(callers.map(async caller => (await caller.query("SELECT current_user AS name")).rows[0]!.name as string)),
      "service_role", "openlup_catalog_publication", "anon", "authenticated"];
    expect((await store.owner.query(`SELECT r.rolname FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::pg_catalog.text[])
        AND NOT r.rolsuper AND pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE')
      UNION ALL SELECT 'PUBLIC' FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
        WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'`, [names])).rows).toEqual([]);
  } finally { await Promise.all([store.close(), fresh.close(), ...local.map(value => value.end())]); }
}, postgresSetupTimeoutMs);

it("restores a sealed catalogue into a pristine same-profile target and serves the same issues as its runtime", async () => {
  const resources = storeJourneyResources();
  try {
    const [source, targets] = await Promise.all([resources.installation("issue-source"), resources.targetTemplate("issue-target")]);
    const target = await targets.nextTarget("issue-target");
    const pristine = await captureStoreJourney(target.owner, "issue-pristine");
    const offer = "test:restore";
    await installPublicationActors(source.owner);
    const [declaring] = await transaction(source.owner, async db => [await seed(db, { offer, id: fixedId(700), lifecycle: true }),
      await seed(db, { offer, id: fixedId(701), lifecycle: true })]);
    const args = [offer, { selectedSkuId: declaring.skuId }, 100, "admission_issue"];
    const expected = JSON.parse(await text(source.runtime, args));
    expect(expected).toMatchObject({ kind: "page", value: { rosterCount: 2, nextCursor: null } });
    const packet = await captureStoreJourney(source.owner, "issue-source");
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget: pristine }))
      .toMatchObject({ replayed: false });
    expect(JSON.parse(await text(target.runtime, args))).toEqual(expected);
  } finally { await resources.close(); }
}, postgresSetupTimeoutMs);
