import { z } from "zod";
import type { DestinationQueryExecutor } from "./index.js";

/** Shared lock order for the claim writer and the admission fence's order writer. */
export function destinationV2Prelock(ctx: { clientId: string; scopeRef: string; owner: object }, snapshotRef: string) {
  const { clientId, scopeRef } = ctx;
  const ownerScope = JSON.stringify(ctx);
  return async (writer: DestinationQueryExecutor): Promise<void> => {
    await writer.query("LOCK TABLE public.identity_privacy_erasures IN SHARE MODE");
    await writer.query("SELECT id FROM public.clients WHERE id = $1 FOR KEY SHARE", [clientId]);
    await writer.query("SELECT public.commerce_lock_destination_v2_selection($1, $2)", [ownerScope, scopeRef]);
    await writer.query("SELECT public.commerce_lock_destination_v2_document($1, $2, $3)", [ownerScope, scopeRef, snapshotRef]);
  };
}

export const contactKeys = ["recipientName", "contactEmail", "contactPhone", "companyName", "label", "taxId", "deliveryNotes", "courierInstructions"] as const;
export const jsonText = (value: string) => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value);
export const utcMillis = (value: string) => value.length === 24 && !value.startsWith("0000")
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const utc = z.string().refine(utcMillis);
const serviceRef = z.string().refine(value => value.length > 0 && [...value].length <= 256 && jsonText(value));
const bindingShape = {
  snapshotRef: uuid, schemaVersion: z.literal(2), destinationDigest: digest,
  policyRevision: z.string().refine(value => /[^ ]/u.test(value) && Buffer.byteLength(value, "utf8") <= 720),
};
export const bindingSchema = z.strictObject(bindingShape);
const selectionSchema = z.strictObject({ kind: z.literal("checkout"), scopeRef: uuid, selectionRevision: uuid });
export const snapshotResult = z.union([
  z.strictObject({ binding: bindingSchema, selection: selectionSchema, evidenceExpiresAt: utc, eventId: uuid, replayed: z.boolean() }),
  z.strictObject({ evidenceDisposition: z.literal("erased") }),
]);
export const readResult = z.strictObject({
  binding: bindingSchema, documentDigest: digest, evidenceExpiresAt: utc,
  document: z.strictObject({
    ...bindingShape, revision: z.literal(1), clientId: uuid, policyRef: z.string(), classificationKeys: z.array(z.string()),
    owner: z.strictObject({ installationRef: z.string(), principalKind: z.literal("customer"), principalRef: uuid, customerOrSessionRef: uuid }),
    address: z.strictObject({ line1: z.string(), line2: z.string().optional(), city: z.string(), postalCode: z.string(),
      country: z.string(), subdivision: z.string().optional() }),
    contact: z.strictObject(Object.fromEntries(contactKeys.map(key => [key, z.string().optional()]))),
  }),
});
export const retainedReadResult = z.union([
  readResult,
  readResult.extend({ documentPurpose: z.literal("subscription"), evidenceExpiresAt: z.null() }),
]);
const serviceSchema = z.strictObject({
  deliverySelectionRef: serviceRef, providerRef: serviceRef, carrierRef: serviceRef, serviceRef,
  servicePolicyRevision: serviceRef, adapterRevision: serviceRef,
});
export const recheckResult = z.strictObject({ binding: bindingSchema, selection: selectionSchema, service: serviceSchema });
const subscriptionRecheck = recheckResult.extend({ selection: selectionSchema.extend({ kind: z.literal("subscription") }) });

export type SubscriptionSuccessComparison = {
  field: string;
  expected: string;
  keys?: readonly string[];
};

const bindingKeys = ["snapshotRef", "schemaVersion", "destinationDigest", "policyRevision"] as const;
const selectionComparisons = [
  { field: "selection.kind", expected: "request.kind" },
  { field: "selection.scopeRef", expected: "request.scopeRef" },
  { field: "binding", expected: "request.binding", keys: bindingKeys },
] as const;

export const subscriptionSuccessDecoders = {
  current: {
    schema: z.strictObject({ binding: bindingSchema, selectionRevision: uuid, service: serviceSchema }),
    comparisons: [],
  },
  exact: {
    schema: readResult.extend({ ...subscriptionRecheck.shape, evidenceExpiresAt: z.null() }),
    comparisons: [
      ...selectionComparisons,
      ...bindingKeys.map(key => ({ field: `document.${key}`, expected: `result.binding.${key}` })),
      { field: "document.clientId", expected: "request.context.clientId" },
      { field: "document.owner", expected: "request.context.owner",
        keys: ["installationRef", "principalKind", "principalRef", "customerOrSessionRef"] },
      { field: "document.owner.customerOrSessionRef", expected: "result.document.clientId" },
    ],
  },
  recheck: {
    schema: subscriptionRecheck,
    comparisons: [
      ...selectionComparisons,
      { field: "selection.selectionRevision", expected: "request.selectionRevision" },
      { field: "service", expected: "request.service",
        keys: ["deliverySelectionRef", "providerRef", "carrierRef", "serviceRef", "servicePolicyRevision", "adapterRevision"] },
    ],
  },
} as const satisfies Record<string, { schema: z.ZodType; comparisons: readonly SubscriptionSuccessComparison[] }>;
