import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { catalogDefinitionDigest, createCatalogProductTypeRegistry, createPostgresCatalogDraftStoreV3, createPostgresCatalogPublicationCommands,
  readPostgresCatalogActivationReadiness, withCatalogPublicationRules, type CatalogHeadRef, type CatalogInstalledReadiness } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV3 } from "@openlup/platform/catalog/contracts";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { actorId, fixture, graph, hash, insertGraph, installPublicationActors, json, stageProductRows, transaction } from "./catalogPublicationFixture.js";

const forward = "db/platform/migrations/20261124121000_catalog_publication_readiness.sql";
const readinessSql = "SELECT public.catalog_publication_activation_readiness($1::text[],$2) AS result";
const entry = "public.catalog_publication_activation_readiness(text[],text)";
const helpers = ["public.catalog_publication_readiness_snapshot(text[],text,timestamptz)", "public.catalog_publication_price_reasons(uuid[],timestamptz)"];
const unavailable = { outcome: "dependency_unavailable", reason: "catalog_publication_read_unavailable" };
const installedInvalid = { outcome: "dependency_unavailable", reason: "catalog_installed_readiness_invalid" };
const invalidInput = { outcome: "validation_issue", reason: "catalog_publication_readiness_input_invalid" };
const headMoved = { outcome: "conflict", reason: "catalog_publication_head_moved", retryable: true };
const drift = { kind: "refusal", reason: "inconsistent_evidence", detail: "catalog_publication_live_drift" };
const inconsistent = { kind: "refusal", reason: "inconsistent_evidence" };
let container: PostgresContainer, pool: Pool;

const artifact = Buffer.from(`
  const wire = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : 1)));
  module.exports = {
    validateContent: () => [], validateProduct: () => [],
    identifyDocument: ({ schemaVersion, id, productSlug, revisionNo, name }) =>
      ({ schemaId: "example:document.v" + schemaVersion, documentRef: id, productSlug, revisionNo, name }),
    inspectDocument(text) { return { ...this.identifyDocument(JSON.parse(text)), canonicallyEncoded: wire(JSON.parse(text)) === text }; },
    matchesDocument: (document, text) => wire(document) === text,
    deriveSkuFacts: () => ({ derived: 12 }), classifySkuChange: () => "compatible",
  };
`);
// Version 1 types the synthetic sealed fixtures; version 2 is published by the real writer.
const registry = createCatalogProductTypeRegistry(withCatalogPublicationRules({ id: "example:rules", namespace: "example",
  version: 1, openlupRange: "1.x", capabilities: {}, taxClasses: [], types: [1, 2].map(version => ({
    key: "example:article", version, units: [{ code: "openlup:g", dimension: "mass" as const, integral: false }], netContentUnits: ["openlup:g"],
    dimensions: [{ key: "finish", kind: "choice" as const, values: ["matte", "gloss"] }], axes: [{ key: "finish", attributeKey: "finish" }],
    attributes: [{ key: "finish", scope: "variant" as const, valueType: { kind: "enum" as const, values: [{ id: "matte" }, { id: "gloss" }] },
      required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }],
  })) }, () => artifact).types);
const none: CatalogInstalledReadiness = { registry, assess: () => [] };

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-readiness-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Catalogue readiness requires PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  await pool.query("CREATE ROLE service_role; CREATE ROLE unrelated");
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { baseline: { file: string }; forward: { file: string }[] };
  const position = manifest.forward.findIndex(unit => unit.file === forward);
  expect(position).toBeGreaterThan(0);
  for (const { file } of [manifest.baseline, ...manifest.forward.slice(0, position)]) await pool.query(readFileSync(file, "utf8"));
  await pool.query(readFileSync(forward, "utf8"));
  await installPublicationActors(pool);
  const writerType = registry.resolve({ key: "example:article", version: 2 })!;
  await pool.query(`INSERT INTO public.catalog_type_versions(type_key,version,definition,definition_digest,validator_ref)
    VALUES($1,2,'{}',$2,$3)`, [writerType.key, catalogDefinitionDigest(writerType), writerType.validatorRef]);
  await pool.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`);
  await pool.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
  // PostgreSQL raises SQLSTATE 40001 from this deferred trigger at COMMIT, or earlier when constraints are set immediate.
  await pool.query(`CREATE FUNCTION public.readiness_conflict_witness() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'could not serialize access' USING ERRCODE='40001'; END $$;
    CREATE TABLE public.readiness_conflict_witness(id integer);
    CREATE CONSTRAINT TRIGGER readiness_conflict_witness AFTER INSERT ON public.readiness_conflict_witness
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.readiness_conflict_witness()`);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

const fixedId = (index: number): ReturnType<typeof randomUUID> => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}
type Lane = Parameters<typeof readPostgresCatalogActivationReadiness>[0];
const lane = (around?: (db: PoolClient, work: () => Promise<unknown>) => Promise<unknown>): Lane => ({
  run: <T>(work: (db: PgQueryExecutor) => Promise<T>) => transaction(pool, db => (around ? around(db, () => work(db)) : work(db)) as Promise<T>),
});
const read = (installed: CatalogInstalledReadiness, skuCodes: string[], expectedHeadDigest: string, transactions = lane()) =>
  readPostgresCatalogActivationReadiness(transactions, installed, { skuCodes, expectedHeadDigest });
async function headDigest(db: Pool | PoolClient = pool) {
  return (await db.query("SELECT coalesce(public.catalog_publication_read_head()->>'headDigest',repeat('0',64)) AS digest")).rows[0]!.digest as string;
}
async function seed(db: PoolClient, options: { code?: string; id?: ReturnType<typeof randomUUID>; documentText?: string;
  registrationText?: string | Record<string, never>; extraSkuCount?: number } = {}) {
  const issue = await graph(db, { ...fixture(), ...(options.id ? { skuId: options.id } : {}), skuCode: options.code }, null, true,
    { documentText: options.documentText, registrationText: options.registrationText });
  await insertGraph(db, issue, { extraSkuCount: options.extraSkuCount });
  return issue;
}
/** Run direct SQL in a transaction that is always rolled back. */
async function rolledBack<T>(work: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    return await work(db);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
}
async function direct(db: PoolClient, codes: string[], digest?: string) {
  const result = (await db.query(readinessSql, [codes, digest ?? await headDigest(db)])).rows[0]!.result;
  expect((await db.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
  return result;
}
const evidenceOf = (issue: Awaited<ReturnType<typeof seed>>) => ({ head: issue.head, document: issue.document,
  skuRevision: { skuId: issue.skuId, revisionId: issue.skuRevisionId, revision: 1, digest: hash(json(issue.facts)) } });
const absent = (skuCode: string) => ({ skuCode, skuId: null, logisticsRef: null, evidence: null, ready: false, reasons: ["sku_not_materialized"] });
const intrinsic = ["logistics_reference_missing", "unit_gtin_missing", "catalog_publication_gross_mass_required"];

it("refuses a legacy catalogue and orphan publication markers before any subject work", async () => {
  expect(await read(none, ["legacy-code"], "a".repeat(64))).toEqual({ outcome: "unsupported", reason: "catalog_publication_not_adopted" });
  await rolledBack(async db => {
    const legacy = fixture();
    await stageProductRows(db, legacy);
    expect(await direct(db, ["legacy-code"], "a".repeat(64))).toEqual({ kind: "refusal", reason: "legacy" });
    await db.query("UPDATE public.catalog_skus SET publication_facts='{}' WHERE id=$1", [legacy.skuId]);
    expect(await direct(db, ["legacy-code"], "a".repeat(64))).toEqual(inconsistent);
  });
});

it("validates the request and transaction mode before taking the fence", async () => {
  await transaction(pool, db => seed(db));
  const digest = await headDigest();
  const fence = "SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation' AND relation='public.catalog_products'::regclass";
  for (const [begin, codes, expected, reason] of [
    ["BEGIN", ["Code", "code"], digest, null], ["BEGIN", [], digest, "invalid_request"],
    ["BEGIN", Array.from({ length: 101 }, (_, index) => `code-${index}`), digest, "invalid_request"],
    ["BEGIN", ["same", "same"], digest, "invalid_request"], ["BEGIN", ["has space"], digest, "invalid_request"], ["BEGIN", [null], digest, "invalid_request"],
    ["BEGIN", "{{a},{b}}", digest, "invalid_request"], ["BEGIN", ["code"], digest.toUpperCase(), "invalid_request"], ["BEGIN", ["code"], null, "invalid_request"],
    ["BEGIN ISOLATION LEVEL REPEATABLE READ", ["code"], digest, "invalid_transaction_mode"],
    ["BEGIN ISOLATION LEVEL SERIALIZABLE", ["code"], digest, "invalid_transaction_mode"], ["BEGIN READ ONLY", ["code"], digest, "invalid_transaction_mode"],
  ] as const) {
    const db = await pool.connect();
    try {
      await db.query(begin);
      const result = (await db.query(readinessSql, [codes, expected])).rows[0]!.result;
      if (reason) expect(result).toEqual({ kind: "refusal", reason });
      else expect(result).toMatchObject({ kind: "batch", value: { items: [{ skuCode: "Code" }, { skuCode: "code" }] } });
      expect((await db.query(fence)).rows).toEqual(reason ? [] : expect.arrayContaining([{ mode: "ShareLock" }]));
      expect((await db.query("SELECT txid_current_if_assigned() AS xid")).rows).toEqual([{ xid: null }]);
      await db.query("COMMIT");
    } finally { db.release(); }
  }
});

it("proves absence from the authenticated sealed roster and refuses the whole batch for damaged evidence", async () => {
  const sealed = await transaction(pool, db => seed(db, { extraSkuCount: 1 }));
  const code = sealed.facts.code;
  expect(await read(none, [code, "absent-code"], await headDigest())).toEqual({ protocol: "governed", headDigest: await headDigest(), items: [
    { skuCode: code, skuId: sealed.skuId, logisticsRef: null, evidence: evidenceOf(sealed), ready: false,
      reasons: [...intrinsic, "price_readiness_missing", "offer_membership_missing"] }, absent("absent-code")] });
  const manifest = JSON.parse((await pool.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [sealed.issueId])).rows[0]!.canonical_state);
  const scenarios: [string, (db: PoolClient) => Promise<unknown>, string[], unknown][] = [
    ["renamed live SKU", db => db.query("UPDATE public.catalog_skus SET sku='renamed' WHERE id=$1", [sealed.skuId]), [code, "absent-code"], drift],
    ["renamed and cleared projection", db => db.query("UPDATE public.catalog_skus SET sku='renamed',publication_facts=NULL WHERE id=$1", [sealed.skuId]),
      [code, "absent-code"], inconsistent],
    ["damaged retained digest", db => db.query("UPDATE public.catalog_sku_revisions SET digest=repeat('1',64) WHERE id=$1", [sealed.skuRevisionId]),
      [code, "absent-code"], inconsistent],
    ["uncertifiable roster for an absent code", db => db.query("UPDATE public.catalog_sku_revisions SET digest=repeat('1',64) WHERE id=$1",
      [sealed.skuRevisionId]), ["absent-code"], inconsistent],
    ["missing selected receipt", db => db.query("DELETE FROM public.catalog_operator_receipts WHERE publication_id=$1", [sealed.issueId]),
      [code, "absent-code"], inconsistent],
    ["duplicate sealed claim", async db => {
      await db.query("UPDATE public.catalog_skus SET sku='renamed' WHERE id=$1", [sealed.skuId]);
      await seed(db, { code });
    }, [code, "absent-code"], inconsistent],
    ["governed live SKU without a sealed identity", db => db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,net_weight_g)
      VALUES($1,$2,'unsealed-code','Article','draft',100)`, [randomUUID(), sealed.productId]), ["unsealed-code", "absent-code"], inconsistent],
    ["legacy takeover of a sealed code", async db => {
      await db.query("UPDATE public.catalog_skus SET sku='renamed' WHERE id=$1", [sealed.skuId]);
      await stageProductRows(db, fixture(), undefined, code);
    }, [code, "absent-code"], drift],
    ["truncated manifest with its original digest", db => db.query("UPDATE public.catalog_publications SET canonical_state=$2 WHERE id=$1",
      [sealed.issueId, json({ ...manifest, skus: manifest.skus.filter((ref: { skuId: string }) => ref.skuId === sealed.skuId) })]), ["absent-code"], inconsistent],
  ];
  for (const [name, damage, codes, expected] of scenarios) {
    await rolledBack(async db => {
      await db.query("SET LOCAL session_replication_role=replica");
      await damage(db);
      expect([name, await direct(db, codes)]).toEqual([name, expected]);
    });
  }
  await rolledBack(async db => {
    await stageProductRows(db, fixture(), undefined, "legacy-only");
    expect(await direct(db, ["legacy-only"])).toMatchObject({ kind: "batch", value: { items: [
      { skuCode: "legacy-only", evidence: null, primaryPresent: null, priceReasons: [] }] } });
  });
});

it("refuses malformed registration bytes before deferred admission and leaves the transaction usable", async () => {
  await transaction(pool, async db => {
    await db.query("SAVEPOINT pending_document");
    const pending = await seed(db, { documentText: "{}", registrationText: {} });
    expect(await direct(db, [pending.facts.code])).toEqual(inconsistent);
    await db.query("ROLLBACK TO SAVEPOINT pending_document");
    const valid = await seed(db, { documentText: "{}", registrationText: "{}" });
    expect(await direct(db, [valid.facts.code])).toMatchObject({ kind: "batch", value: { items: [{ skuCode: valid.facts.code }] } });
  });
});

const at = "2001-01-01T00:00:00.000900Z";
async function priced(work: (db: PoolClient, sku: string, list: string) => Promise<void>) {
  await rolledBack(async db => {
    await db.query("UPDATE public.price_lists SET status='archived' WHERE status='active'");
    const legacy = fixture();
    await stageProductRows(db, legacy);
    await work(db, legacy.skuId, await priceList(db));
  });
}
async function priceList(db: Pool | PoolClient, options: { id?: string; created?: string; to?: string } = {}) {
  const id = options.id ?? randomUUID();
  await db.query(`INSERT INTO public.price_lists(id,name,region_code,currency,valid_from,valid_to,created_at)
    VALUES($1,'Readiness','ZZ','XXX','2000-01-01T00:00:00Z',$2,coalesce($3::timestamptz,now()))`, [id, options.to ?? null, options.created ?? null]);
  return id;
}
function price(db: Pool | PoolClient, list: string, sku: string, mode: string,
  options: { amount?: number; kind?: string; min?: number; from?: string; to?: string } = {}) {
  return db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,amount_kind,valid_from,valid_to)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [list, sku, mode, options.min ?? 1, options.amount ?? 1000, options.kind ?? "gross",
    options.from ?? "2000-01-01T00:00:00Z", options.to ?? null]);
}
function policy(db: PoolClient, list: string, from: string, to: string | null, revision = 1, discount = 1000) {
  return db.query(`INSERT INTO public.subscription_price_policy_revisions(id,revision_no,price_list_id,region_code,currency,channel,
    discount_bps,rounding_quantum_minor,rounding_rule,effective_from,effective_to,digest)
    SELECT id,$2::integer,$1::uuid,'ZZ','XXX','D2C',$5::integer,10,'FLOOR_TO_QUANTUM',$3::timestamptz,$4::timestamptz,
      public.catalog_price_setup_policy_digest(id,$2,$1,'ZZ','XXX','D2C',$3,$4,$5,10,'FLOOR_TO_QUANTUM')
    FROM (SELECT gen_random_uuid() AS id) fresh RETURNING id`, [list, revision, from, to, discount]);
}
async function reasons(db: PoolClient, skus: string[], instant = at) {
  return (await db.query("SELECT public.catalog_publication_price_reasons($1::uuid[],$2::timestamptz) AS result", [skus, instant])).rows[0]!.result;
}
const priceVerdict = (sku: string, values: string[] = []) => [{ skuId: sku, reasons: values }];

it.each([
  ["a future policy", "2001-01-02T00:00:00Z", null, null, [[at, false]]],
  ["an expired policy", "2000-12-30T00:00:00Z", "2000-12-31T00:00:00Z", null, [[at, false]]],
  ["an inclusive start", at, null, null, [[at, true], ["2001-01-01T00:00:00.000899Z", false]]],
  ["an exclusive end", "2000-12-30T00:00:00Z", at, null, [["2001-01-01T00:00:00.000899Z", true], [at, false]]],
  ["a shortened open policy", "2000-12-30T00:00:00Z", null, "2001-01-02T00:00:00Z", [[at, true], ["2001-01-02T00:00:00Z", false]]],
] as const)("evaluates %s at pinned instants with its actual end and original digest", async (_name, from, to, closeAt, instants) => {
  await priced(async (db, sku, list) => {
    await price(db, list, sku, "one_time");
    const id = (await policy(db, list, from, to)).rows[0]!.id;
    if (closeAt) await db.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2 WHERE id=$1", [id, closeAt]);
    for (const [instant, ready] of instants) expect(await reasons(db, [sku], instant)).toEqual(priceVerdict(sku, ready ? [] : ["price_readiness_missing"]));
  });
});

it("keeps the stored-row exclusion and the independent shape probe, with every check at one unrounded instant", async () => {
  await priced(async (db, sku, list) => {
    await price(db, list, sku, "one_time");
    await price(db, list, sku, "subscription", { amount: 900 });
    expect(await reasons(db, [sku])).toEqual(priceVerdict(sku));
    await policy(db, list, "2000-01-01T00:00:00Z", null);
    expect(await reasons(db, [sku])).toEqual(priceVerdict(sku, ["price_readiness_missing"]));
  });
  await priced(async (db, sku, list) => {
    await price(db, list, sku, "one_time");
    await policy(db, list, "2000-01-01T00:00:00Z", null);
    expect(await reasons(db, [sku])).toEqual(priceVerdict(sku));
    await db.query("UPDATE public.price_entries SET unit_price_minor=5 WHERE variant_id=$1", [sku]);
    expect(await reasons(db, [sku])).toEqual(priceVerdict(sku, ["price_readiness_missing"]));
  });
  await priced(async (db, sku, list) => {
    await price(db, list, sku, "one_time");
    await price(db, list, sku, "subscription", { kind: "net" });
    expect(await reasons(db, [sku])).toEqual(priceVerdict(sku, ["price_readiness_missing", "price_shape_invalid"]));
  });
  await priced(async (db, sku) => {
    // Every window ends before the current clock and the base starts between the instant's millisecond and microsecond.
    const bounded = await priceList(db, { to: "2002-01-01T00:00:00Z" });
    await db.query("UPDATE public.price_lists SET status='archived' WHERE id<>$1", [bounded]);
    await price(db, bounded, sku, "one_time", { from: "2001-01-01T00:00:00.0005Z", to: "2002-01-01T00:00:00Z" });
    await price(db, bounded, sku, "subscription", { to: "2002-01-01T00:00:00Z" });
    expect(await reasons(db, [sku])).toEqual(priceVerdict(sku));
    expect(await reasons(db, [sku], "2001-01-01T00:00:00.0004Z")).toEqual(priceVerdict(sku, ["price_readiness_missing"]));
  });
  await priced(async (db, sku) => {
    await db.query("UPDATE public.price_lists SET status='archived'");
    expect(await reasons(db, [sku])).toEqual(priceVerdict(sku, ["price_readiness_missing"]));
  });
});

it("refuses an ambiguous settlement list and an unreadable settlement context", async () => {
  const ambiguous = { kind: "refusal", reason: "inconsistent_evidence", detail: "active_price_list_ambiguous" };
  for (const created of [["2000-01-01T00:00:00Z", "2000-06-01T00:00:00Z"], ["2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z"]]) {
    for (const [priced_, unpriced] of [[fixedId(901), fixedId(902)], [fixedId(902), fixedId(901)]]) {
      await priced(async (db, sku) => {
        await db.query("UPDATE public.price_lists SET status='archived'");
        const full = await priceList(db, { id: priced_, created: created[1] });
        await priceList(db, { id: unpriced, created: created[0] });
        await price(db, full, sku, "one_time");
        await price(db, full, sku, "subscription");
        expect(await reasons(db, [sku])).toEqual(ambiguous);
      });
    }
  }
  await priced(async (db, sku) => {
    await db.query("UPDATE public.commerce_settings SET value_text='zz' WHERE key='settlement_region'");
    expect(await reasons(db, [sku])).toEqual({ kind: "refusal", reason: "inconsistent_evidence", detail: "catalog_price_setup_settlement_context_unverified" });
  });
});

it("keys price reasons by SKU in request order and skips settlement for an all-absent batch", async () => {
  const [low, high] = await transaction(pool, async db => [await seed(db, { id: fixedId(11) }), await seed(db, { id: fixedId(12) })]);
  const list = await priceList(pool);
  try {
    await price(pool, list, low.skuId, "one_time");
    await price(pool, list, low.skuId, "subscription");
    await price(pool, list, high.skuId, "one_time");
    const result = await read(none, [high.facts.code, low.facts.code], await headDigest());
    expect(result).toMatchObject({ items: [{ skuId: high.skuId, reasons: [...intrinsic, "price_readiness_missing", "offer_membership_missing"] },
      { skuId: low.skuId, reasons: [...intrinsic, "offer_membership_missing"] }] });
    await priceList(pool);
    expect(await read(none, [low.facts.code], await headDigest())).toEqual({ ...unavailable, reason: "active_price_list_ambiguous" });
    await pool.query("UPDATE public.commerce_settings SET value_text=NULL WHERE key='settlement_currency'");
    expect(await read(none, ["absent-one", "absent-two"], await headDigest())).toEqual({ protocol: "governed", headDigest: await headDigest(),
      items: [absent("absent-one"), absent("absent-two")] });
    expect(await read(none, [low.facts.code], await headDigest())).toEqual({ ...unavailable, reason: "catalog_price_setup_settlement_context_unverified" });
  } finally {
    await pool.query("UPDATE public.commerce_settings SET value_text='XXX' WHERE key='settlement_currency'");
    await pool.query("UPDATE public.price_lists SET status='archived'");
  }
});

it("gives installed rules detached certified subjects after the owner transaction and keeps SQL price reasons", async () => {
  const issue = await transaction(pool, db => seed(db));
  const list = await priceList(pool);
  await price(pool, list, issue.skuId, "one_time");
  try {
    const digest = await headDigest();
    let open = false;
    const owner = lane(async (db, work) => {
      open = true;
      try {
        const value = await work();
        expect((await db.query("SELECT txid_current_if_assigned() AS xid")).rows).toEqual([{ xid: null }]);
        return value;
      } finally { open = false; }
    });
    const writes = vi.fn();
    const binder = Object.assign((db: PgQueryExecutor) => {
      writes();
      return { registry, channel: "D2C", prices: { resolvePrice: () => db.query("INSERT INTO public.price_lists DEFAULT VALUES") }, assess: () => ({ ready: true, reasons: [] }) };
    }, none);
    expect(await read(binder as unknown as CatalogInstalledReadiness, [issue.facts.code], digest, owner)).toEqual(invalidInput);
    expect(await read({ registry } as CatalogInstalledReadiness, [issue.facts.code], digest, owner)).toEqual(invalidInput);
    expect(writes).not.toHaveBeenCalled();
    const assess = vi.fn((...args: Parameters<CatalogInstalledReadiness["assess"]>) => {
      expect(open).toBe(false);
      const [subject] = args;
      expect(JSON.stringify(subject, (_key, value: unknown) => typeof value === "function" ? "function" : value)).not.toContain("function");
      subject.evidence.head.revision = 99;
      subject.sku.id = randomUUID();
      return ["host_rule", "offer_membership_missing", "host_rule"];
    });
    const resolve = vi.fn((type: Parameters<typeof registry.resolve>[0]) => registry.resolve(type));
    expect(await read({ registry: { resolve }, assess }, [issue.facts.code], digest, owner)).toEqual({ protocol: "governed", headDigest: digest,
      items: [{ skuCode: issue.facts.code, skuId: issue.skuId, logisticsRef: null, evidence: evidenceOf(issue), ready: false,
        reasons: [...intrinsic, "price_readiness_missing", "offer_membership_missing", "host_rule"] }] });
    expect(assess.mock.calls.map(call => call.length)).toEqual([1]);
    expect(resolve).toHaveBeenCalledWith({ key: "example:article", version: 1 });
    for (const bad of [() => ["price_readiness_missing"], () => ["price_shape_invalid"], () => ({ ready: true, reasons: [] }), () => ["Not A Key"],
      () => { throw Object.assign(new Error("host rule failed"), { code: "40001" }); }]) {
      expect(await read({ registry, assess: bad as never }, [issue.facts.code], digest, owner)).toEqual(installedInvalid);
    }
    expect(await read({ registry: { resolve: () => undefined }, assess: () => [] }, [issue.facts.code], digest, owner)).toEqual(installedInvalid);
  } finally {
    await pool.query("UPDATE public.price_lists SET status='archived'");
  }
});

it("keeps PostgreSQL failures at execution and commit retryable and separates entry from internal denials", async () => {
  const issue = await transaction(pool, db => seed(db));
  const codes = [issue.facts.code], digest = await headDigest();
  const conflict = { outcome: "conflict", reason: "catalog_publication_transaction_conflict", retryable: true };
  for (const immediate of [true, false]) {
    const observed = vi.fn(), assess = vi.fn(() => []);
    const owner: Lane = { run: work => transaction(pool, async db => work({ query: async (sql, args) => {
      const value = await db.query(sql, args);
      if (sql.includes("activation_readiness")) {
        await db.query("INSERT INTO public.readiness_conflict_witness VALUES (1)");
        if (immediate) await db.query("SET CONSTRAINTS ALL IMMEDIATE").catch(error => { observed(error.code); throw error; });
      }
      return value;
    } })).catch(error => { observed(error.code); throw error; }) };
    expect(await read({ registry, assess }, codes, digest, owner)).toEqual(conflict);
    expect(observed).toHaveBeenCalledWith("40001");
    expect(assess).not.toHaveBeenCalled();
  }
  for (const role of ["unrelated", "anon", "authenticated", "service_role", "postgres"]) {
    const privileges = await pool.query("SELECT name,has_function_privilege($1::name,name,'EXECUTE') AS allowed FROM unnest($2::text[]) name",
      [role, [entry, ...helpers]]);
    expect(privileges.rows).toEqual([entry, ...helpers].map(name => ({ name, allowed: role === "postgres" || (role === "service_role" && name === entry) })));
    const result = await read(none, codes, digest, lane(async (db, work) => {
      await db.query(`SET LOCAL ROLE ${role}`);
      return work();
    }));
    if (role === "service_role" || role === "postgres") expect(result).toMatchObject({ protocol: "governed" });
    else expect(result).toEqual({ outcome: "unauthorized", reason: "catalog_publication_read_not_authorized" });
  }
  const owner = (await pool.query("SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid=$1::regprocedure", [entry])).rows[0]!.owner as string;
  try {
    for (const message of ["permission denied for table catalog_products", "permission denied for function catalog_publication_readiness_snapshot"]) {
      await pool.query(`ALTER FUNCTION ${entry} OWNER TO unrelated`);
      if (message.includes("function")) await pool.query("GRANT UPDATE ON public.catalog_products TO unrelated");
      const observed = vi.fn();
      expect(await read(none, codes, digest, lane(async (db, work) => {
        await db.query("SET LOCAL ROLE service_role");
        return work().catch(error => { observed(error); throw error; });
      }))).toEqual(unavailable);
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ code: "42501", message }));
    }
  } finally {
    await pool.query(`ALTER FUNCTION ${entry} OWNER TO ${owner}`);
    await pool.query("REVOKE UPDATE ON public.catalog_products FROM unrelated");
  }
});

// The real catalogue writer publishes version 2 drafts through its own owner lane.
function writer(hold?: { held: () => void; release: Promise<void> }) {
  return createPostgresCatalogPublicationCommands({
    authorizeHuman: async (userId: string) => ({ ok: true, userId, role: "admin", isMachineActor: false }),
    catalogPublicationOwner: { run: work => transaction(pool, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const result = await work(db);
      if (hold) {
        hold.held();
        await hold.release;
      }
      return result;
    }) },
    registry,
  });
}
function draft(sequence: number) {
  const productId = randomUUID(), draftId = randomUUID(), skuId = randomUUID(), documentId = randomUUID();
  const slug = `writer-${sequence}`, code = `WRITER-${sequence}`, prefix = String(590123412340 + sequence);
  const barcode = prefix + String((10 - [...prefix].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 === 0 ? 1 : 3), 0) % 10) % 10);
  const document = { schemaVersion: 1, id: "example:document", productSlug: slug, revisionNo: 1, name: "Example article" };
  const canonicalText = canonicalCatalogDraftJson(document);
  const ref = { id: documentId, productId, revisionNo: 1, schemaId: "example:document.v1", sourceRef: "example:source", documentRef: document.id, digest: hash(canonicalText) };
  const facts = { skuCode: code, title: "Example article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  const identifier = { scheme: "gs1:gtin", issuer: "example", value: barcode, packagingLevel: "unit" as const };
  const payload: CatalogDraftPayloadV3 = { schemaVersion: 3, product: { id: productId, type: { key: "example:article", version: 2 },
    dimensions: ["finish"], slug, primarySkuId: skuId, documentRevision: ref,
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: {}, publicationSkus: [facts],
      requestedModes: [{ skuCode: code, modes: [] }], offerMemberships: [] } },
    skus: [{ id: skuId, productId, code, options: { finish: { kind: "choice", value: "matte" } }, identifiers: [identifier],
      netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 } }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: slug, name: document.name },
      { op: "register_document_revision", productSlug: slug, revisionId: documentId, revisionNo: 1,
        documentRef: ref.documentRef, sourceRef: ref.sourceRef, canonicalText, digest: ref.digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
      { op: "create_sku", productSlug: slug, documentRevisionNo: 1, skuId, ...facts },
      { op: "create_identifier", skuCode: code, ...identifier, quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: slug, skuCode: code },
      { op: "set_product_presentation", productSlug: slug, presentation: {} },
    ] } };
  return { productId, draftId, slug, payload };
}
async function publish(command: Parameters<ReturnType<typeof writer>["execute"]>[0], hold?: Parameters<typeof writer>[0]) {
  const api = writer(hold);
  return api.execute(command, (await api.authorize(actorId))!);
}
async function approved(data: ReturnType<typeof draft>, revision: number, head: CatalogHeadRef | null, payload = data.payload) {
  const canonicalCommand = canonicalCatalogDraftJson({ schemaVersion: 3, action: revision === 1 ? "create" : "revise",
    draftId: data.draftId, commandKey: randomUUID(), expectedRevision: revision - 1, payload });
  const saved = await createPostgresCatalogDraftStoreV3(pool).apply({ canonicalCommand, fingerprint: hash(canonicalCommand), actorId });
  if (!("record" in saved)) throw new Error(`Draft save failed: ${JSON.stringify(saved)}`);
  const api = writer(), who = (await api.authorize(actorId))!;
  const candidate = await api.prepareCandidate({ draftId: data.draftId, draftRevision: revision, expectedHead: head }, who);
  if (!("candidateRef" in candidate) || !candidate.preparation?.postStateDigest) throw new Error(JSON.stringify(candidate));
  const common = { productId: data.productId, candidateRef: candidate.candidateRef, candidateDigest: candidate.candidateDigest };
  expect(await api.execute({ ...common, action: "approve", reason: null, commandKey: randomUUID(),
    postStateDigest: candidate.preparation.postStateDigest }, who)).toMatchObject({ outcome: "committed" });
  return { ...common, action: "publish", expectedHead: head, changes: [], commandKey: randomUUID() } as const;
}

it("refuses committed owner-side product name drift before assessing published facts", async () => {
  const product = draft(4);
  expect(await publish(await approved(product, 1, null))).toMatchObject({ outcome: "committed" });
  const code = product.payload.skus[0]!.code, digest = await headDigest();
  const assess = vi.fn(() => []);
  expect(await read({ registry, assess }, [code], digest)).toMatchObject({ protocol: "governed" });
  const originalName = (await pool.query("SELECT name FROM public.catalog_products WHERE id=$1", [product.productId])).rows[0]!.name;
  assess.mockClear();
  await pool.query("UPDATE public.catalog_products SET name='Unpublished drift' WHERE id=$1", [product.productId]);
  try {
    expect(await headDigest()).toBe(digest);
    expect(await read({ registry, assess }, [code], digest))
      .toEqual({ outcome: "dependency_unavailable", reason: "catalog_publication_live_drift" });
    expect(assess).not.toHaveBeenCalled();
  } finally {
    await pool.query("UPDATE public.catalog_products SET name=$2 WHERE id=$1", [product.productId, originalName]);
  }
});

it("waits behind the held real writer, refuses its moved head without installed calls, and makes a later publication busy", async () => {
  const subject = await transaction(pool, db => seed(db));
  const advanced = draft(1);
  const issued = await publish(await approved(advanced, 1, null));
  if (!("receipt" in issued) || !("head" in issued.receipt)) throw new Error(JSON.stringify(issued));
  const revised = structuredClone(advanced.payload);
  revised.product.sharedContent.catalogAction = "revise";
  revised.product.sharedContent.presentation = { routePath: { en: "/revised" } };
  revised.publication.operations = [{ op: "set_product_presentation", productSlug: advanced.slug, presentation: revised.product.sharedContent.presentation }];
  const waiting = "SELECT count(*)::int AS readers FROM pg_locks WHERE locktype='relation' AND relation='public.catalog_products'::regclass AND mode='ShareLock' AND NOT granted";
  for (const command of [await approved(advanced, 2, issued.receipt.head, revised), await approved(draft(2), 1, null)]) {
    const expected = await headDigest(), held = latch(), release = latch();
    const publication = publish(command, { held: held.resolve, release: release.promise });
    await held.promise;
    const installed = { registry: { resolve: vi.fn((type: Parameters<typeof registry.resolve>[0]) => registry.resolve(type)) }, assess: vi.fn(() => []) };
    const reading = read(installed, [subject.facts.code], expected);
    await vi.waitFor(async () => expect((await pool.query(waiting)).rows).toEqual([{ readers: 1 }]), { timeout: 15_000, interval: 50 });
    release.resolve();
    expect(await publication).toMatchObject({ outcome: "committed" });
    expect(await reading).toEqual(headMoved);
    expect(installed.registry.resolve).not.toHaveBeenCalled();
    expect(installed.assess).not.toHaveBeenCalled();
    expect(await headDigest()).not.toBe(expected);
  }
  const later = draft(3), command = await approved(later, 1, null), held = latch(), release = latch();
  const reading = read(none, [subject.facts.code], await headDigest(), lane(async (_db, work) => {
    const value = await work();
    held.resolve();
    await release.promise;
    return value;
  }));
  await held.promise;
  const before = await headDigest();
  expect(await publish(command)).toMatchObject({ outcome: "conflict", reason: "publication_busy" });
  expect((await pool.query("SELECT count(*)::int AS issues FROM public.catalog_publications WHERE product_id=$1", [later.productId])).rows).toEqual([{ issues: 0 }]);
  expect((await pool.query("SELECT count(*)::int AS products FROM public.catalog_products WHERE id=$1", [later.productId])).rows).toEqual([{ products: 0 }]);
  expect(await headDigest()).toBe(before);
  release.resolve();
  expect(await reading).toMatchObject({ protocol: "governed", headDigest: before, items: [{ skuCode: subject.facts.code, skuId: subject.skuId }] });
  expect(await publish(command)).toMatchObject({ outcome: "committed" });
});
