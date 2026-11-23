import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresAcquisitionCheckoutPersistence, createPostgresNativeCheckoutPersistence } from "@openlup/platform/commerce/server/native-checkout";
import { createPostgresCommercePriceAuthorityReadPort } from "@openlup/platform/commerce/server/postgres";
import { createPostgresCatalogAdmission } from "@openlup/platform/catalog";
import * as pricing from "@openlup/platform/pricing";
import { buildCatalogOwnerQuote, withCatalogAdmissionFence } from "@openlup/platform/catalog/testing";
import { actorId, fixture, graph, hash, insertGraph, installPublicationActors, projectOfferOnlyMembership, transaction, type Graph } from "./catalogPublicationFixture.js";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { checkoutOwnerRoutines, selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { proveRuntimeCheckout, watchRuntimeCheckoutAclDelta } from "./catalogRuntimeCheckout.proof.js";

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

beforeAll(async () => {
  env = await lifecycleInstallation("qualified-v2");
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
      async query(text: string, values?: unknown[]) {
        if (text === "SELECT public.catalog_admission_lock_shared()") {
          buyerReachedFence();
          await publisherFinished;
        }
        return db.query(text, values);
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
