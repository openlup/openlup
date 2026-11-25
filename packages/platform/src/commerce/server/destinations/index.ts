import { z } from "zod";
import { createCheckoutCommandSchemas } from "../../checkoutCommandSchemas.js";
import type { CheckoutCommandV2 } from "../../contracts/index.js";

/** Private native destination authority; the host authenticates actors and owns connection lifetime. */
export interface DestinationAddress {
  recipientName: string; line1: string; line2?: string | null; city: string; postalCode: string; country: string;
  contactPhone?: string | null; label?: string | null; companyName?: string | null; taxId?: string | null;
  deliveryNotes?: string | null; courierInstructions?: string | null;
}
export type NewDestinationAddress = Pick<DestinationAddress, "recipientName" | "line1" | "city" | "postalCode" | "country"> & { line2?: string; contactPhone?: string };
export interface DestinationDocument { destinationId: string; revision: 1; clientId: string; address: Required<DestinationAddress> }
/** A saved row can be incomplete for a carrier; its immutable snapshot retains that fact. */
export interface SavedDestinationDocument {
  destinationId: string; revision: 1; clientId: string;
  address: Omit<Required<DestinationAddress>, "recipientName"> & { savedAddressId: string; recipientName: string | null };
}
export type DestinationReadDocument = DestinationDocument | SavedDestinationDocument;
export interface SavedShippingAddressSelectionResult {
  status: "applied" | "replayed"; subscriptionId: string; shippingAddressId: string | null;
  subscriptionStatus: string; nextCycleAt: string | null; templateVersion: number; eventId: string;
}
export type DestinationChangeResult = {
  outcome: "applied" | "applied_from_next_parcel"; appliesFrom: "current_parcel" | "next_parcel";
  futureDestinationId: string; replayed: boolean;
  currentParcel: { outcome: "updated" | "skipped"; reason: string | null; orderId: string | null;
    shipmentId: string | null; destinationId: string | null };
} | { outcome: "refused" | "conflict"; refusalCode: string; replayed: boolean };
export interface DestinationQueryExecutor { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
/** The shipment reader pins its first destination under the native dispatch lock. Use the same
 * connection as authoritative preparation. Subscription reads lock their parent; retain the
 * transaction through renewal claim. Saved selections snapshot the current address for a new
 * claim; a retained operation keeps its prior immutable destination. No automatic route exists. */
export function createPostgresDestinationPort(db: DestinationQueryExecutor) {
  const invoke = async <T>(name: string, args: unknown[]): Promise<T> => {
    const { rows } = await db.query(`SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS result`, args);
    if (rows.length !== 1 || !rows[0]?.result || typeof rows[0].result !== "object") throw new Error("commerce_destination_response_invalid");
    return rows[0].result as T;
  };
  return {
    registerOrder(input: { idempotencyKey: string; orderId: string; address: DestinationAddress; now: string }) {
      return invoke<DestinationDocument>("commerce_register_order_destination", [input.idempotencyKey, input.orderId, JSON.stringify(input.address), input.now]);
    },
    async read(scope: "order" | "subscription" | "shipment", id: string): Promise<DestinationDocument> {
      const document = await invoke<DestinationDocument>("commerce_read_destination", [scope, id]);
      if (document.address?.recipientName === null) throw new Error("commerce_destination_response_invalid");
      return document;
    },
    /** Saved snapshots may retain a null recipient; use this reader when selecting saved addresses. */
    readWithSaved(scope: "order" | "subscription" | "shipment", id: string): Promise<DestinationReadDocument> {
      return invoke<DestinationReadDocument>("commerce_read_destination", [scope, id]);
    },
    /** Replays an existing subscription-event key before parsing/validating the saved ID. */
    selectSavedShippingAddress(input: { actorId: string; clientId: string; idempotencyKey: string; subscriptionId: string;
      savedAddressId: string; reason?: string; now: string }) {
      return invoke<SavedShippingAddressSelectionResult>("subscription_select_saved_shipping_address", [input.actorId, input.clientId,
        input.idempotencyKey, input.subscriptionId, JSON.stringify({ shippingAddressId: input.savedAddressId,
          ...(input.reason === undefined ? {} : { reason: input.reason }) }), input.now]);
    },
    changeShippingAddress(input: { actorId: string; clientId: string; idempotencyKey: string; subscriptionId: string;
      newAddress: NewDestinationAddress; expectedVersion: number; reason?: string; now: string }) {
      return invoke<DestinationChangeResult>("subscription_change_shipping_destination", [input.actorId, input.clientId, input.idempotencyKey,
        input.subscriptionId, JSON.stringify({ newAddress: input.newAddress, ...(input.reason === undefined ? {} : { reason: input.reason }) }), input.expectedVersion, input.now]);
    },
  };
}
const version = "commerce.checkout_command.v2";

/** @experimental Parse the strict v2 checkout envelope before applying the host address policy. */
export function createCheckoutCommandV2Schema(schemas: { sku: z.ZodType<string, string> }): z.ZodType<CheckoutCommandV2> {
  const { checkoutCommandV1Schema } = createCheckoutCommandSchemas({
    sku: schemas.sku, paymentIntentStatus: z.string(), paymentAttemptStatus: z.string(),
  });
  // Reuse the common envelope and its cadence refinement across both versions.
  const envelope: z.ZodObject<Omit<typeof checkoutCommandV1Schema.shape, "version" | "shippingAddress">> = checkoutCommandV1Schema;
  const ingress = envelope.safeExtend({
    version: z.literal(version),
    shippingAddress: z.strictObject({
      line1: z.string(), line2: z.string().optional(), city: z.string(), subdivisionCode: z.string().optional(),
      postalCode: z.string(), countryCode: z.string(),
    }),
  });
  return ingress
    .transform((command): { command: CheckoutCommandV2 } | { issue: z.ZodIssue } => ({ command }))
    .catch(({ error }) => ({ issue: error.issues[0]! }))
    .transform((result, context) => {
      if ("command" in result) return result.command;
      const { issue } = result;
      const wrongDialect = issue.path[0] === "version";
      context.addIssue({
        code: "custom",
        path: issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]!] : issue.path,
        params: { refusalCode: wrongDialect ? "destination_dialect_invalid" : "address_invalid_input" },
        message: wrongDialect ? `Unsupported checkout version. Submit version ${version}.`
          : `${issue.message}. Correct the indicated checkout input and resubmit.`,
      });
      return z.NEVER;
    });
}

type CapabilityStatus = { supported: boolean; available: boolean; refusalCode?:
  "destination_v2_unsupported_rail" | "destination_v2_unavailable" };

/** @experimental Discover v2 destination issuance and saved-address support. Keep installed readers and replay when disabling issuance. */
export function destinationV2Capabilities(input: {
  rail: "native" | "managed"; installed?: boolean; issuanceEnabled?: boolean;
  privacyRegistry?: {
    readonly contributors: readonly { readonly id: string }[];
    readonly missingContributors: readonly string[];
  };
}): { [K in "destinationAddressV2" | "savedAddressV2"]: CapabilityStatus & { capability: K } } {
  const supported = input.rail === "native";
  const registry = input.privacyRegistry;
  const privacyReady = registry?.missingContributors.length === 0 && ["destination-receipts", "destination-documents"]
    .every(id => registry.contributors.some(contributor => contributor.id === id));
  const available = supported && input.installed === true && input.issuanceEnabled === true && privacyReady;
  const refusalCode = supported ? "destination_v2_unavailable" : "destination_v2_unsupported_rail";
  return {
    destinationAddressV2: { capability: "destinationAddressV2", supported, available, ...(available ? {} : { refusalCode }) },
    savedAddressV2: { capability: "savedAddressV2", supported: false, available: false, refusalCode: "destination_v2_unsupported_rail" },
  };
}

type UUID = string;
type Digest = string;
type UtcMillis = string;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type NativeAddress = { line1: string; line2?: string; city: string; postalCode: string; country: string; subdivision?: string };
type OriginalAddress = Omit<NativeAddress, "country" | "subdivision"> & { countryCode: string; subdivisionCode?: string };
const contactKeys = ["recipientName", "contactEmail", "contactPhone", "companyName", "label", "taxId", "deliveryNotes", "courierInstructions"] as const;
type Contact = { [Key in typeof contactKeys[number]]?: string };

/** @experimental Host-authorized customer and destination scope. */
export type DestinationContextV2 = {
  clientId: UUID; scopeRef: UUID;
  owner: { installationRef: string; principalKind: "customer"; principalRef: UUID; customerOrSessionRef: UUID };
};
/** @experimental The binding sealed with destination evidence. */
export type DestinationBindingV2 = {
  snapshotRef: UUID; schemaVersion: 2; destinationDigest: Digest; policyRevision: string;
};
/** @experimental A sealed checkout selection. */
export type DestinationSelectionV2 = { kind: "checkout"; scopeRef: UUID; selectionRevision: UUID };
/** @experimental The service coordinates sealed with a destination selection. */
export type DestinationServicePinV2 = {
  deliverySelectionRef: string; providerRef: string; carrierRef: string; serviceRef: string;
  servicePolicyRevision: string; adapterRevision: string;
};
/** @experimental Issued or replayed destination evidence. */
export type DestinationIssueResultV2 = {
  binding: DestinationBindingV2; selection: DestinationSelectionV2; evidenceExpiresAt: UtcMillis; eventId: UUID; replayed: boolean;
};
/** @experimental Destination evidence verified by the native owner. Keep it server-side. */
export type DestinationVerifiedReadV2 = {
  binding: DestinationBindingV2; documentDigest: Digest; evidenceExpiresAt: UtcMillis;
  document: DestinationBindingV2 & {
    revision: 1; owner: DestinationContextV2["owner"]; clientId: UUID;
    policyRef: string; classificationKeys: string[]; address: NativeAddress; contact: Contact;
  };
};

type Check = {
  kind: "checkout"; scopeRef: UUID; expectedSelectionRevision: UUID;
  expectedBinding: DestinationBindingV2; expectedService: DestinationServicePinV2;
};
type SnapshotCommand = {
  dialect: "commerce.destination.snapshot.v2"; requestKey: string; requestDigest: Digest;
  purpose: "checkout"; scopeRef: UUID; original: { address: OriginalAddress; contact: Contact }; validated?: JsonValue;
};
type Rechecked = { binding: DestinationBindingV2; selection: DestinationSelectionV2; service: DestinationServicePinV2 };
type SubscriptionSelection = Omit<DestinationSelectionV2, "kind"> & { kind: "subscription" };
type SubscriptionRechecked = Omit<Rechecked, "selection"> & { selection: SubscriptionSelection };
type CurrentSubscriptionDestination = Pick<Rechecked, "binding" | "service"> & { selectionRevision: UUID };
type SubscriptionRead = Omit<DestinationVerifiedReadV2, "evidenceExpiresAt"> & SubscriptionRechecked & { evidenceExpiresAt: null };
type SubscriptionCheck = Omit<Check, "kind"> & { kind: "subscription" };
type Erased = { evidenceDisposition: "erased" };

/** @experimental Native operations on the host's supplied executor. */
export interface DestinationPortV2 {
  snapshot(ctx: DestinationContextV2, command: SnapshotCommand, now: UtcMillis): Promise<Decision<DestinationIssueResultV2 | Erased>>;
  read(ctx: DestinationContextV2, kind: "subscription", id: UUID, expectedBinding: null): Promise<SubscriptionDecision<CurrentSubscriptionDestination>>;
  read(ctx: DestinationContextV2, kind: "subscription", id: UUID, expectedBinding: DestinationBindingV2): Promise<SubscriptionDecision<SubscriptionRead>>;
  read(ctx: DestinationContextV2, kind: "snapshot" | "order" | "shipment", id: UUID,
    expectedBinding: DestinationBindingV2): Promise<Decision<DestinationVerifiedReadV2>>;
  recheck(ctx: DestinationContextV2, check: SubscriptionCheck): Promise<SubscriptionDecision<SubscriptionRechecked>>;
  recheck(ctx: DestinationContextV2, check: Check): Promise<Decision<Rechecked>>;
  registerOrder(ctx: DestinationContextV2, orderId: UUID, check: Check): Promise<Decision<DestinationBindingV2>>;
}

const addressKeys = ["line1", "line2", "city", "postalCode", "countryCode", "subdivisionCode"] as const;
const refusalFields = {
  address_invalid_input: [
    "command", "now", "requestKey", "requestDigest", "purpose", "scopeRef", "original", "original.address", "original.contact",
    ...addressKeys.map(key => `original.address.${key}` as const), ...contactKeys.map(key => `original.contact.${key}` as const),
    "validated", "validated.address", "validated.contact", ...addressKeys, ...contactKeys,
    "policyRef", "policyRevision", "classificationKeys", "orderId", "shipmentId",
  ],
  destination_dialect_invalid: ["version"],
  destination_owner_unlinked: ["owner"],
  destination_evidence_unavailable: ["destination.snapshotRef", "orderId", "shipmentId"],
  destination_evidence_erased: ["owner"],
  destination_binding_invalid: ["destination", "selectedDelivery", "orderBindings"],
  destination_digest_mismatch: ["destinationDigest", "documentDigest"],
  destination_version_changed: ["destination.policyRevision", "selectionRevision", "destination.snapshotRef", "destinationDigest"],
  destination_v2_selection_required: ["destination.snapshotRef"],
  destination_order_binding_occupied: ["orderId"],
  destination_busy: ["orderId"],
  destination_idempotency_conflict: ["idempotencyKey"],
  destination_isolation_unsupported: ["isolation"],
} as const;
const subscriptionRefusalFields = {
  address_invalid_input: ["subscriptionId"],
  destination_evidence_unavailable: ["subscriptionId"],
  destination_v2_selection_required: ["subscriptionId"],
  destination_version_changed: ["selectedDelivery"],
} as const;
type Refusal<Code, Field> = {
  outcome: "refused"; code: Code; field: Field; observed: string; cause: string; fix: string; recheck: string;
};
type OwnerRefusal = { [Code in keyof typeof refusalFields]: Refusal<Code, typeof refusalFields[Code][number]> }[keyof typeof refusalFields];
type SubscriptionRefusal = {
  [Code in keyof typeof subscriptionRefusalFields]: Refusal<Code, typeof subscriptionRefusalFields[Code][number]>
}[keyof typeof subscriptionRefusalFields];
type TransportField = "owner" | "command" | "destination" | "selectedDelivery" | "check";
type TransportRefusal = Refusal<"address_invalid_input", TransportField>;
type Decision<T> = T | OwnerRefusal | TransportRefusal;
type SubscriptionDecision<T> = Decision<T> | SubscriptionRefusal;
type BindValue = string | null | TransportRefusal;

function transportRefusal(field: TransportField): TransportRefusal {
  return {
    outcome: "refused", code: "address_invalid_input", field,
    observed: "An argument cannot be sent as plain JSON.",
    cause: "The native destination operation requires lossless JSON arguments.",
    fix: "Supply plain JSON data in the indicated argument.",
    recheck: "Resubmit the original representable data.",
  };
}

const jsonText = (value: string) => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value);
const plainRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function dataEntries(value: object): [string, unknown][] {
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !plainRecord(value)) throw new TypeError("Expected plain JSON data");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter(key => !array || key !== "length");
  if (array && (keys.length !== descriptors.length?.value || keys.some((key, index) => key !== String(index)))) {
    throw new TypeError("Expected a dense JSON array");
  }
  return keys.map(key => {
    if (typeof key !== "string" || !jsonText(key)) throw new TypeError("Invalid JSON key");
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Expected enumerable JSON data");
    return [key, descriptor.value];
  });
}

function snapshotJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean" || (typeof value === "string" && jsonText(value))
    || (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Expected lossless JSON data");
  ancestors.add(value);
  const entries = dataEntries(value).map(([key, child]) => [key, snapshotJson(child, ancestors)] as const);
  ancestors.delete(value);
  return Array.isArray(value) ? entries.map(([, child]) => child) : Object.fromEntries(entries);
}

function jsonArgument(value: unknown, field: TransportField): BindValue {
  try { return JSON.stringify(snapshotJson(value)); }
  catch { return transportRefusal(field); }
}

// Cast-bound scalars use PostgreSQL's input domain; the returned UUID spelling is canonical.
const postgresUuid = /^(?:[0-9a-f]{4}-?){7}[0-9a-f]{4}$/iu;
function uuidArgument(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const inner = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
  return postgresUuid.test(inner) ? value : null;
}
function matchesSubscriptionScope(scopeRef: string, requested: BindValue | undefined): boolean {
  return typeof requested === "string" && scopeRef.replaceAll("-", "") === requested.replace(/[-{}]/gu, "").toLowerCase();
}
const kindArgument = (value: unknown) => typeof value === "string" && jsonText(value) ? value : null;
const utcMillis = (value: string) => value.length === 24 && !value.startsWith("0000")
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function checkArguments(value: unknown): BindValue[] {
  try {
    if (!plainRecord(value)) {
      snapshotJson(value);
      return [null, null, null, null, null];
    }
    const fields = new Map(dataEntries(value));
    const kind = kindArgument(fields.get("kind"));
    const scope = uuidArgument(fields.get("scopeRef"));
    const revision = uuidArgument(fields.get("expectedSelectionRevision"));
    const binding = fields.has("expectedBinding") ? jsonArgument(fields.get("expectedBinding"), "destination") : null;
    const service = fields.has("expectedService") ? jsonArgument(fields.get("expectedService"), "selectedDelivery") : null;
    // The envelope is split over SQL parameters. Checkout retains its plain-data extension rule.
    for (const key of ["kind", "scopeRef", "expectedSelectionRevision", "expectedBinding", "expectedService"]) fields.delete(key);
    if (kind === "subscription" && fields.size > 0) return [transportRefusal("check")];
    for (const extra of fields.values()) snapshotJson(extra);
    return [kind, scope, revision, binding, service];
  } catch { return [transportRefusal("check")]; }
}

const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const utc = z.string().refine(utcMillis);
const serviceRef = z.string().refine(value => value.length > 0 && [...value].length <= 256 && jsonText(value));
const bindingShape = {
  snapshotRef: uuid, schemaVersion: z.literal(2), destinationDigest: digest,
  policyRevision: z.string().refine(value => /[^ ]/u.test(value) && Buffer.byteLength(value, "utf8") <= 720),
};
const bindingSchema = z.strictObject(bindingShape);
const selectionSchema = z.strictObject({ kind: z.literal("checkout"), scopeRef: uuid, selectionRevision: uuid });
const snapshotResult = z.union([
  z.strictObject({ binding: bindingSchema, selection: selectionSchema, evidenceExpiresAt: utc, eventId: uuid, replayed: z.boolean() }),
  z.strictObject({ evidenceDisposition: z.literal("erased") }),
]);
const readResult = z.strictObject({
  binding: bindingSchema, documentDigest: digest, evidenceExpiresAt: utc,
  document: z.strictObject({
    ...bindingShape, revision: z.literal(1), clientId: uuid, policyRef: z.string(), classificationKeys: z.array(z.string()),
    owner: z.strictObject({ installationRef: z.string(), principalKind: z.literal("customer"), principalRef: uuid, customerOrSessionRef: uuid }),
    address: z.strictObject({ line1: z.string(), line2: z.string().optional(), city: z.string(), postalCode: z.string(),
      country: z.string(), subdivision: z.string().optional() }),
    contact: z.strictObject(Object.fromEntries(contactKeys.map(key => [key, z.string().optional()]))),
  }),
});
const serviceSchema = z.strictObject({
  deliverySelectionRef: serviceRef, providerRef: serviceRef, carrierRef: serviceRef, serviceRef,
  servicePolicyRevision: serviceRef, adapterRevision: serviceRef,
});
const recheckResult = z.strictObject({ binding: bindingSchema, selection: selectionSchema, service: serviceSchema });
const subscriptionRecheck = recheckResult.extend({ selection: selectionSchema.extend({ kind: z.literal("subscription") }) });
const subscriptionCurrent = z.strictObject({ binding: bindingSchema, selectionRevision: uuid, service: serviceSchema });
const subscriptionRead = readResult.extend({ ...subscriptionRecheck.shape, evidenceExpiresAt: z.null() });
const ownerRefusal = z.strictObject({
  outcome: z.literal("refused"), code: z.string(), field: z.string(),
  observed: z.string(), cause: z.string(), fix: z.string(), recheck: z.string(),
});
function hasRefusalPair(table: Readonly<Record<string, readonly string[]>>, code: string, field: string): boolean {
  return Object.hasOwn(table, code) && table[code]!.includes(field);
}

const infrastructureMessage = [
  "OPENLUP_E_DESTINATION_INFRASTRUCTURE",
  "Observed: The destination operation did not return a usable result.",
  "Cause: The native executor or installed destination contract could not complete the operation.",
  "Fix: Check the native app binding, driver initialization, database connection and TLS, runtime CONNECT, schema USAGE and EXECUTE privileges, and installed migrations.",
  "Recheck: Retry the same operation.",
].join("\n");

/** @experimental Use the supplied executor. The native host owns transaction and session lifetime. */
export function createPostgresDestinationPortV2(db: DestinationQueryExecutor): DestinationPortV2 {
  function invoke<T>(sql: string, values: BindValue[], success: z.ZodType<T>, subscription: true): Promise<SubscriptionDecision<T>>;
  function invoke<T>(sql: string, values: BindValue[], success: z.ZodType<T>): Promise<Decision<T>>;
  async function invoke<T>(sql: string, values: BindValue[], success: z.ZodType<T>, subscription = false): Promise<SubscriptionDecision<T>> {
    const refusal = values.find(value => value !== null && typeof value === "object");
    if (refusal) return refusal;
    let response: Awaited<ReturnType<DestinationQueryExecutor["query"]>>;
    try {
      response = await db.query(sql, values);
    } catch (cause) {
      throw new Error(infrastructureMessage, { cause });
    }
    let rowCount: number | null = null;
    try {
      const rows: unknown = Object.getOwnPropertyDescriptor(response, "rows")?.value;
      const length: unknown = Array.isArray(rows) ? rows.length : null;
      rowCount = typeof length === "number" ? length : null;
      if (rowCount === 1) {
        const row: unknown = Object.getOwnPropertyDescriptor(rows, "0")?.value;
        const fields = plainRecord(row) ? dataEntries(row) : [];
        if (fields.length === 1 && fields[0]?.[0] === "result") {
          const result = snapshotJson(fields[0][1]);
          const refusal = ownerRefusal.safeParse(result);
          if (refusal.success) {
            const { code, field } = refusal.data;
            if (hasRefusalPair(refusalFields, code, field) ||
              (subscription && hasRefusalPair(subscriptionRefusalFields, code, field))) return result as OwnerRefusal | SubscriptionRefusal;
          }
          const decoded = success.safeParse(result);
          if (decoded.success) return decoded.data;
        }
      }
    } catch {
      // Keep only the row count when decoding fails.
    }
    throw new Error(infrastructureMessage, { cause: { reason: "malformed_response", rowCount } });
  }

  function read(ctx: DestinationContextV2, kind: "subscription", id: UUID, binding: null): Promise<SubscriptionDecision<CurrentSubscriptionDestination>>;
  function read(ctx: DestinationContextV2, kind: "subscription", id: UUID, binding: DestinationBindingV2): Promise<SubscriptionDecision<SubscriptionRead>>;
  function read(ctx: DestinationContextV2, kind: "snapshot" | "order" | "shipment", id: UUID,
    binding: DestinationBindingV2): Promise<Decision<DestinationVerifiedReadV2>>;
  function read(ctx: DestinationContextV2, kind: string, id: UUID, binding: DestinationBindingV2 | null) {
    const sql = "SELECT public.commerce_read_destination_v2($1::jsonb, $2::text, $3::uuid, $4::jsonb) AS result";
    const current = kind === "subscription" && binding === null;
    const scope = uuidArgument(id);
    const args = [jsonArgument(ctx, "owner"), kindArgument(kind), scope, current ? null : jsonArgument(binding, "destination")];
    if (kind !== "subscription") return invoke(sql, args, readResult);
    return current ? invoke(sql, args, subscriptionCurrent, true)
      : invoke(sql, args, subscriptionRead.refine(result => matchesSubscriptionScope(result.selection.scopeRef, scope)), true);
  }

  function recheck(ctx: DestinationContextV2, check: SubscriptionCheck): Promise<SubscriptionDecision<SubscriptionRechecked>>;
  function recheck(ctx: DestinationContextV2, check: Check): Promise<Decision<Rechecked>>;
  function recheck(ctx: DestinationContextV2, check: Check | SubscriptionCheck) {
    const sql = "SELECT public.commerce_recheck_destination_v2($1::jsonb, $2::text, $3::uuid, $4::uuid, $5::jsonb, $6::jsonb) AS result";
    const args = [jsonArgument(ctx, "owner"), ...checkArguments(check)];
    const [, kind, scope] = args;
    return kind === "subscription"
      ? invoke(sql, args, subscriptionRecheck.refine(result => matchesSubscriptionScope(result.selection.scopeRef, scope)), true)
      : invoke(sql, args, recheckResult);
  }

  return {
    snapshot(ctx, command, now) {
      return invoke("SELECT public.commerce_snapshot_destination_v2($1::jsonb, $2::jsonb, $3::timestamptz) AS result",
        [jsonArgument(ctx, "owner"), jsonArgument(command, "command"), typeof now === "string" && utcMillis(now) ? now : null], snapshotResult);
    },
    read,
    recheck,
    registerOrder(ctx, orderId, check) {
      return invoke("SELECT public.commerce_register_order_destination_v2($1::jsonb, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::jsonb, $7::jsonb) AS result",
        [jsonArgument(ctx, "owner"), uuidArgument(orderId), ...checkArguments(check)], bindingSchema);
    },
  };
}
