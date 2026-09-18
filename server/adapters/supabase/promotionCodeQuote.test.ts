import { describe, expect, it, vi } from "vitest";

import { createSupabasePromotionCodeQuotePort } from "./promotionCodeQuote.js";

describe("Supabase promotion-code quote port", () => {
  it("uses the v2 advisory RPC and maps its UI-safe rejection details", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          promotionId: "11111111-1111-4111-8111-111111111111",
          codeId: "22222222-2222-4222-8222-222222222222",
          code: "SAVE80",
          codeRevision: 3,
          definitionFingerprint: "a".repeat(64),
          minimumReferenceMinor: 0,
          validTo: "2026-07-17T00:00:00.000Z",
          name: "Save 80",
          source: "code",
          scopes: ["one_time", "subscription_initial"],
          lane: "product",
          kind: "target_percentage",
          valueBps: 8_000,
        }],
        codeRejections: [{ code: "SCOPE80", reason: "not_eligible" }],
        codeRejectionDetails: [{
          code: "SCOPE80",
          reason: "scope_not_applicable",
          allowedScopes: ["one_time"],
        }],
      },
      error: null,
    });
    const port = createSupabasePromotionCodeQuotePort({ rpc });

    await expect(port.resolve({
      codes: ["save80"],
      clientId: "33333333-3333-4333-8333-333333333333",
      purchaseScope: "one_time",
      referenceProductMinor: 10_000,
      atTime: "2026-07-14T10:00:00.000Z",
    })).resolves.toMatchObject({
      candidates: [expect.objectContaining({ code: "SAVE80", codeRevision: 3 })],
      codeRejectionDetails: [{ code: "SCOPE80", reason: "scope_not_applicable" }],
    });
    expect(rpc).toHaveBeenCalledWith("commerce_promotion_codes_quote_candidates_v2", {
      p_codes: ["save80"],
      p_client_id: "33333333-3333-4333-8333-333333333333",
      p_scope: "one_time",
      p_reference_product_minor: 10_000,
      p_at: "2026-07-14T10:00:00.000Z",
    });
  });

  it("normalizes an omitted unbounded validTo from the v2 RPC to null", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          promotionId: "11111111-1111-4111-8111-111111111111",
          codeId: "22222222-2222-4222-8222-222222222222",
          code: "STAGING20",
          codeRevision: 2,
          definitionFingerprint: "a".repeat(64),
          minimumReferenceMinor: 0,
          name: "Staging rollout 20%",
          source: "code",
          scopes: ["one_time", "subscription_initial"],
          lane: "product",
          kind: "target_percentage",
          valueBps: 2000,
        }],
        codeRejections: [],
        codeRejectionDetails: [],
      },
      error: null,
    });

    const resolved = await createSupabasePromotionCodeQuotePort({ rpc }).resolve({
      codes: ["STAGING20"],
      clientId: null,
      purchaseScope: "one_time",
      referenceProductMinor: 16_688,
      atTime: "2026-07-22T12:00:00.000Z",
    });

    expect(resolved.candidates).toEqual([
      expect.objectContaining({ code: "STAGING20", validTo: null }),
    ]);
  });

  it("falls back to v1 only when the additive RPC is not installed", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } })
      .mockResolvedValueOnce({
        data: {
          candidates: [],
          codeRejections: [{ code: "SCOPE80", reason: "not_eligible" }],
        },
        error: null,
      });

    await expect(createSupabasePromotionCodeQuotePort({ rpc }).resolve({
      codes: ["SCOPE80"], clientId: null, purchaseScope: "subscription_initial",
      referenceProductMinor: 10_000, atTime: "2026-07-22T12:00:00.000Z",
    })).resolves.toEqual({
      candidates: [],
      codeRejections: [{ code: "SCOPE80", reason: "not_eligible" }],
      codeRejectionDetails: [],
    });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "commerce_promotion_codes_quote_candidates_v2",
      "commerce_promotion_codes_quote_candidates",
    ]);
  });

  it("fails closed on a v2 RPC error other than undefined-function", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "42501", message: "secret customer code SAVE80" },
    });
    await expect(createSupabasePromotionCodeQuotePort({ rpc }).resolve({
      codes: ["SAVE80"], clientId: null, purchaseScope: "one_time",
      referenceProductMinor: 10_000, atTime: "2026-07-14T10:00:00.000Z",
    })).rejects.toThrow("promotion_code_quote_read_failed:42501");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed candidates and masks a legacy fallback failure", async () => {
    const malformed = createSupabasePromotionCodeQuotePort({
      rpc: vi.fn().mockResolvedValue({
        data: { candidates: [{ code: "SAVE80" }], codeRejections: [], codeRejectionDetails: [] },
        error: null,
      }),
    });
    await expect(malformed.resolve({
      codes: ["SAVE80"], clientId: null, purchaseScope: "one_time",
      referenceProductMinor: 10_000, atTime: "2026-07-14T10:00:00.000Z",
    })).rejects.toThrow();

    const failed = createSupabasePromotionCodeQuotePort({
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: null, error: { code: "42883" } })
        .mockResolvedValueOnce({ data: null, error: { code: "42501", message: "secret customer code SAVE80" } }),
    });
    await expect(failed.resolve({
      codes: ["SAVE80"], clientId: null, purchaseScope: "one_time",
      referenceProductMinor: 10_000, atTime: "2026-07-14T10:00:00.000Z",
    })).rejects.toThrow("promotion_code_quote_read_failed:42501");
  });
});
