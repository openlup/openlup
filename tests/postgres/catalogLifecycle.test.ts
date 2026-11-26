import { randomUUID } from "node:crypto";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { catalogAcceptanceV2Schema, nativeCatalogPublication } from "@openlup/platform/catalog";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { activateNativePurchaseWithRenewal, createNativeRenewalCodec, createPostgresPurchaseRenewalWriter,
  createPostgresRenewalStore, type NativeRenewalPurchaseFacts, type SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import type { CatalogAcceptanceV2 } from "@openlup/core/catalog";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixture, graph, insertGraph, installPublicationActors, json, transaction, type Graph } from "./catalogPublicationFixture.js";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer, pool: Pool, installer: Pool, runtime: Pool, first: Graph, withdrawn: Graph;
let acceptance: CatalogAcceptanceV2;
const data = fixture();
const refusal = (message: string) => ({ message });

beforeAll(async () => {
  container = await runPostgresContainer({ name: `catalog-lifecycle-${process.pid}`, password: randomUUID() });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Lifecycle proof needs PostgreSQL");
  pool = new Pool({ connectionString: container.connectionString });
  const selection = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
    migrationLogin: "postgres", runtimeLogin: "catalog_runtime", restoreLogin: "catalog_restore" } as const;
  const password = randomUUID();
  for (const login of [selection.runtimeLogin, selection.restoreLogin]) await pool.query(`CREATE ROLE ${login}
    LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  installer = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => installer }).apply();
  const runtimeUrl = new URL(container.connectionString);
  runtimeUrl.username = selection.runtimeLogin;
  runtimeUrl.password = password;
  runtime = new Pool({ connectionString: runtimeUrl.toString() });
  expect((await runtime.query(`SELECT current_user,pg_has_role(current_user,'service_role','USAGE') AS inherits`)).rows)
    .toEqual([{ current_user: selection.runtimeLogin, inherits: true }]);
  await pool.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('subscription_minimum_base_units','1') ON CONFLICT(key) DO UPDATE SET value_text='1'");
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
afterAll(() => closePostgres(container, [pool, installer, runtime].filter(Boolean)), postgresTeardownTimeoutMs);

async function committed(work: (db: PoolClient) => Promise<void>, error?: string, connection = pool) {
  const db = await connection.connect();
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

it("refuses open wire shapes, repeated SKU identities or codes and out-of-range rosters", async () => {
  const line = acceptance.lines[0]!;
  const oversized = Array.from({ length: 101 }, (_, i) => ({ ...line, skuId: randomUUID(), skuCode: `sku-${i}` }));
  const invalid = [
    { ...acceptance, extra: true },
    { ...acceptance, lines: [] },
    { ...acceptance, lines: oversized },
    { ...acceptance, lines: [line, { ...line, skuCode: "other-sku" }] },
    { ...acceptance, lines: [line, { ...line, skuId: randomUUID() }] },
  ];
  expect(catalogAcceptanceV2Schema.parse(acceptance)).toEqual(acceptance);
  expect(catalogAcceptanceV2Schema.safeParse({ ...acceptance, lines: oversized.slice(0, 100) }).success).toBe(true);
  for (const value of invalid) {
    expect(catalogAcceptanceV2Schema.safeParse(value).success).toBe(false);
    const error: unknown = await runtime.query("SELECT public.catalog_acceptance_assert_v2($1)", [json(value)]).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: "catalog_acceptance_invalid", hint: expect.stringContaining("1 to 100") });
    expect(nativeCatalogPublication.catalogPublicationAdmissionRefusal(error)).toMatchObject({
      reason: "catalog_acceptance_invalid", message: expect.stringContaining("1 to 100"),
    });
  }
  for (const value of [{ ...line, extra: true },
    { ...line, publicationHead: { ...line.publicationHead, extra: true } },
    { ...line, typeRef: { ...line.typeRef, extra: true } }]) {
    expect(catalogAcceptanceV2Schema.safeParse({ ...acceptance, lines: [value] }).success).toBe(false);
    await expect(runtime.query("SELECT public.catalog_acceptance_assert_v2($1)", [json({ ...acceptance, lines: [value] })]))
      .rejects.toMatchObject({ message: "catalog_accepted_reference_invalid", hint: expect.stringContaining("supported fields") });
  }
});

it.each(["service_role", "catalog_runtime"])("keeps acceptance mutation helpers private from %s", async role => {
  const db = await runtime.connect();
  try {
    if (role === "service_role") await db.query("SET ROLE service_role");
    await expect(db.query("SELECT public.catalog_clear_template_acceptance($1)", [randomUUID()]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(db.query("SELECT public.catalog_attach_edit_acceptance($1,$2)", [randomUUID(), json(acceptance)]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(db.query("SELECT public.catalog_accepted_reference_assert_v2($1)", [json(acceptance.lines[0])]))
      .rejects.toMatchObject({ code: "42501" });
  } finally {
    await db.query("RESET ROLE");
    db.release();
  }
});

async function receipt(db: PoolClient, order: string, sku: string, qty = 1, otherLines: { sku: string; quantity: number }[] = []) {
  await db.query(`INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
    VALUES($1,$2,$3,$4)`, [`receipt:${order}`, "f".repeat(32), order, json({
    orderDraft: { orderId: `order_${order}`, quoteSnapshot: { quote: { lines: [{ sku, quantity: qty }, ...otherLines] } } },
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
      await committed(async db => {
        await db.query(`UPDATE public.subscription_quote_previews
          SET status='previewed',accepted_event_id=NULL,accepted_at=NULL,accepted_idempotency_key=NULL WHERE id=$1`, [preview]);
      }, "catalog_acceptance_line_mismatch");
      await committed(async db => {
        await db.query("DELETE FROM public.subscription_quote_previews WHERE id=$1", [preview]);
      }, "catalog_acceptance_line_mismatch");
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

async function obligationOrder(db: PoolClient, client: string, status: string, skuId: string = data.skuId) {
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

it("reports missing SKU, contradictory pending order and owner-filtered census as unknown or unavailable", async () => {
  await rolledBack(async db => {
    const result = await db.query("SELECT public.catalog_bound_obligations_v2($1) AS census", [randomUUID()]);
    expect(result.rows[0]!.census).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
  });
  await rolledBack(async db => {
    const owner = await subscription(db);
    const cycle = (await db.query(`INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status)
      VALUES($1,now(),'payment_pending') RETURNING id`, [owner.id])).rows[0]!.id;
    const order = await obligationOrder(db, owner.client, "pending_payment");
    await db.query("UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1", [order, cycle]);
    await db.query("INSERT INTO public.subscription_activations(order_id,client_id,cadence_days,declare_idempotency_key) VALUES($1,$2,28,$3)",
      [order, owner.client, randomUUID()]);
    expect(await obligations(db)).toMatchObject({ outcome: "unknown", reason: "catalog_obligation_evidence_unknown" });
  });
  await rolledBack(async db => {
    const role = "catalogue_filtered_owner";
    await db.query(`CREATE ROLE ${role} NOLOGIN`);
    // Isolate the row_security_active conjunct from the relation-owner check.
    const commands = await db.query<{ sql: string }>(`SELECT format('ALTER TABLE public.%I OWNER TO %I',relname,$1::text) AS sql
      FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')`, [role]);
    for (const { sql } of commands.rows) await db.query(sql);
    await db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await db.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
    await db.query(`SET LOCAL ROLE ${role}`);
    expect(await obligations(db)).toMatchObject({ outcome: "complete" });
    await db.query("ALTER TABLE public.subscription_lines ENABLE ROW LEVEL SECURITY");
    await db.query("ALTER TABLE public.subscription_lines FORCE ROW LEVEL SECURITY");
    expect((await db.query("SELECT row_security_active('public.subscription_lines'::regclass) AS active")).rows).toEqual([{ active: true }]);
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

const codec = createNativeRenewalCodec();
async function acceptedPurchase(options: { scheduledAt?: string; graduation?: boolean; issued?: CatalogAcceptanceV2 } = {}) {
  const issued = options.issued ?? acceptance;
  const reference = issued.lines[0]!;
  const at = new Date(Date.now() - 1000).toISOString();
  const scheduledAt = options.scheduledAt ?? at;
  const scheduleAt = scheduledAt.replace("Z", "000Z");
  const lines = issued.lines.map((ref, index) => ({ lineOrdinal: index + 1, sku: ref.skuCode, quantity: 1, unitAmountMinor: 100 }));
  const originalTerms = { templateId: "fixture", shippingAmountMinor: 0, acquisitionRef: null };
  const starterPack = { schemaVersion: "1", basisTemplateVersion: 1, starterIntervalDays: 28,
    delivery2: { discountBps: 0, discountMinor: 0, basisSubtotalMinor: lines.length * 100 },
    graduation: { cadenceDays: 30, lines: [{ sku: reference.skuCode, qty: 3, sortOrder: 0, isAddon: false,
      quoteLine: { unitPriceGross: { amountMinor: 100 }, lineSubtotalGross: { amountMinor: 300 } } }] } };
  const retained = options.graduation ? { renewalTerms: { version: "native.renewal-terms.v1",
    shippingTerms: { version: "shipping-threshold.v1", currency: "XXX", flatMinor: 0, freeThresholdMinor: 0 },
    minimumPayableMinor: 1, normalCadenceDays: [30], starterPack,
    linePricing: lines.map((line, index) => ({ sku: line.sku, quantity: line.quantity,
      unitAmountMinor: line.unitAmountMinor, isAddon: index > 0, quoteLine: {} })) } } : {};
  const purchase = { ...originalTerms, ...retained, currency: "XXX", stockSourceKey: "fixture", settlementChannelKey: "sandbox", lines,
    unattendedChargeAuthorizedAt: at, authorizationRef: "fixture", payerAccountRef: null, methodRef: "fixture", methodEvidenceRef: "fixture" };
  const owner = await transaction(pool, async db => {
    const owner = await subscription(db, "cancelled");
    const list = randomUUID();
    await db.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Edit proof','ZZ','XXX','2026-01-01')", [list]);
    await db.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',100,'2026-01-01')",
      [list, reference.skuId]);
    await db.query("UPDATE public.subscriptions SET status='active',next_cycle_at=$2,currency_code='XXX',price_list_id=$3 WHERE id=$1",
      [owner.id, scheduledAt, list]);
    const order = await obligationOrder(db, owner.client, "paid", reference.skuId);
    for (const [index, ref] of issued.lines.entries()) {
      await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
        VALUES($1,$2,1,$3,$4,100,'XXX')`, [owner.id, ref.skuId, index, index > 0]);
      if (index > 0) await db.query(`INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
        VALUES($1,$2,$3,1,100,100)`, [order, ref.skuId, index + 1]);
    }
    if (lines.length > 1) await db.query("UPDATE public.commerce_orders SET total_amount_minor=$2 WHERE id=$1", [order, lines.length * 100]);
    await receipt(db, order, reference.skuCode, 1, lines.slice(1));
    await call(db, "catalog_attach_order_acceptance", [order, issued, `receipt:${order}`, Object.fromEntries(lines.map(line => [line.sku, line.quantity]))]);
    const activationCycleId = randomUUID();
    await db.query(`INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status)
      VALUES($1,$2,$3::timestamptz-interval '28 days','paid')`, [activationCycleId, owner.id, scheduledAt]);
    await db.query("UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1", [order, activationCycleId]);
    if (options.graduation) await db.query(`INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status)
      VALUES($1,$2::timestamptz-interval '14 days','paid')`, [owner.id, scheduledAt]);
    await db.query(`INSERT INTO public.subscription_activations(order_id,client_id,subscription_id,state,cadence_days,activated_at,
      payment_fingerprint,activation_idempotency_key,declare_idempotency_key) VALUES($1,$2,$3,'active',28,$4,$5,$6,$7)`,
    [order, owner.client, owner.id, at, "1".repeat(64), `activate:${order}`, `declare:${order}`]);
    await db.query("INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts) VALUES($1,$2,$3)",
      [order, owner.id, json(purchase)]);
    const attach = () => db.query("SELECT public.subscription_complete_renewal_attachment($1) AS result", [order]);
    expect((await attach()).rows).toEqual([{ result: { subscriptionId: owner.id, replayed: false } }]);
    expect((await attach()).rows).toEqual([{ result: { subscriptionId: owner.id, replayed: true } }]);
    if (options.graduation) await db.query("UPDATE public.subscription_renewal_terms SET next_cycle_number=2 WHERE subscription_id=$1", [owner.id]);
    expect((await db.query("SELECT catalog_sku_revision_id FROM public.subscription_lines WHERE subscription_id=$1 ORDER BY sort_order", [owner.id])).rows)
      .toEqual(issued.lines.map(ref => ({ catalog_sku_revision_id: ref.skuRevisionId })));
    expect((await db.query("SELECT public.subscription_renewal_purchase_terms($1) AS result", [owner.id])).rows)
      .toEqual([{ result: { ...originalTerms, ...retained } }]);
    return { ...owner, order, activationCycleId };
  });
  return { ...owner, schedule: { subscriptionId: owner.id, scheduledAt: scheduleAt, scheduledInstant: Date.parse(scheduledAt) },
    lines, originalTerms, at, scheduleAt };
}

it("replays the stored acceptance after reopening without changing frozen v1 bytes", async () => {
  const owner = await acceptedPurchase();
  const { schedule, lines, originalTerms, scheduleAt } = owner;
  const snapshot = codec.freeze({ subscription_id: owner.id, client_id: owner.client, cadence_days: 28, template_version: 1,
    currency_code: "XXX", stock_source_key: "fixture", settlement_channel_key: "sandbox", authorization_ref: "fixture",
    unattended_charge_authorized_at: scheduleAt, scheduled_at: scheduleAt, next_cycle_number: 1, activation_cycle_id: owner.activationCycleId,
    activation_cycle_paid: true, paid_cycle_count: 1, purchase_facts: originalTerms, lines },
  schedule);
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

it.each(["customer", "other customer", "service"] as const)("checks deferred edit evidence under the %s login", async login => {
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
  async function assumeEditor(db: PoolClient, ownsEvent: boolean) {
    if (login === "service") {
      await db.query("SET LOCAL ROLE service_role");
    } else {
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [json({ sub: ownsEvent ? identity.principal : randomUUID(), role: "authenticated" })]);
    }
  }
  await committed(async db => {
    // Queue owner-side revalidation of intact evidence before the restricted caller commits.
    await db.query("UPDATE public.subscription_edit_quotes SET accepted_at=accepted_at WHERE accepted_event_id=$1", [id]);
    if (login === "service") {
      await db.query("UPDATE public.subscription_events SET catalog_acceptance=catalog_acceptance WHERE id=$1", [id]);
    }
    await assumeEditor(db, login === "customer");
    const grants = await db.query(`SELECT has_table_privilege(current_user,'public.subscription_events','SELECT') AS reads_events,
      has_function_privilege(current_user,'public.catalog_customer_edit_acceptance_assert(uuid)','EXECUTE') AS runs_assertion`);
    expect(grants.rows[0]!.runs_assertion).toBe(false);
    if (login !== "service") expect(grants.rows[0]!.reads_events).toBe(false);
  }, login === "other customer" ? "subscription_edit_forbidden" : undefined);
  if (login === "service") await committed(async db => {
    await assumeEditor(db, true);
    await db.query("SAVEPOINT direct_invocation");
    await expect(db.query("SELECT public.subscription_package_edit_apply(NULL,NULL,NULL,$1,NULL,NULL)", [id]))
      .rejects.toMatchObject(refusal("subscription_command_invalid_input"));
    await db.query("ROLLBACK TO SAVEPOINT direct_invocation");
  });
  await committed(async db => {
    await db.query("UPDATE public.subscription_edit_quotes SET proposed_lines=jsonb_set(proposed_lines,'{0,quantity}','2') WHERE accepted_event_id=$1", [id]);
    await assumeEditor(db, login !== "other customer");
  }, login === "other customer" ? "subscription_edit_forbidden" : "catalog_acceptance_line_mismatch");
  if (login === "customer") {
    await committed(async db => {
      await db.query("UPDATE public.subscription_edit_quotes SET status='previewed',accepted_event_id=NULL,accepted_at=NULL WHERE accepted_event_id=$1", [id]);
      await assumeEditor(db, true);
    }, "catalog_acceptance_line_mismatch");
    await committed(async db => {
      await db.query("DELETE FROM public.subscription_edit_quotes WHERE accepted_event_id=$1", [id]);
      await assumeEditor(db, true);
    }, "catalog_acceptance_line_mismatch");
  }
});

const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
async function call(db: Pool | PoolClient, name: string, values: unknown[]) {
  const args = values.map((_, index) => `$${index + 1}`).join(",");
  return (await db.query(`SELECT public.${name}(${args}) AS result`, values)).rows[0]!.result;
}

it.each(["first attempt", "pending retry"])("completes a previously accepted native purchase on %s and claims its bound renewal", async attempt => {
  const issued = await issueActiveAcceptance(), reference = issued.lines[0]!;
  const at = new Date(Date.now() - 29 * 86_400_000).toISOString(), key = randomUUID();
  const { client } = await transaction(pool, db => subscription(db));
  const list = randomUUID();
  await pool.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Purchase proof','ZZ','XXX',$2)", [list, at]);
  await pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',100,$3)",
    [list, reference.skuId, at]);
  const quote = { context: { mode: "subscription", cadenceDays: 28 }, lines: [
    { sku: reference.skuCode, quantity: 2, unitPriceGross: money(100), lineSubtotalGross: money(200) }], totalGross: money(200) };
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
    currency: "XXX", context: quote.context, lines: quote.lines, totals: { totalGross: money(200) } };
  await expect(call(runtime, "commerce_create_order_draft_with_outbox", [key, { quote }, draft, client]))
    .rejects.toMatchObject(refusal("catalog_admission_quote_authority_required"));
  const orderId = randomUUID(), quoteSnapshot = { quote };
  const saved = { contractVersion: "commerce.v0", orderDraft: {
    orderId: `order_${orderId}`, status: "draft", paymentStatus: "not_started", idempotencyKey: key, quoteSnapshot, replayed: false,
  } };
  await transaction(pool, async db => {
    await db.query(`INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,metadata)
      VALUES($1,$2,'pending_payment','XXX',200,$3)`,
    [orderId, client, { paymentStatus: "not_started", quoteSnapshot, orderDraftSnapshot: draft }]);
    await db.query(`INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      VALUES($1,$2,1,2,100,200)`, [orderId, reference.skuId]);
    await db.query(`INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
      VALUES($1,md5($2::jsonb::text||'|'||$3::jsonb::text||'|'||$4::uuid::text),$5,$6)`,
    [key, quoteSnapshot, draft, client, orderId, saved]);
  });
  await call(runtime, "catalog_attach_order_acceptance", [orderId, issued, key, { [reference.skuCode]: 2 }]);
  await expect(call(runtime, "commerce_create_order_draft_with_outbox", [key, quoteSnapshot, draft, client]))
    .resolves.toEqual({ ...saved, orderDraft: { ...saved.orderDraft, replayed: true } });
  const opened = await call(runtime, "commerce_open_settlement_intent", [`open:${key}`, orderId, "sandbox", 200, "XXX", {}, at]);
  const simulator = createPostgresSandboxPaymentSimulator(runtime, { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover",
    recoveryTemplateSlug: "recovered" });
  await captureSandboxPurchase(simulator, { settlementIntentId: opened.settlement.id, key, at });
  await call(runtime, "subscription_declare_provisional_activation", [`declare:${key}`, orderId, 28, at]);
  const settled = (await runtime.query("SELECT external_ref,id FROM public.commerce_settlement_intents WHERE id=$1", [opened.settlement.id])).rows[0]!;
  const facts: NativeRenewalPurchaseFacts = { templateId: "fixture", shippingAmountMinor: 0, acquisitionRef: null, cadenceDays: 28,
    currency: "XXX", stockSourceKey: "fixture", settlementChannelKey: "sandbox", unattendedChargeAuthorizedAt: at,
    authorizationRef: "fixture", payerAccountRef: null, methodRef: "fixture", methodEvidenceRef: "fixture",
    lines: [{ lineOrdinal: 1, sku: reference.skuCode, quantity: 2, unitAmountMinor: 100 }] };
  const retry = attempt === "pending retry";
  let linesBeforeCompletion: number | undefined;
  const executor: SubscriptionQueryExecutor = { async query(sql, values) {
    if (sql.startsWith("SELECT public.subscription_complete_renewal_attachment(")) {
      const lines = await runtime.query(`SELECT l.id FROM public.subscription_activations a
        JOIN public.subscription_lines l ON l.subscription_id=a.subscription_id WHERE a.order_id=$1`, [orderId]);
      linesBeforeCompletion = lines.rows.length;
      if (retry) throw new Error("synthetic unavailable completion");
    }
    return runtime.query(sql, values);
  } };
  const activated = await activateNativePurchaseWithRenewal(executor,
    { orderId, idempotencyKey: `activate:${key}`, capturedReference: settled.external_ref ?? settled.id, facts });
  expect(linesBeforeCompletion).toBe(0);
  expect(activated.renewalAttachment).toBe(retry ? "pending" : "complete");
  const id = String(activated.activation.subscriptionId), writer = createPostgresPurchaseRenewalWriter(runtime);
  if (retry) {
    expect(await writer.pending()).toEqual(expect.arrayContaining([expect.objectContaining({ orderId, subscriptionId: id })]));
    expect(await retainedAcceptance(id)).toEqual([]);
    expect(await writer.complete(orderId)).toEqual({ subscriptionId: id, replayed: false });
  }
  expect(await writer.complete(orderId)).toEqual({ subscriptionId: id, replayed: true });
  expect(await retainedAcceptance(id)).toEqual([{ catalog_acceptance: issued, catalog_sku_revision_id: reference.skuRevisionId }]);
  expect((await runtime.query("SELECT price_list_id,currency_code FROM public.subscriptions WHERE id=$1", [id])).rows)
    .toEqual([{ price_list_id: list, currency_code: "XXX" }]);
  const store = createPostgresRenewalStore(runtime, codec), now = new Date().toISOString();
  const due = (await store.listDue(100, now)).find(candidate => candidate.subscriptionId === id);
  expect(due).toBeDefined();
  const snapshot = await store.buildCycleSnapshots(due!);
  expect(await store.claimDue({ snapshot, workerId: "native-purchase", now })).toMatchObject({ acquired: true, catalogAcceptance: issued });
});

it("attaches acceptance to a persisted draft order through the service grant", async () => {
  const order = randomUUID();
  await transaction(runtime, async db => {
    await db.query("INSERT INTO public.commerce_orders(id,status,currency_code,total_amount_minor) VALUES($1,'cancelled','XXX',0)", [order]);
    await receipt(db, order, first.facts.code);
    await call(db, "catalog_attach_order_acceptance", [order, acceptance, `receipt:${order}`, { [first.facts.code]: 1 }]);
  });
  expect((await pool.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [order])).rows)
    .toEqual([{ catalog_acceptance: acceptance }]);
});

it.each(["service_role", "catalog_runtime"])("claims, prepares and updates accepted commerce under %s", async role => {
  const owner = await acceptedPurchase();
  const db = await runtime.connect();
  try {
    if (role === "service_role") await db.query("SET ROLE service_role");
    expect((await db.query("SELECT current_user")).rows).toEqual([{ current_user: role }]);
    await db.query("BEGIN");
    const store = createPostgresRenewalStore(db, codec);
    const snapshot = await store.buildCycleSnapshots(owner.schedule);
    const wire = codec.encode(snapshot);
    await db.query("SAVEPOINT invalid_renewal_roster");
    await expect(call(db, "subscription_claim_due_renewal", [codec.identity(snapshot), codec.fingerprint(snapshot),
      { ...wire, lines: [{ ...snapshot.orderSnapshot.lines[0], quantity: 2 }] }, role, 300, new Date().toISOString()]))
      .rejects.toMatchObject(refusal("catalog_acceptance_line_mismatch"));
    await db.query("ROLLBACK TO SAVEPOINT invalid_renewal_roster");
    const claim = await store.claimDue({ snapshot, workerId: role, now: new Date().toISOString() });
    expect(claim).toMatchObject({ acquired: true, catalogAcceptance: acceptance });
    expect((await db.query(`SELECT catalog_acceptance,catalog_acceptance_fingerprint FROM public.subscription_renewal_operations
      WHERE id=$1`, [claim.operationId])).rows).toEqual([{
      catalog_acceptance: acceptance, catalog_acceptance_fingerprint: snapshot.frozenFingerprint,
    }]);
    await db.query("COMMIT");

    await db.query("BEGIN");
    await db.query("INSERT INTO public.fulfillment_inventory_reservations(renewal_operation_id,operation_fingerprint,source_key,expires_at) VALUES($1,$2,'fixture',now()+interval '10 minutes')",
      [claim.operationId, snapshot.frozenFingerprint]);
    await db.query("UPDATE public.subscription_renewal_operations SET state='reserved' WHERE id=$1", [claim.operationId]);
    const prepared = await call(db, "commerce_prepare_subscription_renewal", [claim.operationId, claim.claimToken, new Date().toISOString()]);
    await db.query("COMMIT");
    expect((await db.query("SELECT catalog_acceptance FROM public.commerce_orders WHERE id=$1", [prepared.orderId])).rows)
      .toEqual([{ catalog_acceptance: acceptance }]);

    await db.query("BEGIN");
    expect((await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [owner.order])).rowCount).toBe(1);
    expect((await db.query("UPDATE public.commerce_order_draft_receipts SET response_payload=response_payload||'{\"reconciled\":true}' WHERE order_id=$1", [owner.order])).rowCount).toBe(1);
    await db.query("COMMIT");

    await db.query("BEGIN");
    await db.query(`UPDATE public.commerce_order_draft_receipts SET response_payload=jsonb_set(
      response_payload,'{orderDraft,quoteSnapshot,quote,lines,0,quantity}','2') WHERE order_id=$1`, [owner.order]);
    await expect(db.query("COMMIT")).rejects.toMatchObject(refusal("catalog_acceptance_line_mismatch"));
  } finally {
    await db.query("ROLLBACK");
    await db.query("RESET ROLE");
    db.release();
  }
});

it("transitions an accepted order through the authenticated pause owner", async () => {
  const owner = await transaction(pool, async db => {
    const owner = await subscription(db, "active");
    const order = await obligationOrder(db, owner.client, "pending_payment");
    await receipt(db, order, first.facts.code);
    await bindOrder(db, order);
    const cycle = (await db.query(`INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status)
      VALUES($1,now(),'payment_pending') RETURNING id`, [owner.id])).rows[0]!.id;
    await db.query("UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1", [order, cycle]);
    return { ...owner, order };
  });
  await transaction(runtime, async db => {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [json({ sub: owner.principal, role: "authenticated" })]);
    const result = await call(db, "customer_subscription_pause_as_actor", [owner.id, randomUUID(), "indefinite", null]);
    expect(result.subscriptionAction).toMatchObject({ status: "applied", subscriptionStatus: "paused" });
  });
  expect((await pool.query("SELECT status,catalog_acceptance FROM public.commerce_orders WHERE id=$1", [owner.order])).rows)
    .toEqual([{ status: "cancelled", catalog_acceptance: acceptance }]);
});

it("preserves authenticated writes to unaccepted orders outside the acting client", async () => {
  const owner = await transaction(pool, async db => {
    const owner = await subscription(db);
    const order = await obligationOrder(db, owner.client, "pending_payment");
    await receipt(db, order, first.facts.code);
    const accepted = await obligationOrder(db, owner.client, "pending_payment");
    await receipt(db, accepted, first.facts.code);
    await bindOrder(db, accepted);
    return { ...owner, order, accepted };
  });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Model a writer with the base tables' permissions, including reads by the line-sum trigger.
    await db.query("GRANT SELECT, UPDATE ON public.commerce_orders,public.commerce_order_items,public.commerce_order_draft_receipts TO authenticated");
    await db.query("GRANT SELECT ON public.commerce_order_adjustments,public.commerce_promotion_claims TO authenticated");
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [json({ sub: randomUUID(), role: "authenticated" })]);
    expect((await db.query("UPDATE public.commerce_orders SET updated_at=now() WHERE id=$1", [owner.order])).rowCount).toBe(1);
    expect((await db.query("UPDATE public.commerce_order_items SET quantity=quantity WHERE order_id=$1", [owner.order])).rowCount).toBe(1);
    expect((await db.query("UPDATE public.commerce_order_draft_receipts SET response_payload=response_payload WHERE order_id=$1", [owner.order])).rowCount).toBe(1);
    // Run every queued commit check with the actual write role, then discard fixture grants.
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await expect(db.query("UPDATE public.commerce_orders SET updated_at=now() WHERE id=$1", [owner.accepted]))
      .rejects.toMatchObject(refusal("subscription_lifecycle_forbidden"));
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

async function previewedEdit(db: Pool | PoolClient, owner: Awaited<ReturnType<typeof acceptedPurchase>>,
  kind: "package" | "exact" | "sized", now: string, supplied?: CatalogAcceptanceV2, reference = (supplied ?? acceptance).lines[0]!) {
  const key = randomUUID(), quoteHash = "d".repeat(64);
  const action = kind === "package" ? "update_package_template" : kind === "exact" ? "update_plan_length" : "resize_bundle";
  const item = { variantId: reference.skuId, qty: 2 };
  const line = { ...item, isAddon: false, quoteLine: { sku: reference.skuCode, quantity: item.qty,
    unitPriceGross: money(100), lineSubtotalGross: money(200) } };
  const constraint = { kind: "plan_days", value: 30 };
  let request: Record<string, unknown> = { action, acceptedQuoteHash: quoteHash, expectedTemplateVersion: 1, planDays: 30 };
  let snapshot: Record<string, unknown> = { lines: [line], cadenceDays: 30, compositionConstraint: constraint };
  let totals = {};
  if (kind === "package") {
    request = { ...request, base: [item], addons: [] };
    snapshot = { baseLines: [line], addonLines: [], compositionConstraint: constraint };
    totals = { currentRecurringPrice: money(100), newRecurringPrice: money(200), delta: money(100) };
  } else if (kind === "sized") {
    request = { ...request, resizeLever: { kind: "subscription.sized.parcel", value: { optInToSized: true } } };
    snapshot = { ...snapshot, optInFacts: { admitted: true }, subjectFacts: {} };
  }
  await call(db, "subscription_quote_preview_record", [owner.principal, owner.client, owner.id, action, quoteHash, 1,
    new Date(Date.parse(now) + 900_000), request, snapshot, totals, now]);
  const args = [owner.principal, owner.client, key, owner.id];
  const payload = { ...snapshot, ...request, ...totals, request, catalogAcceptance: supplied };
  if (kind === "package") return call(db, "subscription_package_edit_apply", [...args, payload, now]);
  if (kind === "exact") return call(db, "subscription_line_edit_apply", [...args, action, payload, now]);
  return call(db, "subscription_sized_edit_apply", [...args, payload, now]);
}

async function retainedAcceptance(owner: string) {
  return (await pool.query(`SELECT t.catalog_acceptance,l.catalog_sku_revision_id FROM public.subscription_renewal_terms t
    JOIN public.subscription_lines l USING (subscription_id) WHERE t.subscription_id=$1 ORDER BY l.sort_order`, [owner])).rows;
}

const editableSchedule = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
const beforeEdit = () => new Date(Date.now() - 1000).toISOString();

it.each(["classic", "exact", "package", "sized", "bundle"] as const)("clears retained acceptance on an unaccepted %s rewrite before the next claim", async kind => {
  const owner = await activeEditPurchase();
  const reference = owner.issued.lines[0]!;
  expect(await retainedAcceptance(owner.id)).toEqual([{ catalog_acceptance: owner.issued, catalog_sku_revision_id: reference.skuRevisionId }]);
  const result = kind === "classic" ? await classicEdit(owner) : kind === "bundle" ? (await bundleEdit(owner, 2)).subscriptionAction
    : await previewedEdit(runtime, owner, kind, beforeEdit(), undefined, reference);
  expect(result).toMatchObject({ status: "applied", templateVersion: 2 });
  expect(await retainedAcceptance(owner.id)).toEqual([{ catalog_acceptance: null, catalog_sku_revision_id: null }]);
  expect((await runtime.query("SELECT quantity FROM public.subscription_lines WHERE subscription_id=$1", [owner.id])).rows).toEqual([{ quantity: 2 }]);
  const store = createPostgresRenewalStore(runtime, codec);
  const snapshot = await store.buildCycleSnapshots(owner.schedule);
  expect(snapshot.templateSnapshot.version).toBe(2);
  const claim = await store.claimDue({ snapshot, workerId: kind, now: owner.schedule.scheduledAt });
  expect(claim).toMatchObject({ acquired: true });
  expect(claim).not.toHaveProperty("catalogAcceptance");
});

it("clears retained acceptance during full graduation before the next claim", async () => {
  const addon = (await issueActiveAcceptance()).lines[0]!;
  const issued = { ...acceptance, lines: [...acceptance.lines, addon] };
  const owner = await acceptedPurchase({ graduation: true, issued });
  const addonLine = (await runtime.query("SELECT id FROM public.subscription_lines WHERE subscription_id=$1 AND is_addon", [owner.id])).rows[0]!;
  await createPostgresDestinationPort(runtime).registerOrder({ idempotencyKey: `destination:${owner.order}`,
    orderId: owner.order, now: owner.at,
    address: { recipientName: "Synthetic recipient", line1: "Synthetic street 1", city: "Fixture", postalCode: "00000", country: "ZZ" } });
  expect(await retainedAcceptance(owner.id)).toEqual(issued.lines.map(ref => ({
    catalog_acceptance: issued, catalog_sku_revision_id: ref.skuRevisionId })));
  const store = createPostgresRenewalStore(runtime, codec, work => transaction(runtime, work));
  const snapshot = await store.buildCycleSnapshots(owner.schedule);
  expect(snapshot.templateSnapshot).toMatchObject({ version: 2, cadenceDays: 30, lines: [{ quantity: 3 }, { quantity: 1 }] });
  expect(await retainedAcceptance(owner.id)).toEqual(issued.lines.map(() => ({
    catalog_acceptance: null, catalog_sku_revision_id: null })));
  expect((await runtime.query("SELECT id FROM public.subscription_lines WHERE subscription_id=$1 AND is_addon", [owner.id])).rows)
    .toEqual([addonLine]);
  const claim = await store.claimDue({ snapshot, workerId: "graduation", now: new Date().toISOString() });
  expect(claim).toMatchObject({ acquired: true });
  expect(claim).not.toHaveProperty("catalogAcceptance");
});

it.each(["package", "exact"] as const)("binds the accepted revision in the %s owner", async kind => {
  const owner = await acceptedPurchase({ scheduledAt: editableSchedule() });
  const result = await previewedEdit(runtime, owner, kind, beforeEdit(), acceptance);
  expect(result).toMatchObject({ status: "applied" });
  expect((await pool.query("SELECT catalog_acceptance FROM public.subscription_events WHERE id=$1", [result.eventId])).rows)
    .toEqual([{ catalog_acceptance: acceptance }]);
  expect(await retainedAcceptance(owner.id)).toEqual([{ catalog_acceptance: acceptance, catalog_sku_revision_id: first.skuRevisionId }]);
});

async function issueActiveAcceptance() {
  const ids = fixture();
  return transaction(pool, async db => {
    const current = await graph(db, ids, null, true, { lifecycle: "active", subscriptionEligible: true });
    await insertGraph(db, current);
    const facts = current.facts as Graph["facts"] & { optionDigest: string };
    const product = current.product as Graph["product"] & { definitionDigest: string };
    return { schemaVersion: 2, lines: [{ schemaVersion: 2, skuId: ids.skuId, skuCode: facts.code,
      skuRevisionId: current.skuRevisionId, publicationHead: current.head, typeRef: product.type,
      definitionDigest: product.definitionDigest, optionDigest: facts.optionDigest, netContent: facts.netContent }] } satisfies CatalogAcceptanceV2;
  });
}

async function activeEditPurchase() {
  const issued = await issueActiveAcceptance();
  const owner = await acceptedPurchase({ scheduledAt: editableSchedule(), issued });
  return { ...owner, issued, skuId: issued.lines[0]!.skuId };
}

it("binds the accepted revision in the sized owner", async () => {
  const owner = await activeEditPurchase();
  const result = await previewedEdit(runtime, owner, "sized", beforeEdit(), owner.issued);
  expect(result).toMatchObject({ status: "applied" });
  expect((await pool.query("SELECT catalog_acceptance FROM public.subscription_events WHERE id=$1", [result.eventId])).rows)
    .toEqual([{ catalog_acceptance: owner.issued }]);
  expect(await retainedAcceptance(owner.id)).toEqual([{ catalog_acceptance: owner.issued,
    catalog_sku_revision_id: owner.issued.lines[0].skuRevisionId }]);
});

async function classicEdit(owner: Awaited<ReturnType<typeof activeEditPurchase>>, acceptance?: CatalogAcceptanceV2) {
  const now = beforeEdit();
  const request = { expectedTemplateVersion: 1, cadenceDays: 30, coreLines: [{ variantId: owner.skuId, qty: 2 }],
    compositionConstraint: {}, catalogAcceptance: acceptance };
  const args = [owner.principal, owner.client, randomUUID(), owner.id, "update_bundle"];
  const preview = await call(runtime, "subscription_command_preview", [...args, request, now]);
  expect(preview, JSON.stringify(preview)).toMatchObject({ status: "previewed" });
  return call(runtime, "subscription_command_apply", [...args, { ...request, acceptedQuoteHash: preview.quoteHash }, now, null]);
}

it("binds the accepted revision in the classic command owner", async () => {
  const owner = await activeEditPurchase();
  const result = await classicEdit(owner, owner.issued);
  expect(result).toMatchObject({ status: "applied" });
  expect((await pool.query("SELECT catalog_acceptance FROM public.subscription_events WHERE id=$1", [result.eventId])).rows)
    .toEqual([{ catalog_acceptance: owner.issued }]);
  expect(await retainedAcceptance(owner.id)).toEqual([{ catalog_acceptance: owner.issued,
    catalog_sku_revision_id: owner.issued.lines[0].skuRevisionId }]);
});

async function bundleEdit(owner: Awaited<ReturnType<typeof activeEditPurchase>>, qty: number, acceptance?: CatalogAcceptanceV2) {
  const args = [owner.id, randomUUID(), [{ variantId: owner.skuId, qty }], [], {}, 30, 1];
  async function customer(kind: "preview" | "apply", values: unknown[]) {
    return transaction(runtime, async db => {
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [json({ sub: owner.principal, role: "authenticated" })]);
      return call(db, `customer_subscription_${kind}_bundle_as_actor`, values.map(value => Array.isArray(value) ? json(value) : value));
    });
  }
  const preview = await customer("preview", args);
  expect(preview.preview).toMatchObject({ canApply: true, quoteHash: expect.any(String) });
  if (acceptance) {
    const quote = (await pool.query("SELECT id FROM public.subscription_edit_quotes WHERE subscription_id=$1 AND quote_hash=$2",
      [owner.id, preview.preview.quoteHash])).rows[0]!.id;
    await call(runtime, "catalog_attach_edit_quote_acceptance", [quote, acceptance]);
    expect((await pool.query("SELECT catalog_acceptance FROM public.subscription_edit_quotes WHERE id=$1", [quote])).rows)
      .toEqual([{ catalog_acceptance: acceptance }]);
  }
  return customer("apply", [owner.id, args[1], preview.preview.quoteHash, ...args.slice(2)]);
}

it("attaches acceptance to a customer quote through the service owner and binds it in authenticated apply", async () => {
  const owner = await activeEditPurchase();
  const result = await bundleEdit(owner, 1, owner.issued);
  expect(result.subscriptionAction).toMatchObject({ status: "applied" });
  expect((await pool.query("SELECT catalog_acceptance FROM public.subscription_events WHERE id=$1", [result.subscriptionAction.eventId])).rows)
    .toEqual([{ catalog_acceptance: owner.issued }]);
  expect(await retainedAcceptance(owner.id)).toEqual([{ catalog_acceptance: owner.issued,
    catalog_sku_revision_id: owner.issued.lines[0].skuRevisionId }]);
});

function plantExcludedCatalogueFields(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(plantExcludedCatalogueFields);
  } else if (node && typeof node === "object") {
    Object.values(node).forEach(plantExcludedCatalogueFields);
    Object.assign(node, { excluded: { payload: [{ Total: "opaque", subtotal: 18 }] },
      "tax-net": "18", PayableValue: 19, flatMinor: 301, freeThresholdMinor: 302 });
  }
}

it("projects bound catalogue acceptance with all admission branches and rejects a damaged roster", async () => {
  const reference = acceptance.lines[0]!, { publicationHead, typeRef, netContent } = reference;
  const digest = "a".repeat(64), priceEvidenceRef = `price.v1:${digest}`, policyEvidenceRef = `policy.v1:${digest}`;
  const binding = { sourceOrdinal: 1, lineKey: "original-line", skuId: reference.skuId, skuCode: reference.skuCode,
    mode: "subscription", quantity: 1, role: "core", source: "retained", skuRevisionId: reference.skuRevisionId } as const;
  const { skuRevisionId: _legacyRevision, ...legacyBinding } = binding;
  const admission = { quoteRef: '{"totalMinor":253}', quoteDigest: digest, moneyVersion: "v0",
    priceEvidenceRef, policyEvidenceRef, acceptanceTokenDigest: digest,
    consultedHeads: [{ productId: data.productId, ...publicationHead }], offer: { ref: "offer:fixture", version: "v1" },
    lineBindings: [binding], legacyReviewEvidence: { identityComparison: "equal", priceEvidenceRef, policyEvidenceRef,
      priorPriceEvidenceRef: priceEvidenceRef, priorPolicyEvidenceRef: policyEvidenceRef },
    destinationRef: "destination:fixture", destinationDigest: digest, graduation: { phaseDigest: digest, lineBindings: [
      { ...legacyBinding, source: "legacy" },
    ] } } satisfies NonNullable<CatalogAcceptanceV2["admission"]>;
  const issued = { ...acceptance, admission };
  const owner = await acceptedPurchase({ issued });
  const store = createPostgresRenewalStore(runtime, codec);
  const claim = await store.claimDue({ snapshot: await store.buildCycleSnapshots(owner.schedule), workerId: "catalog-reader", now: new Date().toISOString() });
  expect(claim).toMatchObject({ acquired: true, catalogAcceptance: issued });
  const pair = [claim.operationId, claim.operationId], sql = "SELECT public.subscription_read_frozen_renewal_generation($1::uuid,$2::uuid) AS projection";
  const positive = (await runtime.query(sql, pair)).rows[0].projection;
  const expectedBinding = { lineKey: binding.lineKey, skuId: binding.skuId, skuCode: binding.skuCode,
    mode: binding.mode, role: binding.role, source: binding.source, skuRevisionId: binding.skuRevisionId };
  const { skuRevisionId: _revision, ...legacyExpected } = expectedBinding;
  expect(positive.catalogAcceptance).toEqual({
    lines: [{ skuId: reference.skuId, skuCode: reference.skuCode, skuRevisionId: reference.skuRevisionId,
      publicationHead: { publicationId: publicationHead.publicationId, documentDigest: publicationHead.documentDigest },
      typeRef: { key: typeRef.key }, netContent: { dimension: netContent.dimension, unscaled: netContent.unscaled, unit: netContent.unit },
      definitionDigest: reference.definitionDigest, optionDigest: reference.optionDigest,
      ...(reference.demandPolicyRef === undefined ? {} : { demandPolicyRef: reference.demandPolicyRef }) }],
    admission: { ...admission, consultedHeads: [{ productId: data.productId, publicationId: publicationHead.publicationId, documentDigest: publicationHead.documentDigest }],
      lineBindings: [expectedBinding], graduation: { phaseDigest: digest, lineBindings: [{ ...legacyExpected, source: "legacy" }] } },
  });

  await rolledBack(async db => {
    await db.query("ALTER TABLE public.subscription_renewal_operations DISABLE TRIGGER subscription_renewal_operations_catalog_acceptance_admit");
    const change = async (statement: string, value: string) => {
      await db.query("RESET ROLE");
      expect((await db.query(statement, [claim.operationId, value])).rowCount).toBe(1);
      await db.query("SET LOCAL ROLE catalog_runtime");
      return (await db.query(sql, pair)).rows[0].projection;
    };
    const fingerprint = "b".repeat(64);
    expect(claim.operationFingerprint).not.toBe(fingerprint);
    expect(await change("UPDATE public.subscription_renewal_operations SET catalog_acceptance_fingerprint=$2 WHERE id=$1", fingerprint))
      .toEqual({ ...positive, catalogAcceptance: null });
    await db.query("RESET ROLE");
    await db.query("UPDATE public.subscription_renewal_operations SET catalog_acceptance_fingerprint=operation_fingerprint WHERE id=$1", [claim.operationId]);
    const planted = structuredClone(issued);
    plantExcludedCatalogueFields(planted);
    const replace = "UPDATE public.subscription_renewal_operations SET catalog_acceptance=$2 WHERE id=$1";
    expect(await change(replace, JSON.stringify(planted))).toEqual(positive);
    const optional = structuredClone(planted);
    Object.assign(optional.admission, { destinationDigest: [248] });
    Object.assign(optional.admission.legacyReviewEvidence, { identityComparison: "unavailable" });
    Object.assign(optional.admission.graduation.lineBindings[0]!, { skuRevisionId: reference.skuRevisionId });
    const expectedOptional = structuredClone(positive);
    delete expectedOptional.catalogAcceptance.admission.destinationRef;
    delete expectedOptional.catalogAcceptance.admission.destinationDigest;
    const review = expectedOptional.catalogAcceptance.admission.legacyReviewEvidence;
    review.identityComparison = "unavailable";
    delete review.priorPriceEvidenceRef;
    delete review.priorPolicyEvidenceRef;
    expect(await change(replace, JSON.stringify(optional))).toEqual(expectedOptional);
    Object.assign(planted.lines[0]!.publicationHead, { documentDigest: { planted: 349 } });
    expect(await change(replace, JSON.stringify(planted))).toEqual({ ...positive, catalogAcceptance: null });
  });
  expect((await runtime.query(sql, pair)).rows[0].projection).toEqual(positive);
});
