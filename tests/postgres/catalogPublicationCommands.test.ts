import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresCatalogDraftStoreV3,
  createPostgresCatalogPublicationCommands, createCatalogProductTypeRegistry, withCatalogPublicationRules,
  catalogDefinitionDigest, type CatalogPublicationCommand } from "@openlup/platform/catalog";
import { canonicalCatalogDraftJson, type CatalogDraftPayloadV3, type CatalogHeadRef } from "@openlup/platform/catalog/contracts";
import type { PgQueryExecutor } from "@openlup/platform/data";
import { publicationWireVectors } from "@openlup/platform/catalog/testing";
import type { CatalogPublishedSku } from "@openlup/platform/catalog";
import { canonicalCatalogPriceSetupCommand } from "@openlup/platform/pricing";
import { hash, transaction } from "./catalogPublicationFixture.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from "../helpers/postgresContainer.js";

let pool: Pool, container: PostgresContainer;
const actor = randomUUID(), otherActor = randomUUID();
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}
const artifact = Buffer.from(`
  const wire = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : 1)));
  module.exports = {
    validateContent: () => [],
    validateProduct: () => [],
    identifyDocument: ({ schemaVersion, id, productSlug, revisionNo, name }) =>
      ({ schemaId: "example:document.v" + schemaVersion, documentRef: id, productSlug, revisionNo, name }),
    inspectDocument(text) { return { ...this.identifyDocument(JSON.parse(text)), canonicallyEncoded: wire(JSON.parse(text)) === text }; },
    matchesDocument: (document, text) => wire(document) === text,
    deriveSkuFacts: () => ({ derived: 12 }),
    classifySkuChange: () => "compatible",
  };
`);
const registry = createCatalogProductTypeRegistry(withCatalogPublicationRules({ id: "example:rules", namespace: "example",
  version: 1, openlupRange: "1.x", capabilities: {}, taxClasses: [], types: [{
    key: "example:article", version: 1,
    units: [{ code: "openlup:g", dimension: "mass", integral: false }],
    netContentUnits: ["openlup:g"],
    dimensions: [{ key: "finish", kind: "choice", values: ["matte", "gloss"] }],
    axes: [{ key: "finish", attributeKey: "finish" }],
    attributes: [{ key: "finish", scope: "variant", valueType: { kind: "enum", values: [{ id: "matte" }, { id: "gloss" }] },
      required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }],
  }] },
() => artifact).types);
const installed = registry.resolve({ key: "example:article", version: 1 })!;
const installedDigest = catalogDefinitionDigest(installed);
beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-publication-commands-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Command proof needs PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as
    { baseline: { file: string }; forward: { file: string }[] };
  for (const unit of [manifest.baseline, ...manifest.forward]) {
    await pool.query(readFileSync(unit.file, "utf8"));
  }
  for (const [index, id] of [actor, otherActor].entries()) {
    await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [id, `operator-${index}@example.invalid`]);
    await pool.query(`INSERT INTO public.platform_human_memberships
      (principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',clock_timestamp())`, [id]);
  }
  await pool.query(`INSERT INTO public.catalog_type_versions(type_key,version,definition,definition_digest,validator_ref)
    VALUES($1,1,'{}',$2,$3)`, [installed.key, installedDigest, installed.validatorRef]);
  await pool.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX')
    ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`);
  await pool.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

function native(query?: (db: PgQueryExecutor, sql: string, args?: unknown[]) => ReturnType<PgQueryExecutor["query"]>) {
  let allowed = true;
  const api = createPostgresCatalogPublicationCommands({
    authorizeHuman: async (userId: string) => ({ ok: true, userId, role: "admin", isMachineActor: false }),
    catalogPublicationOwner: { run: work => transaction(pool, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      return work({ query: (sql, args) => query ? query(db, sql, args) : db.query(sql, args) });
    }) },
    registry: { resolve(type) {
      if (!allowed) throw new Error("Rules were read on replay");
      return registry.resolve(type);
    } },
  });
  return { ...api, disableRules() { allowed = false; } };
}
function authored(sequence: number) {
  const productId = randomUUID(), draftId = randomUUID(), skuId = randomUUID(), documentId = randomUUID();
  const slug = `article-${sequence}`, code = `ARTICLE-${sequence}`;
  const barcodePrefix = String(590123412340 + sequence);
  const checksum = [...barcodePrefix].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 === 0 ? 1 : 3), 0);
  const barcode = barcodePrefix + String((10 - checksum % 10) % 10);
  const document = { schemaVersion: 1, id: "example:document", productSlug: slug, revisionNo: 1, name: "Example article" };
  const canonicalText = canonicalCatalogDraftJson(document), digest = hash(canonicalText);
  const ref = { id: documentId, productId, revisionNo: 1, schemaId: "example:document.v1",
    sourceRef: "example:source", documentRef: document.id, digest };
  const facts = { skuCode: code, title: "Example article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  const identifier = { scheme: "gs1:gtin", issuer: "example", value: barcode, packagingLevel: "unit" as const };
  const payload: CatalogDraftPayloadV3 = { schemaVersion: 3, product: { id: productId, type: { key: installed.key, version: 1 },
    dimensions: ["finish"], slug, primarySkuId: skuId, documentRevision: ref,
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: {}, publicationSkus: [facts],
      requestedModes: [{ skuCode: code, modes: [] }], offerMemberships: [] } },
    skus: [{ id: skuId, productId, code, options: { finish: { kind: "choice", value: "matte" } }, identifiers: [identifier],
      netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 } }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: slug, name: document.name },
      { op: "register_document_revision", productSlug: slug, revisionId: documentId, revisionNo: 1,
        documentRef: ref.documentRef, sourceRef: ref.sourceRef, canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: slug, documentRevisionNo: 1 },
      { op: "create_sku", productSlug: slug, documentRevisionNo: 1, skuId, ...facts },
      { op: "create_identifier", skuCode: code, ...identifier, quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: slug, skuCode: code },
      { op: "set_product_presentation", productSlug: slug, presentation: {} },
    ] },
  };
  return { productId, draftId, skuId, slug, code, barcode, payload };
}
async function save(data: ReturnType<typeof authored>, revision: number, payload = data.payload) {
  const canonicalCommand = canonicalCatalogDraftJson({ schemaVersion: 3, action: revision === 1 ? "create" : "revise",
    draftId: data.draftId, commandKey: randomUUID(), expectedRevision: revision - 1, payload });
  const saved = await createPostgresCatalogDraftStoreV3(pool).apply({ canonicalCommand, fingerprint: hash(canonicalCommand), actorId: actor });
  if (!("record" in saved)) throw new Error(`Draft save failed: ${JSON.stringify(saved)}`);
  return saved.record;
}
async function prepare(data: ReturnType<typeof authored>, draftRevision: number, expectedHead: CatalogHeadRef | null) {
  const { productId, draftId } = data;
  const api = native();
  const candidate = await api.prepareCandidate({ draftId, draftRevision, expectedHead }, (await api.authorize(actor))!);
  if (!("candidateRef" in candidate)) throw new Error(JSON.stringify(candidate));
  const postStateDigest = candidate.preparation?.postStateDigest;
  if (!postStateDigest) throw new Error(`No structural seal: ${JSON.stringify(candidate.preparation)}`);
  const common = { productId, candidateRef: candidate.candidateRef, candidateDigest: candidate.candidateDigest };
  return {
    approve: { ...common, action: "approve", reason: null, commandKey: randomUUID(), postStateDigest } as const,
    revoke: { ...common, action: "revoke", reason: null, commandKey: randomUUID() } as const,
    publish: { ...common, action: "publish", expectedHead, changes: [], commandKey: randomUUID() } as const,
  } satisfies Record<string, CatalogPublicationCommand>;
}

it("commits the sealed plan, refuses revocation after issuance and replays without fresh reads or effects", async () => {
  const data = authored(1);
  await save(data, 1);
  const command = await prepare(data, 1, null);
  const queries: string[] = [];
  const api = native((db, sql, args) => { queries.push(sql); return db.query(sql, args); });
  const who = (await api.authorize(actor))!, other = (await api.authorize(otherActor))!;
  expect(await api.execute(command.revoke, who)).toMatchObject({ outcome: "conflict", reason: "publication_approval_missing" });
  expect(await api.execute({ ...command.approve, postStateDigest: "0".repeat(64) }, who))
    .toMatchObject({ outcome: "conflict", reason: "publication_post_state_changed" });
  const approval = await api.execute(command.approve, who);
  expect(approval).toMatchObject({ outcome: "committed", receipt: { postStateDigest: command.approve.postStateDigest,
    decidedAt: /[.][0-9]{6}Z$/u } });
  const first = await api.execute(command.publish, who);
  expect(first).toMatchObject({ outcome: "committed", receipt: { head: { revision: 1 }, changes: [{ variantId: data.skuId }] } });
  expect(await api.execute(command.revoke, who)).toEqual({ outcome: "conflict", reason: "publication_candidate_already_issued",
    message: "This candidate is already issued; revoking it has no effect. No action is needed." });
  expect(await api.execute(command.publish, other)).toMatchObject({ outcome: "unauthorized" });
  expect(await api.execute({ ...command.revoke, commandKey: command.approve.commandKey }, who))
    .toMatchObject({ outcome: "conflict", reason: "publication_command_key_reused" });
  api.disableRules();
  queries.length = 0;
  expect(await api.execute(command.approve, who)).toEqual({ ...approval, outcome: "replayed" });
  expect(await api.execute(command.publish, who)).toEqual({ ...first, outcome: "replayed" });
  expect(queries.join("\n")).not.toMatch(/catalog_draft_heads|catalog_type_versions|catalog_price_setup_(claim|apply)|\b(INSERT|UPDATE|LOCK TABLE)\b/u);
  expect((await pool.query(`SELECT event_type FROM public.outbox_events WHERE aggregate_id=$1`, [data.productId])).rows)
    .toEqual([{ event_type: "catalog.publication.committed" }]);
});

it("lets a new compensation issue equal business facts while retaining unchanged SKU revisions", async () => {
  const data = authored(2);
  const secondary = { scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" as const };
  data.payload.skus[0]!.identifiers!.push(secondary);
  data.payload.publication.operations.splice(5, 0, { op: "create_identifier", skuCode: data.code,
    ...secondary, quantity: 1, isPrimary: false, label: null, sourceRef: null });
  await save(data, 1);
  const original = await prepare(data, 1, null);
  const api = native(), who = (await api.authorize(actor))!;
  expect(await api.execute(original.approve, who)).toMatchObject({ outcome: "committed" });
  const issue = await api.execute(original.publish, who);
  if (!("receipt" in issue) || !("head" in issue.receipt)) throw new Error(JSON.stringify(issue));
  const repaired = structuredClone(data.payload);
  repaired.product.sharedContent.catalogAction = "revise";
  repaired.publication = { kind: "compensation", evidence: {},
    operations: [{ op: "set_product_presentation", productSlug: data.slug, presentation: {} }] };
  await save(data, 2, repaired);
  await pool.query("UPDATE public.catalog_products SET name='Unpublished drift' WHERE id=$1", [data.productId]);
  const gtins = [data.barcode, secondary.value].map(value => value.padStart(14, "0"));
  await transaction(pool, async db => {
    await db.query("UPDATE public.catalog_sku_identifiers SET is_primary=false WHERE catalog_sku_id=$1", [data.skuId]);
    await db.query("UPDATE public.catalog_sku_identifiers SET is_primary=true WHERE catalog_sku_id=$1 AND normalized_value=$2", [data.skuId, gtins[1]]);
  });
  const commands = await prepare(data, 2, issue.receipt.head);
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(commands.publish, who)).toMatchObject({ outcome: "committed",
    receipt: { head: { revision: 2 }, previousHead: issue.receipt.head, changes: [] } });
  expect((await pool.query(`SELECT revision,issued_count FROM public.catalog_publications WHERE product_id=$1 ORDER BY revision`,
    [data.productId])).rows).toEqual([{ revision: 1, issued_count: 1 }, { revision: 2, issued_count: 0 }]);
  expect((await pool.query("SELECT normalized_value FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1 AND is_primary",
    [data.skuId])).rows).toEqual([{ normalized_value: gtins[0] }]);
  expect(await api.execute(original.publish, who)).toEqual({ ...issue, outcome: "replayed" });
});

it.each([[13, "matching"], [14, "cleared"]] as const)(
  "a fresh publish compares live code with the sealed SKU (%s: %s cache)", async (sequence, cache) => {
    const data = authored(sequence), api = native(), who = (await api.authorize(actor))!;
    await save(data, 1);
    const initial = await prepare(data, 1, null);
    expect(await api.execute(initial.approve, who)).toMatchObject({ outcome: "committed" });
    const issued = await api.execute(initial.publish, who);
    if (!("receipt" in issued) || !("head" in issued.receipt)) throw new Error(JSON.stringify(issued));
    const payload = structuredClone(data.payload);
    payload.product.sharedContent.catalogAction = "revise";
    payload.product.sharedContent.presentation = { routePath: { en: `/new-${sequence}` } };
    payload.publication.operations = [{ op: "set_product_presentation", productSlug: data.slug,
      presentation: payload.product.sharedContent.presentation }];
    await save(data, 2, payload);
    const next = await prepare(data, 2, issued.receipt.head);
    expect(await api.execute(next.approve, who)).toMatchObject({ outcome: "committed" });
    await pool.query(`UPDATE public.catalog_skus SET sku=$2, publication_facts=CASE WHEN $3::boolean
      THEN jsonb_set(publication_facts,'{code}',to_jsonb($2::text)) END WHERE id=$1`,
    [data.skuId, `RENAMED-${sequence}`, cache === "matching"]);
    expect(await api.execute(next.publish, who)).toMatchObject({ outcome: "conflict", reason: "publication_sku_identity_changed",
      message: "A SKU code differs from its published identity. Restore the saved code or prepare a new SKU." });
  });

it("resamples legacy GTINs committed between the first read and the catalogue fence", async () => {
  const data = authored(3);
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  const api = native(), who = (await api.authorize(actor))!;
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  let crossed = false;
  const publisher = native(async (db, sql, args) => {
    if (sql.startsWith("LOCK TABLE")) {
      crossed = true;
      // The host defaults to repeatable read. The runner chooses READ COMMITTED
      // before authenticating and then observes the other's committed legacy row.
      await transaction(pool, async other => {
        const id = randomUUID();
        await other.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'legacy-gtin','Legacy article')", [id]);
        await other.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_standalone) VALUES($1,$1,'LEGACY','Legacy article','draft',false)", [id]);
        await other.query(`INSERT INTO public.catalog_sku_identifiers
          (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity)
          VALUES($1,'legacy','gtin',$2,'unit',1)`, [id, data.barcode]);
      });
    }
    return db.query(sql, args);
  });
  const publisherCapability = (await publisher.authorize(actor))!;
  expect(await publisher.execute(commands.publish, publisherCapability)).toMatchObject({ outcome: "conflict", reason: "publication_gtin_conflict" });
  expect(crossed).toBe(true);
  expect((await pool.query("SELECT id FROM public.catalog_products WHERE id=$1", [data.productId])).rows).toEqual([]);
});

it("waits for the draft-head write conflict before taking a decision timestamp", async () => {
  const data = authored(4);
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  const blocker = await pool.connect();
  const started = latch();
  let settled = false;
  const api = native((db, sql, args) => {
    const result = db.query(sql, args);
    if (sql.includes("ORDER BY draft_id FOR NO KEY UPDATE")) started.resolve();
    return result;
  });
  const who = (await api.authorize(actor))!;
  await blocker.query("BEGIN");
  try {
    await blocker.query("UPDATE public.catalog_draft_heads SET revision=revision WHERE draft_id=$1", [data.draftId]);
    const decision = api.execute(commands.approve, who).finally(() => { settled = true; });
    await started.promise;
    const stamp = (await blocker.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`)).rows[0].time;
    expect(settled).toBe(false);
    await blocker.query("COMMIT");
    const result = await decision;
    if (!("receipt" in result) || !("decidedAt" in result.receipt)) throw new Error(JSON.stringify(result));
    expect(result.receipt.decidedAt > stamp).toBe(true);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

it("keeps issuer helpers owner-only while preserving the released price wrapper grant", async () => {
  const { rows } = await pool.query(`SELECT role, signature, has_function_privilege(role,signature,'EXECUTE') AS allowed
    FROM unnest(ARRAY['anon','authenticated']) AS roles(role) CROSS JOIN unnest(ARRAY[
      'public.catalog_publication_record_command(jsonb)','public.catalog_price_setup_claim(text,text)',
      'public.catalog_price_setup_lock_context(uuid,uuid)','public.catalog_price_setup_apply_claimed(jsonb,timestamptz)',
      'public.catalog_price_setup_apply(text,text)']) AS functions(signature)`);
  expect(rows.filter(row => row.allowed)).toEqual([{ role: "authenticated", signature: "public.catalog_price_setup_apply(text,text)", allowed: true }]);
});

it("seals the new issue's receipt on a SKU physically authored in a retained draft revision", async () => {
  const data = authored(5);
  const genesis = structuredClone(data.payload);
  const retainedId = randomUUID(), retainedCode = "RETAINED-5";
  const base = structuredClone(genesis.skus[0]!);
  genesis.skus = [{ ...base, id: retainedId, code: retainedCode, options: { finish: { kind: "choice", value: "gloss" } }, identifiers: [] }];
  genesis.product.primarySkuId = retainedId;
  const retainedFacts = { skuCode: retainedCode, title: "Retained choice", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  genesis.product.sharedContent.publicationSkus = [retainedFacts];
  genesis.product.sharedContent.requestedModes = [];
  genesis.publication.operations = [];
  const original = await save(data, 1, genesis);

  const payload = structuredClone(data.payload);
  payload.publication.evidence.drafts = [{ draftId: original.draftId, revision: original.revision,
    commandKey: original.commandKey, fingerprint: original.fingerprint }];
  payload.publication.operations.push({ op: "create_sku", productSlug: data.slug, skuId: retainedId,
    documentRevisionNo: 1, ...retainedFacts });
  const issuing = await save(data, 2, payload);
  const commands = await prepare(data, 2, null);
  const api = native(), who = (await api.authorize(actor))!;
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(commands.publish, who)).toMatchObject({ outcome: "committed" });
  expect((await pool.query("SELECT full_facts::jsonb->'source' AS claim FROM public.catalog_sku_revisions WHERE sku_id=$1",
    [retainedId])).rows).toEqual([{ claim: { draftId: issuing.draftId, revision: issuing.revision,
    commandKey: issuing.commandKey, fingerprint: issuing.fingerprint } }]);
});

it.each([[6, "inactive"], [15, "missing"], [16, "expired"], [17, "wrong settlement"]] as const)(
  "rolls back a completed child price when the later list is refused (%s: %s)", async (sequence, problem) => {
  const data = authored(sequence);
  const goodList = randomUUID(), inactiveList = randomUUID();
  await pool.query(`INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from)
    VALUES($1,'First','ZZ','XXX','active',statement_timestamp()-interval '1 hour')`, [goodList]);
  if (problem !== "missing") await pool.query(`INSERT INTO public.price_lists(id,name,region_code,currency,status,valid_from,valid_to)
    VALUES($1,'Second',$2,'XXX',$3,statement_timestamp()-interval '1 hour',
      CASE WHEN $4::boolean THEN statement_timestamp()-interval '1 minute' END)`,
  [inactiveList, problem === "wrong settlement" ? "XY" : "ZZ", problem === "inactive" ? "draft" : "active", problem === "expired"]);
  const child = { schemaVersion: 1, variantId: data.skuId, mode: "one_time", minQty: 1, amountKind: "gross",
    unitPriceMinor: 1733, expected: { entryId: null, unitPriceMinor: null } } as const;
  data.payload.skus[0]!.priceOperations = [
    { ...child, commandKey: `publication-first-${sequence}`, priceListId: goodList },
    { ...child, commandKey: `publication-second-${sequence}`, priceListId: inactiveList },
  ];
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  let changed = 0;
  let sqlFailure: string | undefined;
  const api = native(async (db, sql, args) => {
    const result = await db.query(sql, args).catch((error: Error) => { sqlFailure = error.message; throw error; });
    if (sql.startsWith("SELECT public.catalog_price_setup_apply_claimed") &&
        (result.rows[0]?.result as { outcome?: string } | undefined)?.outcome === "committed") changed++;
    return result;
  });
  const who = (await api.authorize(actor))!;
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(commands.publish, who), sqlFailure).toMatchObject(problem === "missing"
    ? { outcome: "validation_issue", reason: "price_list_not_found",
      message: "Select an installed, effective price list for the settlement region and currency, then prepare the draft again." }
    : { outcome: "validation_issue", reason: "price_list_not_active",
      message: "Activate the intended price list or select an effective list for the settlement region and currency." });
  expect(changed).toBe(1);
  expect((await pool.query("SELECT id FROM public.price_entries WHERE variant_id=$1", [data.skuId])).rows).toEqual([]);
  expect((await pool.query("SELECT idempotency_key FROM public.catalog_price_setup_receipts WHERE idempotency_key LIKE $1",
    [`publication-%-${sequence}`])).rows).toEqual([]);
  expect((await pool.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1", [data.productId])).rows).toEqual([]);
  if (problem === "inactive") {
    await pool.query("UPDATE public.price_lists SET status='active' WHERE id=$1", [inactiveList]);
    expect(await api.execute(commands.publish, who)).toMatchObject({ outcome: "committed" });
    expect((await pool.query("SELECT unit_price_minor FROM public.price_entries WHERE variant_id=$1", [data.skuId])).rows)
      .toEqual([{ unit_price_minor: 1733 }, { unit_price_minor: 1733 }]);
  }
});

it.each(["publish", "revoke"] as const)("serializes %s before the competing command", async first => {
  const data = authored(first === "publish" ? 7 : 8);
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  const inserted = latch(), release = latch(), waiting = latch();
  const leader = native(async (db, sql, args) => {
    const result = await db.query(sql, args);
    if (sql.startsWith("SELECT public.catalog_publication_record_command") &&
      JSON.parse(String(args?.[0])).action === first) {
      inserted.resolve();
      await release.promise;
    }
    return result;
  });
  const who = (await leader.authorize(actor))!;
  expect(await leader.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  const follower = native((db, sql, args) => {
    const result = db.query(sql, args);
    if (sql.includes("pg_advisory_xact_lock")) waiting.resolve();
    return result;
  });
  const claimant = (await follower.authorize(actor))!;
  const winner = leader.execute(commands[first], who);
  await Promise.race([inserted.promise, winner.then(result => { throw new Error(JSON.stringify(result)); })]);
  const next = follower.execute(first === "publish" ? commands.revoke : commands.publish, claimant);
  try { await waiting.promise; } finally { release.resolve(); }
  expect(await winner).toMatchObject({ outcome: "committed" });
  expect(await next).toMatchObject({ outcome: "conflict",
    reason: first === "publish" ? "publication_candidate_already_issued" : "publication_approval_missing" });
});

it("enforces marked GTIN uniqueness and still admits a later legacy unmarked identifier", async () => {
  const data = authored(9);
  await save(data, 1);
  const commands = await prepare(data, 1, null);
  const api = native(), who = (await api.authorize(actor))!;
  expect(await api.execute(commands.approve, who)).toMatchObject({ outcome: "committed" });
  expect(await api.execute(commands.publish, who)).toMatchObject({ outcome: "committed" });
  const other = randomUUID();
  await pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'later-legacy','Legacy article')", [other]);
  await pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_standalone) VALUES($1,$1,'LATER-LEGACY','Legacy article','draft',false)", [other]);
  const insert = (marker: string | null) => pool.query(`INSERT INTO public.catalog_sku_identifiers
    (catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,scheme)
    VALUES($1,'later-legacy','gtin',$2,'unit',1,$3)`, [other, data.barcode.padStart(14, "0"), marker]);
  await expect(insert("gs1:gtin")).rejects.toMatchObject({ code: "23505", constraint: "catalog_publication_gtin_key" });
  await expect(insert(null)).resolves.toMatchObject({ rowCount: 1 });
  expect((await pool.query("SELECT scheme FROM public.catalog_sku_identifiers WHERE catalog_sku_id=$1", [data.skuId])).rows)
    .toEqual([{ scheme: "gs1:gtin" }]);
});

it.each([
  ["document", "publication_document_required", 10],
  ["primarySkuId", "publication_primary_sku_required", 11],
  ["reserved carrier", "publication_reserved_carrier", 12],
] as const)("refuses %s before calling the recorder", async (field, reason, sequence) => {
  const data = authored(sequence);
  if (field === "reserved carrier") {
    const vector = publicationWireVectors.find(item => item.name === "reserved scalar in nested facts")!;
    const entry = data.payload.product.sharedContent.publicationSkus[0]!;
    entry.facts = vector.apply({ facts: entry.facts } as CatalogPublishedSku).facts as typeof entry.facts;
  } else {
    const skip = field === "document"
      ? ["move_document_pointer", "create_sku", "create_identifier", "set_primary_sku"] : ["set_primary_sku"];
    data.payload.publication.operations = data.payload.publication.operations.filter(operation => !skip.includes(operation.op));
  }
  await save(data, 1);
  const called: string[] = [];
  const api = native((db, sql, args) => { called.push(sql); return db.query(sql, args); });
  const who = (await api.authorize(actor))!;
  const preview = await api.prepareCandidate({ draftId: data.draftId, draftRevision: 1, expectedHead: null }, who);
  if (!("candidateRef" in preview)) throw new Error(JSON.stringify(preview));
  const { candidateRef, candidateDigest } = preview;
  expect(await api.execute({ candidateRef, candidateDigest, productId: data.productId, action: "approve",
    commandKey: randomUUID(), postStateDigest: "a".repeat(64) }, who)).toMatchObject({
    outcome: "validation_issue", reason, path: field === "reserved carrier" ?
      "product.sharedContent.publicationSkus.0.facts.values.0.cANonical_TeXt" : `product.${field}`,
  });
  expect(called.every(query => !query.includes("catalog_publication_record_command"))).toBe(true);
});

describe("publication activation prices", () => {
  const listId = randomUUID();
  beforeAll(async () => {
    await pool.query("UPDATE public.price_lists SET status='draft' WHERE status='active'");
    await pool.query(`INSERT INTO public.price_lists(id,name,region_code,currency,valid_from)
      VALUES($1,'Effective list','ZZ','XXX',statement_timestamp()-interval '1 hour')`, [listId]);
    await pool.query(`INSERT INTO public.subscription_price_policy_revisions
      (id,revision_no,price_list_id,region_code,currency,channel,effective_from,discount_bps,rounding_quantum_minor,rounding_rule,digest)
      SELECT id,1,$1,'ZZ','XXX','D2C',at,1000,10,'FLOOR_TO_QUANTUM',
        public.catalog_price_setup_policy_digest(id,1,$1,'ZZ','XXX','D2C',at,NULL,1000,10,'FLOOR_TO_QUANTUM')
      FROM (SELECT gen_random_uuid() AS id,date_trunc('milliseconds',statement_timestamp()-interval '1 hour') AS at) timing`, [listId]);
    const base = randomUUID();
    await pool.query("INSERT INTO public.catalog_products(id,slug,name,status) VALUES($1,'priced-core','Core item','active')", [base]);
    await pool.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,status,sellable_standalone)
      VALUES($1,$1,'PRICED-CORE','Core item','active',true)`, [base]);
    await seedBasePrice(base);
    const promotion = {
      status: "active", trigger_type: "automatic", code: null, discount_type: "percentage", applies_to_kind: "order_total",
      valid_from: "2020-01-01T00:00:00Z", valid_to: null, redemption_limit_global: null,
      region_availability: ["ZZ"], benefit_lane: "product", benefit_value_minor: null, v2_mirror_of: null,
    };
    for (const definition of [
      { ...promotion, id: "example:acquisition", promotion_engine_version: "promotion-engine.v2",
        discount_value: 50, stacking_rule: "exclusive", redemption_limit_per_customer: 1, benefit_kind: "target_percentage",
        benefit_value_bps: 5000, eligibility: { first_subscription_purchase: true },
        applies_to_payload: { cart_mode: "subscription", acquisitionTerms: {
          schemaVersion: "subscription-acquisition.v1", revision: "example:terms-1", delivery2DiscountBps: 3500,
        } } },
      { ...promotion, id: "example:bundle", promotion_engine_version: "promotion-engine.v1",
        discount_value: 5, stacking_rule: "stackable_with_any", redemption_limit_per_customer: null, benefit_kind: "percentage",
        benefit_value_bps: 500, eligibility: { min_cart_minor: 12000 }, applies_to_payload: { cart_mode: "one_time" } },
    ]) {
      const text = JSON.stringify(definition);
      await pool.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id,definition_fingerprint,definition,active)
        VALUES($1,$2,$3,true)`, [definition.id, hash(text), text]);
    }
    await pool.query(`INSERT INTO public.platform_job_controls(job_name,active_driver,enabled,last_status,last_success_at,metadata)
      VALUES('platform-watchdog','worker',true,'success',statement_timestamp(),'{"promotionReady":true}'),
      ('promotion-claim-sweep','worker',true,'success',statement_timestamp(),'{}')
      ON CONFLICT(job_name) DO UPDATE SET enabled=excluded.enabled,last_status=excluded.last_status,
        last_success_at=excluded.last_success_at,metadata=excluded.metadata`);
    expect((await pool.query("SELECT public.commerce_offer_policy_v2_readiness() AS result")).rows[0]?.result)
      .toMatchObject({ ready: true, reasons: [] });
  });

  async function seedBasePrice(skuId: string) {
    const id = randomUUID();
    await pool.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,unit_price_minor,valid_from)
      VALUES($1,$2,$3,'one_time',1000,statement_timestamp()-interval '1 minute')`, [id, listId, skuId]);
    return id;
  }

  async function approvedActivation(sequence: number, isAddon: boolean) {
    const data = authored(sequence), api = native(), who = (await api.authorize(actor))!;
    const sku = data.payload.skus[0]!;
    sku.grossMass = { ...sku.netContent!, unscaled: "110" };
    sku.logisticsRef = "example:logistics";
    data.payload.product.sharedContent.publicationSkus[0]!.isAddon = isAddon;
    const create = data.payload.publication.operations.find(operation => operation.op === "create_sku")!;
    create.isAddon = isAddon;
    data.payload.publication.operations.push({ op: "set_sku_metadata", skuCode: data.code, logisticsRef: sku.logisticsRef });
    await save(data, 1);
    const first = await prepare(data, 1, null);
    expect(await api.execute(first.approve, who)).toMatchObject({ outcome: "committed" });
    const issue = await api.execute(first.publish, who);
    if (!("receipt" in issue) || !("head" in issue.receipt)) throw new Error(JSON.stringify(issue));

    const payload = structuredClone(data.payload);
    const membership = { skuCode: data.code, admitted: true, offerVersion: "example:open" };
    const content = payload.product.sharedContent;
    content.catalogAction = "revise";
    content.offerMemberships = [membership];
    content.requestedModes = [{ skuCode: data.code, modes: ["one_time"] }];
    payload.publication.operations = [
      { op: "set_product_status", productSlug: data.slug, status: "active" },
      { op: "set_sku_status", skuCode: data.code, status: "active" },
      { op: "set_eligibility", skuCode: data.code, sellableStandalone: true, sellableInSubscription: false },
      { op: "set_offer_membership", ...membership },
    ];
    await save(data, 2, payload);
    const next = await prepare(data, 2, issue.receipt.head);
    expect(await api.execute(next.approve, who)).toMatchObject({ outcome: "committed" });
    return { ...data, api, who, command: next.publish, head: issue.receipt.head };
  }

  it("refuses an unpriced add-on even when the store passes readiness and rolls back activation", async () => {
    const { api, who, command, code, skuId, productId, head } = await approvedActivation(18, true);
    expect(await api.execute(command, who)).toMatchObject({ outcome: "validation_issue", reason: "publication_sku_price_not_ready",
      message: expect.stringContaining(`SKU ${code}. Set a positive gross base price`) });
    expect((await pool.query(`SELECT s.status,s.sellable_standalone,p.status AS product_status,h.publication_id
      FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
      JOIN public.catalog_publication_heads h USING(product_id) WHERE s.id=$1`, [skuId])).rows)
      .toEqual([{ status: "draft", sellable_standalone: false, product_status: "draft", publication_id: head.publicationId }]);
    expect((await pool.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1", [productId])).rows).toHaveLength(1);
    expect((await pool.query("SELECT command_key FROM public.catalog_operator_receipts WHERE scope_id=$1 AND command_key=$2",
      [productId, command.commandKey])).rows).toEqual([]);
    await seedBasePrice(skuId);
    const override = (await pool.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
      VALUES($1,$2,'any',1000,statement_timestamp()-interval '1 minute') RETURNING id`, [listId, skuId])).rows[0]?.id;
    expect(await api.execute(command, who)).toMatchObject({ outcome: "validation_issue", reason: "publication_sku_price_shape_invalid",
      message: expect.stringContaining(`SKU ${code}. Use gross one-time or subscription pricing`) });
    await pool.query("DELETE FROM public.price_entries WHERE id=$1", [override]);
    expect(await api.execute(command, who)).toMatchObject({ outcome: "committed" });
  });

  it("holds the reused LC3 context after readiness and through issuance", async () => {
    const { command, skuId } = await approvedActivation(19, false);
    const entryId = await seedBasePrice(skuId);
    const read = latch(), issue = latch();
    const publisher = native(async (db, sql, args) => {
      const result = await db.query(sql, args);
      if (sql.startsWith("SELECT public.commerce_offer_policy_v2_readiness()")) {
        read.resolve();
        await issue.promise;
      }
      return result;
    });
    const pending = publisher.execute(command, (await publisher.authorize(actor))!);
    const text = canonicalCatalogPriceSetupCommand({ schemaVersion: 1, commandKey: randomUUID(), variantId: skuId,
      priceListId: listId, mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 1,
      expected: { entryId, unitPriceMinor: 1000 } });
    const price = () => transaction(pool, async db => {
      await db.query("SET LOCAL lock_timeout='500ms'");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: otherActor, role: "authenticated" })]);
      return db.query("SELECT public.catalog_price_setup_apply($1,$2)", [text, hash(text)]);
    });
    try {
      await Promise.race([read.promise, pending.then(result => { throw new Error(JSON.stringify(result)); })]);
      await expect(price()).rejects.toMatchObject({ code: "55P03", where: expect.stringContaining("catalog_price_setup_lock_context") });
    } finally {
      issue.resolve();
      await pending;
    }
    expect(await pending).toMatchObject({ outcome: "committed" });
    await expect(price()).rejects.toMatchObject({ message: "catalog_price_setup_readiness_would_fail" });
  });
});
