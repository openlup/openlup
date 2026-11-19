import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresCatalogPublication, createCatalogProductTypeRegistry, installCatalogDefinitions, catalogDefinitionDigest,
  createPostgresCatalogAdmission, createPostgresCommerceQuoteCatalogReadPort, type CatalogPublicationRules } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV4, type CatalogPublishCommand, type CatalogHeadRef,
  type CatalogAdmissionInput, type CatalogAcceptedReferenceV2 } from "@openlup/platform/catalog/contracts";
import { createPostgresProviderPaymentControlPort, createPostgresPaymentWebhookControlPort } from "@openlup/platform/payments";
import { createNativeCatalogRenewalCodecV2, createPostgresRenewalStore, createPostgresStockWaitStore } from "@openlup/platform/subscriptions";
import { createPostgresAcquisitionCheckoutPersistence, createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { canonicalCatalogPriceSetupCommand, createDbBackedCommerceQuotePort } from "@openlup/platform/pricing";
import { createPostgresPackageEditor, createPostgresSizedEditor, createOfferDispatchedSubscriptionEditor, createPostgresPurchaseRenewalWriter, mapPackageEditError, mapSizedEditError, type SizedEditorOptions, type SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import { catalogAcceptedReferenceV2Schema } from "@openlup/platform/catalog";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { createPostgresCommercePriceAuthorityPort } from "../../server/adapters/postgres/pricingResolver.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from "../helpers/postgresContainer.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function primaryIdentifier(sku: string) {
  const digits = (BigInt(`0x${sku.replaceAll("-","").slice(0,14)}`) % 1_000_000_000_000n).toString().padStart(12,"0");
  return digits + String((10 - [...digits].reduce((sum,digit,index) => sum + Number(digit) * (index % 2 ? 3 : 1),0) % 10) % 10);
}
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:g", dimension: "mass" as const, integral: false }],
  netContentUnits: ["openlup:g"], dimensions: [], axes: [], validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] };
const registry = createCatalogProductTypeRegistry([definition]);
const rules: CatalogPublicationRules = { canonicalizeDocument: canonicalCatalogDraftJson,
  deriveSkuFacts: document => ({ derived: (document as { derived: number }).derived }), validateProduct: () => [], classifySkuChange: () => "compatible" };
let container: PostgresContainer | undefined, pool: Pool, runtime: Pool;
const administrator = randomUUID();
const packs = ["supplements", "cosmetics", "pet-food"] as const;
const lanes = ["classic", "exact", "sized", "legacy"] as const;
type Lane = typeof lanes[number];
beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-admission-${process.pid}`, password: "synthetic-admission" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Admission requires real PostgreSQL");
  const installation: QualifiedPostgresInstallation = {
    generation: "qualified-v2",roleMode: "installer-managed",bootstrapLogin: "postgres",migrationLogin: "postgres",
    runtimeLogin: "admission_runtime",restoreLogin: "admission_restore",
  };
  pool = new Pool({ connectionString: container.connectionString,options: qualifiedPostgresStartupOptions(installation) });
  await pool.query("CREATE ROLE admission_runtime LOGIN NOINHERIT NOBYPASSRLS PASSWORD 'synthetic-admission'; CREATE ROLE admission_restore LOGIN NOINHERIT NOBYPASSRLS");
  await createPostgresMigrationRunner({ connectionString: container.connectionString },{ installation,poolFactory: () => pool }).apply();
  const runtimeUrl = new URL(container.connectionString);
  runtimeUrl.username = installation.runtimeLogin;
  runtime = new Pool({ connectionString: runtimeUrl.toString() });
  await installCatalogDefinitions(pool, { id: "example:admission", namespace: "example", version: 1, openlupRange: "0.44.x",
    capabilities: { publish: false }, types: [definition], taxClasses: [] });
  await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,'admission@example.invalid')", [administrator]);
  await pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())", [administrator]);
  await pool.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','1')");
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, [pool,runtime].filter(Boolean)), postgresTeardownTimeoutMs);
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
  const gtin = primaryIdentifier(sku);
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
async function fixture(pack: string, standing: { product?: Record<string, unknown>; sku?: Record<string, unknown>; sibling?: boolean } = {}) {
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
    const sibling = standing.sibling ? { id: randomUUID(), revision: randomUUID() } : null;
    const siblingIdentifier = sibling ? primaryIdentifier(sibling.id) : null;
    const siblingFacts = sibling ? { ...facts, id: sibling.id, code: `ARTICLE-${sibling.id}`, status: "draft",
      lifecycleState: "draft", isAddon: false, sellableStandalone: false, sellableInSubscription: false, memberships: [],
      identifiers: [{ ...facts.identifiers[0],value: siblingIdentifier }] } : null;
    const siblingText = siblingFacts ? canonicalCatalogDraftJson(siblingFacts) : null;
    if (sibling && siblingText) {
      manifest.skus.push({ ...ref,skuId: sibling.id,revisionId: sibling.revision,revision: 1,digest: digest(siblingText) });
      manifest.skus.sort((a: { skuId: string }, b: { skuId: string }) => a.skuId.localeCompare(b.skuId));
    }
    const canonical = canonicalCatalogDraftJson(manifest), hash = digest(canonical);
    await db.query("INSERT INTO public.catalog_lifecycle_write_capabilities VALUES(pg_current_xact_id(),$1,$2)", [product,hash]);
    await db.query("UPDATE public.catalog_products SET status=$3,publication_facts=$2::jsonb WHERE id=$1", [product,manifest.product,manifest.product.status]);
    await db.query("UPDATE public.catalog_skus SET status=$3,sellable_standalone=$4,sellable_in_subscription=$5,is_addon=$6,publication_facts=$2::jsonb WHERE id=$1",
      [sku,facts,facts.status,facts.sellableStandalone,facts.sellableInSubscription,facts.isAddon]);
    await db.query("INSERT INTO public.catalog_publications(id,product_id,revision,previous_id,draft_id,draft_revision,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id) VALUES($1,$2,2,$3,$4,1,$5,$6,$7,$8,$6,$9)",
      [publication,product,old.id,draft,`standing:${publication}`,hash,old.document_revision_id,canonical,administrator]);
    await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,2,$4,$5,$6)", [revision,sku,product,publication,fullFacts,factsDigest]);
    if (sibling && siblingFacts && siblingText) {
      await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,min_order_qty,is_addon,sellable_standalone,
        sellable_in_subscription,net_weight_g,publication_facts,net_content_dimension,net_content_unscaled,net_content_scale,net_content_unit,
        gross_mass_dimension,gross_mass_unscaled,gross_mass_scale,gross_mass_unit,asset_ref,attribute_values,option_values,canonical_option_bytes,combination_digest)
        SELECT $2,product_id,$3,title,'draft',min_order_qty,false,false,false,net_weight_g,$4,net_content_dimension,
         net_content_unscaled,net_content_scale,net_content_unit,gross_mass_dimension,gross_mass_unscaled,gross_mass_scale,gross_mass_unit,
         asset_ref,attribute_values,option_values,canonical_option_bytes,combination_digest FROM public.catalog_skus WHERE id=$1`, [sku,sibling.id,siblingFacts.code,siblingFacts]);
      await db.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary,scheme,original_value)
        VALUES($1,'example','gtin',lpad($2,14,'0'),'unit',1,true,'gs1:gtin',$2)`, [sibling.id,siblingIdentifier]);
      await db.query("INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest) VALUES($1,$2,$3,1,$4,$5,$6)",
        [sibling.revision,sibling.id,product,publication,siblingText,digest(siblingText)]);
    }
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
    return { product,sku,draft,client,subscription,actor,value,head,reference,admission,at,anchor,sibling: sibling?.id,code: facts.code as string };
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function edit(f: Fixture, lane: Lane = "classic", deriveEvidence = false, policy?: { revisionId: string; digest: string }, legacyLine?: { sku: string; code: string }) {
  const key = randomUUID(), line = { variantId: f.sku,qty: 2,isAddon: false,
    quoteLine: { sku: f.code,quantity: 2,unitPriceGross: money(617),lineSubtotalGross: money(1234) } };
  let hash = digest(key);
  const core: { variantId: string; qty: number }[] = [{ variantId: f.sku,qty: 2 }];
  if (legacyLine) core.push({ variantId: legacyLine.sku,qty: 1 });
  const newAmount = core.reduce((sum,entry) => sum+entry.qty*617,0);
  if (lane === "legacy") {
    if (deriveEvidence) {
      const db = await session(), constraint = {};
      try {
        await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
          [f.actor,JSON.stringify({ sub: f.actor,role: "authenticated" })]);
        const preview = await rpc(db,"customer_subscription_preview_bundle_as_actor",[f.subscription,key,JSON.stringify(core),"[]",constraint,28,1]);
        const accepted = preview.preview.quoteHash as string;
        await db.query("COMMIT");
        const args: unknown[] = [f.subscription,key,accepted,JSON.stringify(core),"[]",constraint,28,1];
        return { key,hash: accepted,action: "update_bundle",payload: {},args,
          invoke: (connection: PoolClient) => rpc(connection,"customer_subscription_apply_bundle_as_actor",args) };
      } finally { await db.query("ROLLBACK"); db.release(); }
    }
    const constraint = {};
    const lines = core.map(({ variantId,qty },sortOrder) => ({ variantId,quantity: qty,isAddon: false,sortOrder,unitPriceMinor: 617,currency: "XXX",
      ...(sortOrder === 0 && f.admission ? { catalogAdmission: f.admission } : {}) }));
    await pool.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,
      command_key_identity,expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
      VALUES($1,'command:'||encode(sha256(convert_to($2::text||':'||$3::text,'UTF8')),'hex'),
        public.subscription_bundle_edit_fingerprint($1,$4::jsonb,'[]','{}',28,1),$5,
        jsonb_build_object('derivation','principal-sha256.v1','actorId',$2::uuid),1,$6::jsonb,28,617,$8,'XXX',$7::timestamptz+interval '1 hour')`,
    [f.subscription,f.actor,key,JSON.stringify(core),hash,JSON.stringify(lines),f.at,newAmount]);
    const args: unknown[] = [f.subscription,key,hash,JSON.stringify(core),"[]",constraint,28,1];
    return { key,hash,action: "update_bundle",payload: {},args,
      invoke: (connection: PoolClient) => rpc(connection,"customer_subscription_apply_bundle_as_actor",args) };
  }
  const lines = [line,...(legacyLine ? [{
    variantId: legacyLine.sku,qty: 1,isAddon: false,quoteLine: {
      sku: legacyLine.code,quantity: 1,unitPriceGross: money(617),lineSubtotalGross: money(617),
    },
  }] : [])];
  const action = lane === "classic" ? "update_package_template" : lane === "exact" ? "update_plan_length" : "resize_bundle";
  const request = lane === "classic" ? { planDays: 28,base: core,addons: [],expectedTemplateVersion: 1,acceptedQuoteHash: hash }
    : lane === "exact" ? { action,planDays: 30,expectedTemplateVersion: 1,acceptedQuoteHash: hash }
      : { action,cadenceDays: 28,compositionConstraint: { kind: "unit_count",value: core.reduce((total,entry) => total+entry.qty,0),dailyNeed: 1 },expectedTemplateVersion: 1,acceptedQuoteHash: hash,
        resizeLever: { kind: "subscription.sized.parcel",value: { coreLines: core,optInToSized: true } } };
  const constraint = lane === "sized" ? { kind: "unit_count",value: core.reduce((total,entry) => total+entry.qty,0),dailyNeed: 1 } : null;
  const cadenceDays = lane === "exact" ? 30 : 28;
  const evidence = lane === "classic" ? { baseLines: lines,addonLines: [],compositionConstraint: constraint,catalogAdmission: f.admission ?? null }
    : { lines,cadenceDays,compositionConstraint: constraint,catalogAdmission: f.admission,subjectFacts: { revision: 1 },optInFacts: { revision: 1 } };
  if (deriveEvidence) {
    const price = f.admission.priceContextVersions[0];
    Object.assign(line.quoteLine,{ catalogFacts: {
      ...(policy ? { version: "catalog_facts_v2",policyRevisionId: policy.revisionId,policyDigest: policy.digest }
        : { version: "catalog_facts_v1",resolvedPriceEntryId: price.entryId }),
      skuId: f.sku,documentRevisionId: f.value.product.documentRevision!.id,
      publication: { productId: f.product,skuRevisionId: f.reference.skuRevisionId,head: f.head },
      documentDigest: f.head.documentDigest,basePriceEntryId: price.entryId,
      mode: "subscription",atTime: f.at,currency: "XXX",baseUnitAmountMinor: 617,resolvedUnitAmountMinor: 617,resolvedLineAmountMinor: 1234,
    } });
    delete (evidence as Partial<typeof evidence>).catalogAdmission;
    if (lane === "exact" && "subjectFacts" in evidence) {
      delete (evidence as Partial<typeof evidence>).subjectFacts;
      delete (evidence as Partial<typeof evidence>).optInFacts;
    }
  }
  const totals = { currentRecurringPrice: money(617),newRecurringPrice: money(newAmount),delta: money(newAmount-617) };
  const recorded = await rpc(pool,"subscription_quote_preview_record",[f.actor,f.client,f.subscription,action,hash,1,
    (await pool.query("SELECT $1::timestamptz+interval '1 hour' AS at", [f.at])).rows[0].at,
    lane === "classic" ? { planDays: 28,base: core,addons: [] } : Object.fromEntries(Object.entries(request).filter(([key]) => !["expectedTemplateVersion","acceptedQuoteHash"].includes(key))),evidence,totals,f.at]);
  hash = recorded.quote_hash;
  request.acceptedQuoteHash = hash;
  const payload = { ...request,request,expectedTemplateVersion: 1,acceptedQuoteHash: hash,
    ...(lane === "classic" ? { planDays: 28,base: core,addons: [],...evidence,...totals } : { ...evidence,cadenceDays }) };
  const args: unknown[] = [f.actor,f.client,key,f.subscription,...(lane === "exact" ? [action] : []),payload,f.at];
  return { key,hash,action,payload,args,invoke: (connection: PoolClient) => rpc(connection,lane === "classic" ? "subscription_package_edit_apply" : lane === "exact" ? "subscription_line_edit_apply" : "subscription_sized_edit_apply",args) };
}
let snapshotStatement: string;
async function snapshot(): Promise<Record<string, unknown>> {
  if (!snapshotStatement) {
    const { rows } = await pool.query("SELECT quote_ident(tablename) AS identifier,quote_literal(tablename) AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const tables = rows.map(({ identifier,name }) => `SELECT ${name}::text AS name,coalesce(
      jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM public.${identifier} t`);
    snapshotStatement = `SELECT jsonb_object_agg(name,rows) AS snapshot FROM (${tables.join(" UNION ALL ")}) all_tables`;
  }
  return (await pool.query(snapshotStatement)).rows[0].snapshot;
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
const catalogAssertionSignature = "public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text)";
const verifiedHeadsSignature = "public.catalog_admission_verified_heads(uuid[],boolean)";
const packageSignature = "public.subscription_package_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz)";
const takeSignature = "public.subscription_quote_preview_take(uuid,uuid,uuid,text,text,integer,text,timestamptz)";
const subscriptionBoundary = "SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;";
it.each((["one_time","subscription"] as const).flatMap(mode => [false,true].flatMap(promoted =>
  [false,true].map(control => ({ mode,promoted,control })))))(
  "LC6-D-070 and LC6-D-073 purchase fences an alternate base price in $mode, promoted=$promoted, control=$control",
  async ({ mode,promoted,control }) => {
    const f = await fixture(packs[0]), input = purchaseInput(f), alternate = randomUUID();
    input.draft.context.mode = mode;
    input.quote.catalogAdmission.mode = mode;
    await pool.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX') ON CONFLICT(key) DO NOTHING");
    await rpc(pool,"commerce_capture_offer_policy_v2_legacy_baseline",[]);
    await pool.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Alternate synthetic list','ZZ','XXX',$2::timestamptz-interval '1 day')", [alternate,f.at]);
    const bytes = canonicalCatalogPriceSetupCommand({ schemaVersion: 1,commandKey: randomUUID(),variantId: f.sku,priceListId: alternate,
      mode: "one_time",minQty: 1,amountKind: "gross",unitPriceMinor: 617,expected: { entryId: null,unitPriceMinor: null } });
    const h = await pool.connect(), a = await runtime.connect(), b = await session();
    const stop = await gate(h), ap = await pid(a), bp = await pid(b), hp = await pid(h);
    const routine = promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox";
    const widerScope = "UNION ALL\n   SELECT l.id,scope.sku_id FROM public.price_lists l CROSS JOIN unnest(scoped_skus) scope(sku_id)\n    WHERE p_purpose='order' AND l.currency=p_offer_evidence->>'currency'";
    const boundary = "UNION SELECT (v#>>'{base,entryId}')::uuid FROM jsonb_array_elements(prices) v WHERE v ? 'base') ORDER BY p.id FOR SHARE;";
    let restore = async () => {};
    try {
      await b.query("SET LOCAL ROLE authenticated");
      await b.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
        [administrator,JSON.stringify({ sub: administrator,role: "authenticated" })]);
      restore = await hook(admissionSignature,boundary,`IF pg_backend_pid()=${ap} THEN ${stop.sql} END IF;`,body => {
        expect(body.split(widerScope)).toHaveLength(2);
        return control ? body.replace(widerScope,"") : body;
      });
      const purchase = tracked(rpc(a,routine,input.args));
      await blocker(h,ap,hp);
      const pricing = tracked(rpc(b,"catalog_price_setup_apply",[bytes,digest(bytes)]));
      if (control) {
        const slipped = await pricing;
        if (!slipped.ok) throw slipped.error;
        expect(slipped.value).toMatchObject({ outcome: "committed" });
        await b.query("COMMIT");
        await stop.release();
      } else {
        await blocker(h,bp,ap);
        await stop.release();
        const written = await pricing;
        if (!written.ok) throw written.error;
        expect(written.value).toMatchObject({ outcome: "committed" });
        await b.query("COMMIT");
      }
      expect(await purchase).toMatchObject({ ok: true,value: { orderDraft: { replayed: false } } });
      expect((await h.query("SELECT unit_price_minor,mode FROM public.price_entries WHERE price_list_id=$1 AND variant_id=$2", [alternate,f.sku])).rows)
        .toEqual([{ unit_price_minor: 617,mode: "one_time" }]);
    } finally {
      await stop.release(); await a.query("ROLLBACK"); await b.query("ROLLBACK");
      await restore(); a.release(); b.release(); h.release();
    }
  },
);


function governedCheckoutQuote(f: Fixture, mode: "one_time" | "subscription", offerVersion = "classic", offerEvidence?: Record<string, unknown>) {
  const amount = money(1234), price = f.admission.priceContextVersions[0];
  return { contractVersion: "commerce.v0" as const,quote: { currency: "XXX",taxIncluded: true as const,
    lines: [{ sku: f.code,productSlug: f.value.product.slug!,quantity: 2,unitPriceGross: money(617),lineSubtotalGross: amount,
      tax: { included: true as const,country: "ZZ",category: "standard",vatRateBps: 0,legalBasis: "Synthetic tax",
        netAmount: amount,vatAmount: money(0),grossAmount: amount },
      catalogFacts: { version: "catalog_facts_v1" as const,skuId: f.sku,documentRevisionId: f.value.product.documentRevision!.id,
        documentDigest: f.head.documentDigest,basePriceEntryId: price.entryId,resolvedPriceEntryId: price.entryId,
        mode,atTime: f.at,currency: "XXX",baseUnitAmountMinor: 617,resolvedUnitAmountMinor: 617,resolvedLineAmountMinor: 1234 } }],
    discounts: [],context: { mode,cadenceDays: 28,promoCodes: [],offerVersion,...(offerEvidence ? { offerEvidence } : {}) },
    subtotalGross: amount,discountTotalGross: money(0),totalGross: amount,netTotal: amount,taxTotal: money(0) } };
}
it.each(["one_time","subscription"] as const)("LC6-D-080 and LC6-D-153 checkout evidence uses the installed membership page in %s", async mode => {
  const f = await fixture(packs[0]), key = randomUUID(), quote = governedCheckoutQuote(f,mode);
  const port = createPostgresAcquisitionCheckoutPersistence(runtime,{ regionCode: "ZZ",isAcquisitionDiscount: () => false,
    financialPolicy: { facts: () => ({ regionCodes: [],metadataPresent: false }) } as never });
  const installed = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
  if (!installed) {
    const before = await snapshot();
    await expect(port.captureCatalogAdmission(quote)).rejects.toMatchObject({ message: "catalog_admission_membership_authority_unavailable",code: "55000" });
    expect(await snapshot()).toEqual(before);
    return;
  }
  await expect(port.captureCatalogAdmission(quote)).rejects.toMatchObject({ message: "catalog_admission_quote_authority_required",code: "22023" });
  const evidence = await port.captureCatalogAdmission(quote,f.admission.heads);
  expect(evidence).toMatchObject({ heads: f.admission.heads,skuRevisions: f.admission.skuRevisions,priceContextVersions: f.admission.priceContextVersions,mode,purpose: "order" });
  const accepted = await port.createOrderDraft({ idempotencyKey: key,quoteSnapshot: quote },{ clientId: f.client,catalogAdmission: evidence! });
  expect(accepted.orderDraft.quoteSnapshot.quote.lines[0]).not.toHaveProperty("catalogFacts");
  const publisher = await pool.connect(), next = await changedDocument(f);
  try { expect((await publishOn(publisher,next.publication)).outcome).toBe("committed"); } finally { publisher.release(); }
  expect(await port.createOrderDraft({ idempotencyKey: key,quoteSnapshot: quote },{ clientId: f.client }))
    .toEqual({ ...accepted,orderDraft: { ...accepted.orderDraft,replayed: true } });
});

it.for(["one_time","subscription"] as const)("LC6-D-034/D-105/D-108 binds capture to the exact mixed checkout and checks every line in %s", async (mode,test) => {
  const installed = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
  if (!installed) { test.skip("Membership page comes from the predecessor installation"); return; }
  const governed = await fixture(packs[0]), legacy = await legacyFixture();
  const sized = governedCheckoutQuote(governed,mode,"sized.v1",{ basis: "synthetic" });
  const { catalogFacts: _facts,...unbound } = governedCheckoutQuote(legacy,mode).quote.lines[0];
  const basket: import("@openlup/platform/pricing").CreateQuoteResponse["quote"]["lines"] = sized.quote.lines;
  basket.push(unbound);
  Object.assign(sized.quote,{ subtotalGross: money(2468),totalGross: money(2468),netTotal: money(2468) });
  let allowLegacy = false, stockChecks = 0;
  const port = createPostgresAcquisitionCheckoutPersistence(runtime,{ regionCode: "ZZ",isAcquisitionDiscount: () => false,
    financialPolicy: { facts: () => ({ regionCodes: [],metadataPresent: false }) } as never,
    availability: { async getAvailability({ items }) {
      stockChecks++;
      expect(items.map(({ sku,checkoutMode,requestedQuantity }) => [sku,checkoutMode,requestedQuantity]))
        .toEqual([[governed.code,mode,2],[legacy.code,mode,2]]);
      return items.filter(item => allowLegacy || item.sku !== legacy.code).map(item => ({ sku: item.sku,productSlug: item.productSlug,
        variantId: item.variantId,visibleInConfigurator: true,sellableNow: 2,status: "available",reasonCode: "synthetic",source: "fixture" }));
    } } });
  const classic = structuredClone(sized);
  classic.quote.context.offerVersion = "classic";
  const classicCapture = await port.captureCatalogAdmission(classic,governed.admission.heads);
  const draft = (quoteSnapshot: typeof sized, catalogAdmission: object | null) => port.createOrderDraft({ idempotencyKey: randomUUID(),quoteSnapshot },
    { clientId: governed.client,catalogAdmission });
  const before = await snapshot();
  await expect(draft(sized,classicCapture)).rejects.toThrow("catalog_admission_checkout_capture_mismatch");
  await expect(port.captureCatalogAdmission(sized,governed.admission.heads)).rejects.toThrow("catalog_admission_sized_stock_unavailable");
  allowLegacy = true;
  const accepted = await port.captureCatalogAdmission(sized,governed.admission.heads);
  const other = structuredClone(sized);
  other.quote.context.mode = mode === "subscription" ? "one_time" : "subscription";
  await expect(draft(other,accepted)).rejects.toThrow("catalog_admission_checkout_capture_mismatch");
  const earlier = structuredClone(sized);
  earlier.quote.lines[0].catalogFacts.atTime = new Date(Date.parse(governed.at)-1000).toISOString();
  await expect(draft(earlier,accepted)).rejects.toThrow("catalog_admission_checkout_capture_mismatch");
  expect(await snapshot()).toEqual(before);
  expect(await draft(sized,accepted)).toMatchObject({ orderDraft: { replayed: false } });
  expect(stockChecks).toBe(2);
});

it.for((["one_time","subscription"] as const).flatMap(mode =>
  (["ready","missing binding","missing stock","wrong identity","hidden","insufficient"] as const).map(stock => ({ mode,stock }))))(
  "LC6-D-101 and LC6-D-108 governed sized checkout checks $stock stock in $mode", async ({ mode,stock },context) => {
    const installed = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
    if (!installed) { context.skip("Membership page comes from the predecessor installation"); return; }
    const f = await fixture(packs[0]);
    const snapshotQuote = governedCheckoutQuote(f,mode,"sized.v1",stock === "missing binding" ? undefined : { basis: "synthetic" });
    const port = createPostgresAcquisitionCheckoutPersistence(runtime,{ regionCode: "ZZ",isAcquisitionDiscount: () => false,
      financialPolicy: { facts: () => ({ regionCodes: [],metadataPresent: false }) } as never,
      availability: { async getAvailability({ items }) {
        expect(items).toEqual([{ sku: f.code,productSlug: f.value.product.slug!,variantId: f.sku,requestedQuantity: 2,checkoutMode: mode }]);
        const held = (await pool.query(`SELECT count(*)::integer AS count FROM pg_locks WHERE locktype='advisory'
          AND mode='ShareLock' AND ((classid::bigint<<32)|objid::bigint)=hashtextextended('catalog-publication-global',0)`)).rows[0];
        expect(held.count).toBe(0);
        if (stock === "missing stock") return [];
        return [{ sku: f.code,productSlug: f.value.product.slug!,variantId: stock === "wrong identity" ? randomUUID() : f.sku,
          visibleInConfigurator: stock !== "hidden",sellableNow: stock === "insufficient" ? 1 : 2,status: "available",reasonCode: "synthetic",source: "fixture" }];
      } },
    });
    if (stock === "ready") {
      const evidence = await port.captureCatalogAdmission(snapshotQuote,f.admission.heads);
      expect(evidence).toMatchObject({ heads: f.admission.heads,skuRevisions: f.admission.skuRevisions,mode,offerEvidence: { offerVersion: "sized.v1" } });
      expect(await port.createOrderDraft({ idempotencyKey: randomUUID(),quoteSnapshot: snapshotQuote },{ clientId: f.client,catalogAdmission: evidence }))
        .toMatchObject({ orderDraft: { replayed: false } });
    } else {
      const before = await snapshot();
      await expect(port.captureCatalogAdmission(snapshotQuote,f.admission.heads)).rejects.toThrow(stock === "missing binding"
        ? "catalog_admission_sized_offer_binding_required" : "catalog_admission_sized_stock_unavailable");
      expect(await snapshot()).toEqual(before);
    }
  },
);

it.for(["one_time","subscription"] as const)("LC6-D-118 checkout cannot replace its quote-time head: %s", async (mode,context) => {
  const installed = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
  if (!installed) { context.skip("Membership page comes from the predecessor installation"); return; }
  const f = await fixture(packs[0]), priorQuote = governedCheckoutQuote(f,mode), next = structuredClone(f.value);
  const membership = { skuCode: f.code,offerVersion: "example:future",admitted: false };
  next.product.sharedContent = { ...next.product.sharedContent,catalogAction: "revise",offerMemberships: [membership] };
  next.publication.operations = [{ op: "set_offer_membership",...membership }];
  const publishing = await pool.connect();
  try {
    const change = await candidate(publishing,next,f.draft,1,f.head), result = await change.authority.publish(change.publication,change.actor);
    expect(result.outcome).toBe("committed");
    if (!("receipt" in result)) throw new Error(JSON.stringify(result));
    expect(result.receipt.head).toMatchObject({ revision: f.head.revision+1,documentDigest: f.head.documentDigest });
  } finally { publishing.release(); }
  const port = createPostgresAcquisitionCheckoutPersistence(runtime,{ regionCode: "ZZ",isAcquisitionDiscount: () => false,
    financialPolicy: { facts: () => ({ regionCodes: [],metadataPresent: false }) } as never });
  const before = await snapshot();
  await expect(port.captureCatalogAdmission(priorQuote,f.admission.heads)).rejects.toMatchObject({ code: "40001",message: "catalog_publication_head_moved" });
  expect(await snapshot()).toEqual(before);
});

const membershipReadBoundary = "page:=public.catalog_offer_memberships_page(offer_version,cursor_id,page_limit,p_mode,head_digest);";
const memberReadFailures = [
  { name: "changed authority",injection: "page:=jsonb_set(page,'{headDigest}',to_jsonb('invalid'::text));",
    predicate: "NOT coalesce(page->>'headDigest' ~ '^[0-9a-f]{64}$',false)",readerCode: "catalog_authority_unavailable",candidateMessage: "catalog_admission_membership_authority_unavailable" },
  { name: "wrong mode",injection: `page:=jsonb_set(page,ARRAY['items','0',CASE WHEN p_mode='one_time' THEN 'sellableStandalone' ELSE 'sellableInSubscription' END],'false');`,
    predicate: "item->'sellableInSubscription' IS DISTINCT FROM 'true'::jsonb",readerCode: "catalog_authority_unavailable",candidateMessage: "catalog_admission_membership_authority_unavailable" },
  { name: "wrong document",injection: "page:=jsonb_set(page,'{items,0,document,id}',to_jsonb('wrong-document'::text));",
    readerCode: "catalog_authority_changed",candidateMessage: "catalog_publication_head_moved" },
  { name: "short cursor page",injection: `page:=jsonb_set(jsonb_set(page,'{items}',jsonb_build_array(page#>'{items,0}')),'{nextCursor}',page#>'{items,0,skuId}');`,
    readerCode: "catalog_authority_unavailable",candidateMessage: "catalog_admission_membership_authority_unavailable" },
  { name: "wrong protocol",injection: "page:=jsonb_set(page,'{protocol}',to_jsonb('legacy'::text));",
    readerCode: "catalog_authority_unavailable",candidateMessage: "catalog_admission_membership_authority_unavailable" },
  { name: "duplicate identity",injection: "page:=jsonb_set(page,'{items}',jsonb_build_array(page#>'{items,0}',page#>'{items,0}'));",
    readerCode: "catalog_authority_unavailable",candidateMessage: "catalog_admission_membership_authority_unavailable" },
  { name: "stale continuation",injection: "RAISE EXCEPTION 'catalog_publication_head_moved' USING ERRCODE='40001';",
    readerCode: "catalog_authority_changed",candidateMessage: "catalog_publication_head_moved" },
  { name: "unavailable",injection: "RAISE EXCEPTION 'synthetic membership store unavailable' USING ERRCODE='58000';",
    readerCode: "catalog_authority_unavailable",candidateMessage: "synthetic membership store unavailable" },
] as const;

function removeLiveRoleCheck() {
  return hook(verifiedHeadsSignature,"DECLARE product_id uuid;","",body => {
    const predicate = "OR to_jsonb(sk.is_addon) IS DISTINCT FROM sk.publication_facts->'isAddon'";
    expect(body.split(predicate)).toHaveLength(2);
    return body.replace(predicate,"");
  });
}

async function observeMembershipSnapshot<T>(f: Fixture,read: () => Promise<T>,control: boolean): Promise<T> {
  const next = await changedDocument(f), h = await pool.connect(), w = await pool.connect(), stop = await gate(h);
  const hp = await pid(h);
  let restore = async () => {}, restoreGuard = async () => {};
  try {
    if (control) restoreGuard = await hook("public.catalog_publication_read_head()","BEGIN\n","",body => {
      expect(body.split(sharedBoundary)).toHaveLength(2);
      return body.replace(sharedBoundary,"");
    });
    restore = await hook("public.catalog_admission_members(text,text,uuid[],boolean)",membershipReadBoundary,stop.sql);
    const reading = tracked(read());
    await expect.poll(async () => (await h.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l WHERE l.locktype='advisory'
      AND NOT l.granted AND ((l.classid::bigint<<32)|l.objid::bigint)=$1::bigint AND $2::integer=ANY(pg_blocking_pids(l.pid))) AS waiting`,
      [stop.key,hp])).rows[0].waiting).toBe(true);
    const before = await snapshot(), published = await publishOn(w,next.publication);
    if (control) {
      expect(published).toMatchObject({ outcome: "committed" });
      await expect(assertBusy(published,before)).rejects.toThrow();
    } else await assertBusy(published,before);
    await stop.release();
    const result = await reading;
    if (!result.ok) throw result.error;
    if (!control) expect(await publishOn(w,next.publication)).toMatchObject({ outcome: "committed" });
    return result.value;
  } finally { await stop.release(); await w.query("ROLLBACK"); await restore(); await restoreGuard(); w.release(); h.release(); }
}

function changedMembershipPage(row: (typeof memberReadFailures)[number], control = false) {
  return hook("public.catalog_admission_members(text,text,uuid[],boolean)",membershipReadBoundary,row.injection,body => {
    if (!control || !("predicate" in row)) return body;
    expect(body.split(row.predicate)).toHaveLength(2);
    return body.replace(row.predicate,"false");
  });
}

it.for([
  { mode: "one_time",check: "shape" },{ mode: "subscription",check: "shape" },
  { mode: "subscription",check: "snapshot" },{ mode: "subscription",check: "snapshot control" },
] as const)("LC6-D-094, LC6-D-096 and LC6-D-118 configured quote read qualifies the exact offer and stamps its head in $mode, $check",
  async ({ mode,check },context) => {
  const installed = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
  if (!installed) { context.skip("Membership page comes from the predecessor installation"); return; }
  const offerVersion = `example:quote-${randomUUID()}`, members = [{ offerVersion,admitted: true }];
  const f = await fixture(packs[0],{ sku: { memberships: members },sibling: check === "shape" && mode === "subscription" });
  await fixture(packs[1],{ sku: { memberships: members,...(mode === "one_time" ? { sellableStandalone: false } : { sellableInSubscription: false }) } });
  const verifier: string[] = [];
  const options = {
    maxItems: 1,
    async verifyDocument(document: unknown, envelope: { sku: { id: string }; documentRevision: { digest: string } }) {
      expect(digest(canonicalCatalogDraftJson(document))).toBe(envelope.documentRevision.digest);
      verifier.push(envelope.sku.id);
    },
    governedOffer: {
      offerVersion,mode,
      async withSnapshot<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) {
        const db = await runtime.connect();
        try { await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const result = await work(db); await db.query("COMMIT"); return result; }
        catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
      },
    },
  };
  const read = createPostgresCommerceQuoteCatalogReadPort(runtime,options);
  expect(await read.listQuoteCatalogItems()).toEqual([expect.objectContaining({
    skuId: f.sku,skuCode: f.code,variantId: f.sku,
    publication: { productId: f.product,skuRevisionId: f.reference.skuRevisionId,head: f.head },
  })]);
  expect(verifier).toEqual([f.sku]);
  if (check !== "shape") {
    expect(await observeMembershipSnapshot(f,() => read.listQuoteCatalogItems(),check === "snapshot control")).toEqual([
      expect.objectContaining({ skuId: f.sku,publication: { productId: f.product,skuRevisionId: f.reference.skuRevisionId,head: f.head } }),
    ]);
    return;
  }
  const readCommitted = createPostgresCommerceQuoteCatalogReadPort(runtime,{
    ...options,governedOffer: { ...options.governedOffer,withSnapshot: work => work(runtime) },
  });
  await expect(readCommitted.listQuoteCatalogItems()).rejects.toMatchObject({ code: "catalog_read_not_configured" });
  expect(verifier).toEqual([f.sku]);
  for (const failure of memberReadFailures) {
    const restore = await changedMembershipPage(failure);
    try { await expect(read.listQuoteCatalogItems()).rejects.toMatchObject({ code: failure.readerCode }); }
    finally { await restore(); }
  }
  if (mode === "subscription") {
    await pool.query("UPDATE public.catalog_skus SET is_addon=true WHERE id=$1", [f.sibling]);
    try {
      await expect(read.listQuoteCatalogItems()).rejects.toMatchObject({ code: "catalog_authority_unavailable" });
      const restore = await removeLiveRoleCheck();
      try { await expect(read.listQuoteCatalogItems()).resolves.toHaveLength(1); }
      finally { await restore(); }
    } finally { await pool.query("UPDATE public.catalog_skus SET is_addon=false WHERE id=$1", [f.sibling]); }
  }
  if (mode === "subscription") {
    for (const failure of memberReadFailures.filter(row => "predicate" in row)) {
      const restore = await changedMembershipPage(failure,true);
      try {
        if (failure.name === "wrong mode") await expect(read.listQuoteCatalogItems()).rejects.toMatchObject({ code: "catalog_authority_changed" });
        else await expect(read.listQuoteCatalogItems()).resolves.toHaveLength(1);
      } finally { await restore(); }
    }
  }
});

it.for([
  { path: "checkout",mode: "one_time",regionCode: "QR" }, { path: "checkout",mode: "subscription",regionCode: "QT" },
  { path: "package",mode: "subscription",regionCode: "QG" }, { path: "exact",mode: "subscription",regionCode: "QH" },
  { path: "sized",mode: "subscription",regionCode: "QJ" }, { path: "opt-in",mode: "subscription",regionCode: "QK" },
  { path: "addon",mode: "subscription",regionCode: "QL" },
  { path: "sized",mode: "subscription",regionCode: "QM",missingHead: true,control: false },
  { path: "sized",mode: "subscription",regionCode: "QN",missingHead: true,control: true },
  { path: "opt-in",mode: "subscription",regionCode: "QO",missingHead: true,control: false },
  { path: "opt-in",mode: "subscription",regionCode: "QP",missingHead: true,control: true },
] as const)("LC6-D-118 configured quote read fixes the $path head at pricing time in $mode ($regionCode)", async (row,context) => {
  const { path,mode,regionCode } = row;
  const present = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
  if (!present) { context.skip("Membership page comes from the predecessor installation"); return; }
  const addon = path === "addon", f = await fixture(packs[0],addon ? { sku: { isAddon: true } } : {});
  const account = addon ? await fixture(packs[1]) : f, price = f.admission.priceContextVersions[0];
  const sized = path === "sized" || path === "opt-in" || addon, quantity = path === "sized" ? 3 : 2;
  const offerVersion = sized ? "sized.v1" : "classic", templateVersion = path === "sized" || addon ? 2 : 1;
  if (templateVersion === 2) {
    const db = await runtime.connect();
    try { expect(await (await edit(account,"sized")).invoke(db)).toMatchObject({ status: "applied",templateVersion }); }
    finally { db.release(); }
  }
  const priceListId = account.admission.priceContextVersions[0].priceListId;
  if (addon) await pool.query("UPDATE public.price_entries SET price_list_id=$2 WHERE id=$1", [price.entryId,priceListId]);
  await pool.query("UPDATE public.price_lists SET region_code=$2 WHERE id=$1", [priceListId,regionCode]);
  await pool.query("UPDATE public.price_entries SET mode='one_time',unit_price_minor=$2 WHERE id=$1", [price.entryId,mode === "one_time" ? 617 : 700]);
  if (mode === "subscription") await pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'subscription',617,$3::timestamptz-interval '1 day')",
    [priceListId,f.sku,f.at]);
  const options = {
    async verifyDocument(document: unknown, envelope: { documentRevision: { digest: string } }) {
      expect(digest(canonicalCatalogDraftJson(document))).toBe(envelope.documentRevision.digest);
    },
    governedOffer: { offerVersion,mode,
      async withSnapshot<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) {
        const db = await runtime.connect();
        try { await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const result = await work(db); await db.query("COMMIT"); return result; }
        catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
      },
    },
  };
  const tax = { included: true,country: "ZZ",category: "standard",vatRateBps: 0,legalBasis: "Synthetic tax" } as const;
  const engine = createDbBackedCommerceQuotePort({ quoteCatalogReadPort: createPostgresCommerceQuoteCatalogReadPort(runtime,options),
    isStrictD1Quote: true,commercePriceAuthorityPort: createPostgresCommercePriceAuthorityPort(runtime),
    taxProfile: tax,supportedTaxProfiles: [tax],regionCode,currency: "XXX",now: () => f.at,hasPromotionCodePort: false,
    resolveAutomaticQuotePromotions: async () => ({ discounts: [],codeRejections: [] }),
    applyPromotionCodesV2: async () => ({ discounts: [],codeRejections: [],codeRejectionDetails: [] }),
    lineContext: () => ({}),quoteContext: input => () => ({ mode: input.mode,cadenceDays: input.cadenceDays,promoCodes: input.promoCodes,offerVersion }),
  });
  const priced = await engine.createServerAuthoritativeQuote({ mode,cadenceDays: 28,promoCodes: [],lines: [{ sku: f.code,quantity }] });
  expect(priced.quote.lines[0].catalogFacts).toMatchObject({
    publication: { productId: f.product,skuRevisionId: f.reference.skuRevisionId,head: f.head },
  });
  const port = createPostgresAcquisitionCheckoutPersistence(runtime,{ regionCode,isAcquisitionDiscount: () => false,
    financialPolicy: { facts: () => ({ regionCodes: [],metadataPresent: false }) } as never });
  if (path === "checkout") await expect(port.captureCatalogAdmission(priced)).resolves.toMatchObject({ heads: f.admission.heads,mode });
  const change = structuredClone(f.value), member = { skuCode: f.code,offerVersion: "example:added",admitted: false };
  change.product.sharedContent = { ...change.product.sharedContent,catalogAction: "revise",offerMemberships: [member] };
  change.publication.operations = [{ op: "set_offer_membership",...member }];
  const advanceHead = async () => {
    const writer = await pool.connect();
    try {
      const next = await candidate(writer,change,f.draft,1,f.head), result = await next.authority.publish(next.publication,next.actor);
      expect(result).toMatchObject({ outcome: "committed",receipt: { head: { revision: f.head.revision+1,documentDigest: f.head.documentDigest } } });
    } finally { writer.release(); }
  };
  if (path === "checkout") {
    await advanceHead();
    await expect(port.captureCatalogAdmission(priced)).rejects.toMatchObject({ code: "40001",message: "catalog_publication_head_moved" });
    return;
  }
  const actor = { actorId: account.actor,clientId: account.client };
  let publishAfterPricing = false, quoteCalls = 0;
  const quotePort = { async createServerAuthoritativeQuote(input: Parameters<typeof engine.createServerAuthoritativeQuote>[0]) {
    quoteCalls++;
    const current = await engine.createServerAuthoritativeQuote(input);
    if (publishAfterPricing && input.lines[0]?.quantity === quantity) {
      publishAfterPricing = false;
      await advanceHead();
    }
    return current;
  } };
  async function withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) {
    const db = await runtime.connect();
    try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  let preview: () => Promise<{ quoteHash?: string }>, apply: (hash: string) => Promise<{ status: string }>;
  if (sized) {
    const earlierQuantity = templateVersion;
    const earlier = addon ? governedCheckoutQuote(account,"subscription").quote.lines[0] : (await engine.createServerAuthoritativeQuote({
      mode: "subscription",cadenceDays: 28,promoCodes: [],lines: [{ sku: f.code,quantity: earlierQuantity }],
    })).quote.lines[0];
    await pool.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
      VALUES($1,'subscription.starter_graduated',$2,$3,$4::timestamptz+interval '1 microsecond')`, [account.subscription,randomUUID(),{ linePricing: [
      { sku: account.code,quantity: earlierQuantity,unitAmountMinor: 617,isAddon: false,quoteLine: earlier },
    ] },account.at]);
    const editor = createPostgresSizedEditor({ quotePort,now: () => f.at,withTransaction,
      policy: { minimumCoreUnits: 1,maximumCoreLines: 3,maximumAddonLines: 3,maximumQuantity: 99,allowedCadences: [28],
        maximumExclusions: 8,maximumCatalogExclusions: 16,fixedThroughCycle: 2,graduationCycle: 3,
        portionModes: { full: { mode: "full",factor: 1 },reduced: { mode: "reduced",factor: 0.5 } } },
      async readFacts(_db,owned) { return { subscriptionId: owned.subscriptionId,clientId: owned.clientId,subjectRef: account.subscription,exclusions: [],snapshot: { basis: templateVersion } }; },
      async resolveOptInNeed() { return { dailyNeed: 1,snapshot: { dailyNeed: 1 } }; },
      async readCatalog(db) {
        const { rows } = await db.query(`SELECT s.id,s.sku,s.product_id,s.net_weight_g,s.is_addon,s.sellable_in_subscription,
          p.publication_facts#>>'{document,id}' AS document_id,p.publication_facts#>>'{document,digest}' AS document_digest
          FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id WHERE s.id=ANY($1::uuid[])`, [[f.sku,account.sku]]);
        return rows.map(standing => ({ variantId: String(standing.id),sku: String(standing.sku),groupId: String(standing.product_id),
          isAddon: standing.is_addon === true,sellable: standing.sellable_in_subscription === true,physicalSize: Number(standing.net_weight_g),demandPerUnit: 28,
          documentRevisionId: String(standing.document_id),documentDigest: String(standing.document_digest),verified: true,exclusions: [],sellableNow: standing.is_addon ? null : 100 }));
      },
      async assertCurrentFacts(_db,owned,expected,need,catalog) {
        expect(expected.clientId).toBe(owned.clientId);
        expect(catalog.map(fact => fact.variantId)).toEqual([f.sku]);
        expect(need).toEqual(path === "opt-in" ? { dailyNeed: 1 } : null);
      },
      proposePortion: async ({ current }) => current.map(({ variantId,qty }) => ({ variantId,qty })),
    });
    const request = addon ? { subscriptionId: account.subscription,action: "add_addon" as const,variantId: f.sku,qty: quantity }
      : { subscriptionId: f.subscription,action: "resize_bundle" as const,cadenceDays: 28,compositionConstraint: { kind: "unit_count",value: quantity,dailyNeed: 1 },
      resizeLever: { kind: "subscription.sized.parcel" as const,value: { coreLines: [{ variantId: f.sku,qty: quantity }],...(path === "opt-in" ? { optInToSized: true as const } : {}) } } };
    preview = () => editor.preview(actor,request);
    apply = hash => editor.apply(actor,randomUUID(),{ ...request,acceptedQuoteHash: hash,expectedTemplateVersion: templateVersion });
  } else {
    const editor = createPostgresPackageEditor({ quoteCatalogReadPort: createPostgresCommerceQuoteCatalogReadPort(runtime,options),quotePort,withTransaction,
      now: () => f.at,limits: { maximumPlanDays: 90,maximumBaseLines: 3,maximumAddonLines: 3,maximumQuantity: 99 },
      constraintMapper: { toCore: stored => ({ kind: "configured",version: 1,data: stored ?? {} }),fromCore: value => value.data,nominalPlanDays: () => null },
      compositionRulesPort: { validateComposition: async () => ({ ok: true }),
        resizeComposition: async input => ({ coreLines: input.coreLines.map(line => ({ ...line,qty: quantity })),constraint: input.constraint }) },
    });
    const request = path === "exact" ? { subscriptionId: f.subscription,action: "update_plan_length" as const,planDays: 30 }
      : { subscriptionId: f.subscription,planDays: 28,base: [{ variantId: f.sku,qty: quantity }],addons: [] };
    preview = () => editor.preview(actor,request);
    apply = hash => editor.apply(actor,randomUUID(),{ ...request,acceptedQuoteHash: hash,expectedTemplateVersion: templateVersion });
  }
  const old = await preview();
  expect(old.quoteHash).toMatch(/^[a-f0-9]{64}$/u);
  if ("missingHead" in row) {
    const original = (await pool.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1 RETURNING *", [f.product])).rows[0];
    expect(original).toBeDefined();
    const before = await snapshot(), priorCalls = quoteCalls;
    const restore = row.control ? await hook("public.catalog_admission_check_sized_preview(uuid,uuid,uuid,text,text,integer,text,boolean,timestamptz)",
      "DECLARE s public.subscriptions; q jsonb;","",body => body.replace(/ PERFORM public\.catalog_admission_accept\([\s\S]+?;/u,"")) : undefined;
    try {
      const refused = await tracked(apply(old.quoteHash!));
      if (row.control) {
        expect(refused).toMatchObject({ ok: false });
        if (!refused.ok) expect(refused.error).not.toMatchObject({ message: "customer_self_service_invalid_catalog_head" });
        expect(quoteCalls).toBeGreaterThan(priorCalls);
      } else {
        expect(refused).toMatchObject({ ok: false,error: { code: "55000",message: "customer_self_service_invalid_catalog_head" } });
        if (!refused.ok) expect(mapSizedEditError(refused.error,"apply")).toMatchObject({ status: 409,code: "CONFLICT",reason: "customer_self_service_invalid_catalog_head" });
        expect(quoteCalls).toBe(priorCalls);
      }
      expect(await snapshot()).toEqual(before);
    } finally {
      await restore?.();
      await pool.query("INSERT INTO public.catalog_publication_heads SELECT * FROM jsonb_populate_record(NULL::public.catalog_publication_heads,$1::jsonb)", [original]);
    }
    return;
  }
  publishAfterPricing = true;
  const ledgers = () => pool.query("SELECT quote_hash FROM public.subscription_quote_previews WHERE subscription_id=$1 ORDER BY id", [account.subscription]);
  const before = await ledgers();
  await expect(preview()).rejects.toMatchObject({ code: "40001",message: "catalog_publication_head_moved" });
  expect((await ledgers()).rows).toEqual(before.rows);
  const stale = await tracked(apply(old.quoteHash!));
  expect(stale).toMatchObject({ ok: false,error: { code: "40001",message: "customer_self_service_stale_edit_catalog_head" } });
  if (!stale.ok) expect((sized ? mapSizedEditError : mapPackageEditError)(stale.error,"apply")).toMatchObject({
    status: 409,code: "CONFLICT",reason: "customer_self_service_stale_edit_catalog_head",
  });
  const accepted = await preview();
  expect(accepted.quoteHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(accepted.quoteHash).not.toBe(old.quoteHash);
  await expect(apply(accepted.quoteHash!)).resolves.toMatchObject({ status: "applied",templateVersion: templateVersion+1 });
  const retained = (await pool.query("SELECT catalog_acceptance FROM public.subscription_renewal_terms WHERE subscription_id=$1", [account.subscription])).rows[0].catalog_acceptance;
  expect(retained.schemaVersion).toBe(2);
  expect(retained.lines).toContainEqual(expect.objectContaining({ skuId: f.sku,publicationHead: expect.objectContaining({ revision: f.head.revision+1,documentDigest: f.head.documentDigest }) }));
});

it.each(lanes)("LC6-D-105, LC6-D-108, LC6-D-132 and LC6-D-133 trusted preview evidence in %s", async lane => {
  const f = await fixture(packs[0]);
  const installed = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
  if (!installed) {
    const before = await snapshot();
    await expect(edit(f,lane,true)).rejects.toMatchObject({ message: "catalog_admission_membership_authority_unavailable",code: "55000" });
    expect(await snapshot()).toEqual(before);
    return;
  }
  const command = await edit(f,lane,true), db = await session(), proof = { schemaVersion: 2,lines: [f.reference] };
  const result = await pool.query(lane === "legacy"
    ? "SELECT proposed_lines#>'{0,catalogAdmission}' AS evidence FROM public.subscription_edit_quotes WHERE subscription_id=$1"
    : "SELECT quote_snapshot->'catalogAdmission' AS evidence FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].evidence).toMatchObject({ mode: "subscription",heads: f.admission.heads,skuRevisions: f.admission.skuRevisions,
    priceContextVersions: f.admission.priceContextVersions,purpose: "account" });
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [f.actor,JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    const accepted = await command.invoke(db);
    expect(lane === "legacy" ? accepted.subscriptionAction.status : accepted.status).toBe("applied");
    await db.query("COMMIT");
    expect((await pool.query("SELECT catalog_acceptance FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ catalog_acceptance: proof }]);
    const next = await changedDocument(f), publisher = await pool.connect();
    try { expect((await publishOn(publisher,next.publication)).outcome).toBe("committed"); } finally { publisher.release(); }
    const before = await snapshot();
    await db.query("BEGIN");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [f.actor,JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    const replay = await command.invoke(db);
    expect(lane === "legacy" ? replay.subscriptionAction.status : replay.status).toBe("replayed");
    await db.query("COMMIT");
    expect(await snapshot()).toEqual(before);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

async function seedAdmissionPolicy(db: Pool | PoolClient,f: Fixture,price: CatalogAdmissionInput["priceContextVersions"][number]) {
  const revisionId = randomUUID();
  const base = (await db.query("UPDATE public.price_entries SET mode='one_time' WHERE id=$1 RETURNING to_jsonb(price_entries) AS entry", [price.entryId])).rows[0].entry;
  const authored = (await db.query(`INSERT INTO public.subscription_price_policy_revisions
    (id,revision_no,price_list_id,region_code,currency,channel,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
    SELECT $1,1,$2,'ZZ','XXX','D2C',t,0,1,'FLOOR_TO_QUANTUM',
      public.catalog_price_setup_policy_digest($1,1,$2,'ZZ','XXX','D2C',t,NULL,0,1,'FLOOR_TO_QUANTUM')
    FROM (SELECT $3::timestamptz-interval '2 days' AS t) clock
    RETURNING digest`, [revisionId,price.priceListId,f.at])).rows[0].digest as string;
  const policy = { revisionId,digest: authored };
  Object.assign(price,{ entry: base,policy });
  return policy;
}

it.for((["assertion","port","classic","exact","sized","addon","ordinary-sized"] as const).flatMap(path =>
  (["current","closed","control"] as const).map(state => ({ path,state }))))(
  "LC6-D-072 consults the authored policy and exact base via $path, state=$state", async ({ path,state },context) => {
  const writer = path !== "assertion" && path !== "port";
  if (writer && !(await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present) {
    context.skip("Membership page comes from the predecessor installation"); return;
  }
  const f = await fixture(packs[0],path === "addon" ? { sku: { isAddon: true } } : {});
  const price = f.admission.priceContextVersions[0];
  const baselineSized = path === "addon" || path === "ordinary-sized";
  const policy = baselineSized ? null : await seedAdmissionPolicy(pool,f,price);
  const sizedCommand = baselineSized ? await authoritySizedPath(f,path,f.admission,false,true) : null;
  const command = sizedCommand ?? (writer ? await edit(f,path as Lane,true,policy!) : null);
  const currentPolicy = sizedCommand?.policy ?? policy!;
  if (state !== "current") await pool.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2::timestamptz-interval '1 day' WHERE id=$1", [currentPolicy.revisionId,f.at]);
  const restore = state === "control" ? await hook(catalogAssertionSignature,
    "DECLARE selection jsonb;","",body => {
      const validity = " AND (r.effective_to IS NULL OR r.effective_to>statement_timestamp())";
      expect(body.split(validity)).toHaveLength(2);
      return body.replace(validity,"");
    }) : undefined;
  const db = await session();
  try {
    if (!command) await db.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscription]);
    const input: CatalogAdmissionInput = { ...f.admission,offerEvidence: { offerVersion: "classic",subscriptionId: f.subscription,lane: "classic" } };
    const call = command ? command.invoke(db) : path === "port" ? createPostgresCatalogAdmission().assertCurrent(db,input)
      : rpc(db,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),input.mode,
        input.offerEvidence,JSON.stringify(input.priceContextVersions),input.purpose]);
    if (state !== "current") {
      const refuses = () => expect(call).rejects.toMatchObject({ code: "40001",message: "catalog_admission_price_context_moved" });
      if (state === "control") await expect(refuses()).rejects.toMatchObject({ name: "AssertionError" });
      else await refuses();
    } else if (command) {
      expect(await call).toMatchObject({ status: "applied" });
      expect((await db.query("SELECT quantity,unit_amount_minor FROM public.subscription_renewal_term_lines WHERE subscription_id=$1 AND sku=$2", [sizedCommand?.baseSubscription ?? f.subscription,f.code])).rows)
        .toEqual([{ quantity: 2,unit_amount_minor: "617" }]);
    } else {
      expect(await call).toBe(path === "port" ? undefined : "");
    }
  } finally { await db.query("ROLLBACK"); db.release(); await restore?.(); }
});


it.for([false,true])("LC6-D-072 legacy quote preserves the exact winning price, control=%s", async (control,context) => {
  if (!(await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present) {
    context.skip("Membership page comes from the predecessor installation"); return;
  }
  const f = await fixture(packs[0]), command = await edit(f,"legacy",true), entry = f.admission.priceContextVersions[0];
  await pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    VALUES($1,$2,'subscription',617,statement_timestamp()-interval '1 minute')`, [entry.priceListId,f.sku]);
  const restore = control ? await hook(catalogAssertionSignature,"DECLARE selection jsonb;","",body => {
    const winner = / {2}IF p_offer_evidence->>'lane'='legacy' AND \(public\.catalog_admission_legacy_price[\s\S]*?END IF;/u;
    expect(body.match(winner)).not.toBeNull();
    return body.replace(winner,"");
  }) : undefined;
  const db = await session();
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [f.actor,JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    const applying = command.invoke(db);
    if (control) expect((await applying).subscriptionAction.status).toBe("applied");
    else await expect(applying).rejects.toMatchObject({ code: "40001",message: "catalog_admission_price_context_moved" });
  } finally { await db.query("ROLLBACK"); db.release(); await restore?.(); }
});

it.for((["assertion","port","plain","promoted"] as const).flatMap(path => [false,true].map(control => ({ path,control }))))(
  "LC6-D-072/D-147 strict subscription evidence preserves both entry identities via $path, control=$control", async ({ path,control }) => {
    const f = await fixture(packs[0]), entry = f.admission.priceContextVersions[0], baseId = randomUUID();
    entry.entry = (await pool.query("UPDATE public.price_entries SET mode='subscription' WHERE id=$1 RETURNING to_jsonb(price_entries) AS entry", [entry.entryId])).rows[0].entry;
    const base = (await pool.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from)
     VALUES($1,$2,$3,'one_time',700,$4::timestamptz-interval '1 day') RETURNING to_jsonb(price_entries) AS entry`,
    [baseId,entry.priceListId,f.sku,f.at])).rows[0].entry;
    Object.assign(entry,{ base: { entryId: baseId,entry: base } });
    const input = { ...f.admission,purpose: "order" as const }, purchase = purchaseInput(f);
    const facts = { ...governedCheckoutQuote(f,"subscription").quote.lines[0].catalogFacts,basePriceEntryId: baseId,baseUnitAmountMinor: 700 };
    Object.assign(purchase.quote.quote.lines[0],{ catalogFacts: facts });
    const restore = control ? await hook(catalogAssertionSignature,"DECLARE selection jsonb;","",body => {
      const predicate = "IF price_context ? 'base' AND (";
      expect(body.split(predicate)).toHaveLength(2);
      return body.replace(predicate,"IF false AND (");
    }) : undefined;
    const db = await session();
    try {
      const assertEntry = () => path === "port" ? createPostgresCatalogAdmission().assertCurrent(db,input)
        : path === "assertion" ? rpc(db,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),
          input.mode,input.offerEvidence,JSON.stringify(input.priceContextVersions),input.purpose])
          : rpc(db,path === "plain" ? "commerce_create_order_draft_with_outbox" : "commerce_create_promoted_order_draft_with_outbox",purchase.args);
      await db.query("SAVEPOINT positive_base");
      if (path === "port" || path === "assertion") await assertEntry();
      else expect(await assertEntry()).toMatchObject({ orderDraft: { replayed: false } });
      await db.query("ROLLBACK TO SAVEPOINT positive_base");
      await db.query("UPDATE public.price_entries SET valid_to=statement_timestamp()-interval '1 second' WHERE id=$1", [baseId]);
      await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
        VALUES($1,$2,'one_time',700,statement_timestamp())`, [entry.priceListId,f.sku]);
      if (control) await assertEntry();
      else await expect(assertEntry()).rejects.toMatchObject({ code: "40001",message: "catalog_admission_price_context_moved" });
    } finally { await db.query("ROLLBACK"); db.release(); await restore?.(); }
  },
);

it.each(["assertion","port"] as const)("LC6-D-147 an eligible nonwinner is refused via %s", async path => {
  const f = await fixture(packs[0]), input = { ...f.admission,purpose: "order" as const }, db = await session();
  try {
    await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
      VALUES($1,$2,'subscription',617,statement_timestamp()-interval '1 second')`, [input.priceContextVersions[0].priceListId,f.sku]);
    const result = path === "port" ? createPostgresCatalogAdmission().assertCurrent(db,input)
      : rpc(db,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),input.mode,
        input.offerEvidence,JSON.stringify(input.priceContextVersions),input.purpose]);
    await expect(result).rejects.toMatchObject({ code: "40001",message: "catalog_admission_price_context_moved" });
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it.each((["assertion","port"] as const).flatMap(path =>
  (["none","current","closed","duplicate","orphan","withdrawn","missing proof","missing proof control"] as const).map(change => ({ path,change }))))(
  "LC6-D-151 retained price consultation $change via $path", async ({ path,change }) => {
    const f = await fixture(packs[0]), input = structuredClone(f.admission), setup = await pool.connect();
    try {
      expect(await (await edit(f,"sized")).invoke(setup)).toMatchObject({ status: "applied" });
    } finally { setup.release(); }
    if (change === "withdrawn") {
      const value = structuredClone(f.value); value.product.sharedContent.catalogAction = "revise";
      value.publication.operations = [{ op: "set_product_lifecycle",productSlug: value.product.slug!,expectedState: "active",state: "withdrawn",
        children: [{ skuCode: f.code,expectedState: "active" }] }];
      const author = await pool.connect();
      try { const next = await candidate(author,value,f.draft,1,f.head); expect(await next.authority.publish(next.publication,next.actor)).toMatchObject({ outcome: "committed" }); }
      finally { author.release(); }
    }
    const proofRemoved = change === "missing proof" || change === "missing proof control";
    const restore = change === "missing proof control" ? await hook(catalogAssertionSignature,"DECLARE selection jsonb;","",body => {
      const guard = "retained IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained->'lines') l WHERE l=reference)";
      expect(body.split(guard)).toHaveLength(2);
      return body.replace(guard,"false");
    }) : undefined;
    const db = await session(), price = input.priceContextVersions[0];
    Object.assign(input,{ heads: [],priceContextVersions: [],skuRevisions: [{ reference: f.reference,quantity: 1 }],
      offerEvidence: { offerVersion: "sized.v1",subscriptionId: f.subscription,lane: "sized" },
      ...(change === "none" || change === "withdrawn" || proofRemoved ? {} : { retainedPriceContextVersions: [price] }) });
    if (change === "duplicate") Object.assign(input,{ retainedPriceContextVersions: [price,price] });
    if (change === "orphan") Object.assign(input,{ retainedPriceContextVersions: [{ ...price,skuId: randomUUID() }] });
    try {
      await db.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscription]);
      if (proofRemoved) await db.query("UPDATE public.subscription_renewal_terms SET catalog_acceptance=NULL WHERE subscription_id=$1", [f.subscription]);
      if (change === "closed") price.entry = (await db.query(
        "UPDATE public.price_entries SET valid_to=statement_timestamp()-interval '1 minute' WHERE id=$1 RETURNING to_jsonb(price_entries) AS entry",
        [price.entryId])).rows[0].entry;
      const call = path === "port" ? createPostgresCatalogAdmission().assertCurrent(db,input)
        : rpc(db,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),input.mode,
          JSON.stringify({ ...input.offerEvidence,retainedPriceContextVersions: input.retainedPriceContextVersions }),
          JSON.stringify(input.priceContextVersions),input.purpose]);
      if (change === "missing proof") await expect(call).rejects.toMatchObject({ code: "22023",message: "catalog_retained_revision_unavailable" });
      else if (change === "closed") await expect(call).rejects.toMatchObject({ code: "40001",message: "catalog_admission_price_context_moved" });
      else if (change === "duplicate" || change === "orphan") await expect(call).rejects.toMatchObject({ code: "22023",message: "catalog_admission_price_context_required" });
      else expect(await call).toBe(path === "port" ? undefined : "");
    } finally { await db.query("ROLLBACK"); db.release(); await restore?.(); }
  });

const membershipPages = [
  { name: "complete selection across pages", pages: 4,lane: "classic",allowed: true },
  { name: "sized selection past item 500", pages: 5,lane: "sized",allowed: true },
  { name: "roster beyond 500", pages: 5,lane: "classic",allowed: false,predicate: "OR cardinality(seen_ids)+jsonb_array_length(page->'items')>maximum_members" },
  { name: "sized roster beyond 1000", pages: 10,lane: "sized",allowed: false,predicate: "OR cardinality(seen_ids)+jsonb_array_length(page->'items')>maximum_members" },
  { name: "cursor with a short page", pages: 0,lane: "classic",allowed: false,predicate: "jsonb_array_length(page->'items')<>page_limit\n    OR " },
] as const;
describe.each(membershipPages)("LC6-D-091 and LC6-D-097 $name", row => {
  const cases = [{ control: false }, ...("predicate" in row ? [{ control: true }] : [])];
  for (const { control } of cases) it(control ? "removal fails the precise witness" : "native preview", async context => {
    const installed = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
    if (!installed) { context.skip("Membership page comes from the predecessor installation"); return; }
    const f = await fixture(packs[0]);
    // Keep the installed page's digest and its final real rows. Prefix sorted
    // protocol rows to exercise continuation without publishing hundreds of SKUs.
    const extension = row.pages === 0 ? `
    page:=jsonb_set(page,'{nextCursor}',page#>'{items,-1,skuId}');` : `
    IF cardinality(seen_ids)<${row.pages * 100} THEN
     page:=page||jsonb_build_object('items',(
      SELECT jsonb_agg(jsonb_build_object('skuId','00000000-0000-0000-0000-'||lpad(n::text,12,'0'),
       'skuCode','PAGE-WITNESS-'||n,'sellableInSubscription',true) ORDER BY n)
      FROM generate_series(cardinality(seen_ids)+1,cardinality(seen_ids)+100) n),
     'nextCursor','00000000-0000-0000-0000-'||lpad((cardinality(seen_ids)+100)::text,12,'0'));
    END IF;`;
    const restore = await hook("public.catalog_admission_members(text,text,uuid[],boolean)",membershipReadBoundary,extension,body => {
      if (!control || !("predicate" in row)) return body;
      expect(body.split(row.predicate)).toHaveLength(2);
      return body.replace(row.predicate,"");
    });
    try {
      if (row.allowed) {
        await edit(f,row.lane,true);
        const { evidence } = (await pool.query("SELECT quote_snapshot->'catalogAdmission' AS evidence FROM public.subscription_quote_previews WHERE subscription_id=$1", [f.subscription])).rows[0];
        expect(evidence.skuRevisions).toEqual(f.admission.skuRevisions);
      } else {
        const before = await snapshot();
        const refuses = async () => expect(edit(f,row.lane,true)).rejects.toMatchObject({ code: "55000",message: "catalog_admission_membership_authority_unavailable" });
        if (control) await expect(refuses()).rejects.toMatchObject({ name: "AssertionError" });
        else { await refuses(); expect(await snapshot()).toEqual(before); }
      }
    } finally { await restore(); }
  });
});

it("F6 subscription precedes its owned preview, with the old-order cycle control", async () => {
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
    expect(first.result.ok).toBe(false); if (!first.result.ok) expect(first.result.error).toMatchObject({ code: "40P01" });
    await first.db.query("ROLLBACK"); const results = await Promise.all([taking,editing]);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    await t2.query("ROLLBACK"); await e2.query("ROLLBACK");
  } finally { await stop.release(); await restoreTake(); await restore(); await t2.query("ROLLBACK"); await e2.query("ROLLBACK"); t2.release(); e2.release(); h.release(); }
});

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

const admissionSignature = "public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text)";
const writerAdmissionSignature = "public.catalog_admission_accept(jsonb,jsonb,text,jsonb,text)";
const sharedBoundary = "PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0));";
async function payment(f: Fixture) {
  const cycle = randomUUID(), order = randomUUID();
  await pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3::timestamptz-interval '28 days','planned')", [cycle,f.subscription,f.at]);
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
describe.each(packs.flatMap(pack => lanes.flatMap(lane => ["provider", "settlement"].map(rail => ({ pack,lane,rail })))))("F1 $pack $lane $rail", ({ pack,lane,rail }) => {
 it("lock_matrix_races_native_payment_settlement", async () => {
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
 });
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
it.each(["provider", "settlement"])("F2 payment owns the subscription before the edit acquires any catalogue guard: %s", async rail => {
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
it("F4 control: removing only the guarded head comparison loses the stale-head refusal", async () => {
  const f = await fixture(packs[0]), command = await edit(f), next = await changedDocument(f), h = await pool.connect(), w = await pool.connect(), e = await session();
  const stop = await gate(h), wp = await pid(w), ep = await pid(e), hp = await pid(h); let reached = false, restore = async () => {};
  try {
    restore = await hook(admissionSignature,sharedBoundary,"",body => {
      const mutant = body.replace(/ IF EXISTS\(SELECT 1 FROM jsonb_array_elements\(p_heads\) h WHERE h->'head' IS DISTINCT FROM actual_heads->\(h->>'productId'\)\) THEN\n {2}RAISE EXCEPTION '%',moved USING ERRCODE='40001'; END IF;/u,"");
      expect(mutant).not.toBe(body); return mutant;
    });
    const publishing = tracked(publishOn(w,next.publication,async (sql,values) => {
      if (!reached && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0]===`catalog-lineage:${f.product}`) {
        reached = true; await w.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await w.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]);
      }
    }));
    await blocker(h,wp,hp); const editing = tracked(command.invoke(e)); await blocker(h,ep,wp); await stop.release();
    const written = await publishing; if (!written.ok) throw written.error; expect(written.value.outcome).toBe("committed");
    const result = await editing;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: "55000",message: "customer_self_service_invalid_offer_membership" });
    await e.query("ROLLBACK");
  } finally { await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); await restore(); e.release(); w.release(); h.release(); }
});
async function assertBusy(result: unknown, before: Record<string, unknown>) {
  expect(result).toMatchObject({ outcome: "conflict",reason: "catalog_publication_busy" });
  expect(await snapshot()).toEqual(before);
}
it.each(packs.flatMap(pack => lanes.map(lane => ({ pack,lane }))))("F5 edit excludes publication with donor busy refusal, then publisher retry succeeds $pack $lane", async ({ pack,lane }) => {
  const f = await fixture(pack), command = await edit(f,lane), next = await changedDocument(f);
  const h = await pool.connect(), e = await session(), w = await pool.connect(), stop = await gate(h);
  const ep = await pid(e), hp = await pid(h); let restore = async () => {};
  try {
    await e.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    restore = await hook(writerAdmissionSignature,sharedBoundary,stop.sql);
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
});
it("F5 control: removing only the edit shared guard lets the publisher proceed", async () => {
  const f = await fixture(packs[0]), command = await edit(f), next = await changedDocument(f);
  const h = await pool.connect(), e = await session(), w = await pool.connect(), stop = await gate(h);
  const ep = await pid(e), hp = await pid(h); let restore = async () => {};
  try {
    const boundary = "BEGIN\n";
    restore = await hook(writerAdmissionSignature,boundary,stop.sql,body => {
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

it.each(["not consulted","consulted","closed"] as const)(
  "sized retained reduction survives withdrawal while increased demand refuses, LC6-D-151 price %s", async priceMode => {
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
      const retainedPriceContextVersions = quantity === 1 && priceMode !== "not consulted" ? f.admission.priceContextVersions : [];
      const evidence = { lines: [line],cadenceDays: 28,compositionConstraint: constraint,subjectFacts: { revision: 1 },optInFacts: null,
        catalogAdmission: { ...f.admission,heads: quantity === 1 ? [] : [{ productId: f.product,head }],priceContextVersions: quantity === 1 ? [] : f.admission.priceContextVersions,
          retainedPriceContextVersions,skuRevisions: [{ reference: f.reference,quantity }] } };
      await rpc(pool,"subscription_quote_preview_record",[f.actor,f.client,f.subscription,request.action,hash,2,
        (await pool.query("SELECT $1::timestamptz+interval '1 hour' AS at", [f.at])).rows[0].at,
        Object.fromEntries(Object.entries(request).filter(([name]) => !["expectedTemplateVersion","acceptedQuoteHash"].includes(name))),evidence,{},f.at]);
      if (quantity === 1 && priceMode === "closed") await pool.query("UPDATE public.price_entries SET valid_to=statement_timestamp()-interval '1 minute' WHERE id=$1", [f.admission.priceContextVersions[0].entryId]);
      const before = await snapshot(), db = await session();
      try {
        const applying = rpc(db,"subscription_sized_edit_apply",[f.actor,f.client,key,f.subscription,{ ...request,request,...evidence },f.at]);
        if (quantity===3) { await expect(applying).rejects.toMatchObject({ code: "55000",message: "customer_self_service_invalid_offer_membership" }); await db.query("ROLLBACK"); expect(await snapshot()).toEqual(before); }
        else if (priceMode === "closed") {
          await expect(applying).rejects.toMatchObject({ code: "40001",message: "catalog_admission_price_context_moved" });
          await db.query("ROLLBACK"); expect(await snapshot()).toEqual(before);
        } else { expect(await applying).toMatchObject({ status: "applied",templateVersion: 3 }); await db.query("COMMIT"); }
      } finally { await db.query("ROLLBACK"); db.release(); }
    }
    expect((await pool.query("SELECT quantity,unit_price_minor,catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ quantity: priceMode === "closed" ? 2 : 1,unit_price_minor: "617",catalog_sku_revision_id: f.reference.skuRevisionId }]);
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
async function admissionCase(row: AdmissionRow & { port?: boolean }) {
  const f = await fixture(packs[0],row.standing); await row.before?.(f); const db = await session();
  const input: CatalogAdmissionInput = { ...structuredClone(f.admission),heads: structuredClone(f.admission.heads),purpose: row.account ? "account" : "order",
    offerEvidence: { offerVersion: "classic",...(row.account ? { subscriptionId: f.subscription,lane: "classic" as const } : {}) } };
  let before: Record<string, unknown> | undefined;
  try {
    await db.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscription]);
    await row.change(db,f,input); before = await snapshot();
    const call = row.port ? createPostgresCatalogAdmission().assertCurrent(db,input)
      : rpc(db,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),input.mode,
        JSON.stringify(input.offerEvidence),JSON.stringify(input.priceContextVersions),input.purpose]);
    if (row.message === null) expect(await call).toBe(row.port ? undefined : "");
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
  { name: "selections-array",message: orderRefused,change: (_d,_f,i) => { Object.assign(i,{ skuRevisions: null }); } },
  { name: "heads-count",message: orderAnchor,change: (_d,f,i) => { Object.assign(i,{ heads: [...i.heads,...Array.from({ length: 100 },() => ({ productId: randomUUID(),head: f.head }))] }); } },
  { name: "mode-null",message: orderRefused,change: (_d,_f,i) => { Object.assign(i,{ mode: null }); } },
  { name: "mode-enum",message: orderRefused,change: (_d,_f,i) => { Object.assign(i,{ mode: "renewal" }); } },
  { name: "offer-object",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ offerEvidence: [] }); } },
  { name: "offer-required",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ offerEvidence: {} }); } },
  { name: "prices-array",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ priceContextVersions: null }); } },
  { name: "prices-cap",message: orderAnchor,change: async (_d,_f,i) => { const b = await fixture(packs[1]); Object.assign(i,{ priceContextVersions: [...i.priceContextVersions,...Array.from({ length: 100 },() => b.admission.priceContextVersions[0])] }); } },
  { name: "selection-object",message: orderRefused,change: (_d,_f,i) => { Object.assign(i,{ skuRevisions: [1] }); } },
  { name: "selection-keys",message: orderRefused,change: (_d,_f,i) => { Object.assign(i.skuRevisions[0],{ extra: true }); } },
  { name: "reference-object",message: orderRefused,change: (_d,_f,i) => { Object.assign(i.skuRevisions[0],{ reference: [] }); } },
  { name: "quantity-number",message: orderRefused,change: (_d,_f,i) => { Object.assign(i.skuRevisions[0],{ quantity: "2" }); } },
  { name: "quantity-positive",message: orderRefused,change: (_d,_f,i) => { Object.assign(i.skuRevisions[0],{ quantity: 0 }); } },
  { name: "unique-skus",message: orderRefused,change: (_d,_f,i) => { Object.assign(i,{ skuRevisions: [i.skuRevisions[0],i.skuRevisions[0]] }); } },
  { name: "unique-products",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i,{ heads: [i.heads[0],i.heads[0]] }); } },
  { name: "sku-present",message: orderRefused,code: "55000",change: (_d,_f,i) => { Object.assign(i.skuRevisions[0].reference,{ skuId: randomUUID() }); } },
  { name: "product-present",message: null,change: () => {} },
  { name: "sku-v3",message: "catalog_propagation_head_unreadable",code: "55000",change: (d,f) => scopedFacts(d,f,"catalog_skus",{ schemaVersion: 2 }) },
  { name: "product-v3",message: "catalog_propagation_head_unreadable",code: "55000",standing: { product: { schemaVersion: 2 },sku: { memberships: [{ offerVersion: "example:unreadable",admitted: true }] } },change: () => {} },
  { name: "head-present",message: "catalog_propagation_head_unreadable",code: "55000",change: async (d,f) => { await d.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [f.product]); } },
  { name: "expected-present",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i.heads[0],{ productId: randomUUID() }); } },
  { name: "head-keys",message: orderAnchor,change: (_d,_f,i) => { Object.assign(i.heads[0].head,{ extra: true }); } },
  { name: "head-id",message: headMoved,code: "40001",change: (_d,_f,i) => { Object.assign(i.heads[0].head,{ publicationId: randomUUID() }); } },
  { name: "head-revision",message: headMoved,code: "40001",change: (_d,_f,i) => { Object.assign(i.heads[0].head,{ revision: 99 }); } },
  { name: "head-digest",message: headMoved,code: "40001",change: (_d,_f,i) => { Object.assign(i.heads[0].head,{ documentDigest: "0".repeat(64) }); } },
  { name: "product-current",message: "catalog_propagation_head_unreadable",code: "55000",change: (d,f) => scopedFacts(d,f,"catalog_products",{ extra: true }) },
  { name: "reference-head",message: orderRefused,code: "55000",change: laterHead },
  { name: "revision-current",message: null,change: () => {} },
  { name: "sku-lifecycle",message: orderRefused,code: "55000",standing: { sku: { lifecycleState: "withdrawn" } },change: () => {} },
  { name: "product-lifecycle",message: orderRefused,code: "55000",standing: { product: { lifecycleState: "withdrawn" } },change: () => {} },
  { name: "sku-active",message: orderRefused,code: "55000",standing: { sku: { status: "draft" } },change: () => {} },
  { name: "product-active",message: orderRefused,code: "55000",standing: { product: { status: "draft" } },change: () => {} },
  { name: "standalone",message: orderRefused,code: "55000",standing: { sku: { sellableStandalone: false } },change: (_d,_f,i) => { i.mode = "one_time"; } },
  { name: "subscription-sellable",message: orderRefused,code: "55000",standing: { sku: { sellableInSubscription: false } },change: () => {} },
  { name: "offer-membership",message: orderRefused,code: "55000",change: (_d,_f,i) => { i.offerEvidence.offerVersion = "unadmitted"; } },
];
it.each(boundaryRows)("admission A1 $name", admissionCase);
it.each(boundaryRows.filter(row => ["code-boundary","mode-null","mode-enum","sku-present","selection-object","head-keys"].includes(row.name))
  .map(row => ({ ...row,port: true })))("admission port A1 $name", admissionCase);
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
it.each(priceRows.map(row => ({ ...row,port: true })))("admission port A8 $name", admissionCase);
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
  await db.query(`WITH purchased AS (
    INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'paid','XXX',617) RETURNING id
  ) INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
    SELECT id,$3,1,1,617,617 FROM purchased`, [order,f.client,f.sku]);
  const amount = money(2468);
  const quoteLine = { sku: f.code,productSlug: f.value.product.slug,quantity: 4,unitPriceGross: money(617),lineSubtotalGross: amount,
    tax: { included: true,country: "ZZ",category: "standard",vatRateBps: 0,legalBasis: "Synthetic tax",netAmount: amount,vatAmount: money(0),grossAmount: amount } };
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

it.each(["missing","present"] as const)("LC6-D-067 legacy governed edit renewal terms: %s", async terms => {
  const f = await fixture(packs[0]), command = await edit(f,"legacy"), db = await pool.connect();
  try {
    if (terms === "missing") await db.query("DELETE FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscription]);
    const before = terms === "missing" ? await snapshot() : undefined;
    await db.query("BEGIN");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [f.actor,JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    if (terms === "missing") {
      await expect(command.invoke(db)).rejects.toMatchObject({ message: "subscription_command_renewal_terms_missing",code: "22023" });
      await db.query("ROLLBACK");
      expect(await snapshot()).toEqual(before);
    } else {
      expect((await command.invoke(db)).subscriptionAction.status).toBe("applied");
      await db.query("COMMIT");
      expect((await db.query(`SELECT t.catalog_acceptance,l.sku,l.quantity,l.unit_amount_minor
        FROM public.subscription_renewal_terms t JOIN public.subscription_renewal_term_lines l USING(subscription_id)
        WHERE t.subscription_id=$1`, [f.subscription])).rows).toEqual([{
        catalog_acceptance: { schemaVersion: 2,lines: [f.reference] },sku: f.code,quantity: 2,unit_amount_minor: "617",
      }]);
    }
  } finally { await db.query("ROLLBACK"); db.release(); }
});

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
      i.offerEvidence.offerVersion = "unadmitted";
      if (name === "graduation-marker" || name === "retained-proof") {
        Object.assign(i,{ heads: [],priceContextVersions: [] });
      }
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
    const boundary = "jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane','classic','optIn',false),'account');";
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

it.each((["boundary-before-barrier","barrier-before-evidence"] as const).flatMap(name =>
  (["assertion","port"] as const).map(path => ({ name,path }))))("admission order $name via $path", async ({ name,path }) => {
  const f = await fixture(packs[0]), next = await changedDocument(f), h = await pool.connect(), w = await pool.connect(), e = await session(), stop = await gate(h);
  const ep = await pid(e), wp = await pid(w), hp = await pid(h); let finished = false, reached = false;
  const publishing = tracked(publishOn(w,next.publication,async (sql,values) => {
    if (!reached && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0]===`catalog-lineage:${f.product}`) {
      reached = true; await w.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await w.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]);
    }
  }));
  try {
    await blocker(h,wp,hp);
    const purpose = name === "boundary-before-barrier" ? "invalid" as CatalogAdmissionInput["purpose"] : "order";
    const input: CatalogAdmissionInput = { ...f.admission,purpose,heads: [] };
    const assert = () => path === "port" ? createPostgresCatalogAdmission().assertCurrent(e,input)
      : rpc(e,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),input.mode,input.offerEvidence,
        JSON.stringify(input.priceContextVersions),input.purpose]);
    const call = tracked(assert().finally(() => { finished = true; }));
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
    expect(finished,"lineage is checked after catalogue acquisition").toBe(false);
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
    await setup.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) SELECT price_list_id,$2,'any',617,clock_timestamp()-interval '1 day' FROM public.subscriptions WHERE id=$1", [old.subscription,target.sku]);
    await setup.query("COMMIT");
  } finally { await setup.query("ROLLBACK"); setup.release(); }
  const f = { ...old,sku: target.sku,code: target.code,admission: target.admission };
  if (lane === "legacy") Object.assign(f,{ admission: undefined });
  const command = await edit(f,lane);
  if (lane !== "legacy") await pool.query("UPDATE public.subscription_quote_previews SET quote_snapshot=quote_snapshot-'catalogAdmission' WHERE subscription_id=$1", [f.subscription]);
  const before = await snapshot(), db = await session();
  try {
    const native = route === "retained" ? old : target;
    if (route !== "sku") await scopedFacts(db,native,"catalog_skus",{ schemaVersion: 2 });
    if (route !== "product") await scopedFacts(db,native,"catalog_products",{ schemaVersion: 2 });
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    await expect(command.invoke(db)).rejects.toMatchObject({ message: route === "retained" ? accountAnchor : "catalog_propagation_head_unreadable",code: route === "retained" ? "22023" : "55000" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await snapshot()).toEqual(before);
});
it.each(["plain-sku","plain-product","promoted-sku","promoted-product"])("admission route %s", async name => {
  const f = await fixture(packs[0]), p = purchaseInput(f), db = await session(), before = await snapshot();
  delete (p.quote as Partial<typeof p.quote>).catalogAdmission;
  // The promoted wrapper owns this refusal before the inner plain mode guard.
  if (name.startsWith("promoted")) p.draft.context.mode = "invalid";
  try {
    await scopedFacts(db,f,name.endsWith("sku") ? "catalog_products" : "catalog_skus",{ schemaVersion: 2 });
    await expect(rpc(db,name.startsWith("plain") ? "commerce_create_order_draft_with_outbox" : "commerce_create_promoted_order_draft_with_outbox",p.args))
      .rejects.toMatchObject({ message: "catalog_propagation_head_unreadable",code: "55000" });
  }
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
it.each(lanes.flatMap(lane => (["subscription_renewal_terms","subscription_events"]).map(table => ({ lane,table }))))("admission accept $lane $table", async ({ lane,table }) => {
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

async function numberedCycle(db: PoolClient, f: Fixture, cycle: number, status: "planned" | "cancelled") {
  const operation = randomUUID(), identity = `subscription:${f.subscription}:cycle:${cycle}`, fingerprint = digest(identity);
  await db.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,
    identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at)
    VALUES($1,$2,$3::timestamptz+make_interval(days=>$4::integer),$4,$5,$6,'{}','reserved',$1,'fixture',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
    [operation,f.subscription,f.at,cycle,identity,fingerprint]);
  await db.query(`INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status,renewal_operation_id,renewal_operation_fingerprint)
    VALUES($1,$2::timestamptz+make_interval(days=>$3::integer),$4,$5,$6)`, [f.subscription,f.at,cycle,status,operation,fingerprint]);
}

it.each((["first open ordinal","next after closed ordinal","different marker basis"] as const).flatMap(basis =>
  (["assertion","port"] as const).map(path => ({ basis,path }))))(
  "LC6-D-059, LC6-D-060 and LC6-D-143 sized retention uses $basis via $path", async ({ basis,path }) => {
    const f = await fixture(packs[0]), db = await session();
    try {
      expect(await (await edit(f,"sized")).invoke(db)).toMatchObject({ status: "applied" });
      await introFixture(db,f,0,basis === "different marker basis" ? 1 : 2);
      await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_sized_intro_phase','{\"fixedThroughCycle\":2,\"graduationCycle\":3}') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
      const number = basis === "next after closed ordinal" ? 1 : 2;
      const status = basis === "next after closed ordinal" ? "cancelled" : "planned";
      await numberedCycle(db,f,number,status);
      if (basis === "first open ordinal") await numberedCycle(db,f,4,"cancelled");
      const context = await rpc(db,"subscription_sized_edit_context",[f.client,f.subscription,false]);
      expect(context).toMatchObject({ logicalUpcomingCycle: 3,paidCycleCount: 0 });
      const input: CatalogAdmissionInput = { ...f.admission,heads: [],priceContextVersions: [],
        skuRevisions: [{ reference: f.reference,quantity: 3 }],offerEvidence: { offerVersion: "sized.v1",subscriptionId: f.subscription,lane: "sized",optIn: false } };
      const applying = path === "port" ? createPostgresCatalogAdmission().assertCurrent(db,input)
        : rpc(db,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),input.mode,
          input.offerEvidence,JSON.stringify(input.priceContextVersions),input.purpose]);
      if (basis === "different marker basis") {
        await expect(applying).rejects.toMatchObject({ message: accountAnchor,code: "22023" });
      } else {
        expect(await applying).toBe(path === "port" ? undefined : "");
      }
    } finally { await db.query("ROLLBACK"); db.release(); }
  },
);

it.for(["add_addon","remove_addon","update_addon_quantity","opt in unchanged","opt in with historical entry","numbered graduation","numbered different basis","repeat after same-money publication","opt in composition head moved","opt in composition head control","candidate offer scope","candidate document drift","candidate parent drift","candidate measure drift","candidate sibling drift","candidate snapshot","candidate snapshot control"] as const)(
  "LC6-D-067 and LC6-D-132 shipped sized preview and apply keep the owned price: %s", async (action,test) => {
    const compositionRace = action === "opt in composition head moved" || action === "opt in composition head control";
    const optIn = action === "opt in unchanged" || action === "opt in with historical entry" || action === "repeat after same-money publication" || compositionRace;
    const graduation = action === "numbered graduation" || action === "numbered different basis";
    let unavailable = false;
    const discovery = action === "candidate offer scope" || action === "candidate document drift" || action === "candidate sibling drift"
      || action === "candidate parent drift" || action === "candidate measure drift"
      || action === "candidate snapshot" || action === "candidate snapshot control";
    if ((optIn || discovery) && !(await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present) {
      test.skip("Membership page comes from the predecessor installation"); return;
    }
    const f = await fixture(packs[0],{ sibling: action === "candidate sibling drift" }), setup = await pool.connect();
    const product = randomUUID(), variantId = randomUUID(), code = `LEGACY-${variantId}`;
    const actor = { actorId: f.actor,clientId: f.client }, coreQuantity = optIn ? 1 : 2;
    const constraint = { kind: "unit_count",value: coreQuantity,dailyNeed: 1 };
    try {
      if (!optIn) expect(await (await edit(f,"sized")).invoke(setup)).toMatchObject({ status: "applied" });
      const outsideOffer = discovery
        ? await fixture(packs[1], { sku: { memberships: [{ offerVersion: "classic", admitted: true }] } })
        : undefined;
      await setup.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,$2,'Legacy article','active')", [product,`legacy-${product}`]);
      await setup.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,is_addon,sellable_standalone,sellable_in_subscription,net_weight_g) VALUES($1,$2,$3,'Legacy article','active',true,true,true,100)", [variantId,product,code]);
      const tax = { included: true,country: "ZZ",category: "standard",vatRateBps: 0,legalBasis: "Synthetic tax" } as const;
      const catalog = { async listQuoteCatalogItems() {
        return (await setup.query("SELECT s.*,p.slug FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id WHERE s.id=ANY($1::uuid[])", [[f.sku,variantId]])).rows.map(row => ({
          variantId: String(row.id),skuId: String(row.id),skuCode: String(row.sku),productSlug: String(row.slug),netWeightG: Number(row.net_weight_g),isAddon: row.is_addon === true,
          sellability: { oneTime: true,subscription: true },documentRevision: { id: null,digest: null },
        }));
      } };
      const priceList = f.admission.priceContextVersions[0].priceListId, entry = randomUUID();
      await setup.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',411,$4::timestamptz-interval '1 day')", [entry,priceList,variantId,f.at]);
      const repriced: string[] = [];
      const engine = createDbBackedCommerceQuotePort({ quoteCatalogReadPort: catalog,isStrictD1Quote: false,
        pricingResolverPort: { async resolvePrice(input) {
          repriced.push(input.variantId);
          const row = (await setup.query("SELECT * FROM public.price_entries WHERE variant_id=$1 AND price_list_id=$2 AND active", [input.variantId,priceList])).rows[0];
          return { variantId: input.variantId,mode: input.mode,unitPriceMinor: Number(row.unit_price_minor),matchedMinQty: Number(row.min_qty),amountKind: "gross",priceListId: String(row.price_list_id),priceEntryId: String(row.id),resolvedAt: f.at };
        } }, taxProfile: tax,supportedTaxProfiles: [tax],regionCode: "ZZ",currency: "XXX",now: () => f.at,hasPromotionCodePort: false,
        resolveAutomaticQuotePromotions: async () => ({ discounts: [],codeRejections: [] }),
        applyPromotionCodesV2: async () => ({ discounts: [],codeRejections: [],codeRejectionDetails: [] }),
        lineContext: () => ({}),quoteContext: input => () => ({ mode: input.mode,cadenceDays: input.cadenceDays,promoCodes: input.promoCodes }) });
      const hasAddon = !optIn && action !== "add_addon";
      const initial = await engine.createServerAuthoritativeQuote({ mode: "subscription",cadenceDays: 28,promoCodes: [],lines: [
        { sku: f.code,quantity: coreQuantity,modeAtLine: "subscription",isAddon: false },
        ...(hasAddon ? [{ sku: code,quantity: 1,modeAtLine: "subscription" as const,isAddon: true }] : []),
      ] });
      if (hasAddon) {
        await setup.query("INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,is_addon,sort_order,unit_price_minor,currency_code) VALUES($1,$2,1,true,1,411,'XXX')", [f.subscription,variantId]);
        await setup.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,2,$2,1,411)", [f.subscription,code]);
      }
      if (action === "opt in with historical entry") {
        const historical = randomUUID();
        await setup.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,active,valid_from,valid_to) VALUES($1,$2,$3,'subscription',617,false,$4::timestamptz-interval '2 days',$4::timestamptz-interval '1 day')", [historical,priceList,f.sku,f.at]);
        Object.assign(initial.quote.lines[0],{ catalogFacts: { ...governedCheckoutQuote(f,"subscription").quote.lines[0].catalogFacts,
          basePriceEntryId: historical,resolvedPriceEntryId: historical,resolvedLineAmountMinor: 617 } });
      }
      const linePricing = initial.quote.lines.map(line => ({ sku: line.sku,quantity: line.quantity,unitAmountMinor: line.unitPriceGross.amountMinor,isAddon: line.sku === code,quoteLine: line }));
      if (optIn) await setup.query("INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at) VALUES($1,'subscription.starter_graduated',$2,$3,$4)", [f.subscription,randomUUID(),{ linePricing },f.at]);
      else await setup.query("UPDATE public.subscription_events SET payload=jsonb_set(payload,'{linePricing}',$2::jsonb) WHERE subscription_id=$1", [f.subscription,JSON.stringify(linePricing)]);
      if (graduation) {
        await introFixture(setup,f,0,action === "numbered different basis" ? 1 : 2);
        const addOn = initial.quote.lines.find(line => line.sku === code)!;
        const amount = money(822), quoteLine = { ...addOn,quantity: 2,lineSubtotalGross: amount,
          tax: { ...addOn.tax,netAmount: amount,grossAmount: amount } };
        await setup.query(`UPDATE public.subscription_renewal_attachments SET purchase_facts=jsonb_set(purchase_facts,
          '{renewalTerms,starterPack,graduation,lines}',purchase_facts#>'{renewalTerms,starterPack,graduation,lines}'||$2::jsonb)
          WHERE subscription_id=$1`, [f.subscription,JSON.stringify([{ sku: code,qty: 2,sortOrder: 1,isAddon: true,quoteLine }])]);
        await numberedCycle(setup,f,2,"planned");
        await setup.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_sized_intro_phase','{\"fixedThroughCycle\":2,\"graduationCycle\":3}') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
      }
      let publishComposition: CatalogPublishCommand | undefined;
      if (compositionRace) {
        const change = structuredClone(f.value), membership = { skuCode: f.code,offerVersion: "example:later",admitted: false };
        change.product.sharedContent = { ...change.product.sharedContent,catalogAction: "revise",offerMemberships: [membership] };
        change.publication.operations = [{ op: "set_offer_membership",...membership }];
        publishComposition = (await candidate(setup,change,f.draft,1,f.head)).publication;
      }
      repriced.length = 0;
      const editor = createPostgresSizedEditor({ quotePort: engine,now: () => f.at,
        async withTransaction(work) {
          const db = await runtime.connect();
          try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
          catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
        },
        async withCandidateSnapshot(work) {
          const db = await runtime.connect();
          try {
            await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            const result = await work(db);
            await db.query("COMMIT");
            return result;
          } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
        },
        policy: { minimumCoreUnits: 1,maximumCoreLines: 3,maximumAddonLines: 3,maximumQuantity: 99,allowedCadences: [28],maximumExclusions: 8,maximumCatalogExclusions: 16,fixedThroughCycle: 2,graduationCycle: 3,
          portionModes: { full: { mode: "full",factor: 1 },reduced: { mode: "reduced",factor: 0.5 } } },
        async readFacts(db,context) {
          expect(unavailable,"replay must precede consultation").toBe(false);
          const row = (await db.query("SELECT composition_constraint FROM public.subscriptions WHERE id=$1 AND client_id=$2", [context.subscriptionId,context.clientId])).rows[0];
          return { subscriptionId: context.subscriptionId,clientId: context.clientId,subjectRef: context.subscriptionId,exclusions: [],snapshot: (row.composition_constraint ?? {}) as Record<string, unknown> };
        },
        async readCatalog(db) {
          expect(unavailable,"replay must precede catalogue read").toBe(false);
          const ids = [f.sku,variantId,...(outsideOffer ? [outsideOffer.sku] : [])];
          const facts = (await db.query(`SELECT s.*,p.publication_facts#>>'{document,id}' AS document_id,p.publication_facts#>>'{document,digest}' AS document_digest
            FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id WHERE s.id=ANY($1::uuid[])`, [ids])).rows.map(row => {
            const wrongDoc = row.id === f.sku && action === "candidate document drift";
            return { variantId: String(row.id),sku: String(row.sku),groupId: row.id === f.sku && action === "candidate parent drift" ? randomUUID() : String(row.product_id),isAddon: row.is_addon === true,
              sellable: row.status === "active" && row.sellable_in_subscription === true,physicalSize: row.id === f.sku && action === "candidate measure drift" ? 101 : 100,demandPerUnit: 28,
              documentRevisionId: wrongDoc ? String(row.id) : String(row.document_id ?? row.id),
              documentDigest: wrongDoc ? digest(String(row.id)) : String(row.document_digest ?? digest(String(row.id))),verified: true,exclusions: [],sellableNow: row.is_addon ? null : 100 };
          });
          if (publishComposition) {
            const published = await publishOn(setup,publishComposition);
            expect(published).toMatchObject({ outcome: "committed",receipt: { head: { revision: f.head.revision+1,documentDigest: f.head.documentDigest } } });
            publishComposition = undefined;
          }
          return facts;
        },
        async resolveOptInNeed() { expect(optIn).toBe(true); return { dailyNeed: 1,snapshot: { dailyNeed: 1 } }; },
        async assertCurrentFacts(db,context,expected,need,catalog) {
          expect(optIn || graduation).toBe(true);
          const row = (await db.query("SELECT client_id,configured_offer_version FROM public.subscriptions WHERE id=$1", [context.subscriptionId])).rows[0];
          expect(row).toEqual({ client_id: expected.clientId,configured_offer_version: optIn ? "classic" : "sized.v1" });
          expect(need).toEqual(optIn ? { dailyNeed: 1 } : null);
          expect(catalog.map(fact => fact.variantId)).toEqual(optIn ? [f.sku] : [f.sku,variantId].sort());
        },
        proposePortion: async ({ current }) => current.map(({ variantId,qty }) => ({ variantId,qty })),
      });
      if (discovery) {
        if (action === "candidate snapshot" || action === "candidate snapshot control") {
          const result = await observeMembershipSnapshot(f,() => editor.candidates(actor,f.subscription),action.endsWith("control"));
          expect(result.catalog.map(fact => fact.variantId).sort()).toEqual([f.sku,variantId].sort());
        } else if (action === "candidate sibling drift") {
          await setup.query("UPDATE public.catalog_skus SET is_addon=true WHERE id=$1", [f.sibling]);
          try {
            await expect(editor.candidates(actor,f.subscription)).rejects.toMatchObject({ code: "55000",message: "catalog_propagation_head_unreadable" });
            const restore = await removeLiveRoleCheck();
            try { expect((await editor.candidates(actor,f.subscription)).catalog.map(fact => fact.variantId).sort()).toEqual([f.sku,variantId].sort()); }
            finally { await restore(); }
          } finally { await setup.query("UPDATE public.catalog_skus SET is_addon=false WHERE id=$1", [f.sibling]); }
        } else if (action === "candidate document drift" || action === "candidate parent drift" || action === "candidate measure drift") {
          await expect(editor.candidates(actor,f.subscription)).rejects.toMatchObject({ code: "40001",message: "catalog_publication_head_moved" });
        } else {
          const result = await editor.candidates(actor,f.subscription);
          expect(result.catalog.map(fact => fact.variantId).sort()).toEqual([f.sku,variantId].sort());
          for (const failure of memberReadFailures.filter(row => row.name !== "wrong document")) {
            const restore = await changedMembershipPage(failure);
            try { await expect(editor.candidates(actor,f.subscription)).rejects.toMatchObject({ message: failure.candidateMessage }); }
            finally { await restore(); }
          }
          for (const failure of memberReadFailures.filter(row => "predicate" in row)) {
            const restore = await changedMembershipPage(failure,true);
            try { expect((await editor.candidates(actor,f.subscription)).catalog.map(fact => fact.variantId).sort()).toEqual([f.sku,variantId].sort()); }
            finally { await restore(); }
          }
        }
        return;
      }
      const request: Parameters<typeof editor.preview>[1] = optIn ? {
        subscriptionId: f.subscription,action: "resize_bundle",cadenceDays: 28,compositionConstraint: constraint,
        resizeLever: { kind: "subscription.sized.parcel",value: { coreLines: [{ variantId: f.sku,qty: 1 }],optInToSized: true } },
      } : graduation ? { subscriptionId: f.subscription,action: "update_bundle",coreLines: [{ variantId: f.sku,qty: 4 }],compositionConstraint: { ...constraint,value: 4 } }
        : action === "remove_addon" ? { subscriptionId: f.subscription,action,variantId } : { subscriptionId: f.subscription,action,variantId,qty: 2 };
      if (action === "numbered different basis") {
        await expect(editor.preview(actor,request)).rejects.toMatchObject({ message: "subscription_reprice_base_total_mismatch" });
        return;
      }
      if (compositionRace) {
        const control = action.endsWith("control");
        const restore = control ? await hook("public.catalog_admission_build_evidence(jsonb,text,jsonb,text)","DECLARE desired jsonb;","",body => {
          const condition = "IF composition_publication IS NOT NULL AND composition_publication IS DISTINCT FROM";
          expect(body.split(condition)).toHaveLength(2);
          return body.replace(condition,"IF false AND composition_publication IS DISTINCT FROM");
        }) : undefined;
        try {
          if (control) expect(await editor.preview(actor,request)).toMatchObject({ newTotal: money(617) });
          else await expect(editor.preview(actor,request)).rejects.toMatchObject({ code: "40001",message: "catalog_publication_head_moved" });
          expect(repriced).toEqual([]);
        } finally { await restore?.(); }
        return;
      }
      const preview = await editor.preview(actor,request);
      expect(preview.quoteHash).toMatch(/^[a-f0-9]{64}$/u);
      const version = optIn ? 1 : 2, quantity = graduation ? 4 : coreQuantity;
      const evidence = (await setup.query("SELECT quote_snapshot->'catalogAdmission' AS evidence FROM public.subscription_quote_previews WHERE subscription_id=$1 AND action=$2 AND template_version=$3", [f.subscription,graduation ? "resize_bundle" : request.action,version])).rows[0].evidence;
      expect(evidence).toMatchObject({ heads: optIn ? f.admission.heads : [],skuRevisions: [{ reference: f.reference,quantity }],priceContextVersions: [] });
      if (action === "repeat after same-money publication") {
        const next = await changedDocument(f);
        const published = await publishOn(setup,next.publication);
        expect(published.outcome).toBe("committed");
        if (!("receipt" in published)) throw new Error(JSON.stringify(published));
        const current = await editor.preview(actor,request);
        expect(current.quoteHash).not.toBe(preview.quoteHash);
        expect(current.newTotal).toEqual(preview.newTotal);
        const previews = (await setup.query(`SELECT quote_hash,quote_snapshot->'catalogAdmission' AS evidence
          FROM public.subscription_quote_previews WHERE subscription_id=$1 AND action=$2 AND template_version=$3`,
          [f.subscription,request.action,version])).rows;
        expect(previews).toHaveLength(2);
        expect(previews.find(previewRow => previewRow.quote_hash === preview.quoteHash)?.evidence).toEqual(evidence);
        expect(previews.find(previewRow => previewRow.quote_hash === current.quoteHash)?.evidence.heads)
          .toEqual([{ productId: f.product,head: published.receipt.head }]);
        await expect(editor.apply(actor,randomUUID(),{ ...request,expectedTemplateVersion: version,acceptedQuoteHash: preview.quoteHash }))
          .rejects.toMatchObject({ code: "40001",message: "customer_self_service_stale_edit_catalog_head" });
        expect(await editor.apply(actor,randomUUID(),{ ...request,expectedTemplateVersion: version,acceptedQuoteHash: current.quoteHash }))
          .toMatchObject({ status: "applied",templateVersion: version+1 });
        return;
      }

      const accepted = { ...request,expectedTemplateVersion: version,acceptedQuoteHash: preview.quoteHash };
      const key = randomUUID();
      if (action === "opt in unchanged") {
        const dispatch = createOfferDispatchedSubscriptionEditor({
          async readBinding(owner,id) {
            const row = (await setup.query("SELECT configured_offer_version FROM public.subscriptions WHERE id=$1 AND client_id=$2", [id,owner.clientId])).rows[0];
            return row?.configured_offer_version ?? null;
          },
          classic: { async preview() { throw new Error("unexpected classic preview"); },async apply() { throw new Error("unexpected classic apply"); } },sized: editor,
        });
        const result = await dispatch.apply(actor,key,accepted);
        expect(result).toMatchObject({ status: "applied",templateVersion: version+1 });
        unavailable = true;
        const before = await snapshot();
        expect(await dispatch.apply(actor,key,accepted)).toEqual({ ...(result as object),status: "replayed",originalStatus: "applied" });
        expect(await snapshot()).toEqual(before);
      } else {
        expect(await editor.apply(actor,key,accepted)).toMatchObject({ status: "applied",templateVersion: version+1 });
      }
      expect(repriced).not.toContain(f.sku);
      expect((await setup.query(`SELECT variant_id,quantity,unit_price_minor,catalog_sku_revision_id FROM public.subscription_lines
        WHERE subscription_id=$1 ORDER BY is_addon`, [f.subscription])).rows).toEqual([
        { variant_id: f.sku,quantity,unit_price_minor: "617",catalog_sku_revision_id: f.reference.skuRevisionId },
        ...(optIn || action === "remove_addon" ? [] : [{ variant_id: variantId,quantity: graduation ? 1 : 2,unit_price_minor: "411",catalog_sku_revision_id: null }]),
      ]);
      expect((await setup.query("SELECT composition_constraint FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].composition_constraint).toEqual({ ...constraint,value: quantity });
    } finally { setup.release(); }
  },
);

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
    const paid = await payment(f); armed = true;
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
it("admission promoted assertion", () => purchaseCase(true,{ name: "promoted-assertion",native: true,message: orderRefused,change: p => {
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

it.each([
  { name: "plain one-time after publication",mode: "one_time",promoted: false },
  { name: "plain subscription after publication",mode: "subscription",promoted: false },
  { name: "promoted one-time after publication",mode: "one_time",promoted: true },
  { name: "promoted",mode: "subscription",promoted: true },
] as const)("admission binding $name", async ({ mode,promoted }) => {
  const f = await fixture(packs[0]), next = await changedDocument(f), p = purchaseInput(f), h = await pool.connect(), w = await pool.connect(), e = await session(), stop = await gate(h);
  const ep = await pid(e), wp = await pid(w), hp = await pid(h); let finished = false, reached = false;
  p.draft.context.mode = mode;
  p.quote.catalogAdmission.mode = mode;
  p.quote.catalogAdmission.skuRevisions[0].quantity = 3;
  const publishing = tracked(publishOn(w,next.publication,async (sql,values) => {
    if (!reached && sql.includes("pg_advisory_xact_lock(hashtextextended($1,0))") && values[0]===`catalog-lineage:${f.product}`) {
      reached = true; await w.query("SELECT pg_advisory_lock($1::bigint)", [stop.key]); await w.query("SELECT pg_advisory_unlock($1::bigint)", [stop.key]);
    }
  }));
  try {
    await blocker(h,wp,hp);
    const routine = promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox";
    const call = tracked(rpc(e,routine,p.args).finally(() => { finished = true; }));
    await expect.poll(async () => finished || (await h.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [ep,wp])).rows[0].blocked).toBe(true);
    expect(finished,"selection is checked after catalogue acquisition").toBe(false);
    await stop.release(); const written = await publishing; if (!written.ok) throw written.error; expect(written.value.outcome).toBe("committed");
    const before = await snapshot(), result = await call; expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ message: headMoved,code: "40001" });
    await e.query("ROLLBACK"); expect(await snapshot()).toEqual(before);
  } finally { await stop.release(); await publishing; await e.query("ROLLBACK"); await w.query("ROLLBACK"); h.release(); w.release(); e.release(); }
});

it.each(["classic","exact","sized"] as const)("LC6-D-157 accepted head precedes equal-money repricing drift through %s", async lane => {
  const f = await fixture(packs[0]), command = await edit(f,lane);
  const next = await changedDocument(f), w = await pool.connect();
  try { expect((await publishOn(w,next.publication)).outcome).toBe("committed"); } finally { w.release(); }
  const payload = command.payload as Record<string, unknown>;
  const repriced = payload[lane === "classic" ? "baseLines" : "lines"] as { quoteLine: Record<string, unknown> }[];
  Object.assign(repriced[0].quoteLine,{ catalogFacts: governedCheckoutQuote(f,"subscription").quote.lines[0].catalogFacts });
  const before = await snapshot(), db = await session();
  try {
    await expect(command.invoke(db)).rejects.toMatchObject({ code: "40001",message: "customer_self_service_stale_edit_catalog_head" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await snapshot()).toEqual(before);
});

const authorityPaths = ["assertion", "port", "plain-one-time", "plain-subscription", "promoted-one-time", "promoted-subscription", ...lanes,"addon","ordinary-sized"] as const;
const authorityCases = [
  { rule: "LC6-D-007 unreadable before malformed", change: "unreadable", code: "55000" },
  { rule: "LC6-D-055 retained product authority reads before demand classification", change: "retained-unreadable", code: "55000" },
  { rule: "LC6-D-008 sealed SKU drift", change: "sku-drift", code: "55000" },
  { rule: "LC6-D-008 relational add-on drift", change: "projection-drift", code: "55000" },
  { rule: "LC6-D-008 unselected sibling role drift", change: "sibling-role-drift", code: "55000" },
  { rule: "LC6-D-008/D-140 unselected sibling persisted identifier drift", change: "identifier-drift", code: "55000" },
  { rule: "LC6-D-008 relational net-weight drift", change: "weight-drift", code: "55000" },
  { rule: "LC6-D-009 exact anchor keys", change: "extra-anchor-key", code: "22023" },
  { rule: "LC6-D-009 malformed digest", change: "invalid-digest", code: "22023" },
  { rule: "LC6-D-012 stale before malformed selection", change: "stale", code: "40001" },
  { rule: "LC6-D-013 null selection", change: "null-selection", code: "22023" },
  { rule: "LC6-D-014 empty roster", change: "empty-roster", code: "22023" },
  { rule: "LC6-D-015 more than 100 distinct selections", change: "oversized-roster", code: "22023" },
  { rule: "LC6-D-016 invalid SKU UUID", change: "invalid-sku", code: "22023" },
  { rule: "LC6-D-016 null SKU UUID", change: "null-sku", code: "22023" },
  { rule: "LC6-D-017 duplicate selected UUID", change: "duplicate-selection", code: "22023" },
  { rule: "LC6-D-150 non-array selected roster", change: "wrong-roster-container", code: "22023" },
  { rule: "LC6-D-016 fractional quantity", change: "fractional-quantity", code: "22023" },
  { rule: "LC6-D-019 duplicate memberships", change: "duplicate-memberships", code: "55000" },
  { rule: "LC6-D-017 duplicate offer includes one denied membership", change: "duplicate-offer-membership", code: "55000" },
  { rule: "LC6-D-020 a different offer cannot grant admission", change: "other-offer", code: "55000" },
  { rule: "LC6-D-021 the selected membership must admit", change: "not-admitted", code: "55000" },
  { rule: "LC6-D-022 inactive SKU", change: "inactive-sku", code: "55000" },
  { rule: "LC6-D-023 inactive product", change: "inactive-product", code: "55000" },
  { rule: "LC6-D-024 unsellable standalone", change: "no-standalone", code: "55000" },
  { rule: "LC6-D-025 unsellable subscription", change: "no-subscription", code: "55000" },
  { rule: "LC6-D-074 missing consulted price", change: "missing-price", code: "22023" },
  { rule: "LC6-D-074 duplicate consulted price", change: "duplicate-price", code: "22023" },
  { rule: "LC6-D-074 orphan consulted price", change: "orphan-price", code: "22023" },
  { rule: "LC6-D-073 closed consulted price", change: "closed-price", code: "40001" },
  { rule: "LC6-D-141 surplus head", change: "surplus", code: "22023" },
  { rule: "LC6-D-027 exact eligible edit", change: "eligible", code: null },
] as const;
async function authoritySizedPath(f: Fixture, path: "addon" | "ordinary-sized", input: CatalogAdmissionInput, includeRetained = false, derivePolicy = false, oppositeRole = false) {
  const base = await fixture(packs[1]), setup = await pool.connect(), addon = path === "addon";
  try {
    expect(await (await edit(base,"sized")).invoke(setup)).toMatchObject({ status: "applied",templateVersion: 2 });
    if (oppositeRole) {
      await setup.query("UPDATE public.subscription_lines SET is_addon=true WHERE subscription_id=$1 AND variant_id=$2", [base.subscription,base.sku]);
      await setup.query("UPDATE public.subscription_events SET payload=jsonb_set(payload,'{linePricing,0,isAddon}','true') WHERE subscription_id=$1", [base.subscription]);
    }
    const lease = base.admission.priceContextVersions[0].priceListId;
    const updated = (await setup.query(
      "UPDATE public.price_entries SET price_list_id=$2 WHERE id=$1 RETURNING to_jsonb(price_entries) AS entry",
      [f.admission.priceContextVersions[0].entryId,lease])).rows[0].entry;
    for (const price of input.priceContextVersions) {
      if (price.entryId === f.admission.priceContextVersions[0].entryId) Object.assign(price,{ priceListId: lease,entry: updated });
    }
    const policy = derivePolicy ? await seedAdmissionPolicy(setup,f,input.priceContextVersions[0]) : null;
    const lineId = (await setup.query("SELECT id FROM public.subscription_lines WHERE subscription_id=$1", [base.subscription])).rows[0].id;
    const target = { variantId: f.sku,qty: 2,isAddon: addon,quoteLine: {
      sku: f.code,quantity: 2,unitPriceGross: money(617),lineSubtotalGross: money(1234),
    } };
    const retained = { ...target,variantId: base.sku,lineId,isAddon: false,quoteLine: { ...target.quoteLine,sku: base.code } };
    if (policy) Object.assign(target.quoteLine,{ catalogFacts: {
      version: "catalog_facts_v2",skuId: f.sku,documentRevisionId: f.value.product.documentRevision!.id,documentDigest: f.head.documentDigest,
      publication: { productId: f.product,skuRevisionId: f.reference.skuRevisionId,head: f.head },basePriceEntryId: input.priceContextVersions[0].entryId,
      policyRevisionId: policy.revisionId,policyDigest: policy.digest,mode: "subscription",atTime: f.at,currency: "XXX",
      baseUnitAmountMinor: 617,resolvedUnitAmountMinor: 617,resolvedLineAmountMinor: 1234,
    } });
    const lines = addon || includeRetained ? [retained,target] : [target];
    if ((addon || includeRetained) && Array.isArray(input.skuRevisions) && input.skuRevisions.length > 0) {
      input.skuRevisions = [...input.skuRevisions,...base.admission.skuRevisions];
    }
    const action = addon ? "add_addon" : "resize_bundle", hash = digest(randomUUID()), key = randomUUID();
    const compositionConstraint = { kind: "unit_count",value: includeRetained ? 4 : 2,dailyNeed: 1 }, cadenceDays = 28;
    const request = addon ? { action,variantId: f.sku,qty: 2 } : { action,cadenceDays,compositionConstraint,
      resizeLever: { kind: "subscription.sized.parcel",value: { coreLines: lines.map(({ variantId,qty }) => ({ variantId,qty })) } } };
    const evidence = { lines,cadenceDays,compositionConstraint,...(derivePolicy ? {} : { catalogAdmission: input }),subjectFacts: { revision: 1 },optInFacts: null };
    const before = money(1234), after = money(lines.length * 1234);
    const recorded = await rpc(setup,"subscription_quote_preview_record",[base.actor,base.client,base.subscription,action,hash,2,
      (await setup.query("SELECT $1::timestamptz+interval '1 hour' AS at", [f.at])).rows[0].at,request,evidence,
      { currentRecurringPrice: before,newRecurringPrice: after,delta: money(after.amountMinor-before.amountMinor) },f.at]);
    const payload = { ...evidence,...request,request: { ...request,expectedTemplateVersion: 2,acceptedQuoteHash: recorded.quote_hash },
      expectedTemplateVersion: 2,acceptedQuoteHash: recorded.quote_hash };
    const args = [base.actor,base.client,key,base.subscription,...(addon ? [action] : []),payload,f.at];
    return { baseProduct: base.product,baseSubscription: base.subscription,policy,invoke: (db: PoolClient) => rpc(db,addon ? "subscription_line_edit_apply" : "subscription_sized_edit_apply",args) };
  } finally { setup.release(); }
}

async function authorityCase({ path,change,code,control }: (typeof authorityCases)[number] & { path: (typeof authorityPaths)[number]; control?: () => Promise<() => Promise<void>> }) {
  const sized = path === "sized" || path === "ordinary-sized" || path === "addon";
  const actualOffer = sized ? "sized.v1" : "classic", otherOffer = sized ? "classic" : "sized.v1";
  const duplicateMembership = change === "duplicate-memberships" || change === "duplicate-offer-membership";
  const memberships = duplicateMembership ? [actualOffer,actualOffer] : change === "other-offer" ? [otherOffer] : [actualOffer];
  const membershipRefusal = duplicateMembership || change === "other-offer" || change === "not-admitted";
  const standing = { sku: { ...(membershipRefusal ? { memberships: memberships.map((offerVersion,index) => ({
    offerVersion,admitted: change !== "not-admitted" && (change !== "duplicate-offer-membership" || index === 0),
  })) } : {}),
    ...(path === "addon" ? { isAddon: true } : {}),...(change === "inactive-sku" ? { status: "draft" } : {}),
    ...(change === "no-standalone" ? { sellableStandalone: false } : {}),
    ...(change === "no-subscription" ? { sellableInSubscription: false } : {}) },
    product: change === "inactive-product" ? { status: "draft" } : undefined,sibling: change === "sibling-role-drift" || change === "identifier-drift" };
  const f = await fixture(packs[0],standing), input = structuredClone(f.admission);
  const purchase = path.startsWith("plain") || path.startsWith("promoted"), account = !purchase && path !== "assertion" && path !== "port";
  if (!account) input.purpose = "order";
  const missing = account ? accountAnchor : orderAnchor;
  const moved = account ? "customer_self_service_stale_edit_catalog_head" : headMoved;
  const refused = account ? "customer_self_service_invalid_offer_membership" : orderRefused;
  const unreadable = "catalog_propagation_head_unreadable";
  let message = missing;
  if (change === "unreadable" || change === "sku-drift" || change === "projection-drift" || change === "sibling-role-drift" || change === "weight-drift" || change === "identifier-drift") message = unreadable;
  if (change === "unreadable" && (path === "sized" || path === "ordinary-sized")) message = "customer_self_service_invalid_catalog_head";
  if (change === "retained-unreadable") message = "customer_self_service_invalid_catalog_head";
  if (change === "unreadable" || change === "extra-anchor-key" || change === "projection-drift" || change === "sibling-role-drift" || change === "weight-drift" || change === "identifier-drift") Object.assign(input.heads[0].head,{ extra: true });
  if (change === "stale") {
    input.heads = structuredClone(input.heads);
    input.heads[0].head.revision = 99;
    Object.assign(input,{ skuRevisions: null });
    message = moved;
  }
  if (change === "invalid-digest") input.heads[0].head.documentDigest = "z".repeat(64);
  if (change === "null-selection") { Object.assign(input,{ skuRevisions: null }); message = refused; }
  if (change === "invalid-sku") { input.skuRevisions[0].reference.skuId = "unknown"; message = refused; }
  if (change === "null-sku") { Object.assign(input.skuRevisions[0].reference,{ skuId: null }); message = refused; }
  if (change === "empty-roster") { input.skuRevisions = []; input.priceContextVersions = []; message = refused; }
  if (change === "oversized-roster") {
    input.skuRevisions = [...input.skuRevisions,...Array.from({ length: 100 },() => ({
      reference: { ...f.reference,skuId: randomUUID() },quantity: 2,
    }))];
    message = refused;
  }
  if (change === "duplicate-selection") { input.skuRevisions = [...input.skuRevisions,...input.skuRevisions]; message = refused; }
  if (change === "wrong-roster-container") { Object.assign(input,{ skuRevisions: { line: input.skuRevisions[0] } }); message = refused; }
  if (change === "missing-price" || change === "duplicate-price" || change === "orphan-price") {
    const price = input.priceContextVersions[0];
    input.priceContextVersions = change === "missing-price" ? [] : [price,change === "duplicate-price" ? { ...price } : { ...price,skuId: randomUUID() }];
    message = "catalog_admission_price_context_required";
  }
  if (change === "closed-price") {
    const price = input.priceContextVersions[0];
    price.entry = (await pool.query("UPDATE public.price_entries SET valid_to=statement_timestamp()-interval '1 minute' WHERE id=$1 RETURNING to_jsonb(price_entries) AS entry",
      [price.entryId])).rows[0].entry;
    message = "catalog_admission_price_context_moved";
  }
  if (change === "fractional-quantity") { input.skuRevisions[0].quantity = 1.5; message = refused; }
  if (membershipRefusal || change === "inactive-sku" || change === "inactive-product" ||
    change === "no-standalone" || change === "no-subscription") message = refused;
  if (change === "no-standalone") input.mode = "one_time";
  if (change === "surplus") input.heads = [...input.heads,{ productId: randomUUID(),head: f.head }];
  const command = path === "addon" || path === "ordinary-sized" ? await authoritySizedPath(f,path,input,change === "retained-unreadable")
    : account ? await edit({ ...f,admission: input },path as Lane) : undefined;
  const before = await snapshot(), restore = control ? await control() : undefined, db = await session();
  try {
    if (change === "unreadable") await db.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [f.product]);
    if (change === "retained-unreadable" && command && "baseProduct" in command) {
      await db.query("DELETE FROM public.catalog_publication_heads WHERE product_id=$1", [command.baseProduct]);
    }
    if (change === "sku-drift") await scopedFacts(db,f,"catalog_skus",{ memberships: [{ offerVersion: actualOffer,admitted: false }] });
    if (change === "projection-drift") {
      await scopedFacts(db,f,"catalog_skus",{});
      await db.query("UPDATE public.catalog_skus SET is_addon=NOT is_addon WHERE id=$1", [f.sku]);
    }
    if (change === "sibling-role-drift") {
      await db.query("UPDATE public.catalog_skus SET is_addon=true WHERE id=$1", [f.sibling]);
    }
    if (change === "identifier-drift") {
      const changed = await db.query("UPDATE public.catalog_sku_identifiers SET original_value='00000000000000',normalized_value='00000000000000' WHERE catalog_sku_id=$1 AND is_primary", [f.sibling]);
      expect(changed.rowCount).toBe(1);
    }
    if (change === "weight-drift") {
      await scopedFacts(db,f,"catalog_skus",{});
      await db.query("UPDATE public.catalog_skus SET net_weight_g=net_weight_g+1 WHERE id=$1", [f.sku]);
    }
    if (command) {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
      if (change === "eligible") await expect(command.invoke(db)).resolves.toMatchObject({ status: "applied",templateVersion: 3 });
      else await expect(command.invoke(db)).rejects.toMatchObject({ code,message });
    } else if (purchase) {
      const p = purchaseInput(f), mode = path.endsWith("one-time") ? "one_time" : "subscription";
      p.quote.catalogAdmission = { ...input,purpose: "order",mode };
      p.draft.context.mode = mode;
      const routine = path.startsWith("plain") ? "commerce_create_order_draft_with_outbox" : "commerce_create_promoted_order_draft_with_outbox";
      await expect(rpc(db,routine,p.args)).rejects.toMatchObject({ code,message });
    } else if (path === "port") {
      await expect(createPostgresCatalogAdmission().assertCurrent(db,input)).rejects.toMatchObject({ code,message });
    } else {
      await expect(rpc(db,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),input.mode,input.offerEvidence,
        JSON.stringify(input.priceContextVersions),"order"])).rejects.toMatchObject({ code,message });
    }
  } finally { await db.query("ROLLBACK"); db.release(); await restore?.(); }
  expect(await snapshot()).toEqual(before);
}

function authorityApplies(path: (typeof authorityPaths)[number], row: (typeof authorityCases)[number]) {
  if (row.change === "eligible") return path === "ordinary-sized" || path === "addon";
  if (row.change === "retained-unreadable") return path === "ordinary-sized";
  if (row.change === "no-standalone") return ["assertion","port","plain-one-time","promoted-one-time"].includes(path);
  if (row.change === "no-subscription") return !path.endsWith("one-time");
  return true;
}
it.each(authorityPaths.flatMap(path => authorityCases.filter(row => authorityApplies(path,row)).map(row => ({ ...row,path }))))("$rule via $path", authorityCase);

const rosterControls = [
  { change: "empty-roster",text: "jsonb_array_length(p_sku_revisions) NOT BETWEEN 1 AND 100",replacement: "jsonb_array_length(p_sku_revisions)>100" },
  { change: "oversized-roster",text: "jsonb_array_length(p_sku_revisions) NOT BETWEEN 1 AND 100",replacement: "jsonb_array_length(p_sku_revisions)<1" },
] as const;
it.each((["assertion","port"] as const).flatMap(path => rosterControls.map(row => ({ ...row,path }))))(
  "LC6-D-014 and LC6-D-015 roster discriminator $change via $path", async ({ path,change,text,replacement }) => {
    const row = authorityCases.find(value => value.change === change)!;
    const control = () => hook(catalogAssertionSignature,"DECLARE selection jsonb;","",body => {
      expect(body.split(text)).toHaveLength(2);
      return body.replace(text,replacement);
    });
    await expect(authorityCase({ ...row,path,control })).rejects.toMatchObject({ name: "AssertionError" });
  },
);

it.each(authorityPaths)("LC6-D-073 closed price validity discriminator via %s", async path => {
  const row = authorityCases.find(value => value.change === "closed-price")!;
  const control = () => hook(catalogAssertionSignature,"DECLARE selection jsonb;","",body => {
    const validity = " AND (p.valid_to IS NULL OR p.valid_to>statement_timestamp())\n   AND to_jsonb(p)=price_context->'entry';";
    expect(body.split(validity)).toHaveLength(2);
    const withoutValidity = body.replace(validity,"\n   AND to_jsonb(p)=price_context->'entry';");
    if (path !== "legacy") return withoutValidity;
    // Legacy independently resolves its winning price through the same row policy.
    const winner = / {2}IF p_offer_evidence->>'lane'='legacy' AND \(public\.catalog_admission_legacy_price[\s\S]*?END IF;/u;
    expect(withoutValidity.match(winner)).not.toBeNull();
    return withoutValidity.replace(winner,"");
  });
  await expect(authorityCase({ ...row,path,control })).rejects.toMatchObject({ name: "AssertionError" });
});

it("LC6-D-055 retained authority discriminator fails on the former order", async () => {
  const row = authorityCases.find(value => value.change === "retained-unreadable")!;
  const control = () => hook(catalogAssertionSignature,"DECLARE selection jsonb;","",body => {
    const demand = body.indexOf(" IF p_purpose='account' AND pg_input_is_valid(p_offer_evidence->>'subscriptionId','uuid') THEN");
    const classification = body.indexOf(" -- The authority read precedes agreement classification.",demand);
    const authority = body.indexOf(" -- Accepting writers supply the scope");
    const source = "ON s.id=CASE WHEN pg_input_is_valid(v#>>'{}','uuid') THEN (v#>>'{}')::uuid END;";
    expect(body.split(source)).toHaveLength(2);
    expect(demand).toBeGreaterThan(authority);
    expect(classification).toBeGreaterThan(demand);
    return (body.slice(0,authority)+body.slice(demand,classification)+body.slice(authority,demand)+body.slice(classification))
      .replace(source,source.replace("END;","END WHERE s.id<>ALL(retained_ids);"));
  });
  await expect(authorityCase({ ...row,path: "ordinary-sized",control })).rejects.toMatchObject({ name: "AssertionError" });
});

it.each([false,true])("LC6-D-057 ordinary sized demand compares the existing line role, control=%s", async control => {
  const f = await fixture(packs[0]), command = await authoritySizedPath(f,"ordinary-sized",structuredClone(f.admission),true,false,true);
  const restore = control ? await hook(catalogAssertionSignature,"DECLARE selection jsonb;","",body => {
    const role = " AND b->'isAddon'=d->'isAddon'";
    expect(body.split(role)).toHaveLength(2);
    return body.replace(role,"");
  }) : undefined;
  const db = await session();
  try {
    const result = await tracked(command.invoke(db));
    const refusedCurrentBasis = !result.ok && result.error?.code === "22023" && result.error.message === accountAnchor;
    expect(refusedCurrentBasis,result.ok ? "edit accepted" : String(result.error?.message)).toBe(!control);
  } finally { await db.query("ROLLBACK"); db.release(); await restore?.(); }
});

const accountAuthorityPaths = [...lanes,"addon","ordinary-sized"] as const;
it.each(accountAuthorityPaths.flatMap(path => [false,true].map(control => ({ path,control }))))(
  "LC6-D-005 guard before account classification via $path, control=$control", async ({ path,control }) => {
    const f = await fixture(packs[0],path === "addon" ? { sku: { isAddon: true } } : {});
    const command = path === "addon" || path === "ordinary-sized" ? await authoritySizedPath(f,path,structuredClone(f.admission)) : await edit(f,path);
    const next = await changedDocument(f), h = await pool.connect(), e = await session(), w = await pool.connect(), stop = await gate(h);
    const ep = await pid(e), hp = await pid(h);
    let restore = async () => {};
    try {
      await e.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
        [f.actor,JSON.stringify({ sub: f.actor,role: "authenticated" })]);
      restore = control ? await hook(writerAdmissionSignature,"BEGIN\n",stop.sql,body => {
        expect(body.split(sharedBoundary)).toHaveLength(2);
        return body.replace(sharedBoundary,"");
      }) : await hook(writerAdmissionSignature,sharedBoundary,stop.sql);
      const applying = tracked(command.invoke(e));
      await blocker(h,ep,hp);
      const before = await snapshot(), published = await publishOn(w,next.publication);
      if (control) {
        expect(published.outcome).toBe("committed");
        await expect(assertBusy(published,before)).rejects.toThrow();
        await stop.release();
        expect(await applying).toMatchObject({ ok: false,error: { code: "40001",message: "customer_self_service_stale_edit_catalog_head" } });
      } else {
        await assertBusy(published,before);
        await stop.release();
        const changed = await applying;
        if (!changed.ok) throw changed.error;
        expect(path === "legacy" ? changed.value.subscriptionAction.status : changed.value.status).toBe("applied");
        await e.query("COMMIT");
        expect(await publishOn(w,next.publication)).toMatchObject({ outcome: "committed" });
      }
    } finally { await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); await restore(); e.release(); w.release(); h.release(); }
  },
);

it.for([false,true])("LC6-D-070 exact add-on holds the consulted policy context, control=%s", async (control,context) => {
  if (!(await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present) {
    context.skip("Membership page comes from the predecessor installation"); return;
  }
  const f = await fixture(packs[0],{ sku: { isAddon: true } });
  const command = await authoritySizedPath(f,"addon",f.admission,false,true);
  const h = await pool.connect(), e = await session(), w = await session(), stop = await gate(h), ep = await pid(e), wp = await pid(w), hp = await pid(h);
  const boundary = "FOR price_context IN SELECT value FROM jsonb_array_elements(prices) ORDER BY (value->>'entryId')::uuid LOOP";
  const keyGuard = "PERFORM pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|',price_key.id::text,price_key.region_code,price_key.currency,'D2C'),0));";
  let restore = async () => {};
  try {
    restore = await hook(catalogAssertionSignature,boundary,"\n"+stop.sql,body => {
      expect(body.split(keyGuard)).toHaveLength(2);
      return control ? body.replace(keyGuard,"NULL;") : body;
    });
    const applying = tracked(command.invoke(e)); await blocker(h,ep,hp);
    const publishing = tracked(w.query("UPDATE public.subscription_price_policy_revisions SET effective_to=$2::timestamptz-interval '1 day' WHERE id=$1 RETURNING id",
      [command.policy!.revisionId,f.at]));
    if (control) {
      expect(await publishing).toMatchObject({ ok: true,value: { rowCount: 1 } });
      await w.query("COMMIT");
      await stop.release();
      expect(await applying).toMatchObject({ ok: false,error: { code: "40001",message: "catalog_admission_price_context_moved" } });
    } else {
      await blocker(h,wp,ep);
      await stop.release();
      expect(await applying).toMatchObject({ ok: true,value: { status: "applied" } });
      await e.query("COMMIT");
      expect(await publishing).toMatchObject({ ok: true,value: { rowCount: 1 } });
      await w.query("COMMIT");
    }
  } finally { await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); await restore(); e.release(); w.release(); h.release(); }
});

const authoritativeWriters = {
  "plain-one-time": "public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
  "plain-subscription": "public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
  "promoted-one-time": "public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
  "promoted-subscription": "public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
  legacy: "public.customer_subscription_apply_bundle_as_actor(uuid,text,text,jsonb,jsonb,jsonb,integer,integer)",
  classic: "public.subscription_package_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz)",
  exact: "public.subscription_line_edit_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz)",
  addon: "public.subscription_line_edit_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz)",
  sized: "public.subscription_sized_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz)",
  "ordinary-sized": "public.subscription_sized_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz)",
} as const;
it.each(Object.entries(authoritativeWriters))("removing the shared assertion call fails admission on %s", async (path,signature) => {
  const row = authorityCases.find(value => value.change === "stale")!;
  const control = () => {
    if (path.startsWith("promoted")) {
      // The promoted routine and its plain delegate both route through this call.
      return hook("public.catalog_admission_accept(jsonb,jsonb,text,jsonb,text)", "DECLARE governed jsonb;", "", body => {
        const call = /PERFORM public.catalog_admission_assert_current\([\s\S]*?;/u;
        expect(body.match(call)).not.toBeNull();
        return body.replace(call,"");
      });
    }
    return hook(signature,"v_catalog_acceptance jsonb;","",body => {
      const call = /v_catalog_acceptance:=public\.catalog_admission_accept\([\s\S]*?;/u;
      expect(body.match(call)).not.toBeNull();
      return body.replace(call,"v_catalog_acceptance:=NULL;");
    });
  };
  await expect(authorityCase({ ...row,path: path as keyof typeof authoritativeWriters,control }))
    .rejects.toMatchObject({ name: "AssertionError" });
});

it.each(["assertion", "port"].flatMap(path => ["absent SKU", "foreign stale scope"].map(change => ({ path,change }))))(
  "LC6-D-012 and LC6-D-019 $change via $path", async ({ path,change }) => {
    const f = await fixture(packs[0]);
    const input: CatalogAdmissionInput = { ...structuredClone(f.admission),purpose: "order" };
    if (change === "absent SKU") input.skuRevisions[0].reference.skuId = randomUUID();
    else {
      const other = await fixture(packs[1]);
      input.heads[0].head.revision += 1;
      input.skuRevisions = [...input.skuRevisions,...other.admission.skuRevisions];
    }
    const db = await session();
    try {
      const result = path === "port" ? createPostgresCatalogAdmission().assertCurrent(db,input)
        : rpc(db,"catalog_admission_assert_current",[JSON.stringify(input.heads),JSON.stringify(input.skuRevisions),input.mode,input.offerEvidence,
          JSON.stringify(input.priceContextVersions),input.purpose]);
      await expect(result).rejects.toMatchObject(change === "absent SKU"
        ? { code: "55000",message: orderRefused } : { code: "40001",message: headMoved });
    } finally { await db.query("ROLLBACK"); db.release(); }
  },
);

it.each(["receipt","malformed total"] as const)("legacy draft mode keeps its original refusal before %s", async competing => {
  const f = await legacyFixture(), request = purchaseInput(f), db = await session();
  const routine = "commerce_create_order_draft_with_outbox";
  delete (request.quote as { catalogAdmission?: unknown }).catalogAdmission;
  try {
    if (competing === "receipt") {
      expect(await rpc(db,routine,request.args)).toMatchObject({ orderDraft: { status: "draft",replayed: false } });
    }
    request.draft.context.mode = "invalid";
    if (competing === "malformed total") Object.assign(request.draft.totals.totalGross,{ amountMinor: "not-money" });
    await expect(rpc(db,routine,request.args)).rejects.toMatchObject({ code: "22023",message: "commerce_order_draft_invalid_mode" });
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it.each([false,true].flatMap(promoted => ["one_time","subscription"].flatMap(mode =>
  ["stale invalid mode","absent mode","null quote lines","object quote lines"].map(change => ({ promoted,mode,change })))))(
  "LC6-D-012, LC6-D-018 and LC6-D-150 $change in $mode, promoted=$promoted", async ({ promoted,mode,change }) => {
    const f = await fixture(packs[0]), p = purchaseInput(f);
    p.quote.quote.context.mode = mode;
    p.draft.context = { ...p.draft.context,mode };
    p.quote.catalogAdmission.mode = mode as CatalogAdmissionInput["mode"];
    if (change === "stale invalid mode") {
      p.draft.context.mode = "invalid";
      p.quote.catalogAdmission.heads[0].head.revision += 1;
    } else if (change === "absent mode") delete p.draft.context.mode;
    else Object.assign(p.quote.quote,{ lines: change === "null quote lines" ? null : {} });
    const db = await session();
    try {
      await expect(rpc(db,promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox",p.args))
        .rejects.toMatchObject(change === "stale invalid mode"
          ? { code: "40001",message: headMoved } : { code: "22023",message: orderRefused });
    } finally { await db.query("ROLLBACK"); db.release(); }
  },
);

const authorityControls = [
  { change: "sku-drift",predicate: "OR sk.publication_facts IS DISTINCT FROM r.full_facts::jsonb",replacement: "" },
  { change: "projection-drift",predicate: "OR to_jsonb(sk.is_addon) IS DISTINCT FROM sk.publication_facts->'isAddon'",replacement: "" },
  { change: "sibling-role-drift",predicate: "OR to_jsonb(sk.is_addon) IS DISTINCT FROM sk.publication_facts->'isAddon'",replacement: "" },
  { change: "identifier-drift",predicate: "OR NOT public.catalog_admission_identifiers_match(sk.id,sk.publication_facts->'identifiers')",replacement: "" },
  { change: "weight-drift",predicate: "OR sk.net_weight_g::numeric IS DISTINCT FROM",replacement: "OR false AND sk.net_weight_g::numeric IS DISTINCT FROM" },
  { change: "extra-anchor-key",predicate: "OR (h->'head')-ARRAY['publicationId','revision','documentDigest']<>'{}'::jsonb",replacement: "" },
  { change: "invalid-digest",predicate: "OR NOT coalesce(h#>>'{head,documentDigest}' ~ '^[0-9a-f]{64}$',false)",replacement: "" },
  { change: "duplicate-memberships",predicate: "HAVING count(*)=1 AND bool_or",replacement: "HAVING count(*)>=1 AND bool_or" },
  { change: "duplicate-offer-membership",predicate: "HAVING count(*)=1 AND bool_or",replacement: "HAVING count(*)>=1 AND bool_or" },
  { change: "other-offer",predicate: "WHERE m->>'offerVersion'=p_offer_evidence->>'offerVersion'",replacement: "" },
  { change: "not-admitted",predicate: "AND bool_or(m->'admitted'='true'::jsonb)",replacement: "" },
  { change: "unreadable",predicate: "RAISE EXCEPTION 'customer_self_service_invalid_catalog_head'",replacement: "RAISE EXCEPTION 'catalog_propagation_head_unreadable'" },
  { change: "inactive-sku",predicate: "OR sku.status<>'active'",replacement: "" },
  { change: "inactive-product",predicate: "OR product.status<>'active'",replacement: "" },
  { change: "no-standalone",predicate: "OR (p_mode='one_time' AND NOT sku.sellable_standalone)",replacement: "" },
  { change: "no-subscription",predicate: "OR (p_mode='subscription' AND NOT sku.sellable_in_subscription)",replacement: "" },
  { change: "stale",predicate: "IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_heads) h WHERE h->'head' IS DISTINCT FROM actual_heads->(h->>'productId')) THEN\n  RAISE EXCEPTION '%',moved USING ERRCODE='40001'; END IF;",replacement: "" },
  { change: "null-selection",predicate: "IF jsonb_typeof(p_sku_revisions) IS DISTINCT FROM 'array' THEN\n  RAISE EXCEPTION '%',refused USING ERRCODE='22023'; END IF;",replacement: "" },
  { change: "invalid-sku",predicate: "OR NOT coalesce(pg_input_is_valid(s#>>'{reference,skuId}','uuid'),false)",replacement: "" },
  { change: "fractional-quantity",predicate: "OR NOT coalesce(s->>'quantity' ~ '^[1-9][0-9]*$' AND pg_input_is_valid(s->>'quantity','integer'),false)",replacement: "" },
] as const;
it.each(authorityControls.flatMap(({ change,predicate,replacement }) => {
  const row = authorityCases.find(value => value.change === change)!;
  const allPaths = ["projection-drift","sibling-role-drift","weight-drift","identifier-drift","duplicate-offer-membership",
    "inactive-sku","inactive-product","no-standalone","no-subscription"].includes(change);
  const paths = allPaths ? authorityPaths.filter(path => authorityApplies(path,row))
    : change === "unreadable" ? ["sized","ordinary-sized"] as const : ["plain-subscription"] as const;
  return paths.map(path => ({ row,path,predicate,replacement }));
}))("authority control $row.change fails its precise witness via $path", async ({ row,path,predicate,replacement }) => {
  const liveHead = ["sku-drift","projection-drift","sibling-role-drift","weight-drift","identifier-drift","unreadable"].includes(row.change);
  const control = () => hook(liveHead ? verifiedHeadsSignature : admissionSignature,liveHead ? "DECLARE product_id uuid;" : sharedBoundary,"",body => {
    expect(body.split(predicate)).toHaveLength(2);
    return body.replace(predicate,replacement);
  });
  await expect(authorityCase({ ...row,path,control })).rejects.toMatchObject({ name: "AssertionError" });
});

async function acquisitionCase({ offerVersion,result,offerInput }: {
  offerInput?: "missing" | "null";
  offerVersion: "classic" | "sized.v1"; result: "bound" | "missing" | "mismatch" | "attachment mismatch" | "unpaid" | "abandoned" | "legacy opaque evidence" | "promoted split" | "qualified runtime";
}) {
  const legacy = result === "legacy opaque evidence", f = await (legacy ? legacyFixture() : fixture(packs[0]));
  const key = randomUUID(), amount = money(1234), sizeConstraint = { kind: "unit_count",value: 2,dailyNeed: 1 };
  const promotionId = result === "promoted split" ? randomUUID() : null;
  if (promotionId) await pool.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)",
    [promotionId,{ id: promotionId,status: "active",redemption_limit_global: null,redemption_limit_per_customer: null }]);
  const cut = promotionId ? 101 : 0, payable = money(amount.amountMinor - cut);
  const actorDb = result === "qualified runtime" ? runtime : pool;
  const quote = { contractVersion: "commerce.v0" as const,quote: { currency: "XXX",taxIncluded: true as const,
    lines: [{ sku: f.code,productSlug: f.value.product.slug!,quantity: 2,unitPriceGross: money(617),lineSubtotalGross: amount,
      tax: { included: true as const,country: "ZZ",category: "standard",vatRateBps: 0,legalBasis: "Synthetic tax",
        netAmount: amount,vatAmount: money(0),grossAmount: amount } }],
    discounts: promotionId ? [{ promotionId,appliesTo: "order_total" as const,amountOffMinor: cut,reasonCode: "synthetic" }] : [],
    context: { mode: "subscription" as const,cadenceDays: 28,promoCodes: [],...(offerInput === "missing" ? {} : { offerVersion: offerInput === "null" ? null : offerVersion }),sizeConstraint },
    subtotalGross: amount,discountTotalGross: money(cut),totalGross: payable,netTotal: payable,taxTotal: money(0) } };
  const port = createPostgresAcquisitionCheckoutPersistence(actorDb,{ regionCode: "ZZ",isAcquisitionDiscount: () => false,
    financialPolicy: { facts: () => ({ regionCodes: [],metadataPresent: false }) } as never });
  const beforeCount = (await pool.query("SELECT count(*) FROM public.subscriptions WHERE client_id=$1", [f.client])).rows[0].count;
  let order: string;
  if (legacy) {
    const purchase = purchaseInput(f), opaqueEvidence = { legacy: "opaque" };
    purchase.args[0] = key;
    Object.assign(purchase.quote,{ catalogAdmission: opaqueEvidence });
    const accepted = await rpc(pool,"commerce_create_order_draft_with_outbox",purchase.args);
    expect(accepted.orderDraft.quoteSnapshot.catalogAdmission).toEqual(opaqueEvidence);
    order = accepted.orderDraft.orderId.replace(/^order_/u,"");
  } else {
    // The raw writer is the C04 fixture entry. H stock coverage uses a capture above.
    const accepted = await (offerVersion === "sized.v1" ? createPostgresNativeCheckoutPersistence(actorDb) : port)
      .createOrderDraft({ idempotencyKey: key,quoteSnapshot: quote },{ clientId: f.client,catalogAdmission: { ...f.admission,purpose: "order",offerEvidence: { offerVersion } } });
    expect(accepted.orderDraft.quoteSnapshot).toEqual(quote);
    order = accepted.orderDraft.orderId.replace(/^order_/u,"");
  }
  const proof = legacy ? null : { schemaVersion: 2,lines: [f.reference] };
  expect((await pool.query("SELECT status,catalog_acceptance,metadata->'catalogAcquisition' AS frozen FROM public.commerce_orders WHERE id=$1", [order])).rows)
    .toEqual([{ status: "pending_payment",catalog_acceptance: proof,frozen: legacy ? null : { offerVersion,sizeConstraint,heads: f.admission.heads,selections: f.admission.skuRevisions,proof } }]);
  if (promotionId) expect((await pool.query(`SELECT quantity,unit_amount_minor,catalog_unit_amount_minor FROM public.commerce_order_items
    WHERE order_id=$1 ORDER BY line_ordinal`, [order])).rows).toEqual([
    { quantity: 1,unit_amount_minor: "566",catalog_unit_amount_minor: "617" },
    { quantity: 1,unit_amount_minor: "567",catalog_unit_amount_minor: "617" },
  ]);
  expect((await pool.query("SELECT count(*) FROM public.subscriptions WHERE client_id=$1", [f.client])).rows[0].count).toBe(beforeCount);
  if (result === "abandoned") {
    await rpc(pool,"subscription_declare_provisional_activation",[`declare:${key}`,order,28,f.at]);
    expect(await rpc(pool,"commerce_cancel_abandoned_purchase_checkout",[`abandon:${key}`,order,"synthetic payment window elapsed",f.at]))
      .toMatchObject({ cancelled: true,orderStatus: "cancelled" });
    expect((await pool.query("SELECT state,subscription_id FROM public.subscription_activations WHERE order_id=$1", [order])).rows)
      .toEqual([{ state: "compensated",subscription_id: null }]);
    await expect(rpc(pool,"subscription_activate_from_captured_payment",[`activate:${key}`,order,digest("synthetic-abandoned")]))
      .rejects.toMatchObject({ code: "22023",message: "subscription_activation_order_compensated" });
    expect((await pool.query("SELECT count(*) FROM public.subscriptions WHERE client_id=$1", [f.client])).rows[0].count).toBe(beforeCount);
    return;
  }
  const intent = await rpc(pool,"commerce_open_settlement_intent",[`open:${key}`,order,"sandbox",payable.amountMinor,"XXX",{},f.at]);
  await rpc(pool,"subscription_declare_provisional_activation",[`declare:${key}`,order,28,f.at]);
  const fingerprint = async () => (await pool.query("SELECT coalesce(external_ref,id::text) AS ref FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0].ref as string;
  const activate = async () => rpc(actorDb,"subscription_activate_from_captured_payment",[`activate:${key}`,order,digest(await fingerprint())]);
  if (result === "unpaid") {
    await expect(activate()).rejects.toMatchObject({ code: "22023",message: "subscription_activation_order_not_paid" });
    expect((await pool.query("SELECT count(*) FROM public.subscriptions WHERE client_id=$1", [f.client])).rows[0].count).toBe(beforeCount);
    return;
  }
  await captureSandboxPurchase(createPostgresSandboxPaymentSimulator(pool,{ dunningTemplateSlug: "failed",recoveryUrlPath: "/recover",recoveryTemplateSlug: "recovered" }),
    { settlementIntentId: intent.settlement.id,key,at: f.at });
  const writer = createPostgresPurchaseRenewalWriter(actorDb);
  await writer.register(order,{ settlementChannelKey: "sandbox",authorizationRef: "synthetic",unattendedChargeAuthorizedAt: f.at,payerAccountRef: null,
    methodRef: "synthetic",methodEvidenceRef: "synthetic",stockSourceKey: "synthetic",templateId: "synthetic",cadenceDays: 28,currency: "XXX",
    lines: [{ lineOrdinal: 1,sku: f.code,quantity: result === "attachment mismatch" ? 3 : 2,unitAmountMinor: 617 }],shippingAmountMinor: 0,acquisitionRef: null });
  if (result === "missing" || result === "mismatch") {
    await pool.query(`UPDATE public.commerce_orders SET metadata=${result === "missing" ? "metadata-'catalogAcquisition'" : "jsonb_set(metadata,'{catalogAcquisition,offerVersion}',to_jsonb('mismatched'::text))"} WHERE id=$1`, [order]);
    const before = await snapshot();
    await expect(activate()).rejects.toMatchObject({ code: "22023",message: "subscription_activation_catalog_acceptance_mismatch" });
    expect(await snapshot()).toEqual(before);
    return;
  }
  if (!legacy) {
    const next = await changedDocument(f), publisher = await pool.connect();
    try { expect((await publishOn(publisher,next.publication)).outcome).toBe("committed"); } finally { publisher.release(); }
  }
  const activated = await activate();
  const activeTerms = () => pool.query(`SELECT s.configured_offer_version,s.composition_constraint,t.catalog_acceptance
    FROM public.subscriptions s LEFT JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id WHERE s.id=$1`, [activated.subscriptionId]);
  const binding = { configured_offer_version: offerVersion,composition_constraint: offerVersion === "classic" ? null : sizeConstraint };
  if (result === "bound" || legacy) expect((await activeTerms()).rows).toEqual([{ ...binding,catalog_acceptance: null }]);
  if (result === "attachment mismatch") {
    const before = await snapshot();
    await expect(writer.complete(order)).rejects.toMatchObject({ code: "22023",message: "subscription_activation_catalog_acceptance_mismatch" });
    expect(await snapshot()).toEqual(before);
    return;
  }
  expect(await writer.complete(order)).toEqual({ subscriptionId: activated.subscriptionId,replayed: false });
  expect((await activeTerms()).rows).toEqual([{ ...binding,catalog_acceptance: proof }]);
  expect((await pool.query(`SELECT line.catalog_sku_revision_id,terms.quantity,terms.unit_amount_minor
    FROM public.subscription_lines line JOIN public.subscription_renewal_term_lines terms ON terms.subscription_id=line.subscription_id
    WHERE line.subscription_id=$1 ORDER BY terms.line_ordinal`, [activated.subscriptionId])).rows)
    .toEqual([{ catalog_sku_revision_id: legacy ? null : f.reference.skuRevisionId,quantity: 2,unit_amount_minor: "617" }]);
  expect(await activate()).toEqual({ ...activated,replayed: true });
  expect(await writer.complete(order)).toEqual({ subscriptionId: activated.subscriptionId,replayed: true });
}

it.each((["classic", "sized.v1"] as const).flatMap(offerVersion => (["bound", "missing", "mismatch", "attachment mismatch", "unpaid", "abandoned", "promoted split", "qualified runtime"] as const)
  .map(result => ({ offerVersion,result }))))("LC6-D-041 and LC6-D-146 $offerVersion $result through native acquisition", acquisitionCase);

it.for(["exact frozen phase", "different attachment marker"] as const)(
  "LC6-D-060/D-063/D-144 graduation uses the authenticated phase and refuses a live reconstruction: %s", async (scenario, test) => {
    const installed = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
    if (!installed) { test.skip("Membership page comes from the predecessor installation"); return; }
    const f = await fixture(packs[0]), next = await fixture(packs[1]);
    const quote = governedCheckoutQuote(f,"subscription","sized.v1",{ basis: "synthetic" });
    const phaseLine = governedCheckoutQuote(next,"subscription","sized.v1").quote.lines[0];
    Object.assign(phaseLine.catalogFacts,{ publication: { productId: next.product,skuRevisionId: next.reference.skuRevisionId,head: next.head } });
    const terms = { version: "native.renewal-terms.v1" as const,minimumPayableMinor: 1,normalCadenceDays: [28],
      linePricing: [{ sku: f.code,quantity: 2,unitAmountMinor: 617,isAddon: false,quoteLine: quote.quote.lines[0] }],
      starterPack: { schemaVersion: "1" as const,starterIntervalDays: 28,basisTemplateVersion: 1,
        delivery2: { discountBps: 0,discountMinor: 0,basisSubtotalMinor: 1234 },
        graduation: { cadenceDays: 28,lines: [{ sku: next.code,qty: 2,sortOrder: 0,isAddon: false,quoteLine: phaseLine }] } } };
    Object.assign(quote.quote.context,{ starterRenewalTerms: terms,sizeConstraint: { kind: "unit_count",value: 2,dailyNeed: 1 } });
    const port = createPostgresAcquisitionCheckoutPersistence(runtime,{ regionCode: "ZZ",isAcquisitionDiscount: () => false,
      financialPolicy: { facts: () => ({ regionCodes: [],metadataPresent: false }) } as never,
      availability: { async getAvailability() { return [{ sku: f.code,productSlug: f.value.product.slug!,variantId: f.sku,
        visibleInConfigurator: true,sellableNow: 2,status: "available",reasonCode: "synthetic",source: "fixture" }]; } } });
    const key = randomUUID(), evidence = await port.captureCatalogAdmission(quote,f.admission.heads);
    const phaseProof = { schemaVersion: 2,lines: [next.reference] };
    expect(evidence).toMatchObject({ phaseReference: { schemaVersion: 1,phase: "graduation",proof: phaseProof } });
    const { orderDraft } = await port.createOrderDraft({ idempotencyKey: key,quoteSnapshot: quote },{ clientId: f.client,catalogAdmission: evidence });
    const order = orderDraft.orderId.replace(/^order_/u,""), intent = await rpc(pool,"commerce_open_settlement_intent",[`open:${key}`,order,"sandbox",1234,"XXX",{},f.at]);
    await rpc(pool,"subscription_declare_provisional_activation",[`declare:${key}`,order,28,f.at]);
    await captureSandboxPurchase(createPostgresSandboxPaymentSimulator(pool,{ dunningTemplateSlug: "failed",recoveryUrlPath: "/recover",recoveryTemplateSlug: "recovered" }),
      { settlementIntentId: intent.settlement.id,key,at: f.at });
    const paid = (await pool.query("SELECT coalesce(external_ref,id::text) AS ref FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0].ref;
    const writer = createPostgresPurchaseRenewalWriter(runtime);
    if (scenario === "different attachment marker") terms.starterPack.graduation.lines[0].sortOrder = 1;
    await writer.register(order,{ settlementChannelKey: "sandbox",authorizationRef: "synthetic",unattendedChargeAuthorizedAt: f.at,payerAccountRef: null,
      methodRef: "synthetic",methodEvidenceRef: "synthetic",stockSourceKey: "synthetic",templateId: "synthetic",cadenceDays: 28,currency: "XXX",
      lines: [{ lineOrdinal: 1,sku: f.code,quantity: 2,unitAmountMinor: 617 }],shippingAmountMinor: 0,acquisitionRef: null,renewalTerms: terms });
    const activated = await rpc(runtime,"subscription_activate_from_captured_payment",[`activate:${key}`,order,digest(paid)]);
    const id = activated.subscriptionId;
    if (scenario === "different attachment marker") {
      const before = await snapshot();
      await expect(writer.complete(order)).rejects.toMatchObject({ code: "22023",message: "subscription_activation_catalog_acceptance_mismatch" });
      expect(await snapshot()).toEqual(before);
      return;
    }
    expect(await writer.complete(order)).toMatchObject({ subscriptionId: id,replayed: false });
    const publisher = await pool.connect(), revision = await changedDocument(next);
    let newHead: CatalogHeadRef;
    try {
      const result = await publishOn(publisher,revision.publication);
      if (result.outcome !== "committed") throw new Error(JSON.stringify(result));
      newHead = result.receipt.head;
    } finally { publisher.release(); }
    const liveRevision = (await pool.query(`SELECT item->>'revisionId' AS revision FROM public.catalog_publications p
      CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') item WHERE p.id=$1 AND item->>'skuId'=$2`, [newHead.publicationId,next.sku])).rows[0].revision;
    expect(liveRevision).not.toBe(next.reference.skuRevisionId);
    const rebuilt = { ...next.reference,skuRevisionId: liveRevision,publicationHead: newHead };
    await pool.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_sized_intro_phase','{\"fixedThroughCycle\":2,\"graduationCycle\":3}') ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text");
    await pool.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) SELECT id,started_at+interval '1 day','paid' FROM public.subscriptions WHERE id=$1", [id]);
    const dueAt = (await pool.query(`UPDATE public.subscriptions SET next_cycle_at=date_trunc('second',clock_timestamp())-interval '1 second' WHERE id=$1
      RETURNING to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`, [id])).rows[0].at;
    await pool.query("UPDATE public.subscription_renewal_terms SET next_cycle_number=2 WHERE subscription_id=$1", [id]);
    const binding = { subscriptionId: id,offerVersion: "sized.v1",lane: "sized",scopeSkuIds: [next.sku],
      scopeDemand: [{ skuId: next.sku,quantity: 2,isAddon: false }] };
    const assertReference = (reference: CatalogAcceptedReferenceV2) => rpc(runtime,"catalog_admission_assert_current",
      ["[]",JSON.stringify([{ reference,quantity: 2 }]),"subscription",binding,"[]","account"]);
    await expect(assertReference(rebuilt)).rejects.toMatchObject({ code: "22023",message: "catalog_retained_revision_unavailable" });
    await assertReference(next.reference);
    const db = await session(), codec = createNativeCatalogRenewalCodecV2(value => catalogAcceptedReferenceV2Schema.parse(value));
    try {
      const store = createPostgresRenewalStore(db,codec,work => work(db));
      const due = (await store.listDue(500,dueAt)).find(row => row.subscriptionId === id)!;
      expect(await store.buildCycleSnapshots(due)).toMatchObject({ scheduledAt: dueAt,catalogAcceptance: phaseProof,
        templateSnapshot: { lines: [{ sku: next.code,quantity: 2,unitAmountMinor: 617 }] } });
      expect((await db.query("SELECT catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [id])).rows)
        .toEqual([{ catalog_sku_revision_id: next.reference.skuRevisionId }]);
    } finally { await db.query("ROLLBACK"); db.release(); }
  },
);

it.for([
  { regionCode: "PQ",base: 1490,discount: 1000,quantum: 10,expected: 1340 },
  { regionCode: "PR",base: 1499,discount: 500,quantum: 10,expected: 1420 },
])("LC6-D-118 the strict quote owner admits policy corpus $base/$discount and refuses caller money", async (row,test) => {
  const installed = (await pool.query("SELECT to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NOT NULL AS present")).rows[0].present;
  if (!installed) { test.skip("Membership page comes from the predecessor installation"); return; }
  const f = await fixture(packs[0]), price = f.admission.priceContextVersions[0];
  await pool.query("UPDATE public.price_lists SET region_code=$2 WHERE id=$1", [price.priceListId,row.regionCode]);
  await pool.query("UPDATE public.price_entries SET mode='one_time',unit_price_minor=$2 WHERE id=$1", [price.entryId,row.base]);
  await pool.query(`INSERT INTO public.subscription_price_policy_revisions(id,revision_no,price_list_id,region_code,currency,channel,
    effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
    SELECT $1,1,$2,$3,'XXX','D2C',t,$4,$5,'FLOOR_TO_QUANTUM',public.catalog_price_setup_policy_digest(
     $1,1,$2,$3,'XXX','D2C',t,NULL,$4,$5,'FLOOR_TO_QUANTUM') FROM (SELECT $6::timestamptz-interval '1 day' AS t) clock`,
  [randomUUID(),price.priceListId,row.regionCode,row.discount,row.quantum,f.at]);
  const tax = { included: true,country: "ZZ",category: "standard",vatRateBps: 0,legalBasis: "Synthetic tax" } as const;
  const catalog = createPostgresCommerceQuoteCatalogReadPort(runtime,{ verifyDocument(document,envelope) {
    expect(digest(canonicalCatalogDraftJson(document))).toBe(envelope.documentRevision.digest);
  },governedOffer: { offerVersion: "classic",mode: "subscription",async withSnapshot(work) {
    const db = await runtime.connect();
    try { await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); return await work(db); }
    finally { await db.query("ROLLBACK"); db.release(); }
  } } });
  const engine = createDbBackedCommerceQuotePort({ quoteCatalogReadPort: catalog,isStrictD1Quote: true,
    commercePriceAuthorityPort: createPostgresCommercePriceAuthorityPort(runtime),taxProfile: tax,supportedTaxProfiles: [tax],
    regionCode: row.regionCode,currency: "XXX",now: () => f.at,hasPromotionCodePort: false,
    resolveAutomaticQuotePromotions: async () => ({ discounts: [],codeRejections: [] }),
    applyPromotionCodesV2: async () => ({ discounts: [],codeRejections: [],codeRejectionDetails: [] }),
    lineContext: () => ({}),quoteContext: input => () => ({ mode: input.mode,cadenceDays: input.cadenceDays,promoCodes: input.promoCodes }) });
  const quoteSnapshot = await engine.createServerAuthoritativeQuote({ mode: "subscription",cadenceDays: 28,promoCodes: [],lines: [{ sku: f.code,quantity: 2 }] });
  expect(quoteSnapshot.quote.lines[0]).toMatchObject({ unitPriceGross: money(row.expected),catalogFacts: {
    version: "catalog_facts_v2",basePriceEntryId: price.entryId,baseUnitAmountMinor: row.base,resolvedUnitAmountMinor: row.expected } });
  const checkout = createPostgresAcquisitionCheckoutPersistence(runtime,{ regionCode: row.regionCode,isAcquisitionDiscount: () => false,
    financialPolicy: { facts: () => ({ regionCodes: [],metadataPresent: false }) } as never });
  const evidence = await checkout.captureCatalogAdmission(quoteSnapshot), request = { idempotencyKey: randomUUID(),quoteSnapshot };
  const identity = { clientId: f.client,catalogAdmission: evidence }, before = await snapshot();
  await expect(checkout.createOrderDraft(structuredClone(request),identity)).rejects.toThrow("catalog_admission_quote_authority_required");
  const raw = purchaseInput(f), { quote } = quoteSnapshot;
  const rawQuote = { ...quoteSnapshot,catalogAdmission: { ...evidence,policyOwnerRegion: row.regionCode } };
  const draft = { ...raw.draft,lines: quote.lines,context: quote.context,
    totals: { ...raw.draft.totals,subtotalGross: quote.subtotalGross,totalGross: quote.totalGross,netTotal: quote.netTotal } };
  for (const routine of ["commerce_create_order_draft_with_outbox","commerce_create_promoted_order_draft_with_outbox"]) {
    await expect(rpc(runtime,routine,[randomUUID(),rawQuote,draft,f.client])).rejects.toMatchObject({ code: "22023",message: "catalog_admission_quote_authority_required" });
  }
  const forgery = { ...quote.lines[0],unitPriceGross: money(row.expected + row.quantum),lineSubtotalGross: money(2 * (row.expected + row.quantum)) };
  const forgedTotal = forgery.lineSubtotalGross;
  await expect(rpc(runtime,"catalog_admission_create_policy_draft",[randomUUID(),rawQuote,
    { ...draft,lines: [forgery],totals: { ...draft.totals,totalGross: forgedTotal,subtotalGross: forgedTotal,netTotal: forgedTotal } },
    f.client,row.regionCode])).rejects.toMatchObject({ code: "22023",message: "commerce_order_draft_catalog_price_changed" });
  expect(await snapshot()).toEqual(before);
  const accepted = await checkout.createOrderDraft(request,identity);
  const order = accepted.orderDraft.orderId.replace(/^order_/u,"");
  expect((await pool.query("SELECT unit_amount_minor::integer AS unit,line_amount_minor::integer AS total FROM public.commerce_order_items WHERE order_id=$1", [order])).rows)
    .toEqual([{ unit: row.expected,total: 2 * row.expected }]);
  expect(await checkout.createOrderDraft(structuredClone(request),{ clientId: f.client })).toEqual({ ...accepted,orderDraft: { ...accepted.orderDraft,replayed: true } });
});


it.each((["missing","null"] as const).flatMap(offerInput => [false,true].map(control => ({ offerInput,control }))))(
  "LC6-D-040 acquisition defaults $offerInput configured offer, control=$control", async ({ offerInput,control }) => {
    const run = () => acquisitionCase({ offerVersion: "classic",result: "bound",offerInput });
    if (!control) { await run(); return; }
    const signature = "public.catalog_price_setup_order_offer_version(jsonb)";
    const restore = await hook(signature,"BEGIN","",body => {
      const fallback = "THEN RETURN 'classic';";
      expect(body.split(fallback)).toHaveLength(2);
      return body.replace(fallback,"THEN RETURN 'sized.v1';");
    });
    try { await expect(run()).rejects.toMatchObject({ code: "22023",message: "subscription_activation_catalog_acceptance_mismatch" }); }
    finally { await restore(); }
  },
);

it.each(["unknown",{ version: "classic" }])("LC6-D-040 acquisition refuses invalid configured offer %j", async offerVersion => {
  for (const promoted of [false,true]) await purchaseCase(promoted,{
    name: "invalid configured offer",native: true,message: "catalog_price_setup_native_order_admission_unverified",code: "55000",
    change(p) { p.quote.quote.context.offerVersion = offerVersion; },
  });
});

it.each([false,true])("CD-CAT-23 legacy opaque quote field during acquisition, control=%s", async control => {
  const run = () => acquisitionCase({ offerVersion: "classic",result: "legacy opaque evidence" });
  if (!control) { await run(); return; }
  const restore = await hook("public.catalog_admission_frozen_order(uuid)","BEGIN","",body => {
    const predicate = "IF o.catalog_acceptance IS NULL AND frozen IS NULL THEN RETURN NULL; END IF;";
    expect(body.split(predicate)).toHaveLength(2);
    return body.replace(predicate,predicate.replace("THEN","AND evidence IS NULL THEN"));
  });
  try { await expect(run()).rejects.toMatchObject({ code: "22023",message: "subscription_activation_catalog_acceptance_mismatch" }); }
  finally { await restore(); }
});

it("LC6-D-152 removing the scoped purchase binder definer fails qualified activation", async () => {
  const signature = "public.catalog_admission_bind_purchase(uuid,uuid)";
  await pool.query(`ALTER FUNCTION ${signature} SECURITY INVOKER`);
  try {
    await expect(acquisitionCase({ offerVersion: "sized.v1",result: "qualified runtime" }))
      .rejects.toMatchObject({ code: "42501",message: "permission denied for function catalog_admission_frozen_order" });
  } finally { await pool.query(`ALTER FUNCTION ${signature} SECURITY DEFINER`); }
});

it.each([
  {
    rule: "LC6-D-039 immutable draft acceptance",
    signature: "public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
    text: "v_catalog_acceptance IS NOT NULL AND v_mode='subscription' THEN",
    replace: "false THEN",
    result: "bound",
  },
  {
    rule: "LC6-D-041 bind at captured-payment activation",
    signature: "public.subscription_activation_commit(public.subscription_activations,text,text,timestamptz,boolean)",
    text: "PERFORM public.catalog_admission_bind_purchase(v_subscription_id,p_activation.order_id);",
    replace: "",
    result: "bound",
  },
  {
    rule: "LC6-D-146 retained proof at attachment",
    signature: "public.subscription_complete_renewal_attachment(uuid)",
    text: "v_facts->>'payerAccountRef',frozen->'proof');",
    replace: "v_facts->>'payerAccountRef',NULL);",
    result: "bound",
  },
  {
    rule: "LC6-D-146 exact draft line agreement at attachment",
    signature: "public.subscription_complete_renewal_attachment(uuid)",
    text: "frozen->'orderLines' IS DISTINCT FROM (SELECT jsonb_agg(l ORDER BY (l->>'lineOrdinal')::integer) FROM jsonb_array_elements(v_facts->'lines') l)",
    replace: "false",
    result: "attachment mismatch",
  },
] as const)("$rule reversion fails the acquisition witness", async ({ signature,text,replace,result }) => {
  const restore = await hook(signature,"BEGIN","",body => {
    expect(body.split(text)).toHaveLength(2);
    return body.replace(text,replace);
  });
  try {
    await expect(acquisitionCase({ offerVersion: "sized.v1",result })).rejects.toMatchObject({ name: "AssertionError" });
  } finally { await restore(); }
});

it.each([
  { name: "LC6-D-017 duplicate source",reason: orderRefused,code: "22023" },
  { name: "LC6-D-032 ordered quote quantity",reason: orderRefused,code: "22023" },
  { name: "LC6-D-063 extra selection",reason: orderRefused,code: "22023" },
  { name: "LC6-D-072 alternate winning entry",reason: priceMoved,code: "40001" },
  { name: "LC6-D-072 consulted quote entry differs from the carrier",reason: priceMoved,code: "40001" },
  { name: "LC6-D-074 duplicate entry",reason: "catalog_admission_price_context_required",code: "22023" },
  { name: "LC6-D-074 orphan entry",reason: "catalog_admission_price_context_required",code: "22023" },
].flatMap(row => ["one_time","subscription"].flatMap(mode => [false,true].map(promoted => ({ ...row,mode,promoted })))))("$name $mode promoted=$promoted", async ({ name,reason,code,mode,promoted }) => {
  const f = await fixture(packs[0]), p = purchaseInput(f), db = await session();
  p.quote.catalogAdmission.mode = mode as CatalogAdmissionInput["mode"];
  p.draft.context.mode = mode;
  const routine = promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox";
  const extra = name.endsWith("extra selection") ? await fixture(packs[1]) : null;
  const before = await snapshot();
  try {
    if (name.endsWith("duplicate source")) {
      p.draft.lines = [p.draft.lines[0],p.draft.lines[0]];
      p.quote.quote.lines = [...p.draft.lines];
      p.draft.totals.subtotalGross = money(2468);
      p.draft.totals.totalGross = money(2468);
    }
    if (name.endsWith("quote quantity")) p.quote.quote.lines = [{ ...p.draft.lines[0],quantity: 3 }];
    if (extra) p.quote.catalogAdmission.skuRevisions = [...p.quote.catalogAdmission.skuRevisions,...extra.admission.skuRevisions];
    if (name.endsWith("winning entry") || name.endsWith("differs from the carrier")) {
      const selected = f.admission.priceContextVersions[0];
      const newEntry = (await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
        VALUES($1,$2,$3,617,statement_timestamp()-interval '1 minute') RETURNING to_jsonb(price_entries) AS entry`, [selected.priceListId,f.sku,mode])).rows[0].entry;
      if (name.endsWith("differs from the carrier")) {
        p.quote.catalogAdmission.priceContextVersions = [{ ...selected,entryId: newEntry.id,entry: newEntry }];
        p.quote.quote.lines = [{ ...p.draft.lines[0] }];
        Object.assign(p.quote.quote.lines[0],{ catalogFacts: {
          version: "catalog_facts_v1",skuId: f.sku,documentRevisionId: f.value.product.documentRevision!.id,
          documentDigest: f.head.documentDigest,basePriceEntryId: selected.entryId,resolvedPriceEntryId: selected.entryId,
          mode,atTime: f.at,currency: "XXX",baseUnitAmountMinor: 617,resolvedUnitAmountMinor: 617,resolvedLineAmountMinor: 1234,
        } });
      }
    }
    if (name.endsWith("duplicate entry")) {
      const entry = p.quote.catalogAdmission.priceContextVersions[0];
      p.quote.catalogAdmission.priceContextVersions = [entry,entry];
    }
    if (name.endsWith("orphan entry")) {
      const entry = p.quote.catalogAdmission.priceContextVersions[0];
      p.quote.catalogAdmission.priceContextVersions = [entry,{ ...entry,skuId: randomUUID() }];
    }
    await expect(rpc(db,routine,p.args)).rejects.toMatchObject({ message: reason,code });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await snapshot()).toEqual(before);
});

const purchaseAgreementRules = [
  { item: "LC6-D-032 unresolved source slot",text: "source_rows<>resolved_rows OR source_rows<>distinct_rows OR ",message: orderRefused,code: "22023" },
  { item: "LC6-D-033 repeated legacy quote line",text: "source_rows<>distinct_rows OR ",message: orderRefused,code: "22023" },
  { item: "LC6-D-034 quote-time publication stamp",text: "WHERE quoted.stamp IS NOT NULL AND quoted.stamp IS DISTINCT FROM",message: headMoved,code: "40001" },
] as const;
it.each(purchaseAgreementRules.flatMap(row => (["one_time","subscription"] as const).flatMap(mode =>
  [false,true].flatMap(promoted => [false,true].map(control => ({ ...row,mode,promoted,control }))))))(
  "$item in $mode, promoted=$promoted, control=$control", async ({ item,text,message,code,mode,promoted,control }) => {
    const f = await fixture(packs[0]), p = purchaseInput(f);
    p.draft.context.mode = mode;
    p.quote.catalogAdmission.mode = mode;
    if (item.includes("publication stamp")) {
      p.quote.quote.lines = [{ ...p.draft.lines[0] }];
      Object.assign(p.quote.quote.lines[0],{ catalogFacts: { publication: { productId: f.product,skuRevisionId: f.reference.skuRevisionId,
        head: { ...f.head,revision: f.head.revision-1 } } } });
    } else {
      const legacy = item.includes("repeated") ? await legacyFixture() : null;
      const line = { ...p.draft.lines[0],sku: legacy?.code ?? `missing-${randomUUID()}` };
      p.draft.lines = [...p.draft.lines,line,...(legacy ? [line] : [])];
      p.quote.quote.lines = [...p.draft.lines];
      p.draft.totals.subtotalGross = p.draft.totals.totalGross = money(p.draft.lines.length*1234);
    }
    const restore = control ? await hook(writerAdmissionSignature,sharedBoundary,"",body => {
      expect(body.split(text)).toHaveLength(2);
      return body.replace(text,text.startsWith("WHERE") ? "WHERE false AND quoted.stamp IS DISTINCT FROM" : "");
    }) : undefined;
    const db = await session(), before = await snapshot();
    try {
      const routine = promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox";
      const result = await tracked(rpc(db,routine,p.args));
      const exactRefusal = !result.ok && result.error?.code === code && result.error.message === message;
      expect(exactRefusal,result.ok ? "purchase accepted" : String(result.error?.message)).toBe(!control);
    } finally { await db.query("ROLLBACK"); db.release(); await restore?.(); }
    expect(await snapshot()).toEqual(before);
  },
);

it.each((["one_time","subscription"] as const).flatMap(mode =>
  [false,true].flatMap(promoted => [false,true].map(control => ({ mode,promoted,control })))))(
  "LC6-D-069 purchase busy refusal preserves state and the publisher retries in $mode, promoted=$promoted, control=$control",
  async ({ mode,promoted,control }) => {
    const f = await fixture(packs[0]), next = await changedDocument(f), p = purchaseInput(f);
    p.draft.context.mode = mode;
    p.quote.catalogAdmission.mode = mode;
    const h = await pool.connect(), e = await session(), w = await pool.connect(), stop = await gate(h), ep = await pid(e), hp = await pid(h);
    const routine = promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox";
    let restore = async () => {};
    try {
      restore = control ? await hook(writerAdmissionSignature,"BEGIN\n",stop.sql,body => {
        expect(body.split(sharedBoundary)).toHaveLength(2);
        return body.replace(sharedBoundary,"");
      }) : await hook(writerAdmissionSignature,sharedBoundary,stop.sql);
      const buying = tracked(rpc(e,routine,p.args));
      await blocker(h,ep,hp);
      const before = await snapshot(), first = await publishOn(w,next.publication);
      if (control) {
        expect(first).toMatchObject({ outcome: "committed" });
        await expect(assertBusy(first,before)).rejects.toThrow();
        await stop.release();
        expect(await buying).toMatchObject({ ok: false,error: { code: "40001",message: headMoved } });
        return;
      }
      await assertBusy(first,before);
      await stop.release();
      const result = await buying;
      if (!result.ok) throw result.error;
      await e.query("COMMIT");
      const order = result.value.orderDraft.orderId.slice(6);
      const retained = () => pool.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [order]);
      const accepted = [{ catalog_acceptance: { schemaVersion: 2,lines: [f.reference] } }];
      expect((await retained()).rows).toEqual(accepted);
      expect(await publishOn(w,next.publication)).toMatchObject({ outcome: "committed" });
      expect((await retained()).rows).toEqual(accepted);
    } finally { await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); await restore(); e.release(); w.release(); h.release(); }
  },
);

it.each((["one_time","subscription"] as const).flatMap(mode => [false,true].map(promoted => ({ mode,promoted }))))(
  "LC6-D-014 and LC6-D-142 mixed purchase proves its governed subset in $mode, promoted=$promoted", async ({ mode,promoted }) => {
  const governed = await fixture(packs[0]), legacy = await legacyFixture(), p = purchaseInput(governed), db = await session();
  const line = { ...p.draft.lines[0],sku: legacy.code };
  p.draft.context.mode = mode;
  p.quote.catalogAdmission.mode = mode;
  p.quote.quote.lines = [...p.quote.quote.lines,line];
  p.draft.lines = [...p.draft.lines,line];
  p.draft.totals.subtotalGross = money(2468);
  p.draft.totals.totalGross = money(2468);
  try {
    const routine = promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox";
    const result = await rpc(db,routine,p.args), orderId = result.orderDraft.orderId.slice(6);
    expect((await db.query("SELECT catalog_acceptance,total_amount_minor FROM public.commerce_orders WHERE id=$1", [orderId])).rows).toEqual([
      { catalog_acceptance: { schemaVersion: 2,lines: [governed.reference] },total_amount_minor: "2468" },
    ]);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it.each(lanes.flatMap(lane => [false,true].map(control => ({ lane,control }))))(
  "LC6-D-142 mixed account acceptance in $lane, control=$control", async ({ lane,control }) => {
    const f = await fixture(packs[0]), legacy = await legacyFixture();
    await pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
      SELECT price_list_id,$2,'any',617,statement_timestamp()-interval '1 day' FROM public.subscriptions WHERE id=$1`, [f.subscription,legacy.sku]);
    const command = await edit(f,lane,false,undefined,legacy);
    const restore = control ? await hook(writerAdmissionSignature,sharedBoundary,"",body => {
      const scope = "coalesce(jsonb_agg(s.id ORDER BY s.id) FILTER(WHERE s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb),'[]')";
      expect(body.split(scope)).toHaveLength(2);
      return body.replace(scope,"coalesce(jsonb_agg(s.id ORDER BY s.id),'[]')");
    }) : undefined;
    const db = await session();
    try {
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
        [f.actor,JSON.stringify({ sub: f.actor,role: "authenticated" })]);
      const applying = command.invoke(db);
      if (control) {
        await expect(applying).rejects.toMatchObject({ code: "55000",message: lane === "sized"
          ? "customer_self_service_invalid_catalog_head" : "catalog_propagation_head_unreadable" });
        return;
      }
      const accepted = await applying;
      expect(lane === "legacy" ? accepted.subscriptionAction.status : accepted.status).toBe("applied");
      expect((await db.query(`SELECT variant_id,quantity,catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1 ORDER BY sort_order`, [f.subscription])).rows)
        .toEqual([{ variant_id: f.sku,quantity: 2,catalog_sku_revision_id: f.reference.skuRevisionId },{ variant_id: legacy.sku,quantity: 1,catalog_sku_revision_id: null }]);
      expect((await db.query("SELECT catalog_acceptance FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscription])).rows)
        .toEqual([{ catalog_acceptance: { schemaVersion: 2,lines: [f.reference] } }]);
    } finally { await db.query("ROLLBACK"); db.release(); await restore?.(); }
  },
);

it.each(lanes)("LC6-D-063 and LC6-D-142 clearing the final governed line in %s", async lane => {
  const source = await fixture(packs[0]), next = await legacyFixture();
  const f = { ...source,sku: next.sku,code: next.code,admission: { ...source.admission,heads: [],skuRevisions: [],priceContextVersions: [] } };
  await pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    SELECT price_list_id,$2,'any',617,statement_timestamp()-interval '1 day' FROM public.subscriptions WHERE id=$1`, [source.subscription,next.sku]);
  const command = await edit(f,lane), db = await session();
  try {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.actor,role: "authenticated" })]);
    const result = await command.invoke(db);
    expect(lane === "legacy" ? result.subscriptionAction.status : result.status).toBe("applied");
    expect((await db.query("SELECT variant_id,catalog_sku_revision_id,quantity FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ variant_id: next.sku,catalog_sku_revision_id: null,quantity: 2 }]);
    expect((await db.query("SELECT catalog_acceptance FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ catalog_acceptance: null }]);
  } finally { await db.query("ROLLBACK"); db.release(); }
});


it.each((["one_time","subscription"] as const).flatMap(mode => [false,true].map(promoted => ({ mode,promoted }))))(
  "LC6-D-130 governed writing uses the qualified runtime in $mode, promoted=$promoted", async ({ mode,promoted }) => {
    const f = await fixture(packs[0]), p = purchaseInput(f);
    p.draft.context.mode = mode;
    p.quote.catalogAdmission.mode = mode;
    const routine = promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox";
    for (const role of ["anon","authenticated"] as const) {
      const db = await session();
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await expect(rpc(db,routine,p.args)).rejects.toMatchObject({ code: "42501",message: `permission denied for function ${routine}` });
      } finally { await db.query("ROLLBACK"); db.release(); }
    }
    const accepted = await rpc(runtime,routine,p.args), orderId = accepted.orderDraft.orderId.slice(6);
    expect((await pool.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [orderId])).rows)
      .toEqual([{ catalog_acceptance: { schemaVersion: 2,lines: [f.reference] } }]);
    const replay = await rpc(runtime,routine,p.args);
    expect(replay.orderDraft).toEqual({ ...accepted.orderDraft,replayed: true });
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.commerce_order_draft_receipts WHERE order_id=$1", [orderId])).rows)
      .toEqual([{ count: 1 }]);
  },
);

it.each((["one_time","subscription"] as const).flatMap(mode => [false,true].flatMap(promoted =>
  [false,true].map(control => ({ mode,promoted,control })))))(
  "LC6-D-036 concurrent first governed purchase in $mode, promoted=$promoted, control=$control", async ({ mode,promoted,control }) => {
    const f = await fixture(packs[0]), input = purchaseInput(f);
    input.draft.context.mode = mode;
    input.quote.catalogAdmission.mode = mode;
    const h = await pool.connect(), a = await runtime.connect(), b = await runtime.connect();
    const stop = await gate(h), ap = await pid(a), bp = await pid(b), hp = await pid(h);
    const routine = promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox";
    const keyGuard = "PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));";
    const boundary = "v_catalog_evidence:=p_quote_snapshot->'catalogAdmission';";
    const insertion = `IF pg_backend_pid()=${ap} THEN ${stop.sql} END IF;`;
    let restore = async () => {};
    try {
      const stopAtPurchase = promoted ? "IF FOUND AND v_receipt.invalidated_at IS NOT NULL THEN\n    RAISE EXCEPTION 'commerce_order_draft_expired' USING ERRCODE = '40001';\n  END IF;" : boundary;
      restore = await hook(`public.${routine}(text,jsonb,jsonb,uuid)`,stopAtPurchase,insertion,body => {
        expect(body.split(keyGuard)).toHaveLength(2);
        return control ? body.replace(keyGuard,"") : body;
      });
      const first = tracked(rpc(a,routine,input.args));
      await blocker(h,ap,hp);
      const second = tracked(rpc(b,routine,input.args));
      if (control) {
        const slipped = await second;
        expect(slipped).toMatchObject({ ok: true,value: { orderDraft: { replayed: false } } });
        await stop.release();
        const result = await first;
        if (promoted) expect(result).toMatchObject({ ok: true,value: { orderDraft: { replayed: true } } });
        else expect(result).toMatchObject({ ok: false,error: { code: "23505" } });
      } else {
        await blocker(h,bp,ap);
        await stop.release();
        const accepted = await first, replay = await second;
        if (!accepted.ok) throw accepted.error;
        expect(replay).toEqual({ ok: true,value: { ...accepted.value,orderDraft: { ...accepted.value.orderDraft,replayed: true } } });
      }
      expect((await h.query(`SELECT count(*)::integer AS receipts,count(e.id)::integer AS events
        FROM public.commerce_order_draft_receipts r JOIN public.outbox_events e ON e.aggregate_id=r.order_id
        WHERE r.idempotency_key=$1 AND e.event_type='commerce.order_draft.created'`, [input.args[0]])).rows)
        .toEqual([{ receipts: 1,events: 1 }]);
    } finally {
      await stop.release(); await a.query("ROLLBACK"); await b.query("ROLLBACK");
      await restore(); a.release(); b.release(); h.release();
    }
  },
);

it.each((["one_time","subscription"] as const).flatMap(mode => [false,true].flatMap(promoted =>
  [false,true].map(control => ({ mode,promoted,control })))))(
  "LC6-D-005 and LC6-D-148 guard before first-price classification in $mode, promoted=$promoted, control=$control",
  async ({ mode,promoted,control }) => {
    const f = await legacyFixture(), value = payload(randomUUID(),randomUUID(),packs[0]), sku = value.skus[0], code = sku.code!,
      draft = randomUUID(), h = await pool.connect(), buyer = await session(), publisher = await pool.connect();
    const stop = await gate(h), buyerPid = await pid(buyer), observerPid = await pid(h), p = purchaseInput(f);
    let restore = async () => {}, restoreGuard = async () => {};
    try {
      const pending = await candidate(publisher,value,draft,0,null);
      p.draft.context.mode = mode;
      p.draft.lines = [{ ...p.draft.lines[0],sku: code }];
      p.quote.quote.lines = p.draft.lines;
      delete (p.quote as Partial<typeof p.quote>).catalogAdmission;
      if (control) restoreGuard = await hook(writerAdmissionSignature,"INTO previously_governed;","",
        body => body.replace(sharedBoundary,""));
      restore = await hook("public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)",
        "v_public_quote:=p_quote_snapshot;",stop.sql);
      const writing = tracked(rpc(buyer,promoted ? "commerce_create_promoted_order_draft_with_outbox" : "commerce_create_order_draft_with_outbox",p.args));
      await blocker(h,buyerPid,observerPid);
      const before = await snapshot();
      const first = await pending.authority.publish(pending.publication,pending.actor);
      if (control) {
        expect(first.outcome).toBe("committed");
        if (!("receipt" in first)) throw new Error("first publication did not commit");
        await publisher.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
          SELECT price_list_id,$2,'any',617,statement_timestamp()-interval '1 minute' FROM public.subscriptions WHERE id=$1`, [f.subscription,sku.id]);
        value.product.sharedContent.catalogAction = "revise";
        value.product.sharedContent.requestedModes = [{ skuCode: code,modes: [mode] }];
        value.product.sharedContent.offerMemberships = [{ skuCode: code,offerVersion: "classic",admitted: true }];
        value.publication.operations = [
          { op: "set_offer_membership",skuCode: code,offerVersion: "classic",admitted: true },
          { op: "set_product_lifecycle",productSlug: value.product.slug!,expectedState: "draft",state: "active",children: [] },
          { op: "set_sku_lifecycle",skuCode: code,expectedState: "draft",state: "active" },
          { op: "set_eligibility",skuCode: code,sellableStandalone: mode === "one_time",sellableInSubscription: mode === "subscription" },
        ];
        const activation = await candidate(publisher,value,draft,1,first.receipt.head);
        expect(await activation.authority.publish(activation.publication,activation.actor)).toMatchObject({ outcome: "committed" });
        await stop.release();
        const accepted = await writing;
        if (!accepted.ok) throw accepted.error;
        expect((await buyer.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [accepted.value.orderDraft.orderId.slice(6)])).rows)
          .toEqual([{ catalog_acceptance: null }]);
      } else {
        expect(first).toMatchObject({ outcome: "conflict",reason: "catalog_publication_busy" });
        expect(await snapshot()).toEqual(before);
        await stop.release();
        const refused = await writing;
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error).toMatchObject({ code: "22023",message: "commerce_order_draft_catalog_price_changed" });
        await buyer.query("ROLLBACK");
        expect(await snapshot()).toEqual(before);
      }
    } finally {
      await stop.release(); await buyer.query("ROLLBACK"); await restore(); await restoreGuard(); buyer.release(); publisher.release(); h.release();
    }
  },
);

it.each([false,true])("LC6-D-070 mixed sized work locks the legacy SKU before price, control=%s", async control => {
  const f = await fixture(packs[0]), legacy = await legacyFixture(), command = await edit(f,"sized");
  const e = await session(), w = await session(), h = await pool.connect(), stop = await gate(h);
  const ep = await pid(e), wp = await pid(w), hp = await pid(h);
  const p = command.payload as ProbePayload;
  const prior = p.lines[0];
  const constraint = { kind: "unit_count",value: 3,dailyNeed: 1 };
  p.lines = [prior,{ ...prior,variantId: legacy.sku,qty: 1,quoteLine: {
    sku: legacy.code,quantity: 1,unitPriceGross: money(617),lineSubtotalGross: money(617),
  } }];
  p.compositionConstraint = constraint;
  p.request.compositionConstraint = constraint;
  p.request.resizeLever = { kind: "subscription.sized.parcel",value: {
    optInToSized: true,coreLines: [{ variantId: f.sku,qty: 2 },{ variantId: legacy.sku,qty: 1 }],
  } };
  let restore = async () => {};
  try {
    await ledger({ db: e,f,p,lane: "sized",command });
    await e.query("COMMIT");
    await e.query("BEGIN");
    const locked = "ORDER BY s.id FOR SHARE;";
    restore = await hook(admissionSignature,locked,stop.sql,body => control ? body.replace(
      " OR\n  (p_offer_evidence->>'lane'='sized' AND (p_offer_evidence->'legacySkuIds') ? s.id::text)","",
    ) : body);
    const editing = tracked(command.invoke(e));
    await blocker(h,ep,hp);
    const writing = tracked(w.query("UPDATE public.catalog_skus SET title=title||' revised' WHERE id=$1 RETURNING id", [legacy.sku]));
    if (control) expect(await writing).toMatchObject({ ok: true,value: { rowCount: 1 } });
    else await blocker(h,wp,ep);
    if (control) await w.query("ROLLBACK");
    await stop.release();
    const edited = await editing;
    if (!edited.ok) throw edited.error;
    expect(edited.value).toMatchObject({ status: "applied" });
    await e.query("ROLLBACK");
    if (!control) expect(await writing).toMatchObject({ ok: true,value: { rowCount: 1 } });
  } finally {
    await stop.release(); await e.query("ROLLBACK"); await w.query("ROLLBACK"); await restore(); e.release(); w.release(); h.release();
  }
});
