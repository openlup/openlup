import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { catalogDefinitionDigest, createCatalogProductTypeRegistry, createPostgresCatalogAdoptionReader, createPostgresCatalogPublication,
  installCatalogDefinitions, observePostgresCatalogPrivileges } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV4 } from "@openlup/platform/catalog/contracts";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { setFixtureCatalogDocument } from "../helpers/storeJourney.js";

const containers: PostgresContainer[] = [], pools: Pool[] = [];
const admin = randomUUID(), secondAdmin = randomUUID(), unaffiliated = randomUUID();
const authorizedRole = "adoption_operator";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:g", dimension: "mass" as const, integral: true }],
  netContentUnits: ["openlup:g"], dimensions: [], validatorRef: `sha256:${"1".repeat(64)}`, validateContent: () => [] };
let pool: Pool;
let identifierSerial = 0;

beforeAll(async () => {
  const container = await runPostgresContainer({ name: `catalog-adoption-${process.pid}`, password: "synthetic-adoption" });
  containers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Adoption witnesses require PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString }); pools.push(pool);
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) await pool.query(readFileSync(unit.file, "utf8"));
  await installCatalogDefinitions(pool, { id: "example:adoption", namespace: "example", version: 1, openlupRange: "0.44.x",
    capabilities: { publish: false }, types: [definition], taxClasses: [] });
  for (const actor of [admin, secondAdmin, unaffiliated]) {
    await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [actor, `${actor}@example.invalid`]);
  }
  for (const actor of [admin, secondAdmin]) {
    await pool.query(`INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at)
      VALUES($1,'admin','active','legacy',clock_timestamp())`, [actor]);
  }
  await pool.query(`CREATE ROLE ${authorizedRole} NOLOGIN NOBYPASSRLS; CREATE ROLE adoption_runtime NOLOGIN NOBYPASSRLS;
    GRANT EXECUTE ON FUNCTION public.catalog_adoption_preflight(uuid,text),public.catalog_adopt_existing(uuid,text,text,text),
      public.catalog_adoption_receipt(uuid,text),public.catalog_adoption_read(uuid,uuid) TO ${authorizedRole}`);
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

async function asActor<T>(work: (client: PoolClient) => Promise<T>, actor: string | null = admin, role = authorizedRole): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    const claims = JSON.stringify({ sub: actor ?? undefined, role: "authenticated" }).replaceAll("'", "''");
    await client.query(`SET LOCAL request.jwt.claims = '${claims}'`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seed({ legacyDocument = false, secondSku = false } = {}) {
  const product = randomUUID(), document = randomUUID(), list = randomUUID();
  const documentText = '{"title":"Existing article"}';
  await pool.query("INSERT INTO public.catalog_products(id,slug,name,type_key,type_version) VALUES($1,$2,'Existing article',$3,1)",
    [product, `article-${product}`, definition.key]);
  async function seedSku() {
    const sku = randomUUID();
    await pool.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,net_weight_g,net_content_dimension,net_content_unscaled,net_content_scale,net_content_unit)
      VALUES($1,$2,$3,'Existing variant',100,'mass',100,0,'openlup:g')`, [sku, product, `ARTICLE-${sku}`]);
    const body = String(123456780000 + ++identifierSerial);
    const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
    await pool.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary)
      VALUES($1,'example','gtin',$2,'unit',1,true)`, [sku, `${body}${(10 - sum % 10) % 10}`]);
    return sku;
  }
  const sku = await seedSku();
  if (secondSku) await seedSku();
  await pool.query(`INSERT INTO public.catalog_product_document_revisions(id,product_id,revision_no,schema_id,document_ref,document_payload,source_ref,provenance,digest,canonical_text)
    VALUES($1,$2,1,'example:article','document:existing',$3::jsonb,'origin:existing','{}',$4,$5)`, [document, product, documentText, digest(documentText), legacyDocument ? null : documentText]);
  await setFixtureCatalogDocument(pool, product, document);
  await pool.query("UPDATE public.catalog_products SET primary_sku_id=$2 WHERE id=$1", [product, sku]);
  await pool.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Example','ZZ','XXX')", [list]);
  await pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from,valid_to)
    VALUES($1,$2,'one_time',137,transaction_timestamp(),transaction_timestamp()+interval '1 week')`, [list, sku]);
  return { product, sku, document, documentText, list };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

const preflight = (product: string, documentText: string | null = null) => asActor(async client =>
  (await client.query("SELECT public.catalog_adoption_preflight($1,$2) AS result", [product, documentText])).rows[0].result);
const adopt = (product: string, source: string, command = "confirm", actor: string | null = admin, documentText: string | null = null) =>
  asActor(async client => (await client.query("SELECT public.catalog_adopt_existing($1,$2,$3,$4) AS result", [product, source, command, documentText])).rows[0].result, actor);
const records = async (product: string) => (await pool.query(`SELECT
  (SELECT count(*)::int FROM public.catalog_publications WHERE product_id=$1) AS publications,
  (SELECT count(*)::int FROM public.catalog_publication_heads WHERE product_id=$1) AS heads,
  (SELECT count(*)::int FROM public.catalog_sku_revisions WHERE product_id=$1) AS revisions,
  (SELECT count(*)::int FROM public.catalog_operator_receipts WHERE scope_id=$1) AS receipts`, [product])).rows[0];

it.each([
  ["LC8-D-011 missing canonical bytes", "document", "catalog_adoption_document_unavailable"],
  ["LC8-D-011 wrong verified document bytes", "bad_document", "catalog_adoption_document_digest_mismatch"],
  ["LC8-D-012 foreign or absent primary", "primary", "catalog_adoption_identity_conflict"],
  ["LC8-D-012 absent measured content", "physical", "catalog_adoption_facts_invalid"],
  ["LC8-D-012 absent selectable identifier", "identifier", "catalog_adoption_identifier_unavailable"],
  ["LC8-D-025 unbound installed type", "type", "catalog_adoption_type_unavailable"],
  ["LC8-D-025 absent scope", "scope", "catalog_adoption_scope_absent"],
  ["LC8-D-018 overlapping price windows", "overlap", "catalog_adoption_price_overlap"],
] as const)("catalog_adoption_verified_fact_census %s", async (_rule, variant, reason) => {
  const fixture = await seed({ legacyDocument: variant === "document" || variant === "bad_document" });
  const { product, sku, list } = fixture;
  const mutations: Partial<Record<typeof variant, () => Promise<unknown>>> = {
    primary: () => pool.query("UPDATE public.catalog_products SET primary_sku_id=NULL WHERE id=$1", [product]),
    physical: () => pool.query("UPDATE public.catalog_skus SET net_content_dimension=NULL,net_content_unscaled=NULL,net_content_scale=NULL,net_content_unit=NULL WHERE id=$1", [sku]),
    identifier: () => pool.query("DELETE FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1", [sku]),
    type: () => pool.query("UPDATE public.catalog_products SET type_key=NULL,type_version=NULL WHERE id=$1", [product]),
    overlap: () => pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from,valid_to)
      SELECT $1,$2,'one_time',137,valid_from,valid_to FROM public.price_entries WHERE variant_id=$2`, [list, sku]),
  };
  await mutations[variant]?.();
  const scope = variant === "scope" ? randomUUID() : product;
  const text = variant === "bad_document" ? "{" : null;
  await expect(preflight(scope, text)).rejects.toMatchObject({ message: reason });
  await expect(adopt(scope, "a".repeat(64), "confirm", admin, text)).rejects.toMatchObject({ message: reason });
  expect(await records(product)).toEqual({ publications: 0, heads: 0, revisions: 0, receipts: 0 });
});

it.each([
  ["LC8-D-006 bad digest before actor", "bad", "confirm"],
  ["LC8-D-006 empty key before actor", "a".repeat(64), ""],
  ["LC8-D-006 untrimmed key before actor", "a".repeat(64), " confirm"],
])("catalog_bound_actor_lanes %s", async (_rule, source, key) => {
  await expect(adopt(randomUUID(), source, key, null)).rejects.toMatchObject({ message: "catalog_adoption_command_invalid", code: "22023" });
});

it.each([null, unaffiliated])("catalog_bound_actor_lanes LC8-D-004 unauthorized identity %s", async actor => {
  await expect(adopt(randomUUID(), "a".repeat(64), "confirm", actor)).rejects.toMatchObject({ code: "42501" });
});

it("catalog_bound_actor_lanes LC8-D-023 restricts execution and direct receipt writes", async () => {
  await expect(asActor(client => client.query("SELECT public.catalog_adopt_existing($1,$2,$3,NULL)",
    [randomUUID(), "a".repeat(64), "confirm"]), admin, "adoption_runtime")).rejects.toMatchObject({ code: "42501" });
  await expect(asActor(client => client.query("INSERT INTO public.catalog_operator_receipts DEFAULT VALUES"))).rejects.toMatchObject({ code: "42501" });
});

it("catalog_seed_adoption_preserves_ids_money_and_agreements LC8-D-013 LC8-D-020 LC8-N-002 LC8-N-003", async () => {
  const { product, sku, documentText } = await seed({ legacyDocument: true, secondSku: true });
  await pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT price_list_id,variant_id,mode,137,valid_to FROM public.price_entries WHERE variant_id=$1`, [sku]);
  const client = randomUUID(), subscription = randomUUID();
  await pool.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await pool.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,clock_timestamp()+interval '28 days')",
    [subscription, client]);
  await pool.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code)
    VALUES($1,$2,3,0,137,'XXX')`, [subscription, sku]);
  const agreements = () => pool.query(`SELECT to_jsonb(s) AS subscription,to_jsonb(l) AS line FROM public.subscriptions s
    JOIN public.subscription_lines l ON l.subscription_id=s.id WHERE s.id=$1`, [subscription]).then(result => result.rows);
  const original = await agreements();
  const sealed = await preflight(product, documentText);
  const result = await adopt(product, sealed.sourceDigest, "confirm", admin, documentText);
  expect(result).toMatchObject({ outcome: "committed", receipt: { kind: "adoption", sourceKind: "adopted_existing",
    actorId: admin, head: { revision: 1, documentDigest: digest(documentText) }, previousHead: null, skuCount: 2, legacyBindingCount: 1 } });
  expect((await pool.query(`SELECT source_kind,previous_id,draft_id,draft_revision FROM public.catalog_publications
    WHERE product_id=$1`, [product])).rows).toEqual([{ source_kind: "adopted_existing", previous_id: null, draft_id: null, draft_revision: null }]);
  expect((await pool.query(`SELECT provenance,source_id,bound_at IS NOT NULL AS dated FROM public.catalog_legacy_obligation_bindings
    WHERE sku_id=$1`, [sku])).rows).toEqual([{ provenance: "legacy", source_id: subscription, dated: true }]);
  expect(await agreements()).toEqual(original);
  const afterSeal = (await pool.query("SELECT public.catalog_adoption_observe($1,$2) AS evidence", [product, documentText])).rows[0].evidence;
  expect(afterSeal).toEqual(sealed.evidence);
  const readback = await asActor(db => createPostgresCatalogAdoptionReader(db)({ productId: product, skuId: sku }));
  expect(readback).toMatchObject({ outcome: "found", readback: { kind: "adopted_existing", current: true,
    skuReference: { skuId: sku }, head: result.receipt.head } });
  expect(await adopt(product, sealed.sourceDigest, "confirm", admin, documentText)).toEqual({ outcome: "replayed", receipt: result.receipt });
  expect(await asActor(async db => (await db.query("SELECT public.catalog_adoption_receipt($1,'confirm') AS result", [product])).rows[0].result)).toEqual(result.receipt);
});

it.each([
  ["LC8-D-010 stale approved digest", "stale", "catalog_adoption_source_changed"],
  ["LC8-D-010 live facts changed", "changed", "catalog_adoption_source_changed"],
  ["LC8-D-009 authority table locked", "busy", "catalog_adoption_busy"],
  ["LC8-D-016 late receipt insert fails", "rollback", "catalog_adoption_test_failure"],
] as const)("catalog_seed_adoption_preserves_ids_money_and_agreements %s", async (_rule, variant, reason) => {
  const { product, sku } = await seed();
  const { sourceDigest } = await preflight(product);
  if (variant === "changed") await pool.query("UPDATE public.catalog_skus SET title='Changed variant' WHERE id=$1", [sku]);
  if (variant === "rollback") {
    await pool.query(`CREATE FUNCTION public.catalog_adoption_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'catalog_adoption_test_failure'; END; $$;
      CREATE TRIGGER catalog_adoption_test_failure BEFORE INSERT ON public.catalog_operator_receipts
      FOR EACH ROW WHEN (NEW.kind='adoption') EXECUTE FUNCTION public.catalog_adoption_test_failure()`);
  }
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    if (variant === "busy") await holder.query("LOCK TABLE public.catalog_skus IN ROW EXCLUSIVE MODE");
    await expect(adopt(product, variant === "stale" ? "a".repeat(64) : sourceDigest)).rejects.toMatchObject({ message: reason });
  } finally {
    await holder.query("ROLLBACK"); holder.release();
    if (variant === "rollback") await pool.query("DROP TRIGGER catalog_adoption_test_failure ON public.catalog_operator_receipts; DROP FUNCTION public.catalog_adoption_test_failure()");
  }
  expect(await records(product)).toEqual({ publications: 0, heads: 0, revisions: 0, receipts: 0 });
});

it("catalog_seed_adoption_preserves_ids_money_and_agreements LC8-D-007 binds exact actor, digest and command namespace", async () => {
  const { product } = await seed();
  const { sourceDigest } = await preflight(product);
  const result = await adopt(product, sourceDigest);
  await expect(adopt(product, sourceDigest, "confirm", secondAdmin)).rejects.toMatchObject({ message: "catalog_adoption_command_key_reused" });
  await expect(adopt(product, "b".repeat(64))).rejects.toMatchObject({ message: "catalog_adoption_command_key_reused" });
  expect(await adopt(product, sourceDigest)).toEqual({ outcome: "replayed", receipt: result.receipt });
  await expect(adopt(product, sourceDigest, "different")).rejects.toMatchObject({ message: "catalog_adoption_already_published" });
  expect(await records(product)).toEqual({ publications: 1, heads: 1, revisions: 1, receipts: 1 });
});

it("catalog_legacy_binding_continuity LC8-N-003 refuses a dangling retained obligation", async () => {
  const { product } = await seed();
  const client = randomUUID();
  await pool.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  const order = (await pool.query("INSERT INTO public.commerce_orders(client_id,currency_code,total_amount_minor) VALUES($1,'XXX',0) RETURNING id",
    [client])).rows[0].id;
  await pool.query(`INSERT INTO public.subscription_activations(order_id,client_id,cadence_days,declare_idempotency_key)
    VALUES($1,$2,28,$3)`, [order, client, `adoption-obligation:${order}`]);
  try {
    await expect(preflight(product)).rejects.toMatchObject({ message: "catalog_adoption_unbound_obligation" });
    await expect(adopt(product, "a".repeat(64))).rejects.toMatchObject({ message: "catalog_adoption_unbound_obligation" });
    expect(await records(product)).toEqual({ publications: 0, heads: 0, revisions: 0, receipts: 0 });
  } finally {
    await pool.query("DELETE FROM public.subscription_activations WHERE order_id=$1", [order]);
  }
});

it("catalog_seed_adoption_preserves_ids_money_and_agreements LC8-D-009 serializes independent adopters", async () => {
  const { product } = await seed();
  const { sourceDigest } = await preflight(product);
  const keys = ["first", "second"];
  const results = await Promise.allSettled(keys.map(command => adopt(product, sourceDigest, command)));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const loser = results.findIndex(result => result.status === "rejected");
  expect(loser).toBeGreaterThanOrEqual(0);
  const refusal = results[loser];
  if (refusal?.status !== "rejected") throw new Error("Expected a losing command");
  expect(["catalog_adoption_busy", "catalog_adoption_already_published"]).toContain(refusal.reason.message);
  await expect(adopt(product, sourceDigest, keys[loser])).rejects.toMatchObject({ message: "catalog_adoption_already_published" });
  expect(await records(product)).toEqual({ publications: 1, heads: 1, revisions: 1, receipts: 1 });
});

it("catalog_adoption_schema_shape verifies the discriminant, scoped key and legacy privileges", async () => {
  const columns = (await pool.query(`SELECT attname,attnotnull FROM pg_attribute
    WHERE attrelid='public.catalog_publications'::regclass AND attname IN ('source_kind','draft_id','draft_revision') ORDER BY attname`)).rows;
  expect(columns).toEqual([{ attname: "draft_id", attnotnull: false }, { attname: "draft_revision", attnotnull: false },
    { attname: "source_kind", attnotnull: true }]);
  const installed = (await pool.query(`SELECT contype,convalidated,pg_get_constraintdef(oid) AS expression
    FROM pg_constraint WHERE conrelid='public.catalog_legacy_obligation_bindings'::regclass
    ORDER BY contype,pg_get_constraintdef(oid)`)).rows;
  expect(installed).toEqual([
    { contype: "c", convalidated: true, expression: "CHECK ((family = ANY (ARRAY['template'::text, 'pending_activation'::text, 'frozen_renewal'::text, 'outstanding_order'::text, 'replacement'::text, 'stock_wait'::text, 'graduation'::text])))" },
    { contype: "c", convalidated: true, expression: "CHECK ((provenance = 'legacy'::text))" },
    { contype: "f", convalidated: true, expression: "FOREIGN KEY (publication_id) REFERENCES catalog_publications(id)" },
    { contype: "f", convalidated: true, expression: "FOREIGN KEY (sku_id, sku_revision_id) REFERENCES catalog_sku_revisions(sku_id, id)" },
    { contype: "p", convalidated: true, expression: "PRIMARY KEY (publication_id, sku_id, family, source_id)" },
  ]);
});

it.each([
  ["LC8-N-001 absent grant", "adoption_runtime", {}, ["public.catalog_adopt_existing(uuid,text,text,text)"], false],
  ["LC8-N-001 absent schema", authorizedRole, {}, ["public.catalog_nonexistent(uuid)"], false],
  ["LC8-N-001 absent column", authorizedRole, { columns: [{ relation: "public.catalog_publications", column: "nonexistent" }] },
    ["public.catalog_adopt_existing(uuid,text,text,text)"], false],
  ["LC8-N-001 exact grant and shape", authorizedRole, { columns: [{ relation: "public.catalog_publications", column: "source_kind" }] },
    ["public.catalog_adopt_existing(uuid,text,text,text)"], true],
] as const)("catalog_capabilities_and_writer_disable %s", async (_rule, role, shape, functions, expected) => {
  await expect(asActor(db => observePostgresCatalogPrivileges(db, { functions, ...shape }), admin, role)).resolves.toBe(expected);
});

it.each(["compatible", "material", "inconclusive"] as const)("catalog_legacy_binding_continuity LC8-N-004 %s follow-up draft", async classification => {
  const { product, sku, document, documentText } = await seed({ legacyDocument: true });
  await pool.query("UPDATE public.catalog_skus SET sellable_standalone=false WHERE id=$1", [sku]);
  const { sourceDigest } = await preflight(product, documentText);
  const first = await adopt(product, sourceDigest, "adopt", admin, documentText);
  const registry = createCatalogProductTypeRegistry([definition]);
  const authority = createPostgresCatalogPublication({
    registry,
    rules: { canonicalizeDocument: canonicalCatalogDraftJson, deriveSkuFacts: () => ({}),
      validateProduct: () => [], classifySkuChange: () => classification },
    transactions: { run: work => asActor(work, admin, "postgres") },
    authorizeHuman: async () => ({ ok: true, userId: admin, role: "admin", isMachineActor: false }),
    readiness: async () => ({ ready: true, reasons: [] }), verifyMedia: async () => false,
  });
  expect(await authority.reads.current(product)).toMatchObject({ outcome: "found", head: first.receipt.head,
    observations: [{ variantId: sku, draftRef: null }] });
  const actor = (await authority.authorize(null))!;
  const identifier = (await pool.query("SELECT normalized_value FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1", [sku])).rows[0].normalized_value;
  const skuCode = `ARTICLE-${sku}`, slug = `article-${product}`, draftId = randomUUID();
  const payload: CatalogDraftPayloadV4 = { schemaVersion: 4,
    product: { id: product, type: { key: definition.key, version: 1 }, slug, dimensions: [], primarySkuId: sku,
      documentRevision: { id: document, productId: product, schemaId: "example:article", revisionNo: 1,
        documentRef: "document:existing", sourceRef: "origin:existing", digest: digest(documentText) },
      sharedContent: { schemaVersion: 1, catalogAction: "revise", presentation: { title: "Displayed article" },
        publicationSkus: [], offerMemberships: [], requestedModes: [] } },
    skus: [{ id: sku, productId: product, code: skuCode, options: {},
      identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: identifier, packagingLevel: "unit" }],
      netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 },
      ...(classification === "compatible" ? {} : { grossMass: { dimension: "mass", unit: "openlup:g", unscaled: "120", scale: 0 } }) }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "set_product_presentation", productSlug: slug, presentation: { title: "Displayed article" } },
    ] },
  };
  const draft = canonicalCatalogDraftJson({ schemaVersion: 4, action: "create", draftId, commandKey: "draft:1", expectedRevision: 0, payload });
  const saved = (await pool.query("SELECT public.catalog_draft_apply($1,$2,'operator:synthetic') AS result", [draft, digest(draft)])).rows[0].result;
  expect(saved).toMatchObject({ outcome: "committed" });
  const candidate = { productId: product, candidateRef: `v1:${draftId}@1/${first.receipt.head.publicationId}@1`,
    candidateDigest: digest(`["catalog-candidate",1,${canonicalCatalogDraftJson(payload)},${canonicalCatalogDraftJson([
      { key: definition.key, version: 1, definitionDigest: catalogDefinitionDigest(definition) },
    ])},${canonicalCatalogDraftJson(first.receipt.head)}]`) };
  expect(await authority.decision({ ...candidate, schemaVersion: 2, action: "approve", commandKey: "approve",
    reason: "Reviewed exact representation" }, actor)).toMatchObject({ outcome: "committed" });
  const next = await authority.publish({ ...candidate, commandKey: "publish", expectedHead: first.receipt.head, changes: [] }, actor);
  if (classification !== "compatible") {
    expect(next).toMatchObject({ reason: "sku_identity_change_requires_new_sku" });
    expect(await authority.reads.current(product)).toMatchObject({ outcome: "found", head: first.receipt.head });
    return;
  }
  expect(next).toMatchObject({ outcome: "committed", receipt: { previousHead: first.receipt.head, head: { revision: 2 } } });
  expect(await authority.reads.current(product)).toMatchObject({ outcome: "found", head: { revision: 2 }, observations: [{ draftRef: { draftId, revision: 1 } }] });
  expect(await authority.reads.readback(first.receipt.head)).toMatchObject({ outcome: "found", observations: [{ draftRef: null }] });
  expect(await adopt(product, sourceDigest, "adopt", admin, documentText)).toEqual({ outcome: "replayed", receipt: first.receipt });
  expect(await asActor(db => createPostgresCatalogAdoptionReader(db)({ productId: product, skuId: sku }))).toMatchObject({
    outcome: "found", readback: { head: first.receipt.head, current: false },
  });
});

it("catalog_adoption_verified_fact_census LC8-D-010 independent session time zones seal the same source", async () => {
  const { product } = await seed();
  const utc = await preflight(product);
  const other = await asActor(async client => {
    await client.query("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
    return (await client.query("SELECT public.catalog_adoption_preflight($1,NULL) AS result", [product])).rows[0].result;
  });
  expect(other).toEqual(utc);
  expect(await adopt(product, other.sourceDigest)).toMatchObject({ outcome: "committed", receipt: { sourceDigest: utc.sourceDigest } });
});
