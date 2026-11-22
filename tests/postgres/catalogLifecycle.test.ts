import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogAcceptanceV2 } from "@openlup/core/catalog";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixture, graph, insertGraph, installPublicationActors, json, transaction, type Graph } from "./catalogPublicationFixture.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer, pool: Pool, first: Graph, withdrawn: Graph;
let acceptance: CatalogAcceptanceV2;
const data = fixture();
const refusal = (message: string) => ({ message });

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-lifecycle-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Lifecycle proof needs PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as
    { baseline: { file: string }; forward: { file: string }[] };
  for (const unit of [manifest.baseline, ...manifest.forward]) await pool.query(readFileSync(unit.file, "utf8"));
  await installPublicationActors(pool);
  await transaction(pool, async db => {
    first = await graph(db, data, null, true, { lifecycle: "active" });
    await insertGraph(db, first);
    withdrawn = await graph(db, data, first.head, true, { lifecycle: "withdrawn" });
    await insertGraph(db, withdrawn);
  });
  const facts = first.facts as Graph["facts"] & { optionDigest: string };
  const product = first.product as Graph["product"] & { definitionDigest: string };
  acceptance = { schemaVersion: 2, lines: [{ schemaVersion: 2, skuId: data.skuId, skuCode: facts.code,
    skuRevisionId: first.skuRevisionId, publicationHead: first.head, typeRef: product.type,
    definitionDigest: product.definitionDigest, optionDigest: facts.optionDigest, netContent: facts.netContent }] };
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

async function committed(work: (db: PoolClient) => Promise<void>, error?: string) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await work(db);
    const commit = db.query("COMMIT");
    if (error) await expect(commit).rejects.toMatchObject(refusal(error));
    else await expect(commit).resolves.toMatchObject({ command: "COMMIT" });
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
}

async function subscription(db: PoolClient, state = "cancelled") {
  const id = randomUUID(), client = randomUUID(), principal = randomUUID();
  await db.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client, `${client}@example.invalid`, principal]);
  await db.query("INSERT INTO public.subscriptions(id,client_id,status,cadence_days,next_cycle_at) VALUES($1,$2,$3,28,now()+interval '28 days')",
    [id, client, state]);
  return { id, client, principal };
}

it("rejects a revision-one rewrite and a consistent unissued SKU at COMMIT", async () => {
  const rewrite = (revision: string) => async (db: PoolClient) => {
    const result = await db.query(`UPDATE public.catalog_skus s
      SET publication_facts=r.full_facts::jsonb,status=r.full_facts::jsonb->>'status',
        sellable_standalone=(r.full_facts::jsonb->>'sellableStandalone')::boolean,
        sellable_in_subscription=(r.full_facts::jsonb->>'sellableInSubscription')::boolean
      FROM public.catalog_sku_revisions r WHERE s.id=$1 AND (r.sku_id,r.id)=(s.id,$2)`, [data.skuId, revision]);
    expect(result.rowCount).toBe(1);
  };
  await committed(rewrite(first.skuRevisionId), "catalog_lifecycle_raw_status_fenced");
  await committed(async db => {
    await rewrite(first.skuRevisionId)(db);
    await rewrite(withdrawn.skuRevisionId)(db);
  });
  await committed(async db => {
    const inserted = await db.query(`INSERT INTO public.catalog_skus
      (id,product_id,sku,title,status,sellable_standalone,sellable_in_subscription,publication_facts)
      SELECT $2,product_id,$3,title,'draft',false,false,publication_facts || jsonb_build_object(
        'id',$2::uuid,'code',$3::text,'status','draft','lifecycleState','draft','sellableStandalone',false,'sellableInSubscription',false)
      FROM public.catalog_skus WHERE id=$1`, [data.skuId, randomUUID(), `${first.facts.code}-unissued`]);
    expect(inserted.rowCount).toBe(1);
  }, "catalog_lifecycle_raw_status_fenced");
});

it("validates the issuing roster after withdrawal and rejects altered identity", async () => {
  const check = (tuple: CatalogAcceptanceV2) => pool.query("SELECT public.catalog_acceptance_assert_v2($1)", [json(tuple)]);
  await expect(check(acceptance)).resolves.toBeDefined();
  for (const wrong of [{ skuRevisionId: withdrawn.skuRevisionId }, { publicationHead: withdrawn.head },
    { optionDigest: "1".repeat(64) }, { definitionDigest: "2".repeat(64) }, { demandPolicyRef: "example:unissued" },
    { netContent: { ...acceptance.lines[0]!.netContent, unscaled: "111" } }]) {
    await expect(check({ ...acceptance, lines: [{ ...acceptance.lines[0]!, ...wrong }] }))
      .rejects.toMatchObject(refusal("catalog_accepted_reference_mismatch"));
  }
});

async function receipt(db: PoolClient, order: string, sku: string, qty = 1) {
  await db.query(`INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
    VALUES($1,$2,$3,$4)`, [`receipt:${order}`, "f".repeat(32), order, json({
    orderDraft: { orderId: `order_${order}`, quoteSnapshot: { quote: { lines: [{ sku, quantity: qty }] } } },
  })]);
}
async function bindOrder(db: PoolClient, order: string, value = acceptance) {
  await db.query("UPDATE public.commerce_orders SET catalog_acceptance=$2,catalog_receipt_key=$3,catalog_basket=$4 WHERE id=$1",
    [order, json(value), `receipt:${order}`, json({ [first.facts.code]: 1 })]);
}

it.each([true, false])("reconciles a receipt-only order with receipt staged first %s", async receiptFirst => {
  const order = randomUUID();
  await committed(async db => {
    await db.query("INSERT INTO public.commerce_orders(id,status,currency_code,total_amount_minor) VALUES($1,'cancelled','XXX',0)", [order]);
    if (receiptFirst) await receipt(db, order, first.facts.code);
    await bindOrder(db, order);
    if (!receiptFirst) await receipt(db, order, first.facts.code);
  });
  await committed(async db => {
    await db.query("DELETE FROM public.commerce_order_draft_receipts WHERE order_id=$1", [order]);
  }, "catalog_acceptance_receipt_mismatch");
  await committed(async db => {
    await db.query(`UPDATE public.commerce_order_draft_receipts
      SET response_payload=jsonb_set(response_payload,'{orderDraft,quoteSnapshot,quote,lines,0,quantity}','2') WHERE order_id=$1`, [order]);
  }, "catalog_acceptance_line_mismatch");
  await committed(async db => {
    await db.query("UPDATE public.commerce_orders SET catalog_acceptance=NULL WHERE id=$1", [order]);
  }, "catalog_acceptance_immutable");
  await committed(async db => {
    const replacement = { ...acceptance, lines: [{ ...acceptance.lines[0]!, skuRevisionId: withdrawn.skuRevisionId, publicationHead: withdrawn.head }] };
    await bindOrder(db, order, replacement);
    await bindOrder(db, order);
  }, "catalog_acceptance_immutable");
});

it("checks a queued forged order even when its rows are removed before COMMIT", async () => {
  const order = randomUUID();
  await committed(async db => {
    await db.query("INSERT INTO public.commerce_orders(id,status,currency_code,total_amount_minor) VALUES($1,'cancelled','XXX',0)", [order]);
    await bindOrder(db, order, { ...acceptance, lines: [{ ...acceptance.lines[0]!, optionDigest: "9".repeat(64) }] });
    await db.query("DELETE FROM public.commerce_orders WHERE id=$1", [order]);
  }, "catalog_accepted_reference_mismatch");
});

it.each(["event then preview", "preview then event", "missing", "wrong quantity", "wrong subject", "transient forged"] as const)(
  "reconciles deferred edit evidence for %s", async scenario => {
    const event = randomUUID(), preview = randomUUID(), key = `edit:${event}`, action = "update_package_template";
    const when = new Date();
    await committed(async db => {
      const owner = await subscription(db);
      const quoteOwner = scenario === "wrong subject" ? await subscription(db) : owner;
      async function insertPreview() {
        const quantity = scenario === "wrong quantity" ? 2 : 1;
        await db.query(`INSERT INTO public.subscription_quote_previews
          (id,subscription_id,client_id,actor_id,action,quote_hash,template_version,expires_at,request_payload,quote_snapshot,totals)
          VALUES($1,$2,$3,$4,$5,$6,1,now()+interval '1 hour','{}',$7,'{}')`,
        [preview, quoteOwner.id, quoteOwner.client, randomUUID(), action, "b".repeat(64),
          json({ baseLines: [{ variantId: data.skuId, qty: quantity, quoteLine: { sku: first.facts.code } }], addonLines: [] })]);
      }
      if (scenario === "preview then event") await insertPreview();
      const chosen = structuredClone(acceptance);
      if (scenario === "transient forged") chosen.lines[0]!.optionDigest = "d".repeat(64);
      await db.query(`INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload,occurred_at,catalog_acceptance,catalog_basket)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [event, owner.id, `subscription.customer_self_service.${action}`, key, json({ action, quotePreviewId: preview }), when,
        json(chosen), json({ [first.facts.code]: 1 })]);
      if (scenario === "transient forged") {
        await db.query("DELETE FROM public.subscription_events WHERE id=$1", [event]);
        return;
      }
      if (scenario !== "preview then event" && scenario !== "missing") await insertPreview();
      if (scenario !== "missing") await db.query(`UPDATE public.subscription_quote_previews
        SET status='accepted',accepted_event_id=$2,accepted_at=$3,accepted_idempotency_key=$4 WHERE id=$1`, [preview, event, when, key]);
    }, scenario === "transient forged" ? "catalog_accepted_reference_mismatch"
      : ["missing", "wrong quantity", "wrong subject"].includes(scenario) ? "catalog_acceptance_line_mismatch" : undefined);
    if (scenario.endsWith("then event") || scenario.endsWith("then preview")) {
      await committed(async db => {
        await db.query("UPDATE public.subscription_quote_previews SET quote_snapshot=jsonb_set(quote_snapshot,'{baseLines,0,qty}','2') WHERE id=$1",
          [preview]);
      }, "catalog_acceptance_line_mismatch");
      await committed(async db => {
        await db.query("UPDATE public.subscription_events SET catalog_acceptance=NULL WHERE id=$1", [event]);
      }, "catalog_acceptance_immutable");
    }
  });

async function rolledBack(work: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await work(db);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
}
const families = ["template", "pending_activation", "frozen_renewal", "outstanding_order", "replacement", "stock_wait", "graduation"] as const;
type Family = typeof families[number];

async function obligations(db: PoolClient) {
  return (await db.query<{ result: { outcome: string; obligations: { family: string; sourceId: string }[] } }>(
    "SELECT public.catalog_bound_obligations_v2($1) AS result", [data.skuId])).rows[0]!.result;
}

async function obligationOrder(db: PoolClient, client: string, status: string, skuId = data.skuId) {
  const order = randomUUID();
  await db.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'XXX',100)",
    [order, client, status]);
  await db.query(`INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
    VALUES($1,$2,1,1,100,100)`, [order, skuId]);
  return order;
}

async function legacyOperation(db: PoolClient, subscriptionId: string, state = "claimed", snapshot: unknown = { lines: [{ sku: first.facts.code, quantity: 1 }] }) {
  const operation = randomUUID();
  await db.query(`INSERT INTO public.subscription_renewal_operations
    (id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,claim_token,claim_generation,claimed_by,claimed_at,lease_expires_at,state,
     terminal_outcome,terminal_reason,terminal_at)
    VALUES($1,$2,now(),2,$3,$4,$5,$6,1,'proof',now(),now()+interval '1 minute',$7,
      CASE WHEN $7='refused' THEN 'refused' END,CASE WHEN $7='refused' THEN 'inventory_unavailable' END,
      CASE WHEN $7='refused' THEN now() END)`, [operation, subscriptionId, `synthetic-renewal:${operation}`, "a".repeat(64), json(snapshot), randomUUID(), state]);
  return operation;
}

async function seedObligation(db: PoolClient, family: Family) {
  const owner = await subscription(db, family === "template" ? "paused" : family === "graduation" ? "active" : "cancelled");
  switch (family) {
    case "template":
      await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code)
        VALUES($1,$2,1,0,100,'XXX')`, [owner.id, data.skuId]);
      break;
    case "pending_activation": {
      const order = await obligationOrder(db, owner.client, "pending_payment");
      await db.query("INSERT INTO public.subscription_activations(order_id,client_id,cadence_days,declare_idempotency_key) VALUES($1,$2,28,$3)",
        [order, owner.client, `activate:${order}`]);
      break;
    }
    case "frozen_renewal":
      await legacyOperation(db, owner.id);
      break;
    case "outstanding_order":
      await obligationOrder(db, owner.client, "paid");
      break;
    case "replacement": {
      const order = await obligationOrder(db, owner.client, "cancelled");
      const root = randomUUID(), middle = randomUUID(), leaf = randomUUID();
      await db.query("INSERT INTO public.fulfillment_ports(port_key,provider_type) VALUES('lifecycle:manual','manual')");
      await db.query(`INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key)
        VALUES($1,$2,'lifecycle:manual','manual','exception',$1::uuid::text)`, [root, order]);
      for (const [id, previous, sequence] of [[middle, root, 1], [leaf, middle, 2]] as const) {
        await db.query(`INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key,replaces_shipment_id,sequence_no,replacement_reason)
          VALUES($1,$2,'lifecycle:manual','manual','in_transit',$1::uuid::text,$3,$4,'lost')`, [id, order, previous, sequence]);
      }
      await db.query("INSERT INTO public.fulfillment_parcel_reservation_sets(shipment_id,order_id) VALUES($1,$2)", [leaf, order]);
      await db.query(`INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity)
        SELECT $1,id,sku_id,$2,quantity FROM public.commerce_order_items WHERE order_id=$3`, [leaf, first.facts.code, order]);
      expect((await obligations(db)).obligations?.filter(item => item.family === "replacement"))
        .toEqual([expect.objectContaining({ sourceId: leaf })]);
      break;
    }
    case "stock_wait": {
      const op = await legacyOperation(db, owner.id, "refused");
      await db.query(`INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,
        state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits)
        SELECT $1,$2,id,scheduled_at,cycle_number,'waiting','{}',cycle_snapshot,operation_fingerprint,identity_key,'[]'
        FROM public.subscription_renewal_operations WHERE id=$3`, [owner.id, owner.client, op]);
      break;
    }
    case "graduation": {
      const other = fixture(), code = `sku-${other.skuId}`;
      await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Article')", [other.productId, `article-${other.productId}`]);
      await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Article')", [other.skuId, other.productId, code]);
      await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code)
        VALUES($1,$2,1,0,100,'XXX')`, [owner.id, other.skuId]);
      const order = await obligationOrder(db, owner.client, "cancelled", other.skuId);
      await db.query(`INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts,completed_at)
        VALUES($1,$2,$3,now())`, [order, owner.id, json({ renewalTerms: { starterPack: { schemaVersion: "1", basisTemplateVersion: 1,
        starterIntervalDays: 14, graduation: { cadenceDays: 28, lines: [{ sku: first.facts.code, qty: 1, sortOrder: 0,
          isAddon: false, quoteLine: { sku: first.facts.code, quantity: 1 } }] } } } })]);
      break;
    }
  }
}

it.each([...families, "all"] as const)("refuses archive with %s obligations", async selected => {
  const expected = selected === "all" ? families : [selected];
  await rolledBack(async db => {
    for (const family of expected) await seedObligation(db, family);
    const result = await obligations(db);
    expect(result.outcome).toBe("complete");
    expect(new Set(result.obligations.map(value => value.family))).toEqual(new Set(expected));
    await expect(db.query("SELECT public.catalog_lifecycle_assert_archive($1)", [data.productId]))
      .rejects.toMatchObject({ constraint: "catalog_bound_obligations" });
  });
});

it("refuses empty, illegible and filtered census results", async () => {
  await rolledBack(async db => {
    expect(await obligations(db)).toEqual({ schemaVersion: 2, outcome: "complete", obligations: [] });
    await expect(db.query("SELECT public.catalog_lifecycle_assert_archive($1)", [data.productId]))
      .rejects.toMatchObject({ constraint: "catalog_archive_barrier_unavailable" });
  });
  await rolledBack(async db => {
    const owner = await subscription(db);
    await legacyOperation(db, owner.id, "claimed", {});
    expect(await obligations(db)).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
    await expect(db.query("SELECT public.catalog_lifecycle_assert_archive($1)", [data.productId]))
      .rejects.toMatchObject({ constraint: "catalog_obligation_evidence_unknown" });
  });
  await rolledBack(async db => {
    await db.query("CREATE ROLE catalogue_census_reader NOLOGIN");
    await db.query("GRANT USAGE ON SCHEMA public TO catalogue_census_reader");
    await db.query("GRANT EXECUTE ON FUNCTION public.catalog_bound_obligations_v2(uuid) TO catalogue_census_reader");
    await db.query("SET LOCAL ROLE catalogue_census_reader");
    expect(await obligations(db)).toMatchObject({ outcome: "unavailable", reason: "catalog_obligation_evidence_unavailable" });
  });
});

it("rejects a foreign-SKU template binding and leaves legacy lines nullable", async () => {
  await rolledBack(async db => {
    const owner = await subscription(db), other = fixture();
    await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Article')", [other.productId, `article-${other.productId}`]);
    await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Article')",
      [other.skuId, other.productId, `sku-${other.skuId}`]);
    const line = (revision: string | null) => db.query(`INSERT INTO public.subscription_lines
      (subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code,catalog_sku_revision_id)
      VALUES($1,$2,1,0,100,'XXX',$3) RETURNING catalog_sku_revision_id`, [owner.id, other.skuId, revision]);
    expect((await line(null)).rows).toEqual([{ catalog_sku_revision_id: null }]);
    await db.query("DELETE FROM public.subscription_lines WHERE subscription_id=$1", [owner.id]);
    await expect(line(first.skuRevisionId)).rejects.toMatchObject({ constraint: "subscription_lines_catalog_sku_revision_fkey" });
  });
});

it("replays the stored acceptance after reopening without changing frozen v1 bytes", async () => {
  const { createNativeRenewalCodec, createPostgresRenewalStore } = await import("@openlup/platform/subscriptions");
  const codec = createNativeRenewalCodec();
  const at = new Date(Date.now() - 1000).toISOString();
  const scheduleAt = at.replace("Z", "000Z");
  const lines = [{ lineOrdinal: 1, sku: first.facts.code, quantity: 1, unitAmountMinor: 100 }];
  const originalTerms = { templateId: "fixture", shippingAmountMinor: 0, acquisitionRef: null };
  const purchase = { ...originalTerms, currency: "XXX", stockSourceKey: "fixture", settlementChannelKey: "sandbox", lines,
    unattendedChargeAuthorizedAt: at, authorizationRef: "fixture", payerAccountRef: null, methodRef: "fixture", methodEvidenceRef: "fixture" };
  const owner = await transaction(pool, async db => {
    const owner = await subscription(db, "cancelled");
    await db.query("UPDATE public.subscriptions SET status='active',next_cycle_at=$2 WHERE id=$1", [owner.id, at]);
    await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,unit_price_minor,currency_code)
      VALUES($1,$2,1,0,100,'XXX')`, [owner.id, data.skuId]);
    const order = await obligationOrder(db, owner.client, "paid");
    await receipt(db, order, first.facts.code);
    await bindOrder(db, order);
    await db.query(`INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,state,cadence_days,activated_at,
      payment_fingerprint,activation_idempotency_key,declare_idempotency_key) VALUES($1,$2,$3,'active',28,$4,$5,$6,$7)`,
    [order, owner.client, owner.id, at, "1".repeat(64), `activate:${order}`, `declare:${order}`]);
    await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts) VALUES($1,$2,$3)",
      [order, owner.id, json(purchase)]);
    const attach = () => db.query("SELECT public.subscription_complete_renewal_attachment($1) AS result", [order]);
    expect((await attach()).rows).toEqual([{ result: { subscriptionId: owner.id, replayed: false } }]);
    expect((await attach()).rows).toEqual([{ result: { subscriptionId: owner.id, replayed: true } }]);
    expect((await db.query("SELECT catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1", [owner.id])).rows)
      .toEqual([{ catalog_sku_revision_id: first.skuRevisionId }]);
    expect((await db.query("SELECT public.subscription_renewal_purchase_terms($1) AS result", [owner.id])).rows)
      .toEqual([{ result: originalTerms }]);
    return owner;
  });
  const snapshot = codec.freeze({ subscription_id: owner.id, client_id: owner.client, cadence_days: 28, template_version: 1,
    currency_code: "XXX", stock_source_key: "fixture", settlement_channel_key: "sandbox", authorization_ref: "fixture",
    unattended_charge_authorized_at: scheduleAt, scheduled_at: scheduleAt, next_cycle_number: 1, activation_cycle_id: randomUUID(),
    activation_cycle_paid: true, paid_cycle_count: 1, purchase_facts: originalTerms, lines },
  { subscriptionId: owner.id, scheduledAt: scheduleAt, scheduledInstant: Date.parse(at) });
  const input = { snapshot, workerId: "fixture", now: new Date().toISOString() };
  const firstRead = await createPostgresRenewalStore(pool, codec).claimDue(input);
  expect(firstRead).toMatchObject({ acquired: true, replayed: false, catalogAcceptance: acceptance, cycleSnapshot: snapshot });
  const stored = (await pool.query(`SELECT cycle_snapshot,catalog_acceptance,catalog_acceptance_fingerprint
    FROM public.subscription_renewal_operations WHERE id=$1`, [firstRead.operationId])).rows[0];
  expect(stored).toEqual({ cycle_snapshot: codec.encode(snapshot), catalog_acceptance: acceptance,
    catalog_acceptance_fingerprint: snapshot.frozenFingerprint });
  expect(stored.cycle_snapshot).not.toHaveProperty("catalogAcceptance");
  await expect(pool.query("UPDATE public.subscription_renewal_operations SET catalog_acceptance=NULL WHERE id=$1", [firstRead.operationId]))
    .rejects.toMatchObject(refusal("catalog_acceptance_snapshot_immutable"));
  await expect(pool.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot='{}' WHERE id=$1", [firstRead.operationId]))
    .rejects.toMatchObject(refusal("catalog_acceptance_snapshot_immutable"));
  await pool.query("UPDATE public.subscription_renewal_terms SET catalog_acceptance=NULL WHERE subscription_id=$1", [owner.id]);
  await pool.query("UPDATE public.subscriptions SET template_version=template_version+1 WHERE id=$1", [owner.id]);
  const reopened = new Pool({ connectionString: container.connectionString });
  try {
    const store = createPostgresRenewalStore(reopened, codec);
    expect(await store.buildCycleSnapshots(snapshot)).toEqual(snapshot);
    expect(await store.claimDue(input)).toMatchObject({ acquired: false, replayed: true, catalogAcceptance: acceptance });
  } finally {
    await reopened.end();
  }
});

it.each([true, false])("checks only the authenticated customer's bound event at COMMIT (owns event %s)", async ownsEvent => {
  const id = randomUUID(), quoteHash = "a".repeat(64), key = `classic:${id}`;
  const identity = await transaction(pool, async db => {
    const a = await subscription(db);
    const when = new Date();
    await db.query(`INSERT INTO public.subscription_events
      (id,subscription_id,event_type,idempotency_key,payload,occurred_at,catalog_acceptance,catalog_basket)
      VALUES($1,$2,'subscription.customer_self_service.update_bundle',$3,$4,$5,$6,$7)`,
    [id, a.id, key, json({ action: "update_bundle", quoteHash, templateVersion: 2 }), when,
      json(acceptance), json({ [first.facts.code]: 1 })]);
    await db.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,expected_template_version,
      proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,status,expires_at,accepted_event_id,accepted_at)
      VALUES($1,$2,$3,$4,1,$5,28,100,100,'XXX','accepted',now()+interval '1 hour',$6,$7)`,
    [a.id, key, "b".repeat(64), quoteHash, json([{ variantId: data.skuId, quantity: 1, isAddon: false }]), id, when]);
    return a;
  });
  await committed(async db => {
    // Queue owner-side revalidation of intact evidence, then finish under the customer login.
    await db.query("UPDATE public.subscription_edit_quotes SET accepted_at=accepted_at WHERE accepted_event_id=$1", [id]);
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [json({ sub: ownsEvent ? identity.principal : randomUUID(), role: "authenticated" })]);
    const grants = await db.query(`SELECT has_table_privilege(current_user,'public.subscription_events','SELECT') AS reads_events,
      has_function_privilege(current_user,'public.catalog_customer_edit_acceptance_assert(uuid)','EXECUTE') AS runs_assertion`);
    expect(grants.rows).toEqual([{ reads_events: false, runs_assertion: false }]);
  });
  await committed(async db => {
    await db.query("UPDATE public.subscription_edit_quotes SET proposed_lines=jsonb_set(proposed_lines,'{0,quantity}','2') WHERE accepted_event_id=$1", [id]);
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [json({ sub: identity.principal, role: "authenticated" })]);
  }, "catalog_acceptance_line_mismatch");
});
