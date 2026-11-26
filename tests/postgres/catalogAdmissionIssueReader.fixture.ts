import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { expect } from "vitest";
import type { CatalogSkuRevisionRef } from "@openlup/platform/catalog";
import registry from "../../config/reviewed-platform-forwards.json" with { type: "json" };
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { tryLeaseTemplateDatabase, type TemplateProfile } from "../helpers/pgTemplateBroker.js";
import {
  installAccountMutations,
  type AccountMutationsInstallation,
  type AccountProfile,
} from "./customerAccountMutations.fixture.js";
import {
  documentRow,
  fixture,
  graph,
  hash,
  insertGraph,
  installPublicationActors,
  json,
  publicationManifestText,
  transaction,
  type Graph,
} from "./catalogPublicationFixture.js";

export const forward = registry.nativeStoreForwardClass.slots.find(slot => slot.path.endsWith("_catalog_admission_issue_reader.sql"))!.path;
export const reader = "public.catalog_offer_memberships_page(text,jsonb,integer,text)";
export const readerSql = "SELECT public.catalog_offer_memberships_page($1,$2,$3,$4)::pg_catalog.text AS result";
export const password = "synthetic-reader";
export type Db = Pool | PoolClient;

export const fixedId = (index: number): ReturnType<typeof randomUUID> => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
export const refusal = (reason: string, detail?: string) => detail ? { kind: "refusal", reason, detail } : { kind: "refusal", reason };
export const invalid = refusal("invalid_request");
export const ineligible = refusal("invalid_request", "catalog_admission_selection_ineligible");

export async function text(db: Db, args: unknown[], sql = readerSql) {
  return (await db.query(sql, args)).rows[0]!.result as string;
}

export async function read(db: Db, offer: unknown, cursor: unknown, limit: unknown = 100) {
  return JSON.parse(await text(db, [offer, cursor, limit, "admission_issue"]));
}

export type Seed = {
  offer: string;
  id?: ReturnType<typeof randomUUID>;
  admitted?: boolean;
  productActive?: boolean;
  skuActive?: boolean;
  standalone?: boolean;
  subscription?: boolean;
  extra?: number;
  lifecycle?: true;
  also?: string;
};

export async function seed(db: PoolClient, options: Seed) {
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
export async function carry(db: PoolClient, previous: Graph, original: Graph, refs: CatalogSkuRevisionRef[], revisionNo: number) {
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

export const references = async (db: Db, head: Graph["head"]) =>
  (JSON.parse(await publicationManifestText(db as Pool, head)) as { skus: CatalogSkuRevisionRef[] }).skus;

export const issueOf = (head: Graph["head"], productId: string, revisionId: string, kind = "compared") =>
  ({ kind, productId, ...head, skuRevisionId: revisionId });

// Earlier modes, including overlapping faults, a moved head, a foreign cursor and collation variants.
export async function goldenMatrix(db: Db, offer: string, collation = true) {
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

export async function functionFacts(db: Db) {
  return (await db.query(`SELECT p.oid::pg_catalog.text AS oid, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile,
      p.proisstrict, p.proparallel, p.proconfig, p.proacl::pg_catalog.text AS acl, p.prorettype::pg_catalog.regtype::pg_catalog.text AS returns,
      pg_catalog.pg_get_function_arguments(p.oid) AS arguments, pg_catalog.md5(p.prosrc) AS source,
      (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.rolname, pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
        ORDER BY r.rolname) FROM pg_catalog.pg_roles r WHERE r.rolname !~ '^pg_') AS execute,
      (SELECT pg_catalog.count(*) FROM pg_catalog.pg_default_acl)::pg_catalog.int4 AS default_acls
    FROM pg_catalog.pg_proc p WHERE p.oid = $1::pg_catalog.regprocedure`, [reader])).rows[0] as Record<string, unknown>;
}

export const withoutSource = ({ source: _source, ...facts }: Record<string, unknown>) => facts;

export type InstallationLogins = {
  migrationLogin?: string;
  runtimeLogin?: string;
  restoreLogin?: string;
};

function installationLogins(installation: AccountMutationsInstallation): InstallationLogins {
  if (installation.generation === "legacy") return {};
  return {
    migrationLogin: installation.migrationLogin,
    runtimeLogin: installation.runtimeLogin,
    restoreLogin: installation.restoreLogin,
  };
}

// Normalizes only the three per-installation login aliases so a broker-leased
// fresh database can be compared against an upgraded installation without
// masking any platform role (service_role, openlup_catalog_publication, anon,
// authenticated, postgres, or PUBLIC).
function roleNormalizer(logins: InstallationLogins): (role: string) => string {
  const aliases = new Map<string, string>();
  if (logins.migrationLogin && logins.migrationLogin !== "postgres") aliases.set(logins.migrationLogin, "<migration>");
  if (logins.runtimeLogin && logins.runtimeLogin !== "postgres") aliases.set(logins.runtimeLogin, "<runtime>");
  if (logins.restoreLogin && logins.restoreLogin !== "postgres") aliases.set(logins.restoreLogin, "<restore>");
  return role => aliases.get(role) ?? role;
}

function normalizeAcl(acl: unknown, mapRole: (role: string) => string): unknown {
  if (typeof acl !== "string" || !acl.startsWith("{") || !acl.endsWith("}")) return acl;
  const body = acl.slice(1, -1);
  if (!body) return acl;
  const entries = body.split(",").map(entry => {
    const match = /^([^=]*)=([^/]*)\/(.*)$/u.exec(entry);
    if (!match) return entry;
    const [, grantee, privileges, grantor] = match;
    return `${grantee ? mapRole(grantee) : ""}=${privileges}/${mapRole(grantor!)}`;
  });
  return `{${entries.join(",")}}`;
}

export function normalizeFunctionFacts(facts: Record<string, unknown>, logins: InstallationLogins): Record<string, unknown> {
  const mapRole = roleNormalizer(logins);
  const execute = Array.isArray(facts.execute)
    ? (facts.execute as [string, boolean][])
      .map(([role, allowed]) => [mapRole(role), allowed] as [string, boolean])
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
    : facts.execute;
  return {
    ...facts,
    owner: typeof facts.owner === "string" ? mapRole(facts.owner) : facts.owner,
    acl: normalizeAcl(facts.acl, mapRole),
    execute,
  };
}

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
export async function assertCalleeResolution(db: Db) {
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

export async function readShadowed(caller: Pool, args: unknown[]) {
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
export async function readAsCaller(caller: Pool, observer: Db, args: unknown[]) {
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
export async function binding(db: Db, offer: string, selection: string, limit: number, offset: number, headDigest: string) {
  return (await db.query(`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array($1::pg_catalog.text,
      pg_catalog.to_jsonb($2::pg_catalog.text), 'admission_issue'::pg_catalog.text, $3::pg_catalog.int4, $4::pg_catalog.int4,
      $5::pg_catalog.text)::pg_catalog.text, 'UTF8')), 'hex') AS value`, [offer, selection, limit, offset, headDigest])).rows[0]!.value as string;
}

// Fresh inspection is strictly read-only (only functionFacts), so all four
// broker-supported profiles can lease a sealed template database safely.
const FRESH_BROKER_PROFILES: Partial<Record<AccountProfile, TemplateProfile>> = {
  legacy: "legacy",
  bootstrap: "qualified-v2",
  separate: "qualified-v2-separate",
  "admin-managed": "qualified-admin",
};

type FreshAdmissionIssueDb = {
  owner: Pool;
  logins: InstallationLogins;
  close: () => Promise<void>;
};

async function openFreshAdmissionIssueDb(profile: AccountProfile): Promise<FreshAdmissionIssueDb> {
  const brokerProfile = FRESH_BROKER_PROFILES[profile];
  if (brokerProfile) {
    const lease = await tryLeaseTemplateDatabase(brokerProfile, "admission-issue-fresh");
    if (lease) {
      let owner: Pool;
      try {
        owner = new Pool({ connectionString: lease.ownerUrl, max: 2 });
        owner.on("error", () => {});
      } catch (error) {
        await lease.release().catch(() => {});
        throw error;
      }
      let closed = false;
      return {
        owner,
        logins: {
          migrationLogin: lease.migrationLogin,
          runtimeLogin: lease.runtimeLogin,
          restoreLogin: lease.restoreLogin,
        },
        close: async () => {
          if (closed) return;
          closed = true;
          try {
            if (!owner.ended) await owner.end();
          } finally {
            await lease.release();
          }
        },
      };
    }
  }
  const isolated = await installAccountMutations(profile, false, "admission-issue-fresh", undefined, undefined, { isolatedCluster: true });
  return {
    owner: isolated.owner,
    logins: installationLogins(isolated.installation),
    close: () => isolated.close(),
  };
}

// The upgraded installation keeps the earlier modes and installed identity; a fresh installation matches it.
export async function verifyAdmissionIssueRail(profile: AccountProfile): Promise<void> {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (manifest?.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
  const prefix = structuredClone(manifest);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
    plan.forward = plan.forward.slice(0, plan.forward.findIndex(unit => unit.file === forward));
  }
  const [storeResult, freshResult] = await Promise.allSettled([
    withPlatformCatalog(prefix, root => installAccountMutations(profile, true, "admission-issue", root)),
    openFreshAdmissionIssueDb(profile),
  ]);
  if (storeResult.status !== "fulfilled" || freshResult.status !== "fulfilled") {
    const errors: unknown[] = [];
    const cleanups: Promise<void>[] = [];
    for (const result of [storeResult, freshResult]) {
      if (result.status === "fulfilled") cleanups.push(result.value.close());
      else errors.push(result.reason);
    }
    if (cleanups.length > 0) {
      const settled = await Promise.allSettled(cleanups);
      for (const item of settled) if (item.status === "rejected") errors.push(item.reason);
    }
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Admission issue rail setup/cleanup failed");
  }
  const store = storeResult.value;
  const fresh = freshResult.value;
  const local: Pool[] = [];
  let testError: unknown;
  let hasTestError = false;
  let cleanupErrors: unknown[] = [];
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
    const { oid: _oid, ...installed } = normalizeFunctionFacts(await functionFacts(fresh.owner), fresh.logins);
    const { oid: _drop, ...upgraded } = normalizeFunctionFacts(after, installationLogins(store.installation));
    expect(installed).toEqual(upgraded);
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
  } catch (error) {
    testError = error;
    hasTestError = true;
  } finally {
    const settled = await Promise.allSettled([store.close(), fresh.close(), ...local.map(value => value.end())]);
    cleanupErrors = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason);
  }
  if (hasTestError) {
    if (cleanupErrors.length > 0) throw new AggregateError([testError, ...cleanupErrors], "Admission issue rail failed and cleanup failed");
    throw testError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Admission issue rail cleanup failed");
}
