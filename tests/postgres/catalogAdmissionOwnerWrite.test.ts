import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { draftEffectCounts, draftHandoff, governedCore, ownerDraft, ownerSql, prelockDraft, productPromotion,
  sampleDraftTime, seedGovernedDraft, shippingPromotion, type GovernedFixture } from "./catalogAdmissionOwnerWrite.fixture.js";
import { hash, transaction } from "./catalogPublicationFixture.js";
import { lifecycleInstallation, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

const mismatch = { code: "22023", message: "catalog_admission_evidence_binding_mismatch" };
const immutable = { code: "55000", message: "catalog_acceptance_immutable" };
let store: LifecycleInstallation, fixture: GovernedFixture;
let order: Awaited<ReturnType<typeof ownerDraft>>;

beforeAll(async () => {
  store = await lifecycleInstallation("qualified-v2", { freshCluster: true });
  fixture = await seedGovernedDraft(store.owner, { product: 3, shipping: 7 });
}, postgresSetupTimeoutMs);
afterAll(async () => { await store?.close(); }, postgresTeardownTimeoutMs);

it("writes the exact allocated graph, claims and timestamps from one sampled instant", async () => {
  order = await ownerDraft(store.owner, fixture);
  const rows = (await store.owner.query(`SELECT line_ordinal,source_line_ordinal,sku_id,quantity,
    unit_amount_minor::integer unit,catalog_unit_amount_minor::integer catalog_unit,catalog_line_amount_minor::integer catalog_sum,
    line_amount_minor::integer effective_sum,promotion_discount_allocated_minor::integer off,promotion_allocation_fingerprint fingerprint,created_at
    FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal`, [order.id])).rows;
  const draftBytes = (await store.owner.query("SELECT (metadata->'orderDraftSnapshot')::text AS bytes FROM public.commerce_orders WHERE id=$1", [order.id])).rows[0]!.bytes;
  const fingerprint = hash(draftBytes + "|effective-line-allocation.v1");
  expect(rows).toEqual([
    { line_ordinal: 1, source_line_ordinal: 1, sku_id: fixture.profile.skuIds[0], quantity: 1, unit: 1339, catalog_unit: 1340, catalog_sum: 1340, effective_sum: 1339, off: 1 },
    { line_ordinal: 2, source_line_ordinal: 1, sku_id: fixture.profile.skuIds[0], quantity: 1, unit: 1340, catalog_unit: 1340, catalog_sum: 1340, effective_sum: 1340, off: 0 },
    { line_ordinal: 3, source_line_ordinal: 2, sku_id: fixture.profile.skuIds[1], quantity: 2, unit: 1339, catalog_unit: 1340, catalog_sum: 2680, effective_sum: 2678, off: 2 },
  ].map(row => ({ ...row, fingerprint, created_at: new Date(order.atTime) })));
  const { rows: adjustmentRows } = await store.owner.query(`SELECT a.kind,a.scope,a.promotion_id,a.amount_minor::integer amount,
    a.created_at=$2 AS same_at,
    CASE WHEN a.promotion_id IS NULL THEN a.definition_fingerprint IS NULL AND c.id IS NULL
      ELSE (c.definition_fingerprint,c.promotion_id,c.amount_off_minor,c.client_id)=(a.definition_fingerprint,a.promotion_id,a.amount_minor,$3::uuid)
        AND c.expires_at=$2::timestamptz+make_interval(hours=>public.promotion_claim_hold_hours_read())
        AND c.reserved_at=$2 AND c.updated_at=$2 AND e.occurred_at=$2 AND e.transition='reserved' END AS claim
    FROM public.commerce_order_adjustments a LEFT JOIN public.commerce_promotion_claims c ON c.adjustment_id=a.id
    LEFT JOIN public.commerce_promotion_claim_events e ON e.claim_id=c.id WHERE a.order_id=$1 ORDER BY a.kind,a.scope`,
  [order.id, order.atTime, fixture.original.clientId]);
  expect(adjustmentRows).toEqual([
    { kind: "promotion_discount", scope: "order_total", amount: 3, promotion_id: productPromotion },
    { kind: "promotion_discount", scope: "shipping", amount: 7, promotion_id: shippingPromotion },
    { kind: "shipping_charge", scope: "shipping", amount: 150, promotion_id: null },
  ].map(row => ({ ...row, same_at: true, claim: true })));
  expect((await store.owner.query(`SELECT o.total_amount_minor::integer total,r.response_payload response,o.metadata->'catalogAdmissionOwnerOrigin' origin,
    r.request_fingerprint fingerprint,o.created_at=$2 AND o.updated_at=$2 AND r.created_at=$2 AND e.created_at=$2 AND e.available_at=$2 AS timestamps
    FROM public.commerce_orders o JOIN public.commerce_order_draft_receipts r ON r.order_id=o.id
    JOIN public.outbox_events e ON e.aggregate_id=o.id AND e.event_type='commerce.order_draft.created' WHERE o.id=$1`, [order.id, order.atTime])).rows)
    .toEqual([{ total: 5500, response: order.response, origin: {
      schemaVersion: 1, orderId: order.id, receiptKey: fixture.original.key, nativeFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/u),
      ownerQuoteDigest: order.value.evidence.quoteDigest,
    }, fingerprint: expect.stringMatching(/^[a-f0-9]{32}$/u), timestamps: true }]);
  expect(await draftEffectCounts(store.owner)).toEqual({ orders: 1, items: 3, adjustments: 3, receipts: 1, claims: 2, events: 2, outbox: 1 });
});

it("refuses forbidden roots, malformed discounts and bad instants before effects", async () => {
  const original = { ...fixture.original, key: randomUUID() };
  const current = { ...fixture, original };
  const before = await draftEffectCounts(store.owner);
  await transaction(store.owner, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await prelockDraft(db, current);
    // Sequence increments survive savepoint rollback, so a refusal after the
    // first effect INSERT cannot pass the same assertion as an ingress refusal.
    await db.query(`CREATE SEQUENCE public.governed_draft_insert_probe;
      CREATE FUNCTION public.governed_draft_insert_probe() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('public.governed_draft_insert_probe'); RETURN NEW; END; $$;
      CREATE TRIGGER governed_draft_insert_probe BEFORE INSERT ON public.commerce_orders
      FOR EACH ROW EXECUTE FUNCTION public.governed_draft_insert_probe()`);
    const atTime = await sampleDraftTime(db), value = await draftHandoff(db, current, atTime);
    const changeDiscount = (patch: object) => {
      const next = structuredClone(value);
      const discounts = [{ ...next.draft.discounts[0]!, ...patch }, next.draft.discounts[1]!];
      return { ...next, draft: { ...next.draft, discounts }, quoteSnapshot: { ...next.quoteSnapshot, quote: { ...next.quoteSnapshot.quote, discounts } } };
    };
    const changeTime = (time: string | undefined) => {
      const next = structuredClone(value);
      next.draft.context.atTime = next.quoteSnapshot.quote.context.atTime = time;
      return next;
    };
    for (const payload of [
      ...["orderId", "receipt", "nativeFingerprint", "response", "metadata", "token", "destinationId", "paymentStatus", "status"]
        .map(name => ({ ...value, [name]: "override" })),
      changeDiscount({ promotionId: undefined }), changeDiscount({ promotionId: "invalid id" }),
      changeDiscount({ promotionId: shippingPromotion }), changeDiscount({ appliesTo: "line" }), changeDiscount({ amountOffMinor: 0 }),
      changeDiscount({ amountOffMinor: 4 }), changeTime(undefined), changeTime("2026-02-31T00:00:00.000Z"),
      changeTime(new Date(Date.parse(atTime) + 60_000).toISOString()), changeTime(new Date(Date.parse(atTime) - 60_000).toISOString()),
    ]) {
      await db.query("SAVEPOINT before_effect");
      await expect(db.query(ownerSql, [original.key, original.clientId, payload])).rejects.toMatchObject(mismatch);
      await db.query("ROLLBACK TO SAVEPOINT before_effect");
      await db.query("RELEASE SAVEPOINT before_effect");
    }
    expect((await db.query("SELECT is_called FROM public.governed_draft_insert_probe")).rows).toEqual([{ is_called: false }]);
    await db.query(`DROP TRIGGER governed_draft_insert_probe ON public.commerce_orders;
      DROP FUNCTION public.governed_draft_insert_probe(); DROP SEQUENCE public.governed_draft_insert_probe`);
  });
  expect(await draftEffectCounts(store.owner)).toEqual(before);
});

it.each([true, false])("leaves all five allocation columns null without a product discount (shipping discount %s)", async includeShipping => {
  const authority = fixture.profile.authority!;
  const current = { original: { ...fixture.original, key: randomUUID() }, profile: { ...fixture.profile,
    authority: { ...authority, async evaluate(input: Parameters<typeof authority.evaluate>[0]) {
      const evaluated = await authority.evaluate(input);
      const discounts = evaluated.result.discounts.filter(row => includeShipping && row.appliesTo === "shipping");
      return { ...evaluated, result: { ...evaluated.result, discounts }, decisions: { ...evaluated.decisions,
        promotions: evaluated.decisions.promotions.filter(row => includeShipping && row.ref === shippingPromotion) } };
    } } } };
  const saved = await ownerDraft(store.owner, current);
  expect((await store.owner.query(`SELECT line_ordinal,source_line_ordinal,catalog_unit_amount_minor,catalog_line_amount_minor,
    promotion_discount_allocated_minor,promotion_allocation_fingerprint FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal`,
  [saved.id])).rows).toEqual([1, 2].map(line_ordinal => ({ line_ordinal, source_line_ordinal: null, catalog_unit_amount_minor: null,
    catalog_line_amount_minor: null, promotion_discount_allocated_minor: null, promotion_allocation_fingerprint: null })));
  expect((await store.owner.query("SELECT kind,scope,promotion_id FROM public.commerce_order_adjustments WHERE order_id=$1 ORDER BY kind", [saved.id])).rows)
    .toEqual([...(includeShipping ? [{ kind: "promotion_discount", scope: "shipping", promotion_id: shippingPromotion }] : []),
      { kind: "shipping_charge", scope: "shipping", promotion_id: null }]);
  expect((await store.owner.query("SELECT promotion_id FROM public.commerce_promotion_claims WHERE order_id=$1", [saved.id])).rows)
    .toEqual(includeShipping ? [{ promotion_id: shippingPromotion }] : []);
});

it("blocks stamp and receipt rewrites while admitting one-way invalidation and legacy rows", async () => {
  expect((await store.runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [governedCore])).rows)
    .toEqual([{ allowed: false }]);
  await expect(store.runtime.query("UPDATE public.commerce_orders SET metadata=metadata-'catalogAdmissionOwnerOrigin' WHERE id=$1", [order.id]))
    .rejects.toMatchObject(immutable);
  await expect(store.runtime.query("UPDATE public.commerce_order_draft_receipts SET request_fingerprint=repeat('a',32) WHERE order_id=$1", [order.id]))
    .rejects.toMatchObject(immutable);
  await expect(store.runtime.query("UPDATE public.commerce_order_draft_receipts SET invalidated_at=clock_timestamp(),invalidation_reason='expired' WHERE order_id=$1", [order.id]))
    .resolves.toMatchObject({ rowCount: 1 });
  await expect(store.runtime.query("UPDATE public.commerce_order_draft_receipts SET invalidated_at=NULL,invalidation_reason=NULL WHERE order_id=$1", [order.id]))
    .rejects.toMatchObject(immutable);
  const orderId = (await store.owner.query("INSERT INTO public.commerce_orders(status,total_amount_minor,currency_code) VALUES('pending_payment',0,'XTS') RETURNING id")).rows[0]!.id;
  await expect(store.owner.query("UPDATE public.commerce_orders SET metadata=jsonb_build_object('catalogAdmissionOwnerOrigin',null) WHERE id=$1", [orderId]))
    .rejects.toMatchObject(immutable);
});

it("admits a sample in the BEGIN millisecond without accepting an older sample", async () => {
  const db = await store.owner.connect();
  try {
    let timing: { beginning: Date; instant: Date } | undefined;
    for (let attempt = 0; attempt < 25 && !timing; attempt++) {
      const [, sample] = await db.query<{ beginning: Date; instant: Date }>(`BEGIN ISOLATION LEVEL REPEATABLE READ;
        SELECT date_trunc('milliseconds',transaction_timestamp()) AS beginning,date_trunc('milliseconds',clock_timestamp()) AS instant`) as
        unknown as [{ rows: [] }, { rows: { beginning: Date; instant: Date }[] }];
      if (+sample.rows[0]!.beginning === +sample.rows[0]!.instant) timing = sample.rows[0]!;
      else await db.query("ROLLBACK");
    }
    expect(timing).toBeDefined();
    const atTime = timing!.instant.toISOString();
    const current = { ...fixture, original: { ...fixture.original, key: randomUUID() } };
    await prelockDraft(db, current);
    const value = await draftHandoff(db, current, atTime);
    await expect(db.query(ownerSql, [current.original.key, current.original.clientId, value])).resolves.toMatchObject({ rowCount: 1 });
    await db.query("COMMIT");
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

it("uses the sampled half-open boundary for the quote and the SQL price verifier", async () => {
  const { owner } = store;
  const boundary = (await owner.query(`SELECT date_trunc('milliseconds',clock_timestamp())+interval '1 second' AS time`)).rows[0]!.time as Date;
  const ending = (await owner.query(`UPDATE public.price_entries SET valid_to=$3
    WHERE price_list_id=$1 AND variant_id=$2 AND mode='subscription' RETURNING id`, [fixture.profile.priceListId, fixture.profile.skuIds[0], boundary])).rows[0]!.id;
  const starting = (await owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,amount_kind,valid_from)
    VALUES($1,$2,'subscription',1,1300,'gross',$3) RETURNING id`, [fixture.profile.priceListId, fixture.profile.skuIds[0], boundary])).rows[0]!.id;
  try {
    await transaction(owner, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const current = { ...fixture, original: { ...fixture.original, key: randomUUID() } };
      await prelockDraft(db, current);
      expect((await db.query("SELECT transaction_timestamp()<$1::timestamptz AS before", [boundary])).rows[0]!.before).toBe(true);
      const earlier = new Date(boundary.getTime() - 1).toISOString();
      const old = await draftHandoff(db, current, earlier);
      expect(old.draft.lines[0]!.catalogFacts).toMatchObject({ resolvedPriceEntryId: ending });
      await db.query("SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))", [boundary]);
      const atTime = await sampleDraftTime(db), exactStart = boundary.toISOString();
      expect(atTime >= exactStart).toBe(true);
      const currentPrice = await draftHandoff(db, current, exactStart);
      expect(currentPrice.draft.lines[0]!.catalogFacts).toMatchObject({ resolvedPriceEntryId: starting });
      const observed = await draftHandoff(db, current, atTime);
      expect(observed.evidence.quoteDigest).toBe(currentPrice.evidence.quoteDigest);
      expect(observed.submit.submitDigest).toBe(currentPrice.submit.submitDigest);
      old.draft.context.atTime = exactStart;
      for (const line of old.draft.lines) line.catalogFacts.atTime = exactStart;
      await db.query("SAVEPOINT old_quote");
      await expect(db.query(ownerSql, [current.original.key, current.original.clientId, old])).rejects.toMatchObject({
        code: "22023", message: "commerce_order_draft_catalog_price_changed",
      });
      await db.query("ROLLBACK TO SAVEPOINT old_quote");
      await expect(db.query(ownerSql, [current.original.key, current.original.clientId, currentPrice])).resolves.toMatchObject({ rowCount: 1 });
      await db.query("ROLLBACK TO SAVEPOINT old_quote");
      const { rows } = await db.query(ownerSql, [current.original.key, current.original.clientId, observed]);
      const id = String(rows[0]!.result.orderDraft.orderId).slice(6);
      expect((await db.query(`SELECT created_at,total_amount_minor::integer AS amount FROM public.commerce_orders WHERE id=$1`, [id])).rows)
        .toEqual([{ created_at: new Date(atTime), amount: observed.submit.reviewedPayable.amountMinor }]);
    });
  } finally {
    await owner.query("DELETE FROM public.price_entries WHERE id=$1", [starting]);
    await owner.query("UPDATE public.price_entries SET valid_to=NULL WHERE id=$1", [ending]);
  }
});

it("re-derives the saved graph and detects missing, extra and changed companions", async () => {
  const { owner } = store, db = await owner.connect();
  try {
    await db.query("BEGIN");
    // Only the fault fixture disables immediate guards. Final validation still runs.
    await db.query(`ALTER TABLE public.commerce_order_items DISABLE TRIGGER commerce_order_items_catalog_owner_origin_guard;
      ALTER TABLE public.commerce_order_items DISABLE TRIGGER commerce_promotion_claim_money_freeze_trigger`);
    await db.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active)
      SELECT 'example:extra',jsonb_set(definition,'{id}','"example:extra"'),active
      FROM public.commerce_promotion_definitions WHERE promotion_id=$1`, [productPromotion]);
    for (const mutation of [
      "DELETE FROM public.commerce_order_items WHERE order_id=$1 AND line_ordinal=1",
      "UPDATE public.commerce_order_items SET promotion_allocation_fingerprint=repeat('a',64) WHERE order_id=$1 AND line_ordinal=1",
      `INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
        SELECT order_id,sku_id,42,1,0,0 FROM public.commerce_order_items WHERE order_id=$1 AND line_ordinal=1`,
      `INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint)
        SELECT $1,'promotion_discount','order_total',1,promotion_id,definition_fingerprint
        FROM public.commerce_promotion_definitions WHERE promotion_id='example:extra'`,
    ]) {
      await db.query("SAVEPOINT mutated_graph");
      expect((await db.query(mutation, [order.id])).rowCount).toBe(1);
      await expect(db.query("SELECT public.catalog_order_acceptance_final($1)", [order.id])).rejects.toMatchObject({
        code: "22023", message: "catalog_acceptance_line_mismatch",
      });
      await db.query("ROLLBACK TO SAVEPOINT mutated_graph");
      await db.query("RELEASE SAVEPOINT mutated_graph");
      await expect(db.query("SELECT public.catalog_order_acceptance_final($1)", [order.id])).resolves.toMatchObject({ rowCount: 1 });
    }
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});
