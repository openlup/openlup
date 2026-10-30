import { createHash,randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalChannelSource,channelSourceDigest,createChannelPurchasedSourceStore,createManagedChannelIngestReservations,createChannelExposureReservationRail,bindChannelPurchasedRows,acknowledgeChannelPurchasedOutcome,createChannelWebhookPort } from "@openlup/platform/channels/server";
import type { ChannelIngestBuyer, ChannelPullPage, ChannelPurchaseCapture } from "@openlup/platform/channels";
import { createManagedStockAvailability } from "@openlup/platform/inventory";
import { channelInstallerWitness } from "../helpers/channelInstallerWitness.js";
import { channelManagedIngestFixture } from "../helpers/channelManagedIngestFixture.js";
import { channelPurchaseFixture,secondChannelRetainedListing } from "../helpers/channelPurchaseFixture.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const forwards = ["20261030121000_channel_retained_basis.sql", "20261030122000_channel_purchased_source.sql"];
function rawPage(page: ChannelPullPage) {
  const text = canonicalChannelSource(page);
  return { p_connection_id: page.scope.connectionId, p_actor_id: page.execution.actorId, p_job_run_id: page.execution.jobRunId,
    p_page_packet_id: page.pagePacketId, p_canonical_text: text, p_input_digest: channelSourceDigest(text) };
}
function rawCapture(capture: ChannelPurchaseCapture) {
  capture.normalizedDigest = channelSourceDigest(canonicalChannelSource(capture.normalized));
  const text = canonicalChannelSource(capture);
  return { p_channel_id: capture.scope.channelId, p_external_order_ref: capture.externalOrderRef, p_external_order_revision: capture.externalOrderRevision,
    p_provider_event_id: capture.providerEventId, p_normalized: capture.normalized, p_capture_text: text, p_capture_digest: channelSourceDigest(text) };
}
describe.each(["portable", "managed"] as const)("channel purchased-source SQL: %s", rail => {
  let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
  let committedFixture: Awaited<ReturnType<typeof channelPurchaseFixture>> | undefined;
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error("Channel purchase proof requires Docker PostgreSQL");
    const spec = { name: `m17-channel-${rail}-${process.pid}`, password: "synthetic-channel-proof" };
    container = rail === "managed" ? await runManagedCompatPostgres(spec) : await runPostgresContainer(spec);
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Channel purchase PostgreSQL unavailable");
    pool = new Pool({ connectionString: rail === "managed" ? container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") : container.connectionString, max: 2 });
    db = await pool.connect();
    if (rail === "managed") {
      await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
      await db.query("SET ROLE postgres; SET search_path=public,extensions");
      for (const filename of readdirSync("supabase/migrations").filter(name => /^\d{14}_.+\.sql$/u.test(name)).sort()) {
        await db.query(readFileSync(`supabase/migrations/${filename}`, "utf8").replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
      }
      await db.query("RESET ROLE; SET row_security=on; SET search_path=public,extensions");
    } else {
      await db.query("CREATE ROLE service_role NOLOGIN");
      const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
      const units = [manifest.baseline, ...manifest.forward];
      for (const unit of units) {
        const bytes = readFileSync(unit.file);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
        await db.query(bytes.toString());
      }
      for (const role of ["service_role", "anon", "authenticated"]) if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) await db.query(`CREATE ROLE ${role} NOLOGIN`);
      for (const filename of forwards) if (!units.some(unit => unit.file.endsWith(filename))) await db.query(readFileSync(`db/platform/migrations/${filename}`, "utf8"));
    }
  }, postgresSetupTimeoutMs);
  afterEach(async()=>{if(db)await db.query("ROLLBACK; RESET ROLE");});
  afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);
  it("captures original purchased evidence, exact readback, page-before-CAS and replay", async () => {
    await db.query("BEGIN");
    try {
      const f = await channelPurchaseFixture(db, rail);
      expect(f.source.readiness).toEqual({sourceCapture:true,settledIngest:rail==="managed",privacyLifecycle:"unavailable"});
      await f.source.recordPage(f.page).catch(error => { throw new Error(JSON.stringify(f.failures), { cause: error }); });
      const result = await f.source.recordCapture(f.capture).catch(error => { throw new Error(JSON.stringify(f.failures), { cause: error }); });
      expect(result).toMatchObject({ ingest: { status: "received", orderId: null } });
      const read = await f.source.readCapture({ channelId: f.capture.scope.channelId, providerEventId: f.capture.providerEventId, actorId: f.actor });
      expect(read?.capture).toEqual(f.capture);
      expect(await f.source.recordCapture(f.capture)).toEqual(result);
      await f.source.recordPage(f.page).catch(error => { throw new Error(JSON.stringify(f.failures), { cause: error }); });
      const commit = await f.source.commitPage(f.page);
      expect(commit.outcome).toBe("applied");
      expect(await f.source.commitPage(f.page)).toEqual({ ...commit, outcome: "replayed" });
    } finally { await db.query("ROLLBACK"); }
  });


  it("preserves exact internal key equality after the approved JSONB helper adaptation", async () => {
    const row=(await db.query(`SELECT public.channel_control_keys('{"a":null,"b":2}','["b","a"]') sorted,
      public.channel_control_keys('{"a":1}','["a","a"]') duplicate,
      public.channel_control_keys('{"a":null}','["a"]') null_value,
      public.channel_control_keys(NULL,'["a"]') absent`)).rows[0];
    expect(row).toEqual({sorted:true,duplicate:false,null_value:true,absent:false});
  });
  it("refuses fresh wrong scope/job and nested-copy/raw evidence mutations with real SQL", async () => {
    await db.query("BEGIN");
    try {
      const f=await channelPurchaseFixture(db,rail);
      const pageArgs=(page:typeof f.page)=>({p_connection_id:page.scope.connectionId,p_actor_id:f.actor,p_job_run_id:f.job,p_page_packet_id:page.pagePacketId,p_canonical_text:canonicalChannelSource(page),p_input_digest:channelSourceDigest(canonicalChannelSource(page))});
      for(const path of ["execution","event"]){const page=structuredClone(f.page);if(path==="execution")Object.assign(page.execution,{extra:{email:"private@example.invalid"}});else Object.assign(page.events[0],{buyer:{email:"private@example.invalid"}});expect((await f.rpc("channel_pull_page_record",pageArgs(page))).error).toMatchObject({code:"22023",message:"channel_purchase_nested_shape"});}
      const wrong=structuredClone(f.page);wrong.scope.connectionVersion++;
      expect((await f.rpc("channel_pull_page_record",pageArgs(wrong))).error).toMatchObject({message:"channel_purchase_scope_conflict"});
      await f.source.recordPage(f.page);
      expect((await f.rpc("channel_pull_progress_commit",{p_connection_id:f.page.scope.connectionId,p_actor_id:f.actor,p_job_run_id:f.job,p_page_packet_id:f.page.pagePacketId,p_expected_cursor:null,p_expected_watermark:null,p_expected_generation:0,p_next_cursor:f.page.next.cursor,p_next_watermark:f.page.next.watermark})).error).toMatchObject({message:"channel_pull_purchase_not_durable"});
      for(const kind of ["sellable","retained"]){const capture=structuredClone(f.capture);if(kind==="sellable")Object.assign(capture.normalized.lines[0].sellable,{extra:{email:"private@example.invalid"}});else Object.assign(capture.retainedRows![0].retained,{extra:{email:"private@example.invalid"}});capture.normalizedDigest=channelSourceDigest(canonicalChannelSource(capture.normalized));const text=canonicalChannelSource(capture);expect((await f.rpc("channel_ingest_record_inbound_event",{p_channel_id:capture.scope.channelId,p_external_order_ref:capture.externalOrderRef,p_external_order_revision:capture.externalOrderRevision,p_provider_event_id:capture.providerEventId,p_normalized:capture.normalized,p_capture_text:text,p_capture_digest:channelSourceDigest(text)})).error).toMatchObject({code:"22023",message:"channel_purchase_nested_shape"});}
      await db.query(rail==="managed"?"UPDATE public.platform_job_runs SET lease_expires_at=now()-interval '1 hour' WHERE id=$1":"UPDATE public.platform_job_runs SET lease_until=now()-interval '1 hour' WHERE id=$1",[f.job]);
      await expect(f.source.recordCapture(f.capture)).rejects.toMatchObject({code:"input_conflict"});
      await db.query(rail==="managed"?"UPDATE public.platform_job_runs SET lease_expires_at=now()+interval '1 hour' WHERE id=$1":"UPDATE public.platform_job_runs SET lease_until=now()+interval '1 hour' WHERE id=$1",[f.job]);
      await f.source.recordCapture(f.capture);await f.source.commitPage(f.page);
      expect((await db.query("SELECT count(*)::int n FROM public.outbox_events WHERE aggregate_id=$1 AND (payload::text||metadata::text) LIKE '%relay@example.test%'",[f.capture.scope.connectionId])).rows[0].n).toBe(0);
      for(const statement of ["UPDATE public.outbox_events SET payload='{}' WHERE id=$1","DELETE FROM public.outbox_events WHERE id=$1"]){await db.query("SAVEPOINT immutable");try{await expect(db.query(statement,[f.capture.captureId])).rejects.toMatchObject({code:"P0001",message:"channel_purchase_source_immutable"});}finally{await db.query("ROLLBACK TO SAVEPOINT immutable; RELEASE SAVEPOINT immutable");}}
      for(const statement of ["TRUNCATE public.outbox_events CASCADE","TRUNCATE public.channel_order_ingests CASCADE"]){await db.query("SAVEPOINT immutable");try{await expect(db.query(statement)).rejects.toMatchObject({code:"P0001"});}finally{await db.query("ROLLBACK TO SAVEPOINT immutable; RELEASE SAVEPOINT immutable");}}
      for(const role of ["anon","authenticated"]){await expect(f.asRole(role,()=>db.query("SELECT public.channel_ingest_capture_read($1,$2,$3)",[f.capture.scope.channelId,f.capture.providerEventId,f.actor]))).rejects.toMatchObject({code:"42501"});}
      await expect(f.asRole("service_role",()=>db.query("SELECT public.channel_purchase_scope(NULL,NULL,NULL,false,NULL)"))).rejects.toMatchObject({code:"42501"});
      await expect(f.asRole("service_role",()=>db.query("SELECT public.channel_control_ref('synthetic')"))).rejects.toMatchObject({code:"42501"});
      await expect(f.asRole("service_role",()=>db.query("UPDATE public.sales_channel_connections SET pull_cursor='forged' WHERE id=$1",[f.capture.scope.connectionId]))).rejects.toMatchObject({code:"42501"});
      await expect(f.asRole("service_role",()=>db.query("INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES('channel_connection',$1,'channel.purchase-source.v1','forged','{}')",[f.capture.scope.connectionId]))).rejects.toMatchObject({code:rail==="managed"?"P0001":"42501"});
      if(rail==="portable")await expect(f.source.originalConversion({ledgerId:randomUUID(),externalLineRef:"line",jobRunId:f.job,canonicalText:null})).rejects.toThrow("channel_purchase_physical_unavailable");
    }finally{await db.query("ROLLBACK");}
  });

  it("binds fresh raw captures to the scoped channel slug before durable effects", async () => {
    await db.query("BEGIN");
    try {
      const f = await channelPurchaseFixture(db, rail);
      await f.source.recordPage(f.page);
      const wrongSlug = structuredClone(f.capture); delete wrongSlug.retainedRows; wrongSlug.normalized.channelSlug = "other-surface";
      expect((await f.rpc("channel_ingest_record_inbound_event", rawCapture(wrongSlug))).error)
        .toMatchObject({ code: "P0001", message: "channel_purchase_scope_conflict" });
      if (rail === "managed") {
        const h = await channelManagedIngestFixture(db, f);
        const contexts = await h.read.contexts(wrongSlug);
        expect(contexts[0].channelSlug).toBe(f.capture.normalized.channelSlug);
        expect(() => bindChannelPurchasedRows({ capture: wrongSlug, contexts })).toThrow();
      }
      expect((await db.query("SELECT count(*)::int n FROM public.channel_order_ingests WHERE channel_id=$1", [f.capture.scope.channelId])).rows[0].n).toBe(0);
      if (rail === "managed") expect((await db.query("SELECT count(*)::int n FROM public.customer_external_refs WHERE provider_kind=$1", ["channel:other-surface"])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_orders WHERE source_channel_id=$1", [f.capture.scope.channelId])).rows[0].n).toBe(0);
    } finally { await db.query("ROLLBACK"); }
  });

  it("binds typed and raw captures to the original page raw digest before durable effects", async () => {
    await db.query("BEGIN");
    try {
      const f = await channelPurchaseFixture(db, rail); await f.source.recordPage(f.page);
      const wrongDigest = structuredClone(f.capture);
      wrongDigest.rawSourceDigest = channelSourceDigest("different-original-source");
      wrongDigest.normalized.payloadDigest = wrongDigest.rawSourceDigest;
      rawCapture(wrongDigest);
      await expect(f.source.recordCapture(wrongDigest)).rejects.toMatchObject({ code: "input_conflict" });
      expect((await f.rpc("channel_ingest_record_inbound_event", rawCapture(wrongDigest))).error)
        .toMatchObject({ code: "P0001", message: "channel_purchase_original_page_required" });
      expect((await db.query("SELECT count(*)::int n FROM public.channel_order_ingests WHERE channel_id=$1", [f.capture.scope.channelId])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_orders WHERE source_channel_id=$1", [f.capture.scope.channelId])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type IN ('channel.purchase-source.v1','channel.purchase-line.v1')", [f.page.scope.connectionId])).rows[0].n).toBe(0);
      expect((await db.query("SELECT pull_cursor,pull_page_generation::int FROM public.sales_channel_connections WHERE id=$1", [f.page.scope.connectionId])).rows[0])
        .toEqual({ pull_cursor: null, pull_page_generation: 0 });
      await f.source.recordCapture(f.capture);
      expect((await f.source.commitPage(f.page)).outcome).toBe("applied");
    } finally { await db.query("ROLLBACK"); }
  });

  it("derives raw page watermarks with public millisecond comparison and exact original tie strings", async () => {
    await db.query("BEGIN");
    try {
      const f = await channelPurchaseFixture(db, rail);
      const future = structuredClone(f.page); future.pagePacketId = randomUUID(); future.events = []; future.observedHead = null;
      future.next = { cursor: null, watermark: "2030-01-01T00:00:00Z", generation: 1 };
      const mismatch = structuredClone(f.page); mismatch.pagePacketId = randomUUID(); mismatch.next.watermark = "2030-01-01T00:00:00Z";
      for (const page of [future, mismatch]) {
        await expect(f.source.recordPage(page)).rejects.toMatchObject({ code: "command_invalid" });
        expect((await f.rpc("channel_pull_page_record", rawPage(page))).error).toMatchObject({ code: "22023", message: "channel_pull_packet_shape" });
        expect((await db.query("SELECT count(*)::int n FROM public.outbox_events WHERE id=$1", [page.pagePacketId])).rows[0].n).toBe(0);
      }
      const page = structuredClone(f.page); page.pagePacketId = randomUUID();
      page.events = ["2026-02-12T07:15:00.1230001Z", "2026-02-12T08:15:00.1239999+01:00", "2026-02-12T07:15:00.1240001Z", "2026-02-12T07:15:00.1249999Z"]
        .map((occurredAt, index) => ({ ...f.page.events[0], providerEventId: `timestamp:${index}`, occurredAt, disposition: "unresolved" as const, captureRef: null }));
      page.next = { cursor: "timestamp:3", watermark: "2026-02-12T07:15:00.1240001Z", generation: 1 };
      const recorded = await f.source.recordPage(page);
      expect((await f.rpc("channel_pull_page_record", rawPage(page))).error).toBeNull();
      const read = await f.source.readPage({ connectionId: page.scope.connectionId, pagePacketId: page.pagePacketId, actorId: f.actor, inputDigest: recorded.inputDigest });
      expect(read?.page.next.watermark).toBe("2026-02-12T07:15:00.1240001Z");
      expect((await f.source.commitPage(page)).outcome).toBe("applied");
      expect((await f.source.commitPage(page)).outcome).toBe("replayed");
      const tied = structuredClone(page); tied.pagePacketId = randomUUID(); tied.expected = page.next; tied.request.from = page.next.cursor;
      tied.events = [{ ...page.events[0], providerEventId: "timestamp:tie", occurredAt: "2026-02-12T08:15:00.12499999+01:00" }];
      tied.next = { ...tied.expected, cursor: "timestamp:tie", generation: 2 };
      await f.source.recordPage(tied);
      expect((await f.source.commitPage(tied)).result.after.watermark).toBe(page.next.watermark);
      expect((await f.source.commitPage(tied)).outcome).toBe("replayed");
    } finally { await db.query("ROLLBACK"); }
  });

  it("rejects malformed normalized scalar copies atomically and roundtrips Unicode and nullable values", async () => {
    await db.query("BEGIN");
    try {
      const f = await channelPurchaseFixture(db, rail); await f.source.recordPage(f.page);
      const invalid: readonly ["buyer" | "shipTo" | "shipping", string, unknown][] = [
        ["buyer", "email", { nested: "private@example.invalid" }], ["buyer", "firstName", []], ["buyer", "lastName", true],
        ["buyer", "phone", 7], ["buyer", "emailIsMasked", "false"], ["buyer", "externalCustomerRef", {}],
        ["buyer", "externalCustomerRef", "x".repeat(129)], ["buyer", "email", "x".repeat(321)],
        ["buyer", "firstName", "x".repeat(121)], ["buyer", "firstName", "😀".repeat(61)], ["buyer", "lastName", "x".repeat(121)],
        ["buyer", "phone", "x".repeat(41)], ["buyer", "taxId", "x".repeat(33)], ["buyer", "companyName", "x".repeat(201)],
        ["buyer", "firstName", "\tUntrimmed"], ["buyer", "externalCustomerRef", "\u00a0untrimmed"],
        ["shipTo", "recipientName", {}], ["shipTo", "line1", []], ["shipTo", "line2", false], ["shipTo", "city", null],
        ["shipTo", "recipientName", ""], ["shipTo", "recipientName", "x".repeat(201)], ["shipTo", "line1", "x".repeat(201)],
        ["shipTo", "line2", "x".repeat(201)], ["shipTo", "postalCode", "x".repeat(21)], ["shipTo", "city", "x".repeat(121)],
        ["shipTo", "phone", "x".repeat(41)], ["shipTo", "pickupPointRef", "x".repeat(121)],
        ["shipTo", "city", "Trailing\u3000"], ["shipTo", "countryCode", true], ["shipTo", "countryCode", "de"],
        ["shipping", "methodLabel", {}], ["shipping", "carrierHint", []], ["shipping", "carrierHint", true],
        ["shipping", "methodLabel", "x".repeat(121)], ["shipping", "carrierHint", "x".repeat(65)],
        ["shipping", "methodLabel", "\uFEFFUntrimmed"], ["shipping", "grossMinor", "7"], ["shipping", "discountMinor", -1],
      ];
      for (const [section, key, value] of invalid) {
        const capture = structuredClone(f.capture); Object.assign(capture.normalized[section], { [key]: value });
        expect((await f.rpc("channel_ingest_record_inbound_event", rawCapture(capture))).error, `${section}.${key}: ${JSON.stringify(value)}`)
          .toMatchObject({ code: "22023", message: "channel_purchase_nested_shape" });
        expect((await db.query("SELECT count(*)::int n FROM public.channel_order_ingests WHERE channel_id=$1", [capture.scope.channelId])).rows[0].n).toBe(0);
        expect((await db.query("SELECT count(*)::int n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type IN ('channel.purchase-source.v1','channel.purchase-line.v1')", [capture.scope.connectionId])).rows[0].n).toBe(0);
      }
      f.capture.normalized.buyer.firstName = "Zoë 字 😀"; f.capture.normalized.buyer.lastName = null;
      f.capture.normalized.buyer.companyName = "😀".repeat(100);
      f.capture.normalized.shipTo.city = "Łódź 字"; f.capture.normalized.shipTo.line2 = null;
      f.capture.normalized.shipping.methodLabel = "取件 😀"; f.capture.normalized.shipping.carrierHint = null;
      rawCapture(f.capture);
      await f.source.recordCapture(f.capture);
      expect((await f.source.readCapture({ channelId: f.capture.scope.channelId, providerEventId: f.capture.providerEventId, actorId: f.actor }))?.capture).toEqual(f.capture);
    } finally { await db.query("ROLLBACK"); }
  });

  if (rail === "managed") it.each([false, true])("settles local allocation with split lots %s and counts items while preserving exact holds on replay", async split => {
    await db.query("BEGIN");
    try {
      const f = await channelPurchaseFixture(db, rail), h = await channelManagedIngestFixture(db, f);
      const capture = structuredClone(f.capture); delete capture.retainedRows;
      capture.normalized.lines[0] = { ...capture.normalized.lines[0], quantity: 6, lineGrossMinor: 18, lineDiscountMinor: 8 };
      capture.normalized.totals = { ...capture.normalized.totals, itemsGrossMinor: 18, itemsDiscountMinor: 8, grandTotalMinor: 15 };
      capture.normalizedDigest = channelSourceDigest(canonicalChannelSource(capture.normalized));
      f.capture = bindChannelPurchasedRows({ capture, contexts: [f.context] });
      await db.query("UPDATE public.sales_channels SET delivery_selection=$2 WHERE id=$1", [capture.scope.channelId, { providerKind: "synthetic_local", serviceCode: "LOCAL" }]);
      const location = randomUUID(), sku = f.context.bundle.components[0].skuId;
      await db.query("INSERT INTO public.inventory_locations(id,code,display_name,kind,status,region,fulfillable) VALUES($1,'channel-local','Synthetic local stock','internal_warehouse','active','DE',true)", [location]);
      for (const [index, quantity] of (split ? [1, 119] : [120]).entries()) {
        const lot = randomUUID();
        await db.query("INSERT INTO public.inventory_lots(id,sku_id,lot_code,expires_at) VALUES($1,$2,$3,now()+$4::int*interval '1 day')", [lot, sku, `local:${index}`, 10 + index]);
        await db.query("INSERT INTO public.inventory_balances(sku_id,location_id,lot_id,on_hand) VALUES($1,$2,$3,$4)", [sku, location, lot, quantity]);
      }
      await f.source.recordPage(f.page);
      const ledgerId = (await f.source.recordCapture(f.capture) as { ingest: { id: string } }).ingest.id;
      const outcome = await h.run(ledgerId); expect(outcome).toMatchObject({ kind: "settled" });
      if (outcome.kind !== "settled") throw new Error("local allocation did not settle");
      const holds = await h.read.reservations(outcome.orderId);
      expect(holds).toHaveLength(split ? 4 : 3);
      expect(holds.every(hold => hold.metadata.providerKind === undefined && hold.metadata.holdKind === "paid_order_hold" && hold.expires_at === null)).toBe(true);
      expect(holds.reduce((sum, hold) => sum + hold.quantity, 0)).toBe(6);
      const items = await h.options.rails!.orderItems.readOrderItems(outcome.orderId);
      const order = { idempotencyKey: "unused-sealed-replay", orderId: outcome.orderId, items, providerKind: "synthetic_local" };
      const reservations = createChannelExposureReservationRail({ jobRunId: f.job, ledgerId, capture: f.capture, source: f.source, read: h.read, newId: randomUUID });
      expect(await reservations.reserveChannelOrderItems(order)).toEqual({ reservedItemCount: 3 });
      for (const change of [{ quantity: holds[0].quantity + 1 }, { sku_id: randomUUID() }, { order_item_id: randomUUID() }, { idempotency_key: "wrong-hold-key" }]) {
        const malformed = createChannelExposureReservationRail({ jobRunId: f.job, ledgerId, capture: f.capture, source: f.source,
          read: { ...h.read, async reservations() { return [{ ...holds[0], ...change }, ...holds.slice(1)]; } }, newId: randomUUID });
        await expect(malformed.reserveChannelOrderItems(order)).rejects.toMatchObject({ code: "response_invalid" });
      }
      for (const patch of ["status='released'", "expires_at=now()+interval '1 hour'"]) {
        await db.query("SAVEPOINT malformed_hold");
        try {
          await db.query(`UPDATE public.inventory_reservations SET ${patch} WHERE id=$1`, [holds[0].id]);
          await expect(reservations.reserveChannelOrderItems(order)).rejects.toThrow();
        } finally { await db.query("ROLLBACK TO SAVEPOINT malformed_hold; RELEASE SAVEPOINT malformed_hold"); }
      }
      expect(await h.run(ledgerId)).toMatchObject({ kind: "replayed", orderId: outcome.orderId });
      expect(await h.read.reservations(outcome.orderId)).toEqual(holds);
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1", [outcome.orderId])).rows[0].n).toBe(1);
      expect((await db.query("SELECT count(*)::int n FROM public.inventory_stock_movements WHERE reservation_id=ANY($1::uuid[])", [holds.map(hold => hold.id)])).rows[0].n).toBe(holds.length);
    } finally { await db.query("ROLLBACK"); }
  });

  if (rail === "managed") it("recovers the sealed original order and holds after the channel delivery provider changes", async () => {
    await db.query("BEGIN");
    try {
      const f = await channelPurchaseFixture(db, rail), h = await channelManagedIngestFixture(db, f); await h.stock(120);
      await f.source.recordPage(f.page); const ledgerId = (await f.source.recordCapture(f.capture) as { ingest: { id: string } }).ingest.id;
      const readHolds = h.read.reservations;
      h.read.reservations = async () => { throw new Error("synthetic_response_loss_after_committed_conversion"); };
      await expect(h.run(ledgerId)).rejects.toThrow();
      h.read.reservations = readHolds;
      const orderId = (await db.query("SELECT order_id FROM public.channel_order_ingests WHERE id=$1", [ledgerId])).rows[0].order_id;
      const holds = await readHolds(orderId);
      const original = await f.source.originalConversion({ ledgerId, externalLineRef: "line:19", jobRunId: f.job, canonicalText: null });
      expect(holds).toHaveLength(3); expect(holds.every(hold => hold.metadata.providerKind === f.providerKind)).toBe(true);
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1", [orderId])).rows[0].n).toBe(0);
      await db.query("UPDATE public.sales_channels SET delivery_selection=$2 WHERE id=$1", [f.capture.scope.channelId, { providerKind: "synthetic_changed", serviceCode: "CHANGED" }]);
      expect(await h.run(ledgerId)).toMatchObject({ kind: "settled", orderId });
      expect((await h.read.reservations(orderId)).map(hold => ({ ...hold, metadata: {} }))).toEqual(holds.map(hold => ({ ...hold, metadata: {} })));
      expect((await h.read.reservations(orderId)).every(hold => hold.metadata.providerKind === f.providerKind && hold.metadata.holdKind === "paid_order_hold")).toBe(true);
      expect(await f.source.originalConversion({ ledgerId, externalLineRef: "line:19", jobRunId: f.job, canonicalText: null })).toBe(original);
      expect((await db.query("SELECT metadata#>>'{selectedDelivery,providerKind}' provider FROM public.commerce_orders WHERE id=$1", [orderId])).rows[0].provider).toBe(f.providerKind);
      expect(await h.run(ledgerId)).toMatchObject({ kind: "replayed", orderId });
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1", [orderId])).rows[0].n).toBe(1);
    } finally { await db.query("ROLLBACK"); }
  });

  if(rail==="managed")it("reads actual retained context, original capture and recovery selection through the managed adapter",async()=>{
    await db.query("BEGIN");try{
      const f=await channelPurchaseFixture(db,rail),h=await channelManagedIngestFixture(db,f);
      expect(await h.read.contexts(f.capture).catch(error=>{throw new Error(JSON.stringify(f.failures),{cause:error});})).toEqual([f.context]);
      await f.source.recordPage(f.page);const ledger=(await f.source.recordCapture(f.capture) as {ingest:{id:string}}).ingest.id;
      expect(await h.read.pageDigest(f.page.pagePacketId)).toBe(channelSourceDigest(canonicalChannelSource(f.page)));
      expect(await h.read.original(ledger)).toEqual(f.capture);expect(await h.read.pending(f.capture.scope.channelId)).toEqual([f.capture]);
      expect(await h.read.exposure(f.context.listing.id)).toEqual({exposure_generation:1,exposure_issued_basis_ref:f.context.firstApproval.id});
      expect(await h.read.lineItems(randomUUID(),"none")).toEqual([]);expect(await h.read.reservations(randomUUID())).toEqual([]);
    }finally{await db.query("ROLLBACK");}
  });
  if (rail === "managed") it("converts original paid exposure before clamping and settles exactly once after stock recovery", async () => {
    await db.query("BEGIN");
    try {
      const f=await channelPurchaseFixture(db,rail),h=await channelManagedIngestFixture(db,f);
      await f.source.recordPage(f.page);const recorded=await f.source.recordCapture(f.capture);
      const ledgerId=(recorded as {ingest:{id:string}}).ingest.id;
      await h.stock(100);
      const stock=createManagedStockAvailability({rpc:f.rpc},{now:()=>new Date().toISOString()});
      expect((await stock.read({skus:["PART-A"],horizonDays:14,excludeOrderId:null})).get("PART-A")).toMatchObject({available:40,availableForNewPurchases:40});
      expect(Number((await db.query("SELECT public.inventory_channel_exposure_quantity($1) n",[f.context.bundle.components[0].skuId])).rows[0].n)).toBe(60);
      await h.stock(5);
      expect(await h.run(ledgerId)).toMatchObject({kind:"blocked_stock",ledgerId});
      const orderId=(await db.query("SELECT order_id FROM public.channel_order_ingests WHERE id=$1",[ledgerId])).rows[0].order_id;
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1",[orderId])).rows[0].n).toBe(0);
      expect(await f.source.originalConversion({ledgerId,externalLineRef:"line:19",jobRunId:f.job,canonicalText:null})).toBeNull();
      expect((await db.query("SELECT exposure_converted_units FROM public.sales_channel_listings WHERE id=$1",[f.context.listing.id])).rows[0].exposure_converted_units).toBe("0");
      expect((await db.query("SELECT count(*)::int n FROM public.inventory_reservations WHERE order_id=$1",[orderId])).rows[0].n).toBe(0);
      await h.stock(60);
      const command={schemaVersion:"channel.exposure.v1",resourceKind:"listing",resourceId:f.context.listing.id,operationId:randomUUID(),operation:"exposure_convert_sale",expectedGeneration:1,
        payload:{scope:{connectionId:f.capture.scope.connectionId,channelId:f.capture.scope.channelId,connectorProviderKind:f.capture.scope.connectorKind,connectorShape:"direct",applicationRef:f.capture.namespace.applicationRef,environmentRef:f.capture.scope.environmentRef,sellerRef:f.capture.scope.sellerRef,channelExternalRef:f.capture.namespace.channelExternalRef,externalOfferRef:f.context.listing.externalOfferRef},issuedBasisRef:f.context.firstApproval.id,ingestId:ledgerId,externalLineRef:"line:19",orderId,purchasedSets:3}};
      expect((await f.rpc("channel_purchase_conversion_command",{p_ledger_id:ledgerId,p_external_line_ref:"line:19",p_actor_id:f.actor,p_job_run_id:null,p_command_text:canonicalChannelSource(command)})).error).toMatchObject({code:"P0001",message:"channel_purchase_job_not_live"});
      expect(await f.source.originalConversion({ledgerId,externalLineRef:"line:19",jobRunId:f.job,canonicalText:null})).toBeNull();
      expect((await db.query("SELECT count(*)::int n FROM public.inventory_reservations WHERE order_id=$1",[orderId])).rows[0].n).toBe(0);
      // Current price/status/expiry drift cannot rewrite a retained paid obligation.
      await db.query("UPDATE public.catalog_skus SET status='archived' WHERE id=$1",[f.context.bundle.components[0].skuId]);
      await db.query("UPDATE public.sales_channels SET status='disabled' WHERE id=$1",[f.capture.scope.channelId]);
      const settled=await h.run(ledgerId);expect(settled).toMatchObject({kind:"settled",ledgerId,orderId});
      const items=(await db.query("SELECT quantity,total_cents,discount_allocated_cents FROM public.commerce_order_items WHERE order_id=$1 ORDER BY allocation_ordinal",[orderId])).rows;
      expect(items.map(row=>[row.quantity,row.total_cents,row.discount_allocated_cents])).toEqual([[1,4,2],[1,3,1],[1,2,1]]);
      const holds=(await db.query("SELECT id,kind,status,quantity,expires_at,metadata FROM public.inventory_reservations WHERE order_id=$1 ORDER BY id",[orderId])).rows;
      expect(holds).toHaveLength(3);for(const hold of holds)expect(hold).toMatchObject({kind:"channel_order_window",status:"reserved",quantity:1,expires_at:null,metadata:{providerKind:f.providerKind}});
      expect((await db.query("SELECT exposure_converted_units,exposure_generation FROM public.sales_channel_listings WHERE id=$1",[f.context.listing.id])).rows[0]).toEqual({exposure_converted_units:"3",exposure_generation:"2"});
      const original=await f.source.originalConversion({ledgerId,externalLineRef:"line:19",jobRunId:f.job,canonicalText:null});expect(original).not.toBeNull();
      await db.query("UPDATE public.platform_job_runs SET lease_expires_at=now()-interval '1 hour' WHERE id=$1",[f.job]);
      expect(await h.run(ledgerId)).toMatchObject({kind:"replayed",orderId});
      expect(await f.source.originalConversion({ledgerId,externalLineRef:"line:19",jobRunId:f.job,canonicalText:null})).toBe(original);
      expect((await db.query("SELECT id,kind,status,quantity,expires_at,metadata FROM public.inventory_reservations WHERE order_id=$1 ORDER BY id",[orderId])).rows).toEqual(holds);
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1",[orderId])).rows[0].n).toBe(1);
      expect((await db.query("SELECT status FROM public.channel_order_ingests WHERE id=$1",[ledgerId])).rows[0].status).toBe("settled");
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_orders WHERE source_channel_id=$1 AND source_order_ref=$2",[f.capture.scope.channelId,f.capture.externalOrderRef])).rows[0].n).toBe(1);
      expect((await db.query("SELECT count(*)::int n FROM public.inbound_provider_events WHERE payment_intent_id=(SELECT payment_intent_id FROM public.channel_order_ingests WHERE id=$1) AND event_type='payment.succeeded'",[ledgerId])).rows[0].n).toBe(1);
      expect((await db.query("SELECT count(*)::int n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.paid'",[orderId])).rows[0].n).toBe(1);
      const ack={capture:f.capture,outcome:settled,acknowledge:async()=>({acknowledged:false}),complete:async(id:string)=>{await h.store.advanceLedger({ledgerId:id,toStatus:"done"});}};
      expect(await acknowledgeChannelPurchasedOutcome(ack)).toBe(false);
      expect((await db.query("SELECT status FROM public.channel_order_ingests WHERE id=$1",[ledgerId])).rows[0].status).toBe("settled");
      expect(await acknowledgeChannelPurchasedOutcome({...ack,acknowledge:async()=>({acknowledged:true})})).toBe(true);
      expect((await db.query("SELECT status FROM public.channel_order_ingests WHERE id=$1",[ledgerId])).rows[0].status).toBe("done");
    } finally { await db.query("ROLLBACK"); }
  });



  if (rail === "managed") it("retains partial holds and original command after lost ACK, then recovers after a competing same-listing purchase", async () => {
    await db.query("BEGIN");
    try {
      const f=await channelPurchaseFixture(db,rail),second=await secondChannelRetainedListing(db,f),contexts=[f.context,second];
      const capture=structuredClone(f.capture);delete capture.retainedRows;
      capture.normalized.lines.push({...capture.normalized.lines[0],externalLineRef:"line:second",sellable:{kind:"bundle",externalOfferRef:"offer:second",bundleCode:null}});
      capture.normalized.totals={...capture.normalized.totals,itemsGrossMinor:18,itemsDiscountMinor:8,grandTotalMinor:15};
      capture.products.push({...capture.products[0],externalLineRef:"line:second",externalOfferRef:"offer:second"});
      capture.normalizedDigest=channelSourceDigest(canonicalChannelSource(capture.normalized));f.capture=bindChannelPurchasedRows({capture,contexts});
      const h=await channelManagedIngestFixture(db,f);await h.stock(120);
      await f.source.recordPage(f.page);const ledger=(await f.source.recordCapture(f.capture) as {ingest:{id:string}}).ingest.id;
      const original=f.source.originalConversion;let dropped=false;
      f.source.originalConversion=async input=>{const result=await original(input);if(!dropped&&input.canonicalText!==null&&input.externalLineRef==="line:19"){dropped=true;await h.stock(2);throw new Error("synthetic_lost_ack");}return result;};
      const blocked=await h.run(ledger);expect(dropped).toBe(true);expect(blocked).toMatchObject({kind:"blocked_stock",ledgerId:ledger});
      if(blocked.kind!=="blocked_stock")throw new Error("partial conversion not retained");
      const prior=(await db.query("SELECT id FROM public.inventory_reservations WHERE order_id=$1 ORDER BY id",[blocked.orderId])).rows;
      expect(prior).toHaveLength(3);expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1",[blocked.orderId])).rows[0].n).toBe(0);
      const args={ledgerId:ledger,jobRunId:f.job,canonicalText:null};const firstCommand=await original({...args,externalLineRef:"line:19"});expect(firstCommand).not.toBeNull();expect(await original({...args,externalLineRef:"line:second"})).toBeNull();
      await h.stock(120);
      const b=structuredClone(f.capture);delete b.retainedRows;b.captureId=randomUUID();b.pagePacketRef=randomUUID();b.providerEventId="competitor:event";b.externalOrderRef="competitor:order";b.rawSourceDigest=channelSourceDigest("competitor");
      b.normalized={...b.normalized,providerEventId:b.providerEventId,externalOrderRef:b.externalOrderRef,payloadDigest:b.rawSourceDigest,lines:[{...b.normalized.lines[1],externalLineRef:"competitor:line",quantity:1,unitGrossMinor:3,lineGrossMinor:3,lineDiscountMinor:0}],totals:{...b.normalized.totals,itemsGrossMinor:3,itemsDiscountMinor:0,grandTotalMinor:8},payment:{...b.normalized.payment,externalPaymentRef:"competitor:payment"}};
      b.products=[{...b.products[1],externalLineRef:"competitor:line"}];b.normalizedDigest=channelSourceDigest(canonicalChannelSource(b.normalized));
      const bCapture=bindChannelPurchasedRows({capture:b,contexts}),bPage={...f.page,pagePacketId:b.pagePacketRef,events:[{...f.page.events[0],providerEventId:b.providerEventId,externalOrderRef:b.externalOrderRef,rawSourceDigest:b.rawSourceDigest,captureRef:b.captureId}],observedHead:{...f.page.observedHead!,providerEventId:b.providerEventId},next:{...f.page.next,cursor:b.providerEventId}};
      await f.source.recordPage(bPage);const bLedger=(await f.source.recordCapture(bCapture) as {ingest:{id:string}}).ingest.id;
      const bFixture={...f,capture:bCapture,page:bPage},bRun=await channelManagedIngestFixture(db,bFixture);
      expect(await bRun.run(bLedger)).toMatchObject({kind:"settled"});
      const bCommand=JSON.parse((await original({ledgerId:bLedger,externalLineRef:"competitor:line",jobRunId:f.job,canonicalText:null}))!);
      expect(await h.run(ledger)).toMatchObject({kind:"settled",orderId:blocked.orderId});
      const afterCommand=JSON.parse((await original({...args,externalLineRef:"line:second"}))!);expect(afterCommand.expectedGeneration).toBe(bCommand.expectedGeneration+1);
      expect(await original({...args,externalLineRef:"line:19"})).toBe(firstCommand);
      const after=(await db.query("SELECT id FROM public.inventory_reservations WHERE order_id=$1 ORDER BY id",[blocked.orderId])).rows;
      expect(after).toHaveLength(6);for(const hold of prior)expect(after).toContainEqual(hold);
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1",[blocked.orderId])).rows[0].n).toBe(1);
      expect(await h.run(ledger)).toMatchObject({kind:"replayed"});
      expect((await f.source.commitPage(f.page)).outcome).toBe("applied");expect((await f.source.commitPage(f.page)).outcome).toBe("replayed");
    }finally{await db.query("ROLLBACK");}
  });


  if(rail==="managed")it("persists named quarantine and retryable failure states without order or money effects",async()=>{
    await db.query("BEGIN");try{
      const f=await channelPurchaseFixture(db,rail),h=await channelManagedIngestFixture(db,f);
      const outcome=await createChannelWebhookPort(h.options).ingestOrder(f.capture.normalized);expect(outcome).toMatchObject({kind:"quarantined",reason:"unmapped_sellable"});
      const row=(await db.query("SELECT id,status FROM public.channel_order_ingests WHERE channel_id=$1",[f.capture.scope.channelId])).rows[0];expect(row.status).toBe("quarantined");
      expect((await db.query("SELECT count(*)::int n FROM public.sales_channel_quarantine WHERE channel_id=$1",[f.capture.scope.channelId])).rows[0].n).toBe(1);
      await h.store.advanceLedger({ledgerId:row.id,toStatus:"failed",lastError:"synthetic_transport_busy"});
      expect((await db.query("SELECT status,last_error FROM public.channel_order_ingests WHERE id=$1",[row.id])).rows[0]).toEqual({status:"failed",last_error:"synthetic_transport_busy"});
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_orders WHERE source_channel_id=$1",[f.capture.scope.channelId])).rows[0].n).toBe(0);
    }finally{await db.query("ROLLBACK");}
  });
  if (rail === "managed") it("preserves stable buyer references, shared-email separation and order-scoped null fallback", async () => {
    await db.query("BEGIN");try{
      const f=await channelPurchaseFixture(db,rail),h=await channelManagedIngestFixture(db,f);
      const results:ChannelIngestBuyer[]=[];
      for(const [index,reference]of ["buyer:one","buyer:one","buyer:two",null,null].entries()) {
        const order=structuredClone(f.capture.normalized);order.externalOrderRef=`identity:order:${index}`;order.providerEventId=`identity:event:${index}`;order.buyer.externalCustomerRef=reference;
        const ledger=await h.store.recordInboundEvent({channelId:f.capture.scope.channelId,externalOrderRef:order.externalOrderRef,externalOrderRevision:order.externalOrderRevision,providerEventId:order.providerEventId,normalized:order});
        const buyer=await h.store.upsertBuyer({ledgerId:ledger.id,buyer:order.buyer,shipTo:order.shipTo});
        expect(await h.store.upsertBuyer({ledgerId:ledger.id,buyer:order.buyer,shipTo:order.shipTo})).toMatchObject({clientId:buyer.clientId,shippingAddressId:buyer.shippingAddressId,replayed:true});results.push(buyer);
      }
      expect(results[0].clientId).toBe(results[1].clientId);expect(new Set([results[0],...results.slice(2)].map(row=>row.clientId)).size).toBe(4);
      expect((await db.query("SELECT count(*)::int n FROM public.customer_external_refs WHERE provider_kind=$1",[`channel:${f.capture.normalized.channelSlug}`])).rows[0].n).toBe(4);
    }finally{await db.query("ROLLBACK");}
  });
  if (rail === "managed") it("executes all 48 retained source boundary pgTAP assertions", async () => {
    await db.query("CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions; SET search_path=public,extensions");
    const results=await db.query(readFileSync("supabase/tests/channel_purchased_order_boundary_test.sql","utf8"));
    const lines=(Array.isArray(results)?results:[results]).flatMap(result=>result.rows.flatMap(row=>Object.values(row).filter((value):value is string=>typeof value==="string")));
    expect(lines.filter(line=>/^(?:not )?ok \d+/u.test(line))).toHaveLength(48);
    expect(lines.filter(line=>line.startsWith("not ok"))).toEqual([]);
  });


  if(rail==="managed")it.each([
    {file:"channel_order_reaches_the_dispatch_gate_test.sql",count:12},
    {file:"inventory_reservation_replay_characterization_test.sql",count:6},
  ])("preserves the existing owner pgTAP witness $file",async({file,count})=>{
    await db.query("CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions; SET search_path=public,extensions");
    const results=await db.query(readFileSync(`supabase/tests/${file}`,"utf8"));
    const lines=(Array.isArray(results)?results:[results]).flatMap(result=>result.rows.flatMap(row=>Object.values(row).filter((value):value is string=>typeof value==="string")));
    expect(lines.filter(line=>/^(?:not )?ok \d+/u.test(line))).toHaveLength(count);expect(lines.filter(line=>line.startsWith("not ok"))).toEqual([]);
  });
  if (rail === "managed") it("preserves closed-owner installation snapshots through poison and injected failure rollback", async () => { try { await db.query("SET ROLE postgres"); await channelInstallerWitness(db); } finally { await db.query("RESET ROLE"); } });

  if (rail === "managed") it("waits for committed stock deductions before channel ATP and refuses ten from stock ten minus eight", async () => {
    await db.query("BEGIN");const f=await channelPurchaseFixture(db,rail),h=await channelManagedIngestFixture(db,f);
    const sku=randomUUID(),product=(await db.query("SELECT product_id FROM public.catalog_skus WHERE id=$1",[f.context.bundle.components[0].skuId])).rows[0].product_id;
    await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit) VALUES($1,$2,'DEDUCTION','Synthetic deduction','other','active',1,1)",[sku,product]);
    await db.query("SELECT public.fulfillment_provider_upsert_stock_current($1,$2,'DEDUCTION',10,10,0,now(),now()+interval '1 hour','channel-deduction','{}')",[randomUUID(),f.providerKind]);
    const location=(await db.query("SELECT id FROM public.inventory_locations WHERE provider_kind=$1 ORDER BY id LIMIT 1",[f.providerKind])).rows[0].id;
    await db.query("INSERT INTO public.inventory_balances(sku_id,location_id,on_hand,safety_stock) VALUES($1,$2,10,0) ON CONFLICT DO NOTHING",[sku,location]);
    const order=structuredClone(f.capture.normalized);order.externalOrderRef="deduction:order";order.providerEventId="deduction:event";order.lines=[{...order.lines[0],sellable:{kind:"sku",externalOfferRef:"deduction:offer",skuCode:"DEDUCTION"},quantity:10,unitGrossMinor:1,lineGrossMinor:10,lineDiscountMinor:0}];
    order.totals={...order.totals,itemsGrossMinor:10,itemsDiscountMinor:0,grandTotalMinor:15};
    const ledger=await h.store.recordInboundEvent({channelId:f.capture.scope.channelId,externalOrderRef:order.externalOrderRef,externalOrderRevision:order.externalOrderRevision,providerEventId:order.providerEventId,normalized:order});
    await h.store.upsertBuyer({ledgerId:ledger.id,buyer:order.buyer,shipTo:order.shipTo});
    const created=await h.store.createChannelOrder({idempotencyKey:"deduction-order",ledgerId:ledger.id});
    const items=(await db.query("SELECT id,sku_id,quantity FROM public.commerce_order_items WHERE order_id=$1",[created.orderId])).rows.map(row=>({orderItemId:row.id,skuId:row.sku_id,quantity:row.quantity}));
    await db.query("COMMIT");committedFixture=f;const writer=new Pool({connectionString:container!.connectionString.replace("postgres://postgres:","postgres://supabase_admin:"),max:1});
    try {
      expect((await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid).not.toBe((await db.query("SELECT pg_backend_pid() pid")).rows[0].pid);
      await writer.query("BEGIN");
      await writer.query("UPDATE public.inventory_balances SET safety_stock=8 WHERE sku_id=$1",[sku]);
      await db.query("BEGIN");let finished=false;
      const waiting=createManagedChannelIngestReservations({rpc:f.rpc}).reserveChannelOrderItems({idempotencyKey:"deduction-hold",orderId:created.orderId,items,providerKind:f.providerKind}).then(value=>({value,error:null}),error=>({value:null,error})).finally(()=>{finished=true;});
      await new Promise(resolve=>setTimeout(resolve,60));expect(finished).toBe(false);
      await writer.query("COMMIT");expect((await waiting).error).toMatchObject({code:"23514"});
      expect((await db.query("SELECT count(*)::int n FROM public.inventory_reservations WHERE order_id=$1",[created.orderId])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1",[created.orderId])).rows[0].n).toBe(0);
    }finally{await writer.query("ROLLBACK");await db.query("ROLLBACK");await writer.end();}

  },30_000);
  it("uses distinct restricted logins for protected read, primitive denial and concurrent original-receipt CAS", async () => {
    await db.query("BEGIN");
    const f=committedFixture??await channelPurchaseFixture(db,rail);
    await f.source.recordPage(f.page);await f.source.recordCapture(f.capture);
    const competing=structuredClone(f.page);competing.pagePacketId=randomUUID();
    await f.source.recordPage(competing);
    await db.query("COMMIT");
    await db.query("CREATE ROLE channel_source_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-channel-proof'; GRANT service_role TO channel_source_runtime; CREATE ROLE channel_source_browser LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-channel-proof'; GRANT authenticated TO channel_source_browser");
    const runtime=(role:string,login:string)=>{const u=new URL(container!.connectionString);u.username=login;return new Pool({connectionString:u.toString(),max:1,options:`-c role=${role} -c row_security=on`});};
    const firstPool=runtime("service_role","channel_source_runtime"),secondPool=runtime("service_role","channel_source_runtime"),browserPool=runtime("authenticated","channel_source_browser");
    const first=await firstPool.connect(),second=await secondPool.connect(),browser=await browserPool.connect();
    let revoker:PoolClient|undefined;
    const runtimeFailures: {code?:string;message?:string;where?:string}[]=[];
    const source=(connection:PoolClient)=>createChannelPurchasedSourceStore({actorId:f.actor,rail,client:{async rpc(name,args){try{return{data:(await connection.query(`SELECT public.${name}(${Object.keys(args).map((key,i)=>`${key} => $${i+1}`).join(",")}) response`,Object.values(args).map(value=>value!==null&&typeof value==="object"?JSON.stringify(value):value))).rows[0].response,error:null};}catch(error){const e=error as {code?:string;message?:string;where?:string};runtimeFailures.push({code:e.code,message:e.message,where:e.where});return{data:null,error:e};}}}});
    try {
      for(const connection of [first,second])await connection.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:"service_role",sub:f.actor})]);
      const identities=await Promise.all([first,second,browser].map(connection=>connection.query("SELECT pg_backend_pid() pid,current_user caller,session_user login,(SELECT rolsuper FROM pg_roles WHERE rolname=session_user) super")));
      expect(new Set(identities.map(result=>result.rows[0].pid)).size).toBe(3);expect(identities.every(result=>result.rows[0].super===false)).toBe(true);
      expect((await source(first).readCapture({channelId:f.capture.scope.channelId,providerEventId:f.capture.providerEventId,actorId:f.actor}))?.capture).toEqual(f.capture);
      await expect(first.query("SELECT public.channel_purchase_scope(NULL,NULL,NULL,false,NULL)")).rejects.toMatchObject({code:"42501"});
      await expect(browser.query("SELECT public.channel_ingest_capture_read($1,$2,$3)",[f.capture.scope.channelId,f.capture.providerEventId,f.actor])).rejects.toMatchObject({code:"42501"});
      if(rail==="managed")await expect(first.query("SET ROLE openlup_channel_purchase_writer")).rejects.toMatchObject({code:"42501"});
      else await expect(first.query("SET ROLE postgres")).rejects.toMatchObject({code:"42501"});
      await first.query("BEGIN");const applied=await source(first).commitPage(f.page).catch(error=>{throw new Error(JSON.stringify(runtimeFailures),{cause:error});});expect(applied.outcome).toBe("applied");
      revoker=await pool.connect();let revoked=false;
      const revocation=(rail==="managed"?revoker.query("UPDATE public.platform_job_runs SET lease_expires_at=now()-interval '1 hour' WHERE id=$1",[f.job]):revoker.query("UPDATE public.platform_job_runs SET lease_until=now()-interval '1 hour' WHERE id=$1",[f.job])).then(()=>null,error=>error).finally(()=>{revoked=true;});
      await second.query("BEGIN");let finished=false;const waiting=source(second).commitPage(f.page).finally(()=>{finished=true;});
      await new Promise(resolve=>setTimeout(resolve,60));expect(finished).toBe(false);expect(revoked).toBe(false);
      const waitingPid=identities[1].rows[0].pid;
      expect((await db.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[waitingPid])).rows[0].wait_event_type).toBe("Lock");
      await first.query("COMMIT");expect(await waiting).toEqual({...applied,outcome:"replayed"});await second.query("COMMIT");expect(await revocation).toBeNull();
      await db.query(rail==="managed"?"UPDATE public.platform_job_runs SET lease_expires_at=now()+interval '1 hour' WHERE id=$1":"UPDATE public.platform_job_runs SET lease_until=now()+interval '1 hour' WHERE id=$1",[f.job]);
      await expect(source(second).commitPage(competing)).rejects.toMatchObject({code:"input_conflict"});
      const fabricated={...f.page,pagePacketId:randomUUID()};await expect(source(second).commitPage(fabricated)).rejects.toMatchObject({code:"input_conflict"});
      await db.query(rail==="managed"?"UPDATE public.platform_job_runs SET lease_expires_at=now()-interval '1 hour' WHERE id=$1":"UPDATE public.platform_job_runs SET lease_until=now()-interval '1 hour' WHERE id=$1",[f.job]);
      expect(await source(first).commitPage(f.page)).toEqual({...applied,outcome:"replayed"});
      expect(await source(first).recordCapture(f.capture)).toMatchObject({ingest:{status:"received"}});
    }finally{for(const connection of [first,second])await connection.query("ROLLBACK");if(revoker){await revoker.query("ROLLBACK");revoker.release();}for(const connection of [first,second,browser])connection.release();await Promise.all([firstPool,secondPool,browserPool].map(connection=>connection.end()));}
  },30_000);

});
