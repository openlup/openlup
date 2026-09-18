import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const FILE = "db/platform/migrations/20260815130000_customer_recovery_console.sql";
const JOURNEY_RECOVERY_STATUS_FILE = "db/platform/migrations/20260817130000_customer_support_journey_recovery_status.sql";
const SEARCH_V3_FILE = "db/platform/migrations/20260826063555_customer_support_search_v3.sql";
const sql = readFileSync(FILE, "utf8");
const journeyRecoveryStatusSql = readFileSync(JOURNEY_RECOVERY_STATUS_FILE, "utf8");
const searchV3Sql = readFileSync(SEARCH_V3_FILE, "utf8");
const statements = sql.replace(/^\s*--.*$/gm, "");
const journeyRecoveryStatusStatements = journeyRecoveryStatusSql.replace(/^\s*--.*$/gm, "");
const searchV3Statements = searchV3Sql.replace(/^\s*--.*$/gm, "");
function routine(name: string): string {
  const start = statements.indexOf(`CREATE FUNCTION public.${name}`);
  if (start < 0) throw new Error(`missing routine ${name}`);
  const end = statements.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`unterminated routine ${name}`);
  return statements.slice(start, end + 4);
}
function replacementJourney(): string {
  const start = journeyRecoveryStatusStatements.indexOf("CREATE OR REPLACE FUNCTION public.customer_support_journey");
  if (start < 0) throw new Error("missing replacement customer_support_journey");
  const end = journeyRecoveryStatusStatements.indexOf("\n$$;", start);
  if (end < 0) throw new Error("unterminated replacement customer_support_journey");
  return journeyRecoveryStatusStatements.slice(start, end + 4);
}
function replacementSearch(): string {
  const start = searchV3Statements.indexOf("CREATE OR REPLACE FUNCTION public.customer_support_search");
  if (start < 0) throw new Error("missing replacement customer_support_search");
  const end = searchV3Statements.indexOf("\n$$;", start);
  if (end < 0) throw new Error("unterminated replacement customer_support_search");
  return searchV3Statements.slice(start, end + 4);
}
describe("public customer recovery console forward", () => {
  it("extends one subject lifecycle instead of creating tester or waitlist identities", () => {
    expect(statements).toMatch(/clients_lifecycle_stage_check[\s\S]+\('lead', 'waitlist', 'tester', 'customer', 'inactive'\)/);
    expect(statements).toContain("CREATE TABLE public.customer_subject_lifecycle_events");
    expect(statements).toContain("CREATE TRIGGER customer_subject_capture_lifecycle_trigger");
    expect(statements).toContain("INSERT INTO public.customer_subject_lifecycle_events");
    expect(statements).not.toMatch(/CREATE TABLE public\.(?:testers|waitlist|customer_360)/);
  });
  it("publishes the four strict named reads expected by the portable adapters", () => {
    expect(statements).toContain("CREATE FUNCTION public.customer_support_summary(p_operator_id uuid)");
    expect(statements).toMatch(/CREATE FUNCTION public\.customer_support_search\(\s+p_operator_id uuid,\s+p_query text,\s+p_page integer,\s+p_page_size integer,\s+p_lifecycle_stage text/);
    expect(statements).toContain("CREATE FUNCTION public.customer_support_detail(p_operator_id uuid, p_client_id uuid)");
    expect(statements).toContain("CREATE FUNCTION public.customer_support_journey(p_operator_id uuid, p_client_id uuid)");
    expect(statements).toContain("'contractVersion', 'clients.customer_360.v2'");
    expect(statements).toContain("'contractVersion', 'support.customer_360.v2'");
    const search = routine("customer_support_search");
    expect(search).toContain("OFFSET v_page * v_limit");
    expect(search).toContain("client_row.lifecycle_stage = p_lifecycle_stage");
    expect(search).toContain("'page', v_page");
  });
  it("replaces search with indexed candidates and resolves direct or legacy-cycle orders", () => {
    const search = replacementSearch();
    expect(searchV3Statements).toContain("CREATE INDEX customer_support_clients_document_trgm_idx");
    expect(search).toContain("WITH candidate_ids AS MATERIALIZED");
    expect(search).toContain("OPERATOR(public.%) v_query_normalized");
    expect(search).toContain("OFFSET v_page::bigint * v_limit::bigint");
    expect(search).toContain("SET pg_trgm.similarity_threshold = '0.28'");
    expect(search).toContain("v_query_is_email boolean");
    expect(search).toContain("v_query_digits := CASE WHEN v_query_is_email THEN ''");
    expect(search).toContain("v_query_normalized !~ '[a-z0-9]'");
    expect(search).toContain("client_row.lifecycle_stage IN ('customer', 'inactive')");
    expect(search).toContain("source_row.normalized_phone LIKE '%' || v_query_digits || '%'");
    expect(search).toContain("source_row.normalized_phone LIKE v_query_digits || '%'");
    expect(search).toContain("COALESCE(order_row.client_id, legacy_subscription.client_id)");
    expect(search).toMatch(/WHERE order_row\.client_id = client_row\.id\s+OR \(order_row\.client_id IS NULL AND subscription_row\.client_id = client_row\.id\)/);
    expect(searchV3Statements).not.toContain("public.pets");
    expect(searchV3Statements).toContain("CREATE INDEX customer_support_orders_client_activity_idx");
    expect(searchV3Statements).toContain("CREATE INDEX customer_support_dunning_client_activity_idx");
  });
  it("builds the journey from real order, subscription, settlement, dunning and recovery evidence", () => {
    const journey = routine("customer_support_journey");
    expect(journey).toContain("FROM public.commerce_orders");
    expect(journey).toContain("FROM public.subscriptions");
    expect(journey).toContain("FROM public.commerce_settlement_intents");
    expect(journey).toContain("FROM public.commerce_settlement_transitions");
    expect(journey).toContain("FROM public.subscription_dunning_cases");
    expect(journey).toContain("FROM public.subscription_dunning_notifications");
    expect(journey).toContain("FROM public.customer_support_audit_events");
    expect(journey).toMatch(/'status', CASE WHEN EXISTS \([\s\S]+commerce_checkout_recovery_tokens[\s\S]+expires_at > now\(\)[\s\S]+THEN 'available' ELSE 'unavailable'/);
    expect(journey).toMatch(/'actionAvailable', client_row\.lifecycle_stage = 'customer'[\s\S]+case_row\.status = 'open'[\s\S]+order_row\.status = 'pending_payment'/);
    expect(journey).toMatch(/'recoveryAvailable', client_row\.lifecycle_stage = 'customer'[\s\S]+case_row\.status = 'open'[\s\S]+order_evidence\.status = 'pending_payment'/);
    expect(journey).not.toMatch(/external_ref|channel_key|token_hash|recovery_url_path|delivery_ref/);
  });
  it("makes recovery availability follow portable order-status consumption and customer notice evidence", () => {
    const journey = replacementJourney();
    const recovery = journey.slice(journey.indexOf("'recovery'"), journey.indexOf("'auditTrail'"));
    const recoveryStatus = recovery.slice(recovery.indexOf("'status', CASE WHEN EXISTS ("), recovery.indexOf("'actionAvailable'"));
    const dunningCases = journey.slice(journey.indexOf("'dunningCases'"), journey.indexOf("'recovery'"));

    expect(journey).toContain("CREATE OR REPLACE FUNCTION public.customer_support_journey");
    expect(recoveryStatus).toMatch(/token_order\.status = 'pending_payment'[\s\S]+token_row\.revoked_at IS NULL[\s\S]+token_row\.expires_at > now\(\)/);
    expect(recoveryStatus).not.toMatch(/WHERE token_order\.subscription_cycle_id = case_row\.cycle_id\s+AND token_row\.client_id = client_row\.id\s+AND token_row\.revoked_at IS NULL\s+AND token_row\.expires_at > now\(\)\s+\) THEN 'available'/);
    expect(recoveryStatus).not.toContain("used_at");
    expect(dunningCases).toMatch(/WHERE notice_row\.case_id = case_row\.id[\s\S]+AND notice_row\.recipient_kind = 'customer'[\s\S]+ORDER BY notice_row\.created_at DESC, notice_row\.id DESC LIMIT 1/);
    expect(recovery).toMatch(/WHERE notice_row\.case_id = case_row\.id[\s\S]+AND notice_row\.notification_kind = 'payment_recovery'[\s\S]+AND notice_row\.recipient_kind = 'customer'[\s\S]+ORDER BY notice_row\.created_at DESC, notice_row\.id DESC LIMIT 1/);
    expect(journey).toMatch(/ORDER BY audit\.occurred_at DESC, audit\.sort_priority DESC, audit\.event_id DESC/);
    expect(journey).toMatch(/CASE transition_row\.outcome WHEN 'failed' THEN 40 WHEN 'opened' THEN 25 ELSE 35 END/);
  });
  it("gates every read and action on the existing durable operator allowlist", () => {
    for (const name of [
      "customer_support_summary",
      "customer_support_search",
      "customer_support_detail",
      "customer_support_journey",
      "customer_support_issue_recovery",
    ]) {
      expect(routine(name)).toContain("PERFORM public.communications_require_active_operator(p_operator_id);");
    }
    expect(statements).toContain("REFERENCES public.platform_communication_operators(principal_id)");
    expect(statements).not.toMatch(/REFERENCES public\.platform_control_operators/);
    expect(statements).not.toMatch(/CREATE TABLE public\.\w*operator/);
  });
  it("locks and validates idempotency before it reaches the D15 token authority", () => {
    const action = routine("customer_support_issue_recovery");
    const lock = action.indexOf("pg_advisory_xact_lock");
    const ledgerRead = action.indexOf("FROM public.customer_recovery_commands");
    const conflict = action.indexOf("customer_support_idempotency_conflict");
    const replay = action.indexOf("RETURN jsonb_set(v_existing.response");
    const authority = action.indexOf("public.dunning_lifecycle_issue_recovery_token(");
    expect(lock).toBeGreaterThan(0);
    expect(ledgerRead).toBeGreaterThan(lock);
    expect(conflict).toBeGreaterThan(ledgerRead);
    expect(replay).toBeGreaterThan(conflict);
    expect(authority).toBeGreaterThan(replay);
    expect(action.match(/dunning_lifecycle_issue_recovery_token\(/g)).toHaveLength(1);
    expect(action).toContain("command_fingerprint <> p_command_fingerprint");
    expect(action).toContain("USING ERRCODE = '23505'");
    expect(action).toMatch(/commerce_checkout_recovery_tokens[\s\S]+token_hash = p_token_hash/);
    expect(action).toContain("customer_support_recovery_token_not_persisted");
    expect(action).toMatch(/response->>'outcome' = 'refused'[\s\S]+RETURN v_existing\.response/);
  });
  it("extends the D15 queue and appends one fresh recovery notice only after token issue", () => {
    expect(statements).toMatch(/subscription_dunning_notifications_kind_check[\s\S]+payment_recovery/);
    const action = routine("customer_support_issue_recovery");
    const authority = action.indexOf("public.dunning_lifecycle_issue_recovery_token(");
    const ordinal = action.indexOf("max(notice_row.retry_attempt)");
    const notice = action.indexOf("public.dunning_lifecycle_queue_notice(");
    const audit = action.indexOf("INSERT INTO public.customer_support_audit_events", notice);
    const ledgerWrite = action.indexOf("INSERT INTO public.customer_recovery_commands", audit);
    expect(ordinal).toBeGreaterThan(authority);
    expect(notice).toBeGreaterThan(ordinal);
    expect(audit).toBeGreaterThan(notice);
    expect(ledgerWrite).toBeGreaterThan(audit);
    expect(action).toContain("p_case_id, 'payment_recovery', 'payment_recovery'");
    expect(action).not.toMatch(/UPDATE public\.(?:subscriptions|subscription_cycles)/);
  });
  it("persists every business refusal so restart cannot turn the same key into an issue", () => {
    const action = routine("customer_support_issue_recovery");
    for (const code of [
      "subject_not_found",
      "lifecycle_not_eligible",
      "case_not_found",
      "case_not_open",
      "recoverable_order_unavailable",
      "dunning_authority_unavailable",
    ]) expect(action).toContain(`'${code}'`);
    expect(action).toMatch(/recipient_kind = 'customer'[\s\S]+notification_kind = 'payment_failed'/);
    const refusal = action.slice(
      action.indexOf("IF v_refusal_code IS NOT NULL THEN"),
      action.indexOf("v_issue_result := public.dunning_lifecycle_issue_recovery_token"),
    );
    expect(refusal).toContain("INSERT INTO public.customer_support_audit_events");
    expect(refusal).toContain("INSERT INTO public.customer_recovery_commands");
    expect(refusal.indexOf("INSERT INTO public.customer_recovery_commands"))
      .toBeLessThan(refusal.indexOf("RETURN v_response"));
  });
  it("returns and persists only the sanitized recovery result", () => {
    const action = routine("customer_support_issue_recovery");
    const responseStart = action.lastIndexOf("v_response := jsonb_build_object(");
    const response = action.slice(
      responseStart,
      action.indexOf("INSERT INTO public.customer_recovery_commands", responseStart),
    );
    expect(response).toContain("'deliveryStatus', 'queued'");
    expect(response).toContain("'auditEventId', v_audit_id");
    expect(response).not.toMatch(/token|hash|path|provider|external|deliveryRef|noticeId|orderId/i);
    expect(statements).not.toMatch(/CREATE TABLE public\.\w*recovery_tokens/);
  });
  it("keeps lifecycle and operator evidence append-only", () => {
    expect(statements).toContain("CREATE TABLE public.customer_subject_lifecycle_events");
    expect(statements).toContain("CREATE TABLE public.customer_support_audit_events");
    expect(statements).toContain("CREATE TABLE public.customer_support_read_audit_events");
    expect(statements).not.toMatch(/UPDATE public\.customer_subject_lifecycle_events/);
    expect(statements).not.toMatch(/DELETE FROM public\.customer_subject_lifecycle_events/);
    expect(statements).not.toMatch(/UPDATE public\.customer_support_audit_events/);
    expect(statements).not.toMatch(/DELETE FROM public\.customer_support_audit_events/);
    expect(statements).toContain("CREATE FUNCTION public.customer_support_refuse_ledger_mutation()");
    expect(statements).toMatch(/BEFORE UPDATE OR DELETE ON public\.customer_subject_lifecycle_events/);
    expect(statements).toMatch(/BEFORE UPDATE OR DELETE ON public\.customer_recovery_commands/);
    expect(statements).toMatch(/BEFORE UPDATE OR DELETE ON public\.customer_support_audit_events/);
    expect(statements).toMatch(/BEFORE UPDATE OR DELETE ON public\.customer_support_read_audit_events/);
    expect(routine("customer_support_refuse_ledger_mutation"))
      .toContain("customer_support_ledger_append_only");
  });
  it("fixes search paths, grants nothing and revokes every new object", () => {
    const routines = [...statements.matchAll(/^CREATE FUNCTION public\.(\w+)/gm)]
      .map((match) => match[1]);
    expect(routines.length).toBeGreaterThanOrEqual(6);
    expect([...statements.matchAll(/SET search_path = pg_catalog/g)]).toHaveLength(routines.length);
    expect(statements).not.toMatch(/\bGRANT\b|SECURITY DEFINER|CREATE POLICY|ROW LEVEL SECURITY/);
    for (const name of routines) {
      expect(statements).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(`));
    }
    for (const table of [
      "customer_subject_lifecycle_events",
      "customer_recovery_commands",
      "customer_support_audit_events",
      "customer_support_read_audit_events",
    ]) {
      expect(statements.slice(statements.indexOf("REVOKE ALL ON TABLE"))).toContain(`public.${table}`);
    }
    expect([...statements.matchAll(/FROM PUBLIC, anon, authenticated;/g)])
      .toHaveLength(routines.length + 1);
  });
});
