import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
      changeDiscount({ promotionId: shippingPromotion }), changeDiscount({ amountOffMinor: 0 }),
      changeDiscount({ amountOffMinor: 4 }), changeTime(undefined), changeTime("2026-02-31T00:00:00.000Z"),
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

function withoutProductDiscount(includeShipping: boolean): GovernedFixture {
  const authority = fixture.profile.authority!;
  return { original: { ...fixture.original, key: randomUUID() }, profile: { ...fixture.profile,
    authority: { ...authority, async evaluate(input: Parameters<typeof authority.evaluate>[0]) {
      const evaluated = await authority.evaluate(input);
      const discounts = evaluated.result.discounts.filter(row => includeShipping && row.appliesTo === "shipping");
      return { ...evaluated, result: { ...evaluated.result, discounts }, decisions: { ...evaluated.decisions,
        promotions: evaluated.decisions.promotions.filter(row => includeShipping && row.ref === shippingPromotion) } };
    } } } };
}

it.each([true, false])("leaves all five allocation columns null without a product discount (shipping discount %s)", async includeShipping => {
  const current = withoutProductDiscount(includeShipping);
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

it.each(["lower", "upper"] as const)("refuses a coherent handoff beyond the %s atTime bound", async bound => {
  const db = await store.owner.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const current = { ...fixture, original: { ...fixture.original, key: randomUUID() } };
    await prelockDraft(db, current);
    const { rows: [times] } = await db.query<{ lower: Date; upper: Date }>(`SELECT
      date_trunc('milliseconds',transaction_timestamp())-interval '1 millisecond' AS lower,
      clock_timestamp()+interval '60 seconds' AS upper`);
    const atTime = times![bound].toISOString();
    const value = await draftHandoff(db, current, atTime);
    expect(value.draft.lines.map(line => line.catalogFacts.atTime)).toEqual([atTime, atTime]);
    await expect(db.query(ownerSql, [current.original.key, current.original.clientId, value])).rejects.toMatchObject(mismatch);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

it("refuses an unsupported discount scope even when payable excludes its amount", async () => {
  const db = await store.owner.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const current = withoutProductDiscount(true);
    await prelockDraft(db, current);
    const atTime = await sampleDraftTime(db);
    const unsupported = await draftHandoff(db, current, atTime);
    const positive = await draftHandoff(db, { ...fixture, original: current.original }, atTime);
    const discount = { ...positive.draft.discounts.find(row => row.promotionId === productPromotion)!, appliesTo: "line" as const };
    const discounts = [...unsupported.draft.discounts, discount];
    unsupported.draft.discounts = unsupported.quoteSnapshot.quote.discounts = discounts;
    expect(unsupported.draft.totals.discountTotalGross.amountMinor).toBe(0);
    await expect(db.query(ownerSql, [current.original.key, current.original.clientId, unsupported])).rejects.toMatchObject(mismatch);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
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

it.each(["service_role", "lifecycle_r"] as const)("guards actual owner-origin keys and preserves non-object metadata for %s", async role => {
  const restricted = role === "lifecycle_r" ? new Pool({ ...store.runtime.options, options: "-c timezone=UTC" }) : undefined;
  const db = await (restricted ?? store.owner).connect();
  const marker = "catalogAdmissionOwnerOrigin";
  const insert = "INSERT INTO public.commerce_orders(status,total_amount_minor,currency_code,metadata) VALUES('pending_payment',0,'XTS',$1::jsonb) RETURNING id";
  const update = "UPDATE public.commerce_orders SET metadata=$1::jsonb WHERE id=$2";
  try {
    await db.query("BEGIN");
    if (!restricted) await db.query("SET LOCAL ROLE service_role");
    expect((await db.query(`SELECT current_user,pg_has_role(current_user,'service_role','USAGE') AS runtime,
      has_function_privilege(current_user,$1,'EXECUTE') AS core,
      has_function_privilege(current_user,'public.catalog_admission_owner_origin_guard()','EXECUTE') AS guard`, [governedCore])).rows)
      .toEqual([{ current_user: role, runtime: true, core: false, guard: false }]);
    const { id } = (await db.query(insert, ["{}"])).rows[0]!;
    for (const value of [marker, [marker], { schemaVersion: 1 }, 1, null]) {
      const metadata = JSON.stringify({ [marker]: value });
      for (const [sql, args] of [[insert, [metadata]], [update, [metadata, id]]] as const) {
        await db.query("SAVEPOINT owner_marker");
        await expect(db.query(sql, [...args])).rejects.toMatchObject(immutable);
        await db.query("ROLLBACK TO SAVEPOINT owner_marker");
        await db.query("RELEASE SAVEPOINT owner_marker");
      }
    }
    for (const value of [marker, [marker], 1, null]) {
      const metadata = JSON.stringify(value);
      await expect(db.query(insert, [metadata])).resolves.toMatchObject({ rowCount: 1 });
      await expect(db.query(update, [metadata, id])).resolves.toMatchObject({ rowCount: 1 });
    }
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await restricted?.end();
  }
});

it("refuses an item insert on a stamped order immediately", async () => {
  const db = await store.runtime.connect();
  try {
    await db.query("BEGIN");
    await expect(db.query(`INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      VALUES($1,$2,91,1,1,1)`, [order.id, fixture.profile.skuIds[1]])).rejects.toMatchObject(immutable);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
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

it("ignores a higher matching subscription tier on another regional list", async () => {
  const db = await store.owner.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const current = { ...fixture, original: { ...fixture.original, key: randomUUID() } };
    const { skuIds, priceListId } = current.profile;
    const { rows: [rival] } = await db.query(`WITH other AS (
      INSERT INTO public.price_lists(name,region_code,currency,status,valid_from)
      SELECT 'Other market','XY',currency,'active',clock_timestamp()-interval '1 day'
      FROM public.price_lists WHERE id=$1 RETURNING id
    ) INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,amount_kind,valid_from)
      SELECT id,$2,'subscription',2,987,'gross',clock_timestamp()-interval '1 day' FROM other RETURNING id`, [priceListId, skuIds[0]]);
    await prelockDraft(db, current);
    const value = await draftHandoff(db, current, await sampleDraftTime(db));
    expect(value.draft.lines[0]).toMatchObject({ quantity: 2, catalogFacts: { version: "catalog_facts_v1", resolvedUnitAmountMinor: 1340 } });
    expect(value.draft.lines[0]!.catalogFacts).not.toMatchObject({ resolvedPriceEntryId: rival!.id });
    await expect(db.query(ownerSql, [current.original.key, current.original.clientId, value])).resolves.toMatchObject({ rowCount: 1 });
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

async function waitForExpiry(db: PoolClient, atTime: string, expiry: string) {
  await db.query("SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))", [expiry]);
  expect((await db.query(`SELECT $1::timestamptz<$2::timestamptz AND $2::timestamptz<=clock_timestamp() AS crossed`,
    [atTime, expiry])).rows).toEqual([{ crossed: true }]);
}

it.each(["legacy price", "acquisition", "promotion"] as const)(
  "honors a sampled %s window after it expires", async window => {
    const db = await store.owner.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const current = { ...fixture, original: { ...fixture.original, key: randomUUID() } };
      await prelockDraft(db, current);
      const atTime = await sampleDraftTime(db);
      const expiry = new Date(+new Date(atTime) + 1).toISOString();
      const { priceListId, skuIds } = current.profile;
      if (window === "legacy price") {
        expect((await db.query(`UPDATE public.price_entries SET valid_to=$3 WHERE price_list_id=$1
          AND variant_id=$2 AND mode='subscription'`, [priceListId, skuIds[0], expiry])).rowCount).toBe(1);
      }
      if (window === "promotion") expect((await setPromotionExpiry(db, expiry)).rowCount).toBe(1);
      const quoted = await draftHandoff(db, window === "acquisition" ? withAcquisitionExpiry(current, expiry) : current, atTime);
      expect(quoted.draft.lines[0]!.catalogFacts.version).toBe("catalog_facts_v1");
      await waitForExpiry(db, quoted.quoteSnapshot.quote.context.atTime!, expiry);
      const { rows } = await db.query(ownerSql, [current.original.key, current.original.clientId, quoted]);
      const id = String(rows[0]!.result.orderDraft.orderId).slice(6);
      await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect((await db.query("SELECT created_at FROM public.commerce_orders WHERE id=$1", [id])).rows)
        .toEqual([{ created_at: new Date(atTime) }]);
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  },
);

it("passes the sampled instant into the derived-price verifier", async () => {
  const current = { ...fixture, original: { ...fixture.original, key: randomUUID() } };
  const { rows: [policy] } = await store.owner.query<{ id: string; effective_from: Date }>(`WITH revision AS (
    SELECT gen_random_uuid() AS id,date_trunc('milliseconds',clock_timestamp())+interval '2 seconds' AS starts
  )
  INSERT INTO public.subscription_price_policy_revisions
    (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,rounding_rule,effective_from,digest)
  SELECT r.id,l.id,l.region_code,l.currency,'D2C',1,2000,1,'FLOOR_TO_QUANTUM',r.starts,
    public.catalog_price_setup_policy_digest(r.id,1,l.id,l.region_code,l.currency,'D2C',r.starts,NULL,2000,1,'FLOOR_TO_QUANTUM')
  FROM revision r JOIN public.price_lists l ON l.id=$1 RETURNING id,effective_from`, [current.profile.priceListId]);
  const boundary = policy!.effective_from;
  const db = await store.owner.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await prelockDraft(db, current);
    expect((await db.query("SELECT transaction_timestamp()<$1::timestamptz AS before", [boundary])).rows[0]!.before).toBe(true);
    await expect(draftHandoff(db, current, new Date(+boundary - 1).toISOString()))
      .rejects.toMatchObject({ message: "subscription_price_policy_not_effective" });
    await db.query("SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))", [boundary]);
    const atTime = await sampleDraftTime(db);
    const expiry = new Date(+new Date(atTime) + 1).toISOString();
    expect((await db.query(`UPDATE public.price_entries SET valid_to=$3 WHERE price_list_id=$1
      AND variant_id=$2 AND mode='one_time'`, [current.profile.priceListId, current.profile.skuIds[0], expiry])).rowCount).toBe(1);
    const currentQuote = await draftHandoff(db, current, atTime);
    expect(+new Date(atTime)).toBeGreaterThanOrEqual(+boundary);
    expect(currentQuote.draft.lines.map(line => line.catalogFacts)).toEqual([0, 1].map(() => expect.objectContaining({
      version: "catalog_facts_v2", policyRevisionId: policy!.id, resolvedUnitAmountMinor: 1192, atTime,
    })));
    await waitForExpiry(db, currentQuote.quoteSnapshot.quote.context.atTime!, expiry);
    const { rows } = await db.query(ownerSql, [current.original.key, current.original.clientId, currentQuote]);
    const id = String(rows[0]!.result.orderDraft.orderId).slice(6);
    expect((await db.query("SELECT created_at,total_amount_minor::integer AS amount FROM public.commerce_orders WHERE id=$1", [id])).rows)
      .toEqual([{ created_at: new Date(atTime), amount: currentQuote.submit.reviewedPayable.amountMinor }]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

function withAcquisitionExpiry(current: GovernedFixture, effectiveTo: string): GovernedFixture {
  const authority = current.profile.authority!;
  return { ...current, profile: { ...current.profile, authority: {
    ...authority, async evaluate(input: Parameters<typeof authority.evaluate>[0]) {
      const evaluation = await authority.evaluate(input);
      return { ...evaluation, result: { ...evaluation.result,
        acquisitionTerms: { ...evaluation.result.acquisitionTerms, effectiveTo } } };
    },
  } } };
}

function setPromotionExpiry(db: PoolClient, validTo: string | null) {
  return db.query(`UPDATE public.commerce_promotion_definitions
    SET definition=jsonb_set(definition,'{valid_to}',coalesce(to_jsonb($2::text),'null'::jsonb)) WHERE promotion_id=$1`,
  [productPromotion, validTo]);
}

it.each([
  ["acquisition", mismatch],
  ["promotion", { code: "40001", message: "commerce_promotion_definition_not_active" }],
] as const)("refuses an expired %s window at the sampled instant", async (window, refusal) => {
  const db = await store.owner.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const current = { ...fixture, original: { ...fixture.original, key: randomUUID() } };
    await prelockDraft(db, current);
    const { rows: [timing] } = await db.query<{ expiry: Date }>(`
      SELECT date_trunc('milliseconds',clock_timestamp())+interval '1 millisecond' AS expiry`);
    const expiry = timing!.expiry.toISOString();
    const expiring = window === "acquisition" ? withAcquisitionExpiry(current, expiry) : current;
    if (window === "promotion") expect((await setPromotionExpiry(db, expiry)).rowCount).toBe(1);

    await db.query("SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))", [expiry]);
    const atTime = await sampleDraftTime(db);
    const expired = await draftHandoff(db, expiring, atTime);
    expect((await db.query(`SELECT transaction_timestamp()<$1::timestamptz AND $1::timestamptz<=$2::timestamptz AS crossed`,
      [expiry, expired.quoteSnapshot.quote.context.atTime])).rows).toEqual([{ crossed: true }]);
    const before = await draftEffectCounts(db);
    const write = (payload: typeof expired) => db.query(ownerSql, [current.original.key, current.original.clientId, payload]);
    await db.query("SAVEPOINT expired_window");
    await expect(write(expired)).rejects.toMatchObject(refusal);
    await db.query("ROLLBACK TO SAVEPOINT expired_window");
    expect(await draftEffectCounts(db)).toEqual(before);

    if (window === "promotion") expect((await setPromotionExpiry(db, null)).rowCount).toBe(1);
    const active = window === "acquisition" ? await draftHandoff(db, current, atTime) : expired;
    const { rows } = await write(active);
    const id = String(rows[0]!.result.orderDraft.orderId).slice(6);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    expect((await db.query("SELECT created_at FROM public.commerce_orders WHERE id=$1", [id])).rows)
      .toEqual([{ created_at: new Date(atTime) }]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

it("rejects late adjustment inserts and claim money changes at ordinary COMMIT", async () => {
  expect((await store.owner.query(`SELECT catalog_acceptance->'admission' IS NOT NULL AS accepted,
    metadata->'catalogAdmissionOwnerOrigin' IS NOT NULL AS stamped FROM public.commerce_orders WHERE id=$1`, [order.id])).rows)
    .toEqual([{ accepted: true, stamped: true }]);
  const { rows: [definition] } = await store.owner.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active)
    SELECT 'example:late',jsonb_set(definition,'{id}','"example:late"'),active
    FROM public.commerce_promotion_definitions WHERE promotion_id=$1 RETURNING definition_fingerprint`, [productPromotion]);
  const db = await store.runtime.connect();
  try {
    for (const [sql, values] of [
      [`INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint)
        VALUES($1,'promotion_discount','order_total',1,'example:late',$2)`, [order.id, definition!.definition_fingerprint]],
      ["UPDATE public.commerce_promotion_claims SET amount_off_minor=amount_off_minor+1 WHERE order_id=$1 AND promotion_id=$2", [order.id, productPromotion]],
    ] as const) {
      await db.query("BEGIN");
      expect((await db.query(sql, [...values])).rowCount).toBe(1);
      await expect(db.query("COMMIT")).rejects.toMatchObject({ code: "22023", message: "catalog_acceptance_line_mismatch" });
    }
    expect((await db.query("SELECT count(*)::integer AS extras FROM public.commerce_order_adjustments WHERE promotion_id='example:late'")).rows)
      .toEqual([{ extras: 0 }]);
    expect((await db.query("SELECT amount_off_minor::integer AS amount FROM public.commerce_promotion_claims WHERE order_id=$1 AND promotion_id=$2",
      [order.id, productPromotion])).rows).toEqual([{ amount: 3 }]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
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
