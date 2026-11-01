
export type { ChannelListingDraft, ChannelBundleBinding, ChannelOfferObservation, ChannelBasis, ChannelQualification, ChannelApproval, ChannelListingDetail } from "./contracts/index.js";
import { z } from "./validation.js";
import { channelCurrencySchema } from "./contracts.js";
import { channelControlIdSchema as id, channelControlRefSchema as ref,
  channelControlDigestSchema as digest, channelControlTimeSchema as time,
  channelControlVersionSchema as version, channelScopeSchema } from "./channelRegistryContracts.js";

// Historical read facts only. This module cannot qualify, publish or approve a listing.
const quantity = z.number().int().min(1).max(999);
const money = z.object({ grossMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: channelCurrencySchema }).strict();
const uniqueSkus = <T extends { skuId: string }>(rows: readonly T[]) => new Set(rows.map(row => row.skuId)).size === rows.length;
export const channelMappingSchema = z.array(z.object({ skuId: id, externalProductRef: ref }).strict()).min(1).max(100)
  .refine(uniqueSkus, "SKU mappings must be unique")
  .refine(rows => new Set(rows.map(row => row.externalProductRef)).size === rows.length, "external mappings must be unique");
export const channelListingDraftSchema = z.object({
  id, version, scope: channelScopeSchema, bundleId: id, externalOfferRef: ref,
  state: z.enum(["draft", "qualified", "approved"]), manualStop: z.boolean(), approvalId: id.nullable(),
}).strict();
export const channelBundleBindingSchema = z.object({
  bundleId: id, code: ref, compositionDigest: digest, lockedAt: time.nullable(),
  fulfillmentMode: ref, constraintRef: ref.nullable(),
  components: z.array(z.object({ skuId: id, skuCode: ref, quantity, isAddon: z.boolean() }).strict())
    .min(1).max(100).refine(uniqueSkus, "BOM identities must be unique"),
}).strict();
export const channelOfferObservationSchema = z.object({
  observationRef: ref, observedAt: time, scope: channelScopeSchema, externalOfferRef: ref,
  revisionRef: ref.nullable(), controlledDigest: digest,
  products: z.array(z.object({ externalProductRef: ref, quantity,
    unitIdentifiers: z.array(z.object({ kind: ref, issuer: ref, value: ref }).strict()).min(1).max(32),
  }).strict()).min(1).max(100)
    .refine(rows => new Set(rows.map(row => row.externalProductRef)).size === rows.length, "products must be unique"),
  price: money,
  terms: z.object({ digest, deliveryRef: ref, returnsRef: ref.nullable(), documentPolicyRef: ref, fiscalProfileRef: ref }).strict(),
  sellingState: ref, restrictions: z.array(ref).max(32),
}).strict();
export const channelBasisSchema = z.array(z.object({
  skuId: id, weightMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  priceListId: ref, priceEntryId: ref, resolvedAt: time,
  sourceMode: ref, sourceAmountKind: ref, matchedMinQty: quantity,
}).strict()).min(1).max(100).refine(uniqueSkus, "basis must be unique");
export const channelQualificationSchema = z.object({
  id, listingId: id, listingVersion: version, connectionVersion: version, registryVersion: version,
  bundleDigest: digest, catalogHead: z.object({ protocol: ref, headDigest: digest.nullable() }).strict(),
  purchaseMode: z.literal("one_time"), sourceDigest: digest, policyRef: ref, policyDigest: digest,
  offer: channelOfferObservationSchema, mapping: channelMappingSchema, basis: channelBasisSchema,
  requestedPrice: money, validUntil: time, disposition: z.enum(["qualified", "blocked", "unknown"]),
  reasons: z.array(z.object({ skuId: id.optional(), field: ref.optional(), reason: ref, nextAction: ref }).strict()).max(200),
}).strict();
export const channelApprovalSchema = z.object({
  id, listingId: id, qualificationId: id, listingVersion: version,
  approvedBy: id, approvedAt: time, bundleDigest: digest, requestedPrice: money,
  controlledDigest: digest, termsDigest: digest, policyRef: ref, firstBasisApprovalId: id,
  recoveryPolicy: z.literal("same_approved_offer_when_ready"),
}).strict();
export const channelListingDetailSchema = z.object({
  listing: channelListingDraftSchema, qualification: channelQualificationSchema.nullable(),
  currentApproval: channelApprovalSchema.nullable(), firstApproval: channelApprovalSchema.nullable(),
  firstQualification: channelQualificationSchema.nullable(),
}).strict();
