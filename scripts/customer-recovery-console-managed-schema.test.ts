import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "supabase/migrations/20260815130100_customer_recovery_console.sql";
const sql = readFileSync(FILE, "utf8");
const statements = sql.replace(/^\s*--.*$/gm, "");

function routine(name: string): string {
  const start = statements.indexOf(`CREATE FUNCTION public.${name}`);
  if (start < 0) throw new Error(`missing routine ${name}`);
  const end = statements.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`unterminated routine ${name}`);
  return statements.slice(start, end + 4);
}

describe("managed customer recovery console forward", () => {
  it("admits waitlist as an earlier stage of the same managed subject", () => {
    expect(statements).toMatch(/clients_lifecycle_stage_check[\s\S]+lead[\s\S]+waitlist[\s\S]+tester[\s\S]+customer[\s\S]+inactive/);
  });

  it("matches the managed adapter's named eight-argument RPC", () => {
    expect(statements).toMatch(/CREATE FUNCTION public\.customer_support_issue_recovery\(\s*p_operator_id uuid,\s*p_subject_id uuid,\s*p_case_id uuid,\s*p_idempotency_key text,\s*p_payload_fingerprint text,\s*p_token_hash text,\s*p_expires_at timestamptz,\s*p_recovery_path text/);
    expect(statements).not.toContain("CREATE FUNCTION public.customer_support_journey");
  });

  it("authorizes before reading customer or dunning state", () => {
    const action = routine("customer_support_issue_recovery");
    const authority = action.indexOf("communications_require_active_operator(p_operator_id)");
    expect(authority).toBeGreaterThan(0);
    expect(action.indexOf("FROM public.clients")).toBeGreaterThan(authority);
    expect(action.indexOf("FROM public.subscription_dunning_cases")).toBeGreaterThan(authority);
  });

  it("serializes immutable fingerprints and replays without durable side effects", () => {
    const action = routine("customer_support_issue_recovery");
    const lock = action.indexOf("pg_advisory_xact_lock");
    const receipt = action.indexOf("FROM public.customer_support_recovery_commands");
    const conflict = action.indexOf("customer_support_idempotency_conflict");
    const replay = action.indexOf("'\"replayed\"'");
    const replayEnd = action.indexOf("END IF;", replay);
    const tokenIssue = action.indexOf("subscription_rotate_payment_recovery_token");
    expect(lock).toBeGreaterThan(0);
    expect(receipt).toBeGreaterThan(lock);
    expect(conflict).toBeGreaterThan(receipt);
    expect(replay).toBeGreaterThan(conflict);
    expect(tokenIssue).toBeGreaterThan(replay);
    expect(replayEnd).toBeGreaterThan(replay);
    expect(action.slice(replay, replayEnd)).not.toMatch(
      /INSERT INTO public\.(?:customer_support_recovery_audit_events|subscription_payment_recovery_tokens|subscription_dunning_notifications)/,
    );
  });

  it("pins every refusal and validates the existing customer/case/order authority", () => {
    const action = routine("customer_support_issue_recovery");
    for (const refusal of [
      "subject_not_found",
      "lifecycle_not_eligible",
      "case_not_found",
      "case_not_open",
      "recoverable_order_unavailable",
      "dunning_authority_unavailable",
    ]) expect(action).toContain(`'${refusal}'`);
    expect(action).toContain("v_subject.lifecycle_stage <> 'customer'");
    expect(action).toContain("v_case.client_id <> p_subject_id");
    expect(action).toContain("order_row.status = 'pending_payment'");
    expect(action).toMatch(/recipient_kind = 'customer'[\s\S]+notification_kind = 'payment_failed'/);
    const refusal = action.slice(action.indexOf("IF v_refusal_code IS NOT NULL THEN"));
    expect(refusal.indexOf("customer_support_recovery_commands"))
      .toBeLessThan(refusal.indexOf("RETURN v_response"));
  });

  it("rotates the existing token and appends one notice to the same queue", () => {
    expect(statements).toMatch(/subscription_dunning_notifications_notification_kind_check[\s\S]+payment_recovery/);
    const action = routine("customer_support_issue_recovery");
    const rotation = routine("subscription_rotate_payment_recovery_token");
    const revoke = rotation.indexOf("UPDATE public.subscription_payment_recovery_tokens");
    const token = rotation.indexOf("INSERT INTO public.subscription_payment_recovery_tokens");
    const notice = action.indexOf("INSERT INTO public.subscription_dunning_notifications");
    expect(revoke).toBeGreaterThan(0);
    expect(token).toBeGreaterThan(revoke);
    expect(action).toContain("subscription_rotate_payment_recovery_token");
    expect(notice).toBeGreaterThan(action.indexOf("subscription_rotate_payment_recovery_token"));
    expect(action).toContain("'payment_recovery'");
    expect(action).toContain("v_source_notice.template_slug");
    expect(action).not.toMatch(/UPDATE public\.(?:subscriptions|subscription_cycles)/);
    expect(action.match(/INSERT INTO public\.subscription_dunning_notifications/g)).toHaveLength(1);
    expect(statements).not.toMatch(/CREATE TABLE public\.(?:subscription|customer).*recovery_tokens/);
  });

  it("keeps command and audit evidence physically append-only", () => {
    expect(statements).toContain("CREATE TRIGGER customer_support_recovery_commands_append_only");
    expect(statements).toContain("CREATE TRIGGER customer_support_recovery_audit_append_only");
    expect(routine("customer_support_refuse_recovery_ledger_mutation"))
      .toContain("customer_support_recovery_ledger_append_only");
    expect(statements).not.toMatch(/UPDATE public\.customer_support_recovery_(?:commands|audit_events)/);
    expect(statements).not.toMatch(/DELETE FROM public\.customer_support_recovery_(?:commands|audit_events)/);
  });

  it("stores and returns only sanitized authority outcomes", () => {
    const action = routine("customer_support_issue_recovery");
    const response = action.slice(action.lastIndexOf("v_response := jsonb_build_object("));
    expect(response).toContain("'delivery_status', 'queued'");
    expect(response).toContain("'audit_event_id', v_audit_id");
    expect(response.slice(0, response.indexOf("INSERT INTO public.customer_support_recovery_commands")))
      .not.toMatch(/token|hash|path|provider/i);
    expect(statements).not.toMatch(/RAISE (?:LOG|NOTICE|WARNING)/);
  });

  it("grants only service_role and fixes both function search paths", () => {
    expect(statements).not.toMatch(/GRANT .* TO (?:PUBLIC|anon|authenticated)/);
    expect(statements).toMatch(/GRANT SELECT, INSERT ON TABLE[\s\S]+TO service_role/);
    expect(statements).toMatch(/GRANT EXECUTE ON FUNCTION public\.customer_support_issue_recovery[\s\S]+TO service_role/);
    expect([...statements.matchAll(/SET search_path = pg_catalog/g)]).toHaveLength(3);
    expect(statements).not.toMatch(/SECURITY DEFINER|CREATE POLICY/);
  });
});
