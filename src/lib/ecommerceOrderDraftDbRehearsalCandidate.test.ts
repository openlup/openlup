import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, explicitFunctionExecuteRoles, explicitTablePrivileges } from "../test/historicalBoundarySchema";
import { describe, expect, it } from "vitest";

const migration = effectiveFunctionBody("commerce_create_order_draft_with_outbox");

describe("ecommerce order draft DB rehearsal candidate", () => {
  it("retains durable outbox replay identity and server-only draft execution", () => {
    const outbox = currentTableStatements("outbox_events");
    expect(outbox).toContain("UNIQUE (event_type, idempotency_key)");
    expect(outbox).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path TO 'public', 'pg_catalog'");
    for (const roles of explicitFunctionExecuteRoles("commerce_create_order_draft_with_outbox").values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
    const roles = explicitTablePrivileges("outbox_events");
    for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.get(role)?.size ?? 0).toBe(0);
  });
  it("keeps order draft writes atomic and idempotent inside one RPC", () => {
    const requiredPhrases = [
      "v_scope constant text := 'commerce.order_draft.create'",
      "v_event_type constant text := 'commerce.order_draft.created'",
      "v_request_fingerprint := md5",
      "FOR UPDATE",
      "status = 'completed'",
      "jsonb_set(v_existing.response_payload, '{orderDraft,replayed}', 'true'::jsonb",
      "commerce_order_draft_idempotency_conflict",
      "INSERT INTO public.commerce_orders",
      "INSERT INTO public.outbox_events",
      "UPDATE public.commerce_idempotency_keys",
    ];

    for (const phrase of requiredPhrases) {
      expect(migration).toContain(phrase);
    }
  });

  it("retains canonical item-money persistence within the draft writer", () => {
    expect(migration).toContain("INSERT INTO public.commerce_order_items");
    expect(migration).toContain("unit_price_cents");
    expect(migration).toContain("effective_total_cents");
    expect(migration).toContain("'quoteLine', v_line");
  });
});
