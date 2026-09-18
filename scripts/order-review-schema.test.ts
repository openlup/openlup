import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "db/platform/migrations/20260816100000_order_review_capability.sql",
  "utf8",
);

describe("portable order-review schema", () => {
  it("owns one neutral review, private media, receipts and append-only audit", () => {
    for (const table of [
      "commerce_order_reviews",
      "commerce_order_review_media",
      "commerce_order_review_command_receipts",
      "commerce_order_review_audit",
    ]) expect(migration).toContain(`CREATE TABLE public.${table}`);
    expect(migration).toContain("UNIQUE(order_id)");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("BEFORE TRUNCATE");
    expect(migration).toContain("access_revoked_at");
    expect(migration).toContain("authorizing_grant_reference text NOT NULL");
    expect(migration).toContain("authorizing_grant_kind text NOT NULL");
    expect(migration).toContain("commerce_order_review_media_authorizing_grant_fkey");
    expect(migration).toContain("commerce_order_review_media_authorizing_grant_idx");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration).not.toContain("SECURITY DEFINER");
  });

  it("resolves only exact accepted C-D20 grants and requires the effects parent", () => {
    const resolver = body("order_review_resolve_order");
    for (const clause of [
      "i.access_grant_reference=g.grant_reference",
      "i.kind=g.kind",
      "i.source_reference='order:'||g.order_id::text",
      "i.status='accepted'",
      "g.revoked_at IS NULL",
      "g.expires_at>p_now",
      "r.kind='review_request'",
      "r.source_reference=i.source_reference",
      "r.subject_reference=i.subject_reference",
      "r.recipient_fingerprint=i.recipient_fingerprint",
    ]) expect(resolver).toContain(clause);
    expect(migration).toContain("subscriber_retention_intents_order_review_grant_idx");
    expect(migration).toContain("subscriber_retention_intents_order_review_parent_idx");
  });

  it("implements the exact adapter RPC surface with fail-closed privileges", () => {
    for (const routine of [
      "read", "submit", "create_media_intent", "confirm_media", "moderate", "revoke_access",
      "admin_list", "admin_read", "read_media", "admit_media_upload", "lock_media_finalize",
      "record_media_stored", "abort_media_upload", "admin_read_media",
      "admin_prepare_media_delete", "admin_complete_media_delete",
      "claim_media_reconcile", "complete_media_reconcile",
    ]) {
      expect(migration).toContain(`CREATE FUNCTION public.order_review_${routine}`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.order_review_${routine}`);
    }
  });

  it("distinguishes an authorized empty review from an invalid grant", () => {
    const read = body("order_review_read");
    expect(read).toContain("v_order IS NULL THEN RETURN NULL");
    expect(read).toContain("jsonb_build_object('review',NULL,'media','[]'::jsonb)");
    expect(read).toContain("jsonb_build_object('review',public.order_review_json(v_review),'media'");
  });

  it("fences leases, exact-key cleanup and every competing transition", () => {
    expect(migration).toContain("commerce_order_review_media_expired_lease_idx");
    expect(migration).toContain("commerce_order_review_media_expired_intent_idx");
    expect(migration).toContain("commerce_order_review_media_cleanup_idx");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("reconcile_state_version=state_version");
    expect(migration).toContain("reconcile_state_version=state_version FOR UPDATE");
    expect(migration).toContain("state='cleanup_pending',writer_reference=NULL");
    expect(body("order_review_read_media")).toContain("m.state='confirmed'");
    expect(body("order_review_read")).toContain("m.authorizing_grant_reference=p_grant AND m.state='confirmed'");
    expect(body("order_review_admin_read")).toContain("m.state<>'deleted'");
    expect(body("order_review_revoke_access")).toContain("|review_effects");
    expect(body("order_review_revoke_access")).toContain("|review_request");
    expect(body("order_review_revoke_access")).toContain("next_attempt_at=GREATEST(p_now,COALESCE(writer_lease_expires_at,p_now))");
    expect(body("order_review_admin_prepare_media_delete")).toContain("next_attempt_at=GREATEST(p_now,COALESCE(writer_lease_expires_at,p_now))");
    expect(body("order_review_admin_complete_media_delete")).toContain("writer_lease_expires_at>p_now THEN RETURN NULL");
    expect(body("order_review_complete_media_reconcile")).toContain("p_reason='object_absent'");
    expect(body("order_review_abort_media_upload")).toContain("p_reason='object_absent'");
    expect(body("order_review_claim_media_reconcile")).toContain("writer_reference IS NULL AND capability_expires_at<=p_now");
    expect(body("order_review_claim_media_reconcile")).toContain("v_media.state='cleanup_pending' OR v_media.writer_reference IS NULL THEN 'delete'");
    expect(body("order_review_complete_media_reconcile")).toContain("v_media.state='pending' AND v_media.writer_reference IS NULL AND v_media.capability_expires_at<=p_now");
  });

  it("recomputes submissions and binds media to the one authorizing grant", () => {
    const submit = body("order_review_submit");
    expect(submit).toContain("p_rating::text||chr(10)||COALESCE(p_comment,'')");
    expect(submit).toContain("p_fingerprint<>v_canonical_fingerprint");
    const intent = body("order_review_create_media_intent");
    expect(intent).toContain("p_grant,v_grant_kind,p_capability_digest");
    for (const routine of ["order_review_read_media", "order_review_admit_media_upload", "order_review_lock_media_finalize", "order_review_claim_media_reconcile", "order_review_complete_media_reconcile"]) {
      expect(body(routine)).toContain("authorizing_grant_reference");
    }
    expect(body("order_review_admit_media_upload")).not.toContain("ORDER BY g.kind");
  });
});

function body(name: string): string {
  const start = migration.indexOf(`CREATE FUNCTION public.${name}`);
  const end = migration.indexOf("END $$;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}
