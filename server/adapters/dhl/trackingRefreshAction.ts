import { mapDhlTrackingStatus as mapCarrierTrackingStatus } from "../../../src/domains/fulfillment/status.js";
import {
  beginTrackingJobRun,
  finishTrackingJobRun,
  parseTrackingDriver,
  TRACKING_JOB_NAME,
  type TrackingDriver,
  type TrackingLedgerClient,
} from "./trackingJobLedger.js";
import { pollCarrierTracking } from "./trackingPoller.js";

export const TRACKING_BATCH_SIZE = 60;
export const TRACKING_TIME_BUDGET_MS = 45_000;
export const TRACKING_FAILURE_CODE = "all_dhl_tracking_checks_failed";
export const TRACKING_SUPPORT_PREFIX = "DHL-TRACK-";

type Tester = { id: string; tracking_number: string | null; status: string };
type RpcError = { message?: string } | null;
type Result = {
  tester_id: string;
  tracking_number: string;
  old_status: string;
  new_status: "delivered" | "in_transit" | null;
  codes?: string[];
  error?: string;
};

export type CarrierTrackingClient = TrackingLedgerClient & {
  auth: { getUser: (token: string) => Promise<{ data: { user: { id: string } | null } }> };
  from: (table: string) => {
    select: (columns: string) => {
      in: (field: string, values: string[]) => {
        not: (field: string, operator: string, value: unknown) => {
          order: (field: string, options: { ascending: boolean; nullsFirst: boolean }) => {
            limit: (count: number) => Promise<{ data: Tester[] | null; error: unknown }>;
          };
        };
      };
      eq: (field: string, value: string) => {
        maybeSingle: () => Promise<{ data: { id: string } | null }>;
      };
    };
    update: (row: Record<string, unknown>) => {
      eq: (field: string, value: string) => Promise<{ error: RpcError }>;
    };
  };
};

export type TrackingRefreshActionDeps = {
  createClient: () => CarrierTrackingClient;
  fetchImpl: typeof fetch;
  callSendEmailImpl: (testerId: string, templateSlug: string, source: string) => Promise<{ ok: boolean; status: number }>;
  providerUsername: string;
  providerPassword: string;
  cronSecret?: string;
  now?: () => Date;
  log?: (...values: unknown[]) => void;
};

export function createTrackingRefreshAction({
  createClient,
  fetchImpl,
  callSendEmailImpl,
  providerUsername,
  providerPassword,
  cronSecret = "",
  now = () => new Date(),
  log = () => undefined,
}: TrackingRefreshActionDeps) {
  return async function runTrackingRefreshAction(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response("ok");
    let active: { client: CarrierTrackingClient; runId: string | null; driver: TrackingDriver; finished: boolean } | null = null;
    try {
      const client = createClient();
      const body = await requestBody(request);
      const auth = await authorizeTrackingRequest(client, request, body, cronSecret);
      if (!auth.authorized) return json({ error: "Unauthorized" }, 401);

      const requested = request.headers.get("x-job-driver") ?? body.driver;
      const requestedDriver = requested ? parseTrackingDriver(requested) : null;
      if (requested && !requestedDriver) return json({ error: "Invalid scheduler driver" }, 400);
      if (requestedDriver === "manual_admin" && !auth.source.startsWith("admin:")) {
        return json({ error: "manual_admin requires admin auth" }, 403);
      }
      const driver = requestedDriver ?? (auth.source.startsWith("admin:") ? "manual_admin" : "pg_cron");
      const metadata = {
        triggerSource: cleanMetadata(body.trigger_source, 80) ?? driver,
        cronSchedule: cleanMetadata(body.cron_schedule, 80),
        authSource: auth.source,
      };
      const lease = await beginTrackingJobRun(client, driver, metadata);
      if (!lease.acquired) {
        return json({
          success: true, skipped: true, driver, reason: lease.reason, run_id: lease.runId,
          lease_until: lease.leaseExpiresAt, checked: 0, updated: 0, results: [],
        });
      }
      active = { client, runId: lease.runId, driver, finished: false };
      const { data: testers, error } = await client.from("testers").select("id, tracking_number, status")
        .in("status", ["shipped", "in_transit"]).not("tracking_number", "is", null)
        .order("dhl_last_checked_at", { ascending: true, nullsFirst: true }).limit(TRACKING_BATCH_SIZE);
      if (error) {
        await finishSafely(client, lease.runId, driver, "failed", null, null, "Failed to fetch testers", undefined, metadata, log);
        active.finished = true;
        return json({ error: "Failed to fetch testers" }, 500);
      }

      const results: Result[] = [];
      const deadline = now().getTime() + TRACKING_TIME_BUDGET_MS;
      let remaining = 0;
      for (const tester of testers ?? []) {
        if (!tester.tracking_number) continue;
        if (now().getTime() >= deadline) {
          remaining += 1;
          continue;
        }
        await checkTester({ client, fetchImpl, callSendEmailImpl, providerUsername, providerPassword, now, tester, results, log });
      }

      const updated = results.filter((result) => result.new_status).length;
      const errorCount = results.filter((result) => result.error).length;
      const allFailed = results.length > 0 && results.length === errorCount;
      const supportCode = allFailed ? trackingSupportCode(now(), results.map((result) => result.error).join("|")) : undefined;
      await finishSafely(
        client, lease.runId, driver, allFailed ? "failed" : "success", results.length, updated,
        allFailed ? TRACKING_FAILURE_CODE : undefined, supportCode,
        { ...metadata, errorCount, remaining, batchSize: TRACKING_BATCH_SIZE }, log,
      );
      active.finished = true;
      if (allFailed) {
        return json({
          error: TRACKING_FAILURE_CODE, success: false, driver, run_id: lease.runId,
          checked: results.length, updated, support_code: supportCode, results,
        }, 502);
      }
      return json({
        success: true, driver, run_id: lease.runId, checked: results.length, updated,
        error_count: errorCount, remaining, batch_size: TRACKING_BATCH_SIZE, results,
      });
    } catch (error) {
      if (active && !active.finished) {
        await finishSafely(active.client, active.runId, active.driver, "failed", null, null, String(error), undefined, {}, log);
      }
      return json({ error: String(error) }, 500);
    }
  };
}

async function checkTester(input: {
  client: CarrierTrackingClient;
  fetchImpl: typeof fetch;
  callSendEmailImpl: TrackingRefreshActionDeps["callSendEmailImpl"];
  providerUsername: string;
  providerPassword: string;
  now: () => Date;
  tester: Tester;
  results: Result[];
  log: (...values: unknown[]) => void;
}): Promise<void> {
  const { client, tester, results } = input;
  try {
    const poll = await pollCarrierTracking({
      fetchImpl: input.fetchImpl, trackingNumber: tester.tracking_number!,
      username: input.providerUsername, password: input.providerPassword,
    });
    await client.from("testers").update({
      dhl_last_response: truncateResponse(poll.responseText), dhl_last_checked_at: input.now().toISOString(),
      dhl_last_codes: poll.events.codes, dhl_last_descriptions: poll.events.descriptions,
    }).eq("id", tester.id);
    if (poll.providerError) {
      results.push(result(tester, null, { error: poll.providerError }));
      return;
    }
    const status = mapCarrierTrackingStatus(poll.events);
    if (!status || status === tester.status) {
      results.push(result(tester, null, { codes: poll.events.codes }));
      return;
    }
    const updates: Record<string, string> = { status, status_updated_at: input.now().toISOString() };
    if (status === "delivered") updates.delivered_at = input.now().toISOString();
    const { error } = await client.from("testers").update(updates).eq("id", tester.id);
    if (error) {
      results.push(result(tester, null, { codes: poll.events.codes, error: `update failed: ${error.message}` }));
      return;
    }
    const email = await input.callSendEmailImpl(tester.id, status === "in_transit" ? "in-transit" : "delivered", TRACKING_JOB_NAME);
    if (!email.ok) input.log(`[WARN] ${TRACKING_JOB_NAME}: send-email HTTP ${email.status} for ${tester.id}`);
    results.push(result(tester, status, { codes: poll.events.codes }));
  } catch (error) {
    results.push(result(tester, null, { error: String(error) }));
  }
}

async function authorizeTrackingRequest(
  client: CarrierTrackingClient,
  request: Request,
  body: Record<string, unknown>,
  cronSecret: string,
): Promise<{ authorized: boolean; source: string }> {
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
  const candidates = [
    { source: "cron:bearer", secret: bearer },
    { source: "cron:header", secret: request.headers.get("x-cron-secret")?.trim() ?? null },
    { source: "cron:body", secret: cleanMetadata(body.cron_secret, Number.MAX_SAFE_INTEGER) },
  ];
  const environmentMatch = candidates.find(({ secret }) => Boolean(cronSecret && secret && secret === cronSecret));
  if (environmentMatch) return { authorized: true, source: environmentMatch.source };
  for (const candidate of candidates) {
    if (!candidate.secret) continue;
    const { data } = await client.rpc<boolean>("verify_cron_secret", { p_secret: candidate.secret });
    if (data) return { authorized: true, source: `${candidate.source}:rpc` };
  }
  if (!bearer) return { authorized: false, source: "" };
  const { data: { user } } = await client.auth.getUser(bearer);
  if (!user) return { authorized: false, source: "" };
  const { data: admin } = await client.from("admin_users").select("id").eq("id", user.id).maybeSingle();
  return admin ? { authorized: true, source: `admin:${user.id}` } : { authorized: false, source: "" };
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

async function finishSafely(
  client: CarrierTrackingClient, runId: string | null, driver: TrackingDriver, status: "success" | "failed",
  checked: number | null, updated: number | null, error?: string, supportCode?: string,
  metadata: Record<string, unknown> = {}, log: (...values: unknown[]) => void = () => undefined,
): Promise<void> {
  if (!runId) return;
  try { await finishTrackingJobRun(client, runId, status, driver, checked, updated, error, supportCode, metadata); }
  catch (finishError) { log(`[WARN] ${TRACKING_JOB_NAME}: failed to finish job run ${runId}: ${String(finishError)}`); }
}

function result(tester: Tester, status: Result["new_status"], extra: Omit<Result, "tester_id" | "tracking_number" | "old_status" | "new_status">): Result {
  return { tester_id: tester.id, tracking_number: tester.tracking_number!, old_status: tester.status, new_status: status, ...extra };
}
function truncateResponse(value: string): string { return value.length > 8192 ? `${value.slice(0, 8192)}...[truncated]` : value; }
function cleanMetadata(value: unknown, length: number): string | null { return typeof value === "string" && value.trim() ? value.trim().slice(0, length) : null; }
function trackingSupportCode(at: Date, seed: string): string {
  const stamp = at.toISOString().replace(/\D/g, "").slice(0, 14).padEnd(14, "0");
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `${TRACKING_SUPPORT_PREFIX}${stamp}-${hash.toString(36).toUpperCase().padStart(6, "0").slice(-6)}`;
}
function json(body: Record<string, unknown>, status?: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
