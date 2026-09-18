// The thirteen row-bearing legs of the customer-diagnostic neutrality axis (Wave 5, item 3). Every
// leg enters through a SHIPPED seam — the ingest BFF handler, the runtime history binding's port,
// the Node scheduler's own prune runtime — then reads rows back on the driver's own connection. A leg
// that called the SQL by hand would prove PostgreSQL works and nothing about provider-independence,
// the failure mode this axis excludes (ADR 003). Every import is RETAINED by the OSS publication
// delta, so the proof ships with the platform it proves.

import { randomUUID } from "node:crypto";

import { loadJobRegistry } from "../server/adapters/scheduler/jobRegistry.js";
import type { VercelRequest, VercelResponse } from "../server/_lib/types/vercel.js";
import { createCustomerDiagnosticEventsRoute } from "../server/bff/platform/customer-diagnostic-events.js";
import { CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME } from "../server/domains/observability/customerDiagnosticPruneJob.js";
import type { CustomerDiagnosticHistoryPort as HistoryPort, CustomerDiagnosticOverviewPort as OverviewPort } from "../server/domains/observability/customerDiagnosticHistory.js";
import { resolveCustomerDiagnosticHistoryBinding } from "../server/runtime/observability/customerDiagnosticHistoryBinding.js";
import { runCustomerDiagnosticPrune } from "../server/runtime/observability/customerDiagnosticPruneRuntime.js";
import { CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V2, CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2,
  CUSTOMER_DIAGNOSTIC_INGEST_CONTRACT_VERSION } from "../src/domains/observability/customerJourneyDiagnostics.js";

type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;
type Port = HistoryPort & OverviewPort;
export type LegStatus = "pass" | "fail" | "unknown";
export interface LegOutcome { id: number; name: string; status: LegStatus; detail: string }
export interface NeutralityContext {
  env: Env;
  /** One dedicated connection on the disposable database; never the binding's own pool. */
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  operatorId: string;
}

/** The four relations and the four routines no browser role may ever reach. */
export const BROWSER_DENIED_TABLES = ["customer_diagnostic_segments", "customer_diagnostic_events",
  "customer_diagnostic_ingress_attempts", "customer_diagnostic_access_events"] as const;
export const BROWSER_DENIED_FUNCTIONS = [
  "customer_diagnostic_ingest_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,integer,text,text,text,text,integer)",
  "customer_diagnostic_search_v1(uuid,timestamptz,timestamptz,uuid,text,text,text,integer,text,integer)",
  "customer_diagnostic_segment_v1(uuid,uuid,integer,text,integer)",
  "customer_diagnostic_prune_v1(integer)",
] as const;
export const BROWSER_ROLES = ["anon", "authenticated"] as const;
const [V2, HEX64, FRESH_BUCKET] = [CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2, "0".repeat(64), "1".repeat(64)];
const LANES = ["eventsDeleted", "segmentsDeleted", "limitsDeleted", "accessDeleted"] as const;
const EVENT_ALIVE = "SELECT count(*)::int AS n FROM public.customer_diagnostic_events WHERE id = $1";
const AUDITED = "SELECT count(*)::int AS n FROM public.customer_diagnostic_access_events";
const BUCKETS = "SELECT count(*)::int AS n FROM public.customer_diagnostic_ingress_attempts WHERE abuse_key_hash = $1";
/** ⛔ `platform_claim_job_run` writes a refusal to the `error` COLUMN (`20260809150000_job_run_ledger.sql`
 *  :186-205) and merges only activeDriver/leaseOwner into metadata, so a count over `metadata->>'reason'`
 *  can never go non-zero — a silently vacuous anti-masking check. */
export const LEDGER_REFUSAL_SQL =
  "SELECT count(*)::int AS n FROM public.platform_job_runs WHERE job_name = $1 AND error = 'inactive_driver'";
const state: { segmentId: string | null } = { segmentId: null };

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** `f(text,uuid)` -> `f(NULL::text,NULL::uuid)`: permission is checked before any argument is read. */
export function nullCall(signature: string): string {
  const open = signature.indexOf("(");
  return `${signature.slice(0, open)}(${signature.slice(open + 1, -1).split(",").map((t) => `NULL::${t}`).join(",")})`;
}

function post(env: Env, action: string, code: string, requestOrigin?: string): VercelRequest {
  const body = { contractVersion: CUSTOMER_DIAGNOSTIC_INGEST_CONTRACT_VERSION, action, phase: "settled", code,
    coverageVersion: CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION_V2,
    clientEventKey: randomUUID(), clientActionKey: randomUUID() };
  const origin = requestOrigin ?? new URL(env.APP_BASE_URL ?? "https://localhost").origin;
  return { method: "POST", headers: { origin }, query: {}, body } as unknown as VercelRequest;
}

function capture(): { out: { status?: number; body?: unknown }; res: VercelResponse } {
  const out: { status?: number; body?: unknown } = {};
  const res = { setHeader: () => undefined, removeHeader: () => undefined,
    status: (status: number) => { out.status = status; return res; },
    json: (value: unknown) => { out.body = value; return res; } };
  return { out, res: res as unknown as VercelResponse };
}

const errorCode = (body: unknown) => String((body as { error?: { code?: unknown } } | undefined)?.error?.code ?? "");

/** Drive the shipped runtime binding rather than the adapter, so the lane choice is proven too. */
function withPort<T>(ctx: NeutralityContext, work: (port: Port) => Promise<T>): Promise<T> {
  const read = { method: "GET", headers: {}, query: {} } as unknown as VercelRequest;
  return resolveCustomerDiagnosticHistoryBinding(read, ctx.env).run(work);
}

const scalar = async (ctx: NeutralityContext, text: string, values: unknown[] = []): Promise<number> =>
  Number(((await ctx.query(text, values)).rows[0] as { n?: unknown } | undefined)?.n ?? -1);

const events = (ctx: NeutralityContext) => scalar(ctx, "SELECT count(*)::int AS n FROM public.customer_diagnostic_events");

const searchWindow = () => ({ windowStart: new Date(Date.now() - 3_600_000).toISOString(), windowEnd: new Date(Date.now() + 3_600_000).toISOString() });

/** Seed one segment and one event whose expiries the caller chooses; returns the event id. */
const searchAs = (ctx: NeutralityContext, operatorId: string) => withPort(ctx,
  (port) => port.search({ contractVersion: V2, operatorId, pageSize: 10, ...searchWindow() }));
async function seedExpiring(ctx: NeutralityContext, segment: string, event: string): Promise<string> {
  const result = await ctx.query(
    `WITH s AS (
       INSERT INTO public.customer_diagnostic_segments (credential_hash, expires_at)
       VALUES (md5(random()::text) || md5(random()::text), clock_timestamp() + $1::interval) RETURNING id)
     INSERT INTO public.customer_diagnostic_events
       (segment_id, client_event_key, payload_fingerprint, action, phase, code, ingest_request_id, expires_at)
     SELECT s.id, gen_random_uuid(), $2, 'payment_status', 'settled', 'succeeded', 'neutrality-seed',
            clock_timestamp() + $3::interval FROM s RETURNING id`,
    [segment, HEX64, event]);
  return String((result.rows[0] as Row).id);
}

/** ⚠ SQLSTATE 42501 ALONE IS NOT A DENIAL, AND NEITHER IS ANY `permission denied` — the falsifier
 *  proved both in turn. `communications_require_active_operator` raises its own refusal under 42501,
 *  and is itself revoked from both browser roles, so a routine a role CAN now execute still fails
 *  with `permission denied for function communications_require_active_operator`. Only a denial
 *  NAMING THE PROBED OBJECT proves the privilege on that object is absent. */
export function isPrivilegeDenial(error: unknown, object: string): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const text = String(message ?? "");
  return code === "42501" && text.startsWith("permission denied for ") && text.endsWith(` ${object}`);
}

async function deniedTo(ctx: NeutralityContext, role: string, statement: string, object: string): Promise<boolean> {
  await ctx.query("BEGIN");
  try {
    await ctx.query(`SET ROLE ${role}`);
    await ctx.query(statement);
    return false;
  } catch (error) { return isPrivilegeDenial(error, object); }
  finally { await ctx.query("ROLLBACK"); }
}

interface Leg { id: number; name: string; run(ctx: NeutralityContext): Promise<string> }
const leg = (id: number, name: string, run: Leg["run"]): Leg => ({ id, name, run });
const legs: Leg[] = [
  leg(1, "ingest", async (ctx) => {
    const target = capture();
    await createCustomerDiagnosticEventsRoute({ env: ctx.env })(post(ctx.env, "payment_status", "succeeded"), target.res);
    assert(target.out.status === 200, `ingest refused with ${target.out.status} ${errorCode(target.out.body)}`);
    const data = (target.out.body as { data?: { segmentCredential?: string } }).data;
    assert(typeof data?.segmentCredential === "string", "ingest returned no segment credential");
    const stored = await events(ctx);
    assert(stored === 1, `expected exactly one committed event, found ${stored}`);
    return "committed 1 event through the BFF handler; segment credential issued";
  }),
  leg(2, "search", async (ctx) => {
    const result = await searchAs(ctx, ctx.operatorId);
    assert(result.contractVersion === V2, "search returned the wrong contract version");
    assert(result.segments.length >= 1 && result.groups.length >= 1, "search returned no rows");
    assert(result.sourceHealth.delivery === "unknown", "search laundered delivery=unknown");
    state.segmentId = result.segments[0]!.segmentId;
    return `${result.segments.length} segment(s), ${result.groups.length} group(s), delivery=unknown`;
  }),
  leg(3, "segment", async (ctx) => {
    assert(state.segmentId, "leg 2 did not yield a segment id");
    const segment = await withPort(ctx, (port) => port.readSegment({
      contractVersion: V2, operatorId: ctx.operatorId, segmentId: state.segmentId!, pageSize: 50 }));
    assert(segment !== null, "segment read returned null");
    assert(segment.events.length >= 1, "segment carried no ordered events");
    assert(segment.sourceHealth.delivery === "unknown", "segment laundered delivery=unknown");
    return `${segment.events.length} ordered event(s) for an ${segment.attribution} segment`;
  }),
  leg(4, "overview", async (ctx) => {
    const overview = await withPort(ctx, (port) => port.overview({
      contractVersion: V2, operatorId: ctx.operatorId, pageSize: 25, ...searchWindow() }));
    const settledOnly = overview.groups.filter((g) => g.action === "payment_status" || g.action === "payment_confirm");
    assert(settledOnly.length >= 1, "overview returned no settled-only payment group");
    assert(settledOnly.every((g) => g.rateApplicability === "not_applicable"),
      "a settled-only payment action was given an attempt rate");
    const orphans = settledOnly.flatMap((g) => g.terminalOutcomes)
      .filter((outcome) => outcome.classification === "terminalWithoutStart");
    assert(orphans.length === 0, `${orphans.length} terminalWithoutStart bucket(s) on a settled-only action`);
    return `${settledOnly.length} settled-only group(s), rateApplicability=not_applicable, terminalWithoutStart=0`;
  }),
  leg(5, "prune", async (ctx) => {
    const doomed = await seedExpiring(ctx, "-1 day", "-1 day");
    const counts = await withPort(ctx, (port) => port.prune(500));
    assert(LANES.every((lane) => Number.isInteger(counts[lane])), "prune returned an incomplete counter set");
    assert(counts.eventsDeleted >= 1, "prune reported no deletion for a row it was handed to delete");
    assert(await scalar(ctx, EVENT_ALIVE, [doomed]) === 0, "the seeded expired event survived the prune port");
    return LANES.map((lane) => `${lane}=${counts[lane]}`).join(" ");
  }),
  leg(6, "default-off", async (ctx) => {
    const before = await events(ctx);
    const dark: Env = { ...ctx.env };
    delete dark.COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED;
    delete dark.VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED;
    const target = capture();
    await createCustomerDiagnosticEventsRoute({ env: dark })(post(ctx.env, "payment_status", "succeeded"), target.res);
    assert(target.out.status === 503 && errorCode(target.out.body) === "UPSTREAM_UNAVAILABLE",
      `flagless ingest answered ${target.out.status} ${errorCode(target.out.body)}`);
    assert(await events(ctx) === before, "flagless ingest still wrote a row");
    return `flags unset -> 503 UPSTREAM_UNAVAILABLE, rows unchanged at ${before}`;
  }),
  leg(7, "strict-origin", async (ctx) => {
    const before = await events(ctx);
    const target = capture();
    await createCustomerDiagnosticEventsRoute({ env: ctx.env })(
      post(ctx.env, "payment_status", "succeeded", "https://foreign.example"), target.res);
    assert(target.out.status === 403 && errorCode(target.out.body) === "FORBIDDEN",
      `foreign origin answered ${target.out.status} ${errorCode(target.out.body)}`);
    assert(await events(ctx) === before, "foreign origin still wrote a row");
    return `foreign Origin -> 403 FORBIDDEN, rows unchanged at ${before}`;
  }),
  leg(8, "browser-role-denial", async (ctx) => {
    const reached: string[] = [];
    for (const role of BROWSER_ROLES) {
      for (const table of BROWSER_DENIED_TABLES) {
        if (!await deniedTo(ctx, role, `SELECT 1 FROM public.${table} LIMIT 1`, table)) reached.push(`${role}:${table}`);
      }
      for (const routine of BROWSER_DENIED_FUNCTIONS) {
        const name = routine.slice(0, routine.indexOf("("));
        if (!await deniedTo(ctx, role, `SELECT public.${nullCall(routine)}`, name)) reached.push(`${role}:${name}`);
      }
    }
    assert(reached.length === 0, `browser roles reached ${reached.join(", ")}`);
    const probes = BROWSER_ROLES.length * (BROWSER_DENIED_TABLES.length + BROWSER_DENIED_FUNCTIONS.length);
    return `${probes} live SET ROLE probes across anon and authenticated, all permission denied`;
  }),
  leg(9, "active-operator-audit", async (ctx) => {
    const before = await scalar(ctx, AUDITED);
    await searchAs(ctx, ctx.operatorId);
    const after = await scalar(ctx, AUDITED);
    assert(after === before + 1, `audited read committed ${after - before} audit row(s), expected 1`);
    let refused = false;
    try { await searchAs(ctx, randomUUID()); } catch { refused = true; }
    assert(refused, "a read with no active operator was served");
    assert(await scalar(ctx, AUDITED) === after, "the refused read left a partial audit row");
    return "active operator committed 1 audit row in the read's transaction; no active operator refused, 0 written";
  }),
  leg(10, "retention-14-day", async (ctx) => {
    const expired = await seedExpiring(ctx, "-1 day", "-1 day");
    const live = await seedExpiring(ctx, "14 days", "14 days");
    const under = await seedExpiring(ctx, "-1 day", "14 days");
    await withPort(ctx, (port) => port.prune(500));
    assert(await scalar(ctx, EVENT_ALIVE, [expired]) === 0, "an expired event survived the drain");
    assert(await scalar(ctx, EVENT_ALIVE, [live]) === 1, "a live event was deleted by the drain");
    assert(await scalar(ctx, EVENT_ALIVE, [under]) === 1, "a live event under an expired segment was deleted");
    const kept = await scalar(ctx, `SELECT count(*)::int AS n FROM public.customer_diagnostic_segments s
      WHERE s.expires_at <= clock_timestamp()
        AND EXISTS (SELECT 1 FROM public.customer_diagnostic_events e WHERE e.segment_id = s.id)`);
    assert(kept === 1, "an expired segment holding a live event was not kept");
    return "expired rows physically gone, live rows kept, expired segment holding a live event kept";
  }),
  leg(11, "admission-window-two-minute", async (ctx) => {
    const seeded = await ctx.query(
      `INSERT INTO public.customer_diagnostic_ingress_attempts (abuse_key_hash, occurred_at)
       VALUES ($1, clock_timestamp() - interval '10 minutes'), ($2, clock_timestamp()) RETURNING id`,
      [HEX64, FRESH_BUCKET]);
    assert(seeded.rows.length === 2, "the admission seed did not commit two buckets");
    const live = await seedExpiring(ctx, "14 days", "14 days");
    await withPort(ctx, (port) => port.prune(500));
    assert(await scalar(ctx, BUCKETS, [HEX64]) === 0, "an admission bucket older than two minutes survived");
    assert(await scalar(ctx, BUCKETS, [FRESH_BUCKET]) === 1, "a fresh admission bucket was removed by the drain");
    assert(await scalar(ctx, EVENT_ALIVE, [live]) === 1, "the two-minute window inherited the 14-day retention");
    return "stale bucket removed, fresh bucket kept, 14-day rows in the same pass untouched";
  }),
  leg(12, "node-scheduler-drive", async (ctx) => {
    const registered = loadJobRegistry().filter((job) => job.jobId === CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME);
    assert(registered.length === 1, `the job registry carries ${registered.length} entries for the drain`);
    const doomed = await seedExpiring(ctx, "-1 day", "-1 day");
    // This IS the scheduler path: `createCustomerDiagnosticPruneScheduledJobHandlers` is a one-line
    // relay of this env and this invocation source into this function, and that module is withheld
    // from the OSS publication while this proof is retained — so the leg drives the runtime it calls.
    const result = await runCustomerDiagnosticPrune({ env: ctx.env, invocationSource: "node_cron" });
    assert(result.status < 400, `the drain answered ${result.status}`);
    assert(result.body.skipped === undefined, `the drain skipped: ${String(result.body.reason)}`);
    assert(await scalar(ctx, EVENT_ALIVE, [doomed]) === 0, "the in-process drain deleted nothing");
    return `registry ${registered[0]!.path} (${registered[0]!.schedule}); drained in-process, no HTTP and no poker`;
  }),
  leg(13, "ledger-evidence", async (ctx) => {
    const latest = await ctx.query(
      `SELECT status, driver, metadata->>'invocationSource' AS invocation_source FROM public.platform_job_runs
        WHERE job_name = $1 ORDER BY started_at DESC LIMIT 1`, [CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME]);
    const row = latest.rows[0] as { status?: unknown; driver?: unknown; invocation_source?: unknown } | undefined;
    assert(row, "the drain left no row in platform_job_runs");
    assert(row.status === "success", `the latest ledger row is ${String(row.status)}`);
    assert(row.driver === "worker", `the latest ledger row carries driver ${String(row.driver)}`);
    assert(row.invocation_source === "node_cron", `metadata->>invocationSource is ${String(row.invocation_source)}`);
    const refused = await scalar(ctx, LEDGER_REFUSAL_SQL, [CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME]);
    assert(refused === 0, `${refused} run(s) were refused as inactive_driver`);
    return "status=success driver=worker metadata->>invocationSource=node_cron, no inactive_driver refusal";
  }),
];

export const NEUTRALITY_LEG_COUNT: number = legs.length;
export const NEUTRALITY_LEG_NAMES: string[] = legs.map((e) => e.name);

/** Run every leg in order. A thrown leg fails; it never downgrades a later leg into a pass. */
export async function runNeutralityLegs(ctx: NeutralityContext): Promise<LegOutcome[]> {
  state.segmentId = null;
  const outcomes: LegOutcome[] = [];
  for (const entry of legs) {
    try {
      outcomes.push({ id: entry.id, name: entry.name, status: "pass", detail: await entry.run(ctx) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcomes.push({ id: entry.id, name: entry.name, status: "fail", detail: detail.slice(0, 240) });
    }
  }
  return outcomes;
}
