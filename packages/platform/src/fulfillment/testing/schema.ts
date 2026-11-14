import { isDeepStrictEqual, types } from "node:util";
import { z } from "zod";
import { parseFulfillmentFact } from "../normalizedFulfillmentFacts.js";
import { FULFILLMENT_REFUSAL_REASONS } from "../contracts/dispatch.js";
import type { FulfillmentDispatchPort, FulfillmentLabelPort, FulfillmentObservationPort, FulfillmentReadbackPort, FulfillmentObservationPagePort, FulfillmentStockSyncProvider, FulfillmentProductSyncProvider, FulfillmentRefusal } from "../contracts/index.js";
type Returned<M extends (...args: never[]) => unknown> = Awaited<ReturnType<M>>;
type ResultTypes = {
  prepare: Returned<FulfillmentDispatchPort["prepare"]>; dispatch: Returned<FulfillmentDispatchPort["dispatch"]>;
  create: Returned<FulfillmentLabelPort["create"]>; read: Returned<FulfillmentLabelPort["read"]>; void: Returned<FulfillmentLabelPort["void"]>;
  observation: Returned<FulfillmentObservationPort["verifyAndNormalize"]>; readback: Returned<FulfillmentReadbackPort["read"]>; page: Returned<FulfillmentObservationPagePort["readPage"]>;
  getStock: Returned<FulfillmentStockSyncProvider["getStock"]>; getStockMovements: Returned<FulfillmentStockSyncProvider["getStockMovements"]>;
  ensureProduct: Returned<FulfillmentProductSyncProvider["ensureProduct"]>; getProductPacks: Returned<FulfillmentProductSyncProvider["getProductPacks"]>;
  addProductPack: Returned<FulfillmentProductSyncProvider["addProductPack"]>; listStockedSkus: Returned<FulfillmentProductSyncProvider["listStockedSkus"]>;
  native: { kind: "refused"; refusal: FulfillmentRefusal };
};

export const PORTLESS_CAPABILITIES = Object.freeze(["courierPickup"] as const);
const s = z.string(), token = s.refine(value => Boolean(value.trim())), n = z.number(), count = n.int().nonnegative(), nullable = s.nullable();
export const refusal = z.strictObject({ reason: z.enum(FULFILLMENT_REFUSAL_REASONS), phase: z.enum(["selection", "prepare", "claim", "begin", "dispatch", "acknowledge", "verify", "normalize", "apply", "readback",
  "sync"]), retryable: z.boolean() });
const no = z.strictObject({ supported: z.literal(false), reason: z.enum(["not_exposed", "host_only", "not_implemented"]) }), support = z.union([z.strictObject({ supported: z.literal(true) }), no]);
const capabilities = z.strictObject({ providerRef: token, role: z.enum(["warehouse", "direct_carrier", "manual", "simulator"]), operations: z.strictObject({ dispatch: support,
  readback: support, exactAbsence: support, verifyObservation: support, syncStock: support, syncProducts: support, labelCreate: support, labelRead: support,
  labelVoid: support, cancel: support, pickupPoint: support, courierPickup: support }), authentication: z.enum(["token", "authenticated_timestamp", "none"]),
  freshness: z.enum(["authenticated_timestamp", "not_available"]), defaultOff: z.literal(true), selected: z.boolean(), readiness: z.union([z.strictObject({ ready: z.literal(true) }),
  z.strictObject({ ready: z.literal(false), refusal })]), ownsDeliveredNotification: z.boolean(), stockAuthority: z.enum(["local_atp", "external_stock_master_with_local_reservations"]),
  intakeMode: z.enum(["webhook", "polling"]).optional(), inventory: z.strictObject({ reservationOwner: z.enum(["local", "provider"]), consumption: z.enum(["finished_picking",
  "provider_managed"]) }).optional(), stockMovements: z.boolean().optional(), independentSplits: z.boolean().optional(), transportSelection: z.enum(["merchant",
  "provider"]).optional(), labelFormats: z.array(s).optional(), labelReadOwner: z.enum(["host_storage", "adapter", "none"]), actionPolicy: z.strictObject({ providerSpecificAdminActions: z.boolean(),
  genericAdminActions: z.boolean(), mutationSurface: z.enum(["none", "local_only", "provider_adapter"]) }) });
const contact = z.strictObject({ schemaVersion: count, source: token, revision: count });
const selection = z.strictObject({ providerRef: nullable, carrierRef: nullable, serviceRef: nullable, deliveryKind: z.enum(["parcel-locker", "courier"]),
  pickupPoint: z.strictObject({ id: token, provider: token, name: s, address: z.strictObject({ line1: s, postalCode: s, city: s, country: s }) }).nullable() });
const request = z.strictObject({ requestKey: token, fulfillmentRef: token, orderRef: token, orderNumber: nullable, parcelRef: nullable, contactRevision: contact,
  recipient: z.strictObject({ name: nullable, email: nullable, phone: nullable, line1: s, line2: nullable, city: s, postalCode: s, country: s, deliveryInstructions: nullable,
  courierInstructions: nullable }), lines: z.array(z.strictObject({ skuRef: s, title: nullable, quantity: n, productRef: nullable, packRef: nullable, lotRef: nullable.optional(),
  expirationDate: nullable.optional() })), selection });
const evidence = z.strictObject({ commandFingerprint: token, contactRevision: contact, providerRef: token, carrierRef: nullable, serviceRef: nullable,
  redactedFieldCount: count.optional(), transcript: z.strictObject({ itemCount: count, items: z.array(z.strictObject({ skuRef: token, quantity: n, lotRef: nullable,
  expirationDate: nullable })), deliveryKind: z.enum(["parcel-locker", "courier"]), pickupPointRef: nullable, redactedFieldCount: count.optional() }).optional(),
  mapping: z.strictObject({ source: z.literal("dispatch_worker"), mode: z.enum(["shadow", "stage", "live"]), shadowMode: z.boolean() }).optional() });
const error = z.strictObject({ code: token, status: n.int().nullable(), retryable: z.boolean(), mayHaveSucceeded: z.boolean(), submissionAttempted: z.boolean().optional(),
  responseBodyRead: z.boolean().optional(), cause: s.optional(), redactedFieldCount: count.optional() });
const correlation = z.strictObject({ orderRef: nullable, fulfillmentRef: nullable, externalRef: nullable, orderNumber: nullable, providerFulfillmentRef: nullable, parcelRef: nullable });
const diagnostics = z.strictObject({ redactedFieldCount: count.optional(), admission: z.strictObject({ rejectedTrackingRefs: count, rejectedTrackingUrls: count }).optional(),
  refusal: refusal.optional(), stockContention: z.strictObject({ sqlState: z.literal("55P03"), phase: z.literal("provider_stock_consumed"), retryable: z.literal(true) }).optional(),
  annotation: z.enum(["recorded", "failed"]).optional(), recoveredPickedReceipt: z.strictObject({ receiptRef: token, closed: z.boolean() }).optional() });
const poll = { correlation, eventKey: token, providerStatus: z.strictObject({ primary: nullable, subStatus: nullable, code: nullable.optional(), detailCode: nullable.optional() }).optional(),
  diagnostics: diagnostics.optional() };
const fact = z.custom<ReturnType<typeof parseFulfillmentFact>>(value => { try { return isDeepStrictEqual(value, parseFulfillmentFact(value)); } catch { return false; } }, "fact must already match the current contract");
const observation = z.strictObject({ ...poll, fact, eventKind: z.enum(["shipment.accepted", "shipment.preparing", "shipment.packed", "shipment.in_transit",
  "shipment.delivered", "order.processing_started", "order.picked", "order.shipped", "order.delivered", "parcel.exception", "parcel.cancelled"]), firstReceivedAt: s,
  intake: z.strictObject({ occurredAt: nullable.optional(), occurrenceKey: token, recovery: z.enum(["provider_recovered", "delivery_only", "manual"]).nullable() }).optional(),
  trackingRefs: z.array(z.strictObject({ trackingNumber: token, carrierRef: nullable, serviceRef: nullable, publicUrl: nullable })) });
const refused = z.strictObject({ kind: z.literal("refused"), refusal });
const dispatchCommon = { error: error.optional(), redactedFieldCount: count.optional() };
const dispatch = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("accepted"), externalRef: token, evidence, providerAttemptKey: token, labelKey: token,
  receiptKey: token.optional(), recovery: z.strictObject({ source: z.literal("persisted_acceptance"), proof: z.literal("persisted_external_ref"), noProviderPost: z.literal(true) }).optional(),
  ...dispatchCommon }), z.strictObject({ kind: z.literal("not_dispatched"), effectMayHaveSucceeded: z.literal(false), refusal, ...dispatchCommon }),
  z.strictObject({ kind: z.literal("unknown"), effectMayHaveSucceeded: z.literal(true), refusal, ...dispatchCommon })]);
const found = z.strictObject({ kind: z.literal("found"), externalRef: token, createdAt: nullable, updatedAt: nullable, observation });
const readback = z.discriminatedUnion("kind", [found, z.strictObject({ kind: z.literal("absent"), scope: z.strictObject({ providerRef: token, requestKey: token,
  fulfillmentRef: token, externalRef: nullable }), proof: z.strictObject({ kind: z.literal("authoritative_exact_lookup"), evidenceRef: z.templateLiteral(["evidence:", s]).refine(value => /^evidence:.+/.test(value)),
  checkedAt: s.refine(value => Number.isFinite(Date.parse(value))) }) }), ...(["unknown", "unsupported"] as const).map(kind => z.strictObject({ kind: z.literal(kind),
  refusal }))]);
const document = z.strictObject({ objectRef: token, mediaType: z.literal("application/pdf"), externalRef: nullable });
const identity = { providerRef: token, syncRunId: token, collectedAt: s, sourceRevision: nullable, revisionSource: z.enum(["provider", "collection", "unknown"]) };
const rejected = z.strictObject({ kind: z.literal("rejected"), itemIndex: count, reason: z.literal("invalid_sku_ref") });
const pack = z.strictObject({ ean: s, quantity: n });
export const results: { [Op in keyof ResultTypes]: z.ZodType<ResultTypes[Op]> } = {
  prepare: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("prepared"), evidence }), refused]), dispatch,
  create: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("created"), parcelRef: token, document: document.nullable() }), refused]),
  read: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("available"), url: token, expiresAt: nullable }), refused]),
void: z.union([z.strictObject({ canProceed: z.literal(true), providerDeletion: z.enum(["confirmed", "unconfirmed"]), labelDeleted: z.boolean() }), z.strictObject({ canProceed: z.literal(false),
  providerDeletion: z.enum(["confirmed", "unconfirmed"]), labelDeleted: z.boolean(), refusal }).refine(value => value.refusal.reason !== "unsupported" || (value.providerDeletion === "unconfirmed" && !value.labelDeleted))]),
observation: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("verified"), observation }), refused.extend({ diagnostics: z.strictObject({ invalidTimestamp: z.literal(true).optional(),
  rejectedCorrelationRefs: count.optional() }).optional() })]), readback,
page: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("page"), rows: z.array(z.union([readback, z.strictObject({ kind: z.literal("unmapped"),
  externalRef: nullable, evidence: z.strictObject(poll) })])) }), z.strictObject({ kind: z.literal("page_exhausted") }), z.strictObject({ kind: z.literal("failed"),
  refusal, error: error.optional() })]),
  getStock: z.array(z.union([rejected, z.strictObject({ ...identity, skuRef: token, quantityKind: z.literal("snapshot"), totalQuantity: n, forSaleQuantity: n, reservedOrUnavailableQuantity: n })])),
getStockMovements: z.array(z.union([rejected, z.strictObject({ ...identity, skuRef: token, quantityKind: z.literal("movement"), quantity: n, occurredAt: nullable,
  operationType: nullable, documentRef: nullable, lotRef: nullable, expirationDate: nullable })])),
  ensureProduct: z.strictObject({ replayed: z.boolean() }).nullable(), getProductPacks: z.array(pack), addProductPack: z.undefined(), listStockedSkus: z.array(s),
  native: refused,
};
export type Operation = keyof typeof results;
const inputs = { prepare: z.tuple([request]), dispatch: z.tuple([request, evidence]), create: z.tuple([request]), read: z.tuple([document]), void: z.tuple([z.strictObject({ parcelRef: token,
  document: document.nullable() })]), observation: z.tuple([z.strictObject({ rawBody: z.instanceof(Uint8Array), headers: z.record(s, s), receivedAt: s })]),
  readback: z.tuple([z.strictObject({ providerRef: token, requestKey: token, fulfillmentRef: token, externalRef: nullable, mode: z.enum(["command", "parcel"]) })]),
  page: z.tuple([z.strictObject({ page: count, size: count.positive() })]), getStock: z.tuple([]), getStockMovements: z.union([z.tuple([]), z.tuple([z.strictObject({ startLocalDate: s.optional(),
  endLocalDate: s.optional(), size: count.positive().optional() }).optional()])]), ensureProduct: z.tuple([s]), getProductPacks: z.tuple([s]), addProductPack: z.tuple([s,
  pack]), listStockedSkus: z.tuple([]), native: z.tuple([]) };
const fixture = <O extends Operation>(op: O) => z.strictObject({ input: inputs[op], expected: results[op] }).refine(value => Object.hasOwn(value, "expected"), "expected required");
const sync = (ops: readonly Operation[], full: boolean) => z.union(ops.map(operation => z.strictObject(full ? { operation: z.literal(operation), success: fixture(operation),
  failure: z.strictObject({ input: inputs[operation], throws: refusal.refine(value => value.phase === "sync" && value.reason !== "unsupported", "supported failure cannot be unsupported") }) } : { operation: z.literal(operation),
  input: inputs[operation], expected: z.union([results[operation], refused]) }).refine(value => full || Object.hasOwn(value, "expected"), "expected required")));
const index = count, tuple = z.tuple([index, index]);
export const subjectSchema: z.ZodType = z.strictObject({ subjectId: token, sensitiveValues: z.array(s), capabilities, fixtures: z.strictObject({
  dispatch: z.array(z.strictObject({ input: request, expectedPrepare: results.prepare, expectedDispatch: results.dispatch.optional(), replay: z.boolean().optional() }).superRefine((value, ctx) => {
if (value.expectedPrepare.kind === "refused" ? Object.hasOwn(value, "expectedDispatch") || Object.hasOwn(value, "replay") : value.expectedDispatch === undefined) ctx.addIssue({ code: "custom",
  message: "refused preparation cannot declare dispatch or replay; prepared dispatch expected required" });
})).min(1), label: z.strictObject({ create: z.array(fixture("create")).optional(), read: z.array(fixture("read")).optional(), void: z.array(fixture("void")).optional() }).optional(),
  observation: z.array(fixture("observation")).optional(), readback: z.array(fixture("readback").extend({ localMissing: z.boolean().optional() })).optional(),
  stockSync: z.array(sync(["getStock", "getStockMovements"], false)).optional(), productSync: z.array(sync(["ensureProduct", "getProductPacks", "addProductPack",
  "listStockedSkus"], false)).optional(),
}), certification: z.strictObject({ profile: z.enum(["adapter", "dispatch-only"]).optional(), dispatch: z.strictObject({ addressBeforeSubmission: index,
  addressAfterSubmission: index, transport: z.strictObject(Object.fromEntries(["transport-before-submission", "transport-after-submission", "http-failure"].map(name => [name,
  z.strictObject({ fixture: index, calls: z.array(z.strictObject({ call: s, kind: z.enum(["success", "http-failure", "transport-before-submission", "transport-after-submission"]) })) })])) as unknown as Record<"transport-before-submission" | "transport-after-submission" | "http-failure",
  z.ZodType<{ fixture: number; calls: { call: string; kind: string }[] }>>) }).optional(), observation: z.strictObject({ duplicate: tuple, outOfOrder: tuple,
  authenticationFailure: index }).optional(), exceptions: z.strictObject({ returned: index, lostCoarse: index }).optional(), paging: z.strictObject(Object.fromEntries(["full",
  "short", "empty", "exhausted", "failure"].map(name => [name, z.strictObject({ input: z.strictObject({ page: count, size: count.positive() }), expected: results.page }).refine(value => value.expected.kind === (name === "exhausted" ? "page_exhausted" : name === "failure" ? "failed" : "page"),
  "fixture discriminant contradicts role")])) as unknown as Record<"full" | "short" | "empty" | "exhausted" | "failure", z.ZodType>).optional(), stockSync: z.array(sync(["getStock",
  "getStockMovements"], true)).optional(), productSync: z.array(sync(["ensureProduct", "getProductPacks", "addProductPack", "listStockedSkus"], true)).optional(),
  snapshotOnly: z.literal(true).optional(), dispatchRefusal: fixture("dispatch").optional() }).optional() });

export function requireFact(value: unknown, label: string): asserts value { if (!value) throw new Error(`fulfillment_adapter_conformance:${label}`); }
const apply = Reflect.apply, NativePromise = Promise, promiseThen = Promise.prototype.then, promisePrototype = Promise.prototype;
const viewBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer")!.get!, dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!;
/** Read executable containers without invoking accessors or proxy traps, including on prototypes. */
export function field<T, K extends keyof T>(owner: T, key: K): T[K] {
  for (let node: unknown = owner; node != null; node = Object.getPrototypeOf(node)) {
    requireFact((typeof node === "object" || typeof node === "function") && !types.isProxy(node), "validation:container");
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor) { requireFact(!descriptor.get && !descriptor.set, "validation:accessor"); return descriptor.value as T[K]; }
  }
  return undefined as T[K];
}
/** Capture once; never read bind/call/apply (or other properties) from the supplied function. */
export function method<T, K extends keyof T>(owner: T, key: K, fn = field(owner, key)): T[K] {
  if (fn === undefined) return fn;
  requireFact(typeof fn === "function" && !types.isProxy(fn), "validation:function");
  return ((...args: unknown[]) => apply(fn, owner, args)) as T[K];
}
/** Native promises only: bypass own then hooks and refuse constructor/species redirection. Project before resolution. */
export function settled<T>(value: unknown, project: (raw: unknown) => T, failure: (error: unknown) => T): Promise<T> {
  requireFact(types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === promisePrototype && !Object.hasOwn(value, "constructor"), "validation:native_promise");
  return new NativePromise<T>((resolve, reject) => {
    const finish = (transform: typeof project) => (raw: unknown) => { try { resolve(transform(raw)); } catch (error) { reject(error); } };
    apply(promiseThen, value, [finish(project), finish(failure)]);
  });
}
/** Host workers may inspect failures too: copy both synchronous throws and promise rejections first. */
export function invokeData<T>(invoke: () => unknown, project: (raw: unknown) => T): Promise<T> {
  let pending: unknown;
  try { pending = invoke(); } catch (error) { throw snapshot(error); }
  return settled(pending, project, error => { throw snapshot(error); });
}
/** Data snapshots reject proxies/accessors, including hidden capability declarations. Error diagnostics are flattened. */
export function snapshot<T>(value: T): T {
  const seen = new WeakSet<object>();
  const inspect = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    requireFact(!types.isProxy(node), "validation:proxy");
    if (ArrayBuffer.isView(node) || types.isAnyArrayBuffer(node)) {
      requireFact(!types.isSharedArrayBuffer(types.isAnyArrayBuffer(node) ? node : apply(types.isDataView(node) ? dataViewBuffer : viewBuffer, node, [])), "validation:shared_memory"); return node;
    }
    requireFact(!seen.has(node), "validation:cyclic_data"); seen.add(node);
    const descriptors = Object.getOwnPropertyDescriptors(node), output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      requireFact(typeof key === "string", "validation:symbol"); const field = descriptors[key]!;
      if ((Array.isArray(node) && key === "length") || (types.isNativeError(node) && ["stack", "message", "name"].includes(key))) continue;
      requireFact(!field.get && !field.set, "validation:accessor");
      requireFact(field.enumerable && (!Array.isArray(node) || /^(0|[1-9][0-9]*)$/.test(key)), "validation:hidden_data"); output[key] = inspect(field.value);
    }
    seen.delete(node); return types.isNativeError(node) ? output : (Array.isArray(node) ? Object.assign([], output) : output);
  };
  try { return structuredClone(inspect(value)) as T; } catch (error) { if (error instanceof Error && error.message === "fulfillment_adapter_conformance:validation:shared_memory") throw error; throw new Error("fulfillment_adapter_conformance:validation:uncloneable_data"); }
}
export function freeze<T>(value: T): T { if (value && typeof value === "object" && !ArrayBuffer.isView(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
