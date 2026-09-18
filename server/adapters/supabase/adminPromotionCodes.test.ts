import { describe, expect, it, vi } from "vitest";

import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import { promotionCodeSummarySchema } from "../../../src/domains/commerce/adminPromotionCodesContracts.js";
import { createSupabaseAdminPromotionCodesDataPort } from "./adminPromotionCodes.js";

describe("Supabase admin promotion-codes adapter", () => {
  it("rejects malformed datetime/UUID cursors before calling RPC", async () => {
    const rpc = vi.fn();
    const port = createSupabaseAdminPromotionCodesDataPort({ rpc });
    const cursor = Buffer.from(JSON.stringify({ createdAt: "not-a-date", id: "not-a-uuid" })).toString("base64url");
    await expect(port.list("admin", {
      status: "active", scope: "all", cursor, limit: 25,
    })).rejects.toEqual(expect.objectContaining<Partial<DomainRpcError>>({
      sqlstate: "22023", pgMessage: "promotion_code_cursor_invalid",
    }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps legacy percentage semantics, engine marker and revision from list", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{
      id: "00000000-0000-4000-8000-000000000001",
      code: "LEGACY10", name: "Legacy", admin_description: null,
      benefits: [{ lane: "product", kind: "percentage", valueBps: 1_000 }],
      promotion_engine_version: "promotion-engine.v1",
      scopes: ["one_time", "subscription_initial"], status: "active", effective_status: "active",
      valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
      minimum_reference_minor: 750,
      redemption_limit_global: 5, redemption_limit_per_customer: 1,
      redeemed_count: 1, reserved_count: 0, remaining_count: 4,
      created_at: "2026-01-01T00:00:00.000Z", revision: 3,
      }], error: null })
      .mockResolvedValueOnce({ data: {
        ready: false,
        unprojectedCount: 2,
        collisionGroupCount: 1,
      }, error: null });
    const result = await createSupabaseAdminPromotionCodesDataPort({ rpc }).list("admin", {
      status: "all", scope: "all", limit: 25,
    });
    expect(result.codes[0]).toEqual(expect.objectContaining({
      promotionEngineVersion: "promotion-engine.v1",
      benefits: [{ lane: "product", kind: "percentage", valueBps: 1_000 }],
      minimumReferenceMinor: 750,
      revision: 3,
    }));
    expect(promotionCodeSummarySchema.parse(result.codes[0]).minimumReferenceMinor).toBe(750);
    expect(result.legacyCompatibility).toEqual({
      ready: false,
      unprojectedCount: 2,
      collisionGroupCount: 1,
    });
    expect(rpc).toHaveBeenCalledWith("admin_promotion_codes_legacy_compatibility", {
      p_actor_id: "admin",
    });
  });

  it("maps an expired definition validity end for activation gating", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      benefits: [{ lane: "product", kind: "percentage", valueBps: 1_000 }],
      scopes: ["one_time"], minimum_reference_minor: 0, revision: 7,
      status: "active", valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: "2026-01-02T00:00:00.000Z",
      promotion_engine_version: "promotion-engine.v1",
    }, error: null });

    const definition = await createSupabaseAdminPromotionCodesDataPort({ rpc }).definition(
      "admin",
      "00000000-0000-4000-8000-000000000001",
    );

    expect(definition.validTo).toBe("2026-01-02T00:00:00.000Z");
    expect(rpc).toHaveBeenCalledWith("admin_promotion_code_definition", {
      p_actor_id: "admin",
      p_code_id: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("passes expected revision to update and never passes preview proof to SQL", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      id: "00000000-0000-4000-8000-000000000001", status: "paused", revision: 4,
      idempotent: false,
    }, error: null });
    const port = createSupabaseAdminPromotionCodesDataPort({ rpc });
    await port.update({
      actorId: "admin",
      request: {
        id: "00000000-0000-4000-8000-000000000001", expectedRevision: 3,
        updates: { status: "paused" }, previewProof: "S".repeat(43),
        idempotencyKey: "00000000-0000-4000-8000-000000000002",
      },
      requestFingerprint: "f".repeat(64),
    });
    expect(rpc).toHaveBeenCalledWith("admin_promotion_code_update", expect.objectContaining({
      p_expected_revision: 3,
    }));
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_preview_proof");
  });
});
