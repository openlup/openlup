import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPlatformPostgresMigrationRunner, qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions, type PlatformPostgresInstallation } from "@openlup/platform/migrations";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { noticeSessionWithRecipientFault } from "./m19NoticeFixture.js";
import { captureConnectedNativeStore, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresLifecycleMessages } from "@openlup/platform/subscriptions";
import { createPostgresTransactionalDeliveryStore, createTransactionalDelivery } from "@openlup/platform/communications";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

// Install the committed catalogue through the real runner, including this suffix.
const candidate = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const files = new Map<string, string>();
function collect(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (typeof row.file === "string" && typeof row.sha256 === "string") files.set(row.file, row.sha256);
  for (const child of Object.values(row)) collect(child);
}
collect(candidate);
for (const [file, digest] of files) {
  const content = readFileSync(file, "utf8");
  if (createHash("sha256").update(content).digest("hex") !== digest) throw new Error(`prefix hash mismatch: ${file}`);
}

const noticeHistory = `SELECT id,subscription_id,event_type,payload FROM public.subscription_events
  UNION ALL SELECT id,aggregate_id,event_type,payload FROM public.outbox_events WHERE aggregate_type='subscription_notice'`;
const password = "synthetic-conformance";
async function install(connectionString: string, installation: PlatformPostgresInstallation) {
  const pool = new Pool({ connectionString, options: installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation)
    : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined });
  try { await createPlatformPostgresMigrationRunner({ connectionString }, { installation, poolFactory: () => pool }).apply(); }
  finally { await pool.end(); }
}

for (const generation of ["legacy", "qualified-v2"] as const) describe(`notice producers: ${generation}`, () => {
  let container: PostgresContainer | undefined, admin: Pool, runtime: Pool, runtimeUrl: string;
  beforeAll(async () => {
    container = await runPostgresContainer({ name: `notice-producers-${generation}-${process.pid}`, password });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Notice producer PostgreSQL unavailable");
    admin = new Pool({ connectionString: container.connectionString });
    let installation: PlatformPostgresInstallation = { generation: "legacy" };
    if (generation === "qualified-v2") {
      for (const role of ["notice_runtime", "notice_restore"]) await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      installation = { generation, roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "notice_runtime", restoreLogin: "notice_restore" };
    }
    await install(container.connectionString, installation);
    const product = randomUUID();
    await admin.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'notice-refill','Refill')", [product]);
    await admin.query("INSERT INTO public.catalog_skus(product_id,sku,title,sellable_in_subscription) VALUES($1,'NOTICE-REFILL','Refill',true)", [product]);
    const endpoint = new URL(container.connectionString);
    if (generation === "qualified-v2") { endpoint.username = "notice_runtime"; endpoint.password = password; }
    runtimeUrl = endpoint.toString(); runtime = new Pool({ connectionString: runtimeUrl });
    if (generation === "qualified-v2") expect((await runtime.query("SELECT rolsuper OR rolbypassrls AS elevated FROM pg_roles WHERE rolname=current_user")).rows[0].elevated).toBe(false);
  }, postgresSetupTimeoutMs);
  afterAll(async () => { await closePostgres(container, [runtime, admin].filter(Boolean)); }, postgresTeardownTimeoutMs);
  beforeEach(async () => { await admin.query("UPDATE public.subscriptions SET status='cancelled'"); });

  async function subscription(health: string | null = "healthy", status = "active", ahead = 4) {
    const client = randomUUID(), id = randomUUID();
    await admin.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
    await admin.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,status,next_cycle_at,updated_at)
      VALUES($1,$2,14,$3,now()+make_interval(days=>$4),now()-interval '6 days')`, [id, client, status, ahead]);
    if (health) await admin.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,$2)", [id, health]);
    return { id, client };
  }
  async function enqueue() { await runtime.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)"); }
  async function count(id: string) { return Number((await admin.query("SELECT count(*) FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [id])).rows[0].count); }
  async function caseFor() {
    const s = await subscription("healthy", "active", 90), id = randomUUID();
    await admin.query(`INSERT INTO public.subscription_dunning_cases(id,subscription_id,client_id,idempotency_key)
      VALUES($1,$2,$3,$4)`, [id, s.id, s.client, `case:${id}`]);
    return { ...s, caseId: id };
  }
  async function customerNotice(caseId: string, attempt = 1) {
    return (await runtime.query("SELECT public.dunning_lifecycle_queue_notice($1::uuid,'payment_failed','subscription-payment-failed-1',$2,NULL) AS id", [caseId.toUpperCase(), attempt])).rows[0].id;
  }

  // Retained event facts are secondary compatibility; the actual base ledger writers run in the prefix-upgrade test below.
  it("retains reminder identities, frozen event facts and accepted receipts across the carrier change", async () => {
    const queued = await subscription(), sent = await subscription();
    const queuedId = randomUUID(), sentId = randomUUID();
    for (const [subject, id] of [[queued, queuedId], [sent, sentId]] as const) {
      await admin.query(`INSERT INTO public.subscription_reminder_ledger(id,subscription_id,reminder_kind,reminder_day)
        SELECT $1,$2,'renewal_due_soon',(next_cycle_at AT TIME ZONE 'UTC')::date FROM public.subscriptions WHERE id=$2`, [id, subject.id]);
      await admin.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
        SELECT id,'subscription.reminder.renewal_facts','renewal-reminder:'||to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD'),
          jsonb_build_object('renewalAt',to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
        FROM public.subscriptions WHERE id=$1`, [subject.id]);
    }
    const legacyFacts = (await admin.query("SELECT payload FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.reminder.renewal_facts'", [queued.id])).rows[0].payload;
    await runtime.query("SELECT public.transactional_delivery_record_accepted($1,$2,'captured:legacy-reminder')", [`subscription-notice:reminder:${sentId}`, "a".repeat(64)]);
    const receipts = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
    const bound: string[] = [], sentKeys: string[] = [];
    const delivery = createTransactionalDelivery({ store: receipts, delivery: { async deliver(command) {
      sentKeys.push(command.idempotencyKey); return { deliveryReference: `captured:${command.idempotencyKey}` };
    } } });
    const worker = createPostgresLifecycleMessages({
      async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
      bind: async notice => {
        expect(notice.subscriptionId).toBe(queued.id);
        expect(notice.payload.renewalAt).toBe(legacyFacts.renewalAt);
        bound.push(notice.subscriptionId);
        return { recipientReference: `client:${queued.client}`, templateReference: notice.templateSlug };
      },
      delivery: { readReceipt: receipts.readReceipt, send: delivery.send },
    });
    try { await worker.run(100); await worker.run(100); } finally { await receipts.close(); }
    expect(bound).toHaveLength(1);
    expect(sentKeys).toEqual([`subscription-notice:reminder:${queuedId}`]);
    expect((await admin.query("SELECT id,subscription_id,renewal_at FROM public.subscription_reminder_ledger WHERE subscription_id=ANY($1::uuid[]) ORDER BY subscription_id", [[queued.id, sent.id]])).rows)
      .toEqual([{ id: queuedId, subscription_id: queued.id, renewal_at: null }, { id: sentId, subscription_id: sent.id, renewal_at: null }].sort((a,b) => a.subscription_id.localeCompare(b.subscription_id)));
    expect((await admin.query("SELECT payload FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.reminder.renewal_facts'", [queued.id])).rows[0].payload).toEqual(legacyFacts);
  }, 30000);

  async function markedPurchase(hasMarker = true) {
    const client = randomUUID(), order = randomUUID(), activation = randomUUID();
    const paidAt = new Date(Date.now() - 100 * 86400000).toISOString();
    // Synthetic paid evidence is fixture setup. The actual activation writer
    // allocates the subscription and its paid cycle; no cycle row is inserted here.
    await admin.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
    await admin.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'paid','XXX',0)", [order, client]);
    await admin.query("INSERT INTO public.subscription_activations(id,order_id,client_id,cadence_days,declare_idempotency_key) VALUES($1,$2,$3,14,$4)", [activation, order, client, `declare:${activation}`]);
    const id = (await admin.query(`SELECT (public.subscription_activation_commit(a,$2,$3,$4::timestamptz,false)).subscription_id AS id
      FROM public.subscription_activations a WHERE a.id=$1::uuid`, [activation, `activate:${activation}`, "a".repeat(64), paidAt])).rows[0].id;
    const retained = { version: "native.renewal-terms.v1", minimumPayableMinor: 1, normalCadenceDays: [14],
      starterPack: { schemaVersion: "1", starterIntervalDays: 14, basisTemplateVersion: 1,
        delivery2: { discountBps: 0, discountMinor: 0, basisSubtotalMinor: 100 },
        graduation: { cadenceDays: 14, lines: [{ sku: "NOTICE-REFILL", qty: 1, sortOrder: 0, isAddon: false,
          quoteLine: { unitPriceGross: { amountMinor: 100 }, lineSubtotalGross: { amountMinor: 100 } } }] } } };
    const facts = { settlementChannelKey: "sandbox", authorizationRef: "sandbox:authorization", unattendedChargeAuthorizedAt: paidAt,
      payerAccountRef: null, methodRef: "sandbox:method", methodEvidenceRef: "sandbox:evidence", stockSourceKey: "notice-stock",
      templateId: "notice-refill", cadenceDays: 14, currency: "XXX", shippingAmountMinor: 0, acquisitionRef: null,
      lines: [{ lineOrdinal: 1, sku: "NOTICE-REFILL", quantity: 1, unitAmountMinor: 100 }], ...(hasMarker ? { renewalTerms: retained } : {}) };
    await runtime.query("SELECT public.subscription_register_renewal_purchase_with_shipping($1::uuid,$2::jsonb)", [order.toUpperCase(), JSON.stringify(facts)]);
    await runtime.query("SELECT public.subscription_complete_renewal_attachment($1::uuid)", [order.toUpperCase()]);
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '4 days',updated_at=now()-interval '2 days' WHERE id=$1", [id]);
    return { id, client, order };
  }

  async function capture(owner: Pool, sourceId: string): Promise<ConnectedNativeStoreCapture> {
    const selected = selectPlatformMigrationManifest(candidate, "qualified-v2", { migrationIsBootstrap: true, hasRestore: true });
    return captureConnectedNativeStore({ sourceId, catalogueId: selected.objectInventorySha256, maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
      source: { async withSnapshot(work) {
        const db = await owner.connect();
        try {
          await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const result = await work({ query: (sql, values) => db.query(sql, values ? [...values] : undefined) });
          await db.query("COMMIT"); return result;
        } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
      } } });
  }

  it.skipIf(generation === "legacy")("preserves the marked cycle census through complete native transfer and refuses a non-pristine target", async () => {
    expect((await admin.query("SELECT count(*) AS n FROM public.communication_delivery_controls")).rows[0].n).toBe("0");
    expect((await admin.query("SELECT count(*) AS n FROM public.notification_recipients")).rows[0].n).toBe("0");
    const s = await markedPurchase(), packet = await capture(admin, "notice-marked-source");
    const target = await runPostgresContainer({ name: `notice-restored-${process.pid}`, password });
    let owner: Pool | undefined;
    try {
      expect(await waitForPostgresTcpReady(target.connectionString)).toBe(true);
      owner = new Pool({ connectionString: target.connectionString });
      for (const role of ["notice_runtime", "notice_restore"]) await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const installation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "notice_runtime", restoreLogin: "notice_restore" } as const;
      await install(target.connectionString, installation);
      await owner.end();
      owner = new Pool({ connectionString: target.connectionString, options: qualifiedPostgresStartupOptions(installation) });
      const freshTarget = await capture(owner, "notice-pristine-target");
      await owner.query("INSERT INTO public.clients(email) VALUES('nonpristine@example.invalid')");
      await expect(restoreConnectedNativeStore({ owner, installation, packet, freshTarget })).rejects.toMatchObject({ code: "target_conflict" });
      // A fresh second target is necessary; never delete domain rows to manufacture pristine proof.
    } finally { await closePostgres(target, owner); }
    const clean = await runPostgresContainer({ name: `notice-restored-clean-${process.pid}`, password });
    let cleanOwner: Pool | undefined;
    try {
      expect(await waitForPostgresTcpReady(clean.connectionString)).toBe(true);
      cleanOwner = new Pool({ connectionString: clean.connectionString });
      for (const role of ["notice_runtime", "notice_restore"]) await cleanOwner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const installation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "notice_runtime", restoreLogin: "notice_restore" } as const;
      await install(clean.connectionString, installation);
      await cleanOwner.end();
      cleanOwner = new Pool({ connectionString: clean.connectionString, options: qualifiedPostgresStartupOptions(installation) });
      const freshTarget = await capture(cleanOwner, "notice-clean-target");
      expect(await restoreConnectedNativeStore({ owner: cleanOwner, installation, packet, freshTarget })).toMatchObject({ replayed: false });
      const before = (await admin.query("SELECT id,scheduled_at,status FROM public.subscription_cycles WHERE subscription_id=$1 ORDER BY id", [s.id])).rows;
      const after = (await cleanOwner.query("SELECT id,scheduled_at,status FROM public.subscription_cycles WHERE subscription_id=$1 ORDER BY id", [s.id])).rows;
      expect(after).toEqual(before);
      expect((await cleanOwner.query("SELECT public.subscription_renewal_purchase_terms($1::uuid) AS facts", [s.id])).rows[0].facts.renewalTerms.starterPack).toBeDefined();
      expect(after.length + 1).toBe(before.length + 1);
      await cleanOwner.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)");
      expect(Number((await cleanOwner.query("SELECT count(*) FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [s.id])).rows[0].count)).toBe(1);
    } finally { await closePostgres(clean, cleanOwner); }
    await admin.query("INSERT INTO public.notification_recipients(email,notification_type) VALUES('configured@example.invalid','commerce_payment_critical')");
    await expect(capture(admin, "notice-configured-source")).rejects.toThrow("postgres_transfer_unsupported_table:public.notification_recipients");
  }, 120000);

  async function allocateCycle(subscriptionId: string, ordinal: number, status: "paid" | "cancelled" | "skipped" | "planned" | "retry") {
    const operation = randomUUID(), token = randomUUID(), fingerprint = "b".repeat(64);
    const stamp = new Date(Date.now() + (status === "planned" ? ordinal * 14 : -90 + ordinal * 14) * 86400000).toISOString();
    const snapshot = { currency: "XXX", totalAmountMinor: 100, settlementChannelKey: "sandbox",
      lines: [{ sku: "NOTICE-REFILL", quantity: 1, unitAmountMinor: 100 }] };
    // Establish a valid reserved operation as fixture input; allocation/replay
    // goes through the installed renewal prepare writer, not a raw cycle INSERT.
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=$2::timestamptz WHERE id=$1", [subscriptionId, stamp]);
    const counter = Number((await admin.query("SELECT next_cycle_number FROM public.subscription_renewal_terms WHERE subscription_id=$1", [subscriptionId])).rows[0].next_cycle_number);
    await admin.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,identity_key,
      operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at)
      VALUES($1,$2,$3::timestamptz,$4,$5,$6,$7::jsonb,'reserved',$8,'notice-fixture',now(),now()+interval '1 hour')`,
    [operation, subscriptionId, stamp, counter, `notice-cycle:${subscriptionId}:${operation}`, fingerprint, JSON.stringify(snapshot), token]);
    await admin.query(`INSERT INTO public.fulfillment_inventory_reservations(renewal_operation_id,operation_fingerprint,source_key,expires_at)
      VALUES($1,$2,'notice-stock',now()+interval '1 hour')`, [operation, fingerprint]);
    const prepared = (await runtime.query("SELECT public.commerce_prepare_subscription_renewal($1::uuid,$2::uuid,now()) AS result", [operation.toUpperCase(), token.toUpperCase()])).rows[0].result;
    const replay = (await runtime.query("SELECT public.commerce_prepare_subscription_renewal($1::uuid,$2::uuid,now()) AS result", [operation, token])).rows[0].result;
    expect(replay.cycleId).toBe(prepared.cycleId);
    if (status === "paid") {
      await runtime.query("SELECT public.commerce_acknowledge_subscription_renewal_attempt($1,$2,$3,now())", [operation, fingerprint, `sandbox:attempt:${operation}`]);
      await runtime.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'succeeded',$4,NULL,now())", [operation, `paid:${operation}`, fingerprint, `sandbox:attempt:${operation}`]);
    } else if (status === "cancelled" || status === "skipped") {
      await runtime.query("SELECT public.commerce_record_subscription_renewal_outcome($1,$2,$3,'refused',NULL,'synthetic_decline',now())", [operation, `refused:${operation}`, fingerprint]);
      expect((await admin.query("SELECT status FROM public.subscription_cycles WHERE id=$1", [prepared.cycleId])).rows[0].status).toBe("payment_pending");
      // No native cancellation allocator creates this history. Preserve the
      // all-status boundary after actual allocation, without inventing a writer.
      await admin.query("UPDATE public.subscription_cycles SET status=$2 WHERE id=$1", [prepared.cycleId, status]);
    } else if (status === "retry") {
      const at = new Date().toISOString();
      const failure = { attemptSequence: 0, logicalCycleNumber: counter+1, occurredAt: at, firstRecordedAt: at,
        failureClass: "temporary", reason: "synthetic_decline", evidenceKey: `failure:${operation}` };
      await runtime.query("SELECT public.subscription_retry_apply_failure($1,$2,$3::jsonb)", [operation, `retry:${operation}`, JSON.stringify(failure)]);
      expect((await admin.query("SELECT state FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1", [operation])).rows[0].state).toBe("waiting");
      expect((await admin.query("SELECT status FROM public.subscription_cycles WHERE id=$1", [prepared.cycleId])).rows[0].status).toBe("payment_pending");
    } else {
      // There is no native future-plan allocator. Preserve its status/time
      // boundary as fixture state after actual cycle allocation.
      await admin.query("UPDATE public.subscription_cycles SET status='planned' WHERE id=$1", [prepared.cycleId]);
    }
  }

  it("uses the actual producer for all-status notice phases while unmarked histories retain ordinary freshness", async () => {
    for (const zone of ["UTC", "Etc/GMT-9", "Etc/GMT+5"]) {
      for (const hasMarker of [true, false]) {
        for (const history of ["paid1", "paid12", "paid123", "cancelled23", "skipped23", "future_planned23"]) {
          const s = await markedPurchase(hasMarker);
          const status = history.includes("planned") ? "planned" : history.includes("skipped") ? "skipped" : history.includes("23") && !history.startsWith("paid") ? "cancelled" : "paid";
          const extras = history === "paid1" ? 0 : history === "paid12" ? 1 : 2;
          for (let index = 0; index < extras; index++) await allocateCycle(s.id, index + 2, status);
          await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '4 days',updated_at=now()-interval '2 days' WHERE id=$1", [s.id]);
          const db = await runtime.connect();
          try {
            await db.query("SELECT set_config('TimeZone',$1,false)", [zone]);
            for (const days of [1, 5]) {
              await db.query("BEGIN");
              await db.query("UPDATE public.subscriptions SET updated_at=now()-make_interval(days=>$2) WHERE id=$1", [s.id, days]);
              await db.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)");
              const relaxed = hasMarker && extras < 2;
              expect(Number((await db.query("SELECT count(*) FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [s.id])).rows[0].count), `${zone}/${hasMarker}/${history}/exact${days}`).toBe(days === 5 && relaxed ? 1 : 0);
              await db.query("UPDATE public.subscriptions SET updated_at=updated_at-interval '1 microsecond' WHERE id=$1", [s.id]);
              await db.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)");
              expect(Number((await db.query("SELECT count(*) FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [s.id])).rows[0].count), `${zone}/${hasMarker}/${history}/older${days}`).toBe(days === 5 || relaxed ? 1 : 0);
              await db.query("ROLLBACK");
            }
            await db.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)");
          } finally { db.release(); }
          expect(await count(s.id), `${zone}/${hasMarker}/${history}`).toBe(hasMarker && extras < 2 ? 1 : 0);
          await admin.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [s.id]);
        }
      }
    }
  }, 120000);

  it("retains notice eligibility after a failed cycle and actual pause/resume/reschedule commands", async () => {
    const s = await markedPurchase(); await allocateCycle(s.id, 2, "cancelled");
    const pauseAt = new Date(Date.now() - 3 * 86400000).toISOString(), resumeAt = new Date(Date.now() - 2 * 86400000).toISOString();
    await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'pause','{}'::jsonb,$4::timestamptz)", [s.client, `pause:${s.id}`, s.id, pauseAt]);
    await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'resume','{}'::jsonb,$4::timestamptz)", [s.client, `resume:${s.id}`, s.id, resumeAt]);
    const next = new Date(Date.now() + 4 * 86400000).toISOString();
    await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'slide_next_cycle',$4::jsonb,$5::timestamptz)", [s.client, `slide:${s.id}`, s.id, JSON.stringify({ newNextCycleAt: next }), resumeAt]);
    await enqueue(); expect(await count(s.id)).toBe(1);
  }, 30000);

  it("applies starter freshness only to correlated retained purchase history and keeps strict boundaries in non-UTC sessions", async () => {
    for (const zone of ["UTC", "Etc/GMT-9", "Etc/GMT+5"]) {
      const s = await markedPurchase();
      await admin.query("UPDATE public.subscription_method_states SET health_state='mandate_not_chargeable_unattended' WHERE subscription_id=$1", [s.id]);
      const db = await runtime.connect();
      try {
        await db.query("SELECT set_config('TimeZone',$1,false)", [zone]);
        await db.query("BEGIN");
        await db.query("UPDATE public.subscriptions SET updated_at=now()-interval '1 day' WHERE id=$1", [s.id]);
        await db.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)");
        expect(Number((await db.query("SELECT count(*) FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [s.id])).rows[0].count)).toBe(0);
        await db.query("UPDATE public.subscriptions SET updated_at=updated_at-interval '1 microsecond' WHERE id=$1", [s.id]);
        await db.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)");
        expect(Number((await db.query("SELECT count(*) FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [s.id])).rows[0].count)).toBe(1);
        await db.query("ROLLBACK");
      } finally { db.release(); }
      await admin.query("UPDATE public.subscription_renewal_terms SET next_cycle_number=2 WHERE subscription_id=$1", [s.id]);
      await enqueue(); expect(await count(s.id)).toBe(0);
      await admin.query("UPDATE public.subscriptions SET updated_at=now()-interval '6 days' WHERE id=$1", [s.id]);
      await enqueue(); expect(await count(s.id)).toBe(1);
    }
  }, 60000);

  it("retained imports raise the notice phase and extra paid evidence falls back to standard freshness", async () => {
    if (generation === "legacy") {
      // This history has no retained-import SQL entry in the legacy selection.
      expect((await admin.query("SELECT to_regprocedure('public.subscription_cycle_import_retained_row(uuid,uuid,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,uuid,text)') AS fn")).rows[0].fn).toBeNull();
      return;
    }
    const endpoint = new URL(container!.connectionString); endpoint.username = "notice_restore"; endpoint.password = password;
    const restore = new Pool({ connectionString: endpoint.toString() });
    try {
      const s = await markedPurchase();
      for (let index = 0; index < 2; index++) {
        await restore.query("SELECT public.subscription_cycle_import_retained_row($1::uuid,$2::uuid,now()-interval '10 days','cancelled',now(),now(),NULL,NULL)", [randomUUID(), s.id.toUpperCase()]);
        expect(Number((await admin.query("SELECT count(*)+1 AS phase FROM public.subscription_cycles WHERE subscription_id=$1", [s.id])).rows[0].phase)).toBe(index + 3);
      }
      await enqueue(); expect(await count(s.id)).toBe(0);
      const paid = await markedPurchase();
      await restore.query("SELECT public.subscription_cycle_import_retained_row($1::uuid,$2::uuid,now()-interval '10 days','paid',now(),now(),NULL,NULL)", [randomUUID(), paid.id.toUpperCase()]);
      await enqueue(); expect(await count(paid.id)).toBe(0);
    } finally { await restore.end(); }
  }, 60000);

  it("selects active and mandate-unchargeable methods, excludes missing/pending/absent methods, and freezes the queued instant", async () => {
    const rows = await Promise.all(["healthy", "mandate_not_chargeable_unattended", "method_missing", "pending_activation", null].map(state => subscription(state)));
    await enqueue();
    expect(await Promise.all(rows.map(row => count(row.id)))).toEqual([1, 1, 0, 0, 0]);
    await enqueue(); expect(await count(rows[0].id)).toBe(1);
    const original = (await admin.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [rows[0].id])).rows[0].next_cycle_at;
    const facts = (await runtime.query("SELECT id,renewal_at FROM public.subscription_reminder_ledger WHERE subscription_id=$1::uuid", [rows[0].id.toUpperCase()])).rows[0];
    expect(facts.renewal_at.getTime()).toBe(original.getTime());
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 day' WHERE id=$1", [rows[0].id]);
    expect(facts.renewal_at).toEqual((await runtime.query("SELECT renewal_at FROM public.subscription_reminder_ledger WHERE id=$1::uuid", [facts.id])).rows[0].renewal_at);
    await enqueue(); expect(await count(rows[0].id)).toBe(2);
  });

  it("applies the charge window, strict ordinary freshness and open-cycle exclusions before insertion", async () => {
    const early = await subscription("healthy", "active", 2), late = await subscription("healthy", "active", 6);
    const fresh = await subscription(), pending = await subscription(), retry = await markedPurchase(false);
    await allocateCycle(retry.id, 2, "retry");
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '4 days',updated_at=now()-interval '6 days' WHERE id=$1", [retry.id]);
    await admin.query("UPDATE public.subscriptions SET updated_at=now()-interval '5 days' WHERE id=$1", [fresh.id]);
    for (const [id, state] of [[pending.id, "payment_pending"]]) {
      await admin.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,now(),$2)", [id, state]);
    }
    // Freeze transaction time so equality at the strict freshness boundary is exact.
    const db = await runtime.connect();
    try {
      await db.query("BEGIN"); await db.query("UPDATE public.subscriptions SET updated_at=now()-interval '5 days' WHERE id=$1", [fresh.id]);
      await db.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)");
      expect(Number((await db.query("SELECT count(*) FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [fresh.id])).rows[0].count)).toBe(0);
      await db.query("ROLLBACK");
    } finally { db.release(); }
    await enqueue();
    expect(await Promise.all([early, late, pending, retry].map(row => count(row.id)))).toEqual([0, 0, 0, 0]);
  });

  it("keeps inclusive renewal time edges and limits at-risk candidates before open-case suppression", async () => {
    const lower = await subscription(), upper = await subscription(), outside = await subscription();
    const db = await runtime.connect();
    try {
      await db.query("BEGIN");
      for (const [sample, offset] of [[lower, "3 days"], [upper, "5 days"], [outside, "5 days 0.000001 seconds"]] as const)
        await db.query("UPDATE public.subscriptions SET next_cycle_at=now()+$2::interval WHERE id=$1", [sample.id, offset]);
      await db.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100)");
      for (const [sample, expected] of [[lower, 1], [upper, 1], [outside, 0]] as const)
        expect(Number((await db.query("SELECT count(*) FROM public.subscription_reminder_ledger WHERE subscription_id=$1", [sample.id])).rows[0].count)).toBe(expected);
      await db.query("ROLLBACK");
    } finally { db.release(); }
    const hidden = await caseFor(), later = await subscription("method_missing", "active", 4);
    await admin.query("UPDATE public.subscription_method_states SET health_state='method_missing' WHERE subscription_id=$1", [hidden.id]);
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '3 days' WHERE id=$1", [hidden.id]);
    expect((await runtime.query("SELECT * FROM public.dunning_lifecycle_scan_at_risk_service(2,5,1)")).rows).toHaveLength(0);
    expect((await runtime.query("SELECT * FROM public.dunning_lifecycle_scan_at_risk_service(2,5,2)")).rows.map(row => row.subscription_id)).toEqual([later.id]);
    if (generation === "qualified-v2") await expect(runtime.query("SELECT * FROM public.dunning_lifecycle_scan_at_risk(2,5,2)"))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for function dunning_lifecycle_scan_at_risk" });
    await admin.query("UPDATE public.subscription_method_states SET narrow_activation_gap=true WHERE subscription_id=$1", [later.id]);
    expect((await runtime.query("SELECT * FROM public.dunning_lifecycle_scan_at_risk_service(2,5,100)")).rows).toHaveLength(0);
  }, 30000);

  it("uses atomic pause-window identity across connections and edits, and permits separate windows on the same end day", async () => {
    const s = await subscription("healthy", "paused"), w = randomUUID();
    await admin.query("INSERT INTO public.subscription_pause_windows(id,subscription_id,pause_preset,starts_at,ends_at,idempotency_key) VALUES($1,$2,'2_weeks',now()-interval '2 days',now()+interval '2 days',$3)", [w, s.id, `pause:${w}`]);
    const other = new Pool({ connectionString: runtimeUrl });
    try { await Promise.all([runtime.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100)"), other.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100)")]); }
    finally { await other.end(); }
    expect((await admin.query(`SELECT payload FROM (${noticeHistory}) n WHERE subscription_id=$1 AND event_type='subscription.pause_reminder_due'`, [s.id])).rows).toHaveLength(1);
    await admin.query("UPDATE public.subscription_pause_windows SET ends_at=ends_at+interval '1 hour' WHERE id=$1", [w]);
    await runtime.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100)");
    expect((await admin.query(`SELECT id FROM (${noticeHistory}) n WHERE subscription_id=$1 AND event_type='subscription.pause_reminder_due'`, [s.id])).rows).toHaveLength(1);
    await admin.query("UPDATE public.subscription_pause_windows SET resumed_at=now() WHERE id=$1", [w]);
    const next = randomUUID();
    await admin.query("INSERT INTO public.subscription_pause_windows(id,subscription_id,pause_preset,starts_at,ends_at,idempotency_key) VALUES($1,$2,'2_weeks',now(),now()+interval '2 days',$3)", [next, s.id, `pause:${next}`]);
    await runtime.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100)");
    expect((await admin.query(`SELECT id FROM (${noticeHistory}) n WHERE subscription_id=$1 AND event_type='subscription.pause_reminder_due'`, [s.id])).rows).toHaveLength(2);
    expect((await runtime.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(0) AS result")).rows[0].result.scanned).toBe(0);
  }, 30000);

  it("keeps frozen renewal facts at delayed binding and suppresses a resumed pause durably", async () => {
    const renewal = await markedPurchase(), paused = await subscription("healthy", "paused"), window = randomUUID();
    await enqueue();
    const original = (await admin.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [renewal.id])).rows[0].next_cycle_at;
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '1 day' WHERE id=$1", [renewal.id]);
    await admin.query("INSERT INTO public.subscription_pause_windows(id,subscription_id,pause_preset,starts_at,ends_at,idempotency_key) VALUES($1,$2,'2_weeks',now()-interval '2 days',now()+interval '2 days',$3)", [window, paused.id, `window:${window}`]);
    await runtime.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100)");
    await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'resume','{}'::jsonb,now())", [paused.client, `resume:${window}`, paused.id]);
    const bound: Record<string, unknown>[] = [], receipts = new Map<string, { state: "accepted"; deliveryReference: string }>();
    const worker = () => createPostgresLifecycleMessages({
      async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
      bind: async notice => {
        if (notice.subscriptionId === paused.id && notice.kind === "subscription.pause_reminder_due") throw new Error("resumed_pause_reached_binding");
        if (notice.subscriptionId !== renewal.id || notice.kind !== "subscription.renewal_upcoming") throw new Error("fixture_unselected_notice");
        bound.push(notice.payload); return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug };
      },
      delivery: { readReceipt: async key => receipts.get(key) ?? null, send: async command => {
        const receipt = { state: "accepted" as const, deliveryReference: `captured:${command.idempotencyKey}` };
        receipts.set(command.idempotencyKey, receipt); return receipt;
      } },
    });
    await worker().run(100); await worker().run(100);
    const delayed = bound.find(payload => Date.parse(String(payload.renewalAt)) === original.getTime())!;
    expect(delayed).toMatchObject({ phaseFactsAllowed: false, phaseFacts: null });
    expect((await admin.query(`SELECT id FROM (${noticeHistory}) n WHERE subscription_id=$1 AND event_type='subscription.notice.suppressed'`, [paused.id])).rows).toHaveLength(1);
    expect((await admin.query("SELECT r.* FROM public.subscription_notice_refusals r JOIN public.subscription_events e ON e.id=r.source_id WHERE e.subscription_id=$1", [paused.id])).rows).toHaveLength(0);
  }, 30000);

  it("selects only finite unresolved pause windows strictly after now through the inclusive configured edge", async () => {
    const samples = await Promise.all([0, 1, 3, 4, null].map(() => subscription("healthy", "paused")));
    const db = await runtime.connect();
    try {
      await db.query("BEGIN");
      for (const [index, days] of [0, 1, 3, 4, null].entries()) await db.query(`INSERT INTO public.subscription_pause_windows(subscription_id,pause_preset,starts_at,ends_at,idempotency_key)
        VALUES($1,'2_weeks',now()-interval '1 day',CASE WHEN $2::integer IS NULL THEN NULL ELSE now()+make_interval(days=>$2) END,$3)`, [samples[index].id, days, `boundary:${samples[index].id}`]);
      await db.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100)");
      const ids = (await db.query(`SELECT subscription_id FROM (${noticeHistory}) n WHERE subscription_id=ANY($1::uuid[]) AND event_type='subscription.pause_reminder_due'`, [samples.map(row => row.id)])).rows.map(row => row.subscription_id).sort();
      expect(ids).toEqual([samples[1].id, samples[2].id].sort());
      await db.query("ROLLBACK");
    } finally { db.release(); }
  }, 30000);

  it("separates multiple operator recipients and customer claims, and preserves missing-recipient diagnostics and old history silence", async () => {
    await admin.query("UPDATE public.notification_recipients SET active=false WHERE notification_type='commerce_payment_critical'");
    const missing = await caseFor(); await customerNotice(missing.caseId);
    expect((await admin.query("SELECT status,error FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='operator'", [missing.caseId])).rows)
      .toEqual([{ status: "skipped", error: "missing_critical_notification_recipient" }]);
    const recipients = [randomUUID(), randomUUID()];
    for (const id of recipients) await admin.query("INSERT INTO public.notification_recipients(id,email,notification_type) VALUES($1,$2,'commerce_payment_critical')", [id, `${id}@example.invalid`]);
    const f = await caseFor(); await customerNotice(f.caseId); await customerNotice(f.caseId);
    expect((await admin.query("SELECT recipient_kind FROM public.subscription_dunning_notifications WHERE case_id=$1", [f.caseId])).rows).toHaveLength(3);
    const historical = randomUUID();
    await admin.query(`INSERT INTO public.subscription_dunning_notifications(id,case_id,subscription_id,recipient_ref,recipient_kind,notification_kind,template_slug,retry_attempt)
      VALUES($1,$2,$3,$4,'operator','payment_failed','subscription-payment-failed-operator',99)`, [historical, f.caseId, f.id, f.client]);
    expect((await admin.query("SELECT operator_dispatch_eligible FROM public.subscription_dunning_notifications WHERE id=$1", [historical])).rows[0].operator_dispatch_eligible).toBe(false);
    const customer = (await runtime.query("SELECT * FROM public.subscription_dunning_claim_batch(100,60,6)")).rows;
    expect(customer.every(row => row.recipient_kind === "customer")).toBe(true);
    const claimed = (await runtime.query("SELECT * FROM public.subscription_dunning_claim_operator_batch(100,60,6,82800)")).rows;
    expect(claimed.filter(row => row.case_id === f.caseId)).toHaveLength(2);
    expect(Object.keys(claimed[0]).sort()).toEqual(["case_id", "claim_token", "notification_id", "recipient_email", "recipient_id", "template_slug"]);
    expect(claimed[0]).not.toHaveProperty("payload"); expect(claimed[0]).not.toHaveProperty("recovery_url_path");
    const row = claimed.find(value => value.case_id === f.caseId)!;
    expect((await runtime.query("SELECT public.subscription_dunning_operator_delivery_eligible($1::uuid,$2::uuid) AS ok", [row.notification_id.toUpperCase(), row.claim_token.toUpperCase()])).rows[0].ok).toBe(true);
    await admin.query("UPDATE public.notification_recipients SET active=false WHERE id=$1", [row.recipient_id]);
    expect((await runtime.query("SELECT public.subscription_dunning_operator_delivery_eligible($1,$2) AS ok", [row.notification_id, row.claim_token])).rows[0].ok).toBe(false);
    await admin.query("UPDATE public.notification_recipients SET active=true WHERE id=$1", [row.recipient_id]);
    await admin.query("UPDATE public.subscription_dunning_cases SET status='cancelled' WHERE id=$1", [f.caseId]);
    expect((await runtime.query("SELECT public.subscription_dunning_operator_delivery_eligible($1,$2) AS ok", [row.notification_id, row.claim_token])).rows[0].ok).toBe(false);
  });

  it("repairs durable operator acceptance before horizon failure and fences stale claim tokens", async () => {
    await admin.query("UPDATE public.notification_recipients SET active=false WHERE notification_type='commerce_payment_critical'");
    const recipient = randomUUID();
    await admin.query("INSERT INTO public.notification_recipients(id,email,notification_type) VALUES($1,$2,'commerce_payment_critical')", [recipient, `${recipient}@example.invalid`]);
    const success = await caseFor(), ambiguous = await caseFor();
    await customerNotice(success.caseId); await customerNotice(ambiguous.caseId);
    const claimed = (await runtime.query("SELECT * FROM public.subscription_dunning_claim_operator_batch(100,60,6,82800)")).rows;
    let accepted = claimed.find(row => row.case_id === success.caseId)!;
    const failed = claimed.find(row => row.case_id === ambiguous.caseId)!, oldToken = accepted.claim_token;
    await admin.query("UPDATE public.subscription_dunning_notifications SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [accepted.notification_id]);
    accepted = (await runtime.query("SELECT * FROM public.subscription_dunning_claim_operator_batch(100,60,6,82800)")).rows.find(row => row.notification_id === accepted.notification_id)!;
    expect(accepted.claim_token).not.toBe(oldToken);
    expect((await runtime.query("SELECT public.subscription_dunning_mark_sent($1,$2,'stale:before-repair') AS ok", [accepted.notification_id, oldToken])).rows[0].ok).toBe(false);
    for (const row of [accepted, failed]) await admin.query("UPDATE public.subscription_dunning_notifications SET first_attempt_at=now()-interval '24 hours',lease_expires_at=now()-interval '1 second' WHERE id=$1", [row.notification_id]);
    await runtime.query("SELECT public.transactional_delivery_record_accepted($1,$2,'captured:operator-repair')", [`subscription-notice:dunning:${accepted.notification_id}`, "a".repeat(64)]);
    await runtime.query("SELECT * FROM public.subscription_dunning_claim_operator_batch(100,60,6,82800)");
    expect((await admin.query("SELECT status,delivery_ref,error FROM public.subscription_dunning_notifications WHERE id=$1", [accepted.notification_id])).rows[0])
      .toEqual({ status: "sent", delivery_ref: "captured:operator-repair", error: null });
    expect((await admin.query("SELECT status,error FROM public.subscription_dunning_notifications WHERE id=$1", [failed.notification_id])).rows[0])
      .toEqual({ status: "failed", error: "notice_idempotency_window_expired_manual_review" });
    expect((await runtime.query("SELECT public.subscription_dunning_mark_sent($1,$2,'stale:receipt') AS ok", [accepted.notification_id, accepted.claim_token])).rows[0].ok).toBe(false);
    const boundary = await caseFor(); await customerNotice(boundary.caseId);
    const db = await runtime.connect();
    try {
      await db.query("BEGIN");
      await db.query("UPDATE public.subscription_dunning_notifications SET first_attempt_at=now()-interval '23 hours' WHERE case_id=$1 AND recipient_kind='operator'", [boundary.caseId]);
      expect((await db.query("SELECT * FROM public.subscription_dunning_claim_operator_batch(100,60,6,82800)")).rows.some(row => row.case_id === boundary.caseId)).toBe(true);
      await db.query("ROLLBACK");
    } finally { db.release(); }
  });

  it("passes only explicit operator mail fields, terminalizes missing IDs, requeues transients and respects template controls", async () => {
    await admin.query("UPDATE public.notification_recipients SET active=false WHERE notification_type='commerce_payment_critical'");
    const recipient = randomUUID();
    await admin.query("INSERT INTO public.notification_recipients(id,email,notification_type) VALUES($1,$2,'commerce_payment_critical')", [recipient, `${recipient}@example.invalid`]);
    const unknown = await caseFor(), transient = await caseFor();
    await customerNotice(unknown.caseId); await customerNotice(transient.caseId);
    const calls: Record<string, string>[] = [], modes = new Map<string, string>();
    let successful = false;
    const worker = createPostgresLifecycleMessages({
      async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
      bind: async () => { throw new Error("fixture_customer_transport_unselected"); },
      bindOperator: async (notice, recipientFacts) => {
        expect(Object.keys(notice).sort()).toEqual(["caseId", "notificationId", "templateSlug"]);
        expect(Object.keys(recipientFacts)).toEqual(["email"]);
        calls.push(notice); modes.set(notice.notificationId, notice.caseId === unknown.caseId ? "unknown" : "transient");
        return { recipientReference: `operator:${recipient}`, templateReference: notice.notificationId };
      },
      delivery: { readReceipt: async () => null, send: async command => successful ? { state: "accepted", deliveryReference: "captured:operator" } : modes.get(command.templateReference) === "unknown"
        ? { state: "accepted", deliveryReference: null } : { state: "failed", deliveryReference: null, retryable: true } },
    });
    await worker.run(100);
    expect(calls).toHaveLength(2);
    expect((await admin.query("SELECT status,error FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='operator'", [unknown.caseId])).rows[0])
      .toEqual({ status: "failed", error: "notice_delivery_acceptance_unknown_manual_review" });
    const retry = (await admin.query("SELECT status,scheduled_at>now()+interval '9 minutes' AS delayed FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='operator'", [transient.caseId])).rows[0];
    expect(retry).toEqual({ status: "queued", delayed: true });
    successful = true;
    const absent = await caseFor(); await customerNotice(absent.caseId); await worker.run(100);
    expect((await admin.query("SELECT status FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='operator'", [absent.caseId])).rows[0].status).toBe("sent");
    const operator = randomUUID();
    await admin.query("INSERT INTO public.platform_communication_operators(principal_id) VALUES($1)", [operator]);
    expect((await admin.query("SELECT control_key FROM public.communication_delivery_controls WHERE control_key='subscription-payment-failed-operator'")).rows).toHaveLength(0);
    await runtime.query("SELECT public.communications_set_delivery_control($1::uuid,'subscription-payment-failed-operator',false)", [operator.toUpperCase()]);
    const disabled = await caseFor(); await customerNotice(disabled.caseId);
    await worker.run(100); expect(calls).toHaveLength(3);
    expect((await admin.query("SELECT status FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='operator'", [disabled.caseId])).rows[0].status).toBe("skipped");
    await runtime.query("SELECT public.communications_set_delivery_control($1::uuid,'subscription-payment-failed-operator',true)", [operator]);
    const enabled = await caseFor(); await customerNotice(enabled.caseId);
    await worker.run(100); expect(calls).toHaveLength(4);
    expect((await admin.query("SELECT status FROM public.subscription_dunning_notifications WHERE case_id=$1 AND recipient_kind='operator'", [enabled.caseId])).rows[0].status).toBe("sent");
  });

  it("binds stable at-risk cause tokens and the actual instant across a merchant calendar boundary", async () => {
    const s = await subscription("method_missing"), seen: { cause: unknown; day: string; utcDay: string }[] = [];
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=((now() AT TIME ZONE 'UTC')::date+interval '3 days 1 hour') AT TIME ZONE 'UTC' WHERE id=$1", [s.id]);
    const run = () => createPostgresLifecycleMessages({
      async withSession(work) { const db = await runtime.connect(); try { await db.query("SET TimeZone='Etc/GMT-9'"); return await work(db); } finally { db.release(); } },
      bind: async notice => {
        if (notice.subscriptionId !== s.id || notice.kind !== "subscription.renewal_at_risk") throw new Error("fixture_unselected_notice");
        const at = new Date(String(notice.payload.renewalAt));
        seen.push({ cause: notice.payload.cause, utcDay: at.toISOString().slice(0, 10), day: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(at) });
        return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug };
      },
      delivery: { readReceipt: async () => null, send: async () => ({ state: "failed", deliveryReference: null }) },
    }).run(100);
    await run();
    await admin.query("UPDATE public.subscription_method_states SET health_state='mandate_not_chargeable_unattended' WHERE subscription_id=$1", [s.id]);
    await run();
    expect(seen.map(row => row.cause)).toEqual(["missing", "mandate"]);
    for (const row of seen) expect(Date.parse(`${row.utcDay}T00:00:00Z`)-Date.parse(`${row.day}T00:00:00Z`)).toBe(86400000);
  }, 30000);

  it("counts two disabled-template days across workers, excludes failed/anomalous attempts, and keeps cause namespaces", async () => {
    const missing = await subscription("method_missing");

    const s = await subscription("method_missing"), control = "subscription-renewal-at-risk";
    await admin.query("INSERT INTO public.communication_delivery_controls(control_key,enabled) VALUES($1,false) ON CONFLICT(control_key) DO UPDATE SET enabled=false", [control]);
    let delivered = 0, anomaly = true, rejectTransport = false;
    const acceptedKeys = new Set<string>();
    const make = (targetId = s.id) => {
      const receipts = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
      const engine = createTransactionalDelivery({ store: receipts, delivery: { async deliver(command) {
        if (rejectTransport) { rejectTransport = false; throw new Error("fixture_transport_failed"); }
        if (!acceptedKeys.has(command.idempotencyKey)) { delivered++; acceptedKeys.add(command.idempotencyKey); }
        // Models the provider's idempotent repeated response after initial ID loss.
        if (anomaly) { anomaly = false; return { deliveryReference: "" }; }
        return { deliveryReference: `captured:${command.idempotencyKey}` };
      } } });
      return { receipts, binding: createPostgresLifecycleMessages({
        async withSession(work) {
          // A new producer connection, worker and receipt store in every phase
          // prove that cause/day history survives the previous worker session.
          const fresh = new Pool({ connectionString: runtimeUrl });
          try {
            const db = await fresh.connect();
            try { await db.query("SET TimeZone='Etc/GMT+5'"); return await work(noticeSessionWithRecipientFault(db, new Set([missing.client]))); }
            finally { db.release(); }
          } finally { await fresh.end(); }
        },
        bind: async notice => {
          if (notice.subscriptionId !== targetId || notice.kind !== "subscription.renewal_at_risk") throw new Error("fixture_unselected_notice");
          return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug };
        },
        delivery: { send: engine.send, readReceipt: receipts.readReceipt },
      }) };
    };
    for (let index = 0; index < 2; index++) {
      await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+make_interval(days=>$2) WHERE id=$1", [s.id, 3 + index]);
      const worker = make(); try { await worker.binding.run(100); } finally { await worker.receipts.close(); }
      if (index === 0) {
        const duplicate = make(); try { await duplicate.binding.run(100); } finally { await duplicate.receipts.close(); }
        await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '2 days' WHERE id=$1", [s.id]);
        const earlier = make(); try { await earlier.binding.run(100); } finally { await earlier.receipts.close(); }
        expect(Number((await admin.query(`SELECT count(*) FROM (${noticeHistory}) n WHERE subscription_id=$1 AND event_type='subscription.notice.at_risk_outcome'`, [s.id])).rows[0].count)).toBe(1);
      }
    }
    expect(Number((await admin.query(`SELECT count(*) FROM (${noticeHistory}) n WHERE subscription_id=$1 AND event_type='subscription.notice.at_risk_outcome'`, [s.id])).rows[0].count)).toBe(2);
    await admin.query("UPDATE public.communication_delivery_controls SET enabled=true WHERE control_key=$1", [control]);
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '5 days' WHERE id=$1", [s.id]);
    const third = make(); try { await third.binding.run(100); } finally { await third.receipts.close(); }
    expect(delivered).toBe(0);
    expect((await admin.query(`SELECT id FROM (${noticeHistory}) n WHERE subscription_id=$1 AND event_type IN ('subscription.notice.at_risk','subscription.notice.at_risk_outcome')`, [missing.id])).rows).toHaveLength(0);
    // A separate cause has a separate history; invalid ID must not count the day.
    await admin.query("UPDATE public.subscription_method_states SET health_state='mandate_not_chargeable_unattended' WHERE subscription_id=$1", [s.id]);
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '4 days' WHERE id=$1", [s.id]);
    for (let index = 0; index < 2; index++) {
      const worker = make(); try { await worker.binding.run(100); } finally { await worker.receipts.close(); }
      const counted = Number((await admin.query(`SELECT count(*) FROM (${noticeHistory}) e JOIN public.transactional_delivery_receipts r
        ON r.idempotency_key='subscription-notice:event:'||e.id::text WHERE e.subscription_id=$1 AND e.event_type='subscription.notice.at_risk' AND e.payload->>'cause'='mandate' AND r.state='accepted'`, [s.id])).rows[0].count);
      expect(counted).toBe(index);
    }
    expect(delivered).toBe(1);
    const failure = await subscription("method_missing"); rejectTransport = true;
    for (let index = 0; index < 2; index++) {
      const worker = make(failure.id); try { await worker.binding.run(100); } finally { await worker.receipts.close(); }
      const accepted = Number((await admin.query(`SELECT count(*) FROM (${noticeHistory}) e JOIN public.transactional_delivery_receipts r
        ON r.idempotency_key='subscription-notice:event:'||e.id::text WHERE e.subscription_id=$1 AND e.event_type='subscription.notice.at_risk' AND r.state='accepted'`, [failure.id])).rows[0].count);
      expect(accepted).toBe(index);
    }
    expect(delivered).toBe(2);
  }, 60000);
  it("isolates renewal facts from retained customer lifecycle keys and preserves unrelated notice dispatch", async () => {
    const blocked = await subscription(), otherReminder = await subscription();
    const key = (await admin.query("SELECT 'renewal-reminder:'||to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS key FROM public.subscriptions WHERE id=$1", [blocked.id])).rows[0].key;
    await customerPause(blocked, key, true);
    expect((await admin.query("SELECT status FROM public.subscriptions WHERE id=$1", [blocked.id])).rows[0].status).toBe("paused");
    expect((await admin.query("SELECT event_type FROM public.subscription_events WHERE subscription_id=$1 AND idempotency_key=$2", [blocked.id, key])).rows)
      .toEqual([{ event_type: "subscription.customer_self_service.pause" }]);
    await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'resume','{}'::jsonb,now())", [blocked.client, `collision-resume:${blocked.id}`, blocked.id]);
    // Model elapsed freshness after the real pause/resume writers without re-keying their event.
    await admin.query("UPDATE public.subscriptions SET updated_at=now()-interval '6 days' WHERE id=$1", [blocked.id]);
    await admin.query("UPDATE public.notification_recipients SET active=false WHERE notification_type='commerce_payment_critical'");
    const recipient = randomUUID();
    await admin.query("INSERT INTO public.notification_recipients(id,email,notification_type) VALUES($1,$2,'commerce_payment_critical')", [recipient, `${recipient}@example.invalid`]);
    const unrelated = await caseFor(); await customerNotice(unrelated.caseId);
    let delivered = 0;
    const boundCustomerIds: string[] = [];
    const accepted = new Map<string, { state: "accepted"; deliveryReference: string }>();
    const worker = createPostgresLifecycleMessages({
      async withSession(work) { const db = await runtime.connect(); try { return await work(db); } finally { db.release(); } },
      bind: async notice => {
        if (notice.subscriptionId === blocked.id && notice.kind === "subscription.paused") boundCustomerIds.push(notice.id);
        return { recipientReference: "customer:collision-control", templateReference: "notice:collision-control" };
      },
      bindOperator: async () => ({ recipientReference: "operator:collision-control", templateReference: "operator:collision-control" }),
      delivery: { readReceipt: async key => accepted.get(key) ?? null, send: async command => {
        const receipt = { state: "accepted" as const, deliveryReference: `captured:collision:${++delivered}` };
        accepted.set(command.idempotencyKey, receipt); return receipt;
      } },
    });
    await worker.run(100);
    expect(await count(blocked.id)).toBe(1);
    expect(await count(otherReminder.id)).toBe(1);
    expect((await admin.query("SELECT recipient_kind,status FROM public.subscription_dunning_notifications WHERE case_id=$1 ORDER BY recipient_kind", [unrelated.caseId])).rows)
      .toEqual([{ recipient_kind: "customer", status: "sent" }, { recipient_kind: "operator", status: "sent" }]);
    expect((await admin.query("SELECT event_type FROM public.subscription_events WHERE subscription_id=$1 AND idempotency_key=$2", [blocked.id, key])).rows)
      .toEqual([{ event_type: "subscription.customer_self_service.pause" }]);
    const customerEventId = (await admin.query("SELECT id FROM public.subscription_events WHERE subscription_id=$1 AND idempotency_key=$2", [blocked.id, key])).rows[0].id;
    expect(boundCustomerIds).toEqual([customerEventId]);
    expect(accepted.get(`subscription-notice:event:${customerEventId}`)?.state).toBe("accepted");
    const deliveredOnce = delivered;
    await worker.run(100);
    expect(await count(blocked.id)).toBe(1);
    expect(await count(otherReminder.id)).toBe(1);
    expect(deliveredOnce).toBeGreaterThanOrEqual(4);
    expect(delivered).toBe(deliveredOnce);
  }, 30000);

  async function customerPause(s: { id: string; client: string }, key: string, legacy = false) {
    const principal = randomUUID();
    await admin.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
    await admin.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [s.client, principal]);
    const signature = "public.customer_subscription_pause_as_actor(uuid,text,text,text)";
    const installed = (await admin.query("SELECT pg_get_functiondef($1::regprocedure) AS sql", [signature])).rows[0].sql;
    // As in the command-key upgrade witness, retain raw history using its actual issued actor routine.
    // Restore the current definition before any notice producer or dispatcher executes.
    if (legacy) await admin.query(readFileSync("db/platform/migrations/20260812100000_customer_subscription_pause_actor.sql", "utf8")
      .match(/CREATE FUNCTION[\s\S]*?\n\$\$;/u)![0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
    const actor = await admin.connect();
    try {
      await actor.query("BEGIN"); await actor.query("SET LOCAL ROLE authenticated");
      await actor.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal, role: "authenticated" })]);
      expect((await actor.query("SELECT current_user AS name")).rows[0].name).toBe("authenticated");
      await actor.query("SELECT public.customer_subscription_pause_as_actor($1,$2,'indefinite',NULL)", [s.id, key]);
      await actor.query("COMMIT");
    } catch (error) { await actor.query("ROLLBACK"); throw error; } finally {
      actor.release();
      if (legacy) await admin.query(installed);
    }
    expect((await admin.query("SELECT pg_get_functiondef($1::regprocedure) AS sql", [signature])).rows).toEqual([{ sql: installed }]);
    const storedKey = legacy ? key : `command:${createHash("sha256").update(`${principal}:${key}`).digest("hex")}`;
    const event = (await admin.query("SELECT * FROM public.subscription_events WHERE subscription_id=$1 AND idempotency_key=$2", [s.id, storedKey])).rows[0];
    expect(event).toMatchObject({ event_type: "subscription.customer_self_service.pause", idempotency_key: storedKey });
    if (!legacy) expect((await admin.query("SELECT id FROM public.subscription_events WHERE subscription_id=$1 AND idempotency_key=$2", [s.id, key])).rows).toEqual([]);
    return event;
  }
  async function resume(s: { id: string; client: string }) {
    await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'resume','{}'::jsonb,now())", [s.client, `resume:${randomUUID()}`, s.id]);
  }
  async function dispatchCaptured(s: { id: string; client: string }, bound: { id: string; kind: string; key: string }[], returnedFailure = false) {
    const receipts = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
    const engine = createTransactionalDelivery({ store: receipts, delivery: { async deliver(command) {
      if (returnedFailure) throw new Error("fixture_transport_unavailable");
      return { deliveryReference: `captured:${command.idempotencyKey}` };
    } } });
    try {
      const worker = createPostgresLifecycleMessages({
        async withSession(work) {
          const db = await runtime.connect();
          try { await db.query("SET TimeZone='Etc/GMT+5'"); return await work(db); } finally { db.release(); }
        },
        bind: async notice => {
          if (notice.subscriptionId !== s.id) throw new Error("fixture_unselected_notice");
          bound.push({ id: notice.id, kind: notice.kind, key: notice.messageKey });
          return { recipientReference: `client:${s.client}`, templateReference: notice.templateSlug };
        },
        delivery: { send: async command => {
          try { return await engine.send(command); }
          catch (error) {
            if (!returnedFailure) throw error;
            // The shared engine already persisted the failed receipt; the host port returns that outcome.
            return { state: "failed" as const, deliveryReference: null, retryable: true };
          }
        }, readReceipt: receipts.readReceipt },
      });
      await worker.run(100);
    } finally { await receipts.close(); }
  }
  async function acceptedCustomer(s: { id: string }, event: Record<string, unknown>) {
    expect((await admin.query("SELECT * FROM public.subscription_events WHERE id=$1", [event.id])).rows).toEqual([event]);
    expect((await admin.query("SELECT state,delivery_reference FROM public.transactional_delivery_receipts WHERE idempotency_key=$1",
      [`subscription-notice:event:${event.id}`])).rows).toEqual([{ state: "accepted", delivery_reference: `captured:subscription-notice:event:${event.id}` }]);
    expect((await admin.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND id=$2", [s.id, event.id])).rows).toEqual([]);
  }
  it.each([["missing", true], ["missing", false], ["mandate", true], ["mandate", false]] as const)("isolates %s at-risk identities from authenticated pause keys (legacy=%s) and permanently counts accepted warnings", async (cause, legacy) => {
    const s = await subscription(cause === "missing" ? "method_missing" : "mandate_not_chargeable_unattended", "active", 3);
    await admin.query("UPDATE public.communication_delivery_controls SET enabled=true WHERE control_key='subscription-renewal-at-risk'");
    const day = (await admin.query("SELECT to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day FROM public.subscriptions WHERE id=$1", [s.id])).rows[0].day;
    const event = await customerPause(s, `at-risk:${cause}:${day}`, legacy); await resume(s);
    const bound: { id: string; kind: string; key: string }[] = [];
    for (const days of [3, 4, 5]) {
      await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+make_interval(days=>$2) WHERE id=$1", [s.id, days]);
      await dispatchCaptured(s, bound); // New worker/session/receipt store each day.
    }
    await acceptedCustomer(s, event);
    const warnings = bound.filter(notice => notice.kind === "subscription.renewal_at_risk");
    expect(warnings).toHaveLength(2);
    expect(warnings.every(notice => notice.id !== event.id)).toBe(true);
    expect(bound.filter(notice => notice.id === event.id).map(notice => notice.kind)).toEqual(["subscription.paused"]);
    expect((await admin.query(`SELECT count(DISTINCT n.payload->>'renewalDay')::int AS n FROM (${noticeHistory}) n
      JOIN public.transactional_delivery_receipts r ON r.idempotency_key='subscription-notice:event:'||n.id::text
      WHERE n.subscription_id=$1 AND n.event_type='subscription.notice.at_risk' AND n.payload->>'cause'=$2 AND r.state='accepted'`, [s.id, cause])).rows).toEqual([{ n: 2 }]);
    expect((await admin.query("SELECT status FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.notice.at_risk'", [s.id])).rows)
      .toEqual([{ status: "processed" }, { status: "processed" }]);
    await admin.query("SELECT public.commerce_outbox_compact_terminal(5000,now()+interval '31 days')");
    expect((await admin.query("SELECT payload FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.notice.at_risk'", [s.id])).rows)
      .toEqual([{ payload: {} }, { payload: {} }]);
    await dispatchCaptured(s, bound);
    expect(bound.filter(notice => notice.kind === "subscription.renewal_at_risk")).toHaveLength(2);
  }, 30000);
  it("isolates retained disabled at-risk outcome keys and includes their day in the permanent cap", async () => {
    const s = await subscription("method_missing", "active", 3);
    const day = (await admin.query("SELECT to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day FROM public.subscriptions WHERE id=$1", [s.id])).rows[0].day;
    const event = await customerPause(s, `at-risk-outcome:missing:${day}`, true); await resume(s);
    await admin.query("INSERT INTO public.communication_delivery_controls(control_key,enabled) VALUES('subscription-renewal-at-risk',false) ON CONFLICT(control_key) DO UPDATE SET enabled=false");
    const bound: { id: string; kind: string; key: string }[] = [];
    await dispatchCaptured(s, bound); await acceptedCustomer(s, event);
    expect((await admin.query("SELECT id,payload->>'outcome' AS outcome FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.notice.at_risk_outcome'", [s.id])).rows)
      .toEqual([{ id: expect.not.stringMatching(String(event.id)), outcome: "disabled" }]);
    await admin.query("UPDATE public.communication_delivery_controls SET enabled=true WHERE control_key='subscription-renewal-at-risk'");
    for (const days of [4, 5]) {
      await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+make_interval(days=>$2) WHERE id=$1", [s.id, days]);
      await dispatchCaptured(s, bound);
    }
    expect(bound.filter(notice => notice.kind === "subscription.renewal_at_risk")).toHaveLength(1);
    expect((await admin.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.notice.at_risk'", [s.id])).rows).toHaveLength(2);
    await admin.query("SELECT public.commerce_outbox_compact_terminal(5000,now()+interval '31 days')");
    expect((await admin.query("SELECT payload FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.notice.at_risk_outcome'", [s.id])).rows)
      .toEqual([{ payload: {} }]);
    await dispatchCaptured(s, bound);
    expect(bound.filter(notice => notice.kind === "subscription.renewal_at_risk")).toHaveLength(1);
  }, 30000);
  it.each(["pause-reminder:", "subscription_pause_reminder:"])("isolates pause-window notices from retained authenticated %s keys", async prefix => {
    const s = await subscription(), window = randomUUID();
    const event = await customerPause(s, `${prefix}${window}`, true); await resume(s);
    await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'pause','{\"pausePreset\":\"2_weeks\"}'::jsonb,now())", [s.client, `window:${window}`, s.id]);
    // Pin the writer-allocated random UUID and model elapsed time, without changing its event or command key.
    await admin.query("UPDATE public.subscription_pause_windows SET id=$2,ends_at=now()+interval '2 days' WHERE subscription_id=$1 AND resumed_at IS NULL", [s.id, window]);
    const bound: { id: string; kind: string; key: string }[] = [];
    await dispatchCaptured(s, bound); await dispatchCaptured(s, bound);
    await acceptedCustomer(s, event);
    const notices = bound.filter(notice => notice.kind === "subscription.pause_reminder_due");
    expect(notices).toHaveLength(1); expect(notices[0].id).not.toBe(event.id);
    expect((await admin.query("SELECT payload->>'pauseWindowId' AS window FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.pause_reminder_due'", [s.id])).rows).toEqual([{ window }]);
    await resume(s); await dispatchCaptured(s, bound);
    expect(bound.filter(notice => notice.kind === "subscription.pause_reminder_due")).toHaveLength(1);
  }, 30000);
  it.each(["notice", "customer"])("isolates resolved-pause markers from retained customer keys targeting a %s source", async target => {
    const s = await subscription();
    const first = await customerPause(s, `pause:${s.id}`);
    await admin.query("UPDATE public.subscription_pause_windows SET ends_at=now()+interval '2 days' WHERE subscription_id=$1 AND resumed_at IS NULL", [s.id]);
    await runtime.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100)");
    const notice = (await admin.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.pause_reminder_due'", [s.id])).rows[0];
    await resume(s);
    const event = await customerPause(s, `notice-suppressed:event:${target === 'notice' ? notice.id : first.id}`, true); await resume(s);
    const bound: { id: string; kind: string; key: string }[] = [];
    await dispatchCaptured(s, bound); await dispatchCaptured(s, bound);
    await acceptedCustomer(s, first); await acceptedCustomer(s, event);
    expect(bound.some(row => row.id === notice.id)).toBe(false);
    expect((await admin.query("SELECT payload FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.notice.suppressed'", [s.id])).rows)
      .toEqual([{ payload: { reason: "pause_window_resolved", source: "event", sourceId: notice.id } }]);
    expect((await admin.query("SELECT state FROM public.transactional_delivery_receipts WHERE idempotency_key=$1", [`subscription-notice:event:${notice.id}`])).rows).toEqual([]);
  }, 30000);
  it("keeps failed pause work pending and reconciles interrupted acceptance without changing its delivery key", async () => {
    const s = await subscription(), customer = await customerPause(s, `pause-retry:${s.id}`);
    await admin.query("UPDATE public.subscription_pause_windows SET ends_at=now()+interval '2 days' WHERE subscription_id=$1 AND resumed_at IS NULL", [s.id]);
    const bound: { id: string; kind: string; key: string }[] = [];
    await dispatchCaptured(s, bound, true);
    const notice = (await admin.query("SELECT id,status FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.pause_reminder_due'", [s.id])).rows[0];
    expect(notice.status).toBe("pending");
    const unrelated = randomUUID();
    await admin.query("INSERT INTO public.outbox_events(id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,'subscription',$2,'subscription.notice.identity_probe',$3,'{}')", [unrelated, s.id, `probe:${unrelated}`]);
    expect((await admin.query("SELECT id FROM public.outbox_claim_batch(ARRAY['subscription.notice.identity_probe'])")).rows).toEqual([{ id: unrelated }]);
    expect((await admin.query("SELECT state,attempt_count FROM public.transactional_delivery_receipts WHERE idempotency_key=$1", [`subscription-notice:event:${notice.id}`])).rows)
      .toEqual([{ state: "failed", attempt_count: 1 }]);
    await dispatchCaptured(s, bound); await acceptedCustomer(s, customer);
    expect(bound.filter(row => row.id === notice.id).map(row => row.key)).toEqual([
      `subscription-notice:event:${notice.id}`, `subscription-notice:event:${notice.id}`,
    ]);
    // Model the process exiting after durable acceptance but before outbox completion.
    await admin.query("UPDATE public.outbox_events SET status='pending',processed_at=NULL WHERE id=$1", [notice.id]);
    await dispatchCaptured(s, bound);
    expect((await admin.query("SELECT status FROM public.outbox_events WHERE id=$1", [notice.id])).rows).toEqual([{ status: "processed" }]);
    expect(bound.filter(row => row.id === notice.id)).toHaveLength(2);
    expect((await admin.query("SELECT state,attempt_count FROM public.transactional_delivery_receipts WHERE idempotency_key=$1", [`subscription-notice:event:${notice.id}`])).rows)
      .toEqual([{ state: "accepted", attempt_count: 2 }]);
  }, 30000);
  // Retained event compatibility is separate from the actual base-ledger upgrade exercised below.
  it.each(["accepted", "disabled", "retry"])("retains typed %s at-risk and pause event history across the carrier change", async history => {
    const risk = await subscription("method_missing", "active", history === "retry" ? 3 : 4), paused = await subscription("healthy", "paused");
    const priorRisk = randomUUID(), priorPause = randomUUID(), window = randomUUID();
    await admin.query(`INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload)
      SELECT $1,id,'subscription.notice.at_risk','at-risk:missing:'||to_char((next_cycle_at-make_interval(days=>$3)) AT TIME ZONE 'UTC','YYYY-MM-DD'),
        jsonb_build_object('cause','missing','renewalDay',to_char((next_cycle_at-make_interval(days=>$3)) AT TIME ZONE 'UTC','YYYY-MM-DD'))
        FROM public.subscriptions WHERE id=$2`, [priorRisk, risk.id, history === "retry" ? 0 : 1]);
    if (history === "accepted") await runtime.query("SELECT public.transactional_delivery_record_accepted($1,$2,$3)", [`subscription-notice:event:${priorRisk}`, "b".repeat(64), "captured:old-risk"]);
    if (history === "disabled") await admin.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
      SELECT subscription_id,'subscription.notice.at_risk_outcome','at-risk-outcome:missing:'||(payload->>'renewalDay'),
        payload||jsonb_build_object('noticeId',id,'outcome','disabled') FROM public.subscription_events WHERE id=$1`, [priorRisk]);
    await admin.query("INSERT INTO public.subscription_pause_windows(id,subscription_id,pause_preset,starts_at,ends_at,idempotency_key) VALUES($1,$2,'2_weeks',now()-interval '1 day',now()+interval '2 days',$3)", [window, paused.id, `legacy:${window}`]);
    await admin.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'subscription.pause_reminder_due',$3,$4)",
      [priorPause, paused.id, `pause-reminder:${window}`, JSON.stringify({ pauseWindowId: window })]);
    const bound: { id: string; kind: string; key: string }[] = [];
    await dispatchCaptured(paused, bound); await dispatchCaptured(paused, bound);
    expect(bound.filter(row => row.id === priorPause)).toHaveLength(1);
    expect((await admin.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.pause_reminder_due'", [paused.id])).rows).toEqual([]);
    await dispatchCaptured(risk, bound);
    if (history === "retry") {
      await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '4 days' WHERE id=$1", [risk.id]);
      await dispatchCaptured(risk, bound);
    }
    await admin.query("UPDATE public.subscriptions SET next_cycle_at=now()+interval '5 days' WHERE id=$1", [risk.id]);
    await dispatchCaptured(risk, bound);
    expect(bound.filter(row => row.kind === "subscription.renewal_at_risk")).toHaveLength(history === "retry" ? 2 : 1);
    expect(bound.some(row => row.id === priorRisk)).toBe(history === "retry");
    expect((await admin.query("SELECT id FROM public.subscription_events WHERE id=ANY($1::uuid[]) ORDER BY id", [[priorRisk, priorPause]])).rows)
      .toEqual([priorRisk, priorPause].sort().map(id => ({ id })));
  }, 30000);


});

// The service read is the only new authority. Both restricted-bootstrap role
// modes keep direct EXECUTE on the replaced implementation unavailable.
it.each(["installer-managed", "operator-provisioned"] as const)("admits the at-risk service read and refuses the owner-only scan in qualified-admin %s", async roleMode => {
  const container = await runPostgresContainer({ name: `notice-scan-acl-${roleMode}-${process.pid}`, password });
  const pools: Pool[] = [];
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const admin = new Pool({ connectionString: container.connectionString }); pools.push(admin);
    const login = (role: string) => { const url = new URL(container.connectionString); url.username = role; url.password = password; return url.toString(); };
    await admin.query(`CREATE ROLE notice_migration LOGIN NOINHERIT NOSUPERUSER ${roleMode === "installer-managed" ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
      ALTER DATABASE postgres OWNER TO notice_migration`);
    for (const role of ["notice_runtime", "notice_restore"]) await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    if (roleMode === "operator-provisioned") {
      await admin.query(`CREATE ROLE notice_operator LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const operator = new Pool({ connectionString: login("notice_operator") }); pools.push(operator);
      for (const group of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
        await admin.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
          GRANT ${group} TO notice_operator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await operator.query(`GRANT ${group} TO notice_migration WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY notice_operator`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group))
          await operator.query(`GRANT ${group} TO notice_runtime WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY notice_operator`);
      }
    }
    const common = { generation: "qualified-admin" as const, bootstrapLogin: "postgres", migrationLogin: "notice_migration", runtimeLogin: "notice_runtime", restoreLogin: "notice_restore" };
    const installation = roleMode === "installer-managed" ? { ...common, roleMode } : { ...common, roleMode, operatorLogin: "notice_operator" };
    await install(login("notice_migration"), installation);
    const runtime = new Pool({ connectionString: login("notice_runtime") }); pools.push(runtime);
    expect((await runtime.query("SELECT rolsuper OR rolbypassrls AS elevated FROM pg_roles WHERE rolname=current_user")).rows[0].elevated).toBe(false);
    const client = randomUUID(), subscription = randomUUID();
    await admin.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
    await admin.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,status,next_cycle_at) VALUES($1,$2,14,'active',now()+interval '4 days')", [subscription, client]);
    await admin.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'method_missing')", [subscription]);
    expect((await runtime.query("SELECT * FROM public.dunning_lifecycle_scan_at_risk_service(2,5,100)")).rows.map(row => row.subscription_id)).toEqual([subscription]);
    await expect(runtime.query("SELECT * FROM public.dunning_lifecycle_scan_at_risk(2,5,100)"))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for function dunning_lifecycle_scan_at_risk" });
  } finally { await closePostgres(container, pools); }
}, postgresSetupTimeoutMs);

// Freeze the actual pre-notice boundary, not a synthetic event representation of its history.
const beforeNoticeInventories = {
  legacy: "802f3aae251758e90316971d1458325d0af0356581f3120523c45d257fd1cd2e",
  bootstrap: "93c8120fd1b4131e6a92e2c2cec2c45a4484592b5bd6e7537ac63bd3d075041a",
  separate: "540873c53e038078b675549899165299c2f1b371d07b481d46121dbd943da6e1",
  adminInstaller: "75d7869d54fc5dcc819e40789bd5d4c4fef8b96deb34e54a37708aed10ae2f70",
  adminOperator: "f0a8d2f11798ac7e36a5b8ff6d6a0698fa878f45f0e744d38cd81f0a3ec99028",
};
it.each(["legacy", "qualified-v2"] as const)("bridges real base pause and renewal producers through the %s upgrade", async generation => {
  const container = await runPostgresContainer({ name: `notice-base-upgrade-${generation}-${process.pid}`, password });
  const pools: Pool[] = [];
  mkdirSync(".context/scratch/c23", { recursive: true });
  const prefixRoot = mkdtempSync(".context/scratch/c23/base-notices-");
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const owner = new Pool({ connectionString: container.connectionString }); pools.push(owner);
    let installation: PlatformPostgresInstallation = { generation: "legacy" };
    const login = new URL(container.connectionString);
    if (generation === "qualified-v2") {
      for (const role of ["base_notice_runtime", "base_notice_restore"]) await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      installation = { generation, roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "base_notice_runtime", restoreLogin: "base_notice_restore" };
      login.username = installation.runtimeLogin; login.password = password;
    }
    const migration = new Pool({ connectionString: container.connectionString,
      options: installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation) : undefined }); pools.push(migration);
    const runtimeUrl = login.toString(), runtime = new Pool({ connectionString: runtimeUrl, options: "-c timezone=Etc/GMT+5" }); pools.push(runtime);
    const prefix = structuredClone(candidate);
    prefix.objectInventorySha256 = beforeNoticeInventories.legacy;
    prefix.qualified.objectInventorySha256.bootstrapMigrator.withRestore = beforeNoticeInventories.bootstrap;
    prefix.qualified.objectInventorySha256.separateMigrator.withRestore = beforeNoticeInventories.separate;
    prefix.qualifiedAdmin.objectInventorySha256.installerManaged = beforeNoticeInventories.adminInstaller;
    prefix.qualifiedAdmin.objectInventorySha256.operatorProvisioned = beforeNoticeInventories.adminOperator;
    for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
      const end = plan.forward.findIndex((unit: { file: string }) => unit.file === "db/platform/migrations/20261106120000_subscription_notice_producers.sql");
      expect(end).toBeGreaterThanOrEqual(0);
      plan.forward = plan.forward.slice(0, end);
      for (const unit of [plan.baseline, ...plan.forward]) {
        const target = join(prefixRoot, unit.file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(unit.file));
      }
    }
    mkdirSync(join(prefixRoot, "config")); writeFileSync(join(prefixRoot, "config/platform-migration-manifest.json"), JSON.stringify(prefix));
    const runner = (root = process.cwd()) => createPostgresMigrationRunner({ connectionString: container.connectionString }, { root, installation, poolFactory: () => migration });
    await runner(prefixRoot).apply();
    expect((await runner(prefixRoot).status()).pending).toEqual([]);
    const producer = (await owner.query("SELECT prosrc FROM pg_proc WHERE oid='public.dunning_lifecycle_pause_reminder_dispatch(integer)'::regprocedure")).rows[0].prosrc;
    expect(producer).toContain("INSERT INTO public.subscription_reminder_ledger");
    expect(producer).toContain("'pause_ending'");
    expect(producer).not.toContain("outbox_events");
    expect((await owner.query("SELECT to_regprocedure('public.dunning_lifecycle_pause_reminder_dispatch(integer,integer)') AS extension")).rows).toEqual([{ extension: null }]);
    const subject = async (renewal = false) => {
      const client = randomUUID(), id = randomUUID();
      await owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
      await owner.query("INSERT INTO public.subscriptions(id,client_id,status,cadence_days,next_cycle_at,updated_at) VALUES($1,$2,'active',14,now()+interval '4 days',now()-interval '6 days')", [id, client]);
      if (renewal) await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [id]);
      return { id, client };
    };
    const acceptedPause = await subject(), resumedPause = await subject(), openPause = await subject();
    const acceptedRenewal = await subject(true), openRenewal = await subject(true);
    // 01:00Z is the previous local day in the dispatch session: identity must stay UTC.
    const requestedAt = (await owner.query("SELECT ((date_trunc('day',now() AT TIME ZONE 'UTC')+interval '2 days 1 hour') AT TIME ZONE 'UTC')-interval '14 days' AS at")).rows[0].at;
    for (const s of [acceptedPause, resumedPause, openPause]) await runtime.query(
      "SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'pause','{\"pausePreset\":\"2_weeks\"}'::jsonb,$4)", [s.client, `base-pause:${s.id}`, s.id, requestedAt]);
    const windows = (await owner.query("SELECT id,subscription_id,ends_at FROM public.subscription_pause_windows ORDER BY subscription_id")).rows;
    expect((await runtime.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100) AS result")).rows[0].result).toMatchObject({ scanned: 3, queued: 3 });
    expect((await runtime.query("SELECT public.dunning_lifecycle_renewal_reminder_enqueue(100) AS result")).rows[0].result).toEqual({ enqueued: 2 });
    const census = async () => (await owner.query("SELECT id,subscription_id,reminder_kind,to_char(reminder_day,'YYYY-MM-DD') AS day,enqueued_at,xmin::text AS version FROM public.subscription_reminder_ledger ORDER BY id")).rows;
    const before = await census(); expect(before).toHaveLength(5);
    const ledgerFor = (id: string) => before.find(row => row.subscription_id === id)!;
    expect(before.filter(row => row.reminder_kind === "pause_ending")).toHaveLength(3);
    expect((await owner.query("SELECT id FROM public.subscription_events WHERE event_type IN ('subscription.pause_reminder_due','subscription.reminder.renewal_facts','subscription.notice.at_risk','subscription.notice.at_risk_outcome','subscription.notice.suppressed')")).rows).toEqual([]);
    const baseReceipts = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
    const acceptedKeys: string[] = [];
    const baseDelivery = createTransactionalDelivery({ store: baseReceipts, delivery: { async deliver(command) {
      acceptedKeys.push(command.idempotencyKey); return { deliveryReference: `captured:base:${command.idempotencyKey}` };
    } } });
    try {
      for (const [s, template] of [[acceptedPause, "subscription-pause-reminder"], [acceptedRenewal, "subscription-renewal-upcoming"]] as const) await baseDelivery.send({
        idempotencyKey: `subscription-notice:reminder:${ledgerFor(s.id).id}`, recipientReference: `client:${s.client}`, templateReference: template,
      });
    } finally { await baseReceipts.close(); }
    expect(acceptedKeys).toHaveLength(2);
    await runtime.query("SELECT public.subscription_apply_lifecycle_action($1,$2,$3,'resume','{}'::jsonb,now())", [resumedPause.client, `base-resume:${resumedPause.id}`, resumedPause.id]);
    // The old operator rail has no producer. Preserve a real base customer dunning row as well.
    const failed = await subject();
    const dunning = (await runtime.query("SELECT public.dunning_lifecycle_open_case($1,$2,NULL,$3,1,NULL,'temporary','declined',now(),100,'XXX','subscription-payment-failed-1','/recover') AS result",
      [`base-case:${failed.id}`, failed.id, failed.client])).rows[0].result;
    expect((await owner.query("SELECT id,recipient_kind FROM public.subscription_dunning_notifications")).rows).toEqual([{ id: dunning.notificationId, recipient_kind: "customer" }]);
    expect((await runner().apply()).applied).toContain("db/platform/migrations/20261106120000_subscription_notice_producers.sql");
    expect(await census()).toEqual(before); // No legacy row rewrite or re-key, including xmin.
    expect((await owner.query("SELECT renewal_at FROM public.subscription_reminder_ledger")).rows.every(row => row.renewal_at === null)).toBe(true);
    expect((await runtime.query("SELECT public.dunning_lifecycle_pause_reminder_dispatch(100) AS result")).rows[0].result).toMatchObject({ scanned: 2, queued: 0 });
    const sent: string[] = [], bound: { id: string; source: string; kind: string; payload: Record<string, unknown> }[] = [];
    const run = async () => {
      const receipts = createPostgresTransactionalDeliveryStore({ connectionString: runtimeUrl });
      const delivery = createTransactionalDelivery({ store: receipts, delivery: { async deliver(command) {
        sent.push(command.idempotencyKey); return { deliveryReference: `captured:upgrade:${command.idempotencyKey}` };
      } } });
      try {
        return await createPostgresLifecycleMessages({
          async withSession(work) {
            const fresh = new Pool({ connectionString: runtimeUrl, options: "-c timezone=Etc/GMT+5" });
            try { const db = await fresh.connect(); try { return await work(db); } finally { db.release(); } } finally { await fresh.end(); }
          },
          bind: async notice => { bound.push(notice); return { recipientReference: `client:${notice.clientId}`, templateReference: notice.templateSlug }; },
          delivery: { readReceipt: receipts.readReceipt, send: delivery.send },
        }).run(100);
      } finally { await receipts.close(); }
    };
    expect(await run()).toMatchObject({ failed: 0, skipped: 1, stale: 0 });
    expect(await run()).toEqual({ sent: 0, replayed: 0, requeued: 0, failed: 0, skipped: 0, busy: 0, stale: 0 });
    for (const s of [acceptedPause, resumedPause, acceptedRenewal]) expect(sent).not.toContain(`subscription-notice:reminder:${ledgerFor(s.id).id}`);
    for (const s of [openPause, openRenewal]) expect(sent.filter(key => key === `subscription-notice:reminder:${ledgerFor(s.id).id}`)).toHaveLength(1);
    expect(sent.filter(key => key === `subscription-notice:dunning:${dunning.notificationId}`)).toHaveLength(1);
    const open = bound.filter(row => row.id === ledgerFor(openPause.id).id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ source: "reminder", kind: "subscription.pause_reminder_due", payload: { pauseWindowId: windows.find(w => w.subscription_id === openPause.id)!.id } });
    expect(bound.some(row => row.id === ledgerFor(resumedPause.id).id)).toBe(false);
    expect((await owner.query("SELECT payload,status FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.notice.suppressed'", [resumedPause.id])).rows)
      .toEqual([{ payload: { reason: "pause_window_resolved", source: "reminder", sourceId: ledgerFor(resumedPause.id).id }, status: "processed" }]);
    expect((await owner.query("SELECT id FROM public.outbox_events WHERE event_type='subscription.pause_reminder_due'")).rows).toEqual([]);
    expect((await owner.query("SELECT source_id FROM public.subscription_notice_refusals WHERE source='reminder' AND source_id=$1", [ledgerFor(resumedPause.id).id])).rows).toEqual([]);
    expect(await census()).toEqual(before);
    expect((await owner.query("SELECT id,recipient_kind,status FROM public.subscription_dunning_notifications")).rows).toEqual([{ id: dunning.notificationId, recipient_kind: "customer", status: "sent" }]);
    for (const key of acceptedKeys) expect((await owner.query("SELECT state,attempt_count FROM public.transactional_delivery_receipts WHERE idempotency_key=$1", [key])).rows).toEqual([{ state: "accepted", attempt_count: 1 }]);
  } finally { await closePostgres(container, pools); rmSync(prefixRoot, { recursive: true, force: true }); }
}, 70_000);

it.each(["legacy", "qualified-v2", "qualified-admin"] as const)("uses elapsed at-risk bounds across a live DST transition on %s", async generation => {
  const container = await runPostgresContainer({ name: `notice-elapsed-${generation}-${process.pid}`, password });
  const pools: Pool[] = [];
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const owner = new Pool({ connectionString: container.connectionString }); pools.push(owner);
    const login = (role: string) => { const url = new URL(container.connectionString); url.username = role; return url.toString(); };
    let installation: PlatformPostgresInstallation = { generation: "legacy" };
    if (generation !== "legacy") {
      if (generation === "qualified-admin") await owner.query(`CREATE ROLE elapsed_m LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
        ALTER DATABASE postgres OWNER TO elapsed_m`);
      await owner.query(`CREATE ROLE elapsed_r LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
        CREATE ROLE elapsed_s LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      installation = { generation, roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: generation === "qualified-v2" ? "postgres" : "elapsed_m", runtimeLogin: "elapsed_r", restoreLogin: "elapsed_s" };
    }
    await install(login(installation.generation === "legacy" ? "postgres" : installation.migrationLogin), installation);
    const runtime = new Pool({ connectionString: login(generation === "legacy" ? "postgres" : "elapsed_r"),
      options: generation === "legacy" ? undefined : "-c role=service_role" }); pools.push(runtime);
    const db = await runtime.connect();
    try {
      await db.query("BEGIN");
      const clock = (await db.query(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
        extract(doy FROM ((now() AT TIME ZONE 'UTC')+interval '1 day'))::int-1 AS spring,
        extract(doy FROM ((now() AT TIME ZONE 'UTC')+interval '8 days'))::int-1 AS autumn`)).rows[0];
      // POSIX day numbers are zero-based. Tomorrow's UTC midnight springs forward;
      // the reverse transition is beyond both bounds, even across a year boundary.
      await db.query("SELECT set_config('TimeZone',$1,true)", [`XST0XDT,${clock.spring}/0,${clock.autumn}/0`]);
      expect((await db.query(`SELECT extract(timezone FROM now())::int AS before,
        extract(timezone FROM now()+interval '48 hours')::int AS after,
        (extract(epoch FROM(now()+make_interval(days=>2)-now()))/3600)::float8 AS calendar_lower,
        (extract(epoch FROM(now()+make_interval(days=>5)-now()))/3600)::float8 AS calendar_upper`)).rows)
        .toEqual([{ before: 0, after: 3600, calendar_lower: 47, calendar_upper: 119 }]);
      if (generation !== "legacy") expect((await db.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
        .toEqual([{ current_user: "service_role", rolsuper: false, rolbypassrls: false }]);
      const samples: { id: string; hours: number }[] = [];
      for (const hours of [47.5, 48, 48.5, 119.5, 120, 120.5]) {
        const client = randomUUID(), id = randomUUID(); samples.push({ id, hours });
        await owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
        await owner.query(`INSERT INTO public.subscriptions(id,client_id,status,cadence_days,next_cycle_at)
          VALUES($1,$2,'active',14,$3::timestamptz+$4::double precision*interval '1 hour')`, [id, client, clock.at, hours]);
        await owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'method_missing')", [id]);
      }
      const found = (await db.query("SELECT subscription_id FROM public.dunning_lifecycle_scan_at_risk_service(2,5,100)")).rows.map(row => row.subscription_id);
      for (const sample of samples) expect.soft(found.includes(sample.id), `renewal at ${sample.hours} elapsed hours`)
        .toBe(sample.hours >= 48 && sample.hours <= 120);
      expect(found).toEqual(samples.filter(sample => sample.hours >= 48 && sample.hours <= 120).map(sample => sample.id));
    } finally { await db.query("ROLLBACK"); db.release(); }
  } finally { await closePostgres(container, pools); }
}, postgresSetupTimeoutMs);
