import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresCatalogPublication, createCatalogProductTypeRegistry, installCatalogDefinitions, catalogDefinitionDigest,
  buildCatalogAdmissionFromServing, createPostgresCatalogAdmission, type CatalogPublicationRules } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV4, type CatalogPublishCommand, type CatalogHeadRef,
  type CatalogAdmissionInput, type CatalogAcceptedReferenceV2 } from "@openlup/platform/catalog/contracts";
import { createPostgresProviderPaymentControlPort, createPostgresPaymentWebhookControlPort } from "@openlup/platform/payments";
import { createNativeCatalogRenewalCodecV2, createPostgresRenewalStore, createPostgresStockWaitStore } from "@openlup/platform/subscriptions";
import { createDbBackedCommerceQuotePort } from "@openlup/platform/pricing";
import { createPostgresLegacyEditConsentBridge, createPostgresPackageEditor, createPostgresSizedEditor, type PackageEditorOptions, type SizedEditorOptions, type SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import { catalogAcceptedReferenceV2Schema } from "@openlup/platform/catalog";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from "../helpers/postgresContainer.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:g", dimension: "mass" as const, integral: false }],
  netContentUnits: ["openlup:g"], dimensions: [], axes: [], validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] };
const registry = createCatalogProductTypeRegistry([definition]);
const rules: CatalogPublicationRules = { canonicalizeDocument: canonicalCatalogDraftJson,
  deriveSkuFacts: document => ({ derived: (document as { derived: number }).derived }), validateProduct: () => [], classifySkuChange: () => "compatible" };
let container: PostgresContainer | undefined, pool: Pool;
const administrator = randomUUID();
const packs = ["supplements", "cosmetics", "pet-food"] as const;
const lanes = ["classic", "exact", "sized", "legacy"] as const;
type Lane = typeof lanes[number];
beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-admission-${process.pid}`, password: "synthetic-admission" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Admission requires real PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  await pool.query("CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS");
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) await pool.query(readFileSync(unit.file, "utf8"));
  await installCatalogDefinitions(pool, { id: "example:admission", namespace: "example", version: 1, openlupRange: "0.44.x",
    capabilities: { publish: false }, types: [definition], taxClasses: [] });
  await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'admission@example.invalid')", [administrator]);
  await pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [administrator]);
  await pool.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','1')");
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, [pool]), postgresTeardownTimeoutMs);
const rpc = async (db: Pool | PoolClient, name: string, args: unknown[]) =>
  (await db.query(`SELECT public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) AS result`, args)).rows[0].result;

function publisher(connection: PoolClient, afterQuery?: (sql: string, values: unknown[]) => Promise<void>) {
  return createPostgresCatalogPublication({ registry, rules,
    authorizeHuman: async () => ({ ok: true, userId: administrator, role: "admin", isMachineActor: false }),
    readiness: async () => ({ ready: true, reasons: [] }), globalReadiness: async () => ({ ready: true, reasons: [] }), verifyMedia: async () => true,
    transactions: { async run(work) {
      await connection.query("BEGIN");
      try {
        const result = await work({ async query(sql, values = []) {
          const result = await connection.query(sql, values); await afterQuery?.(sql, values); return result;
        } });
        await connection.query("COMMIT"); return result;
      } catch (error) { await connection.query("ROLLBACK"); throw error; }
    } },
  });
}
function payload(product: string, sku: string, pack: string): CatalogDraftPayloadV4 {
  const code = `ARTICLE-${sku}`, slug = `article-${product}`, documentId = randomUUID();
  const digits = (BigInt(`0x${sku.replaceAll("-","").slice(0,14)}`) % 1_000_000_000_000n).toString().padStart(12,"0");
  const gtin = digits + String((10 - [...digits].reduce((sum,digit,index) => sum + Number(digit) * (index % 2 ? 3 : 1),0) % 10) % 10);
  const document = { schemaVersion: 1, derived: 12, pack }, canonicalText = canonicalCatalogDraftJson(document);
  const facts = { skuCode: code, title: "Synthetic article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  return { schemaVersion: 4, product: { id: product, type: { key: definition.key, version: 1 }, dimensions: [], slug, primarySkuId: sku,
    documentRevision: { id: documentId, productId: product, revisionNo: 1, schemaId: "example:document.v1", documentRef: "example:document", sourceRef: "example:source", digest: digest(canonicalText) },
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: {}, publicationSkus: [facts], requestedModes: [{ skuCode: code, modes: [] }], offerMemberships: [] } },
    skus: [{ id: sku, productId: product, code, options: {}, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 },
      grossMass: { dimension: "mass", unit: "openlup:g", unscaled: "120", scale: 0 }, logisticsRef: "example:logistics",
      identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit" }] }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId: product, productSlug: slug, name: "Synthetic article" },
      { op: "register_document_revision", productSlug: slug, revisionId: documentId, revisionNo: 1, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest: digest(canonicalText), provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 }, { op: "create_sku", productSlug: slug, documentRevisionNo: 1, skuId: sku, ...facts },
      { op: "create_identifier", skuCode: code, scheme: "gs1:gtin", issuer: "example", value: gtin, packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: slug, skuCode: code }, { op: "set_product_presentation", productSlug: slug, presentation: {} },
      { op: "set_sku_metadata", skuCode: code, logisticsRef: "example:logistics" },
    ] } };
}
async function candidate(db: PoolClient, value: CatalogDraftPayloadV4, draft: string, revision: number, head: CatalogHeadRef | null) {
  const command = { schemaVersion: 4, action: revision ? "revise" : "create", draftId: draft,
    commandKey: `draft:${revision}`, expectedRevision: revision, payload: value }, text = canonicalCatalogDraftJson(command);
  expect((await rpc(db, "catalog_draft_apply", [text,digest(text),"operator:synthetic"])).outcome).toBe("committed");
  const candidateRef = `v1:${draft}@${revision + 1}/${head ? `${head.publicationId}@${head.revision}` : "unpublished"}`;
  const candidateDigest = digest('["catalog-candidate",1,' + canonicalCatalogDraftJson(value) + ','
    + canonicalCatalogDraftJson([{ ...value.product.type, definitionDigest: catalogDefinitionDigest(definition) }]) + ',' + canonicalCatalogDraftJson(head) + ']');
  const authority = publisher(db), actor = (await authority.authorize(null))!;
  const publication: CatalogPublishCommand = { productId: value.product.id, commandKey: `publish:${revision}`, candidateRef, candidateDigest, expectedHead: head, changes: [] };
  expect(await authority.decision({ schemaVersion: 2, action: "approve", productId: value.product.id,
    commandKey: `approve:${revision}`, candidateRef, candidateDigest, reason: "Exact synthetic candidate" }, actor)).toMatchObject({ outcome: "committed" });
  return { authority, actor, publication };
}
async function fixture(pack: string, standing: { product?: Record<string, unknown>; sku?: Record<string, unknown> } = {}) {
  const product = randomUUID(), sku = randomUUID(), draft = randomUUID(), client = randomUUID(), subscription = randomUUID(), actor = randomUUID();
  const value = payload(product,sku,pack), db = await pool.connect();
  try {
    const initial = await candidate(db,value,draft,0,null), published = await initial.authority.publish(initial.publication,initial.actor);
    if (!("receipt" in published)) throw new Error(JSON.stringify(published));
    await db.query("BEGIN");
    // Installed standing facts, as in the lifecycle servicing fixture. Activation is not this witness.
    const old = (await db.query("SELECT * FROM public.catalog_publications WHERE id=$1", [published.receipt.head.publicationId])).rows[0];
    const manifest = JSON.parse(old.canonical_state), ref = manifest.skus[0];
    const prior = (await db.query("SELECT * FROM public.catalog_sku_revisions WHERE id=$1", [ref.revisionId])).rows[0];
    const facts = { ...JSON.parse(prior.full_facts), lifecycleState: "active", status: "active", sellableStandalone: true, sellableInSubscription: true,
      memberships: [{ offerVersion: "classic", admitted: true }, { offerVersion: "sized.v1", admitted: true }], ...standing.sku };
    manifest.product = { ...manifest.product, lifecycleState: "active", status: "active", ...standing.product };
    const publication = randomUUID(), revision = randomUUID(), fullFacts = canonicalCatalogDraftJson(facts), factsDigest = digest(fullFacts);
    manifest.skus = [{ ...ref, revisionId: revision, revision: 2, digest: factsDigest }];
    const canonical = canonicalCatalogDraftJson(manifest), hash = digest(canonical);
    await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities VALUES(pg_current_xact_id(),$1,$2)", [product,hash]);
    await db.query("UPDATE public.catalog_products SET status='active',publication_facts=$2::jsonb WHERE id=$1", [product,manifest.product]);
    await db.query("UPDATE public.catalog_skus SET status='active',sellable_standalone=true,sellable_in_subscription=true,publication_facts=$2::jsonb WHERE id=$1", [sku,facts]);
    await db.query("INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id) VALUES($1,$2,2,$3,$4,1,$5,$6,$7,$8,$6,$9)",
      [publication,product,old.id,draft,`standing:${publication}`,hash,old.document_revision_id,canonical,administrator]);
    await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,2,$4,$5,$6)", [revision,sku,product,publication,fullFacts,factsDigest]);
    await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=2 WHERE product_id=$1", [product,publication]);
    await db.query("DELETE FROM public.catalog_lifecycle_write_capabilities WHERE product_id=$1", [product]);
    const head: CatalogHeadRef = { ...published.receipt.head, publicationId: publication, revision: 2 };
    const reference: CatalogAcceptedReferenceV2 = { schemaVersion: 2, skuId: sku, skuCode: facts.code, skuRevisionId: revision,
      publicationHead: head, typeRef: manifest.product.type, definitionDigest: manifest.product.definitionDigest, optionDigest: facts.optionDigest, netContent: facts.netContent };
    await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client,`${client}@example.invalid`,actor]);
    const priceList = randomUUID(), entry = randomUUID();
    await db.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic list','ZZ','XXX',clock_timestamp()-interval '1 day')", [priceList]);
    await db.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',617,clock_timestamp()-interval '1 day')", [entry,priceList,sku]);
    await db.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,started_at,currency_code,price_list_id) VALUES($1,$2,28,clock_timestamp()+interval '28 days',clock_timestamp()-interval '56 days','XXX',$3)", [subscription,client,priceList]);
    await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id) VALUES($1,$2,1,0,617,'XXX',$3)", [subscription,sku,revision]);
    await db.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref,catalog_acceptance) VALUES($1,'XXX','synthetic','sandbox',clock_timestamp(),'synthetic',$2::jsonb)", [subscription,{ schemaVersion: 2, lines: [reference] }]);
    await db.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,1,617)", [subscription,facts.code]);
    await db.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [subscription]);
    const instants = (await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at,to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS anchor FROM public.subscriptions WHERE id=$1", [subscription])).rows[0];
    const at = instants.at as string, anchor = instants.anchor as string;
    const price = (await db.query("SELECT to_jsonb(p) AS row FROM public.price_entries p WHERE id=$1", [entry])).rows[0].row;
    await db.query("COMMIT");
    const admission: CatalogAdmissionInput = { heads: [{ productId: product, head }], skuRevisions: [{ reference, quantity: 2 }], mode: "subscription",
      offerEvidence: { offerVersion: "classic" }, priceContextVersions: [{ skuId: sku,priceListId: priceList,entryId: entry,entry: price }], purpose: "account" };
    return { product,sku,draft,client,subscription,actor,value,head,reference,admission,at,anchor,code: facts.code as string };
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function edit(f: Fixture, lane: Lane = "classic") {
  const key = randomUUID(), hash = digest(key), line = { variantId: f.sku,qty: 2,isAddon: false,
    quoteLine: { sku: f.code,quantity: 2,unitPriceGross: money(617),lineSubtotalGross: money(1234) } };
  const core = [{ variantId: f.sku,qty: 2 }];
  if (lane === "legacy") {
    const db = await pool.connect(), constraint = { catalogAdmission: f.admission };
    try {
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [f.actor]);
      await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
      const quoted = await rpc(db,"customer_subscription_preview_bundle_as_actor",[f.subscription,key,JSON.stringify(core),"[]",constraint,28,1]);
      const args: unknown[] = [f.subscription,key,quoted.preview.quoteHash,JSON.stringify(core),"[]",constraint,28,1];
      return { key,hash: quoted.preview.quoteHash as string,action: "update_bundle",payload: {},args,
        invoke: (connection: PoolClient) => rpc(connection,"customer_subscription_apply_bundle_as_actor",args) };
    } finally { await db.query("RESET request.jwt.claim.sub"); await db.query("RESET request.jwt.claims"); db.release(); }
  }
  const action = lane === "classic" ? "update_package_template" : lane === "exact" ? "update_plan_length" : "resize_bundle";
  const request = lane === "classic" ? { planDays: 28,base: core,addons: [],expectedTemplateVersion: 1,acceptedQuoteHash: hash }
    : lane === "exact" ? { action,planDays: 30,expectedTemplateVersion: 1,acceptedQuoteHash: hash }
      : { action,cadenceDays: 28,compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 },expectedTemplateVersion: 1,acceptedQuoteHash: hash,
        resizeLever: { kind: "subscription.sized.parcel",value: { coreLines: core,optInToSized: true } } };
  const constraint = lane === "sized" ? { kind: "unit_count",value: 2,dailyNeed: 1 } : null;
  const cadenceDays = lane === "exact" ? 30 : 28;
  const evidence = lane === "classic" ? { baseLines: [line],addonLines: [],compositionConstraint: constraint,catalogAdmission: f.admission }
    : { lines: [line],cadenceDays,compositionConstraint: constraint,catalogAdmission: f.admission,subjectFacts: { revision: 1 },optInFacts: { revision: 1 } };
  const totals = { currentRecurringPrice: money(617),newRecurringPrice: money(1234),delta: money(617) };
  await rpc(pool,"subscription_quote_preview_record",[f.actor,f.client,f.subscription,action,hash,1,
    (await pool.query("SELECT $1::timestamptz+interval '1 hour' AS at", [f.at])).rows[0].at,
    lane === "classic" ? { planDays: 28,base: core,addons: [] } : Object.fromEntries(Object.entries(request).filter(([key]) => !["expectedTemplateVersion","acceptedQuoteHash"].includes(key))),evidence,totals,f.at]);
  const payload = { ...request,request,expectedTemplateVersion: 1,acceptedQuoteHash: hash,
    ...(lane === "classic" ? { planDays: 28,base: core,addons: [],...evidence,...totals } : { ...evidence,cadenceDays }) };
  const args: unknown[] = [f.actor,f.client,key,f.subscription,...(lane === "exact" ? [action] : []),payload,f.at];
  return { key,hash,action,payload,args,invoke: (connection: PoolClient) => rpc(connection,lane === "classic" ? "subscription_package_edit_apply" : lane === "exact" ? "subscription_line_edit_apply" : "subscription_sized_edit_apply",args) };
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const { tablename } of (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
    result[tablename] = (await pool.query(`SELECT coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM public."${tablename}" t`)).rows[0].rows;
  return result;
}
const tracked = <T>(work: Promise<T>) => work.then(value => ({ ok: true as const,value }),error => ({ ok: false as const,error }));
async function session() { const db = await pool.connect(); await db.query("BEGIN"); return db; }
const pid = async (db: PoolClient) => Number((await db.query("SELECT pg_backend_pid() AS id")).rows[0].id);
async function blocker(observer: PoolClient, waiter: number, holder: number) {
  await expect.poll(async () => (await observer.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [waiter,holder])).rows[0].blocked).toBe(true);
}
async function assertNoCatalogGuard(observer: PoolClient, backend: number) {
  expect((await observer.query("SELECT count(*)::integer AS count FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND ((classid::bigint<<32)|objid::bigint)=hashtextextended('catalog-publication-global',0)", [backend])).rows[0].count,
    "catalogue guard held before subscription").toBe(0);
}
async function gate(observer: PoolClient) {
  const key = BigInt(`0x${randomUUID().replaceAll("-","").slice(0,14)}`).toString();
  await observer.query("SELECT pg_advisory_lock($1::bigint)", [key]);
  return { key,release: () => observer.query("SELECT pg_advisory_unlock($1::bigint)", [key]),
    sql: `PERFORM pg_advisory_lock(${key}::bigint); PERFORM pg_advisory_unlock(${key}::bigint);` };
}
async function hook(signature: string, boundary: string, insertion: string, mutate?: (body: string) => string) {
  const before = (await pool.query("SELECT pg_get_functiondef(oid) AS ddl,prosrc,proconfig,proacl::text AS acl FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows[0];
  const body = mutate ? mutate(before.prosrc) : before.prosrc;
  expect(body.split(boundary)).toHaveLength(2);
  await pool.query(before.ddl.replace(before.prosrc,() => body.replace(boundary,() => boundary+insertion)));
  const installed = (await pool.query("SELECT prosrc,proconfig,proacl::text AS acl FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows[0];
  expect(installed.prosrc.replace(insertion,"")).toBe(body); expect(installed.proconfig).toEqual(before.proconfig); expect(installed.acl).toBe(before.acl);
  return async () => { await pool.query(before.ddl); expect((await pool.query("SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows[0].prosrc).toBe(before.prosrc); };
}
const packageSignature = "public.subscription_package_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz)";
const takeSignature = "public.subscription_quote_preview_take(uuid,uuid,uuid,text,text,integer,text,timestamptz)";
const subscriptionBoundary = "SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;";
async function consentTakeEditLockOrder() {
  const f = await fixture(packs[0]), command = await edit(f), observer = await pool.connect(), t = await session(), e = await session();
  const gateT = await gate(observer), tPid = await pid(t), ePid = await pid(e), hPid = await pid(observer);
  let restore = async () => {};
  try {
    restore = await hook(takeSignature,subscriptionBoundary,gateT.sql);
    const taking = tracked(rpc(t,"subscription_quote_preview_take",[f.actor,f.client,f.subscription,command.action,command.hash,1,randomUUID(),f.at]));
    await blocker(observer,tPid,hPid);
    const editing = tracked(command.invoke(e)); await blocker(observer,ePid,tPid);
    expect((await observer.query("SELECT count(*)::integer AS count FROM pg_locks WHERE pid=$1 AND relation='public.subscription_quote_previews'::regclass", [ePid])).rows[0].count).toBe(0);
    await gateT.release(); const taken = await taking; expect(taken.ok).toBe(true); await t.query("COMMIT");
    const edited = await editing; if (!edited.ok) throw edited.error; expect(edited.value).toMatchObject({ status: "applied",templateVersion: 2 }); await e.query("COMMIT");
    expect((await pool.query("SELECT status,accepted_idempotency_key FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ status: "accepted",accepted_idempotency_key: command.key }]);
  } finally { await gateT.release(); await restore(); await t.query("ROLLBACK"); await e.query("ROLLBACK"); t.release(); e.release(); observer.release(); }
  const mutant = await fixture(packs[1]), mutation = await edit(mutant), h = await pool.connect(), t2 = await session(), e2 = await session();
  const stop = await gate(h), tp = await pid(t2), ep = await pid(e2), hp = await pid(h);
  const oldOrder = `PERFORM 1 FROM public.subscription_quote_previews WHERE subscription_id=p_subscription_id AND quote_hash=p_payload->>'acceptedQuoteHash' FOR UPDATE;\n `;
  let restoreTake = async () => {};
  try {
    restoreTake = await hook(takeSignature,subscriptionBoundary,stop.sql);
    restore = await hook(packageSignature,subscriptionBoundary,"",body => body.replace(subscriptionBoundary,() => oldOrder+subscriptionBoundary));
    const taking = tracked(rpc(t2,"subscription_quote_preview_take",[mutant.actor,mutant.client,mutant.subscription,mutation.action,mutation.hash,1,randomUUID(),mutant.at]));
    await blocker(h,tp,hp); const editing = tracked(mutation.invoke(e2)); await blocker(h,ep,tp); await stop.release();
    await blocker(h,tp,ep);
    const first = await Promise.race([taking.then(result => ({ db: t2,result })),editing.then(result => ({ db: e2,result }))]);
    // Either response can be observed first after both queries have settled.
    await first.db.query("ROLLBACK"); const results = await Promise.all([taking,editing]);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    for (const result of results) if (!result.ok) expect(result.error).toMatchObject({ code: "40P01" });
    await t2.query("ROLLBACK"); await e2.query("ROLLBACK");
  } finally { await stop.release(); await restoreTake(); await restore(); await t2.query("ROLLBACK"); await e2.query("ROLLBACK"); t2.release(); e2.release(); h.release(); }
}
it("F6 subscription precedes its owned preview, with the old-order cycle control", consentTakeEditLockOrder);
it("edit_consent_take_edit_lock_order", consentTakeEditLockOrder);

it("F6 reverse: preview-take refuses the old template after the edit commits", async () => {
  const f = await fixture(packs[2]), command = await edit(f), h = await pool.connect(), e = await session(), t = await session();
  const stop = await gate(h), ep = await pid(e), tp = await pid(t), hp = await pid(h);
  let restore = async () => {};
  try {
    restore = await hook(packageSignature,subscriptionBoundary,stop.sql);
    const editing = tracked(command.invoke(e)); await blocker(h,ep,hp);
    const taking = tracked(rpc(t,"subscription_quote_preview_take",[f.actor,f.client,f.subscription,command.action,command.hash,1,randomUUID(),f.at]));
    await blocker(h,tp,ep); await stop.release(); expect((await editing).ok).toBe(true); await e.query("COMMIT");
    const result = await taking; expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: "22023",message: "subscription_edit_stale_template" });
    await t.query("ROLLBACK");
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_command_receipts WHERE subscription_id=$1", [f.subscription])).rows[0].count).toBe(1);
  } finally { await stop.release(); await e.query("ROLLBACK"); await t.query("ROLLBACK"); await restore(); e.release(); t.release(); h.release(); }
});

const admissionSignature = "public.catalog_edit_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text,text)";
const sharedBoundary = "PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0));";
async function payment(f: Fixture, numbered = false) {
  const cycle = randomUUID(), order = randomUUID();
  if (numbered) {
    await pool.query(`WITH saved AS (
      INSERT INTO public.subscription_renewal_operations(subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,
        cycle_snapshot,claim_token,claimed_by,claimed_at,lease_expires_at)
      VALUES($2,$3::timestamptz-interval '28 days',1,$4,repeat('f',64),'{"cycle":{"status":"correlated","logicalCycleNumber":2}}',
        $5,'synthetic',$3::timestamptz-interval '2 minutes',$3::timestamptz-interval '1 minute') RETURNING id,scheduled_at,operation_fingerprint
    ) INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint)
      SELECT $1,$2,scheduled_at,'planned',id,operation_fingerprint FROM saved`, [cycle,f.subscription,f.at,`numbered-cycle:${randomUUID()}`,randomUUID()]);
  } else {
    await pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3::timestamptz-interval '28 days','planned')", [cycle,f.subscription,f.at]);
  }
  await pool.query("WITH o AS (INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'pending_payment','XXX',617) RETURNING id) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$4,1,1,617,617 FROM o", [order,f.client,cycle,f.sku]);
  const options = { dunningTemplateSlug: "failed",recoveryUrlPath: "/recover",recoveryTemplateSlug: "recovered" };
  await rpc(pool,"payment_method_ref_upsert",[`method:${f.subscription}`,f.client,f.subscription,"example_rail","card",
    `customer:${f.client}`,`method:${f.subscription}`,null,"active",true,null,{ recurringModel: "O" },{}]);
  const control = createPostgresProviderPaymentControlPort(pool,options);
  const intent = await control.createIntent({ idempotencyKey: `intent:${order}`,targetKind: "subscription_cycle",orderId: order,
    subscriptionId: f.subscription,subscriptionCycleId: cycle,amountMinor: 617,currency: "XXX",metadata: {},channelKey: "example_rail",at: f.at });
  const prepare = { idempotencyKey: `prepare:${order}`,paymentIntentId: intent.id,provider: "example_rail",providerIdempotencyKey: `provider:${order}`,
    providerRequestFingerprint: digest(order),providerFlow: "one_time_payment",paymentMethodRef: null,requestPayload: { source: "fixture" } };
  const attempt = await control.prepareProviderAttempt(prepare);
  await control.finalizeProviderAttempt({ idempotencyKey: `finalize:${order}`,paymentIntentId: intent.id,paymentAttemptId: attempt.paymentAttemptId,
    providerIdempotencyKey: prepare.providerIdempotencyKey,providerRequestFingerprint: prepare.providerRequestFingerprint,
    providerAttemptId: `attempt:${order}`,providerSessionId: `session:${order}`,attemptStatus: "processing",nextActionKind: null,
    requestPayload: {},responsePayload: { providerCall: true } });
  const event = await createPostgresPaymentWebhookControlPort(pool,options).ingestPaymentEvent({ provider: "example_rail",providerEventId: `event:${order}`,
    providerPaymentId: `attempt:${order}`,eventType: "payment.succeeded",paymentIntentId: intent.id,amountMinor: 617,currency: "XXX",occurredAt: f.at,rawPayload: { kind: "payment.succeeded" } });
  return { cycle,order,intent: intent.id,
    invoke: (db: PoolClient,settlement = false) => settlement
      ? rpc(db,"commerce_record_settlement",[`settle:${order}`,intent.id,"succeeded",`event:${order}`,{},f.at])
      : createPostgresProviderPaymentControlPort(db,options).applyPaymentResult({ idempotencyKey: `result:${order}`,paymentIntentId: intent.id,
        paymentEventId: event.paymentEventId,resultStatus: "succeeded",occurredAt: f.at,failureReason: null }) };
}
async function assertPrelocked(db: PoolClient, f: Fixture, lane: Lane) {
  for (const table of ["subscription_lines",...(lane === "legacy" ? [] : ["subscription_renewal_term_lines"])]) {
    await db.query("SAVEPOINT probe");
    let refused = false;
    try { await db.query(`SELECT 1 FROM public.${table} WHERE subscription_id=$1 FOR KEY SHARE NOWAIT`, [f.subscription]); }
    catch (error) { expect(error).toMatchObject({ code: "55P03" }); refused = true; }
    await db.query("ROLLBACK TO SAVEPOINT probe");
    if (!refused) throw new Error(`existing commerce row unheld after first catalogue lock: ${table}`);
  }
}
const applySignature = (lane: Lane) => lane === "classic" ? packageSignature : lane === "exact"
  ? "public.subscription_line_edit_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz)" : lane === "sized"
    ? "public.subscription_sized_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz)"
    : "public.customer_subscription_apply_bundle_as_actor(uuid,text,text,jsonb,jsonb,jsonb,integer,integer)";
async function assertAgreement(f: Fixture, command: Awaited<ReturnType<typeof edit>>, lane: Lane, paymentMayExtend = false) {
  expect((await pool.query(`SELECT status,currency_code,cadence_days,next_cycle_at${paymentMayExtend ? ">=" : "="}$2::timestamptz AS anchor FROM public.subscriptions WHERE id=$1`, [f.subscription,f.anchor])).rows[0])
    .toMatchObject({ status: "active",currency_code: "XXX",cadence_days: lane === "exact" ? 30 : 28,anchor: true });
  expect((await pool.query("SELECT quantity,unit_price_minor,catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows)
    .toEqual([{ quantity: 2,unit_price_minor: "617",catalog_sku_revision_id: f.reference.skuRevisionId }]);
  expect((await pool.query("SELECT count(*)::integer AS count FROM public.subscription_events WHERE subscription_id=$1 AND event_type LIKE 'subscription.customer_self_service.%'", [f.subscription])).rows[0].count).toBe(1);
  if (lane !== "legacy") expect((await pool.query("SELECT status FROM public.subscription_command_receipts WHERE actor_id=$1 AND idempotency_key=$2", [f.actor,command.key])).rows).toEqual([{ status: "applied" }]);
}
async function consentEditBeforePayment(pack: string, lane: Lane, rail: string) {
  const f = await fixture(pack), command = await edit(f,lane), paid = await payment(f), h = await pool.connect(), e = await session(), p = await session();
  const stop = await gate(h), ep = await pid(e), pp = await pid(p), hp = await pid(h);
  let restore = async () => {};
  try {
    await e.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    restore = await hook(admissionSignature,sharedBoundary,stop.sql);
    const editing = tracked(command.invoke(e)); await blocker(h,ep,hp); await assertPrelocked(p,f,lane);
    const paying = tracked(paid.invoke(p,rail === "settlement")); await blocker(h,pp,ep);
    await stop.release(); const edited = await editing; if (!edited.ok) throw edited.error;
    const returnedAnchor = lane === "legacy" ? edited.value.subscriptionAction.nextCycleAt : edited.value.nextCycleAt;
    expect((await h.query("SELECT $1::timestamptz=$2::timestamptz AS same", [returnedAnchor,f.anchor])).rows[0].same).toBe(true);
    await e.query("COMMIT");
    const result = await paying; if (!result.ok) throw result.error; await p.query("COMMIT");
    await assertAgreement(f,command,lane,true);
    expect((await pool.query("SELECT status,total_amount_minor FROM public.commerce_orders WHERE id=$1", [paid.order])).rows).toEqual([{ status: "paid",total_amount_minor: "617" }]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [paid.intent])).rows[0].count).toBe(1);
  } finally { await stop.release(); await e.query("ROLLBACK"); await p.query("ROLLBACK"); await restore(); e.release(); p.release(); h.release(); }
}
describe.each(packs.flatMap(pack => lanes.flatMap(lane => ["provider", "settlement"].map(rail => ({ pack,lane,rail })))))("F1 $pack $lane $rail", ({ pack,lane,rail }) => {
  it("lock_matrix_races_native_payment_settlement", () => consentEditBeforePayment(pack,lane,rail));
 });

it("F1 control: removing only the new prelocks makes the existing-row witness fail", async () => {
  const f = await fixture(packs[0]), command = await edit(f), paid = await payment(f), h = await pool.connect(), e = await session(), p = await session();
  const stop = await gate(h), ep = await pid(e), pp = await pid(p), hp = await pid(h);
  let restoreGuard = async () => {}, restoreApply = async () => {};
  try {
    restoreApply = await hook(packageSignature,subscriptionBoundary,"",body => {
      const mutant = body.replace(/ {2}PERFORM 1 FROM public\.subscription_(?:lines|renewal_term_lines) WHERE subscription_id=s\.id ORDER BY (?:id|line_ordinal) FOR UPDATE;\n/gu,"");
      expect(mutant).not.toBe(body); return mutant;
    });
    restoreGuard = await hook(admissionSignature,sharedBoundary,stop.sql);
    const editing = tracked(command.invoke(e)); await blocker(h,ep,hp);
    await expect(assertPrelocked(p,f,"classic")).rejects.toThrow("existing commerce row unheld after first catalogue lock");
    const paying = tracked(paid.invoke(p)); await blocker(h,pp,ep);
    await stop.release(); expect((await editing).ok).toBe(true); await e.query("COMMIT"); expect((await paying).ok).toBe(true); await p.query("COMMIT");
  } finally { await stop.release(); await e.query("ROLLBACK"); await p.query("ROLLBACK"); await restoreGuard(); await restoreApply(); e.release(); p.release(); h.release(); }
});
async function consentPaymentBeforeEdit(rail: string) {
  const f = await fixture(packs[1]), command = await edit(f), paid = await payment(f), h = await pool.connect(), e = await session(), p = await session();
  const stop = await gate(h), ep = await pid(e), pp = await pid(p), hp = await pid(h);
  let restore = async () => {};
  try {
    restore = await hook("public.payment_provider_lock_aggregate(uuid)","PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE;",stop.sql);
    const paying = tracked(paid.invoke(p,rail === "settlement")); await blocker(h,pp,hp);
    const editing = tracked(command.invoke(e)); await blocker(h,ep,pp);
    await assertNoCatalogGuard(h,ep);
    await stop.release(); expect((await paying).ok).toBe(true); await p.query("COMMIT");
    f.anchor = (await pool.query("SELECT to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS anchor FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].anchor;
    const edited = await editing; if (!edited.ok) throw edited.error; await e.query("COMMIT"); await assertAgreement(f,command,"classic");
  } finally { await stop.release(); await p.query("ROLLBACK"); await e.query("ROLLBACK"); await restore(); e.release(); p.release(); h.release(); }
}
it.each(["provider", "settlement"])("F2 payment owns the subscription before the edit acquires any catalogue guard: %s", consentPaymentBeforeEdit);
it("edit_consent_payment_edit_serialization_both_directions", async () => {
  await consentEditBeforePayment(packs[0],"classic","provider");
  await consentPaymentBeforeEdit("provider");
});

it("F2 control: a catalogue-first edit fails the lock-order witness", async () => {
  const f = await fixture(packs[0]), command = await edit(f), paid = await payment(f), h = await pool.connect(), e = await session(), p = await session();
  const stop = await gate(h), ep = await pid(e), pp = await pid(p), hp = await pid(h);
  let restorePayment = async () => {}, restoreEdit = async () => {}, restoreAdmission = async () => {};
  try {
    restorePayment = await hook("public.payment_provider_lock_aggregate(uuid)","PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE;",stop.sql);
    restoreEdit = await hook(packageSignature,subscriptionBoundary,"",body => body.replace(subscriptionBoundary,() => sharedBoundary+"\n "+subscriptionBoundary));
    restoreAdmission = await hook(admissionSignature,"RAISE EXCEPTION 'catalog_propagation_admission_boundary_invalid' USING ERRCODE='22023'; END IF;","",body => body.replace(sharedBoundary,""));
    const paying = tracked(paid.invoke(p)); await blocker(h,pp,hp);
    const editing = tracked(command.invoke(e)); await blocker(h,ep,pp);
    await expect(assertNoCatalogGuard(h,ep)).rejects.toThrow("catalogue guard held before subscription");
    await stop.release(); expect((await paying).ok).toBe(true); await p.query("COMMIT");
    const edited = await editing; if (!edited.ok) throw edited.error; await e.query("COMMIT");
  } finally { await stop.release(); await p.query("ROLLBACK"); await e.query("ROLLBACK"); await restorePayment(); await restoreEdit(); await restoreAdmission(); e.release(); p.release(); h.release(); }
});

async function changedDocument(f: Fixture) {
  const value = structuredClone(f.value), document = { schemaVersion: 1,derived: 12,label: "Equal-money editorial revision" };
  const canonicalText = canonicalCatalogDraftJson(document), revisionId = randomUUID();
  value.product.sharedContent = { ...value.product.sharedContent,catalogAction: "revise",document };
  value.product.documentRevision = { ...value.product.documentRevision!,id: revisionId,revisionNo: 2,digest: digest(canonicalText) };
  value.publication.operations = [
    { op: "register_document_revision",productSlug: value.product.slug!,revisionId,revisionNo: 2,documentRef: "example:document",sourceRef: "example:source",canonicalText,digest: digest(canonicalText),provenance: { source: "current_draft" } },
    { op: "move_document_pointer",productSlug: value.product.slug!,documentRevisionNo: 2 },
  ];
  const db = await pool.connect();
  try { return { value,...await candidate(db,value,f.draft,1,f.head) }; } finally { db.release(); }
}
async function publishOn(db: PoolClient, publication: CatalogPublishCommand, afterQuery?: (sql: string,values: unknown[]) => Promise<void>) {
  const authority = publisher(db,afterQuery), actor = (await authority.authorize(null))!;
  return authority.publish(publication,actor);
}
it.each(packs.flatMap(pack => lanes.map(lane => ({ pack,lane }))))("F4 subscription_edit_refuses_publication_race; subscription_equal_money_document_drift_refuses $pack $lane", async ({ pack,lane }) => {
  const f = await fixture(pack), command = await edit(f,lane), next = await changedDocument(f);
  const h = await pool.connect(), w = await pool.connect(), e = await session(), stop = await gate(h);
  const wp = await pid(w), ep = await pid(e), hp = await pid(h);
  let reached = false;
  try {
    await e.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    const publishing = tracked(publishOn(w,next.publication,async (sql,values) => {
      if (!reached && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0]===`catalog-lineage:${f.product}`) {
        reached = true; await w.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await w.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]);
      }
    }));
    await blocker(h,wp,hp); const editing = tracked(command.invoke(e)); await blocker(h,ep,wp);
    const templateBefore = (await pool.query("SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows;
    await stop.release(); const written = await publishing; if (!written.ok) throw written.error;
    expect(written.value.outcome).toBe("committed"); const afterPublication = await snapshot();
    const refused = await editing; expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatchObject({ code: "40001",message: "customer_self_service_stale_edit_catalog_head" });
    await e.query("ROLLBACK"); expect(await snapshot()).toEqual(afterPublication);
    expect((await pool.query("SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows).toEqual(templateBefore);
    expect(reached).toBe(true);
  } finally { await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); e.release(); w.release(); h.release(); }
});
it("subscription_edit_refuses_publication_race", async () => {
  for (const pack of packs) {
    const f = await fixture(pack), command = await edit(f), next = await changedDocument(f), h = await pool.connect(), w = await pool.connect(), e = await session();
    const stop = await gate(h), wp = await pid(w), ep = await pid(e), hp = await pid(h); let reached = false;
    try {
      const publishing = tracked(publishOn(w,next.publication,async (sql,values) => {
        if (!reached && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0]===`catalog-lineage:${f.product}`) {
          reached = true; await w.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await w.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]);
        }
      }));
      await blocker(h,wp,hp); const editing = tracked(command.invoke(e)); await blocker(h,ep,wp); await stop.release();
      const written = await publishing; if (!written.ok) throw written.error; expect(written.value.outcome).toBe("committed");
      const before = await snapshot(), result = await editing; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: "40001",message: "customer_self_service_stale_edit_catalog_head" });
      await e.query("ROLLBACK"); expect(await snapshot()).toEqual(before);
    } finally { await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); e.release(); w.release(); h.release(); }
  }
});
it("F4 control: removing only the guarded head check admits an equal-money stale preview", async () => {
  const f = await fixture(packs[0]), command = await edit(f), next = await changedDocument(f), h = await pool.connect(), w = await pool.connect(), e = await session();
  const stop = await gate(h), wp = await pid(w), ep = await pid(e), hp = await pid(h); let reached = false, restore = async () => {};
  try {
    restore = await hook(admissionSignature,sharedBoundary,"",body => {
      const mutant = body.replace(/ {2}IF publication\.id IS NULL[\s\S]*?RAISE EXCEPTION '%',moved USING ERRCODE='40001'; END IF;/u,"");
      expect(mutant).not.toBe(body); return mutant;
    });
    const publishing = tracked(publishOn(w,next.publication,async (sql,values) => {
      if (!reached && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0]===`catalog-lineage:${f.product}`) {
        reached = true; await w.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await w.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]);
      }
    }));
    await blocker(h,wp,hp); const editing = tracked(command.invoke(e)); await blocker(h,ep,wp); await stop.release();
    const written = await publishing; if (!written.ok) throw written.error; expect(written.value.outcome).toBe("committed");
    const result = await editing; if (!result.ok) throw result.error; expect(result.value.status).toBe("applied"); await e.query("ROLLBACK");
    expect(result.value.status,"stale-refusal witness fails when its guarded head comparison is removed").not.toBe("refused");
  } finally { await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); await restore(); e.release(); w.release(); h.release(); }
});
async function assertBusy(result: unknown, before: Record<string, unknown>) {
  expect(result).toMatchObject({ outcome: "conflict",reason: "catalog_publication_busy" });
  expect(await snapshot()).toEqual(before);
}
async function consentPublisherBusyThenRetry(pack: string, lane: Lane) {
  const f = await fixture(pack), command = await edit(f,lane), next = await changedDocument(f);
  const h = await pool.connect(), e = await session(), w = await pool.connect(), stop = await gate(h);
  const ep = await pid(e), hp = await pid(h); let restore = async () => {};
  try {
    await e.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    restore = await hook(admissionSignature,sharedBoundary,stop.sql);
    const editing = tracked(command.invoke(e)); await blocker(h,ep,hp); const before = await snapshot();
    await assertBusy(await publishOn(w,next.publication),before);
    await stop.release(); const edited = await editing; if (!edited.ok) throw edited.error; await e.query("COMMIT");
    await assertAgreement(f,command,lane);
    const agreed = (await pool.query("SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows;
    const retry = await publishOn(w,next.publication); expect(retry.outcome).toBe("committed");
    expect((await pool.query("SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1", [f.subscription])).rows).toEqual(agreed);
    await e.query("BEGIN");
    await e.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    const replayed = await command.invoke(e); await e.query("COMMIT");
    expect(lane === "legacy" ? replayed.subscriptionAction.status : replayed.status).toBe("replayed");
  } finally { await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); await restore(); e.release(); w.release(); h.release(); }
}
it.each(packs.flatMap(pack => lanes.map(lane => ({ pack,lane }))))("F5 edit excludes publication with donor busy refusal, then publisher retry succeeds $pack $lane",
  ({ pack,lane }) => consentPublisherBusyThenRetry(pack,lane));
it("edit_consent_publisher_busy_then_retry", () => consentPublisherBusyThenRetry(packs[0],"classic"));

it("F5 control: removing only the edit shared guard lets the publisher proceed", async () => {
  const f = await fixture(packs[0]), command = await edit(f), next = await changedDocument(f);
  const h = await pool.connect(), e = await session(), w = await pool.connect(), stop = await gate(h);
  const ep = await pid(e), hp = await pid(h); let restore = async () => {};
  try {
    const boundary = "RAISE EXCEPTION 'catalog_propagation_admission_boundary_invalid' USING ERRCODE='22023'; END IF;";
    restore = await hook(admissionSignature,boundary,stop.sql,body => {
      expect(body.split(sharedBoundary)).toHaveLength(2); return body.replace(sharedBoundary,"");
    });
    const editing = tracked(command.invoke(e)); await blocker(h,ep,hp); const before = await snapshot();
    const published = await publishOn(w,next.publication); expect(published.outcome).toBe("committed");
    await expect(assertBusy(published,before)).rejects.toThrow();
    await stop.release(); const refused = await editing; expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatchObject({ code: "40001",message: "customer_self_service_stale_edit_catalog_head" });
    await e.query("ROLLBACK");
    expect((await pool.query("SELECT template_version FROM public.subscriptions WHERE id=$1", [f.subscription])).rows).toEqual([{ template_version: 1 }]);
  } finally { await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); await restore(); e.release(); w.release(); h.release(); }
});

async function renewal(f: Fixture, stage: "claim" | "prepare" | "retry") {
  const paidCycle = randomUUID(), order = randomUUID();
  await pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) SELECT $1,id,started_at,'paid' FROM public.subscriptions WHERE id=$2", [paidCycle,f.subscription]);
  await pool.query("WITH o AS (INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'paid','XXX',617) RETURNING id) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) SELECT id,$4,1,1,617,617 FROM o", [order,f.client,paidCycle,f.sku]);
  await pool.query("INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,cadence_days,state,payment_fingerprint,activation_idempotency_key,declare_idempotency_key,activated_at) VALUES($1,$2,$3,28,'active',$4,$5,$6,$7)", [order,f.client,f.subscription,digest(order),`active:${order}`,`declare:${order}`,f.at]);
  await pool.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3::jsonb,$4)", [order,f.subscription,
    { templateId: "synthetic",shippingAmountMinor: 0,acquisitionRef: null,renewalTerms: { version: "native.renewal-terms.v1" } },f.at]);
  const now = (await pool.query("SELECT to_char((next_cycle_at+interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].at as string;
  const codec = createNativeCatalogRenewalCodecV2(value => catalogAcceptedReferenceV2Schema.parse(value));
  const builder = createPostgresRenewalStore(pool,codec,work => work(pool));
  const due = (await builder.listDue(1000,now)).find(value => value.subscriptionId===f.subscription);
  if (!due) throw new Error("Missing recorded due subscription");
  const frozen = await builder.buildCycleSnapshots(due), encoded = codec.encode(frozen);
  const claim = (db: PoolClient | Pool) => createPostgresRenewalStore(db,codec).claimDue({ snapshot: frozen,workerId: "admission-fixture",now });
  if (stage === "claim") return { invoke: (db: PoolClient) => claim(db),signature: "public.subscription_claim_due_renewal(text,text,jsonb,text,integer,timestamptz)",
    boundary: "SELECT * INTO v_subscription\n    FROM public.subscriptions\n   WHERE id = v_subscription_id\n   FOR UPDATE;",encoded,codec,now };
  const operation = await claim(pool);
  await pool.query("INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint) VALUES('synthetic',$1,100,100,0,'sellable',$2,$3::timestamptz+interval '7 days',$4,$4,$5)", [f.code,f.at,now,`stock:${f.sku}`,digest(f.sku)]);
  await rpc(pool,"fulfillment_reserve_subscription_renewal",[operation.operationId,operation.claimToken,900,now]);
  const prepare = (db: PoolClient | Pool) => rpc(db,"commerce_prepare_subscription_renewal",[operation.operationId,operation.claimToken,now]);
  if (stage === "prepare") return { invoke: (db: PoolClient) => prepare(db),signature: "public.commerce_prepare_subscription_renewal(uuid,uuid,timestamptz)",
    boundary: "PERFORM id FROM public.subscriptions\n   WHERE id = v_operation.subscription_id FOR UPDATE;",encoded,codec,now };
  const prepared = await prepare(pool);
  await rpc(pool,"commerce_acknowledge_subscription_renewal_attempt",[operation.operationId,operation.operationFingerprint,`attempt:${operation.operationId}`,now]);
  const raw = encoded as Record<string, unknown>, cycle = raw.cycle as { logicalCycleNumber: number };
  await rpc(pool,"subscription_retry_apply_failure",[operation.operationId,`failure:${operation.operationId}`,
    { attemptSequence: 0,logicalCycleNumber: cycle.logicalCycleNumber,occurredAt: now,failureClass: "temporary",reason: "declined",externalRef: `attempt:${operation.operationId}`,
      evidenceKey: `failure-evidence:${operation.operationId}`,firstRecordedAt: now }]);
  // A retained unpaid obligation may belong to an earlier scheduled cycle. Its
  // exact frozen basket remains independent of the future editable template.
  await pool.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '28 days' WHERE id=$1", [f.subscription]);
  f.anchor = (await pool.query("SELECT to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS anchor FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].anchor;
  const retryNow = (await pool.query("SELECT to_char(next_retry_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1", [operation.operationId])).rows[0].at as string;
  f.at = retryNow;
  const input = { paymentIntentId: prepared.settlementIntentId,orderRef: prepared.orderId,amountMinor: 617,currency: "XXX",idempotencyKey: randomUUID(),
    providerIdempotencyKey: randomUUID(),providerRequestFingerprint: digest(operation.operationId),paymentMethodRef: "synthetic-method" };
  return { invoke: (db: PoolClient) => rpc(db,"subscription_retry_prepare",[operation.operationId,`retry:${operation.operationId}`,input,retryNow]),
    signature: "public.subscription_retry_prepare(uuid,text,jsonb,timestamptz)",
    boundary: "PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;",encoded,codec,now: retryNow };
}
it.each(["claim", "prepare", "retry"] as const)("F3 renewal/retry owns subscription before edit: %s", async stage => {
  const f = await fixture(packs[0]), renew = await renewal(f,stage), command = await edit(f), h = await pool.connect(), r = await session(), e = await session();
  const stop = await gate(h), rp = await pid(r), ep = await pid(e), hp = await pid(h); let restore = async () => {};
  try {
    restore = await hook(renew.signature,renew.boundary,stop.sql);
    const renewing = tracked(renew.invoke(r)); await blocker(h,rp,hp); const editing = tracked(command.invoke(e)); await blocker(h,ep,rp);
    expect((await h.query("SELECT count(*)::integer AS count FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND ((classid::bigint<<32)|objid::bigint)=hashtextextended('catalog-publication-global',0)", [ep])).rows[0].count).toBe(0);
    await stop.release(); const result = await renewing; if (!result.ok) throw result.error; await r.query("COMMIT");
    const afterRenewal = await snapshot(), edited = await editing;
    if (stage === "prepare") {
      expect(edited.ok).toBe(false); if (!edited.ok) expect(edited.error).toMatchObject({ message: "subscription_lifecycle_payment_blocked" });
      await e.query("ROLLBACK"); expect(await snapshot()).toEqual(afterRenewal);
    } else { if (!edited.ok) throw edited.error; await e.query("COMMIT"); await assertAgreement(f,command,"classic"); }
    expect((await pool.query("SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ cycle_snapshot: renew.encoded }]);
  } finally { await stop.release(); await r.query("ROLLBACK"); await e.query("ROLLBACK"); await restore(); r.release(); e.release(); h.release(); }
});
it.each(["claim", "prepare", "retry"] as const)("F3 edit prelocks before frozen renewal/retry, reverse: %s", async stage => {
  const f = await fixture(packs[1]), renew = await renewal(f,stage), command = await edit(f), h = await pool.connect(), r = await session(), e = await session();
  const stop = await gate(h), rp = await pid(r), ep = await pid(e), hp = await pid(h); let restore = async () => {};
  try {
    restore = await hook(admissionSignature,sharedBoundary,stop.sql);
    const editing = tracked(command.invoke(e)); await blocker(h,ep,hp); await assertPrelocked(r,f,"classic");
    const renewing = tracked(renew.invoke(r)); await blocker(h,rp,ep);
    await stop.release(); const edited = await editing; if (!edited.ok) throw edited.error; await e.query("COMMIT");
    const result = await renewing; if (!result.ok) throw result.error; await r.query("COMMIT"); await assertAgreement(f,command,"classic");
    expect((await pool.query("SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ cycle_snapshot: renew.encoded }]);
  } finally { await stop.release(); await e.query("ROLLBACK"); await r.query("ROLLBACK"); await restore(); r.release(); e.release(); h.release(); }
});

async function businessSnapshot() {
  const rows = await snapshot();
  for (const name of Object.keys(rows)) if (/^(catalog_|price_)/u.test(name)) delete rows[name];
  rows.outbox_events = (rows.outbox_events as { row: { event_type: string } }[]).filter(entry => entry.row.event_type !== "catalog.publication.committed");
  return rows;
}
it("catalog_change_never_advances_cycle", async () => {
  for (const pack of packs) {
    const f = await fixture(pack), before = await businessSnapshot(), next = await changedDocument(f), db = await pool.connect();
    try { expect((await publishOn(db,next.publication)).outcome).toBe("committed"); } finally { db.release(); }
    expect(await businessSnapshot()).toEqual(before);
  }
});
it("subscription_equal_money_document_drift_refuses", async () => {
  for (const pack of packs) {
    const f = await fixture(pack), command = await edit(f), next = await changedDocument(f), w = await pool.connect();
    try { expect((await publishOn(w,next.publication)).outcome).toBe("committed"); } finally { w.release(); }
    const before = await snapshot(), db = await session();
    try { await expect(command.invoke(db)).rejects.toMatchObject({ code: "40001",message: "customer_self_service_stale_edit_catalog_head" }); }
    finally { await db.query("ROLLBACK"); db.release(); }
    expect(await snapshot()).toEqual(before);
  }
});
it("subscription_renewal_ignores_new_catalog_prices", async () => {
  for (const pack of packs) {
    const f = await fixture(pack), renew = await renewal(f,"claim"), db = await session();
    let operation: { operationId: string; claimToken: string | null };
    try { operation = await renew.invoke(db); await db.query("COMMIT"); } finally { await db.query("ROLLBACK"); db.release(); }
    // Fixture changes the current price; price-writer qualification belongs to its existing witness.
    await pool.query("UPDATE public.price_entries SET unit_price_minor=999 WHERE variant_id=$1", [f.sku]);
    expect((await pool.query("SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1", [operation.operationId])).rows).toEqual([{ cycle_snapshot: renew.encoded }]);
    expect(renew.encoded).toMatchObject({ totalAmountMinor: 617,lines: [{ sku: f.code,quantity: 1,unitAmountMinor: 617 }] });
    const replay = await session();
    try { expect(await renew.invoke(replay)).toMatchObject({ operationId: operation.operationId,replayed: true }); await replay.query("COMMIT"); }
    finally { await replay.query("ROLLBACK"); replay.release(); }
  }
});
it("subscription_stock_wait_keeps_exact_obligation", async () => {
  for (const pack of packs) {
    const f = await fixture(pack), renew = await renewal(f,"claim"), db = await session();
    let operation: { operationId: string; claimToken: string | null };
    try { operation = await renew.invoke(db); await db.query("COMMIT"); } finally { await db.query("ROLLBACK"); db.release(); }
    await pool.query("INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint) VALUES('synthetic',$1,0,0,0,'sellable',$2,$3::timestamptz+interval '7 days',$4,$4,$5)", [f.code,f.at,renew.now,`stock:${f.sku}`,digest(f.sku)]);
    const store = createPostgresStockWaitStore({ executor: pool,codec: renew.codec,workerId: "catalog-admission-stock",
      async withTransaction(work) { const connection = await session(); try { const value = await work(connection); await connection.query("COMMIT"); return value; }
        catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); } } });
    const waiting = await store.admit({ operationId: operation.operationId,claimToken: operation.claimToken!,snapshot: renew.codec.decode(renew.encoded),now: renew.now });
    expect(waiting.waiting).toBe(true);
    const before = (await pool.query("SELECT cycle_snapshot,fingerprint,scheduled_at FROM public.subscription_stock_wait_cases WHERE id=$1", [waiting.caseId])).rows;
    const next = await changedDocument(f), w = await pool.connect();
    try { expect((await publishOn(w,next.publication)).outcome).toBe("committed"); } finally { w.release(); }
    expect((await pool.query("SELECT cycle_snapshot,fingerprint,scheduled_at FROM public.subscription_stock_wait_cases WHERE id=$1", [waiting.caseId])).rows).toEqual(before);
    expect(before[0].cycle_snapshot).toEqual(renew.encoded);
    expect((await pool.query("SELECT status,next_cycle_at=$2::timestamptz AS anchor FROM public.subscriptions WHERE id=$1", [f.subscription,f.anchor])).rows).toEqual([{ status: "active",anchor: true }]);
  }
});
it("CatalogAdmissionPort asserts through the native transaction and refuses incomplete evidence", async () => {
  const f = await fixture(packs[0]), port = createPostgresCatalogAdmission(), db = await session();
  const input: CatalogAdmissionInput = { ...f.admission,offerEvidence: { offerVersion: "classic",subscriptionId: f.subscription,lane: "classic" } };
  try {
    await db.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscription]);
    const before = await snapshot(); await port.assertCurrent(db,input); expect(await snapshot()).toEqual(before);
    await port.assertCurrent(db,{ ...input,purpose: "order",skuRevisions: [{ reference: f.reference,quantity: 2147483647 }] });
    expect(await snapshot()).toEqual(before);
    for (const delta of [{ heads: [] },{ skuRevisions: [] },{ priceContextVersions: [] }]) {
      await db.query("SAVEPOINT evidence"); await expect(port.assertCurrent(db,{ ...input,...delta })).rejects.toMatchObject({ severity: "ERROR" });
      await db.query("ROLLBACK TO SAVEPOINT evidence"); expect(await snapshot()).toEqual(before);
    }
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("subscription_swap_target_withdrawn_after_preview", async () => {
  for (const pack of packs) {
    const f = await fixture(pack), target = await fixture(pack), key = randomUUID(), hash = digest(key);
    const request = { action: "swap_base_line",fromVariantId: f.sku,toVariantId: target.sku,expectedTemplateVersion: 1,acceptedQuoteHash: hash };
    const lines = [{ variantId: target.sku,qty: 1,isAddon: false,lineId: (await pool.query("SELECT id FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows[0].id,
      quoteLine: { sku: target.code,quantity: 1,unitPriceGross: money(617),lineSubtotalGross: money(617) } }];
    const entry = randomUUID(), priceListId = f.admission.priceContextVersions[0]!.priceListId;
    await pool.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',617,$4::timestamptz-interval '1 day')", [entry,priceListId,target.sku,f.at]);
    const entryFacts = (await pool.query("SELECT to_jsonb(p) AS row FROM public.price_entries p WHERE id=$1", [entry])).rows[0].row;
    const admission = { ...target.admission,skuRevisions: [{ reference: target.reference,quantity: 1 }],
      priceContextVersions: [{ skuId: target.sku,priceListId,entryId: entry,entry: entryFacts }] };
    const evidence = { lines,cadenceDays: 28,compositionConstraint: null,catalogAdmission: admission };
    await rpc(pool,"subscription_quote_preview_record",[f.actor,f.client,f.subscription,"swap_base_line",hash,1,
      (await pool.query("SELECT $1::timestamptz+interval '1 hour' AS at", [f.at])).rows[0].at,
      { action: request.action,fromVariantId: f.sku,toVariantId: target.sku },evidence,{},f.at]);
    const trial = await session();
    try {
      expect(await rpc(trial,"subscription_line_edit_apply",[f.actor,f.client,key,f.subscription,"swap_base_line",{ ...request,request,...evidence },f.at])).toMatchObject({ status: "applied" });
      expect((await trial.query("SELECT variant_id,catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows)
        .toEqual([{ variant_id: target.sku,catalog_sku_revision_id: target.reference.skuRevisionId }]);
    } finally { await trial.query("ROLLBACK"); trial.release(); }
    const value = structuredClone(target.value); value.product.sharedContent.catalogAction = "revise";
    value.publication.operations = [{ op: "set_product_lifecycle",productSlug: value.product.slug!,expectedState: "active",state: "withdrawn",
      children: [{ skuCode: target.code,expectedState: "active" }] }];
    const writer = await pool.connect();
    try { const next = await candidate(writer,value,target.draft,1,target.head); expect((await next.authority.publish(next.publication,next.actor)).outcome).toBe("committed"); }
    finally { writer.release(); }
    const before = await snapshot(), db = await session();
    try { await expect(rpc(db,"subscription_line_edit_apply",[f.actor,f.client,key,f.subscription,"swap_base_line",{ ...request,request,...evidence },f.at]))
      .rejects.toMatchObject({ code: "40001",message: "customer_self_service_stale_edit_catalog_head" }); }
    finally { await db.query("ROLLBACK"); db.release(); }
    expect(await snapshot()).toEqual(before);
  }
});

it.each(["one_time", "subscription"] as const)("governed purchase records acceptance and replays after publication in both native writers: %s", async mode => {
  for (const pack of packs) for (const routine of ["commerce_create_order_draft_with_outbox", "commerce_create_promoted_order_draft_with_outbox"]) {
    const f = await fixture(pack), key = randomUUID(), context = { mode,offerVersion: "classic" };
    const lines = [{ sku: f.code,quantity: 2,unitPriceGross: money(617),lineSubtotalGross: money(1234) }];
    const quote = { quote: { context,lines,totalGross: money(1234) },catalogAdmission: { ...f.admission,mode,purpose: "order" } };
    const draft = { contractVersion: "commerce.v0",source: "commerce.order_draft.bff.v0",status: "draft",paymentStatus: "not_started",currency: "XXX",context,lines,discounts: [],
      totals: { subtotalGross: money(1234),totalGross: money(1234),discountTotalGross: money(0),shippingGross: money(0),shippingDiscountGross: money(0) } };
    const first = await session(), firstPid = await pid(first);
    let original: { orderDraft: { orderId: string; replayed: boolean } };
    try { original = await rpc(first,routine,[key,quote,draft,f.client]); await first.query("COMMIT"); }
    finally { await first.query("ROLLBACK"); first.release(true); }
    expect(original.orderDraft.replayed).toBe(false);
    const orderId = original.orderDraft.orderId.replace(/^order_/u,"");
    expect((await pool.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [orderId])).rows)
      .toEqual([{ catalog_acceptance: { schemaVersion: 2,lines: [f.reference] } }]);
    const next = await changedDocument(f), writer = await pool.connect();
    try { expect((await publishOn(writer,next.publication)).outcome).toBe("committed"); } finally { writer.release(); }
    const before = await snapshot(), connection = await session();
    try {
      expect(await pid(connection)).not.toBe(firstPid);
      expect(await rpc(connection,routine,[key,quote,draft,f.client])).toMatchObject({ orderDraft: { orderId: original.orderDraft.orderId,replayed: true } });
      await connection.query("COMMIT"); expect(await snapshot()).toEqual(before);
      await connection.query("BEGIN"); await expect(rpc(connection,routine,[randomUUID(),quote,draft,f.client]))
        .rejects.toMatchObject({ code: "40001",message: "commerce_order_draft_catalog_head_moved" });
      await connection.query("ROLLBACK"); expect(await snapshot()).toEqual(before);
    } finally { await connection.query("ROLLBACK"); connection.release(); }
  }
});

it("sized retained reduction survives withdrawal while increased demand refuses", async () => {
  for (const pack of packs) {
    const f = await fixture(pack), optIn = await edit(f,"sized"), initial = await session();
    try { expect(await optIn.invoke(initial)).toMatchObject({ status: "applied",templateVersion: 2 }); await initial.query("COMMIT"); }
    finally { await initial.query("ROLLBACK"); initial.release(); }
    const value = structuredClone(f.value); value.product.sharedContent.catalogAction = "revise";
    value.publication.operations = [{ op: "set_product_lifecycle",productSlug: value.product.slug!,expectedState: "active",state: "withdrawn",
      children: [{ skuCode: f.code,expectedState: "active" }] }];
    const w = await pool.connect(); let head: CatalogHeadRef;
    try {
      const next = await candidate(w,value,f.draft,1,f.head), written = await next.authority.publish(next.publication,next.actor);
      if (!("receipt" in written)) throw new Error(JSON.stringify(written)); head = written.receipt.head;
    } finally { w.release(); }
    for (const quantity of [3,1]) {
      const key = randomUUID(), hash = digest(key), constraint = { kind: "unit_count",value: quantity,dailyNeed: 1 };
      const request = { action: "resize_bundle",cadenceDays: 28,compositionConstraint: constraint,expectedTemplateVersion: 2,acceptedQuoteHash: hash,
        resizeLever: { kind: "subscription.sized.parcel",value: { coreLines: [{ variantId: f.sku,qty: quantity }] } } };
      const line = { variantId: f.sku,qty: quantity,isAddon: false,quoteLine: { sku: f.code,quantity,unitPriceGross: money(617),lineSubtotalGross: money(617*quantity) } };
      const evidence = { lines: [line],cadenceDays: 28,compositionConstraint: constraint,subjectFacts: { revision: 1 },optInFacts: null,
        catalogAdmission: { ...f.admission,heads: [{ productId: f.product,head }],skuRevisions: [{ reference: f.reference,quantity }] } };
      await rpc(pool,"subscription_quote_preview_record",[f.actor,f.client,f.subscription,request.action,hash,2,
        (await pool.query("SELECT $1::timestamptz+interval '1 hour' AS at", [f.at])).rows[0].at,
        Object.fromEntries(Object.entries(request).filter(([name]) => !["expectedTemplateVersion","acceptedQuoteHash"].includes(name))),evidence,{},f.at]);
      const before = await snapshot(), db = await session();
      try {
        const applying = rpc(db,"subscription_sized_edit_apply",[f.actor,f.client,key,f.subscription,{ ...request,request,...evidence },f.at]);
        if (quantity===3) { await expect(applying).rejects.toMatchObject({ code: "55000",message: "customer_self_service_invalid_offer_membership" }); await db.query("ROLLBACK"); expect(await snapshot()).toEqual(before); }
        else { expect(await applying).toMatchObject({ status: "applied",templateVersion: 3 }); await db.query("COMMIT"); }
      } finally { await db.query("ROLLBACK"); db.release(); }
    }
    expect((await pool.query("SELECT quantity,unit_price_minor,catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ quantity: 1,unit_price_minor: "617",catalog_sku_revision_id: f.reference.skuRevisionId }]);
    expect((await pool.query("SELECT status,next_cycle_at=$2::timestamptz AS anchor FROM public.subscriptions WHERE id=$1", [f.subscription,f.anchor])).rows).toEqual([{ status: "active",anchor: true }]);
  }
});

it("CatalogAdmissionPort locks multiple contexts and preserves its service-only execution boundary", async () => {
  const a = await fixture(packs[0]), b = await fixture(packs[1]), port = createPostgresCatalogAdmission();
  const input: CatalogAdmissionInput = { ...a.admission,purpose: "order",heads: [...b.admission.heads,...a.admission.heads],
    skuRevisions: [...b.admission.skuRevisions,...a.admission.skuRevisions],
    priceContextVersions: [...b.admission.priceContextVersions,...a.admission.priceContextVersions] };
  const signature = "public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text)";
  expect((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed", [signature])).rows).toEqual([{ allowed: false }]);
  for (const role of ["anon","authenticated","service_role"] as const) {
    const db = await session();
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      if (role === "service_role") await port.assertCurrent(db,input);
      else await expect(port.assertCurrent(db,input)).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query("ROLLBACK"); db.release(); }
  }
});

type AdmissionRow = {
  name: string; message: string | null; code?: string; account?: boolean;
  standing?: { product?: Record<string, unknown>; sku?: Record<string, unknown> };
  before?(f: Fixture): Promise<void>;
  change(db: PoolClient, f: Fixture, input: CatalogAdmissionInput): void | Promise<void>;
};
const orderAnchor = "commerce_order_draft_catalog_anchor_missing", accountAnchor = "customer_self_service_invalid_catalog_anchor";
const orderRefused = "commerce_order_draft_offer_membership_refused", priceMoved = "catalog_admission_price_context_moved";
const headMoved = "commerce_order_draft_catalog_head_moved";
async function scopedFacts(db: PoolClient, f: Fixture, table: "catalog_products" | "catalog_skus", patch: Record<string, unknown>) {
  await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities SELECT pg_current_xact_id(),product_id,digest FROM public.catalog_publications WHERE id=$1 ON CONFLICT DO NOTHING", [f.head.publicationId]);
  await db.query(`UPDATE public.${table} SET publication_facts=publication_facts||$2::jsonb WHERE id=$1`, [table === "catalog_products" ? f.product : f.sku,patch]);
}
async function priceRow(db: PoolClient, input: CatalogAdmissionInput, assignment: string) {
  await db.query(`UPDATE public.price_entries SET ${assignment} WHERE id=$1`, [input.priceContextVersions[0].entryId]);
  Object.assign(input.priceContextVersions[0], { entry: (await db.query("SELECT to_jsonb(p) AS row FROM public.price_entries p WHERE id=$1", [input.priceContextVersions[0].entryId])).rows[0].row });
}
async function laterHead(db: PoolClient, f: Fixture, input: CatalogAdmissionInput) {
  const next = (await db.query(`INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id)
    SELECT gen_random_uuid(),product_id,revision+1,id,draft_id,draft_revision,'same-facts:'||gen_random_uuid()::text,candidate_digest,document_revision_id,canonical_state,digest,actor_id
    FROM public.catalog_publications WHERE id=$1 RETURNING id,revision`, [f.head.publicationId])).rows[0];
  await db.query("UPDATE public.catalog_publication_heads SET publication_id=$2,revision=$3 WHERE product_id=$1", [f.product,next.id,next.revision]);
  Object.assign(input.heads[0].head, { publicationId: next.id,revision: Number(next.revision) });
}
async function admissionCase(row: AdmissionRow) {
  const f = await fixture(packs[0],row.standing); await row.before?.(f); const db = await session();
  const input: CatalogAdmissionInput = { ...structuredClone(f.admission),heads: structuredClone(f.admission.heads),purpose: row.account ? "account" : "order",
    offerEvidence: { offerVersion: "classic",...(row.account ? { subscriptionId: f.subscription,lane: "classic" as const } : {}) } };
  let before: Record<string, unknown> | undefined;
  try {
    await db.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscription]);
    await row.change(db,f,input); before = await snapshot();
    const call = rpc(db,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),input.mode,
      JSON.stringify(input.offerEvidence),JSON.stringify(input.priceContextVersions),input.purpose]);
    if (row.message === null) expect(await call).toBe("");
    else await expect(call).rejects.toMatchObject({ message: row.message,code: row.code ?? "22023" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await snapshot()).toEqual(before);
}
const boundaryRows: AdmissionRow[] = [
  { name: "code-order-anchor",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ heads: [] }); } },
  { name: "code-order-refused",message: orderRefused,code: "55000",change: (_d,_f,i) => { i.offerEvidence.offerVersion = "unadmitted"; } },
  { name: "code-account-anchor",message: accountAnchor,account: true,change: (_d,_f,i) => { Object.assign(i,{ heads: [] }); } },
  { name: "code-boundary",message: "catalog_propagation_admission_boundary_invalid",change: (_d,_f,i) => { Object.assign(i,{ purpose: "renewal" }); } },
  { name: "heads-array",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ heads: null }); } },
  { name: "selections-array",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ skuRevisions: null }); } },
  { name: "heads-count",message: orderAnchor,change: (_d,f,i) => { Object.assign(i,{ heads: [...i.heads,...Array.from({ length: 100 },() => ({ productId: randomUUID(),head: f.head }))] }); } },
  { name: "mode-null",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ mode: null }); } },
  { name: "mode-enum",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ mode: "renewal" }); } },
  { name: "offer-object",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ offerEvidence: [] }); } },
  { name: "offer-required",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ offerEvidence: {} }); } },
  { name: "prices-array",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ priceContextVersions: null }); } },
  { name: "prices-cap",message: orderAnchor,change: async (_d,_f,i) => { const b = await fixture(packs[1]); Object.assign(i,{ priceContextVersions: [...i.priceContextVersions,...Array.from({ length: 100 },() => b.admission.priceContextVersions[0])] }); } },
  { name: "selection-object",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ skuRevisions: [1] }); } },
  { name: "selection-keys",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i.skuRevisions[0],{ extra: true }); } },
  { name: "reference-object",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i.skuRevisions[0],{ reference: [] }); } },
  { name: "quantity-number",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i.skuRevisions[0],{ quantity: "2" }); } },
  { name: "quantity-positive",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i.skuRevisions[0],{ quantity: 0 }); } },
  { name: "unique-skus",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ skuRevisions: [i.skuRevisions[0],i.skuRevisions[0]] }); } },
  { name: "unique-products",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ heads: [i.heads[0],i.heads[0]] }); } },
  { name: "sku-present",message: "catalog_retained_revision_unavailable",change: (_d,_f,i) => { Object.assign(i.skuRevisions[0].reference,{ skuId: randomUUID() }); } },
  { name: "product-present",message: null,change: () => {} },
  { name: "sku-v3",message: "catalog_propagation_head_unreadable",code: "55000",change: (d,f) => scopedFacts(d,f,"catalog_skus",{ schemaVersion: 2 }) },
  { name: "product-v3",message: "catalog_propagation_head_unreadable",code: "55000",standing: { product: { schemaVersion: 2 } },change: () => {} },
  { name: "head-present",message: headMoved,code: "40001",change: async (d,f) => { await d.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [f.product]); } },
  { name: "expected-present",message: headMoved,code: "40001",change: (_d,_f,i) => { Object.assign(i.heads[0],{ productId: randomUUID() }); } },
  { name: "head-keys",message: headMoved,code: "40001",change: (_d,_f,i) => { Object.assign(i.heads[0].head,{ extra: true }); } },
  { name: "head-id",message: headMoved,code: "40001",change: (_d,_f,i) => { Object.assign(i.heads[0].head,{ publicationId: randomUUID() }); } },
  { name: "head-revision",message: headMoved,code: "40001",change: (_d,_f,i) => { Object.assign(i.heads[0].head,{ revision: 99 }); } },
  { name: "head-digest",message: headMoved,code: "40001",change: (_d,_f,i) => { Object.assign(i.heads[0].head,{ documentDigest: "0".repeat(64) }); } },
  { name: "product-current",message: headMoved,code: "40001",change: (d,f) => scopedFacts(d,f,"catalog_products",{ extra: true }) },
  { name: "reference-head",message: orderRefused,code: "55000",change: laterHead },
  { name: "revision-current",message: null,change: () => {} },
  { name: "sku-lifecycle",message: orderRefused,code: "55000",standing: { sku: { lifecycleState: "withdrawn" } },change: () => {} },
  { name: "product-lifecycle",message: orderRefused,code: "55000",standing: { product: { lifecycleState: "withdrawn" } },change: () => {} },
  { name: "sku-active",message: orderRefused,code: "55000",change: async (d,f) => { await scopedFacts(d,f,"catalog_skus",{}); await d.query("UPDATE public.catalog_skus SET status='draft' WHERE id=$1", [f.sku]); } },
  { name: "product-active",message: orderRefused,code: "55000",change: async (d,f) => { await scopedFacts(d,f,"catalog_products",{}); await d.query("UPDATE public.catalog_products SET status='draft' WHERE id=$1", [f.product]); } },
  { name: "standalone",message: orderRefused,code: "55000",change: async (d,f,i) => { i.mode = "one_time"; await scopedFacts(d,f,"catalog_skus",{}); await d.query("UPDATE public.catalog_skus SET sellable_standalone=false WHERE id=$1", [f.sku]); } },
  { name: "subscription-sellable",message: orderRefused,code: "55000",change: async (d,f) => { await scopedFacts(d,f,"catalog_skus",{}); await d.query("UPDATE public.catalog_skus SET sellable_in_subscription=false WHERE id=$1", [f.sku]); } },
  { name: "offer-membership",message: orderRefused,code: "55000",change: (_d,_f,i) => { i.offerEvidence.offerVersion = "unadmitted"; } },
];
it.each(boundaryRows)("admission A1 $name", admissionCase);
it.each<AdmissionRow>([
  { name: "reference-reader",message: "catalog_accepted_reference_mismatch",change: (_d,_f,i) => { Object.assign(i.skuRevisions[0].reference,{ optionDigest: "0".repeat(64) }); } },
])("admission A7 $name", admissionCase);
const priceRows: AdmissionRow[] = [
  { name: "account-list",message: priceMoved,code: "40001",account: true,change: async (d,f,i) => {
    const list = randomUUID(),entry = randomUUID();
    await d.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Other','ZZ','XXX',clock_timestamp()-interval '1 day')", [list]);
    await d.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',617,clock_timestamp()-interval '1 day')", [entry,list,f.sku]);
    Object.assign(i.priceContextVersions[0],{ priceListId: list,entryId: entry,entry: (await d.query("SELECT to_jsonb(p) AS row FROM public.price_entries p WHERE id=$1", [entry])).rows[0].row });
  } },
  { name: "list-currency",message: priceMoved,code: "40001",account: true,change: async (d,_f,i) => { await d.query("UPDATE public.price_lists SET currency='YYY' WHERE id=$1", [i.priceContextVersions[0].priceListId]); } },
  { name: "list-active",message: priceMoved,code: "40001",change: async (d,_f,i) => { await d.query("UPDATE public.price_lists SET valid_from=clock_timestamp()+interval '1 day' WHERE id=$1", [i.priceContextVersions[0].priceListId]); } },
  { name: "entry-list",message: priceMoved,code: "40001",change: async (d,_f,i) => {
    const id = randomUUID(); await d.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Other','ZZ','XXX',clock_timestamp()-interval '1 day')", [id]); Object.assign(i.priceContextVersions[0],{ priceListId: id });
  } },
  { name: "entry-sku",message: priceMoved,code: "40001",change: async (d,_f,i) => {
    const b = await fixture(packs[1]),id = randomUUID();
    await d.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',617,clock_timestamp()-interval '1 day')", [id,i.priceContextVersions[0].priceListId,b.sku]);
    Object.assign(i.priceContextVersions[0],{ entryId: id,entry: (await d.query("SELECT to_jsonb(p) AS row FROM public.price_entries p WHERE id=$1", [id])).rows[0].row });
  } },
  { name: "entry-active",message: priceMoved,code: "40001",change: (d,_f,i) => priceRow(d,i,"active=false") },
  { name: "entry-exact",message: priceMoved,code: "40001",change: (_d,_f,i) => { Object.assign(i.priceContextVersions[0].entry,{ unit_price_minor: 618 }); } },
];
it.each(priceRows)("admission A8 $name", admissionCase);
it.each<AdmissionRow>([
  { name: "list-valid-from",message: priceMoved,code: "40001",change: async (d,_f,i) => { await d.query("UPDATE public.price_lists SET valid_from=clock_timestamp()+interval '1 day' WHERE id=$1", [i.priceContextVersions[0].priceListId]); } },
  { name: "list-valid-to",message: priceMoved,code: "40001",change: async (d,_f,i) => { await d.query("UPDATE public.price_lists SET valid_to=clock_timestamp()-interval '1 minute' WHERE id=$1", [i.priceContextVersions[0].priceListId]); } },
  { name: "entry-valid-from",message: priceMoved,code: "40001",change: (d,_f,i) => priceRow(d,i,"valid_from=clock_timestamp()+interval '1 day'") },
  { name: "entry-valid-to",message: priceMoved,code: "40001",change: (d,_f,i) => priceRow(d,i,"valid_to=clock_timestamp()-interval '1 minute'") },
  { name: "membership-version",message: orderRefused,code: "55000",change: (_d,_f,i) => { i.offerEvidence.offerVersion = "unadmitted"; } },
  { name: "membership-admitted",message: orderRefused,code: "55000",standing: { sku: { memberships: [{ offerVersion: "classic",admitted: false }] } },change: () => {} },
  { name: "current-sku-id",message: null,change: () => {} },
  { name: "current-revision-id",message: null,change: () => {} },
])("admission conjunct $name", admissionCase);

// Each row reaches one native refusal site; ledger enrichment remains aligned unless
// the row explicitly tests that binding. All mutations roll back on the same rail.
async function legacyFixture() {
  const f = await fixture(packs[0]), product = randomUUID(), sku = randomUUID(), code = `LEGACY-${sku}`;
  await pool.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,'Legacy article','active')", [product,`legacy-${product}`]);
  await pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_standalone,sellable_in_subscription,net_weight_g) VALUES($1,$2,$3,'Legacy article','active',true,true,100)", [sku,product,code]);
  await pool.query("UPDATE public.subscription_lines SET variant_id=$2,catalog_sku_revision_id=NULL WHERE subscription_id=$1", [f.subscription,sku]);
  await pool.query("UPDATE public.subscription_renewal_terms SET catalog_acceptance=NULL WHERE subscription_id=$1", [f.subscription]);
  await pool.query("UPDATE public.subscription_renewal_term_lines SET sku=$2 WHERE subscription_id=$1", [f.subscription,code]);
  await pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) SELECT price_list_id,$2,'any',617,clock_timestamp()-interval '1 day' FROM public.subscriptions WHERE id=$1", [f.subscription,sku]);
  return { ...f,product,sku,code };
}
type ProbePayload = Record<string, unknown> & { request: Record<string, unknown>; lines: Array<Record<string, unknown>> };
type NativeProbe = { db: PoolClient; f: Fixture; command: Awaited<ReturnType<typeof edit>>; p: ProbePayload; lane: Lane };
type NativeRow = { name: string; message: string; code?: string; change(probe: NativeProbe): void | Promise<void> };
async function ledger({ db,f,p,lane }: NativeProbe) {
  const action = String(p.request.action ?? 'update_package_template');
  await db.query("UPDATE public.subscription_quote_previews SET action=$2,request_payload=$3,quote_snapshot=quote_snapshot||$4::jsonb WHERE subscription_id=$1", [f.subscription,action,
    Object.fromEntries(Object.entries(p.request).filter(([key]) => !["expectedTemplateVersion","acceptedQuoteHash"].includes(key))),
    Object.fromEntries(Object.entries(p).filter(([key]) => (lane === "classic" ? ["baseLines","addonLines","compositionConstraint"] : ["lines","cadenceDays","compositionConstraint","portionModes","subjectFacts","optInFacts"]).includes(key)))]);
}
async function receipt(probe: NativeProbe, status = "previewed") {
  const { db,f,command,p,lane } = probe;
  const input = { clientId: f.client,subscriptionId: f.subscription,action: lane === "classic" ? "update_package_template" : p.request.action,payload: p.request };
  await db.query("INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status) VALUES($1,$2,$3,$4,encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex'),$5,$6,'{}',$7)", [f.actor,command.key,f.subscription,f.client,input,command.hash,status]);
}
async function nativeCase(lane: Lane, row: NativeRow) {
  const f = await legacyFixture(), command = await edit(f,lane), db = await session();
  const probe: NativeProbe = { db,f,command,lane,p: command.payload as ProbePayload };
  const before = await snapshot();
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [f.actor,JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    await row.change(probe);
    await expect(command.invoke(db)).rejects.toMatchObject({ message: row.message,code: row.code ?? "22023" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await snapshot()).toEqual(before);
}
const actorNull = ({ command }: NativeProbe) => { command.args[0] = null; };
const wrongClient = ({ command }: NativeProbe) => { command.args[1] = randomUUID(); };
const receiptOwner = async (probe: NativeProbe) => { await receipt(probe); wrongClient(probe); };
const paymentBlocked = async ({ db,f }: NativeProbe) => { await db.query("DELETE FROM public.subscription_method_states WHERE subscription_id=$1", [f.subscription]); };
const windowClosed = async ({ db,f }: NativeProbe) => { await db.query("UPDATE public.subscriptions SET next_cycle_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [f.subscription]); };
const noTerms = async ({ db,f }: NativeProbe) => { await db.query("DELETE FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscription]); };
const standardRows = (lane: "classic" | "exact" | "sized"): NativeRow[] => {
  const sized = lane === "sized", classic = lane === "classic";
  const row = (number: number,message: string,change: NativeRow["change"]): NativeRow => ({ name: `refusal-${String(number).padStart(2,"0")}`,message,change });
  return [row(1,"subscription_command_invalid_input",actorNull),
    ...(!classic ? [row(2,"subscription_command_unsupported_action",({ command,p }) => { if (sized) p.request.action = "unknown"; else command.args[4] = "unknown"; })] : []),
    row(classic ? 2 : 3,"subscription_command_forbidden",receiptOwner),
    row(classic ? 3 : 4,"subscription_command_idempotency_conflict",receipt),
    row(classic ? 8 : 5,"subscription_command_forbidden",wrongClient),
    row(classic ? 9 : sized ? 10 : 6,"subscription_edit_window_closed",windowClosed),
    row(classic ? 10 : sized ? 11 : 7,"subscription_command_payment_blocked",paymentBlocked),
    row(classic ? 11 : sized ? 12 : 8,"subscription_edit_quote_required",({ p }) => { (sized ? p.request : p).acceptedQuoteHash = ""; }),
    row(classic ? 12 : sized ? 13 : 9,"subscription_edit_stale_template",({ p }) => { (sized ? p.request : p).expectedTemplateVersion = null; }),
    row(classic ? 13 : sized ? 14 : 10,"subscription_edit_stale_template",({ p }) => { (sized ? p.request : p).expectedTemplateVersion = 2; }),
    row(classic ? 14 : sized ? 17 : 11,"subscription_command_renewal_terms_missing",noTerms)];
};
const classicRows: NativeRow[] = [...standardRows("classic"),
  { name: "refusal-04",message: "subscription_edit_invalid_lines",change: ({ p }) => { p.baseLines = []; } },
  { name: "refusal-05",message: "subscription_reprice_minimum_base_units_unavailable",change: async ({ db }) => { await db.query("UPDATE public.commerce_settings SET value_text='invalid' WHERE key='subscription_minimum_base_units'"); } },
  { name: "refusal-06",message: "subscription_reprice_minimum_base_units_unavailable",change: async ({ db }) => { await db.query("UPDATE public.commerce_settings SET value_text='2147483648' WHERE key='subscription_minimum_base_units'"); } },
  { name: "refusal-07",message: "subscription_edit_below_minimum_order_units",change: async ({ db }) => { await db.query("UPDATE public.commerce_settings SET value_text='3' WHERE key='subscription_minimum_base_units'"); } },
  { name: "refusal-15",message: "subscription_edit_invalid_request",change: async probe => { probe.p.planDays = 0; probe.p.request.planDays = 0; await ledger(probe); } },
  { name: "refusal-16",message: "subscription_edit_quote_drift",change: async ({ db,f }) => { await db.query("UPDATE public.subscription_quote_previews SET quote_snapshot=quote_snapshot-'compositionConstraint' WHERE subscription_id=$1", [f.subscription]); } },
];
it.each(classicRows)("native classic $name", row => nativeCase("classic",row));
async function exactAction(probe: NativeProbe, action: string, fields: Record<string, unknown>) {
  probe.command.args[4] = action;
  probe.p.request = { action,expectedTemplateVersion: 1,acceptedQuoteHash: probe.command.hash,...fields };
  await ledger(probe);
}
const exactRows: NativeRow[] = [...standardRows("exact"),
  { name: "refusal-12",message: "subscription_edit_invalid_lines",change: ({ p }) => { p.lines = []; } },
  { name: "refusal-15",message: "subscription_edit_conflict_duplicate_line",change: probe => exactAction(probe,"swap_base_line",{ fromVariantId: randomUUID(),toVariantId: probe.f.sku }) },
  { name: "refusal-16",message: "subscription_edit_not_found_line",change: probe => exactAction(probe,"swap_base_line",{ fromVariantId: randomUUID(),toVariantId: randomUUID() }) },
  { name: "refusal-17",message: "subscription_edit_not_found_addon",change: probe => exactAction(probe,"remove_addon",{ variantId: randomUUID() }) },
  { name: "refusal-18",message: "subscription_edit_invalid_addon_qty",change: probe => exactAction(probe,"update_addon_quantity",{ variantId: randomUUID(),qty: 0 }) },
  { name: "refusal-19",message: "subscription_edit_not_found_addon",change: probe => exactAction(probe,"update_addon_quantity",{ variantId: randomUUID(),qty: 2 }) },
  { name: "refusal-20",message: "subscription_edit_invalid_plan_length",change: probe => exactAction(probe,"update_plan_length",{ planDays: 0 }) },
  { name: "refusal-21",message: "subscription_edit_base_total_mismatch",change: probe => exactAction(probe,"update_base_mix",{}) },
  { name: "refusal-22",message: "subscription_edit_invalid_portion_mode",change: async probe => {
    probe.p.portionModes = { full: { mode: "full",factor: 1 },reduced: { mode: "reduced",factor: 0.5 } };
    probe.p.compositionConstraint = { mode: "other",portionFactor: 1 };
    await exactAction(probe,"update_portion",{ portionMode: "other" });
  } },
  { name: "refusal-23",message: "subscription_edit_quote_drift",change: async probe => { const addon = await addonFixture(probe.db,probe.f,1); probe.p.lines[0].lineId = randomUUID(); await exactAction(probe,"remove_addon",{ variantId: addon.variantId }); } },
];
it.each(exactRows)("native exact $name", row => nativeCase("exact",row));
async function introFixture(db: PoolClient, f: Fixture, paid: number, basis: number) {
  const order = randomUUID();
  await db.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'paid','XXX',617)", [order,f.client]);
  const quoteLine = { sku: f.code,quantity: 4,unitPriceGross: money(617),lineSubtotalGross: money(2468) };
  await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at) VALUES($1,$2,$3,$4)", [order,f.subscription,
    { templateId: "introductory",shippingAmountMinor: 0,renewalTerms: { version: "native.renewal-terms.v1",minimumPayableMinor: 1,normalCadenceDays: [28],starterPack: { schemaVersion: "1",starterIntervalDays: 28,basisTemplateVersion: basis,
      delivery2: { discountBps: 0,discountMinor: 0,basisSubtotalMinor: 617 },graduation: { cadenceDays: 28,sizeConstraint: { kind: "unit_count",value: 4,dailyNeed: 1 },lines: [{ sku: f.code,qty: 4,sortOrder: 0,isAddon: false,quoteLine }] } } } },f.at]);
  for (let index = 0; index < paid; index++) await db.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2::timestamptz-make_interval(days=>$3::integer),'paid')", [f.subscription,f.at,28 * (index + 1)]);
}
const sizedRows: NativeRow[] = [...standardRows("sized"),
  { name: "refusal-06",message: "subscription_edit_invalid_offer_binding",change: ({ p }) => { p.request.resizeLever = { kind: "subscription.sized.parcel",value: { optInToSized: false } }; } },
  { name: "refusal-07",message: "subscription_edit_invalid_sized_configuration",change: async ({ db,f }) => { await introFixture(db,f,2,1); await db.query("DELETE FROM public.commerce_settings WHERE key='subscription_sized_intro_phase'"); } },
  { name: "refusal-08",message: "subscription_edit_invalid_intro_fixed",change: async ({ db,f }) => {
    await introFixture(db,f,0,1); await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_sized_intro_phase','{\"fixedThroughCycle\":2,\"graduationCycle\":3}') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
  } },
  { name: "refusal-09",message: "subscription_edit_invalid_intro_fixed",change: async ({ db,f }) => {
    await introFixture(db,f,2,1); await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_sized_intro_phase','{\"fixedThroughCycle\":1,\"graduationCycle\":3}') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
  } },
  { name: "refusal-15",message: "subscription_edit_invalid_lines",change: ({ p }) => { p.lines = []; } },
  { name: "refusal-16",message: "subscription_edit_base_total_mismatch",change: async ({ db,command,p }) => { await command.invoke(db); command.args[2] = randomUUID(); p.request.action = "update_base_mix"; p.request.expectedTemplateVersion = 2; p.lines[0].qty = 3; } },
  { name: "refusal-20",message: "subscription_edit_invalid_sku_admission",change: async ({ db,f }) => { await db.query("UPDATE public.catalog_skus SET sellable_in_subscription=false WHERE id=$1", [f.sku]); } },
  { name: "refusal-21",message: "subscription_edit_quote_drift",change: async ({ db,f }) => { await addonFixture(db,f,1); } },
  { name: "refusal-22",message: "subscription_edit_quote_drift",change: async probe => {
    (probe.p.lines[0].quoteLine as Record<string, unknown>).lineSubtotalGross = money(1235); await ledger(probe);
  } },
  { name: "refusal-23",message: "subscription_edit_quote_drift",change: async probe => {
    const addon = { ...await addonFixture(probe.db,probe.f,2),lineId: randomUUID() };
    probe.p.lines.push(addon); await ledger(probe);
  } },
];
it.each(sizedRows)("native sized $name", row => nativeCase("sized",row));

async function addonFixture(db: PoolClient, f: Fixture, qty: number) {
  const variantId = randomUUID(), code = `ADDON-${variantId}`;
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_standalone,sellable_in_subscription,net_weight_g) VALUES($1,$2,$3,'Addon article','active',true,true,100)", [variantId,f.product,code]);
  const line = (await db.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code) VALUES($1,$2,$3,1,true,617,'XXX') RETURNING id", [f.subscription,variantId,qty])).rows[0];
  return { lineId: line.id,variantId,qty,isAddon: true,quoteLine: { sku: code,quantity: qty,unitPriceGross: money(617),lineSubtotalGross: money(617 * qty) } };
}

async function legacyEvent(probe: NativeProbe, raw: boolean, identity: "correct" | "wrong" | "absent", action = "update_bundle") {
  const { db,f,command } = probe;
  const key = raw ? command.key : (await db.query("SELECT idempotency_key FROM public.subscription_edit_quotes WHERE subscription_id=$1", [f.subscription])).rows[0].idempotency_key;
  const commandKeyIdentity = identity === "absent" ? undefined : { derivation: "principal-sha256.v1",actorId: identity === "correct" ? f.actor : randomUUID() };
  await db.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,$3,$4)", [f.subscription,`subscription.customer_self_service.${action}`,key,{ action,commandKeyIdentity }]);
}
const legacyRows: NativeRow[] = [
  { name: "refusal-01",message: "subscription_edit_invalid_idempotency_key",change: ({ command }) => { command.args[1] = "short"; } },
  { name: "refusal-02",message: "subscription_command_reserved_idempotency_key",change: ({ command }) => { command.args[1] = "command:reserved"; } },
  { name: "refusal-03",message: "subscription_edit_not_found",change: async ({ db }) => { await db.query("SELECT set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)"); } },
  { name: "refusal-04",message: "subscription_edit_not_found",change: async ({ db }) => { await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [randomUUID(),JSON.stringify({ sub: randomUUID() })]); } },
  { name: "refusal-05",message: "subscription_edit_forbidden",change: ({ command }) => { command.args[0] = randomUUID(); } },
  { name: "refusal-06",message: "subscription_command_ambiguous_idempotency_key",code: "23505",change: p => legacyEvent(p,false,"wrong") },
  { name: "refusal-07",message: "subscription_edit_idempotency_conflict",code: "23505",change: p => legacyEvent(p,false,"correct","pause") },
  { name: "refusal-08",message: "subscription_command_ambiguous_idempotency_key",code: "23505",change: p => legacyEvent(p,true,"correct") },
  { name: "refusal-09",message: "subscription_edit_idempotency_conflict",code: "23505",change: p => legacyEvent(p,true,"absent","pause") },
  { name: "refusal-10",message: "subscription_command_ambiguous_idempotency_key",code: "23505",change: async ({ db,f }) => { await db.query("UPDATE public.subscription_edit_quotes SET command_key_identity=$2 WHERE subscription_id=$1", [f.subscription,{ derivation: "principal-sha256.v1",actorId: randomUUID() }]); } },
  { name: "refusal-11",message: "subscription_edit_idempotency_conflict",code: "23505",change: p => legacyEvent(p,false,"correct") },
  { name: "refusal-12",message: "subscription_edit_quote_required",change: async ({ db,f }) => { await db.query("DELETE FROM public.subscription_edit_quotes WHERE subscription_id=$1", [f.subscription]); } },
  { name: "refusal-13",message: "subscription_edit_idempotency_conflict",code: "23505",change: ({ command,f }) => { command.args[3] = JSON.stringify([{ variantId: f.sku,qty: 3 }]); } },
  { name: "refusal-14",message: "subscription_edit_quote_expired",change: async ({ db,f }) => { await db.query("UPDATE public.subscription_edit_quotes SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE subscription_id=$1", [f.subscription]); } },
  { name: "refusal-15",message: "subscription_edit_stale_template",change: async ({ db,f }) => { await db.query("UPDATE public.subscriptions SET template_version=2 WHERE id=$1", [f.subscription]); } },
  { name: "refusal-16",message: "subscription_edit_window_closed",change: windowClosed },
];
it.each(legacyRows)("native legacy $name", row => nativeCase("legacy",row));

it.each<AdmissionRow>([
  { name: "subscription-required",message: accountAnchor,account: true,change: (_d,_f,i) => { i.offerEvidence.subscriptionId = randomUUID(); } },
  { name: "account-mode",message: accountAnchor,account: true,change: (_d,_f,i) => { i.mode = "one_time"; } },
  { name: "lane-enum",message: accountAnchor,account: true,change: (_d,_f,i) => { Object.assign(i.offerEvidence,{ lane: "unknown" }); } },
  { name: "lane-required",message: accountAnchor,account: true,change: (_d,_f,i) => { delete i.offerEvidence.lane; } },
  ...["sized-config-required","graduation-marker","retained-proof","graduation-cycle","graduation-template"].map(name => ({ name,account: true,
    message: name === "sized-config-required" ? "subscription_edit_invalid_sized_configuration" : name === "retained-proof" ? "catalog_retained_revision_unavailable" : name === "graduation-marker" ? null : "customer_self_service_invalid_offer_membership",
    code: name === "graduation-cycle" || name === "graduation-template" ? "55000" : "22023",
    async before(f: Fixture) { const first = await edit(f,"sized"), db = await pool.connect();
      try { expect(await first.invoke(db)).toMatchObject({ status: "applied" }); } finally { db.release(); } },
    async change(db: PoolClient,f: Fixture,i: CatalogAdmissionInput) {
      i.offerEvidence = { offerVersion: "sized.v1",subscriptionId: f.subscription,lane: "sized",optIn: false };
      await introFixture(db,f,name === "graduation-cycle" ? 1 : 2,name === "graduation-template" ? 1 : 2);
      await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_sized_intro_phase','{\"fixedThroughCycle\":2,\"graduationCycle\":3}') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
      if (name === "sized-config-required") await db.query("DELETE FROM public.commerce_settings WHERE key='subscription_sized_intro_phase'");
      i.skuRevisions[0].quantity = name === "retained-proof" ? 1 : 3;
      if (name === "retained-proof") await db.query("UPDATE public.subscription_renewal_terms SET catalog_acceptance=NULL WHERE subscription_id=$1", [f.subscription]);
      await scopedFacts(db,f,"catalog_skus",{ lifecycleState: "withdrawn" });
      if (name === "graduation-marker" || name === "retained-proof") i.priceContextVersions = [];
    } })),
])("admission A2 $name", admissionCase);

// Probe the specified lock while a real edit is paused before its effects. The
// second business session then settles a real payment behind that edit.
it.each(["lineage","head-row","product-row","sku-row","price-guard","price-list-row","price-entry-row"])("admission lock %s", async name => {
  const f = await fixture(packs[0]), command = await edit(f), paid = await payment(f);
  const h = await pool.connect(), e = await session(), p = await session(), stop = await gate(h);
  const ep = await pid(e), pp = await pid(p), hp = await pid(h);
  let restore = async () => {};
  try {
    const boundary = "v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;";
    restore = await hook(packageSignature,boundary,stop.sql);
    const editing = tracked(command.invoke(e)); await blocker(h,ep,hp);
    await p.query("SAVEPOINT lock_probe");
    try {
    if (name === "lineage" || name === "price-guard") {
      const key = name === "lineage" ? `catalog-lineage:${f.product}` : `catalog-price-setup:${f.admission.priceContextVersions[0].priceListId}:${f.sku}`;
      expect((await p.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [key])).rows[0].acquired).toBe(false);
    } else {
      const [table,column,id] = name === "head-row" ? ["catalog_publication_heads","product_id",f.product] : name === "product-row" ? ["catalog_products","id",f.product]
        : name === "sku-row" ? ["catalog_skus","id",f.sku] : name === "price-list-row" ? ["price_lists","id",f.admission.priceContextVersions[0].priceListId]
          : ["price_entries","id",f.admission.priceContextVersions[0].entryId];
      await expect(p.query(`SELECT 1 FROM public.${table} WHERE ${column}=$1 FOR NO KEY UPDATE NOWAIT`, [id])).rejects.toMatchObject({ code: "55P03" });
    }

    } finally { await p.query("ROLLBACK TO SAVEPOINT lock_probe"); }
    const paying = tracked(paid.invoke(p)); await blocker(h,pp,ep);
    await stop.release(); const result = await editing; if (!result.ok) throw result.error;
    await e.query("COMMIT"); const settled = await paying; if (!settled.ok) throw settled.error; await p.query("COMMIT");
    await assertAgreement(f,command,"classic",true);
  } finally { await stop.release(); await e.query("ROLLBACK"); await p.query("ROLLBACK"); await restore(); e.release(); p.release(); h.release(); }
});

it.each(["boundary-before-barrier","barrier-before-evidence"])("admission order %s", async name => {
  const f = await fixture(packs[0]), next = await changedDocument(f), h = await pool.connect(), w = await pool.connect(), e = await session(), stop = await gate(h);
  const ep = await pid(e), wp = await pid(w), hp = await pid(h); let finished = false, reached = false;
  const publishing = tracked(publishOn(w,next.publication,async (sql,values) => {
    if (!reached && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0]===`catalog-lineage:${f.product}`) {
      reached = true; await w.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await w.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]);
    }
  }));
  try {
    await blocker(h,wp,hp);
    const call = tracked(rpc(e,"catalog_admission_assert_current",[JSON.stringify([]),JSON.stringify(f.admission.skuRevisions),"subscription",{ offerVersion: "classic" },JSON.stringify(f.admission.priceContextVersions),name === "boundary-before-barrier" ? "invalid" : "order"]).finally(() => { finished = true; }));
    await expect.poll(async () => finished || (await h.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [ep,wp])).rows[0].blocked).toBe(true);
    expect(finished).toBe(name === "boundary-before-barrier");
    await stop.release(); const written = await publishing; if (!written.ok) throw written.error; expect(written.value.outcome).toBe("committed");
    const before = await snapshot(), result = await call; expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: "22023",message: name === "boundary-before-barrier" ? "catalog_propagation_admission_boundary_invalid" : orderAnchor });
    await e.query("ROLLBACK"); expect(await snapshot()).toEqual(before);
  } finally { await stop.release(); await publishing; await e.query("ROLLBACK"); await w.query("ROLLBACK"); h.release(); w.release(); e.release(); }
});

it.each(lanes)("admission lineage %s", async lane => {
  const f = await fixture(packs[0]), next = await changedDocument(f);
  // The legacy quote fingerprints its complete constraint, including absence.
  if (lane === "legacy") Object.assign(f,{ admission: undefined });
  const command = await edit(f,lane), h = await pool.connect(), w = await pool.connect(), e = await session(), stop = await gate(h);
  const ep = await pid(e), wp = await pid(w), hp = await pid(h); let finished = false, reached = false;
  if (lane !== "legacy") await pool.query("UPDATE public.subscription_quote_previews SET quote_snapshot=quote_snapshot-'catalogAdmission' WHERE subscription_id=$1", [f.subscription]);
  const publishing = tracked(publishOn(w,next.publication,async (sql,values) => {
    if (!reached && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0]===`catalog-lineage:${f.product}`) {
      reached = true; await w.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await w.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]);
    }
  }));
  try {
    await blocker(h,wp,hp);
    await e.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    const call = tracked(command.invoke(e).finally(() => { finished = true; }));
    await expect.poll(async () => finished || (await h.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [ep,wp])).rows[0].blocked).toBe(true);
    expect(finished,"missing lineage refuses before any catalogue guard").toBe(true);
    await stop.release(); const written = await publishing; if (!written.ok) throw written.error; expect(written.value.outcome).toBe("committed");
    const before = await snapshot(), result = await call; expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: "22023",message: accountAnchor });
    await e.query("ROLLBACK"); expect(await snapshot()).toEqual(before);
  } finally { await stop.release(); await publishing; await e.query("ROLLBACK"); await w.query("ROLLBACK"); h.release(); w.release(); e.release(); }
});

function purchaseInput(f: Fixture) {
  const context: Record<string, unknown> = { mode: "subscription",offerVersion: "classic" };
  const lines = [{ sku: f.code,quantity: 2,unitPriceGross: money(617),lineSubtotalGross: money(1234) }];
  const quote = { quote: { context,lines,totalGross: money(1234) },catalogAdmission: { ...structuredClone(f.admission),purpose: "order" } };
  const draft = { contractVersion: "commerce.v0",source: "commerce.order_draft.bff.v0",status: "draft",paymentStatus: "not_started",currency: "XXX",context,lines,
    discounts: [] as Array<{ promotionId?: string; appliesTo: string; amountOffMinor: number }>,
    totals: { subtotalGross: money(1234),totalGross: money(1234),discountTotalGross: money(0),shippingGross: money(0),shippingDiscountGross: money(0) } };
  return { quote,draft,args: [randomUUID(),quote,draft,f.client] as unknown[] };
}
type PurchaseProbe = ReturnType<typeof purchaseInput> & { db: PoolClient; f: Fixture; routine: string };
type PurchaseRow = { name: string; message: string; code?: string; native?: boolean; change(p: PurchaseProbe): void | Promise<void> };
async function purchaseCase(promoted: boolean,row: PurchaseRow) {
  const f = await (row.native ? fixture(packs[0]) : legacyFixture()), db = await session();
  const routine = promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox";
  const p: PurchaseProbe = { ...purchaseInput(f),db,f,routine }, before = await snapshot();
  if (!row.native) delete (p.quote as Partial<typeof p.quote>).catalogAdmission;
  try { await row.change(p); await expect(rpc(db,routine,p.args)).rejects.toMatchObject({ message: row.message,code: row.code ?? "22023" }); }
  finally { await db.query("ROLLBACK"); db.release(); }
  expect(await snapshot()).toEqual(before);
}
async function promotion(p: PurchaseProbe, options: { active?: boolean; global?: number; customer?: number } = {}) {
  const id = randomUUID();
  await p.db.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,$3)", [id,
    { id,status: "active",redemption_limit_global: options.global ?? null,redemption_limit_per_customer: options.customer ?? null },options.active ?? true]);
  p.draft.discounts = [{ promotionId: id,appliesTo: "order_total",amountOffMinor: 100 }];
  p.draft.totals.discountTotalGross = money(100); p.draft.totals.totalGross = money(1134);
  return id;
}
async function existingClaim(p: PurchaseProbe,id: string) {
  const order = randomUUID();
  await p.db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',1134)", [order,p.f.client]);
  const adjustment = (await p.db.query("INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint) SELECT $1,'promotion_discount','order_total',100,promotion_id,definition_fingerprint FROM public.commerce_promotion_definitions WHERE promotion_id=$2 RETURNING id", [order,id])).rows[0].id;
  await p.db.query("INSERT INTO public.commerce_promotion_claims(promotion_id,definition_fingerprint,adjustment_id,order_id,client_id,amount_off_minor,expires_at) SELECT promotion_id,definition_fingerprint,$1,$2,$3,100,clock_timestamp()+interval '1 day' FROM public.commerce_promotion_definitions WHERE promotion_id=$4", [adjustment,order,p.f.client,id]);
}
const purchaseBinding = (p: PurchaseProbe) => { p.quote.catalogAdmission.skuRevisions[0].quantity = 3; };
const plainRows: PurchaseRow[] = [
  { name: "binding",message: orderRefused,native: true,change: purchaseBinding },
  { name: "refusal-01",message: "commerce_order_draft_invalid_idempotency_key",change: p => { p.args[0] = "short"; } },
  { name: "refusal-02",message: "commerce_order_draft_invalid_snapshot",change: p => { p.draft.contractVersion = "invalid"; } },
  { name: "refusal-03",message: "commerce_order_draft_unknown_client",change: p => { p.args[3] = randomUUID(); } },
  { name: "refusal-04",message: "commerce_order_draft_invalid_mode",change: p => { p.draft.context.mode = "invalid"; } },
  { name: "refusal-05",message: "commerce_order_draft_idempotency_conflict",code: "23505",change: async p => { await rpc(p.db,p.routine,p.args); Object.assign(p.quote,{ different: true }); } },
  { name: "refusal-07",message: orderRefused,native: true,change: purchaseBinding },
  { name: "refusal-08",message: "commerce_order_draft_invalid_line",change: p => { p.draft.lines[0].lineSubtotalGross = money(1235); } },
  { name: "refusal-10",message: priceMoved,code: "40001",native: true,change: async p => {
    await p.db.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'subscription',617,clock_timestamp()-interval '1 day')", [p.f.admission.priceContextVersions[0].priceListId,p.f.sku]);
  } },
];
it.each(plainRows)("native plain $name", row => purchaseCase(false,row));
const promotedRows: PurchaseRow[] = [
  { name: "refusal-01",message: "commerce_order_draft_invalid_idempotency_key",change: p => { p.args[0] = "short"; } },
  { name: "refusal-02",message: "commerce_order_draft_expired",code: "40001",change: async p => {
    await rpc(p.db,p.routine,p.args); await p.db.query("UPDATE public.commerce_order_draft_receipts SET invalidated_at=clock_timestamp() WHERE idempotency_key=$1", [p.args[0]]);
  } },
  { name: "refusal-03",message: "commerce_order_draft_money_components_mismatch",change: p => { p.draft.totals.subtotalGross = money(1235); } },
  { name: "refusal-04",message: "commerce_promotion_line_allocation_unsupported",change: p => { p.draft.discounts = [{ appliesTo: "line",amountOffMinor: 0 }]; } },
  { name: "refusal-05",message: "commerce_order_draft_money_components_mismatch",change: p => { p.draft.context.shippingTerms = {}; } },
  { name: "refusal-06",message: "commerce_order_draft_money_components_mismatch",change: p => { p.draft.context.shippingTerms = { version: "shipping-threshold.v1",currency: "XXX",flatMinor: 100,freeThresholdMinor: 2000 }; } },
  { name: "refusal-07",message: "commerce_order_draft_money_equation_mismatch",change: p => { p.draft.totals.totalGross = money(1235); } },
  { name: "refusal-08",message: "commerce_zero_payable_order_unsupported",change: p => { p.draft.lines[0].unitPriceGross = money(0); p.draft.lines[0].lineSubtotalGross = money(0); p.draft.totals.subtotalGross = money(0); p.draft.totals.totalGross = money(0); } },
  { name: "refusal-10",message: orderRefused,native: true,change: purchaseBinding },
  { name: "refusal-11",message: "commerce_promotion_definition_not_active",code: "40001",change: async p => { await promotion(p,{ active: false }); } },
  { name: "refusal-12",message: "commerce_promotion_global_limit_reached",code: "40001",change: async p => { await existingClaim(p,await promotion(p,{ global: 1 })); } },
  { name: "refusal-13",message: "commerce_promotion_client_required",change: async p => { await promotion(p,{ customer: 1 }); p.args[3] = null; } },
  { name: "refusal-14",message: "commerce_promotion_customer_limit_reached",code: "40001",change: async p => { await existingClaim(p,await promotion(p,{ customer: 1 })); } },
];
it.each(promotedRows)("native promoted $name", row => purchaseCase(true,row));

it.each([false,true])("admission legacy purchase %s", async promoted => {
  const f = await legacyFixture(), db = await session(), p = purchaseInput(f);
  delete (p.quote as Partial<typeof p.quote>).catalogAdmission;
  try {
    const result = await rpc(db,promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox",p.args);
    expect(result).toEqual({ contractVersion: "commerce.v0",orderDraft: { orderId: result.orderDraft.orderId,status: "draft",paymentStatus: "not_started",idempotencyKey: p.args[0],quoteSnapshot: p.quote,replayed: false } });
    expect((await db.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [result.orderDraft.orderId.replace('order_','')])).rows).toEqual([{ catalog_acceptance: null }]);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

const routeRows = lanes.flatMap(lane => ["sku","product","retained"].map(route => ({ lane,route,name: `${lane}-${route}` })));
it.each(routeRows)("admission route $name", async ({ lane,route }) => {
  const old = route === "retained" ? await fixture(packs[0]) : await legacyFixture();
  const target = route === "retained" ? await legacyFixture() : await fixture(packs[1]);
  const setup = await session();
  try {
    const native = route === "retained" ? old : target;
    if (route !== "sku") await scopedFacts(setup,native,"catalog_skus",{ schemaVersion: 2 });
    if (route !== "product") await scopedFacts(setup,native,"catalog_products",{ schemaVersion: 2 });
    await setup.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) SELECT price_list_id,$2,'any',617,clock_timestamp()-interval '1 day' FROM public.subscriptions WHERE id=$1", [old.subscription,target.sku]);
    await setup.query("COMMIT");
  } finally { await setup.query("ROLLBACK"); setup.release(); }
  const f = { ...old,sku: target.sku,code: target.code,admission: target.admission };
  if (lane === "legacy") Object.assign(f,{ admission: undefined });
  const command = await edit(f,lane);
  if (lane !== "legacy") await pool.query("UPDATE public.subscription_quote_previews SET quote_snapshot=quote_snapshot-'catalogAdmission' WHERE subscription_id=$1", [f.subscription]);
  const before = await snapshot(), db = await session();
  try {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    await expect(command.invoke(db)).rejects.toMatchObject({ message: accountAnchor,code: "22023" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await snapshot()).toEqual(before);
});
it.each(["plain-sku","plain-product","promoted-sku","promoted-product"])("admission route %s", async name => {
  const f = await fixture(packs[0]), setup = await session();
  try { await scopedFacts(setup,f,name.endsWith("sku") ? "catalog_products" : "catalog_skus",{ schemaVersion: 2 }); await setup.query("COMMIT"); }
  finally { await setup.query("ROLLBACK"); setup.release(); }
  const p = purchaseInput(f), db = await session(), before = await snapshot();
  delete (p.quote as Partial<typeof p.quote>).catalogAdmission;
  // The promoted wrapper owns this refusal before the inner plain mode guard.
  if (name.startsWith("promoted")) p.draft.context.mode = "invalid";
  try { await expect(rpc(db,name.startsWith("plain") ? "commerce_create_order_draft_with_outbox" : "commerce_create_promoted_order_draft_with_outbox",p.args))
    .rejects.toMatchObject({ message: orderAnchor,code: "22023" }); }
  finally { await db.query("ROLLBACK"); db.release(); }
  expect(await snapshot()).toEqual(before);
});
it.each(lanes)("admission binding %s", async lane => {
  const f = await fixture(packs[0]); f.admission.skuRevisions[0].quantity = 3;
  const command = await edit(f,lane), db = await session(), before = await snapshot();
  try {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    await expect(command.invoke(db)).rejects.toMatchObject({ message: "customer_self_service_invalid_offer_membership",code: "22023" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await snapshot()).toEqual(before);
});
it.each(lanes.flatMap(lane => (lane === "legacy" ? ["subscription_events"] : ["subscription_renewal_terms","subscription_events"]).map(table => ({ lane,table }))))("admission accept $lane $table", async ({ lane,table }) => {
  const f = await fixture(packs[0]), next = await changedDocument(f), w = await pool.connect();
  try {
    const result = await publishOn(w,next.publication); expect(result.outcome).toBe("committed");
    if (!("receipt" in result)) throw new Error(JSON.stringify(result));
    const publication = (await w.query("SELECT canonical_state FROM public.catalog_publications WHERE id=$1", [result.receipt.head.publicationId])).rows[0];
    const sku = JSON.parse(publication.canonical_state).skus.find((s: { skuId: string }) => s.skuId === f.sku);
    f.head = result.receipt.head; f.reference = { ...f.reference,publicationHead: f.head,skuRevisionId: sku.revisionId };
    f.admission = { ...f.admission,heads: [{ productId: f.product,head: f.head }],skuRevisions: [{ reference: f.reference,quantity: 2 }] };
  } finally { w.release(); }
  const command = await edit(f,lane), db = await session();
  try {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    const result = await command.invoke(db);
    expect(lane === "legacy" ? result.subscriptionAction.status : result.status).toBe("applied");
    expect((await db.query(`SELECT catalog_acceptance FROM public.${table} WHERE subscription_id=$1${table === "subscription_events" ? " AND event_type LIKE 'subscription.customer_self_service.%'" : ""}`, [f.subscription])).rows)
      .toEqual([{ catalog_acceptance: { schemaVersion: 2,lines: [f.reference] } }]);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it.each(["package","sized"] as const)("LC6-host-prelock-%s", async lane => {
  const f = await legacyFixture(), h = await pool.connect(), e = await pool.connect(), p = await session();
  const ep = await pid(e), pp = await pid(p), hp = await pid(h), stop = await gate(h);
  let armed = false;
  const pause = async () => { if (armed) { await e.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await e.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]); } };
  const withTransaction = async <T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) => {
    await e.query("BEGIN"); try { const result = await work(e); await e.query("COMMIT"); return result; }
    catch (error) { await e.query("ROLLBACK"); throw error; }
  };
  const catalog = { async listQuoteCatalogItems() {
    if (lane === "package") await pause();
    return (await e.query("SELECT s.*,p.slug FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id WHERE s.id=$1", [f.sku])).rows.map(row => ({
      variantId: String(row.id),skuId: String(row.id),skuCode: String(row.sku),productSlug: String(row.slug),netWeightG: Number(row.net_weight_g),isAddon: row.is_addon === true,
      sellability: { oneTime: row.sellable_standalone === true,subscription: row.sellable_in_subscription === true },documentRevision: { id: null,digest: null } }));
  } };
  const tax = { included: true,country: "ZZ",category: "standard",vatRateBps: 0,legalBasis: "synthetic" } as const;
  const engine = createDbBackedCommerceQuotePort({ quoteCatalogReadPort: catalog,isStrictD1Quote: false,
    pricingResolverPort: { async resolvePrice(input) {
      const row = (await e.query("SELECT p.* FROM public.price_entries p JOIN public.subscriptions s ON s.price_list_id=p.price_list_id WHERE s.id=$1 AND p.variant_id=$2 AND p.active", [f.subscription,input.variantId])).rows[0];
      return { variantId: input.variantId,mode: input.mode,unitPriceMinor: Number(row.unit_price_minor),matchedMinQty: Number(row.min_qty),amountKind: "gross",priceListId: String(row.price_list_id),priceEntryId: String(row.id),resolvedAt: f.at };
    } },taxProfile: tax,supportedTaxProfiles: [tax],regionCode: "ZZ",currency: "XXX",now: () => f.at,hasPromotionCodePort: false,
    resolveAutomaticQuotePromotions: async () => ({ discounts: [],codeRejections: [] }),applyPromotionCodesV2: async () => ({ discounts: [],codeRejections: [],codeRejectionDetails: [] }),
    lineContext: () => ({}),quoteContext: input => () => ({ mode: input.mode,cadenceDays: input.cadenceDays,promoCodes: input.promoCodes }) });
  try {
    await pool.query("UPDATE public.subscriptions SET composition_constraint=$2 WHERE id=$1", [f.subscription,{ kind: "unit_count",value: 1,dailyNeed: 1,exclusions: [] }]);
    await pool.query("UPDATE public.catalog_skus SET publication_facts=$2 WHERE id=$1", [f.sku,{ schemaVersion: 2,physicalSize: 100,demandPerUnit: 28,documentRevisionId: f.sku,documentDigest: digest(f.sku),verified: true,exclusions: [],sellableNow: 100 }]);
    const initial = await engine.createServerAuthoritativeQuote({ mode: "subscription",cadenceDays: 28,promoCodes: [],lines: [{ sku: f.code,quantity: 1,modeAtLine: "subscription",isAddon: false }] });
    await pool.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at) VALUES($1,'subscription.starter_graduated',$2,$3,$4)", [f.subscription,randomUUID(),{ linePricing: [{ sku: f.code,quantity: 1,unitAmountMinor: 617,isAddon: false,quoteLine: initial.quote.lines[0] }] },f.at]);
    const actor = { actorId: f.actor,clientId: f.client };
    let preview: { quoteHash?: string }, invoke: () => Promise<{ status: string }>;
    if (lane === "package") {
      const editor = createPostgresPackageEditor({ quotePort: engine,quoteCatalogReadPort: catalog,now: () => f.at,withTransaction,
        limits: { maximumPlanDays: 90,maximumBaseLines: 3,maximumAddonLines: 3,maximumQuantity: 99 },
        constraintMapper: { toCore: stored => ({ kind: "configured",version: 1,data: stored ?? {} }),fromCore: value => value.data,nominalPlanDays: () => null },
        compositionRulesPort: { validateComposition: async () => ({ ok: true }),resizeComposition: async () => null } });
      const request = { subscriptionId: f.subscription,planDays: 28,base: [{ variantId: f.sku,qty: 2 }],addons: [] };
      preview = await editor.preview(actor,request);
      invoke = () => editor.apply(actor,randomUUID(),{ ...request,expectedTemplateVersion: 1,acceptedQuoteHash: preview.quoteHash });
    } else {
      const ports: SizedEditorOptions = { quotePort: engine,now: () => f.at,withTransaction,
        policy: { minimumCoreUnits: 1,maximumCoreLines: 3,maximumAddonLines: 3,maximumQuantity: 99,allowedCadences: [28,30],maximumExclusions: 8,maximumCatalogExclusions: 16,fixedThroughCycle: 2,graduationCycle: 3,
          portionModes: { full: { mode: "full",factor: 1 },reduced: { mode: "reduced",factor: 0.5 } } },
        async readFacts(db,context,point) {
          if (point === "apply") await pause();
          const row = (await db.query("SELECT composition_constraint FROM public.subscriptions WHERE id=$1 AND client_id=$2", [context.subscriptionId,context.clientId])).rows[0];
          const facts = row.composition_constraint as Record<string, unknown>;
          return { subscriptionId: context.subscriptionId,clientId: context.clientId,subjectRef: context.subscriptionId,exclusions: facts.exclusions as string[],snapshot: facts };
        },
        async resolveOptInNeed(db,context) {
          const row = (await db.query("SELECT composition_constraint FROM public.subscriptions WHERE id=$1", [context.subscriptionId])).rows[0];
          const facts = row.composition_constraint as Record<string, unknown>;
          return { dailyNeed: Number(facts.dailyNeed),snapshot: facts };
        },
        async readCatalog(db) {
          return (await db.query("SELECT * FROM public.catalog_skus WHERE id=$1", [f.sku])).rows.map(row => ({ variantId: String(row.id),sku: String(row.sku),groupId: String(row.product_id),isAddon: row.is_addon === true,
            sellable: row.status === "active" && row.sellable_in_subscription === true,...row.publication_facts as { physicalSize: number; demandPerUnit: number; documentRevisionId: string; documentDigest: string; verified: boolean; exclusions: string[]; sellableNow: number } }));
        },
        async assertCurrentFacts(db,context,expected,need,catalogFacts) {
          const row = (await db.query("SELECT composition_constraint FROM public.subscriptions WHERE id=$1 AND client_id=$2 FOR UPDATE", [context.subscriptionId,context.clientId])).rows[0];
          expect(row.composition_constraint).toEqual(expected.snapshot); expect(row.composition_constraint).toEqual(need);
          expect(await ports.readCatalog(db,context)).toEqual(catalogFacts);
        },
        proposePortion: async ({ current,factor }) => current.map(line => ({ variantId: line.variantId,qty: Math.max(1,Math.floor(line.qty * factor)) })),
      };
      const editor = createPostgresSizedEditor(ports), request = { subscriptionId: f.subscription,action: "resize_bundle" as const,cadenceDays: 28,compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 },
        resizeLever: { kind: "subscription.sized.parcel" as const,value: { coreLines: [{ variantId: f.sku,qty: 2 }],optInToSized: true as const } } };
      preview = await editor.preview(actor,request);
      invoke = () => editor.apply(actor,randomUUID(),{ ...request,expectedTemplateVersion: 1,acceptedQuoteHash: preview.quoteHash });
    }
    expect(preview.quoteHash).toMatch(/^[a-f0-9]{64}$/u);
    const paid = await payment(f,lane === "sized"); armed = true;
    const editing = tracked(invoke()); await blocker(h,ep,hp);
    await p.query("SAVEPOINT host_prelock");
    const held = await tracked(p.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR SHARE NOWAIT", [f.subscription]));
    await p.query("ROLLBACK TO SAVEPOINT host_prelock");
    expect(held.ok,"host subscription prelock").toBe(false); if (!held.ok) expect(held.error).toMatchObject({ code: "55P03" });
    const paying = tracked(paid.invoke(p)); await blocker(h,pp,ep);
    await stop.release(); const result = await editing; if (!result.ok) throw result.error; expect(result.value.status).toBe("applied");
    const settled = await paying; if (!settled.ok) throw settled.error; await p.query("COMMIT");
    expect((await pool.query("SELECT quantity,unit_price_minor FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ quantity: 2,unit_price_minor: "617" }]);
    expect((await pool.query("SELECT status FROM public.commerce_orders WHERE id=$1", [paid.order])).rows).toEqual([{ status: "paid" }]);
  } finally { await stop.release(); await e.query("ROLLBACK"); await p.query("ROLLBACK"); e.release(); p.release(); h.release(); }
});

it.each(["legacy","exact","sized"] as const)("admission commerce-first %s", async lane => {
  const f = await fixture(packs[0]), command = await edit(f,lane), paid = await payment(f);
  const h = await pool.connect(), e = await session(), p = await session(), stop = await gate(h), ep = await pid(e), pp = await pid(p), hp = await pid(h);
  let restore = async () => {};
  try {
    await e.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    restore = await hook("public.payment_provider_lock_aggregate(uuid)","PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE;",stop.sql);
    const paying = tracked(paid.invoke(p)); await blocker(h,pp,hp);
    const editing = tracked(command.invoke(e)); await blocker(h,ep,pp); await assertNoCatalogGuard(h,ep);
    await stop.release(); const settled = await paying; if (!settled.ok) throw settled.error; await p.query("COMMIT");
    const edited = await editing; if (!edited.ok) throw edited.error; await e.query("COMMIT"); await assertAgreement(f,command,lane,true);
  } finally { await stop.release(); await e.query("ROLLBACK"); await p.query("ROLLBACK"); await restore(); e.release(); p.release(); h.release(); }
});
it("admission promoted assertion", () => purchaseCase(true,{ name: "promoted-assertion",native: true,message: orderAnchor,change: p => {
  p.draft.context.mode = "invalid";
} }));
it("admission promoted promotion-head prelock", async () => {
  const f = await fixture(packs[0]), e = await session(), p = await session(), h = await pool.connect(), stop = await gate(h);
  const ep = await pid(e), pp = await pid(p), hp = await pid(h);
  const input: PurchaseProbe = { ...purchaseInput(f),f,db: e,routine: "commerce_create_promoted_order_draft_with_outbox" };
  const id = await promotion(input); await e.query("COMMIT"); await e.query("BEGIN");
  const second = purchaseInput(f); second.draft.discounts = structuredClone(input.draft.discounts); second.draft.totals = structuredClone(input.draft.totals);
  let restore = async () => {};
  try {
    restore = await hook(admissionSignature,sharedBoundary,stop.sql);
    const buying = tracked(rpc(e,input.routine,input.args)); await blocker(h,ep,hp);
    await p.query("SAVEPOINT promotion_probe");
    const held = await tracked(p.query("SELECT promotion_id FROM public.commerce_promotion_definitions WHERE promotion_id=$1 FOR SHARE NOWAIT", [id]));
    await p.query("ROLLBACK TO SAVEPOINT promotion_probe");
    expect(held.ok,"promotion head prelock").toBe(false); if (!held.ok) expect(held.error).toMatchObject({ code: "55P03" });
    const contending = tracked(rpc(p,input.routine,second.args)); await blocker(h,pp,ep);
    await stop.release(); const first = await buying; if (!first.ok) throw first.error; await e.query("COMMIT");
    const other = await contending; if (!other.ok) throw other.error; await p.query("COMMIT");
    expect((await pool.query("SELECT status,amount_off_minor FROM public.commerce_promotion_claims WHERE promotion_id=$1 ORDER BY id", [id])).rows)
      .toEqual([{ status: "reserved",amount_off_minor: "100" },{ status: "reserved",amount_off_minor: "100" }]);
  } finally { await stop.release(); await e.query("ROLLBACK"); await p.query("ROLLBACK"); await restore(); e.release(); p.release(); h.release(); }
});

it("admission binding promoted", async () => {
  const f = await fixture(packs[0]), next = await changedDocument(f), p = purchaseInput(f), h = await pool.connect(), w = await pool.connect(), e = await session(), stop = await gate(h);
  const ep = await pid(e), wp = await pid(w), hp = await pid(h); let finished = false, reached = false;
  p.quote.catalogAdmission.skuRevisions[0].quantity = 3;
  const publishing = tracked(publishOn(w,next.publication,async (sql,values) => {
    if (!reached && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0]===`catalog-lineage:${f.product}`) {
      reached = true; await w.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await w.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]);
    }
  }));
  try {
    await blocker(h,wp,hp);
    const call = tracked(rpc(e,"commerce_create_promoted_order_draft_with_outbox",p.args).finally(() => { finished = true; }));
    await expect.poll(async () => finished || (await h.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [ep,wp])).rows[0].blocked).toBe(true);
    expect(finished,"promoted selection binding refuses before catalogue acquisition").toBe(true);
    await stop.release(); const written = await publishing; if (!written.ok) throw written.error; expect(written.value.outcome).toBe("committed");
    const before = await snapshot(), result = await call; expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ message: orderRefused,code: "22023" });
    await e.query("ROLLBACK"); expect(await snapshot()).toEqual(before);
  } finally { await stop.release(); await publishing; await e.query("ROLLBACK"); await w.query("ROLLBACK"); h.release(); w.release(); e.release(); }
});

it.each(["order", "classic", "exact", "sized", "legacy"] as const)(
  "catalog_bound_effect_rechecks_shared_authority MC5-D-026 %s", async purpose => {
    const f = await fixture("serving"), read = await pool.connect();
    try {
      const offerVersion = purpose === "sized" ? "sized.v1" : "classic";
      const authority = publisher(read).serving({ types: [definition], offerVersion, maxItems: 5000 });
      const { items } = await authority.detail(f.value.product.slug!);
      const item = items.find(item => item.sku.id === f.sku);
      expect(item).toMatchObject({ product: { id: f.product }, acceptedReference: f.reference });
      const input = buildCatalogAdmissionFromServing({
        mode: f.admission.mode, priceContextVersions: f.admission.priceContextVersions,
        lines: [{ item: { productId: item!.product.id, acceptedReference: item!.acceptedReference }, quantity: 2 }],
        purpose: purpose === "order" ? "order" : "account",
        offerEvidence: purpose === "order" ? { offerVersion } : { offerVersion, subscriptionId: f.subscription, lane: purpose, ...(purpose === "sized" ? { optIn: true } : {}) },
      });
      await expect(createPostgresCatalogAdmission().assertCurrent(read, input)).resolves.toBeUndefined();
      const before = (await pool.query("SELECT next_cycle_at, cadence_days FROM public.subscriptions WHERE id=$1", [f.subscription])).rows;
      const stale = { ...input, heads: [{ productId: f.product, head: { ...f.head, revision: 1 } }] };
      await expect(createPostgresCatalogAdmission().assertCurrent(read, stale)).rejects.toMatchObject({
        code: "40001", message: purpose === "order" ? "commerce_order_draft_catalog_head_moved" : "customer_self_service_stale_edit_catalog_head",
      });
      expect((await pool.query("SELECT next_cycle_at, cadence_days FROM public.subscriptions WHERE id=$1", [f.subscription])).rows).toEqual(before);
    } finally { read.release(); }
  },
);

it.each((["classic","exact","legacy","sized opt-in","sized bundle"] as const).flatMap(lane =>
  (["valid","absent","wrong quantity","price moved","publisher first","edit before publish","payment first","edit before payment"] as const).map(change => ({ lane,change }))))(
  "LC9-D-039/S-018/S-031 actual $lane edit handles $change", async ({ lane,change }) => {
    const f = await fixture(packs[0]), context = await pool.connect(), publisher = await pool.connect(), observer = await pool.connect();
    const actor = { actorId: f.actor,clientId: f.client }, key = randomUUID();
    const wanted = lane === "exact" ? 1 : lane === "sized bundle" ? 3 : 2;
    let reads = 0, priming = false, restore = async () => {};
    const options: PackageEditorOptions = {
      now: () => f.at, limits: { maximumPlanDays: 90,maximumBaseLines: 3,maximumAddonLines: 3,maximumQuantity: 99 },
      async withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) {
        await context.query("BEGIN");
        try {
          await context.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
          const answer = await work(context); await context.query("COMMIT"); return answer;
        } catch (error) { await context.query("ROLLBACK"); throw error; }
      },
      readCatalogAdmission: async (_db, input) => {
        reads++;
        const quantity = priming ? 2 : wanted;
        expect(input.lines.map(line => [line.variantId,line.qty])).toEqual([[f.sku,quantity]]);
        if (!priming && change === "absent") return null;
        return { ...f.admission,skuRevisions: [{ reference: f.reference,quantity: !priming && change === "wrong quantity" ? quantity + 1 : quantity }] };
      },
      quoteCatalogReadPort: { listQuoteCatalogItems: async () => [{ variantId: f.sku,skuCode: f.code,sellability: { subscription: true } }] },
      quotePort: { async createServerAuthoritativeQuote(request) {
        const lines = request.lines.map(line => ({ sku: line.sku,quantity: line.quantity,unitPriceGross: money(617),lineSubtotalGross: money(617*line.quantity) }));
        const total = money(lines.reduce((sum,line) => sum+line.lineSubtotalGross.amountMinor,0));
        return { quote: { lines,totalGross: total,subtotalGross: total,discountTotalGross: money(0) } };
      } },
      constraintMapper: { toCore: value => ({ kind: "configured",version: 1,data: value ?? {} }),fromCore: value => value.data,nominalPlanDays: () => null },
      compositionRulesPort: { validateComposition: async () => ({ ok: true }),resizeComposition: async input => ({ coreLines: input.coreLines,constraint: input.constraint }) },
    };
    let preview: () => Promise<string | undefined>, apply: (hash: string) => Promise<unknown>;
    if (lane === "legacy") {
      const editor = createPostgresLegacyEditConsentBridge(options), request = { subscriptionId: f.subscription,coreLines: [{ variantId: f.sku,qty: wanted }] };
      preview = async () => ((await editor.preview(actor,key,request)).preview as { quoteHash?: string } | undefined)?.quoteHash;
      apply = hash => editor.apply(actor,key,{ ...request,acceptedQuoteHash: hash });
    } else if (lane === "sized opt-in" || lane === "sized bundle") {
      const withTax = (line: { sku: string; quantity: number; unitPriceGross: ReturnType<typeof money>; lineSubtotalGross: ReturnType<typeof money> }) => ({
        ...line,productSlug: f.value.product.slug!,tax: { included: true as const,country: "ZZ",category: "standard",vatRateBps: 0,legalBasis: "synthetic",
          netAmount: line.lineSubtotalGross,grossAmount: line.lineSubtotalGross,vatAmount: money(0) },
      });
      const original = withTax({ sku: f.code,quantity: 1,unitPriceGross: money(617),lineSubtotalGross: money(617) });
      await pool.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at) VALUES($1,'subscription.starter_graduated',$2,$3,$4::timestamptz-interval '1 millisecond')",
        [f.subscription,randomUUID(),{ linePricing: [{ sku: f.code,quantity: 1,unitAmountMinor: 617,isAddon: false,quoteLine: original }] },f.at]);
      const editor = createPostgresSizedEditor({
        now: options.now,withTransaction: options.withTransaction,readCatalogAdmission: options.readCatalogAdmission,
        policy: { minimumCoreUnits: 1,maximumCoreLines: 3,maximumAddonLines: 3,maximumQuantity: 99,allowedCadences: [28,30],maximumExclusions: 8,
          maximumCatalogExclusions: 16,fixedThroughCycle: 2,graduationCycle: 3,portionModes: { full: { mode: "full",factor: 1 },reduced: { mode: "reduced",factor: 0.5 } } },
        async readFacts() { return { clientId: f.client,subscriptionId: f.subscription,subjectRef: f.subscription,exclusions: [],snapshot: {} }; },
        async resolveOptInNeed() { return { dailyNeed: 1,snapshot: { dailyNeed: 1 } }; },
        async readCatalog() { return [{ variantId: f.sku,sku: f.code,groupId: f.product,isAddon: false,sellable: true,physicalSize: 100,demandPerUnit: 28,
          documentRevisionId: f.reference.skuRevisionId,documentDigest: f.head.documentDigest,verified: true,exclusions: [],sellableNow: 100 }]; },
        async assertCurrentFacts() {}, async proposePortion() { return []; },
        quotePort: { async createServerAuthoritativeQuote(request) {
          const { quote } = await options.quotePort.createServerAuthoritativeQuote({ ...request,cadenceDays: request.cadenceDays ?? 28,
            lines: request.lines.map(line => ({ ...line,modeAtLine: "subscription",isAddon: line.isAddon ?? false })) });
          return { quote: { ...quote,lines: quote.lines.map(withTax),currency: "XXX",taxIncluded: true,discounts: [],netTotal: quote.totalGross,taxTotal: money(0) } };
        } },
      });
      const optIn = { subscriptionId: f.subscription,action: "resize_bundle" as const,cadenceDays: 28,
        compositionConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 },
        resizeLever: { kind: "subscription.sized.parcel" as const,value: { coreLines: [{ variantId: f.sku,qty: 2 }],optInToSized: true as const } } };
      if (lane === "sized bundle") {
        priming = true;
        const seed = await editor.preview(actor,optIn);
        await editor.apply(actor,randomUUID(),{ ...optIn,acceptedQuoteHash: seed.quoteHash });
        reads = 0;
        priming = false;
      }
      const request = lane === "sized opt-in" ? optIn : { ...optIn,compositionConstraint: { kind: "unit_count",value: 3,dailyNeed: 1 },
        resizeLever: { kind: "subscription.sized.parcel" as const,value: { coreLines: [{ variantId: f.sku,qty: 3 }] } } };
      preview = async () => (await editor.preview(actor,request)).quoteHash;
      apply = hash => editor.apply(actor,key,{ ...request,acceptedQuoteHash: hash });
    } else {
      const editor = createPostgresPackageEditor(options), request = lane === "classic"
        ? { subscriptionId: f.subscription,planDays: 28,base: [{ variantId: f.sku,qty: wanted }] }
        : { subscriptionId: f.subscription,action: "update_plan_length" as const,planDays: 30 };
      preview = async () => (await editor.preview(actor,request)).quoteHash;
      apply = hash => editor.apply(actor,key,{ ...request,acceptedQuoteHash: hash });
    }
    const refusing = "customer_self_service_invalid_offer_membership";
    let stop: Awaited<ReturnType<typeof gate>> | undefined;
    const inFlight: Promise<unknown>[] = [];
    try {
      if (change === "wrong quantity") {
        const before = await snapshot();
        await expect(preview()).rejects.toThrow(new RegExp(`^${refusing}$`, "u"));
        expect(await snapshot()).toEqual(before);
        return;
      }
      const hash = (await preview())!;
      expect(hash).toMatch(/^[a-f0-9]{64}$/u);
      if (change === "absent" || change === "price moved") {
        if (change === "price moved") await pool.query("UPDATE public.price_entries SET updated_at=updated_at+interval '1 second' WHERE id=$1", [f.admission.priceContextVersions[0].entryId]);
        const before = await snapshot();
        await expect(apply(hash)).rejects.toMatchObject({ message: change === "absent" ? "customer_self_service_invalid_catalog_anchor" : "catalog_admission_price_context_moved" });
        expect(await snapshot()).toEqual(before);
        return;
      }
      if (change === "publisher first" || change === "edit before publish") {
        const next = await changedDocument(f), ep = await pid(context), wp = await pid(publisher), hp = await pid(observer);
        stop = await gate(observer);
        const barrier = stop;
        if (change === "publisher first") {
          let atGuard = false;
          const publishing = tracked(publishOn(publisher,next.publication,async (sql,values) => {
            if (!atGuard && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0] === `catalog-lineage:${f.product}`) {
              atGuard = true;
              await publisher.query("SELECT pg_advisory_lock($1::bigint)", [barrier.key]);
              await publisher.query("SELECT pg_advisory_unlock($1::bigint)", [barrier.key]);
            }
          }));
          inFlight.push(publishing);
          await blocker(observer,wp,hp);
          const editing = tracked(apply(hash)); inFlight.push(editing);
          await blocker(observer,ep,wp); await stop.release();
          expect(await publishing).toMatchObject({ ok: true,value: { outcome: "committed" } });
          expect(await editing).toMatchObject({ ok: false,error: { message: "customer_self_service_stale_edit_catalog_head",code: "40001" } });
          expect((await observer.query("SELECT count(*)::integer AS n FROM public.subscription_command_receipts WHERE subscription_id=$1 AND idempotency_key=$2", [f.subscription,key])).rows[0].n).toBe(0);
          return;
        }
        restore = await hook(admissionSignature, sharedBoundary, barrier.sql);
        const editing = tracked(apply(hash)); inFlight.push(editing);
        await blocker(observer,ep,hp);
        const before = await snapshot();
        await assertBusy(await publishOn(publisher,next.publication),before);
        await stop.release();
        expect(await editing).toMatchObject({ ok: true });
      } else if (change === "payment first" || change === "edit before payment") {
        const paid = await payment(f,lane === "sized opt-in" || lane === "sized bundle"), ep = await pid(context), pp = await pid(publisher), hp = await pid(observer);
        stop = await gate(observer);
        await publisher.query("BEGIN");
        if (change === "payment first") {
          restore = await hook("public.payment_provider_lock_aggregate(uuid)",
            "PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE;",stop.sql);
          const paying = tracked(paid.invoke(publisher)); inFlight.push(paying);
          await blocker(observer,pp,hp);
          const editing = tracked(apply(hash)); inFlight.push(editing);
          await blocker(observer,ep,pp);
          await assertNoCatalogGuard(observer,ep);
          await stop.release();
          expect(await paying).toMatchObject({ ok: true });
          await publisher.query("COMMIT");
          expect(await editing).toMatchObject({ ok: true });
        } else {
          restore = await hook(admissionSignature,sharedBoundary,stop.sql);
          const editing = tracked(apply(hash)); inFlight.push(editing);
          await blocker(observer,ep,hp);
          await assertPrelocked(publisher,f,lane === "sized opt-in" || lane === "sized bundle" ? "sized" : lane);
          const paying = tracked(paid.invoke(publisher)); inFlight.push(paying);
          await blocker(observer,pp,ep);
          await stop.release();
          expect(await editing).toMatchObject({ ok: true });
          expect(await paying).toMatchObject({ ok: true });
          await publisher.query("COMMIT");
        }
        expect((await pool.query("SELECT status,total_amount_minor FROM public.commerce_orders WHERE id=$1", [paid.order])).rows)
          .toEqual([{ status: "paid",total_amount_minor: "617" }]);
      } else {
        const applied = await apply(hash);
        expect(applied).toMatchObject(lane === "legacy" ? { subscriptionAction: { status: "applied" } } : { status: "applied" });
      }
      expect(reads).toBe(1);
      expect((await pool.query("SELECT catalog_acceptance FROM public.subscription_events WHERE subscription_id=$1 AND idempotency_key=$2",
        [f.subscription,`command:${digest(`${f.actor}:${key}`)}`])).rows)
        .toEqual([{ catalog_acceptance: { schemaVersion: 2,lines: [f.reference] } }]);
    } finally {
      await stop?.release();
      await publisher.query("ROLLBACK");
      await Promise.allSettled(inFlight);
      await restore();
      context.release(); publisher.release(); observer.release();
    }
  },
);
