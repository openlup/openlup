import { expect, it } from "vitest";
import { runCommunicationSyncDispatchCron } from "../../../api/_cron/communicationSyncDispatchJob.js";
import { runCommunicationSyncReconcileCron } from "../../../api/_cron/communicationSyncReconcileJob.js";
import { enrichEmailSendsWithDeliveryEvidence } from "../../adapters/supabase/adminEmailSendsDeliveryEvidence.js";
import type { Client, EmailSendWithTesterRow } from "../../adapters/supabase/adminEmailSendsPort.js";
import type { DataGatewayPort } from "../../../src/domains/platform-runtime/ports.js";
import { processNewsletterWebhookEvent } from "./newsletterWebhookHandler.js";
import type { NewsletterWebhookEvent } from "@openlup/platform/communications/contracts";

const env = { CRON_SECRET: "synthetic", SUPABASE_URL: "https://gateway.example.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-local", COMMUNICATION_SYNC_DISPATCH_ENABLED: "true", COMMUNICATION_SYNC_RECONCILE_ENABLED: "true", COMMUNICATION_NEWSLETTER_PROVIDER_KINDS: "noop_newsletter" };
const request = { method: "POST", headers: { authorization: "Bearer synthetic" } };
const event = { id: "sync:1", claim_token: "claim:1", contact_id: "contact:1", normalized_email: "reader@example.invalid", event_type: "subscribe", purpose: "marketing_newsletter", payload: {}, attempt_count: 0 };

it.each(["dispatch", "reconcile", "auth", "disabled", "driver", "busy"])("W5 actual job/selected registry/store/finish: %s", async mode => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let settled = false;
  let gatewaySelections = 0;
  const client = { async rpc(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    if (name === "platform_claim_job_run") return { data: [{ acquired: !["busy", "driver"].includes(mode), run_id: ["busy", "driver"].includes(mode) ? null : "run:1", reason: mode === "driver" ? "driver_not_allowed" : "already_running" }], error: null };
    if (name === "communication_claim_sync_outbox") return { data: [event], error: null };
    if (name === "communication_mark_sync_outbox_sent") { settled = args.p_claim_token === event.claim_token && args.p_provider_kind === "noop_newsletter"; return { data: settled, error: null }; }
    if (name === "platform_finish_job_run_v2") return { data: null, error: null };
    throw Error(`unexpected persistence access: ${name}`);
  } };
  const factory = (): DataGatewayPort => { gatewaySelections++; return ({ asActor: async () => { throw Error("unexpected actor"); }, asService: async work => work(client as never) }); };
  const result = await (mode === "reconcile" ? runCommunicationSyncReconcileCron : runCommunicationSyncDispatchCron)(mode === "auth" ? { ...request, headers: { authorization: "Bearer invalid" } } as never : request as never, mode === "disabled" ? { ...env, COMMUNICATION_SYNC_DISPATCH_ENABLED: "false" } : env, factory);
  const names = calls.map(call => call.name);
  expect(names).toEqual(["auth", "disabled"].includes(mode) ? [] : ["busy", "driver"].includes(mode) ? ["platform_claim_job_run"] : mode === "reconcile" ? ["platform_claim_job_run", "platform_finish_job_run_v2"] : ["platform_claim_job_run", "communication_claim_sync_outbox", "communication_mark_sync_outbox_sent", "platform_finish_job_run_v2"]);
  expect(result.status).toBe(mode === "auth" ? 401 : 200);
  expect(gatewaySelections).toBe(["auth", "disabled"].includes(mode) ? 0 : 1);
  expect(settled).toBe(mode === "dispatch");
  if (mode === "dispatch") {
    expect(calls[1].args.p_provider_kind).toBe("noop_newsletter");
    expect(calls[2].args).toMatchObject({ p_outbox_id: "sync:1", p_claim_token: "claim:1", p_provider_kind: "noop_newsletter" });
    expect(result.body).toMatchObject({ sent: 1, checked: 1, updated: 1 });
    expect(calls[3].args).toMatchObject({ p_run_id: "run:1", p_status: "success" });
  }
});

it.each(["sent", "delivery_delayed", "failed", "delivered"])("W5 unchanged operator evidence retains %s and event linkage", async status => {
  const calls: unknown[] = [];
  const delivery = { email_send_id: "send:1", status, last_error_code: status === "failed" ? "refused" : null, outbox_event_id: "outbox:1", aggregate_type: "notice", aggregate_id: "notice:1", provider_message_id: "remote:1" };
  const client = { from(table: string) { calls.push(["from", table]); return { select(columns: string) { calls.push(["select", columns]); return { async in(column: string, values: string[]) { calls.push(["in", column, values]); return { data: [delivery], error: null }; } }; } }; } };
  const sends = [{ id: "send:1", testers: null, provider_response: { outboxEventId: "outbox:1" } }] as EmailSendWithTesterRow[];
  const rows = await enrichEmailSendsWithDeliveryEvidence(client as unknown as Client, sends);
  expect(rows[0]).toMatchObject({ delivery_status: status, delivery_outbox_event_id: "outbox:1", delivery_aggregate_id: "notice:1", delivery_last_error_code: delivery.last_error_code });
  expect(calls).toEqual([["from", "communication_email_deliveries"], ["select", "email_send_id, status, last_error_code, outbox_event_id, aggregate_type, aggregate_id, provider_message_id"], ["in", "email_send_id", ["send:1"]], ["from", "communication_email_deliveries"], ["select", "email_send_id, status, last_error_code, outbox_event_id, aggregate_type, aggregate_id, provider_message_id"], ["in", "outbox_event_id", ["outbox:1"]]]);
});

const feedback: NewsletterWebhookEvent = { providerKind: "synthetic", providerEventId: "event:1", eventType: "unsubscribe", email: "reader@example.invalid", remoteProfileId: null, remoteListId: null, purpose: null, explicitOptInEvidence: false, doubleOptInStatus: "unknown", occurredAt: null, rawPayload: {} };
it.each(["fallback", "replay", "permission-failure", "audit-failure"])("W3 actual feedback complete effects: %s", async mode => {
  const calls: unknown[][] = [];
  const run = processNewsletterWebhookEvent({ providerKind: "synthetic", event: feedback, port: {
    async recordProviderEvent(value) { calls.push(["event", value]); if (mode === "audit-failure") throw Error(mode); return { inserted: mode !== "replay", providerEventId: "row:1", contactId: "contact:1" }; },
    async recordPermission(value) { calls.push(["permission", value]); if (mode === "permission-failure") throw Error(mode); },
    async markProviderEvent(value) { calls.push(["settle", value]); },
  } });
  if (mode.endsWith("failure")) await expect(run).rejects.toThrow(mode); else await run;
  expect(calls.map(call => call[0])).toEqual(mode === "replay" || mode === "audit-failure" ? ["event"] : mode === "permission-failure" ? ["event", "permission"] : ["event", "permission", "permission", "settle"]);
  expect(calls[0][1]).toEqual({ ...feedback, state: "suppressed", processingStatus: "received" });
  if (mode === "fallback") expect(calls.slice(1, 3).map(call => (call[1] as { purpose: string }).purpose)).toEqual(["marketing_launch_offer", "marketing_newsletter"]);
});
