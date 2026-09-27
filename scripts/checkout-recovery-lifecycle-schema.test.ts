import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "db/platform/migrations/20260818120000_checkout_recovery_lifecycle.sql";
const OPERATOR_AUTHORIZE_FILE =
  "db/platform/migrations/20260824090000_checkout_recovery_operator_email_authorize.sql";
const MANAGED_RECOVERY_FILE = "supabase/migrations/20260721200000_expired_checkout_recovery.sql";
const sql = readFileSync(FILE, "utf8");
const operatorAuthorizeSql = readFileSync(OPERATOR_AUTHORIZE_FILE, "utf8");
const managedRecoverySql = readFileSync(MANAGED_RECOVERY_FILE, "utf8");

describe("checkout recovery lifecycle public forward", () => {
  it("adds no privileged execution path", () => {
    expect(sql).not.toMatch(/^\s*SECURITY\s+DEFINER\b/im);
    expect(sql).not.toMatch(/^\s*GRANT\s+/im);
  });

  it("does not expose a replacement-order or settlement mutation on the direct bundle", () => {
    expect(sql).not.toContain("commerce_checkout_recovery_replacements");
    expect(sql).not.toContain("commerce_prepare_expired_checkout_recovery");
    expect(sql).not.toContain("commerce_open_settlement_intent");
    expect(sql).not.toContain("commerce_record_settlement");
    expect(managedRecoverySql).toContain(
      "CREATE OR REPLACE FUNCTION public.commerce_prepare_expired_checkout_recovery",
    );
  });

  it("caps reminder intents, reauthorizes active claims and requires accepted 1h recovery", () => {
    expect(sql).toContain("commerce_enqueue_abandoned_cart_reminders");
    expect(sql).toContain("commerce_enqueue_checkout_recovery_reminders");
    expect(sql).toContain("commerce_checkout_reminder_delivery_authorize");
    expect(sql).toContain("receipt.state = 'accepted'");
    expect(sql).toContain("metadata->>'claimToken' = p_claim_token");
    expect(sql).toContain("marketing_newsletter_consent");
    expect(sql).toContain("receipt.invalidated_at IS NULL");
    expect(sql).not.toContain("'recoveryToken'");
    expect(sql).not.toContain("'recoveryTokenId'");
    expect(sql).not.toMatch(/(?:INSERT\s+INTO|UPDATE)\s+public\.commerce_checkout_recovery_tokens/i);
    const recoveryEnqueueSql = sql.slice(
      sql.indexOf("CREATE FUNCTION public.commerce_enqueue_checkout_recovery_reminders"),
      sql.indexOf("CREATE FUNCTION public.commerce_checkout_reminder_delivery_authorize"),
    );
    expect(recoveryEnqueueSql.match(/order_row\.subscription_cycle_id IS NULL/g)).toHaveLength(2);
    expect(sql).toContain("v_order.subscription_cycle_id IS NOT NULL OR NOT EXISTS");
  });

  it("compacts only old terminal rows and preserves every replay fence", () => {
    expect(sql).toContain("CREATE FUNCTION public.commerce_checkout_recovery_try_timestamptz");
    expect(sql).toContain("CREATE FUNCTION public.commerce_outbox_compact_terminal");
    expect(sql).toContain("event.status = 'processed'");
    expect(sql).toContain("event.status = 'discarded'");
    expect(sql).toContain("retentionCompactedAt");
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.outbox_events/i);
    expect(sql).not.toMatch(/event\.status\s+IN\s*\([^)]*(?:pending|processing|failed)/i);
    expect(sql).not.toContain("(event.metadata->>'discardedAt')::timestamptz");
  });
});

/**
 * The operator branch is the half of this wave the TypeScript tests cannot reach:
 * on the direct bundle a send passes this SQL gate before any handler runs, so a
 * missing branch here is a silent no-send for a link a human promised a customer.
 * The assertions below pin the branch AND the refusals it must keep making.
 */
describe("checkout recovery operator email authorize forward", () => {
  it("adds no privileged execution path", () => {
    expect(operatorAuthorizeSql).not.toMatch(/^\s*SECURITY\s+DEFINER\b/im);
    expect(operatorAuthorizeSql).not.toMatch(/^\s*GRANT\s+/im);
    expect(operatorAuthorizeSql).toContain(
      "CREATE OR REPLACE FUNCTION public.commerce_checkout_reminder_delivery_authorize",
    );
  });

  it("admits an operator-issued link on the live token rather than on pending_payment", () => {
    expect(operatorAuthorizeSql).toContain("checkout_recovery:operator:%");
    expect(operatorAuthorizeSql).toContain("NOT v_operator AND v_order.status <> 'pending_payment'");
    expect(operatorAuthorizeSql).toContain("token.revoked_at IS NULL");
    expect(operatorAuthorizeSql).toContain("token.expires_at > now()");
    expect(operatorAuthorizeSql).toContain("operator_checkout_recovery_link_not_live");
  });

  // The gate must stay read-only over the bearer-token table: authorization is not
  // a place that may mint, revoke or extend a link.
  it("reads the token table without writing to it", () => {
    expect(operatorAuthorizeSql).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.commerce_checkout_recovery_tokens/i,
    );
    expect(operatorAuthorizeSql).not.toContain("'recoveryToken'");
  });

  // Everything the previous body refused, this one still refuses. A full-body
  // replace that quietly drops a business guard is the incident these lines exist
  // for; the cron branch's two conditions and the claim fence are restated here.
  it("keeps every refusal the replaced body already made", () => {
    expect(operatorAuthorizeSql).toContain("metadata->>'claimToken' = p_claim_token");
    expect(operatorAuthorizeSql).toContain("'claim_not_active'");
    expect(operatorAuthorizeSql).toContain("'event_type_not_supported'");
    expect(operatorAuthorizeSql).toContain("'order_not_recoverable'");
    expect(operatorAuthorizeSql).toContain("'abandoned_reminder_no_longer_allowed'");
    expect(operatorAuthorizeSql).toContain("marketing_newsletter_consent");
    expect(operatorAuthorizeSql).toContain("receipt.invalidated_at IS NULL");
    expect(operatorAuthorizeSql).toContain("v_order.subscription_cycle_id IS NOT NULL OR NOT EXISTS");
    expect(operatorAuthorizeSql).toContain("WHERE order_id = v_order.id AND status = 'failed'");
    expect(operatorAuthorizeSql).toContain("'checkout_recovery_no_longer_allowed'");
  });

  // One template, one recipient rule, one idempotency key: the operator email is
  // the SAME email, so a divergence here would be a second transactional rail.
  it("resolves the same template, recipient and idempotency key as before", () => {
    // Both recovery branches, operator and cron, resolve the one shared template.
    expect(operatorAuthorizeSql.match(/v_template := 'commerce-checkout-recovery';/g)).toHaveLength(2);
    expect(operatorAuthorizeSql).toContain("'idempotencyKey', 'checkout-reminder:' || v_event.id");
    expect(operatorAuthorizeSql).toContain("'recipientReference', v_order.client_id");
    expect(operatorAuthorizeSql).toContain("'templateReference', v_template");
  });
});
