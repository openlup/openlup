import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresCustomerOrderHistoryReadStore } from "@openlup/platform/account-support";
import { createPostgresRetryStore, createPostgresSubscriptionCommandStore, createPostgresSubscriptionCommands,
  createPostgresSubscriptionSaveOfferAcceptor, type SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import type { SubscriptionCommand, SubscriptionLifecycleTerms, SubscriptionSaveOfferPresentation } from "@openlup/platform/subscriptions/contracts";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { fixture as paidParcel } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { captureStoreJourney, journeySelection, storeJourneyResources } from "../helpers/storeJourney.js";
import { request } from "./subscriptionNativeFixture.js";
import { AT, call, later, lifecycleDeclined, lifecycleForward, lifecycleInstallation, lifecycleProfiles, lifecycleRows, lifecycleSubject, lifecycleTimeZone,
  type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

const terms: SubscriptionLifecycleTerms = { pauseDays: 9, pauseMonths: 2, slideMinDays: 4, slideMaxDays: 40, orderNowDelayMinutes: 17, reactivateDelayDays: 6 };
const offerPolicy = {
  offerPresentation: "ask_permission_first", defaultOffer: "skip", rescheduleOfferDays: 3,
  allowedPausePresets: ["2_weeks", "1_month", "indefinite"], preselectedPausePreset: "1_month",
} as const;
type Acceptor = ReturnType<typeof createPostgresSubscriptionSaveOfferAcceptor>;
type Accept = Parameters<Acceptor["accept"]>[0];
type OfferPolicy = Parameters<typeof createPostgresSubscriptionSaveOfferAcceptor>[0]["offerPolicy"];
const refused = (reason: string) => ({ outcome: "refused", reason });
const offerActor = (f: { actor: string; client: string }) => ({ kind: "customer" as const, actorId: f.actor, clientId: f.client });
function offerBinding(runtime: Pool, failBefore?: RegExp) {
  return { lifecycleTerms: terms,
    async withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>) {
      const db = await runtime.connect();
      try {
        await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const result = await work({ async query(sql, values) {
          if (failBefore?.test(sql)) await db.query("SELECT 1/0");
          return db.query(sql, values);
        } });
        await db.query("COMMIT");
        return result;
      } catch (error) { await db.query("ROLLBACK"); throw error; }
      finally { db.release(); }
    },
  };
}
function acceptor(runtime: Pool, policy: Partial<OfferPolicy> = {}, failBefore?: RegExp) {
  return createPostgresSubscriptionSaveOfferAcceptor({ ...offerBinding(runtime, failBefore), offerPolicy: { ...offerPolicy, ...policy } });
}
async function presented<Kind extends SubscriptionSaveOfferPresentation["kind"]>(service: Acceptor,
  f: { actor: string; client: string; subscription: string }, kind: Kind, now = AT) {
  const descriptor = (await service.readPresentations({ actor: offerActor(f), subscriptionIds: [f.subscription], now })).get(f.subscription);
  if (descriptor?.kind !== kind) throw new Error(`Expected a ${kind} presentation`);
  return descriptor as Extract<SubscriptionSaveOfferPresentation, { kind: Kind }>;
}
function acceptInput(f: { actor: string; client: string; subscription: string }, generation: string, now = AT) {
  return { actor: offerActor(f), subscriptionId: f.subscription, idempotencyKey: randomUUID(), now, generation };
}
const offerEvents = (db: Pool, id: string) => db.query(`SELECT event_type,payload,communication_subject_id FROM public.subscription_events
  WHERE subscription_id=$1 ORDER BY event_type`, [id]).then(result => result.rows);
const offerReceipts = (db: Pool, id: string) => db.query(`SELECT idempotency_key,command,command_fingerprint,result,status
  FROM public.subscription_command_receipts WHERE subscription_id=$1 ORDER BY idempotency_key`, [id]).then(result => result.rows);
const signatures = ["public.subscription_terminalize_unpaid_artifacts(uuid,timestamptz,text,text)",
  "public.subscription_pause_close_recovery(uuid,text,uuid,timestamptz)",
  "public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz,jsonb)",
  "public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz,jsonb)"];
// One container per catalogue, serialized by Vitest; deadlines include slow hosted PostgreSQL.
describe.each(lifecycleProfiles)("subscription lifecycle closure on %s", profile => {
  let env: LifecycleInstallation;
  beforeAll(async () => { env = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { if (env) await env.close(); }, postgresTeardownTimeoutMs);
  const invoke = (f: { actor: string; client: string; subscription: string }, key: string, action: string,
    payload: Record<string, unknown> = {}, now = AT, policy?: SubscriptionLifecycleTerms) => call(env.runtime, "subscription_command_apply",
    [f.actor.toUpperCase(), f.client.toUpperCase(), key, f.subscription.toUpperCase(), action, payload, now, ...(policy ? [policy] : [])]);

  it("cx1r_accept_once_and_recover: one concurrent skip, then the next real renewal occurrence", async () => {
    const f = await lifecycleSubject(env.owner), other = await lifecycleSubject(env.owner);
    const service = acceptor(env.runtime), offer = await presented(service, f, "skip");
    const requests = [1, 2].map(() => ({ ...acceptInput(f, offer.generation), kind: offer.kind }));
    const outcomes = await Promise.allSettled(requests.map(async input => {
      const result = await service.accept(input);
      if (result.outcome === "applied") throw new Error("response lost after commit");
      return result;
    }));
    const winner = requests[outcomes.findIndex(result => result.status === "rejected")];
    expect(outcomes).toContainEqual({ status: "rejected", reason: new Error("response lost after commit") });
    expect(outcomes).toContainEqual({ status: "fulfilled", value: refused("subscription_save_offer_consumed") });
    const [receipt] = await offerReceipts(env.owner, f.subscription);
    expect(await offerReceipts(env.owner, f.subscription)).toHaveLength(1);
    const digest = createHash("sha256").update(JSON.stringify(["cx1r-accept-v1", f.actor, f.client, f.subscription, offer.generation, "skip", []])).digest("hex");
    expect(receipt).toMatchObject({ idempotency_key: `save-offer-accept:v1:${winner.idempotencyKey}`,
      status: "applied", result: { cx1rRequestSha256: digest }, command: { payload: { actorKind: "customer", reason: null, confirmedChargeTiming: false } } });
    expect(await offerEvents(env.owner, f.subscription)).toEqual([
      { event_type: "subscription.customer_self_service.skip_next_cycle", communication_subject_id: null,
        payload: { action: "skip_next_cycle", payload: receipt.command.payload, reason: null } },
      { event_type: "subscription.save_offer_accepted", communication_subject_id: null, payload: { kind: "skip", nextCycleNumber: "2" } },
    ]);
    const off = acceptor(env.runtime, { offerPresentation: "off" });
    const replay = await off.accept({ ...winner, now: later(1) });
    expect(replay).toMatchObject({ outcome: "replayed", idempotencyKey: winner.idempotencyKey, eventId: receipt.result.eventId,
      commandFingerprint: receipt.command_fingerprint });
    expect(replay).not.toHaveProperty("cx1rRequestSha256");
    expect(await createPostgresSubscriptionCommandStore(offerBinding(env.runtime)).apply({
      actorId: f.actor, clientId: f.client, subscriptionId: f.subscription, idempotencyKey: receipt.idempotency_key,
      action: "skip_next_cycle", now: AT, payload: receipt.command.payload,
    })).not.toHaveProperty("cx1rRequestSha256");
    expect(new Date("nextCycleAt" in replay ? replay.nextCycleAt! : "").toISOString()).toBe(later(240 + 28 * 24));
    expect(await off.accept({ ...winner, actor: { ...winner.actor, clientId: other.client }, subscriptionId: other.subscription }))
      .toEqual(refused("subscription_command_idempotency_conflict"));
    const fresh = { ...winner, idempotencyKey: randomUUID() };
    expect(await off.accept(fresh)).toEqual(refused("subscription_save_offer_consumed"));
    expect(await invoke(f, `offer-slide:${f.subscription}`, "slide_next_cycle", { newNextCycleAt: later(160) })).toMatchObject({ status: "applied" });
    expect(await service.accept(fresh)).toEqual(refused("subscription_save_offer_consumed"));
    expect(await invoke(f, `offer-cancel:${f.subscription}`, "cancel")).toMatchObject({ status: "applied" });
    expect(await invoke(f, `offer-reactivate:${f.subscription}`, "reactivate", { confirmedChargeTiming: true }, AT, terms)).toMatchObject({ status: "applied" });
    expect(await service.accept(fresh)).toEqual(refused("subscription_save_offer_consumed"));

    const due = later(terms.reactivateDelayDays * 24);
    const identity = await call(env.runtime, "subscription_renewal_identity", [f.subscription, due]);
    const snapshot = { ...f.snapshot, scheduledAt: due };
    const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const op = await call(env.runtime, "subscription_claim_due_renewal", [identity, fingerprint, snapshot, "cx1r-witness", 300, due]);
    const attempt = `offer-renewal:${op.operationId}`;
    await call(env.runtime, "fulfillment_reserve_subscription_renewal", [op.operationId, op.claimToken, 900, due]);
    await call(env.runtime, "commerce_prepare_subscription_renewal", [op.operationId, op.claimToken, due]);
    await call(env.runtime, "commerce_acknowledge_subscription_renewal_attempt", [op.operationId, fingerprint, attempt, due]);
    await call(env.runtime, "commerce_record_subscription_renewal_outcome", [op.operationId, attempt, fingerprint, "succeeded", attempt, null, due]);
    const next = await presented(service, f, "skip", due);
    expect(next.generation).not.toBe(offer.generation);
    expect(await service.accept({ ...fresh, generation: next.generation, now: due })).toMatchObject({ outcome: "applied" });
    expect((await offerEvents(env.owner, f.subscription)).filter(event => event.event_type === "subscription.save_offer_accepted")
      .map(event => event.payload.nextCycleNumber).sort()).toEqual(["2", "3"]);
  }, 30_000);

  it("cx1r_accept_once_and_recover: exact reschedule terms, native refusals and no-op", async () => {
    const f = await lifecycleSubject(env.owner);
    await env.owner.query("UPDATE public.subscriptions SET next_cycle_at=next_cycle_at+interval '0.123456 seconds' WHERE id=$1", [f.subscription]);
    const service = acceptor(env.runtime, { defaultOffer: "reschedule" });
    const offer = await presented(service, f, "reschedule");
    expect(offer.newNextCycleAt).toBe("2026-09-14T12:00:00.123456Z");
    const unavailable = acceptor(env.runtime, { defaultOffer: "reschedule", rescheduleOfferDays: 100 });
    const input = { ...acceptInput(f, offer.generation), kind: offer.kind, newNextCycleAt: offer.newNextCycleAt };
    expect(await unavailable.accept(input)).toEqual(refused("subscription_save_offer_unavailable"));
    expect(await service.accept({ ...input, newNextCycleAt: "2026-09-14T12:00:00.123457Z" })).toEqual(refused("subscription_save_offer_stale"));
    expect(await offerReceipts(env.owner, f.subscription)).toEqual([]);
    expect(await service.accept(input)).toMatchObject({ outcome: "applied" });

    const second = await lifecycleSubject(env.owner);
    const noopService = acceptor(env.runtime, { defaultOffer: "reschedule", rescheduleOfferDays: 0 });
    const sameDay = await presented(noopService, second, "reschedule");
    const noopInput = { ...acceptInput(second, sameDay.generation), kind: sameDay.kind, newNextCycleAt: sameDay.newNextCycleAt };
    await env.owner.query("DELETE FROM public.subscription_method_states WHERE subscription_id=$1", [second.subscription]);
    const block = refused("subscription_command_payment_blocked");
    expect(await noopService.accept(noopInput)).toEqual(block);
    expect(await offerEvents(env.owner, second.subscription)).toEqual([]);
    await env.owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [second.subscription]);
    expect(await noopService.accept(noopInput)).toEqual(block);
    const fresh = { ...noopInput, idempotencyKey: randomUUID() };
    expect(await noopService.accept(fresh)).toMatchObject({ outcome: "noop", eventId: null });
    expect(await noopService.accept(fresh)).toMatchObject({ outcome: "replayed", eventId: null });
    expect(await offerEvents(env.owner, second.subscription)).toEqual([
      { event_type: "subscription.save_offer_accepted", communication_subject_id: null, payload: { kind: "reschedule", nextCycleNumber: "2" } },
    ]);
  }, 30_000);

  it("cx1r_accept_once_and_recover: pause presets share one occurrence and both private writes roll back", async () => {
    const f = await lifecycleSubject(env.owner), policy = { defaultOffer: "pause" } as const;
    const service = acceptor(env.runtime, policy), offer = await presented(service, f, "pause");
    expect(offer).toMatchObject({ preselectedPausePreset: "1_month", pausePresets: [
      { pausePreset: "2_weeks", duration: { unit: "days", value: 9 } },
      { pausePreset: "1_month", duration: { unit: "months", value: 2 } },
      { pausePreset: "indefinite", duration: { unit: "indefinite" } },
    ] });
    const input = { ...acceptInput(f, offer.generation), kind: offer.kind, ...offer.pausePresets[0] };
    const before = await lifecycleRows(env.owner);
    for (const sql of [/^UPDATE public\.subscription_command_receipts/, /'subscription\.save_offer_accepted'/]) {
      await expect(acceptor(env.runtime, policy, sql).accept(input)).rejects.toMatchObject({ code: "22012" });
      expect(await lifecycleRows(env.owner)).toEqual(before);
    }
    const result = await service.accept(input);
    expect(result).toMatchObject({ outcome: "applied", originalState: "paused" });
    expect((await env.owner.query("SELECT pause_preset,ends_at,reason FROM public.subscription_pause_windows WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ pause_preset: "2_weeks", ends_at: new Date(later(9 * 24)), reason: null }]);
    expect(await service.accept({ ...input, duration: { unit: "days", value: 10 } })).toEqual(refused("subscription_command_idempotency_conflict"));
    expect(await service.accept({ ...input, ...offer.pausePresets[2], idempotencyKey: randomUUID() })).toEqual(refused("subscription_save_offer_consumed"));
  }, 30_000);

  it("cx1r_legacy_command_compatibility: normalized cancel and scoped receipt isolation", async () => {
    const f = await lifecycleSubject(env.owner);
    const pair = { actor: offerActor(f), subscriptionId: f.subscription, idempotencyKey: randomUUID(), now: AT,
      action: "cancel", reason: null, confirmedChargeTiming: false,
      survey: { reasonCode: "schedule", comment: "  Later, please.  " }, saveOffer: null } as const;
    const binding = { ...offerBinding(env.runtime), futureTerms: async () => { throw new Error("unexpected_future_terms"); } };
    const commands = createPostgresSubscriptionCommands({ ...binding, retentionReasonCodes: ["schedule"] });
    const first = await commands.apply(pair);
    expect(first).toMatchObject({ outcome: "applied" });
    expect(await createPostgresSubscriptionCommands({ ...binding, retentionReasonCodes: [] }).apply(pair))
      .toEqual({ ...first, outcome: "replayed" });
    expect((await offerReceipts(env.owner, f.subscription))[0].command.payload.survey).toEqual({ reasonCode: "schedule", comment: "Later, please." });
    expect((await offerReceipts(env.owner, f.subscription))[0].result).not.toHaveProperty("cx1rRequestSha256");

    const second = await lifecycleSubject(env.owner), service = acceptor(env.runtime);
    const offer = await presented(service, second, "skip");
    const input: Accept = { ...acceptInput(second, offer.generation), kind: "skip" };
    const store = createPostgresSubscriptionCommandStore(binding);
    const raw = { actorId: second.actor, clientId: second.client, subscriptionId: second.subscription,
      idempotencyKey: `save-offer-accept:v1:${input.idempotencyKey}`, now: AT, action: "skip_next_cycle",
      payload: { actorKind: "customer", reason: null, confirmedChargeTiming: false } };
    expect(await store.apply(raw)).toMatchObject({ status: "applied" });
    expect(await service.accept(input)).toEqual(refused("subscription_command_idempotency_conflict"));
  }, 30_000);

  it("preserves replacement headers/ACLs, closes every created ACL, and replays the upgrade", async () => {
    // The full suffix also pins the pause function's search path.
    const expectedCatalog = env.before.map(row => row.signature === "customer_subscription_pause_as_actor(uuid,text,text,text)"
      ? { ...row, proconfig: ["search_path=pg_catalog, pg_temp"] }
      : row);
    expect(env.after).toEqual(expectedCatalog);
    expect(env.bodiesBefore).toHaveLength(3);
    expect(env.bodiesAfter).toHaveLength(7);
    expect(await env.runner.apply()).toEqual({ applied: [] });
    const acl = (await env.owner.query(`SELECT p.oid::regprocedure::text AS signature,p.proacl::text AS acl,p.proowner::regrole::text AS owner,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
      has_function_privilege(to_regrole('service_role'),p.oid,'EXECUTE') AS service,coalesce((SELECT bool_or(x.grantee=0 AND x.privilege_type='EXECUTE')
       FROM aclexplode(p.proacl) x),false) AS public FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY signature`, [signatures])).rows;
    expect(acl).toHaveLength(4);
    for (const entry of acl) expect(entry).toMatchObject({ prosecdef: false, proconfig: ["search_path=pg_catalog"], anon: false, authenticated: false, service: profile === "legacy" ? null : true, public: false });
    const view = (await env.owner.query(`SELECT has_table_privilege('anon','public.subscription_retention_outcomes','SELECT') AS anon,
      has_table_privilege('authenticated','public.subscription_retention_outcomes','SELECT') AS authenticated,
      has_table_privilege(to_regrole('service_role'),'public.subscription_retention_outcomes','SELECT') AS service`)).rows[0];
    expect(view).toEqual({ anon: false, authenticated: false, service: profile === "legacy" ? null : false });
    const deferred = (await env.owner.query(`SELECT tgname,tgrelid::regclass::text AS relation,tgdeferrable,tginitdeferred,
      pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgdeferrable AND tgrelid=ANY($1::regclass[]) ORDER BY tgname`, [[
      "public.commerce_orders", "public.commerce_settlement_intents", "public.subscription_retry_obligations", "public.subscription_cycles",
      "public.fulfillment_inventory_reservations", "public.subscription_renewal_operations", "public.subscription_dunning_cases",
      "public.commerce_checkout_recovery_tokens", "public.subscription_dunning_notifications"]])).rows;
    expect(deferred.map(row => row.tgname)).toEqual(["trg_commerce_orders_line_sum"]);
    mkdirSync(".context/scratch/c21", { recursive: true });
    writeFileSync(`.context/scratch/c21/catalog-${profile}.json`, JSON.stringify({ before: env.before, after: env.after, guardBefore: env.guardBefore, guardAfter: env.guardAfter, bodiesBefore: env.bodiesBefore, bodiesAfter: env.bodiesAfter, deferred, acl, view }, null, 2));
  }, 30_000);

  it("preserves the installed order money guard byte for byte around catalogue checks", () => {
    const [mainGuard] = env.guardBefore.function;
    const [catalogueGuard] = env.guardAfter.function;
    // Strip only the catalogue checks. This compares the entire
    // remaining body, including the declared total, line sum and refusal.
    const moneyBody = catalogueGuard!.body
      .replace("    PERFORM public.catalog_order_line_sum_acceptance(v_order_id, p_old_header => OLD, p_new_header => NEW);\n", "")
      .replace(`    -- Transfer runs under the owning migration login. Ordinary table writers
    -- may not add governed purchase lines outside the native draft owner.
    IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid=TG_RELID),'USAGE') THEN
      IF TG_OP='INSERT' THEN PERFORM public.catalog_admission_guard_purchase_item(NEW);
      ELSIF (OLD.order_id,OLD.sku_id,OLD.quantity) IS DISTINCT FROM (NEW.order_id,NEW.sku_id,NEW.quantity) THEN
        PERFORM public.catalog_admission_guard_purchase_item(NEW);
      END IF;
    END IF;
`, "")
      .replace("    IF TG_OP = 'UPDATE' THEN\n      PERFORM public.catalog_order_line_sum_acceptance(v_order_id, OLD.order_id);\n    END IF;\n", "")
      .replace("  PERFORM public.catalog_order_line_sum_acceptance(v_order_id);\n", "");
    expect(moneyBody).toBe(mainGuard!.body);
    expect(catalogueGuard!.definition.replace(catalogueGuard!.body, "")).toBe(mainGuard!.definition.replace(mainGuard!.body, ""));
    expect(env.guardAfter.triggers).toEqual(env.guardBefore.triggers);
  });

  it.each(["UTC", "Etc/GMT-9", "Etc/GMT+5"])("closes pause recovery once and preserves exact replay in %s", async zone => {
    const f = await lifecycleDeclined(env.owner);
    await env.runtime.query("SELECT set_config('TimeZone',$1,false)", [zone]);
    const input = { pausePreset: "2_weeks", survey: { reasonCode: "schedule", comment: "Later", acceptedSaveOfferId: "pause-custom" },
      saveOffer: { offerId: "pause-custom", kind: "pause", accepted: true } };
    const first = await invoke(f, `pause:${f.subscription}`, "pause", input);
    expect(first).toMatchObject({ status: "applied", subscriptionStatus: "paused" });
    const state = (await env.owner.query(`SELECT c.status,c.next_retry_at,c.updated_at,
      (SELECT status FROM public.subscription_cycles WHERE id=$2) AS cycle,
      (SELECT status FROM public.commerce_orders WHERE id=$3) AS orders,
      (SELECT status FROM public.commerce_settlement_intents WHERE id=$4) AS intent,
      (SELECT next_retry_at FROM public.subscription_retry_obligations WHERE renewal_operation_id=$5) AS retry,
      (SELECT revoked_at IS NOT NULL FROM public.commerce_checkout_recovery_tokens WHERE id=$6) AS revoked
      FROM public.subscription_dunning_cases c WHERE id=$1`, [f.caseId, f.original.cycleId, f.original.orderId, f.original.settlementIntentId, f.operation, f.token])).rows[0];
    expect(state).toEqual({ status: "paused", next_retry_at: null, updated_at: new Date(AT), cycle: "skipped", orders: "cancelled", intent: "cancelled", retry: null, revoked: true });
    expect((await env.owner.query("SELECT recipient_kind,status,error,recovery_url_path FROM public.subscription_dunning_notifications WHERE case_id=$1 ORDER BY recipient_kind", [f.caseId])).rows)
      .toEqual([
        { recipient_kind: "customer", status: "skipped", error: "subscription_paused", recovery_url_path: null },
        { recipient_kind: "operator", status: "skipped", error: "missing_critical_notification_recipient", recovery_url_path: null },
      ]);
    await expect(call(env.runtime, "subscription_retry_authorize_recovery", [f.operation, f.token, "method-1", "evidence", later(1)])).rejects.toThrow("not_authorized");
    const before = await lifecycleRows(env.owner);
    expect(await invoke(f, `pause:${f.subscription}`, "pause", input, later(30), terms)).toMatchObject({ ...first, status: "replayed", originalStatus: "applied" });
    expect(await lifecycleRows(env.owner)).toEqual(before);
    expect((await env.owner.query("SELECT cancel_reason_code,save_offer_accepted FROM public.subscription_retention_outcomes WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ cancel_reason_code: "schedule", save_offer_accepted: true }]);
    expect(await invoke(f, `resume:${f.subscription}`, "resume", {}, later(50))).toMatchObject({ status: "applied", subscriptionStatus: "active" });
    expect((await env.owner.query("SELECT status FROM public.subscription_cycles WHERE id=$1", [f.original.cycleId])).rows[0].status).toBe("skipped");
    await env.runtime.query("SELECT set_config('TimeZone',$1,false)", [lifecycleTimeZone]);
  }, 30_000);

  it("keeps skip/slide refused during dunning and rolls an invalid pause entirely back", async () => {
    const f = await lifecycleDeclined(env.owner);
    const before = await lifecycleRows(env.owner, true);
    for (const [action, payload, reason] of [["skip_next_cycle", {}, "subscription_command_payment_blocked"],
      ["slide_next_cycle", { newNextCycleAt: later(240) }, "subscription_command_payment_blocked"],
      ["pause", { pausePreset: "invalid" }, "subscription_lifecycle_invalid_transition"]] as const) {
      expect(await invoke(f, `${action}:${f.subscription}`, action, payload)).toMatchObject({ status: "refused", reason });
      expect(await lifecycleRows(env.owner, true)).toEqual(before);
    }
  }, 30_000);

  it("terminalizes cancellation including exhausted cycles and never resurrects them on reactivation", async () => {
    const f = await lifecycleDeclined(env.owner);
    await env.owner.query("UPDATE public.subscription_retry_obligations SET next_retry_at=NULL,retry_attempt=4 WHERE renewal_operation_id=$1", [f.operation]);
    const payload = { reason: "fallback", survey: { reasonCode: "schedule", comment: "Later", acceptedSaveOfferId: null },
      saveOffer: { offerId: "reschedule", kind: "reschedule", accepted: false, externalOfferRef: "opaque" } };
    expect(await invoke(f, `cancel:${f.subscription}`, "cancel", payload)).toMatchObject({ status: "applied", subscriptionStatus: "cancelled" });
    await env.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [f.actor, `${f.actor}@example.invalid`]);
    await env.owner.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.client, f.actor]);
    const history = createPostgresCustomerOrderHistoryReadStore(env.runtime, { principalId: f.actor.toUpperCase(), clientId: f.client.toUpperCase(), readInvoiceSummaries: async () => new Map() });
    expect(await history.readPaymentStatuses([f.original.orderId.toUpperCase()])).toEqual(new Map([[f.original.orderId, "cancelled"]]));
    const cancelled = await lifecycleRows(env.owner);
    expect(await invoke(f, `cancel:${f.subscription}`, "cancel", payload, later(1))).toMatchObject({ status: "replayed" });
    expect(await lifecycleRows(env.owner)).toEqual(cancelled);
    expect(await invoke(f, `reactivate:${f.subscription}`, "reactivate", { confirmedChargeTiming: true }, later(2))).toMatchObject({ status: "applied", subscriptionStatus: "active", templateVersion: 2 });
    expect((await env.owner.query("SELECT status FROM public.subscription_cycles WHERE id=$1", [f.original.cycleId])).rows[0].status).toBe("cancelled");
    expect((await env.owner.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.original.orderId])).rows[0].status).toBe("cancelled");
    expect((await env.owner.query("SELECT status FROM public.commerce_settlement_intents WHERE id=$1", [f.original.settlementIntentId])).rows[0].status).toBe("cancelled");
    expect((await env.owner.query("SELECT ended_at,cancellation_reason FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0]).toEqual({ ended_at: null, cancellation_reason: null });
    expect((await env.owner.query("SELECT cancel_reason_code,cancel_comment,accepted_save_offer_id,save_offer_id,save_offer_kind,save_offer_accepted,external_offer_ref FROM public.subscription_retention_outcomes WHERE subscription_id=$1", [f.subscription])).rows)
      .toEqual([{ cancel_reason_code: "schedule", cancel_comment: "Later", accepted_save_offer_id: null, save_offer_id: "reschedule", save_offer_kind: "reschedule", save_offer_accepted: false, external_offer_ref: "opaque" }]);
  }, 30_000);

  it.each(["2_weeks", "1_month", "indefinite"])("uses changed trusted pause terms for %s with calendar arithmetic", async preset => {
    const f = await lifecycleSubject(env.owner), now = "2026-01-31T12:00:00.123456Z";
    expect(await invoke(f, `terms:${f.subscription}`, "pause", { pausePreset: preset, terms: { pauseDays: 999 } }, now, terms)).toMatchObject({ status: "applied" });
    const row = (await env.owner.query("SELECT to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS ends FROM public.subscription_pause_windows WHERE subscription_id=$1", [f.subscription])).rows[0];
    expect(row.ends).toBe(preset === "2_weeks" ? "2026-02-09T12:00:00.123456Z" : preset === "1_month" ? "2026-03-31T12:00:00.123456Z" : null);
  }, 30_000);

  it.each(["skip_next_cycle", "slide_next_cycle", "order_now"])("admits cutoff minus one microsecond and exact cutoff, refuses plus one for %s", async action => {
    for (const delta of [-1, 0, 1]) {
      const f = await lifecycleSubject(env.owner);
      await env.owner.query("UPDATE public.subscriptions SET next_cycle_at='2026-09-10T12:00:00.123456Z',edit_window_hours=48 WHERE id=$1", [f.subscription]);
      const at = `2026-09-08T12:00:00.${123456 + delta}Z`;
      const payload = action === "slide_next_cycle" ? { newNextCycleAt: "2026-09-19T12:00:00Z" } : { confirmedChargeTiming: true };
      expect(await invoke(f, `cutoff:${f.subscription}`, action, payload, at)).toMatchObject(delta > 0
        ? { status: "refused", reason: "subscription_edit_window_closed" } : { status: "applied" });
    }
  }, 30_000);

  it("applies configured O delays without payment dispatch and binds replay to the accepted command", async () => {
    const f = await lifecycleSubject(env.owner);
    expect(await invoke(f, `unconfirmed:${f.subscription}`, "order_now")).toMatchObject({ status: "refused", reason: "subscription_command_charge_timing_not_confirmed" });
    const first = await invoke(f, `order:${f.subscription}`, "order_now", { confirmedChargeTiming: true }, AT, terms);
    expect(first).toMatchObject({ status: "applied" });
    expect(new Date(first.nextCycleAt).toISOString()).toBe("2026-09-01T12:17:00.000Z");
    const before = await lifecycleRows(env.owner);
    expect(await invoke(f, `order:${f.subscription}`, "order_now", { confirmedChargeTiming: true }, later(1), { ...terms, orderNowDelayMinutes: 99 })).toMatchObject({ ...first, status: "replayed" });
    expect(await lifecycleRows(env.owner)).toEqual(before);
    expect(await invoke(f, `order:${f.subscription}`, "reactivate", { confirmedChargeTiming: true })).toMatchObject({ status: "refused", reason: "subscription_command_idempotency_conflict" });
    await invoke(f, `cancel:${f.subscription}`, "cancel");
    const result = await invoke(f, `reactivate:${f.subscription}`, "reactivate", { confirmedChargeTiming: true }, AT, terms);
    expect(new Date(result.nextCycleAt).toISOString()).toBe(later(144));
    expect((await env.owner.query("SELECT id FROM public.commerce_settlement_intents WHERE order_id IN (SELECT id FROM public.commerce_orders WHERE subscription_cycle_id IN (SELECT id FROM public.subscription_cycles WHERE subscription_id=$1))", [f.subscription])).rows).toEqual([]);
  }, 30_000);

  it("uses alternate slide bounds and preserves same-day no-op before a closed window", async () => {
    const f = await lifecycleSubject(env.owner);
    expect(await invoke(f, `short:${f.subscription}`, "slide_next_cycle", { newNextCycleAt: later(72) }, AT, terms)).toMatchObject({ status: "refused", reason: "subscription_lifecycle_invalid_slide" });
    expect(await invoke(f, `valid:${f.subscription}`, "slide_next_cycle", { newNextCycleAt: later(120), reason: "save_offer=reschedule;cancel_reason=schedule" }, AT, terms)).toMatchObject({ status: "applied" });
    expect(await invoke(f, `noop:${f.subscription}`, "slide_next_cycle", { newNextCycleAt: later(121) }, later(119), terms)).toMatchObject({ status: "noop" });
    expect((await env.owner.query("SELECT event_id FROM public.subscription_retention_outcomes WHERE subscription_id=$1", [f.subscription])).rows).toEqual([]);
  }, 30_000);

  it("rejects malformed trusted terms after receipt replay and never widens the action set", async () => {
    const f = await lifecycleSubject(env.owner), payload = { pausePreset: "indefinite" };
    expect(await invoke(f, `valid:${f.subscription}`, "pause", payload, AT, terms)).toMatchObject({ status: "applied" });
    const invalid = { ...terms, pauseDays: 0 };
    expect(await invoke(f, `valid:${f.subscription}`, "pause", payload, later(1), invalid)).toMatchObject({ status: "replayed" });
    expect(await invoke(f, `invalid:${f.subscription}`, "resume", {}, AT, invalid)).toMatchObject({ status: "refused", reason: "subscription_command_invalid_input" });
    expect(await invoke(f, `unknown:${f.subscription}`, "invented_action", {}, AT, terms)).toMatchObject({ status: "refused", reason: "subscription_command_unsupported_action" });
  }, 30_000);

  it("fences live claims and busy preparation before committing any pause closure", async () => {
    const f = await lifecycleDeclined(env.owner);
    const db = await env.owner.connect();
    try {
      await db.query("BEGIN"); await db.query("SELECT id FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE", [f.operation]);
      const before = await lifecycleRows(env.owner, true);
      expect(await invoke(f, `busy:${f.subscription}`, "pause", { pausePreset: "indefinite" })).toMatchObject({ status: "refused", reason: "subscription_command_operation_busy" });
      expect(await lifecycleRows(env.owner, true)).toEqual(before);
      await db.query("ROLLBACK");
      await call(env.owner, "subscription_retry_prepare", [f.operation, `prepared:${f.operation}`, request(f), later(24)]);
      const prepared = await lifecycleRows(env.owner, true);
      expect(await invoke(f, `prepared-pause:${f.subscription}`, "pause", {}, later(24))).toMatchObject({ status: "refused", reason: "subscription_command_payment_blocked" });
      expect(await lifecycleRows(env.owner, true)).toEqual(prepared);
    } finally { await db.query("ROLLBACK"); db.release(); }
  }, 30_000);

  it("serializes pause behind actual renewal preparation and refuses its irreversible attempt", async () => {
    const f = await lifecycleSubject(env.owner);
    const snapshot = { ...f.snapshot, scheduledAt: later(240) };
    const identity = await call(env.owner, "subscription_renewal_identity", [f.subscription, later(240)]);
    const op = await call(env.owner, "subscription_claim_due_renewal", [identity, f.fingerprint, snapshot, "lifecycle-race", 300, later(240)]);
    await call(env.owner, "fulfillment_reserve_subscription_renewal", [op.operationId, op.claimToken, 900, later(240)]);
    const db = await env.owner.connect();
    let pending: Promise<Record<string, unknown>> | undefined;
    try {
      await db.query("BEGIN");
      await call(db, "commerce_prepare_subscription_renewal", [op.operationId, op.claimToken, later(240)]);
      pending = invoke(f, `prepare-race:${f.subscription}`, "pause", {}, later(240));
      let blocked = false;
      for (let n = 0; n < 100 && !blocked; n++) blocked = (await env.owner.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%subscription_command_apply%') AS blocked`)).rows[0].blocked;
      expect(blocked).toBe(true);
      await db.query("COMMIT");
      expect(await pending).toMatchObject({ status: "refused", reason: "subscription_command_payment_blocked" });
      expect((await env.owner.query("SELECT status FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0].status).toBe("active");
      expect((await env.owner.query("SELECT id FROM public.subscription_pause_windows WHERE subscription_id=$1", [f.subscription])).rows).toEqual([]);
    } finally { await db.query("ROLLBACK"); db.release(); if (pending) await pending.catch(() => undefined); }
  }, 30_000);

  it("fences sandbox dispatch under the order lock and unresolved observations after commit", async () => {
    const f = await lifecycleDeclined(env.owner);
    await env.owner.query("UPDATE public.commerce_settlement_intents SET channel_key='sandbox' WHERE id=$1", [f.original.settlementIntentId]);
    const db = await env.owner.connect();
    try {
      await db.query("BEGIN");
      const attempt = await call(db, "payment_simulator_begin_attempt", [`sandbox:${f.subscription}`, f.original.settlementIntentId, "a".repeat(64), {}, AT]);
      // Sandbox dispatch holds the order fence, leaving lifecycle roots free
      // so pause reaches its existing NOWAIT refusal before dispatch commits.
      await env.owner.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE NOWAIT", [f.subscription]);
      await env.owner.query("SELECT id FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE NOWAIT", [f.operation]);
      expect(await invoke(f, `dispatch-race:${f.subscription}`, "pause")).toMatchObject({ status: "refused", reason: "subscription_command_operation_busy" });
      await db.query("COMMIT");
      for (const state of ["dispatched", "indeterminate"] as const) {
        if (state === "indeterminate") {
          await db.query("BEGIN");
          await call(db, "payment_simulator_record_observation", [attempt.id, `observation:${f.subscription}`, "b".repeat(64), state, later(1)]);
          await env.owner.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE NOWAIT", [f.subscription]);
          await env.owner.query("SELECT id FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE NOWAIT", [f.operation]);
          expect(await invoke(f, `observation-race:${f.subscription}`, "pause")).toMatchObject({ status: "refused", reason: "subscription_command_operation_busy" });
          await db.query("COMMIT");
        }
        const before = await lifecycleRows(env.owner, true);
        expect(await invoke(f, `${state}:${f.subscription}`, "pause", {}, later(1))).toMatchObject({ status: "refused", reason: "subscription_command_payment_blocked" });
        expect(await lifecycleRows(env.owner, true)).toEqual(before);
      }
    } finally { await db.query("ROLLBACK"); db.release(); }
  }, 30_000);

  it.each(["pause", "cancel"])("retains committed capture evidence for review when %s precedes truth ingress", async action => {
    const f = await lifecycleDeclined(env.owner), at = later(1);
    await env.owner.query("UPDATE public.commerce_settlement_intents SET channel_key='sandbox' WHERE id=$1", [f.original.settlementIntentId]);
    const attempt = await call(env.runtime, "payment_simulator_begin_attempt", [`capture:${f.subscription}`, f.original.settlementIntentId, "a".repeat(64), {}, AT]);
    const observation = await call(env.runtime, "payment_simulator_record_observation", [attempt.id, `capture:${attempt.id}`, "b".repeat(64), "captured", at]);
    expect((await env.owner.query("SELECT state FROM public.subscription_renewal_operations WHERE id=$1", [f.operation])).rows[0].state).toBe("refused");
    expect((await env.owner.query("SELECT state FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1", [f.operation])).rows[0].state).toBe("waiting");
    expect((await env.owner.query("SELECT id FROM public.payment_truth_events WHERE settlement_intent_id=$1", [f.original.settlementIntentId])).rows).toEqual([]);
    expect(await invoke(f, `capture-${action}:${f.subscription}`, action, action === "pause" ? { pausePreset: "indefinite" } : {}, at))
      .toMatchObject({ status: "applied" });
    expect((await env.owner.query(`SELECT c.status AS cycle,o.status AS orders,i.status AS intent
      FROM public.subscription_cycles c JOIN public.commerce_orders o ON o.subscription_cycle_id=c.id
      JOIN public.commerce_settlement_intents i ON i.order_id=o.id WHERE i.id=$1`, [f.original.settlementIntentId])).rows)
      .toEqual([{ cycle: action === "pause" ? "skipped" : "cancelled", orders: "cancelled", intent: "cancelled" }]);
    const evidence = { sourceKind: "accepted_event", sourceReference: observation.id, attemptRef: attempt.id,
      observedStatus: "captured", observedAt: at, payloadFingerprint: "b".repeat(64) };
    const ingress = () => call(env.runtime, "payment_truth_ingest_event", [`sandbox:${observation.id}`, "c".repeat(64),
      `ingest:${observation.id}`, f.original.settlementIntentId, "captured", f.snapshot.totalAmountMinor, "XXX", at,
      null, null, evidence, "payment_failed", "/recover", "payment_recovered"]);
    expect(await ingress()).toMatchObject({ event: { applicationStatus: "review_required", outcome: "captured", replayed: false },
      financial: { orderStatus: "cancelled" }, effects: { paymentResultRecorded: false } });
    const beforeReplay = await lifecycleRows(env.owner);
    expect(await ingress()).toMatchObject({ event: { applicationStatus: "review_required", outcome: "captured", replayed: true },
      financial: { orderStatus: "cancelled" }, effects: { paymentResultRecorded: false } });
    expect(await lifecycleRows(env.owner)).toEqual(beforeReplay);
    expect((await env.owner.query(`SELECT count(*)::int AS count, bool_and(outcome='captured' AND review_required_at IS NOT NULL
      AND settlement_transition_id IS NULL AND amount_minor=$2) AS retained FROM public.payment_truth_events
      WHERE settlement_intent_id=$1`, [f.original.settlementIntentId, f.snapshot.totalAmountMinor])).rows).toEqual([{ count: 1, retained: true }]);
    expect((await env.owner.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [f.original.settlementIntentId])).rows).toEqual([]);
  }, 30_000);

  it("keeps public late recovery non-paid after customer pause closes a captured renewal", async () => {
    const f = await lifecycleDeclined(env.owner), at = later(1);
    await env.owner.query("UPDATE public.commerce_settlement_intents SET channel_key='sandbox' WHERE id=$1", [f.original.settlementIntentId]);
    const attempt = await call(env.runtime, "payment_simulator_begin_attempt", [`public-capture:${f.subscription}`, f.original.settlementIntentId, "a".repeat(64), {}, AT]);
    const observation = await call(env.runtime, "payment_simulator_record_observation", [attempt.id, `public-capture:${attempt.id}`, "b".repeat(64), "captured", at]);
    const port = createPostgresSubscriptionCommands({ futureTerms: async () => { throw new Error("edit_not_selected"); },
      withTransaction: async work => { const db = await env.runtime.connect(); try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
        catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); } } });
    expect(await port.apply({ actor: { kind: "customer", actorId: f.actor, clientId: f.client }, subscriptionId: f.subscription,
      idempotencyKey: `public-pause:${f.subscription}`, now: at, action: "pause", pausePreset: "indefinite", reason: null, survey: null, saveOffer: null })).toMatchObject({ outcome: "applied" });
    const effects = async () => (await env.owner.query(`SELECT jsonb_build_object(
      'counter',(SELECT next_cycle_number FROM public.subscription_renewal_terms WHERE subscription_id=$1),
      'stock',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.fulfillment_inventory_reservations r WHERE renewal_operation_id=$2),
      'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb) FROM public.subscription_retry_receipts r
        WHERE obligation_id=(SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$2) AND kind='recovery'),
      'obligation',(SELECT to_jsonb(o) FROM public.subscription_retry_obligations o WHERE renewal_operation_id=$2)) AS value`, [f.subscription, f.operation])).rows[0].value;
    const before = await effects();
    expect(before.counter).toBe(2);
    expect(before.stock).toEqual([expect.objectContaining({ status: "released", expires_at: null })]);
    expect(before.receipts).toEqual([]);
    expect((await env.owner.query("SELECT id FROM public.payment_truth_events WHERE settlement_intent_id=$1", [f.original.settlementIntentId])).rows).toEqual([]);
    const input = { evidenceKey: `sandbox:${observation.id}`, occurredAt: at, firstRecordedAt: at, externalRef: `capture:${observation.id}`,
      amountMinor: f.snapshot.totalAmountMinor, currency: "XXX", template: "payment_recovered", sourceKind: "accepted_event" as const,
      sourceReference: observation.id, attemptRef: attempt.id, observedStatus: "captured" as const, observedAt: at, payloadFingerprint: "b".repeat(64) };
    const store = createPostgresRetryStore(env.runtime), key = `public-recover:${f.operation}`;
    const result = await store.recordRecovery(f.operation, key, input);
    expect(result).toMatchObject({ state: "waiting", disposition: "payment_failed" });
    expect(await effects()).toEqual(before);
    const truth = (await env.owner.query("SELECT id FROM public.payment_truth_events WHERE settlement_intent_id=$1", [f.original.settlementIntentId])).rows;
    expect(truth).toHaveLength(1);
    expect(await call(env.owner, "payment_truth_readback", [truth[0].id, false])).toMatchObject({
      event: { applicationStatus: "review_required", outcome: "captured" }, effects: { paymentResultRecorded: false },
      financial: { orderStatus: "cancelled", settlementStatus: "cancelled" } });
    const after = await lifecycleRows(env.owner);
    expect(await store.recordRecovery(f.operation, key, input)).toEqual(result);
    expect(await effects()).toEqual(before);
    expect(await lifecycleRows(env.owner)).toEqual(after);
    expect((await env.owner.query("SELECT id FROM public.commerce_settlement_transitions WHERE intent_id=$1 AND outcome='succeeded'", [f.original.settlementIntentId])).rows).toEqual([]);
  }, 30_000);

  it("rolls resume forward by whole stored cadences without creating a delivery fact", async () => {
    const f = await lifecycleSubject(env.owner);
    await env.owner.query("UPDATE public.subscriptions SET next_cycle_at='2026-07-07T12:00:00Z' WHERE id=$1", [f.subscription]);
    expect(await invoke(f, `roll-pause:${f.subscription}`, "pause", { pausePreset: "indefinite" })).toMatchObject({ status: "applied" });
    const resumed = await invoke(f, `roll-resume:${f.subscription}`, "resume");
    expect(new Date(resumed.nextCycleAt).toISOString()).toBe(later(28 * 24));
    const before = await lifecycleRows(env.owner);
    expect(await invoke(f, `roll-resume:${f.subscription}`, "resume", {}, later(1))).toMatchObject({ status: "replayed" });
    expect(await lifecycleRows(env.owner)).toEqual(before);
  }, 30_000);

  it("keeps a sending notice intact and repairs actor pause without changing actor authority", async () => {
    const f = await lifecycleDeclined(env.owner), principal = randomUUID();
    await env.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
    await env.owner.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.client, principal]);
    const original = readFileSync("db/platform/migrations/20260812100000_customer_subscription_pause_actor.sql", "utf8");
    const body = original.slice(original.indexOf("CREATE FUNCTION"), original.indexOf("\n$$;") + 4).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
    const db = await env.owner.connect();
    try {
      await db.query("BEGIN"); await db.query(body); await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal })]);
      await call(db, "customer_subscription_pause_as_actor", [f.subscription.toUpperCase(), `before:${f.subscription}`, "indefinite", null]);
      await db.query("RESET ROLE");
      expect((await db.query("SELECT status FROM public.subscription_dunning_cases WHERE id=$1", [f.caseId])).rows[0].status).toBe("open");
      expect((await db.query("SELECT next_retry_at IS NOT NULL AS due FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1", [f.operation])).rows[0].due).toBe(true);
      await db.query("ROLLBACK");
    } finally { await db.query("ROLLBACK"); db.release(); }
    await env.owner.query("UPDATE public.subscription_dunning_notifications SET status='sending',claim_token=$2,lease_expires_at=$3 WHERE case_id=$1", [f.caseId, randomUUID(), later(1)]);
    const key = `actor:${f.subscription}`, derived = `command:${createHash("sha256").update(`${principal}:${key}`).digest("hex")}`;
    const beforeReserved = await lifecycleRows(env.owner);
    await expect(env.actor(principal, actor => call(actor, "customer_subscription_pause_as_actor", [f.subscription, derived, "indefinite", null])))
      .rejects.toMatchObject({ code: "22023", message: "subscription_command_reserved_idempotency_key" });
    expect(await lifecycleRows(env.owner)).toEqual(beforeReserved);
    await env.actor(principal, actor => call(actor, "customer_subscription_pause_as_actor", [f.subscription.toUpperCase(), key, "indefinite", null]));
    expect((await env.owner.query("SELECT idempotency_key,payload#>'{payload,commandKeyIdentity}' AS identity FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.customer_self_service.pause'", [f.subscription])).rows)
      .toEqual([{ idempotency_key: derived, identity: { derivation: "principal-sha256.v1", actorId: principal } }]);
    const beforeReplay = await lifecycleRows(env.owner);
    expect((await env.actor(principal, actor => call(actor, "customer_subscription_pause_as_actor", [f.subscription, key, "indefinite", null]))).subscriptionAction.status).toBe("replayed");
    expect(await lifecycleRows(env.owner)).toEqual(beforeReplay);
    expect((await env.owner.query("SELECT status,next_retry_at FROM public.subscription_dunning_cases WHERE id=$1", [f.caseId])).rows[0]).toEqual({ status: "paused", next_retry_at: null });
    expect((await env.owner.query("SELECT status FROM public.subscription_dunning_notifications WHERE case_id=$1", [f.caseId])).rows[0].status).toBe("sending");
    expect((await env.owner.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.original.orderId])).rows[0].status).toBe("cancelled");
    expect((await env.owner.query("SELECT status FROM public.commerce_settlement_intents WHERE id=$1", [f.original.settlementIntentId])).rows[0].status).toBe("cancelled");
  }, 30_000);

  it("refuses an inconsistent own order with 23514 inside actor authority and rolls the entire transaction back", async () => {
    const f = await lifecycleDeclined(env.owner), principal = randomUUID();
    await env.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
    await env.owner.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.client, principal]);
    const before = await lifecycleRows(env.owner), db = await env.owner.connect();
    try {
      await db.query("BEGIN");
      // Fixture-owned corruption is part of this transaction, never an actor grant.
      await db.query("UPDATE public.commerce_order_items SET quantity=quantity+1,line_amount_minor=(quantity+1)*unit_amount_minor WHERE order_id=$1", [f.original.orderId]);
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal })]);
      await expect(call(db, "customer_subscription_pause_as_actor", [f.subscription.toUpperCase(), `mismatch:${f.subscription}`, "indefinite", null]))
        .rejects.toMatchObject({ code: "23514", message: "commerce_order_line_sum_mismatch",
          detail: `order ${f.original.orderId} declares 200 and its lines sum to 300` });
      await db.query("ROLLBACK");
      expect(await lifecycleRows(env.owner)).toEqual(before);
    } finally { await db.query("ROLLBACK"); db.release(); }
  }, 30_000);

  it("restores the named constraint to deferred for a later statement before authenticated COMMIT", async () => {
    const f = await lifecycleDeclined(env.owner), principal = randomUUID();
    await env.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)", [principal, `${principal}@example.invalid`]);
    await env.owner.query("UPDATE public.clients SET principal_id=$2 WHERE id=$1", [f.client, principal]);
    const before = await lifecycleRows(env.owner), db = await env.owner.connect();
    try {
      await db.query("BEGIN");
      // A session-local, fixed-own-order fault writer distinguishes restored
      // deferral from IMMEDIATE. It is not a shipped actor routine or grant.
      await db.query(`CREATE FUNCTION pg_temp.c21_later_order_mismatch() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
        BEGIN UPDATE public.commerce_orders SET total_amount_minor=total_amount_minor+1 WHERE id='${f.original.orderId}'::uuid; END; $f$`);
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal })]);
      await call(db, "customer_subscription_pause_as_actor", [f.subscription.toUpperCase(), `deferred:${f.subscription}`, "indefinite", null]);
      // Missing DEFERRED would raise 23514 here inside this fixture definer.
      await db.query("SELECT pg_temp.c21_later_order_mismatch()");
      expect((await db.query("SELECT current_user AS role")).rows).toEqual([{ role: "authenticated" }]);
      // This deliberately queued *later* write has no actor wrapper to flush it.
      // Its failure at COMMIT proves that the original deferred invoker mode is back.
      await expect(db.query("COMMIT")).rejects.toMatchObject({ code: "42501", message: "permission denied for table commerce_orders" });
      await db.query("ROLLBACK");
      expect(await lifecycleRows(env.owner)).toEqual(before);
    } finally { await db.query("ROLLBACK"); db.release(); }
  }, 30_000);

  it("keeps the service closure helper deferred with the unchanged 23514 refusal at COMMIT", async () => {
    const f = await lifecycleDeclined(env.owner), db = await env.owner.connect();
    const before = await lifecycleRows(env.owner);
    try {
      await db.query("BEGIN");
      await db.query("UPDATE public.commerce_order_items SET quantity=quantity+1,line_amount_minor=(quantity+1)*unit_amount_minor WHERE order_id=$1", [f.original.orderId]);
      if (profile !== "legacy") await db.query("SET LOCAL ROLE service_role");
      await call(db, "subscription_pause_close_recovery", [f.client.toUpperCase(), `service-deferred:${f.subscription}`, f.subscription.toUpperCase(), AT]);
      // No actor-wrapper flush occurs: the call returns and the old guard fires at COMMIT.
      await expect(db.query("COMMIT")).rejects.toMatchObject({ code: "23514", message: "commerce_order_line_sum_mismatch" });
      await db.query("ROLLBACK");
      expect(await lifecycleRows(env.owner)).toEqual(before);
    } finally { await db.query("ROLLBACK"); db.release(); }
  }, 30_000);

  it("uses the typed package port for structured retention and confirmed O commands", async () => {
    const f = await lifecycleSubject(env.owner);
    const reasonCodes = ["schedule"];
    const port = createPostgresSubscriptionCommands({ lifecycleTerms: terms, retentionReasonCodes: reasonCodes, futureTerms: async () => { throw new Error("edit_not_selected"); },
      withTransaction: async work => { const db = await env.runtime.connect(); try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
        catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); } } });
    const context = { actor: { kind: "customer" as const, actorId: f.actor.toUpperCase(), clientId: f.client.toUpperCase() }, subscriptionId: f.subscription.toUpperCase(), now: AT };
    const command: SubscriptionCommand = { ...context, idempotencyKey: `typed:${f.subscription}`, action: "pause", pausePreset: "1_month", reason: null,
      survey: { reasonCode: "schedule" }, saveOffer: { offerId: "pause", kind: "pause", accepted: true } };
    expect(await port.apply(command)).toMatchObject({ outcome: "applied" });
    reasonCodes.splice(0, 1, "changed-taxonomy");
    expect(await port.apply(command)).toMatchObject({ outcome: "replayed" });
    expect(await port.apply({ ...command, idempotencyKey: `invalid:${f.subscription}`, survey: { reasonCode: "unknown" } })).toMatchObject({ outcome: "refused", reason: "subscription_command_invalid_input" });
  }, 30_000);

  it("keeps paid cycles and their parcels out of unpaid cleanup", async () => {
    const f = { ...await paidParcel(env.owner), actor: randomUUID() };
    await env.owner.query("UPDATE public.subscriptions SET started_at='2026-01-01T00:00:00Z' WHERE id=$1", [f.subscription]);
    const rows = async () => (await env.owner.query(`SELECT to_jsonb(c) AS cycle,to_jsonb(o) AS orders,to_jsonb(p) AS parcel,
      c.xmin::text AS cycle_version,o.xmin::text AS order_version,p.xmin::text AS parcel_version
      FROM public.subscription_cycles c JOIN public.commerce_orders o ON o.subscription_cycle_id=c.id
      JOIN public.fulfillment_shipments p ON p.order_id=o.id WHERE c.id=$1`, [f.cycle])).rows;
    const before = await rows();
    expect(await invoke(f, `paid:${f.subscription}`, "pause", { pausePreset: "indefinite" })).toMatchObject({ status: "applied" });
    expect(await invoke(f, `paid-cancel:${f.subscription}`, "cancel")).toMatchObject({ status: "applied" });
    expect(await rows()).toEqual(before);
    expect(readFileSync(lifecycleForward, "utf8")).not.toContain("subscription_delivery_alignment_confirm_replacement");
  }, 30_000);
});

it("cx1r_accept_once_and_recover: owner restore retains the marker and exact receipt", async () => {
  const resources = storeJourneyResources();
  try {
    const source = await resources.installation("save-offer-source");
    const f = await lifecycleSubject(source.owner);
    const service = acceptor(source.runtime);
    const offer = await presented(service, f, "skip");
    const input = { ...acceptInput(f, offer.generation), kind: offer.kind };
    const first = await service.accept(input);
    expect(first).toMatchObject({ outcome: "applied" });
    const packet = await captureStoreJourney(source.owner, "save-offer-source");
    const target = await (await resources.targetTemplate("save-offer-target")).nextTarget();
    const freshTarget = await captureStoreJourney(target.owner, "save-offer-target");
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget }))
      .toMatchObject({ replayed: false });
    expect(await offerEvents(target.owner, f.subscription)).toEqual(await offerEvents(source.owner, f.subscription));
    expect(await offerReceipts(target.owner, f.subscription)).toEqual(await offerReceipts(source.owner, f.subscription));
    const restored = acceptor(target.runtime);
    expect(await restored.accept(input)).toEqual({ ...first, outcome: "replayed" });
    expect(await restored.accept({ ...input, idempotencyKey: randomUUID() })).toEqual(refused("subscription_save_offer_consumed"));
  } finally { await resources.close(); }
}, 245_000);
