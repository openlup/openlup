import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PgGatewayClient } from "@openlup/platform/data";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { channelBundleBindingSchema, channelPurchaseCaptureSchema } from "@openlup/platform/channels";
import { canonicalChannelSource, channelSourceDigest, type ChannelHistoricalBundleReadPort } from "@openlup/platform/channels/server";
import { channelPurchaseFixture } from "../helpers/channelPurchaseFixture.js";
import { channelManagedIngestFixture } from "../helpers/channelManagedIngestFixture.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { createM17ChannelReferenceBinding } from "../../server/runtime/public-reference/m17ChannelBinding.js";

type ManagedInput = Extract<Parameters<typeof createM17ChannelReferenceBinding>[1], { rail: "managed" }>;

/** Host read-only projection of imported facts; never an active-catalog or qualification writer. */
function historicalBundles(db: PoolClient): ChannelHistoricalBundleReadPort {
  return { async read(bundleId) {
    const row = (await db.query(`SELECT id,code,composition_digest,
      to_char(composition_locked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') locked_at,
      fulfillment_mode,composition_constraint FROM public.catalog_bundles WHERE id=$1`, [bundleId])).rows[0];
    if (!row) return null;
    const components = (await db.query(`SELECT c.catalog_sku_id,s.sku,c.quantity,c.is_addon
      FROM public.catalog_bundle_components c JOIN public.catalog_skus s ON s.id=c.catalog_sku_id
      WHERE c.bundle_id=$1 ORDER BY c.sort_order,c.catalog_sku_id`, [bundleId])).rows;
    return channelBundleBindingSchema.parse({ bundleId: row.id, code: row.code, compositionDigest: row.composition_digest,
      lockedAt: row.locked_at, fulfillmentMode: row.fulfillment_mode, constraintRef: row.composition_constraint?.type ?? null,
      components: components.map(value => ({ skuId: value.catalog_sku_id, skuCode: value.sku, quantity: value.quantity, isAddon: value.is_addon })) });
  } };
}

/** Only the existing managed channel embed/.not syntax is adapted to the local pg shim. */
function managedClient(db: PoolClient, f: Awaited<ReturnType<typeof channelPurchaseFixture>>) {
  const gateway = new PgGatewayClient({ async query(sql, args) {
    const result = await f.asRole("service_role", () => db.query(sql, [...(args ?? [])]));
    return { rows: result.rows.map(row => "exposure_generation" in row ? { ...row, exposure_generation: Number(row.exposure_generation) } : row) };
  } });
  return { rpc: f.rpc, from(table: string) {
    const query = gateway.from(table), select = query.select.bind(query), single = query.maybeSingle.bind(query);
    let embed = false;
    return Object.assign(query, {
      select(columns: string) {
        embed = table === "sales_channels" && columns.endsWith(", sales_channel_connections(connector_provider_kind)");
        return select(embed ? columns.replace(", sales_channel_connections(connector_provider_kind)", "") : columns);
      },
      not(column: string, operator: string, value: unknown) {
        if (table !== "channel_order_ingests" || column !== "purchase_capture_text" || operator !== "is" || value !== null) throw new Error("unexpected_reference_filter");
        return query.gt(column, "");
      },
      async maybeSingle() {
        const result = await single();
        if (!embed || !result.data) return result;
        const row = result.data as Record<string, unknown>;
        const connection = await gateway.from("sales_channel_connections").select("connector_provider_kind").eq("id", row.connection_id).maybeSingle();
        return { ...result, data: { ...row, sales_channel_connections: connection.data }, error: result.error ?? connection.error };
      },
    });
  } } as unknown as ManagedInput["client"];
}

describe("M17 unmounted managed reference on local compatibility PostgreSQL", () => {
  let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error("M17 reference proof requires Docker PostgreSQL");
    container = await runManagedCompatPostgres({ name: `m17-reference-${process.pid}`, password: "synthetic-reference-proof" });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("M17 reference PostgreSQL unavailable");
    pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 2 });
    db = await pool.connect();
    await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
    await db.query("SET ROLE postgres; SET search_path=public,extensions");
    for (const name of readdirSync("supabase/migrations").filter(value => /^\d{14}_.+\.sql$/u.test(value)).sort()) {
      await db.query(readFileSync(`supabase/migrations/${name}`, "utf8").replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
    }
    await db.query("RESET ROLE; SET row_security=on; SET search_path=public,extensions");
  }, postgresSetupTimeoutMs);
  afterEach(async () => { if (db) await db.query("ROLLBACK; RESET ROLE"); });
  afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

  async function fixture() {
    await db.query("BEGIN");
    const f = await channelPurchaseFixture(db, "managed"), owners = await channelManagedIngestFixture(db, f);
    const acknowledgeOrder = vi.fn().mockResolvedValue({ acknowledged: false });
    const normalizeWebhook = vi.fn().mockResolvedValue({ kind: "ignored", providerEventId: "synthetic:event", reason: "not_an_order" });
    const bundles = historicalBundles(db), client = managedClient(db, f);
    // This catalog binding is deliberately unread by retained ingest: current active facts cannot replace history.
    const bundleClient = { from() { throw new Error("active_catalog_must_not_resolve_retained_history"); } };
    const input: ManagedInput = { rail: "managed", actorId: f.actor, currentJobRunId: f.job,
      client, bundleClient, historicalBundles: bundles, acceptedCurrencies: ["EUR"], connector: { acknowledgeOrder, normalizeWebhook },
      webhook: { connectorKind: f.capture.scope.connectorKind, enabled: () => true, verifyToken: () => true, readRawBody: async () => "synthetic-body" } };
    const bound = createM17ChannelReferenceBinding(true, input);
    if (!bound || bound.rail !== "managed") throw new Error("managed_binding_missing");
    return { f, owners, bundles, input, bound, acknowledgeOrder, normalizeWebhook };
  }

  async function effectCounts() {
    return (await db.query(`SELECT
      (SELECT count(*)::int FROM public.channel_order_ingests) ledgers,
      (SELECT count(*)::int FROM public.outbox_events) events,
      (SELECT count(*)::int FROM public.commerce_orders) orders,
      (SELECT count(*)::int FROM public.commerce_order_items) items,
      (SELECT count(*)::int FROM public.inventory_reservations) holds,
      (SELECT count(*)::int FROM public.commerce_payment_intents) intents,
      (SELECT count(*)::int FROM public.commerce_payment_attempts) attempts,
      (SELECT count(*)::int FROM public.commerce_payments) payments,
      (SELECT count(*)::int FROM public.inbound_provider_events) paymentEvents,
      (SELECT sum(exposure_converted_units)::text FROM public.sales_channel_listings) converted`)).rows[0];
  }

  it("refuses conflicting accepted capture identities and values before ACK or another effect", async () => {
    const { f, owners, input, bound, acknowledgeOrder } = await fixture();
    await owners.stock(100);
    const first = (await bound.purchasedPage(f.page, [f.capture], new AbortController().signal)).outcomes[0];
    expect(first.kind).toBe("settled");
    const replay = createM17ChannelReferenceBinding(true, { ...input,
      historicalBundles: { async read() { throw new Error("accepted_replay_must_not_read_history"); } } });
    if (!replay || replay.rail !== "managed") throw new Error("managed_binding_missing");
    const contexts = vi.spyOn(replay.read, "contexts"), record = vi.spyOn(replay.source, "recordCapture");
    const original = vi.spyOn(replay.read, "original");
    const before = await effectCounts(), ackCount = acknowledgeOrder.mock.calls.length;
    const mutations: Record<string, (capture: typeof f.capture) => void> = {
      capture: value => { value.captureId = randomUUID(); },
      order: value => { value.externalOrderRef = value.normalized.externalOrderRef = "sale:conflict"; },
      revision: value => { value.externalOrderRevision = value.normalized.externalOrderRevision = "revision:conflict"; },
      payment: value => { value.normalized.payment.externalPaymentRef = "collection:conflict"; },
      sourceDigest: value => { value.rawSourceDigest = value.normalized.payloadDigest = channelSourceDigest("conflict:source"); },
      body: value => { value.normalized.buyer.firstName = "Élodie"; },
      products: value => { value.products[0].products[0].externalProductRef = "product:conflict"; },
      rows: value => { value.retainedRows![0].retained.firstApprovalId = randomUUID(); },
      execution: value => { value.execution.jobRunId = randomUUID(); },
      page: value => { value.pagePacketRef = randomUUID(); },
      time: value => { value.capturedAt = "2026-02-12T07:21:00Z"; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const conflict = structuredClone(f.capture);
      mutate(conflict);
      conflict.normalizedDigest = channelSourceDigest(canonicalChannelSource(conflict.normalized));
      expect(channelPurchaseCaptureSchema.safeParse(conflict).success, name).toBe(true);
      await expect(replay.consume(conflict, new AbortController().signal), name).rejects.toMatchObject({ code: "input_conflict" });
      expect(acknowledgeOrder, name).toHaveBeenCalledTimes(ackCount);
      expect(await effectCounts(), name).toEqual(before);
    }
    expect(contexts).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(original).not.toHaveBeenCalled();
  });

  it("replays exact captures and accepted aliases using original IDs/payment without current history", async () => {
    const { f, owners, input, bound, acknowledgeOrder } = await fixture();
    await owners.stock(100);
    const incoming = structuredClone(f.capture); delete incoming.retainedRows;
    const first = (await bound.purchasedPage(f.page, [incoming], new AbortController().signal)).outcomes[0];
    if (first.kind !== "settled") throw new Error("initial_capture_not_settled");
    const original = await bound.read.original(first.ledgerId);
    expect(original.retainedRows).toHaveLength(3);
    const alias = structuredClone(original);
    alias.captureId = randomUUID(); alias.providerEventId = alias.normalized.providerEventId = "delivery:alias";
    alias.externalOrderRef = alias.normalized.externalOrderRef = "sale:alias";
    alias.externalOrderRevision = alias.normalized.externalOrderRevision = "revision:alias";
    alias.rawSourceDigest = alias.normalized.payloadDigest = channelSourceDigest("alias:source");
    alias.pagePacketRef = randomUUID();
    alias.normalizedDigest = channelSourceDigest(canonicalChannelSource(alias.normalized));
    const page = structuredClone(f.page);
    page.pagePacketId = alias.pagePacketRef; page.expected = f.page.next; page.request.from = f.page.next.cursor;
    page.events = [{ ...page.events[0], providerEventId: alias.providerEventId, externalOrderRef: alias.externalOrderRef,
      externalOrderRevision: alias.externalOrderRevision, captureRef: alias.captureId, rawSourceDigest: alias.rawSourceDigest }];
    page.observedHead = { ...page.observedHead!, providerEventId: alias.providerEventId };
    page.next = { ...page.next, cursor: alias.providerEventId, generation: 2 };
    await bound.source.recordPage(page);
    await expect(bound.source.recordCapture(alias)).resolves.toMatchObject({ ingest: { id: first.ledgerId } });
    expect(await bound.source.readCapture({ channelId: alias.scope.channelId, providerEventId: alias.providerEventId,
      actorId: f.actor })).toEqual({ ledgerId: first.ledgerId, capture: alias });
    const replay = createM17ChannelReferenceBinding(true, { ...input,
      historicalBundles: { async read() { throw new Error("accepted_replay_must_not_read_history"); } } });
    if (!replay || replay.rail !== "managed") throw new Error("managed_binding_missing");
    const contexts = vi.spyOn(replay.read, "contexts"), record = vi.spyOn(replay.source, "recordCapture");
    const before = await effectCounts();
    const paymentBefore = (await db.query("SELECT id,payment_id,active_attempt_id,provider_payment_id,amount_cents,currency FROM public.commerce_payment_intents WHERE order_id=$1", [first.orderId])).rows;
    expect(paymentBefore).toEqual([expect.objectContaining({ provider_payment_id: incoming.normalized.payment.externalPaymentRef,
      amount_cents: incoming.normalized.totals.grandTotalMinor, currency: incoming.normalized.currency })]);
    const aliasWithoutRows = structuredClone(alias); delete aliasWithoutRows.retainedRows;
    for (const capture of [incoming, original, alias, aliasWithoutRows]) {
      await expect(replay.consume(capture, new AbortController().signal)).resolves.toEqual({ kind: "replayed",
        ledgerId: first.ledgerId, orderId: first.orderId });
      expect(acknowledgeOrder).toHaveBeenLastCalledWith(expect.objectContaining({ externalOrderRef: incoming.externalOrderRef,
        localOrderRef: first.orderId }));
      expect(await effectCounts()).toEqual(before);
      expect((await db.query("SELECT id,payment_id,active_attempt_id,provider_payment_id,amount_cents,currency FROM public.commerce_payment_intents WHERE order_id=$1", [first.orderId])).rows).toEqual(paymentBefore);
    }
    expect(await replay.read.original(first.ledgerId)).toEqual(original);
    expect((await db.query("SELECT payment_intent_id FROM public.channel_order_ingests WHERE id=$1", [first.ledgerId])).rows[0].payment_intent_id).not.toBeNull();
    expect(contexts).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("reads actual locked history, captures all before CAS, settles original groups and keeps false-ACK debt", async () => {
    const { f, owners, bundles, bound, acknowledgeOrder, input } = await fixture();
    await owners.stock(100);
    await db.query("ALTER TABLE public.catalog_bundles DISABLE TRIGGER channel_retained_bundle_guard");
    await db.query("UPDATE public.catalog_bundles SET composition_locked_at='2026-02-10T10:12:00.123456Z',status='archived' WHERE id=$1", [f.context.bundle.bundleId]);
    await db.query("ALTER TABLE public.catalog_bundles ENABLE TRIGGER channel_retained_bundle_guard");
    expect(await bundles.read(f.context.bundle.bundleId)).toEqual({ ...f.context.bundle, lockedAt: "2026-02-10T10:12:00.123456Z" });
    const capture = structuredClone(f.capture); delete capture.retainedRows;
    capture.normalized.payment.paidAt = "2026-02-12T07:13:17.234567Z";
    capture.normalizedDigest = channelSourceDigest(canonicalChannelSource(capture.normalized));
    const calls: string[] = [], rpc = bound.source;
    for (const name of ["recordPage", "recordCapture", "commitPage"] as const) {
      const original = rpc[name].bind(rpc);
      vi.spyOn(rpc, name).mockImplementation(((value: never) => { calls.push(name); return original(value); }) as never);
    }
    const second = structuredClone(capture);
    second.captureId = randomUUID(); second.providerEventId = "delivery:second"; second.externalOrderRef = "sale:second";
    second.normalized.providerEventId = second.providerEventId; second.normalized.externalOrderRef = second.externalOrderRef;
    second.normalized.payment.externalPaymentRef = "collection:second";
    second.normalized.lines[0].externalLineRef = "line:second"; second.products[0].externalLineRef = "line:second";
    second.rawSourceDigest = channelSourceDigest("synthetic:second"); second.normalized.payloadDigest = second.rawSourceDigest;
    second.normalizedDigest = channelSourceDigest(canonicalChannelSource(second.normalized));
    const page = structuredClone(f.page);
    page.events.push({ ...page.events[0], captureRef: second.captureId, providerEventId: second.providerEventId,
      externalOrderRef: second.externalOrderRef, rawSourceDigest: second.rawSourceDigest });
    page.observedHead = { ...page.observedHead!, providerEventId: second.providerEventId };
    page.next.cursor = second.providerEventId;
    const result = await bound.purchasedPage(page, [capture, second], new AbortController().signal)
      .catch(error => { throw new Error(JSON.stringify(f.failures), { cause: error }); });
    expect(calls).toEqual(["recordPage", "recordCapture", "recordCapture", "commitPage"]);
    expect(result.receipt.outcome).toBe("applied");
    expect(result.outcomes.map(value => value.kind)).toEqual(["settled", "settled"]);
    const outcome = result.outcomes[0];
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") throw new Error(JSON.stringify(f.failures));
    expect((await db.query("SELECT status,purchase_capture_text FROM public.channel_order_ingests WHERE id=$1", [outcome.ledgerId])).rows[0]).toMatchObject({ status: "settled" });
    const original = await bound.read.original(outcome.ledgerId);
    expect(original.normalized).toEqual(capture.normalized);
    expect(original.retainedRows).toHaveLength(3);
    expect((await db.query("SELECT quantity,total_cents,discount_allocated_cents FROM public.commerce_order_items WHERE order_id=$1 ORDER BY allocation_ordinal", [outcome.orderId])).rows.map(row => [row.quantity, row.total_cents, row.discount_allocated_cents])).toEqual([[1,4,2],[1,3,1],[1,2,1]]);
    expect((await db.query("SELECT count(*)::int n FROM public.inventory_reservations WHERE order_id=$1 AND status='reserved'", [outcome.orderId])).rows[0].n).toBe(3);
    expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1", [outcome.orderId])).rows[0].n).toBe(1);
    expect(acknowledgeOrder).toHaveBeenCalledWith(expect.objectContaining({ connectionRef: capture.scope.connectionId, externalOrderRef: capture.externalOrderRef, localOrderRef: outcome.orderId }));
    expect(bound.readiness).toEqual({ sourceCapture: true, settledIngest: true, privacyLifecycle: "unavailable", jobs: "unavailable", simulator: false });
    // A fresh live run consumes the old execution's debt after discovery and current catalog stop.
    const currentJob = randomUUID();
    await db.query("INSERT INTO public.platform_job_runs(id,job_name,trigger_source,driver,lease_owner,lease_expires_at) SELECT $1,job_name,trigger_source,driver,lease_owner,now()+interval '1 hour' FROM public.platform_job_runs WHERE id=$2", [currentJob, f.job]);
    await db.query("UPDATE public.platform_job_controls SET enabled=false,lease_token=$1 WHERE job_name='channel-order-pull'", [currentJob]);
    await db.query("UPDATE public.platform_job_runs SET lease_expires_at=now()-interval '1 hour' WHERE id=$1", [f.job]);
    await db.query("UPDATE public.sales_channels SET status='disabled' WHERE id=$1", [capture.scope.channelId]);
    const fresh = createM17ChannelReferenceBinding(true, { ...input,
      rail: "managed" as const, actorId: f.actor, currentJobRunId: currentJob, client: managedClient(db, f),
      bundleClient: { from() { throw new Error("active_catalog_unavailable"); } }, historicalBundles: { async read() { throw new Error("history_already_captured"); } },
      acceptedCurrencies: ["EUR"], connector: { normalizeWebhook: vi.fn(), acknowledgeOrder: acknowledgeOrder.mockResolvedValue({ acknowledged: true }) },
      webhook: { connectorKind: capture.scope.connectorKind, enabled: () => false, verifyToken: () => false, readRawBody: async () => "" },
    });
    if (!fresh || fresh.rail !== "managed") throw new Error("fresh_binding_missing");
    const recovered = await fresh.recover(capture.scope.channelId, new AbortController().signal);
    expect(recovered).toHaveLength(2);
    expect(recovered).toEqual(expect.arrayContaining([
      { outcome: { kind: "replayed", ledgerId: outcome.ledgerId, orderId: outcome.orderId } },
    ]));
    expect(recovered.every(value => "outcome" in value && value.outcome.kind === "replayed")).toBe(true);
    expect((await db.query("SELECT status FROM public.channel_order_ingests WHERE id=$1", [outcome.ledgerId])).rows[0].status).toBe("done");
    expect(await fresh.read.pending(capture.scope.channelId)).toEqual([]);
    expect((await db.query("SELECT count(*)::int n FROM public.commerce_payment_intents WHERE order_id=$1", [outcome.orderId])).rows[0].n).toBe(1);
  });

  it("recovers blocked stock through a new live job while preserving original execution", async () => {
    const { f, owners, input, bound, acknowledgeOrder } = await fixture();
    await owners.stock(5);
    const first = await bound.purchasedPage(f.page, [f.capture], new AbortController().signal);
    expect(first.outcomes[0]).toMatchObject({ kind: "blocked_stock" });
    expect(acknowledgeOrder).not.toHaveBeenCalled();
    const currentJob = randomUUID();
    await db.query("INSERT INTO public.platform_job_runs(id,job_name,trigger_source,driver,lease_owner,lease_expires_at) SELECT $1,job_name,trigger_source,driver,lease_owner,now()+interval '1 hour' FROM public.platform_job_runs WHERE id=$2", [currentJob, f.job]);
    await db.query("UPDATE public.platform_job_controls SET lease_token=$1 WHERE job_name='channel-order-pull'", [currentJob]);
    await db.query("UPDATE public.platform_job_runs SET lease_expires_at=now()-interval '1 hour' WHERE id=$1", [f.job]);
    await db.query("UPDATE public.sales_channels SET status='disabled' WHERE id=$1", [f.capture.scope.channelId]);
    await owners.stock(100);
    const recovered = createM17ChannelReferenceBinding(true, { ...input, currentJobRunId: currentJob,
      historicalBundles: { async read() { throw new Error("retained_history_must_not_be_rebound"); } },
      webhook: { ...input.webhook, enabled: () => false },
    });
    if (!recovered || recovered.rail !== "managed") throw new Error("managed_binding_missing");
    const results = await recovered.recover(f.capture.scope.channelId, new AbortController().signal);
    expect(results).toEqual([{ outcome: expect.objectContaining({ kind: "settled" }) }]);
    const ledgerId = (await db.query("SELECT id FROM public.channel_order_ingests WHERE channel_id=$1", [f.capture.scope.channelId])).rows[0].id;
    expect((await recovered.read.original(ledgerId)).execution).toEqual({ actorId: f.actor, jobRunId: f.job });
    expect((await db.query("SELECT status FROM public.channel_order_ingests WHERE id=$1", [ledgerId])).rows[0].status).toBe("settled");
    expect(acknowledgeOrder).toHaveBeenCalledTimes(1);
  });

  it("records unresolved source without CAS consumption or guessed physical rows", async () => {
    const { f, input } = await fixture();
    const bound = createM17ChannelReferenceBinding(true, { ...input, historicalBundles: { async read() { return null; } } });
    if (!bound || bound.rail !== "managed") throw new Error("managed_binding_missing");
    const capture = structuredClone(f.capture); delete capture.retainedRows;
    await expect(bound.purchasedPage(f.page, [capture], new AbortController().signal)).rejects.toMatchObject({ reason: "channel_purchase_retained_rows_unavailable" });
    expect((await db.query("SELECT status,order_id FROM public.channel_order_ingests WHERE channel_id=$1", [capture.scope.channelId])).rows).toEqual([{ status: "received", order_id: null }]);
    expect((await bound.source.readPage({ connectionId: f.page.scope.connectionId, pagePacketId: f.page.pagePacketId,
      actorId: f.actor, inputDigest: channelSourceDigest(canonicalChannelSource(f.page)) }))?.cursorReceipt).not.toBeNull();
  });

  it("exposes the existing webhook callable with method/token/body admission and no mounted route", async () => {
    const { bound, normalizeWebhook } = await fixture();
    const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await bound.webhook({ method: "GET", headers: {}, query: {} } as HttpRequest, response as unknown as HttpResponse);
    expect(normalizeWebhook).not.toHaveBeenCalled();
    await bound.webhook({ method: "POST", headers: {}, query: {} } as HttpRequest, response as unknown as HttpResponse);
    expect(normalizeWebhook).toHaveBeenCalledWith(expect.objectContaining({ rawBody: "synthetic-body" }));
    expect(response.json).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, data: expect.objectContaining({ status: "ignored" }) }));
    expect(bound).not.toHaveProperty("routes");
    expect(bound).not.toHaveProperty("jobs");
  });
});
