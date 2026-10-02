import { describe, expect, it } from "vitest";
import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, explicitTablePrivileges, explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";
const tables = ["omnipack_dispatch_refs", "omnipack_status_evidence", "omnipack_stock_sync_cursors", "omnipack_stock_snapshots", "omnipack_low_stock_evidence"];
const functions = ["omnipack_record_dispatch_ref", "omnipack_record_status_evidence", "omnipack_upsert_stock_sync_cursor", "omnipack_record_stock_snapshot", "omnipack_record_low_stock_evidence"];
describe("installed OmniPack evidence boundaries", () => {
  it("retains evidence RLS and server-only explicit function/table privileges", () => {
    for (const table of tables) {
      expect(currentTableStatements(table)).toContain("ENABLE ROW LEVEL SECURITY");
      const acl = explicitTablePrivileges(table);
      expect(acl.get("service_role")?.has("SELECT")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(acl.get(role)?.size ?? 0).toBe(0);
    }
    for (const name of functions) for (const roles of explicitFunctionExecuteRoles(name).values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
  });
  it("retains shared inbound-event identity without a tracking fork", () => {
    expect(currentTableStatements("omnipack_status_evidence")).toContain("REFERENCES public.inbound_provider_events(id) ON DELETE SET NULL");
    for (const name of functions) expect(effectiveFunctionBody(name)).not.toMatch(/INSERT INTO public\.shipment_external_refs|CREATE TABLE/);
  });
  it("keeps evidence recording separate from inventory writes and provider traffic", () => {
    for (const name of functions) {
      const body = effectiveFunctionBody(name);
      expect(body).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) public\.inventory_|inventory_consume_reservation|inventory_adjust_stock|inventory_reserve_order|net\.http_|Authorization: Basic/);
    }
  });
  it("retains immutable replay fences for dispatch, status, stock and low-stock evidence", () => {
    const legacy = effectiveFunctionBody("omnipack_record_dispatch_ref");
    expect(legacy).toContain("omnipack_dispatch_ref_submission_fence_required");
    expect(legacy).toContain("RETURN public.omnipack_record_dispatch_ref_v2(");
    const dispatch = effectiveFunctionBody("omnipack_record_dispatch_ref_v2");
    expect(dispatch).toContain("v_ref.request_fingerprint IS NOT DISTINCT FROM p_request_fingerprint");
    expect(dispatch).toContain("omnipack_dispatch_ref_idempotency_conflict");
    expect(dispatch).toContain("updated_at = CASE WHEN v_replayed THEN updated_at ELSE now() END");
    for (const name of ["omnipack_record_status_evidence", "omnipack_record_stock_snapshot", "omnipack_record_low_stock_evidence"]) {
      const body = effectiveFunctionBody(name);
      expect(body).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
      expect(body).toContain("WHERE idempotency_key = btrim(p_idempotency_key)");
      expect(body).toContain("v_replayed := true");
      expect(body).toContain("'replayed', v_replayed");
    }
  });
  it("keeps the explicit provider-stock consume boundary behind its own ledger", () => {
    expect(currentTableStatements("fulfillment_provider_stock_current")).toContain("provider_for_sale_quantity");
    const body = effectiveFunctionBody("commerce_fulfillment_mark_provider_stock_consumed");
    expect(body).toContain("inventory_consume_reservation_for_fulfillment");
    expect(body).toContain("idempotency_key = p_idempotency_key");
  });
});
