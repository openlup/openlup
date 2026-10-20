import { build } from "esbuild";
import * as localPromotions from "../../../src/domains/commerce/adminPromotionsContracts.js";
import * as localCodes from "../../../src/domains/commerce/adminPromotionCodesContracts.js";
import * as serverCodes from "@openlup/platform/promotions";
import type * as dto from "@openlup/platform/promotions/contracts";
import { ambientSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
import { expect, expectTypeOf, it, vi } from "vitest";
import { createAdminPromotionCodesHandlers, type PromotionCodeCreateRequest, type PromotionCodeBenefit, type AdminPromotion, createAdminPromotionSchemas } from "@openlup/platform/promotions";
import type { PromotionCodeCreateRequest as DtoCreate, PromotionCodeBenefit as DtoBenefit, AdminPromotion as DtoPromotion } from "@openlup/platform/promotions/contracts";
import { bindings, DomainRpcError } from "./adminFixtures.js";
import { createAdminMutationHandler } from "../../../server/_lib/admin-domain/handlers.js";
import { promotionCodeCreateRequestSchema as referenceCreate } from "../../../src/domains/commerce/adminPromotionCodesContracts.js";
import { promotionCodeCreateRequestSchema } from "@openlup/platform/promotions";
import { platformCurrencySchema } from "../../../src/lib/currency/platformCurrency.js";
import type { z } from "zod";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";

it("binds the real human gate, host error identity and preview delegation; DTO outputs match schemas", async () => {
  expectTypeOf<PromotionCodeCreateRequest>().toEqualTypeOf<DtoCreate>();
  expectTypeOf<PromotionCodeBenefit>().toMatchTypeOf<DtoBenefit>();
  expectTypeOf<DtoBenefit>().toMatchTypeOf<PromotionCodeBenefit>();
  expectTypeOf<AdminPromotion>().toEqualTypeOf<DtoPromotion>();
  const schemas = createAdminPromotionSchemas({ currencySchema: platformCurrencySchema });
  expectTypeOf<z.infer<typeof schemas.adminPromotionSchema>>().toEqualTypeOf<DtoPromotion>();
  expect(referenceCreate.safeParse({})).toEqual(promotionCodeCreateRequestSchema.safeParse({}));
  expect(bindings.DomainRpcError).toBe(DomainRpcError);
  const kit = vi.fn(createAdminMutationHandler), preview = vi.fn(bindings.previewPromotionCode);
  const handlers = createAdminPromotionCodesHandlers({ ...bindings, createAdminMutationHandler: kit, previewPromotionCode: preview });
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() } as unknown as HttpResponse;
  const deps = { dataPort: { create: vi.fn() } as never, previewSecret: "synthetic-preview-key-000000000000000000", authorizeAdmin: async () => ({ ok: true as const, userId: "operator", role: "admin" as const, isMachineActor: true }) };
  await handlers.createAdminPromotionCodeCreateHandler(deps)({ method: "POST", body: {} } as HttpRequest, res);
  expect(kit).toHaveBeenCalledOnce(); expect(res.status).toHaveBeenCalledWith(403);
  const input = { benefits: [{ lane: "product", kind: "target_percentage", valueBps: 2000 }], scopes: ["one_time"], promotionEngineVersion: "promotion-engine.v2", minimumReferenceMinor: 0, context: { referenceProductMinor: 10000, oneTimeProductMinor: 10000, subscriptionProductMinor: 9000, shippingMinor: 500 } };
  await handlers.createAdminPromotionCodePreviewHandler({ ...deps, authorizeAdmin: async () => ({ ok: true, userId: "operator", role: "admin", isMachineActor: false }) })({ method: "POST", body: input } as HttpRequest, res);
  expect(preview).toHaveBeenCalledWith(input, deps.previewSecret);
  expect(res.status).toHaveBeenLastCalledWith(200);
});

// Compare acceptance, errors and parsed bytes, including strip/default transforms.
function parity(local: z.ZodType, server: z.ZodType, values: unknown[]) {
  for (const value of values) expect(local.safeParse(value), JSON.stringify(value)).toEqual(server.safeParse(value));
}

it("preserves promotion update, read and mirror semantics with the same currency validator", () => {
  const server = createAdminPromotionSchemas({ currencySchema: platformCurrencySchema });
  expectTypeOf<localPromotions.AdminPromotion>().toMatchTypeOf<dto.AdminPromotion>();
  expectTypeOf<dto.AdminPromotion>().toMatchTypeOf<localPromotions.AdminPromotion>();
  expectTypeOf<localPromotions.AdminPromotionUpdateRequest>().toEqualTypeOf<dto.AdminPromotionUpdateRequest>();
  expectTypeOf<localPromotions.AdminPromotionUpdateResponse>().toEqualTypeOf<dto.AdminPromotionUpdateResponse>();
  expectTypeOf<localPromotions.AdminPromotionsListResponse>().toEqualTypeOf<dto.AdminPromotionsListResponse>();
  expectTypeOf<localPromotions.AdminPromotionV2Mirror>().toEqualTypeOf<dto.AdminPromotionV2Mirror>();
  expectTypeOf<localPromotions.AdminPromotionSemanticBenefit>().toMatchTypeOf<dto.AdminPromotionSemanticBenefit>();
  expectTypeOf<dto.AdminPromotionSemanticBenefit>().toMatchTypeOf<localPromotions.AdminPromotionSemanticBenefit>();
  const benefit = { kind: "target_percentage", valueBps: 1500, reference: "catalog_list_price", unitTargets: [{ variantId: "unit-a", sku: "UNIT-A", referenceMinor: 1000, targetMinor: 850, currency: ambientSettlementProfile.defaultCurrency }] };
  const row = { id: "promo-a", code: null, name: "Synthetic", triggerType: "automatic", discountType: "percentage", semanticBenefit: benefit, systemManaged: true, readOnly: true, v2Mirror: { id: "mirror-a", status: "active", ignored: true }, appliesToKind: "order_total", stackingRule: "exclusive", eligibility: {}, validFrom: "opaque-date", validTo: null, status: "active", regionAvailability: ["ZZ"], redemptionLimitGlobal: null, redemptionLimitPerCustomer: null };
  // Derive enum fixtures from the actual browser schema rather than invent values.
  row.triggerType = localPromotions.adminPromotionSchema.shape.triggerType.options[0];
  row.discountType = localPromotions.adminPromotionSchema.shape.discountType.options[0];
  row.appliesToKind = localPromotions.adminPromotionSchema.shape.appliesToKind.options[0];
  row.stackingRule = localPromotions.adminPromotionSchema.shape.stackingRule.options[0];
  expect(localPromotions.adminPromotionSchema.parse({ ...row, ignored: true })).not.toHaveProperty("ignored");
  const values: Record<string, unknown[]> = {
    adminPromotionSemanticBenefitSchema: [benefit, { ...benefit, valueBps: 0 }, { ...benefit, valueBps: 10000 }, { ...benefit, unitTargets: [{ ...benefit.unitTargets[0], currency: "!" }] }, { kind: "fixed_amount", valueMinor: 0, currency: ambientSettlementProfile.defaultCurrency }, { kind: "percentage", valuePercent: 120 }, { kind: "free_shipping", ignored: true }, { kind: "unavailable", reason: "system_managed_metadata_incomplete" }],
    adminPromotionV2MirrorSchema: [row.v2Mirror, null, { id: "", status: "active" }, { id: "mirror-a", status: "unknown" }],
    adminPromotionSchema: [row, { ...row, ignored: true }, { ...row, status: "unknown" }, { ...row, v2Mirror: null }],
    adminPromotionsListResponseSchema: [{ contractVersion: "commerce.v0", promotions: [row], ignored: true }, { contractVersion: "unknown", promotions: [] }],
    adminPromotionUpdatePayloadSchema: [{ name: "  Synthetic  " }, {}, { name: " " }, { discountValue: -1 }, { status: "active", ignored: true }, { validTo: null, redemptionLimitGlobal: 1 }, { redemptionLimitGlobal: 0 }, { redemptionLimitPerCustomer: 1.5 }],
    adminPromotionUpdateRequestSchema: [{ id: " promo-a ", updates: { name: " Synthetic " } }, { id: "promo-a", updates: {} }, { id: "promo-a", updates: { status: "paused" }, extra: true }],
    adminPromotionUpdateResponseSchema: [{ contractVersion: "commerce.v0", updated: true, id: "promo-a", ignored: true }, { contractVersion: "commerce.v0", updated: false, id: "promo-a" }],
  };
  for (const [key, inputs] of Object.entries(values)) parity(localPromotions[key], server[key], inputs);
});

it("preserves promotion-code create/update/list/preview and DTO semantics", () => {
  expectTypeOf<localCodes.PromotionCodeCreateRequest>().toEqualTypeOf<dto.PromotionCodeCreateRequest>();
  expectTypeOf<localCodes.PromotionCodeCreateResponse>().toEqualTypeOf<dto.PromotionCodeCreateResponse>();
  expectTypeOf<localCodes.PromotionCodeUpdateRequest>().toEqualTypeOf<dto.PromotionCodeUpdateRequest>();
  expectTypeOf<localCodes.PromotionCodeUpdateResponse>().toEqualTypeOf<dto.PromotionCodeUpdateResponse>();
  expectTypeOf<localCodes.PromotionCodesListRequest>().toEqualTypeOf<dto.PromotionCodesListRequest>();
  expectTypeOf<localCodes.PromotionCodesListResponse>().toMatchTypeOf<dto.PromotionCodesListResponse>();
  expectTypeOf<dto.PromotionCodesListResponse>().toMatchTypeOf<localCodes.PromotionCodesListResponse>();
  expectTypeOf<localCodes.PromotionCodeSummary>().toMatchTypeOf<dto.PromotionCodeSummary>();
  expectTypeOf<dto.PromotionCodeSummary>().toMatchTypeOf<localCodes.PromotionCodeSummary>();
  expectTypeOf<localCodes.PromotionCodeBenefit>().toMatchTypeOf<dto.PromotionCodeBenefit>();
  expectTypeOf<dto.PromotionCodeBenefit>().toMatchTypeOf<localCodes.PromotionCodeBenefit>();
  expectTypeOf<localCodes.PromotionCodePreviewRequest>().toMatchTypeOf<dto.PromotionCodePreviewRequest>();
  expectTypeOf<dto.PromotionCodePreviewRequest>().toMatchTypeOf<localCodes.PromotionCodePreviewRequest>();
  expectTypeOf<localCodes.PromotionCodePreviewResponse>().toEqualTypeOf<dto.PromotionCodePreviewResponse>();
  const id = "00000000-0000-4000-8000-000000000001";
  const benefits = [{ lane: "product", kind: "target_percentage", valueBps: 1000 }];
  const context = { referenceProductMinor: 1000, oneTimeProductMinor: 900, subscriptionProductMinor: 800, shippingMinor: 0 };
  const preview = { benefits, scopes: ["one_time"], context };
  const create = { name: " Synthetic ", code: { kind: "manual", value: " CODE-A " }, benefits, scopes: ["one_time"], validFrom: "2026-01-01T00:00:00Z", validTo: null, idempotencyKey: id };
  const update = { id, expectedRevision: 1, updates: { status: "active" }, idempotencyKey: id };
  const result = { scope: "one_time", productPayableMinor: 900, shippingPayableMinor: 0, effectiveProductDiscountBps: 1000, winner: "code", floorApplied: false, adjustments: [] };
  const summary = { id, code: "CODE-A", name: "Synthetic", description: null, benefits, promotionEngineVersion: "promotion-engine.v2", scopes: ["one_time"], status: "active", effectiveStatus: "scheduled", validFrom: "opaque-date", validTo: null, minimumReferenceMinor: 0, redemptionLimitGlobal: null, redemptionLimitPerCustomer: null, redeemedCount: 0, reservedCount: 0, remainingCount: null, createdAt: "opaque-date", revision: 1 };
  const response = { contractVersion: "commerce.v0", id, code: "CODE-A", status: "draft", revision: 1, idempotent: false, ignored: true };
  const proof = "a".repeat(43);
  const values: Record<string, unknown[]> = {
    promotionCodeBenefitSchema: [...benefits, { lane: "product", kind: "percentage", valueBps: 0 }, { lane: "shipping", kind: "fixed_amount", valueMinor: 0 }, { lane: "product", kind: "percentage", validationState: "unsupported_legacy_value" }, { ...benefits[0], ignored: true }],
    promotionCodePreviewContextSchema: [context, { ...context, oneTimeProductMinor: 1001 }, { ...context, subscriptionProductMinor: 1001 }, { ...context, shippingMinor: -1 }, { ...context, extra: true }],
    promotionCodePreviewRequestSchema: [preview, { ...preview, benefits: [...benefits, ...benefits] }, { ...preview, scopes: ["one_time", "one_time"] }, { ...preview, promotionEngineVersion: "promotion-engine.v1" }, { ...preview, extra: true }],
    promotionCodePreviewResultSchema: [result, { ...result, ignored: true }, { ...result, effectiveProductDiscountBps: 10001 }],
    promotionCodePreviewResponseSchema: [{ contractVersion: "commerce.v0", promotionEngineVersion: "promotion-engine.v2", previewProof: proof, results: [result, { ...result, scope: "subscription_initial" }] }, { contractVersion: "commerce.v0", previewProof: "bad", results: [] }],
    promotionCodeCreateRequestSchema: [create, { ...create, status: "active" }, { ...create, status: "active", previewContext: context, previewProof: proof }, { ...create, previewProof: "bad" }, { ...create, validTo: create.validFrom }, { ...create, validFrom: "bad" }, { ...create, scopes: ["one_time", "one_time"] }, { ...create, benefits: [...benefits, ...benefits] }, { ...create, extra: true }, ...[0, 10000, 1.5].map(valueBps => ({ ...create, benefits: [{ ...benefits[0], valueBps }] })), ...[0, 2147483648, 1.5].map(valueMinor => ({ ...create, benefits: [{ lane: "product", kind: "fixed_amount", valueMinor }] }))],
    promotionCodeCreateResponseSchema: [response, { ...response, revision: 0 }],
    promotionCodeUpdateRequestSchema: [update, { ...update, updates: {} }, { ...update, updates: { status: "paused", extra: true } }, { ...update, expectedRevision: 0 }, { ...update, previewProof: "bad" }],
    promotionCodeUpdateResponseSchema: [response, { ...response, status: "unknown" }],
    promotionCodesListRequestSchema: [{}, { q: " CODE-A ", limit: "10" }, { status: "expired_or_archived", scope: "both", limit: 100 }, { limit: 101 }, { q: " " }, { extra: true }],
    promotionCodeSummarySchema: [summary, { ...summary, ignored: true }, { ...summary, benefits: [...benefits, ...benefits] }],
    promotionCodesListResponseSchema: [{ contractVersion: "commerce.v0", codes: [summary], nextCursor: null, capabilities: { mutationsEnabled: false }, legacyCompatibility: { ready: false, unprojectedCount: 1, collisionGroupCount: 0 } }, { contractVersion: "commerce.v0", codes: [], nextCursor: null, capabilities: { mutationsEnabled: true, extra: true }, legacyCompatibility: { ready: true, unprojectedCount: 0, collisionGroupCount: 0 } }],
  };
  expect(localCodes.promotionCodeCreateRequestSchema.parse(create)).toMatchObject({ name: "Synthetic", description: null, status: "draft", minimumReferenceMinor: 0, code: { value: "CODE-A" } });
  for (const [key, inputs] of Object.entries(values)) parity(localCodes[key], serverCodes[key], inputs);
});

it("keeps both promotion clients and value-importing dialogs in a browser-safe closure", async () => {
  const browser = await build({ entryPoints: ["src/domains/commerce/adminPromotionsClient.ts", "src/domains/commerce/adminPromotionCodesClient.ts", "src/components/admin/PromotionEditDialog.tsx", "src/components/admin/promotion-codes/PromotionCodeCreateDialog.tsx", "src/components/admin/promotion-codes/PromotionCodeEditDialog.tsx", "src/components/admin/promotion-codes/PromotionCodePreviewDialog.tsx"], bundle: true, platform: "browser", format: "esm", outdir: "browser", write: false, metafile: true, minify: true });
  const inputs = Object.keys(browser.metafile!.inputs).map(path => path.replaceAll("\\", "/"));
  expect(inputs).toEqual(expect.arrayContaining(["src/domains/commerce/adminPromotionsContracts.ts", "src/domains/commerce/adminPromotionCodesContracts.ts"]));
  // Match workspace sources and installed packages, both source and emitted forms.
  const serverEntry = /(?:packages\/platform|node_modules\/@openlup\/platform)\/(?:src|dist)\/(?![^/]+\/contracts(?:\/|\.))/;
  for (const path of ["packages/platform/src/promotions/index.ts", "packages/platform/dist/promotions/index.js", "node_modules/@openlup/platform/src/promotions/index.ts", "node_modules/@openlup/platform/dist/promotions/index.js"]) expect(serverEntry.test(path)).toBe(true);
  expect(serverEntry.test("packages/platform/dist/pricing/contracts/index.js")).toBe(false);
  expect(inputs.filter(path => serverEntry.test(path))).toEqual([]);
});
