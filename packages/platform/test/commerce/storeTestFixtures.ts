import { z } from "zod";
import { createCommerceSchemas, createCheckoutResumeSchemas, checkoutResumeCompletionCoreSchema } from "../../src/commerce/index.js";
import { createCommerceQuoteSchemas, quoteDiscountSchema } from "../../src/pricing/index.js";
import { createOrderDraftRpcPayload, createCommerceOrderDraftRpcPort as createDraft, createCommerceCheckoutResumeQueryPort as createResume, createConfiguratorIntentPersistenceRpcPort as createPersistence } from "../../src/commerce/server/index.js";
import type { CommerceOrderDraftRpcClient as DraftClient, ConfiguratorIntentRpcQueryClient as IntentClient, ConfiguratorIntentPersistenceIdentity, CommerceCheckoutResumeClient } from "../../src/commerce/server/index.js";
import { quoteSnapshot } from "./checkoutTestFixtures.js";
const currencySchema = z.string().length(3);
export const moneySchema = z.object({ amountMinor: z.number().int(), currency: currencySchema });
export const pricing = createCommerceQuoteSchemas({ currencySchema, productSlugSchema: z.string(), contextSchema: z.object({ mode: z.enum(["one_time", "subscription"]), cadenceDays: z.number().nullable().optional(), promoCodes: z.array(z.string()), sizeConstraint: z.unknown().optional(), shippingTerms: z.object({ version: z.literal("shipping-threshold.v1"), currency: z.string(), flatMinor: z.number(), freeThresholdMinor: z.number().nullable() }).optional() }) });
export const quoteSchema = pricing.createQuoteResponseSchema;
export type CreateQuoteResponse = z.output<typeof quoteSchema>;
export const ORDER_DRAFT_SNAPSHOT_SOURCE = "commerce.order_draft.bff.v0";
const snapshotSchema = z.object({
  contractVersion: z.literal("commerce.v0"), source: z.literal(ORDER_DRAFT_SNAPSHOT_SOURCE),
  status: z.literal("draft"), paymentStatus: z.literal("not_started"), currency: currencySchema,
  taxIncluded: z.literal(true), lines: z.array(pricing.quoteLineSchema), discounts: z.array(quoteDiscountSchema),
  context: z.unknown().optional(), totals: z.object({ subtotalGross: moneySchema, discountTotalGross: moneySchema,
    totalGross: moneySchema, netTotal: moneySchema, taxTotal: moneySchema }).strict(),
}).strict().refine(s => s.lines.reduce((n,l) => n + l.lineSubtotalGross.amountMinor, 0) === s.totals.subtotalGross.amountMinor);
export const payloadBindings = { quoteSchema, draftSchema: snapshotSchema,
  createSnapshot(snapshot: CreateQuoteResponse) {
    const { currency, taxIncluded, lines, discounts, context, subtotalGross, discountTotalGross, totalGross, netTotal, taxTotal } = snapshot.quote;
    return { contractVersion: "commerce.v0" as const, source: ORDER_DRAFT_SNAPSHOT_SOURCE as "commerce.order_draft.bff.v0", status: "draft" as const, paymentStatus: "not_started" as const, currency, taxIncluded, lines, discounts, ...(context ? {context} : {}), totals: {subtotalGross, discountTotalGross, totalGross, netTotal, taxTotal} };
  } };
export const { createOrderDraftRpcArgs, orderDraftRpcArgsSchema } = createOrderDraftRpcPayload(payloadBindings);
export const schemas = createCommerceSchemas({ contractVersion: "commerce.v0", createQuoteResponseSchema: quoteSchema, commerceMoneySchema: moneySchema, commerceCurrencySchema: currencySchema, cartLineInputSchema: z.object({ sku: z.string(), quantity: z.number() }) });
export type CreateOrderDraftRequest = z.output<typeof schemas.createOrderDraftRequestSchema>;
export type CreateOrderDraftResponse = z.output<typeof schemas.createOrderDraftResponseSchema>;
export type CommerceOrderDraftRpcClient = DraftClient<ReturnType<typeof createOrderDraftRpcArgs>>;
export const createCommerceOrderDraftRpcPort = (client: CommerceOrderDraftRpcClient) => createDraft(client, { createOrderDraftRpcArgs, responseSchema: schemas.createOrderDraftResponseSchema });
export const resumeSchemas = createCheckoutResumeSchemas({ sectionSchema: z.enum(["review", "shipping"]), redactedFieldSchema: z.literal("contact"), completionSchema: checkoutResumeCompletionCoreSchema, productSlugSchema: z.string(), skuSchema: z.string() });
export type ResumeState = z.output<typeof resumeSchemas.checkoutResumeDraftStateSchema>;
export const createCommerceCheckoutResumeQueryPort = (client: CommerceCheckoutResumeClient) => createResume<"review" | "shipping", ResumeState, z.output<typeof resumeSchemas.checkoutResumeDraftSchema>>(client, resumeSchemas.checkoutResumeDraftSchema);
export const completedSchema = z.object({ contractVersion: z.literal("commerce.configurator_intent_persistence.v1"), intentVersion: z.string(), idempotencyKey: z.string(), clientId: z.guid(), subjectId: z.guid().nullable(), addressId: z.guid(), clientMatchReason: z.string(), replayed: z.boolean() });
export type CheckoutCommandV1 = { version: string; idempotencyKey: string; mode: string; lines: Array<{sku: string; quantity: number}>; customer: { firstName: string; lastName: string; email: string; phone: string }; shippingAddress: {street: string; postalCode: string; city: string; country: string}; currency: string; cadenceDays?: number };
export type Intent = { contact?: { phone?: string }; address?: { country?: string }; [key: string]: unknown };
export type ConfiguratorIntentRpcQueryClient = IntentClient<Intent, CheckoutCommandV1>;
export const normalizePhoneToE164 = (phone: string, _country: unknown) => phone === "123456789" || phone === "123456789 ext 4" ? "+99123456789" : phone === "2025550123" ? "+992025550123" : null;
export const persistenceBindings = { responseSchema: completedSchema, normalizePhoneToE164, decodeCommandResponse(data: unknown) {
  const parsed = completedSchema.parse(data);
  return { idempotencyKey: parsed.idempotencyKey, clientId: parsed.clientId, subjectId: parsed.subjectId, shippingAddressId: parsed.addressId, replayed: parsed.replayed };
} };
export const createConfiguratorIntentPersistenceRpcPort = (client: ConfiguratorIntentRpcQueryClient, identity?: ConfiguratorIntentPersistenceIdentity) => createPersistence<Intent, z.output<typeof completedSchema>, CheckoutCommandV1, ReturnType<typeof persistenceBindings.decodeCommandResponse>>(client, persistenceBindings, identity);
export function frozenQuote() { return quoteSchema.parse(quoteSnapshot()); }
