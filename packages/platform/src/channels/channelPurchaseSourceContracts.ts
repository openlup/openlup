
export type { ChannelPurchaseNamespace, ChannelPurchasedProductFacts, ChannelPurchasedExpandedLine, ChannelPurchaseCapture, ChannelPullPage, ChannelPullProgressState, ChannelPullCursorReceipt } from "./contracts/index.js";
import { z } from "./validation.js";
import { normalizedChannelOrderSchema } from "./orderContracts.js";

import { channelScopeSchema, channelControlIdSchema as id, channelControlRefSchema as ref,
  channelControlDigestSchema as digest, channelControlTimeSchema as time, channelControlVersionSchema as version } from "./channelRegistryContracts.js";


export const channelPurchaseNamespaceSchema = z.object({ applicationRef: ref, channelExternalRef: ref.nullable() }).strict();
export const channelPurchasedProductFactsSchema = z.object({
  externalLineRef: ref, externalOfferRef: ref, purchasedAt: time,
  products: z.array(z.object({ externalProductRef: ref, quantityPerSet: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()).min(1).max(100),
}).strict().refine(row => new Set(row.products.map(product => product.externalProductRef)).size === row.products.length);
export const channelPurchaseExecutionSchema = z.object({ actorId: id, jobRunId: id }).strict();
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const channelPurchasedExpandedLineSchema = z.object({
  externalLineRef: ref, externalOfferRef: ref.nullable(), skuCode: ref,
  quantity: z.number().int().positive().max(2147483647), unitGrossMinor: minor, lineGrossMinor: minor, lineDiscountMinor: minor,
  vatRateBps: z.number().int().min(0).max(10000).nullable(), bundleCode: ref.nullable(),
  bundleQty: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  retained: z.object({ skuId: id, groupIndex: z.number().int().min(0).max(2), listingId: id,
    bundleDigest: digest, firstApprovalId: id, firstQualificationId: id,
    weightMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), normalizationFactor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict().refine(row => row.unitGrossMinor * row.quantity === row.lineGrossMinor && row.lineDiscountMinor <= row.lineGrossMinor);
export const channelPurchaseCaptureSchema = z.object({
  schemaVersion: z.literal("channel.purchase-source.v1"), captureId: id,
  scope: channelScopeSchema, namespace: channelPurchaseNamespaceSchema, execution: channelPurchaseExecutionSchema,
  providerEventId: ref, externalOrderRef: ref, externalOrderRevision: ref.nullable(), normalized: normalizedChannelOrderSchema,
  normalizedDigest: digest, rawSourceDigest: digest, products: z.array(channelPurchasedProductFactsSchema).min(1).max(100),
  capturedAt: time, pagePacketRef: id, retainedRows: z.array(channelPurchasedExpandedLineSchema).min(1).max(300).optional(),
}).strict().superRefine((capture, ctx) => {
  const order = capture.normalized;
  if (capture.providerEventId !== order.providerEventId || capture.externalOrderRef !== order.externalOrderRef ||
      capture.externalOrderRevision !== order.externalOrderRevision || capture.scope.currency !== order.currency ||
      new Set(capture.products.map(row => row.externalLineRef)).size !== capture.products.length ||
      capture.products.length !== order.lines.length || capture.products.some(row => !order.lines.some(line =>
        line.externalLineRef === row.externalLineRef && line.sellable.externalOfferRef === row.externalOfferRef))) {
    ctx.addIssue({ code: "custom", message: "captured purchase identity mismatch" });
  }
});
export const channelPullProgressStateSchema = z.object({ cursor: ref.nullable(), watermark: time.nullable(), generation: version }).strict();
export const channelPullCursorReceiptSchema = z.object({ pagePacketId: id, before: channelPullProgressStateSchema, after: channelPullProgressStateSchema }).strict()
  .refine(value => value.after.generation === value.before.generation + 1);
export const channelPullPageEventSchema = z.object({ providerEventId: ref, externalOrderRef: ref.nullable(), externalOrderRevision: ref.nullable(),
  occurredAt: time, rawSourceDigest: digest, disposition: z.enum(["purchase", "unresolved"]), captureRef: id.nullable(),
}).strict().refine(value => (value.disposition === "purchase") === (value.captureRef !== null));
export const channelPullPageSchema = z.object({
  schemaVersion: z.literal("channel.pull-page.v1"), pagePacketId: id, scope: channelScopeSchema, namespace: channelPurchaseNamespaceSchema,
  execution: channelPurchaseExecutionSchema, expected: channelPullProgressStateSchema,
  request: z.object({ from: ref.nullable(), limit: z.number().int().min(1).max(1000) }).strict(),
  events: z.array(channelPullPageEventSchema).max(1000),
  observedHead: z.object({ providerEventId: ref, occurredAt: time }).strict().nullable(), observedAt: time, next: channelPullProgressStateSchema,
}).strict().superRefine((page, ctx) => {
  const watermark = page.events.reduce((latest, event) => latest === null || Date.parse(event.occurredAt) > Date.parse(latest) ? event.occurredAt : latest, page.expected.watermark);
  if (page.request.from !== page.expected.cursor || page.events.length > page.request.limit ||
      page.next.generation !== page.expected.generation + 1 ||
      page.next.cursor !== (page.events.at(-1)?.providerEventId ?? page.expected.cursor) || page.next.watermark !== watermark ||
      new Set(page.events.map(event => event.providerEventId)).size !== page.events.length) {
    ctx.addIssue({ code: "custom", message: "captured page progress mismatch" });
  }
});
export const channelPurchaseCaptureReadSchema = z.object({ ledgerId: id, canonicalText: z.string().min(1).max(262144), inputDigest: digest }).strict();
export const channelPullPageReadSchema = z.object({ canonicalText: z.string().min(1).max(262144), inputDigest: digest, cursorReceipt: channelPullCursorReceiptSchema.nullable() }).strict();
export const channelPurchaseLineClaimSchema = z.object({
  schemaVersion: z.literal("channel.purchase-line.v1"), scope: channelScopeSchema, namespace: channelPurchaseNamespaceSchema, captureRef: id,
  externalOrderRef: ref, externalOrderRevision: ref.nullable(), externalLineRef: ref, externalOfferRef: ref,
  purchasedSets: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), externalPaymentRef: ref, rawSourceDigest: digest,
}).strict();
