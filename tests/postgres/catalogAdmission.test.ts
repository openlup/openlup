import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresAcquisitionCheckoutPersistence, createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import { createPostgresCommercePriceAuthorityReadPort } from "@openlup/platform/commerce/server/postgres";
import { createPostgresCatalogAdmission } from "@openlup/platform/catalog";
import * as pricing from "@openlup/platform/pricing";
import { buildCatalogOwnerQuote, withCatalogAdmissionFence } from "@openlup/platform/catalog/testing";
import { actorId, fixture, graph, hash, insertGraph, installPublicationActors, projectOfferOnlyMembership, stageProductRows, transaction, type Graph } from "./catalogPublicationFixture.js";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { checkoutOwnerRoutines, selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { proveRuntimeCheckout, watchRuntimeCheckoutAclDelta } from "./catalogRuntimeCheckout.proof.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";

let env: LifecycleInstallation;
let issued: Graph;
let clientId: string;
let priceListId: string;
let inactivePriceListId: string;
let legacyId: ReturnType<typeof randomUUID>;
let archivedId: string;
const legacySku = "ARTICLE-LEGACY";
const archivedSku = "ARTICLE-ARCHIVED";
const closed = {
  code: "55000", message: "catalog_admission_quote_authority_required",
  hint: "Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.",
};
const checkLegacy = "SELECT public.catalog_admission_check_legacy_draft($1,$2,$3,$4)";
const legacyLocks = [true, false, null];
const levels = ["READ COMMITTED", "REPEATABLE READ"] as const;
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });

beforeAll(async () => {
  // Fresh cluster: withCatalogAdmissionFence compares cluster-wide pg_current_snapshot() xmax/xip.
  env = await lifecycleInstallation("qualified-v2", { freshCluster: true });
  await installPublicationActors(env.owner);
  issued = await transaction(env.owner, async db => {
    const value = await graph(db, fixture(), null, true, { lifecycle: "active" });
    await insertGraph(db, value);
    return value;
  });
  clientId = (await env.owner.query("INSERT INTO public.clients(email) VALUES('buyer@example.invalid') RETURNING id")).rows[0]!.id;
  legacyId = randomUUID();
  await env.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'legacy-article','Legacy article')", [legacyId]);
  await env.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Legacy article')", [legacyId, legacySku]);
  archivedId = (await env.owner.query(`INSERT INTO public.catalog_skus(product_id,sku,title,status,sellable_standalone)
    VALUES($1,$2,'Archived article','archived',false) RETURNING id`, [legacyId, archivedSku])).rows[0]!.id;
  priceListId = (await env.owner.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Example','ZZ','XXX') RETURNING id")).rows[0]!.id;
  inactivePriceListId = (await env.owner.query(`INSERT INTO public.price_lists(name,region_code,currency,status)
    VALUES('Inactive candidate','ZZ','XXX','archived') RETURNING id`)).rows[0]!.id;
  await env.owner.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX') ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text");
  await env.owner.query("SELECT public.commerce_capture_offer_policy_v2_legacy_baseline()");
  await env.owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,mode)
    SELECT $1,id,125,'one_time' FROM public.catalog_skus WHERE id=ANY($2::uuid[])`, [priceListId, [legacyId, issued.skuId]]);
}, postgresSetupTimeoutMs);
afterAll(() => env?.close(), postgresTeardownTimeoutMs);

it.each([false, true])("installs the native checkout ACL with service group present: %s", async serviceRole => {
  const container = await runPostgresContainer({ name: `catalog-legacy-acl-${serviceRole}-${process.pid}`, password: "synthetic-conformance" });
  const owner = new Pool({ connectionString: container.connectionString });
  const assertAclDelta = watchRuntimeCheckoutAclDelta(owner);
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native catalogue PostgreSQL unavailable");
    if (serviceRole) {
      // The optional cluster role is outside the canonical legacy inventory.
      await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
      const plan = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "legacy");
      const db = await owner.connect();
      try {
        for (const { file } of [plan.baseline, ...plan.forward]) await db.query(readFileSync(file, "utf8"));
      } finally { db.release(); }
    } else {
      await createPostgresMigrationRunner({ connectionString: container.connectionString }, {
        installation: { generation: "legacy" }, poolFactory: () => owner,
      }).apply();
    }
    assertAclDelta();
    await proveRuntimeCheckout(owner, owner, "postgres", [], serviceRole);
  } finally { await closePostgres(container, owner); }
}, postgresSetupTimeoutMs);

const quote = (sku: string): pricing.CreateQuoteResponse => {
  const amount = { amountMinor: 125, currency: "XXX" };
  const none = { amountMinor: 0, currency: "XXX" };
  return { contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true,
    context: { mode: "one_time", promoCodes: [] }, lines: [{ sku, productSlug: "example-article", quantity: 1,
      unitPriceGross: amount, lineSubtotalGross: amount, tax: { included: true, country: "ZZ", category: "standard",
        vatRateBps: 0, netAmount: amount, vatAmount: none, grossAmount: amount, legalBasis: "Example" } }],
    discounts: [], subtotalGross: amount, discountTotalGross: none, totalGross: amount, netTotal: amount, taxTotal: none } };
};
const draft = (snapshot: pricing.CreateQuoteResponse) => ({ contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0",
  status: "draft", paymentStatus: "not_started", currency: "XXX", context: snapshot.quote.context,
  lines: snapshot.quote.lines, discounts: snapshot.quote.discounts, totals: {
    subtotalGross: snapshot.quote.subtotalGross, discountTotalGross: snapshot.quote.discountTotalGross,
    totalGross: snapshot.quote.totalGross,
  } });

async function counts() {
  return (await env.owner.query(`SELECT (SELECT count(*) FROM public.commerce_orders) AS orders,
    (SELECT count(*) FROM public.commerce_order_draft_receipts) AS receipts,
    (SELECT count(*) FROM public.commerce_settlement_intents) AS intents,
    (SELECT count(*) FROM public.outbox_events WHERE event_type='commerce.order_draft.created') AS events`)).rows[0];
}

it("keeps the restricted definitions dark and closes ordinary draft and raw item effects", async () => {
  const acl = (await env.runtime.query(`SELECT p.prosecdef,p.proconfig,
    pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') AS allowed,
    p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.commerce_orders'::regclass) AS owner_matches
    FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[])`, [checkoutOwnerRoutines])).rows;
  expect(acl).toHaveLength(3);
  expect(acl).toEqual(Array.from({ length: 3 }, () => ({ prosecdef: true,
    proconfig: ["search_path=pg_catalog, pg_temp"], allowed: false, owner_matches: true })));
  await expect(env.runtime.query("SELECT public.catalog_admission_lock_shared()")).rejects.toMatchObject({ code: "42501" });
  await expect(env.owner.query("SELECT public.catalog_admission_create_order_draft('anything',NULL,NULL,NULL,NULL)"))
    .rejects.toMatchObject({ message: "catalog_admission_quote_authority_required" });
  const before = await counts();
  const snapshot = quote(issued.facts.code);
  for (const operation of ["commerce_create_order_draft_with_outbox", "commerce_create_promoted_order_draft_with_outbox"]) {
    await expect(env.runtime.query(`SELECT public.${operation}($1,$2,$3,$4)`,
      [randomUUID(), snapshot, draft(snapshot), clientId])).rejects.toMatchObject(closed);
  }
  await expect(createPostgresNativeCheckoutPersistence(env.runtime).createOrderDraft({
    idempotencyKey: randomUUID(), quoteSnapshot: snapshot,
  }, { clientId })).rejects.toMatchObject({ details: { reason: "catalog_admission_quote_authority_required" } });
  await expect(transaction(env.runtime, async db => {
    const orderId = (await db.query(`INSERT INTO public.commerce_orders(client_id,status,currency_code,total_amount_minor)
      VALUES($1,'pending_payment','XXX',125) RETURNING id`, [clientId])).rows[0]!.id;
    await db.query(`INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      VALUES($1,$2,1,1,125,125)`, [orderId, issued.skuId]);
  })).rejects.toMatchObject(closed);
  expect(await counts()).toEqual(before);
});

it("preserves an original receipt before fresh offer-only admission on both native adapters", async () => {
  const plain = createPostgresNativeCheckoutPersistence(env.runtime);
  const acquisition = createPostgresAcquisitionCheckoutPersistence(env.runtime, {
    regionCode: "ZZ", financialPolicy: {} as never, isAcquisitionDiscount() { throw new Error("Policy must not run"); },
  });
  const snapshot = quote(legacySku);
  Object.assign(snapshot.quote.context!, { offerVersion: "example:checkout@1" });
  const request = { idempotencyKey: randomUUID(), quoteSnapshot: snapshot };
  const saved = await plain.createOrderDraft(request, { clientId });
  const before = await counts();
  await projectOfferOnlyMembership(env.owner, legacyId, legacyId, legacySku, "example:checkout@1");
  try {
    for (const port of [plain, acquisition]) {
      await expect(port.createOrderDraft(request, { clientId })).resolves.toMatchObject({
        orderDraft: { orderId: saved.orderDraft.orderId, replayed: true },
      });
      for (const offerVersion of ["example:checkout@1", { version: "example:checkout@1" }]) {
        const fresh = quote(legacySku);
        Object.assign(fresh.quote.context!, { offerVersion, mode: "subscription", cadenceDays: 3661 });
        await expect(port.createOrderDraft({ idempotencyKey: randomUUID(), quoteSnapshot: fresh }, { clientId }))
          .rejects.toMatchObject({ message: closed.hint, details: { reason: closed.message } });
      }
    }
    for (const lock of legacyLocks) for (const offerVersion of ["example:checkout@1", { version: "example:checkout@1" }]) {
      const fresh = quote(legacySku);
      Object.assign(fresh.quote.context!, { offerVersion });
      await expect(env.runtime.query(checkLegacy, [randomUUID(), draft(fresh), clientId, lock])).rejects.toMatchObject(closed);
    }
    expect(await counts()).toEqual(before);
  } finally {
    await env.owner.query("UPDATE public.catalog_skus SET publication_facts=NULL WHERE id=$1", [legacyId]);
  }
});

it("refuses a fresh recovery link using retained owner acceptance without live demand", async () => {
  const source = randomUUID(), key = `receipt:${source}`;
  const facts = issued.facts as typeof issued.facts & { optionDigest: string };
  const product = issued.product as typeof issued.product & { definitionDigest: string };
  const acceptance = { schemaVersion: 2, lines: [{ schemaVersion: 2, skuId: issued.skuId, skuCode: facts.code,
    skuRevisionId: issued.skuRevisionId, publicationHead: issued.head, typeRef: product.type,
    netContent: facts.netContent, optionDigest: facts.optionDigest, definitionDigest: product.definitionDigest }] };
  await transaction(env.owner, async db => {
    await db.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'cancelled','XXX',0)",
      [source, clientId]);
    await db.query("SELECT public.catalog_attach_order_acceptance($1,$2,$3,$4)", [source, acceptance, key, { [facts.code]: 1 }]);
    await db.query(`INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
      VALUES($1,$2,$3,$4)`, [key, "a".repeat(32), source, { orderDraft: { orderId: `order_${source}`,
       quoteSnapshot: { quote: { lines: [{ sku: facts.code, quantity: 1 }] } } } }]);
  });
  const request = { idempotencyKey: `recovery:${source}`, quoteSnapshot: quote(legacySku) };
  const replacement = (await createPostgresNativeCheckoutPersistence(env.runtime).createOrderDraft(request, { clientId })).orderDraft.orderId.slice(6);
  const before = await counts();
  for (const lock of legacyLocks) {
    await expect(env.runtime.query(checkLegacy, [`checkout-recovery-recreate:${source}`, draft(quote(legacySku)), clientId, lock]))
      .rejects.toMatchObject(closed);
    await env.runtime.query(checkLegacy, [`checkout-recovery-recreate:${source}`, draft(quote(legacySku)), null, lock]);
  }
  await expect(env.runtime.query("SELECT public.commerce_prepare_expired_checkout_recovery($1,$2,$3,1000,now())",
    [request.idempotencyKey, source, replacement])).rejects.toMatchObject(closed);
  expect(await counts()).toEqual(before);
  expect((await env.owner.query("SELECT recreated_from_order_id FROM public.commerce_orders WHERE id=$1", [replacement])).rows)
    .toEqual([{ recreated_from_order_id: null }]);
});

it("authenticates exact receipts, preserves historical replay and rejects changes to committed submit evidence", async () => {
  const key = randomUUID();
  const snapshot = quote(legacySku);
  const saved = await transaction(env.runtime, async db => {
    const response = await createPostgresNativeCheckoutPersistence(db).createOrderDraft({ idempotencyKey: key, quoteSnapshot: snapshot }, { clientId });
    const submit = { schemaVersion: 1, ownerNamespace: "example:store", clientId, lane: "example-checkout", requestKey: key,
      submitDigest: "a".repeat(64), acceptanceTokenDigest: null };
    await db.query("SELECT public.catalog_admission_attach_legacy_submit($1,$2,$3)", [key, clientId, submit]);
    return response.orderDraft.orderId.slice(6);
  });
  async function replay(client: string, digest: string) {
    return (await env.runtime.query("SELECT public.catalog_admission_replay_order_draft($1,$2,'example-checkout',$3) AS result",
      [key, client, digest])).rows[0]!.result;
  }
  await expect(replay(clientId, "a".repeat(64))).resolves.toMatchObject({ orderDraft: { replayed: true } });
  await expect(replay(randomUUID(), "a".repeat(64))).rejects.toMatchObject({ code: "23505" });
  await expect(env.runtime.query("UPDATE public.commerce_orders SET metadata=metadata-'catalogAdmissionSubmit' WHERE id=$1", [saved]))
    .rejects.toMatchObject({ message: "catalog_acceptance_immutable" });
  await expect(env.runtime.query("UPDATE public.commerce_order_draft_receipts SET idempotency_key=$2 WHERE order_id=$1", [saved, randomUUID()]))
    .rejects.toMatchObject({ message: "catalog_acceptance_receipt_mismatch" });
  await env.runtime.query("UPDATE public.commerce_order_draft_receipts SET invalidated_at=now(),invalidation_reason='fixture' WHERE order_id=$1", [saved]);
  await expect(replay(clientId, "b".repeat(64))).rejects.toMatchObject({ code: "23505" });
  await expect(replay(clientId, "a".repeat(64))).rejects.toMatchObject({ message: "commerce_order_draft_expired" });
  const request = { idempotencyKey: randomUUID(), quoteSnapshot: snapshot };
  const first = await createPostgresNativeCheckoutPersistence(env.runtime).createOrderDraft(request, { clientId });
  const replayed = await createPostgresNativeCheckoutPersistence(env.runtime).createOrderDraft(request, { clientId });
  expect(replayed.orderDraft).toEqual({ ...first.orderDraft, replayed: true });
  expect((await env.owner.query(`SELECT metadata ? 'catalogAdmissionSubmit' AS stamped FROM public.commerce_orders WHERE id=$1`,
    [first.orderDraft.orderId.slice(6)])).rows).toEqual([{ stamped: false }]);
});

it("takes the actual products and price fences before bound evidence reads", async () => {
  const before = await counts();
  const scope = { key: randomUUID(), clientId, skuIds: [issued.skuId, archivedId], revisionIds: [issued.skuRevisionId], priceListId, timeoutMs: 1000 };
  await withCatalogAdmissionFence(env.owner, scope, async (db, atTime) => {
    const prices = pricing.createCommercePriceAuthorityPort(createPostgresCommercePriceAuthorityReadPort(db));
    const resolved = await prices.resolvePrice({ regionCode: "ZZ", currency: "XXX", channel: "D2C", mode: "one_time",
      variantId: issued.skuId, atTime });
    expect(resolved.kind).toBe("one_time");
    const snapshot = quote(issued.facts.code);
    const context = { regionCode: "ZZ", currency: "XXX", channel: "D2C", policy: "not_applicable" as const };
    const { document, evidence } = buildCatalogOwnerQuote({ quote: snapshot, consultedHeads: [{ productId: issued.productId, ...issued.head }],
      lineBindings: [{ sourceOrdinal: 1, skuId: issued.skuId, skuCode: issued.facts.code, quantity: 1, mode: "one_time",
        role: "core", source: "fresh", skuRevisionId: issued.skuRevisionId }],
      priceSelectors: [{ sourceOrdinal: 1, role: "actual", selectorKey: resolved.base.priceEntryId, evidence: { list: resolved.base.priceListId } }],
      policy: { applicability: "not_applicable", context } });
    await createPostgresCatalogAdmission().assertCurrent(db, {
      mode: "one_time", context, reviewedProjection: document.reviewedProjection, ownerDocument: document, evidence,
    });
    const { rows } = await db.query("SELECT public.catalog_admission_accept($1,$2,$3,$4,$5) AS evidence",
      [document.reviewedProjection, document, "one_time", context, evidence.quoteDigest]);
    expect(rows).toEqual([{ evidence }]);
    const controls = [
      { reason: "catalog_admission_quote_projection_moved", projection: {} },
      { reason: "catalog_publication_head_moved", owner: { ...document, consultedHeads: [
        { ...document.consultedHeads[0]!, revision: issued.head.revision + 1 },
      ] } },
      { reason: "catalog_admission_membership_authority_unavailable", owner: { ...document, offer: { ref: "example:offer", version: "1" } } },
      { reason: "catalog_admission_line_ineligible", owner: { ...document, lineBindings: [
        { ...document.lineBindings[0]!, role: "addon" },
      ] } },
      { reason: "catalog_admission_price_context_required", priceContext: { ...context, channel: "B2B" } },
      { reason: "catalog_admission_roster_archived", owner: { ...document, lineBindings: [
        { sourceOrdinal: 1, skuId: archivedId, skuCode: archivedSku, mode: "one_time", quantity: 1, role: "core", source: "legacy" },
      ] } },
    ];
    for (const { reason, projection, owner = document, priceContext = context } of controls) {
      await db.query("SAVEPOINT component_refusal");
      await expect(db.query("SELECT public.catalog_admission_accept($1,$2,$3,$4,$5)",
        [projection ?? document.reviewedProjection, owner, "one_time", priceContext, pricing.quoteDigest("catalog.owner-quote.v0", owner)]))
        .rejects.toMatchObject({ message: reason });
      await db.query("ROLLBACK TO SAVEPOINT component_refusal");
      await db.query("RELEASE SAVEPOINT component_refusal");
    }
    await expect(env.owner.query("SELECT public.catalog_admission_accept($1,$2,$3,$4,$5)",
      [document.reviewedProjection, document, "one_time", context, evidence.quoteDigest]))
      .rejects.toMatchObject({ message: "catalog_admission_fence_unavailable" });
    await expect(transaction(env.owner, async other => {
      await other.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
      return other.query("SELECT public.catalog_publication_lock_projection()");
    }))
      .rejects.toMatchObject({ code: "55P03" });
    const writePrices = (sql: string, values: unknown[] = []) => transaction(env.owner, async other => {
      await other.query("SET LOCAL lock_timeout='250ms'");
      return other.query(sql, values);
    });
    await Promise.all([
      writePrices("INSERT INTO public.price_lists(name,region_code,currency) VALUES('New match','ZZ','XXX')"),
      writePrices("UPDATE public.price_lists SET status='active',valid_from=now() WHERE id=$1", [inactivePriceListId]),
      writePrices("INSERT INTO public.price_entries(price_list_id,variant_id,min_qty,unit_price_minor,mode) VALUES($1,$2,2,125,'one_time')",
        [priceListId, issued.skuId]),
    ].map(writer => expect(writer).rejects.toMatchObject({ code: "55P03" })));
    expect((await env.runtime.query(`SELECT
      has_table_privilege(current_user,'public.price_lists','INSERT') AS lists,
      has_table_privilege(current_user,'public.price_entries','INSERT') AS entries`)).rows)
      .toEqual([{ lists: false, entries: false }]);
    const asPriceAdmin = (work: (db: PoolClient) => Promise<unknown>) => transaction(env.owner, async other => {
      await other.query("SET LOCAL ROLE authenticated");
      await other.query("SET LOCAL lock_timeout='250ms'");
      await other.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
      return work(other);
    });
    await expect(asPriceAdmin(other => other.query("SELECT public.catalog_price_setup_preview($1,$2,130)", [issued.skuId, priceListId])))
      .rejects.toMatchObject({ code: "55P03", where: expect.stringContaining("public.catalog_price_setup_preview") });
    const command = pricing.canonicalCatalogPriceSetupCommand({
      schemaVersion: 1, commandKey: randomUUID(), variantId: issued.skuId, priceListId, mode: "one_time",
      minQty: 1, amountKind: "gross", unitPriceMinor: 130, expected: { entryId: resolved.base.priceEntryId, unitPriceMinor: 125 },
    });
    await expect(asPriceAdmin(other => other.query("SELECT public.catalog_price_setup_apply($1,$2)", [command, hash(command)])))
      .rejects.toMatchObject({ code: "55P03", where: expect.stringContaining("catalog_price_setup_lock_context") });
  });
  expect(await counts()).toEqual(before);
});

it.each(["publication", "unrelated commit"] as const)("rejects an early purchase snapshot after %s", async change => {
  const before = await counts();
  const publisher = await env.owner.connect();
  let buyerReachedFence!: () => void;
  let continueBuyer!: () => void;
  const atFence = new Promise<void>(resolve => { buyerReachedFence = resolve; });
  const publisherFinished = new Promise<void>(resolve => { continueBuyer = resolve; });
  let acquired = 0;
  const pair = { async connect() {
    const index = acquired++;
    const db = await env.owner.connect();
    if (index !== 0) return db;
    return {
      async query(request: string | QueryConfig, values?: unknown[]) {
        const text = typeof request === "string" ? request : request.text;
        if (text === "SELECT public.catalog_admission_lock_shared()") {
          buyerReachedFence();
          await publisherFinished;
        }
        return typeof request === "string" ? db.query(request, values) : db.query(request);
      },
      release: (error?: boolean | Error) => db.release(error),
    } as PoolClient;
  } };
  let purchase: Promise<unknown> | undefined;
  try {
    await publisher.query("BEGIN");
    if (change === "publication") {
      await publisher.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
      await publisher.query("SELECT public.catalog_publication_lock_projection()");
      const { productId, skuId, draftId, documentId } = issued;
      const next = await graph(publisher, { productId, skuId, draftId, documentId }, issued.head, false, { lifecycle: "withdrawn" });
      await insertGraph(publisher, next);
    } else {
      const contact = randomUUID();
      await publisher.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [contact, `${contact}@example.invalid`]);
    }
    purchase = withCatalogAdmissionFence(pair as Pick<import("pg").Pool, "connect">, {
      key: randomUUID(), clientId, skuIds: [issued.skuId], revisionIds: [issued.skuRevisionId], priceListId, timeoutMs: 2000,
    }, () => Promise.reject(new Error("An old visibility snapshot must stay outside the reader")));
    await Promise.race([atFence, purchase]);
    await publisher.query("COMMIT");
    continueBuyer();
    await expect(purchase).rejects.toMatchObject({ code: "40001" });
    expect(await counts()).toEqual(before);
  } finally {
    continueBuyer();
    await publisher.query("ROLLBACK");
    publisher.release();
    await purchase?.catch(() => undefined);
  }
});

// Another session's NOWAIT probe reports a conflicting lock without waiting for it.
const conflicts = (sql: string, values: unknown[] = []) => transaction(env.owner, db => db.query(sql, values))
  .then(() => false, (error: { code?: string }) => { if (error.code === "55P03") return true; throw error; });
const draftEntry = (db: Pick<Pool, "query">, routine: string, key: string, snapshot: pricing.CreateQuoteResponse, client = clientId) =>
  db.query(`SELECT public.${routine}($1,$2,$3,$4) AS result`, [key, snapshot, draft(snapshot), client]).then(({ rows }) => rows[0]!.result);
const replayed = (saved: { orderDraft: object }) => ({ ...saved, orderDraft: { ...saved.orderDraft, replayed: true } });
const entries = ["commerce_create_order_draft_with_outbox", "commerce_create_promoted_order_draft_with_outbox"];

it.each(levels)("takes one lock scope for direct true, false and NULL legacy checks at %s", async level => {
  for (const lock of legacyLocks) {
    const db = await env.runtime.connect();
    try {
      await db.query(`BEGIN ISOLATION LEVEL ${level}`);
      // Guest, missing or non-array lines and a malformed recovery key are admitted unchanged.
      for (const value of [{}, { lines: { sku: issued.facts.code } }, draft(quote(legacySku))]) {
        await db.query(checkLegacy, [`checkout-recovery-recreate:${"g".repeat(36)}`, value, null, lock]);
      }
      await db.query(checkLegacy, [randomUUID(), draft(quote(legacySku)), clientId, lock]);
      expect(await Promise.all([
        conflicts("SELECT 1 FROM public.clients WHERE id=$1 FOR UPDATE NOWAIT", [clientId]),
        conflicts("SELECT 1 FROM public.catalog_skus WHERE id=$1 FOR UPDATE NOWAIT", [legacyId]),
        conflicts("SELECT 1 FROM public.catalog_skus WHERE id=$1 FOR UPDATE NOWAIT", [issued.skuId]),
        conflicts("SELECT 1 FROM public.catalog_products WHERE id=$1 FOR SHARE NOWAIT", [legacyId]),
        conflicts("LOCK TABLE public.catalog_products IN SHARE ROW EXCLUSIVE MODE NOWAIT"),
      ])).toEqual([true, true, false, level === "REPEATABLE READ", true]);
      await expect(db.query(checkLegacy, [randomUUID(), draft(quote(issued.facts.code)), clientId, lock])).rejects.toMatchObject(closed);
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
    await expect(transaction(env.runtime, async db => {
      await db.query(`SET TRANSACTION ISOLATION LEVEL ${level}, READ ONLY`);
      return db.query(checkLegacy, [randomUUID(), draft(quote(legacySku)), clientId, lock]);
    })).rejects.toMatchObject({ code: "25006" });
  }
});

it("commits base and discounted promoted drafts and replays both ahead of a held products lock", async () => {
  const otherClient = (await env.owner.query("INSERT INTO public.clients(email) VALUES('other@example.invalid') RETURNING id")).rows[0]!.id;
  const promoted = quote(legacySku);
  Object.assign(promoted.quote, { discounts: [{ appliesTo: "order_total", amountOffMinor: 25 }], discountTotalGross: money(25), totalGross: money(100) });
  const saved: { routine: string; key: string; snapshot: pricing.CreateQuoteResponse; response: { orderDraft: object } }[] = [];
  for (const [routine, snapshot, payable] of [[entries[0]!, quote(legacySku), 125], [entries[1]!, promoted, 100]] as const) {
    const key = randomUUID(), response = await draftEntry(env.runtime, routine, key, snapshot);
    expect((await env.owner.query(`SELECT o.total_amount_minor::int AS payable,
      (SELECT jsonb_agg(jsonb_build_array(quantity,unit_amount_minor::int,line_amount_minor::int)) FROM public.commerce_order_items WHERE order_id=o.id) AS items,
      (SELECT count(*)::int FROM public.commerce_order_adjustments WHERE order_id=o.id) AS adjustments,
      (SELECT jsonb_agg(response_payload) FROM public.commerce_order_draft_receipts WHERE order_id=o.id) AS receipts,
      (SELECT count(*)::int FROM public.outbox_events WHERE aggregate_id=o.id AND event_type='commerce.order_draft.created') AS events
      FROM public.commerce_orders o WHERE o.id=$1`, [response.orderDraft.orderId.slice(6)])).rows)
      .toEqual([{ payable, items: [[1, payable, payable]], adjustments: 0, receipts: [response], events: 1 }]);
    saved.push({ routine, key, snapshot, response });
  }
  const before = await counts(), fence = await env.owner.connect();
  try {
    await fence.query("BEGIN");
    await fence.query("LOCK TABLE public.catalog_products IN SHARE ROW EXCLUSIVE MODE");
    const invalid = quote(legacySku);
    invalid.quote.totalGross = money(124);
    for (const expired of [false, true]) for (const level of levels) {
      const at = <T>(work: (db: PoolClient) => Promise<T>) => transaction(env.runtime, async db => {
        await db.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
        await db.query("SET LOCAL lock_timeout='500ms'");
        return work(db);
      });
      for (const { routine, key, snapshot, response } of saved) {
        if (expired) {
          await expect(at(db => draftEntry(db, routine, key, snapshot))).rejects.toMatchObject({ code: "40001", message: "commerce_order_draft_expired" });
          continue;
        }
        // Replay holds the key and receipt locks, not the catalogue fence.
        expect(await at(async db => [await draftEntry(db, routine, key, snapshot),
          await conflicts("SELECT 1 FROM public.commerce_order_draft_receipts WHERE idempotency_key=$1 FOR UPDATE NOWAIT", [key]),
          (await env.owner.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS free", [key])).rows[0]!.free,
        ])).toEqual([replayed(response), true, false]);
        await expect(at(db => draftEntry(db, routine, key, snapshot, otherClient))).rejects.toMatchObject({ code: "23505" });
        await expect(at(db => draftEntry(db, routine, key, { ...snapshot, quote: { ...snapshot.quote, lines: [{ ...snapshot.quote.lines[0]!, productSlug: "changed-article" }] } })))
          .rejects.toMatchObject({ code: "23505" });
      }
      // Fresh promoted work waits at the outer checker before money validation.
      if (!expired) await expect(at(db => draftEntry(db, entries[1]!, randomUUID(), invalid)))
        .rejects.toMatchObject({ code: "55P03", where: expect.stringContaining("catalog_admission_lock_shared") });
      if (!expired && level === levels[1]) await env.owner.query(`UPDATE public.commerce_order_draft_receipts
        SET invalidated_at=now(),invalidation_reason='fixture' WHERE idempotency_key=ANY($1)`, [saved.map(({ key }) => key)]);
    }
    expect(await counts()).toEqual(before);
  } finally {
    await fence.query("ROLLBACK");
    fence.release();
  }
});

async function classicArticle() {
  const data = fixture();
  await transaction(env.owner, async db => {
    await stageProductRows(db, data);
    await db.query("UPDATE public.catalog_products SET status='active' WHERE id=$1", [data.productId]);
    await db.query("UPDATE public.catalog_skus SET status='active',sellable_standalone=true WHERE id=$1", [data.skuId]);
    await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,unit_price_minor,mode) VALUES($1,$2,125,'one_time')", [priceListId, data.skuId]);
  });
  return { data, snapshot: quote(`sku-${data.skuId}`) };
}
async function publicationFence(db: PoolClient) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actorId, role: "authenticated" })]);
  return db.query("SELECT public.catalog_publication_lock_projection()");
}
// The publication preserves the SKU identity and updates the product row from classic to governed.
const governArticle = async (db: PoolClient, data: ReturnType<typeof fixture>) => insertGraph(db, await graph(db, data, null, false, { lifecycle: "active" }));
async function productFenceWait(pid: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await env.owner.query(`SELECT mode,pg_blocking_pids($1) AS blockers FROM pg_locks
      WHERE pid=$1 AND NOT granted AND relation='public.catalog_products'::regclass`, [pid]);
    if (rows.length) return rows[0];
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("The checkout did not reach the products fence");
}

it.each(levels.flatMap(level => entries.map(routine => [routine, level] as const)))("orders %s against publication at %s", async (routine, level) => {
  const before = await counts(), first = await classicArticle(), second = await classicArticle();
  const buyer = await env.runtime.connect(), publisher = await env.owner.connect();
  try {
    await publisher.query("BEGIN");
    const publisherPid = (await publisher.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await publicationFence(publisher);
    await buyer.query(`BEGIN ISOLATION LEVEL ${level}`);
    await buyer.query("SET LOCAL lock_timeout='20s'; SET LOCAL statement_timeout='30s'");
    const pid = (await buyer.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    // Promoted money is invalid: the catalogue lock outcome must precede its validation.
    if (routine === entries[1]) first.snapshot.quote.totalGross = money(124);
    const pending = draftEntry(buyer, routine, randomUUID(), first.snapshot);
    pending.catch(() => undefined);
    expect(await productFenceWait(pid)).toEqual({ mode: "ShareLock", blockers: [publisherPid] });
    expect(await conflicts("SELECT 1 FROM public.catalog_skus WHERE id=$1 FOR UPDATE NOWAIT", [first.data.skuId])).toBe(true);
    await governArticle(publisher, first.data);
    await publisher.query("COMMIT");
    await expect(pending).rejects.toMatchObject(level === "READ COMMITTED" ? closed : { code: "40001",
      where: expect.stringContaining("catalog_admission_check_legacy_draft(text,jsonb,uuid,boolean) line 11 at PERFORM") });
    await buyer.query("ROLLBACK");
    expect(await counts()).toEqual(before);
    const key = randomUUID();
    await buyer.query(`BEGIN ISOLATION LEVEL ${level}`);
    const saved = await draftEntry(buyer, routine, key, second.snapshot);
    await expect(transaction(env.owner, publicationFence)).rejects.toMatchObject({ code: "55P03" });
    await buyer.query("COMMIT");
    await transaction(env.owner, async db => { await publicationFence(db); await governArticle(db, second.data); });
    expect(await draftEntry(env.runtime, routine, key, second.snapshot)).toEqual(replayed(saved));
    await expect(draftEntry(env.runtime, routine, randomUUID(), second.snapshot)).rejects.toMatchObject(closed);
  } finally {
    await Promise.all([buyer.query("ROLLBACK"), publisher.query("ROLLBACK")]);
    buyer.release();
    publisher.release();
  }
});

const derivedForward = "db/platform/migrations/20261128000000_native_derived_subscription_price.sql";
const draftWriter = "public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)";
const promotedWriter = "public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid)";
const derivedResolver = "public.catalog_admission_derived_subscription_prices(text,jsonb,jsonb,timestamptz)";
const deriveArithmetic = "public.catalog_derive_subscription_unit_price(integer,integer,integer)";
const priceChanged = { code: "22023", message: "commerce_order_draft_catalog_price_changed" };
const roundingRule = "FLOOR_TO_QUANTUM" as const;

async function addPrice(db: Pool, subject: { listId: string; skuId: string }, base: number,
  mode = "one_time", min = 1, kind = "gross", from: string | null = null, to: string | null = null) {
  return (await db.query<{ id: string }>(`INSERT INTO public.price_entries
    (price_list_id,variant_id,unit_price_minor,mode,min_qty,amount_kind,valid_from,valid_to)
    VALUES($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now()-interval '1 day'),$8) RETURNING id`,
  [subject.listId, subject.skuId, base, mode, min, kind, from, to])).rows[0]!.id;
}

async function addPolicy(db: Pool, listId: string, discountBps: number, quantum: number,
  revision = 1, start: string | null = null, end: string | null = null) {
  return (await db.query<{ id: string; digest: string }>(`WITH revision AS (
    SELECT gen_random_uuid() AS id, coalesce($5::timestamptz,now()-interval '1 day') AS starts
  )
  INSERT INTO public.subscription_price_policy_revisions
    (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,rounding_rule,effective_from,effective_to,digest)
  SELECT r.id,l.id,l.region_code,l.currency,'D2C',$4,$2,$3,'FLOOR_TO_QUANTUM',r.starts,$6,
    public.catalog_price_setup_policy_digest(r.id,$4,l.id,l.region_code,l.currency,'D2C',r.starts,$6,$2,$3,'FLOOR_TO_QUANTUM')
  FROM revision r JOIN public.price_lists l ON l.id=$1 RETURNING id,digest`,
  [listId, discountBps, quantum, revision, start, end])).rows[0]!;
}

async function priceSubject(db: Pool, currency: string, skuId: string = randomUUID()) {
  const sku = `Article-${skuId}`;
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Article') ON CONFLICT DO NOTHING", [skuId, sku.toLowerCase()]);
  await db.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
    VALUES($1,$1,$2,'Article',true) ON CONFLICT DO NOTHING`, [skuId, sku]);
  const listId = (await db.query<{ id: string }>(`INSERT INTO public.price_lists(name,region_code,currency,valid_from)
    VALUES('Test market','ZZ',$1,now()-interval '1 day') RETURNING id`, [currency])).rows[0]!.id;
  return { skuId, sku, listId, currency };
}
type PriceSubject = Awaited<ReturnType<typeof priceSubject>>;

function moneySnapshot(subject: PriceSubject, unit: number, quantity = 1, mode: "one_time" | "subscription" = "subscription") {
  const result = quote(subject.sku);
  const amount = (amountMinor: number) => ({ amountMinor, currency: subject.currency });
  const total = amount(unit * quantity);
  Object.assign(result.quote, { currency: subject.currency, context: { mode, promoCodes: [] },
    subtotalGross: total, totalGross: total, netTotal: total, discountTotalGross: amount(0), taxTotal: amount(0) });
  const line = result.quote.lines[0]!;
  Object.assign(line, { quantity, unitPriceGross: amount(unit), lineSubtotalGross: total });
  Object.assign(line.tax, { grossAmount: total, netAmount: total, vatAmount: amount(0) });
  return result;
}

function derivedSnapshot(subject: PriceSubject, baseId: string, base: number,
  policy: { id: string; digest: string }, atTime: string, unit: number, quantity = 1) {
  const snapshot = moneySnapshot(subject, unit, quantity);
  snapshot.quote.lines[0]!.catalogFacts = {
    version: "catalog_facts_v2", skuId: subject.skuId, documentRevisionId: randomUUID(), documentDigest: "a".repeat(64),
    basePriceEntryId: baseId, baseUnitAmountMinor: base, policyRevisionId: policy.id, policyDigest: policy.digest,
    resolvedUnitAmountMinor: unit, resolvedLineAmountMinor: unit * quantity, currency: subject.currency, mode: "subscription", atTime,
  };
  return snapshot;
}

async function dbInstant(db: Pool | PoolClient) {
  return (await db.query<{ instant: string }>("SELECT now()::text AS instant")).rows[0]!.instant;
}

const writerDraft = (snapshot: pricing.CreateQuoteResponse) => ({ ...draft(snapshot), currency: snapshot.quote.currency,
  lines: structuredClone(snapshot.quote.lines) });
async function writePriceDraft(db: Pool | PoolClient, snapshot: pricing.CreateQuoteResponse, key = randomUUID(),
  submitted = writerDraft(snapshot)) {
  return (await db.query<{ response: { orderDraft: { orderId: string; replayed: boolean }; contractVersion: string } }>(
    "SELECT public.commerce_create_order_draft_with_outbox($1,$2,$3,NULL) AS response", [key, snapshot, submitted]
  )).rows[0]!.response;
}

async function seedDerived(db: Pool, currency: string, base = 125, discount = 500, quantum = 10) {
  const subject = await priceSubject(db, currency);
  const policy = await addPolicy(db, subject.listId, discount, quantum);
  const baseId = await addPrice(db, subject, base);
  const unit = pricing.deriveSubscriptionUnitPrice(base, { discountBps: discount, roundingQuantumMinor: quantum, roundingRule });
  return { subject, baseId, policy, snapshot: derivedSnapshot(subject, baseId, base, policy, await dbInstant(db), unit) };
}

it("accepts derived units at a half-open base and policy boundary with exactly one set of effects", async () => {
  const { owner, runtime } = env;
  const subject = await priceSubject(owner, "XAA");
  const { key, saved, snapshot } = await transaction(runtime, async db => {
    const boundary = await dbInstant(db);
    const oldPolicy = await addPolicy(owner, subject.listId, 500, 10);
    const oldBase = await addPrice(owner, subject, 125, "one_time", 1, "gross", null, boundary);
    await owner.query(`UPDATE public.subscription_price_policy_revisions
      SET effective_to=$2 WHERE id=$1`, [oldPolicy.id, boundary]);
    const policy = await addPolicy(owner, subject.listId, 500, 10, 2, boundary);
    const baseId = await addPrice(owner, subject, 125, "one_time", 1, "gross", boundary);
    const stale = derivedSnapshot(subject, oldBase, 125, oldPolicy, boundary, 110, 3);
    const snapshot = derivedSnapshot(subject, baseId, 125, policy, boundary, 110, 3);
    const before = await counts();
    const resolver = "SELECT public.catalog_admission_derived_subscription_prices($1,$2,$3,$4::timestamptz) AS units";
    expect((await db.query(resolver, [subject.currency, snapshot, writerDraft(snapshot), boundary])).rows).toEqual([{ units: [110] }]);
    expect((await db.query(resolver, [subject.currency, stale, writerDraft(stale), boundary])).rows).toEqual([{ units: [null] }]);
    const earlier = (await db.query<{ instant: string }>("SELECT ($1::timestamptz-interval '1 microsecond')::text AS instant", [boundary])).rows[0]!.instant;
    expect((await db.query(resolver, [subject.currency, stale, writerDraft(stale), earlier])).rows).toEqual([{ units: [110] }]);
    await db.query("SAVEPOINT stale_price");
    await expect(writePriceDraft(db, stale)).rejects.toMatchObject(priceChanged);
    await db.query("ROLLBACK TO SAVEPOINT stale_price");
    expect(await counts()).toEqual(before);
    const key = randomUUID();
    return { key, saved: await writePriceDraft(db, snapshot, key), snapshot };
  });
  const orderId = saved.orderDraft.orderId.slice(6);
  expect((await owner.query(`SELECT i.quantity,i.unit_amount_minor::integer,i.line_amount_minor::integer,
    o.metadata->'quoteSnapshot' AS quote,r.response_payload AS receipt,e.payload->'quoteSnapshot' AS emitted
    FROM public.commerce_orders o JOIN public.commerce_order_items i ON i.order_id=o.id
    JOIN public.commerce_order_draft_receipts r ON r.order_id=o.id AND r.idempotency_key=$2
    JOIN public.outbox_events e ON e.aggregate_id=o.id AND e.idempotency_key=$2 WHERE o.id=$1`, [orderId, key])).rows)
    .toEqual([{ quantity: 3, unit_amount_minor: 110, line_amount_minor: 330, quote: snapshot, receipt: saved, emitted: snapshot }]);
});

it("refuses mismatched or ambiguous derived authority even when a stored price matches", async () => {
  const { owner, runtime } = env;
  const { subject, snapshot } = await seedDerived(owner, "XAB");
  await addPrice(owner, subject, 105, "subscription");
  const wrong = moneySnapshot(subject, 105);
  const facts = snapshot.quote.lines[0]!.catalogFacts!;
  wrong.quote.lines[0]!.catalogFacts = { ...facts, resolvedUnitAmountMinor: 105, resolvedLineAmountMinor: 105 };
  const before = await counts();
  await expect(writePriceDraft(runtime, wrong)).rejects.toMatchObject(priceChanged);
  const invalidLine = writerDraft(snapshot);
  invalidLine.lines[0]!.quantity = 0;
  await expect(writePriceDraft(runtime, wrong, randomUUID(), invalidLine))
    .rejects.toMatchObject({ code: "22023", message: "commerce_order_draft_invalid_line" });
  for (const [field, value] of [
    ["policyRevisionId", randomUUID()], ["policyRevisionId", []], ["policyRevisionId", undefined], ["policyDigest", undefined],
    ["policyDigest", "b".repeat(64)], ["basePriceEntryId", randomUUID()], ["basePriceEntryId", undefined],
    ["skuId", randomUUID()], ["baseUnitAmountMinor", 126], ["resolvedUnitAmountMinor", "110"],
    ["resolvedLineAmountMinor", 111], ["currency", "USD"], ["mode", "one_time"],
  ] as const) {
    const submitted = writerDraft(snapshot);
    const altered = { ...facts, [field]: value } as typeof facts;
    submitted.lines[0]!.catalogFacts = altered;
    await expect(writePriceDraft(runtime, snapshot, randomUUID(), submitted), field).rejects.toMatchObject(priceChanged);
    const quoted = structuredClone(snapshot);
    quoted.quote.lines[0]!.catalogFacts = altered;
    await expect(writePriceDraft(runtime, quoted, randomUUID(), submitted), field).rejects.toMatchObject(priceChanged);
  }
  const missing = writerDraft(snapshot);
  delete missing.lines[0]!.catalogFacts;
  await expect(writePriceDraft(runtime, snapshot, randomUUID(), missing)).rejects.toMatchObject(priceChanged);
  const noQuoteLine = structuredClone(snapshot);
  noQuoteLine.quote.lines = [];
  await expect(writePriceDraft(runtime, noQuoteLine, randomUUID(), writerDraft(snapshot))).rejects.toMatchObject(priceChanged);
  const otherList = (await owner.query<{ id: string }>(`INSERT INTO public.price_lists(name,region_code,currency)
    VALUES('Competing list','ZZ',$1) RETURNING id`, [subject.currency])).rows[0]!.id;
  await expect(writePriceDraft(runtime, snapshot)).rejects.toMatchObject(priceChanged);
  await owner.query("DELETE FROM public.price_lists WHERE id=$1", [otherList]);
  const net = await addPrice(owner, subject, 125, "one_time", 1, "net", await dbInstant(owner));
  await expect(writePriceDraft(runtime, snapshot)).rejects.toMatchObject(priceChanged);
  await owner.query("UPDATE public.price_entries SET active=false WHERE id<>$1 AND price_list_id=$2 AND mode='one_time'", [net, subject.listId]);
  const netClaim = structuredClone(snapshot);
  netClaim.quote.lines[0]!.catalogFacts!.basePriceEntryId = net;
  await expect(writePriceDraft(runtime, netClaim)).rejects.toMatchObject(priceChanged);
  expect(await counts()).toEqual(before);
  await owner.query("UPDATE public.price_entries SET active=(id<>$1) WHERE price_list_id=$2 AND mode='one_time'", [net, subject.listId]);
  await expect(writePriceDraft(runtime, snapshot)).resolves.toMatchObject({ orderDraft: { replayed: false } });
});

it.each([
  { currency: "XAC", base: 10, bps: 0, quantum: 10, expected: 10, outcome: "accepts" },
  { currency: "XAD", base: 125, bps: 10000, quantum: 10, expected: 0, outcome: "refuses" },
  { currency: "XAE", base: 11, bps: 900, quantum: 10, expected: 10, outcome: "accepts" },
  { currency: "XAF", base: 10, bps: 1, quantum: 10, expected: 0, outcome: "refuses" },
  { currency: "XAG", base: 2147483647, bps: 0, quantum: 1, expected: 2147483647, outcome: "accepts" },
])("$outcome the derived price $expected from base $base at $bps basis points", async ({ currency, base, bps, quantum, expected, outcome }) => {
  const { snapshot, subject } = await seedDerived(env.owner, currency, base, bps, quantum);
  expect(snapshot.quote.lines[0]!.unitPriceGross.amountMinor).toBe(expected);
  if (outcome === "accepts") {
    await expect(writePriceDraft(env.runtime, snapshot)).resolves.toMatchObject({ orderDraft: { replayed: false } });
  } else {
    const submitted = writerDraft(snapshot);
    const { rows } = await env.owner.query(
      "SELECT public.catalog_admission_derived_subscription_prices($1,$2,$3,now()) AS units",
      [currency, snapshot, submitted],
    );
    expect(rows).toEqual([{ units: [null] }]);
    const before = await counts();
    await expect(writePriceDraft(env.runtime, snapshot, randomUUID(), submitted)).rejects.toMatchObject(priceChanged);
    expect(await counts()).toEqual(before);
  }
  if (base === 2147483647) {
    const overflowing = moneySnapshot(subject, expected, 2);
    overflowing.quote.lines[0]!.catalogFacts = snapshot.quote.lines[0]!.catalogFacts;
    const submitted = writerDraft(overflowing);
    submitted.lines[0]!.lineSubtotalGross = { amountMinor: expected, currency };
    await expect(writePriceDraft(env.runtime, overflowing, randomUUID(), submitted)).rejects.toMatchObject({ code: "22003" });
  }
});

it("keeps subscription-mode priority and tiers during a policy gap", async () => {
  const { owner, runtime } = env;
  const { subject, snapshot } = await seedDerived(owner, "XAH");
  await expect(writePriceDraft(runtime, snapshot)).resolves.toMatchObject({ orderDraft: { replayed: false } });
  await owner.query(`UPDATE public.subscription_price_policy_revisions
    SET effective_to=now() WHERE price_list_id=$1 AND effective_to IS NULL`, [subject.listId]);
  await addPrice(owner, subject, 105, "subscription");
  await addPrice(owner, subject, 95, "subscription", 2);
  await addPrice(owner, subject, 80, "any", 3);
  await expect(writePriceDraft(runtime, snapshot)).rejects.toMatchObject(priceChanged);
  await expect(writePriceDraft(runtime, moneySnapshot(subject, 80, 3))).rejects.toMatchObject(priceChanged);
  const stored = moneySnapshot(subject, 95, 3);
  const key = randomUUID();
  const result = await writePriceDraft(runtime, stored, key);
  const expected = { contractVersion: "commerce.v0", orderDraft: { orderId: result.orderDraft.orderId,
    idempotencyKey: key, status: "draft", paymentStatus: "not_started", replayed: false, quoteSnapshot: stored } };
  const canonical = (await runtime.query("SELECT $1::jsonb AS receipt", [expected])).rows[0]!.receipt;
  expect(JSON.stringify(result)).toBe(JSON.stringify(canonical));
});

it("accepts a stored subscription draft from a writer role without resolver execution", async () => {
  const { owner } = env;
  const subject = await priceSubject(owner, "XAT");
  await addPrice(owner, subject, 125, "subscription");
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(`CREATE ROLE stored_price_writer NOLOGIN NOINHERIT;
      GRANT USAGE ON SCHEMA public TO stored_price_writer;
      GRANT SELECT ON public.clients, public.catalog_products, public.catalog_skus, public.price_entries,
        public.price_lists, public.commerce_orders, public.commerce_order_items,
        public.commerce_order_draft_receipts, public.commerce_order_adjustments TO stored_price_writer;
      GRANT INSERT ON public.commerce_orders, public.commerce_order_items,
        public.commerce_order_draft_receipts, public.outbox_events TO stored_price_writer;
      GRANT UPDATE ON public.commerce_order_draft_receipts TO stored_price_writer;
      GRANT EXECUTE ON FUNCTION ${draftWriter}, public.catalog_admission_check_legacy_draft(text,jsonb,uuid,boolean),
        public.catalog_admission_replay_order_draft(text,uuid,text,text),
        public.catalog_order_line_sum_acceptance(uuid,uuid,public.commerce_orders,public.commerce_orders),
        public.catalog_admission_guard_purchase_item(public.commerce_order_items) TO stored_price_writer;
      SET LOCAL ROLE stored_price_writer`);
    const { rows } = await db.query(`SELECT pg_has_role(current_user,'service_role','MEMBER') AS service_member,
      has_function_privilege(current_user,$1::text,'EXECUTE') AS writer,
      has_function_privilege(current_user,$2::text,'EXECUTE') AS resolver`, [draftWriter, derivedResolver]);
    expect(rows).toEqual([{ service_member: false, writer: true, resolver: false }]);
    await expect(writePriceDraft(db, moneySnapshot(subject, 125))).resolves.toMatchObject({
      orderDraft: { status: "draft", replayed: false },
    });
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  } finally {
    try { await db.query("ROLLBACK"); } finally { db.release(); }
  }
});

it("keeps one-time pricing and effects alongside an effective subscription policy", async () => {
  const { subject, snapshot } = await seedDerived(env.owner, "XAI");
  await expect(writePriceDraft(env.runtime, snapshot)).resolves.toMatchObject({ orderDraft: { replayed: false } });
  const oneTime = moneySnapshot(subject, 125, 2, "one_time");
  const key = randomUUID();
  const saved = await writePriceDraft(env.runtime, oneTime, key);
  expect((await env.owner.query(`SELECT i.unit_amount_minor::integer,i.line_amount_minor::integer,e.payload->'quoteSnapshot' AS quote
    FROM public.commerce_order_items i JOIN public.outbox_events e ON e.aggregate_id=i.order_id
    WHERE i.order_id=$1 AND e.idempotency_key=$2`, [saved.orderDraft.orderId.slice(6), key])).rows)
    .toEqual([{ unit_amount_minor: 125, line_amount_minor: 250, quote: oneTime }]);
});

it("keeps the stored any fallback and wrong-price refusal without settlement settings", async () => {
  const { owner, runtime } = env;
  const { snapshot } = await seedDerived(owner, "XAJ");
  const stored = await priceSubject(owner, "XAK");
  await addPrice(owner, stored, 125, "any");
  await owner.query("DELETE FROM public.commerce_settings WHERE key IN ('settlement_region','settlement_currency')");
  try {
    await expect(writePriceDraft(runtime, snapshot)).resolves.toMatchObject({ orderDraft: { replayed: false } });
    await expect(writePriceDraft(runtime, moneySnapshot(stored, 125))).resolves.toMatchObject({ orderDraft: { replayed: false } });
    const before = await counts();
    await expect(writePriceDraft(runtime, moneySnapshot(stored, 124))).rejects.toMatchObject(priceChanged);
    expect(await counts()).toEqual(before);
  } finally {
    await owner.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('settlement_region','ZZ'),('settlement_currency','XXX')");
  }
});

it("upgrades writer authority in place and replays a completed pre-upgrade draft", async () => {
  const prefix = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as PlatformMigrationManifest;
  if (prefix.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
    const end = plan.forward.findIndex(unit => unit.file === derivedForward);
    expect(end).toBeGreaterThan(0);
    plan.forward = plan.forward.slice(0, end);
  }
  const store = await withPlatformCatalog(prefix, root => installAccountMutations("bootstrap", true, "derived-price", root));
  const { owner, runtime } = store;
  const privilegesSql = `SELECT named.signature,p.oid,p.proowner,p.prosecdef,p.proconfig,p.provolatile,p.proacl::text,
    pg_catalog.has_function_privilege(p.proowner,p.oid,'EXECUTE') AS owner,
    pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
    pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
    pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') AS service,
    pg_catalog.has_function_privilege(0::oid,p.oid,'EXECUTE') AS public
    FROM unnest($1::text[]) WITH ORDINALITY AS named(signature,position)
    JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(named.signature) ORDER BY named.position`;
  const facts = async (names: string[]) => (await owner.query(privilegesSql, [names])).rows;
  const effects = async () => (await owner.query(`SELECT (SELECT count(*) FROM public.commerce_orders) AS orders,
    (SELECT count(*) FROM public.commerce_order_items) AS items,
    (SELECT count(*) FROM public.commerce_order_draft_receipts) AS receipts,
    (SELECT count(*) FROM public.outbox_events) AS events`)).rows;
  try {
    const { subject, snapshot } = await seedDerived(owner, "XAL");
    const entry = await addPrice(owner, subject, 125, "subscription");
    const stored = moneySnapshot(subject, 125);
    const key = randomUUID();
    const saved = await writePriceDraft(runtime, stored, key);
    const beforeEffects = await effects();
    const beforeWriters = await facts([draftWriter, promotedWriter]);
    const promotedSource = async () => (await owner.query("SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=$1::regprocedure", [promotedWriter])).rows;
    const beforePromoted = await promotedSource();
    expect((await store.runner.apply()).applied.slice(0, 1)).toEqual([derivedForward]);
    expect(await facts([draftWriter, promotedWriter])).toEqual(beforeWriters);
    expect(await promotedSource()).toEqual(beforePromoted);
    expect(beforeWriters).toEqual([draftWriter, promotedWriter].map(signature => expect.objectContaining({
      signature, prosecdef: false, proconfig: ["search_path=pg_catalog, pg_temp"], service: true,
    })));
    expect(await facts([deriveArithmetic, derivedResolver])).toEqual([
      expect.objectContaining({ signature: deriveArithmetic, prosecdef: false, proconfig: ["search_path=pg_catalog, pg_temp"],
        provolatile: "i", owner: true, anon: false, authenticated: false, service: false, public: false }),
      expect.objectContaining({ signature: derivedResolver, prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"],
        provolatile: "s", owner: true, anon: false, authenticated: false, service: true, public: false }),
    ]);
    await owner.query("UPDATE public.price_entries SET unit_price_minor=150 WHERE id=$1", [entry]);
    expect(JSON.stringify(await writePriceDraft(runtime, stored, key)))
      .toBe(JSON.stringify({ ...saved, orderDraft: { ...saved.orderDraft, replayed: true } }));
    await expect(writePriceDraft(runtime, stored)).rejects.toMatchObject(priceChanged);
    expect(await effects()).toEqual(beforeEffects);
    await expect(writePriceDraft(runtime, snapshot)).resolves.toMatchObject({ orderDraft: { replayed: false } });
  } finally {
    await store.close();
  }
}, postgresSetupTimeoutMs);

it("keeps rounding parity with quote and preview amounts and readiness signs", async () => {
  const { owner } = env;
  const vectors = [
    { currency: "XAM", base: 10, bps: 0, quantum: 10, unit: 10 },
    { currency: "XAN", base: 125, bps: 10000, quantum: 10, unit: 0 },
    { currency: "XAO", base: 10, bps: 1, quantum: 10, unit: 0 },
    { currency: "XAP", base: 11, bps: 900, quantum: 10, unit: 10 },
    { currency: "XAQ", base: 19, bps: 0, quantum: 10, unit: 10 },
    { currency: "XAR", base: 20, bps: 0, quantum: 10, unit: 20 },
    { currency: "XAS", base: 2147483647, bps: 1, quantum: 1, unit: 2147268898 },
  ];
  const skuId = randomUUID();
  try {
    for (const { currency, base, bps, quantum, unit } of vectors) {
      const subject = await priceSubject(owner, currency, skuId);
      await addPolicy(owner, subject.listId, bps, quantum);
      await addPrice(owner, subject, base);
      await owner.query("UPDATE public.commerce_settings SET value_text=$1 WHERE key='settlement_currency'", [currency]);
      expect(pricing.deriveSubscriptionUnitPrice(base, { discountBps: bps, roundingQuantumMinor: quantum, roundingRule })).toBe(unit);
      const preview = await env.actor(actorId, db => db.query(
        "SELECT public.catalog_price_setup_preview($1,$2,NULL)->'subscription' AS price", [skuId, subject.listId]));
      expect(preview.rows).toEqual([{ price: expect.objectContaining({ kind: "derived", derivedUnitPriceMinor: unit }) }]);
      const sign = unit > 0;
      const target = JSON.stringify([{ skuId, requiredModes: ["subscription"] }]);
      expect((await owner.query(`SELECT public.catalog_derive_subscription_unit_price($1,$2,$3) AS unit,
        (public.commerce_offer_policy_v2_readiness()#>>'{evidence,subscriptionPricePolicyDerivesBand}')::boolean AS offer,
        public.catalog_publication_price_reasons(ARRAY[$4::uuid],now())#>'{0,reasons}' AS publication,
        public.catalog_publication_target_price_verdict($5,now())#>>'{targets,0,reason}' AS writer`,
      [base, bps, quantum, skuId, target])).rows).toEqual([{
        unit, offer: sign, publication: sign ? [] : ["price_readiness_missing"],
        writer: sign ? null : "catalog_publication_sku_price_not_ready",
      }]);
    }
  } finally {
    await owner.query("UPDATE public.commerce_settings SET value_text='XXX' WHERE key='settlement_currency'");
  }
});
