import { ambientSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AgentAuditClient } from "../../_lib/admin-domain/agentCustomerReadGuard.js";
import type { OmsAgentReadGovernance } from "../../_lib/admin-domain/customerReadGovernance.js";
import {
  CommerceOmsConflictError,
  type CommerceOmsHoldPort,
  type CommerceOmsReadPort,
} from "../../../src/domains/commerce/omsPorts.js";
import {
  createAdminCommerceOrderDetailHandler,
  createAdminCommerceOrderHoldHandler,
  createAdminCommerceOrderNoteHandler,
  createAdminCommerceOrderReleaseHoldHandler,
  createAdminCommerceOrdersListHandler,
  createAdminCommerceOrderUpdateShippingAddressHandler,
  type AdminAuthResult,
} from "./commerceOmsHandlers.js";

/**
 * Q0 pin (CO-01, CO-02, CO-03) for the six handlers of `commerceOmsHandlers.ts`.
 * Each case records one ordered call list across the response, the authorizer,
 * the OMS port (every method of both port interfaces) and the agent audit
 * client, plus every console call, and compares both strictly. Response bodies
 * are recorded wire-serialised, so key order counts. The response, the port and
 * the audit client are recorders: a method the case did not provide is recorded
 * and then throws. The fixtures make each parsed value differ from its raw one
 * (padded strings, coerced numbers, filled defaults, stripped extra keys), so a
 * raw pass-through to the port, the audit query or the answer is red. The mutation
 * port fakes settle on a macrotask, so a dropped `await` on the sender is red.
 * Expected literals were captured from the current handlers' output.
 */

type Event = readonly unknown[];
type Provided = Record<string, (...args: never[]) => unknown>;
type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>;
type Actor = "human" | "machine" | "unauthorized" | "forbidden" | "throws";
type OmsPort = CommerceOmsReadPort & CommerceOmsHoldPort;
interface Deps {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  omsPort: OmsPort;
  governance?: OmsAgentReadGovernance;
}
type Build = (deps: Deps) => Handler;
interface Case {
  name: string;
  build: Build;
  method: string;
  body?: unknown;
  query?: Record<string, unknown>;
  actor?: Actor;
  port?: Provided;
  /** Absent: no governance. `off`/`on`: the agent customer-read flag. */
  governance?: "off" | "on";
  expected: Event[];
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
let consoleEvents: Event[] = [];

beforeEach(() => {
  consoleEvents = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleEvents.push([method, ...args]);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const RESPONSE_METHODS = ["setHeader", "status", "json", "removeHeader", "getHeader", "send", "end", "write", "writeHead", "redirect"];
const PORT_METHODS = [
  "listOrders",
  "getOrderDetail",
  "createHold",
  "releaseHold",
  "addNote",
  "updateShippingAddress",
  "markRefunded",
  "cancelOrder",
  "requestReplacementShipment",
];

/**
 * Every listed method records its call; one the case did not provide then throws.
 * `wire` names the methods whose single argument is recorded wire-serialised.
 */
function recorder<T extends object>(
  name: string,
  calls: Event[],
  methods: readonly string[],
  provided: Provided,
  wire: readonly string[] = [],
): T {
  return Object.fromEntries(methods.map((method) => [method, (...args: unknown[]) => {
    calls.push([`${name}.${method}`, ...(wire.includes(method) ? [JSON.stringify(args[0])] : args)]);
    const implementation = provided[method] as ((...args: unknown[]) => unknown) | undefined;
    if (!implementation) throw new Error(`unexpected call: ${name}.${method}`);
    return implementation(...args);
  }])) as T;
}

/** `json` records its body wire-serialised, so the key order is part of the pin. */
function recordingResponse(calls: Event[]): VercelResponse {
  const res = {} as VercelResponse;
  Object.assign(res, recorder<VercelResponse>("res", calls, RESPONSE_METHODS, {
    setHeader: () => undefined,
    status: () => res,
    json: () => res,
  }, ["json"]));
  return res;
}

const ACTOR_ID = "admin-user-7";

function authorizer(calls: Event[], actor: Actor): Deps["authorizeAdmin"] {
  const results: Record<Exclude<Actor, "throws">, AdminAuthResult> = {
    human: { ok: true, userId: ACTOR_ID, isMachineActor: false },
    machine: { ok: true, userId: ACTOR_ID, isMachineActor: true },
    unauthorized: { ok: false, code: "UNAUTHORIZED", message: "Admin session required" },
    forbidden: { ok: false, code: "FORBIDDEN", message: "Admin role required" },
  };
  return async () => {
    calls.push(["authorizeAdmin"]);
    if (actor === "throws") throw new Error("auth backend down");
    return results[actor];
  };
}

async function observe(c: Case): Promise<{ calls: Event[]; console: Event[] }> {
  const calls: Event[] = [];
  const handler = c.build({
    authorizeAdmin: authorizer(calls, c.actor ?? "human"),
    omsPort: recorder<OmsPort>("omsPort", calls, PORT_METHODS, c.port ?? {}),
    governance: c.governance === undefined ? undefined : {
      flagEnabled: c.governance === "on",
      auditClient: recorder<AgentAuditClient>("auditClient", calls, ["rpc"], {
        rpc: async () => ({ data: "audit-row", error: null }),
      }),
    },
  });
  const req = { method: c.method, body: c.body, query: c.query ?? {}, headers: {} } as unknown as VercelRequest;
  await handler(req, recordingResponse(calls));
  // Copied at once, so a write after the handler's promise settled is missing. The
  // mutation port fakes settle on a macrotask, so a sender the handler does not
  // await has not written yet when the copy is taken.
  return { calls: [...calls], console: [...consoleEvents] };
}

/** Settles after a macrotask, later than every microtask a non-awaited sender would run. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sent(status: number, body: unknown): Event[] {
  return [
    ["res.setHeader", "Content-Type", "application/json"],
    ["res.setHeader", "Cache-Control", "no-store"],
    ["res.status", status],
    ["res.json", JSON.stringify(body)],
  ];
}

function refused(status: number, code: string, message: string, details?: unknown): Event[] {
  return sent(status, { ok: false, error: { code, message, details } });
}

const AUTHORIZE: Event = ["authorizeAdmin"];
const METHOD_NOT_ALLOWED = refused(405, "METHOD_NOT_ALLOWED", "Method not allowed");
const allow = (methods: string): Event => ["res.setHeader", "Allow", methods];
const AUTH_REFUSALS: Array<[Actor, Event[]]> = [
  ["unauthorized", refused(401, "UNAUTHORIZED", "Admin session required")],
  ["forbidden", refused(403, "FORBIDDEN", "Admin role required")],
  ["throws", refused(503, "UPSTREAM_UNAVAILABLE", "Admin authorization failed")],
];

const ORDER_ID = "42222222-2222-4222-8222-222222222221";
const HOLD_ID = "92222222-2222-4222-8222-222222222221";
const CLIENT_ID = "52222222-2222-4222-8222-222222222221";
const OPERATION_ID = "b2222222-2222-4222-8222-222222222222";
const VERSION = "commerce.v0";
const money = (amountMinor: number) => ({ amountMinor, currency: ambientSettlementProfile.defaultCurrency });

// Too short once trimmed, and a key no strict request schema admits.
const INVALID_BODY = { idempotencyKey: "  short  ", extra: true };
const NOT_A_RESPONSE = { replayed: "no" };
const CONFLICT = new CommerceOmsConflictError("Order already has an active hold", { reason: "hold_active", holdId: HOLD_ID });
const BARE_CONFLICT = new CommerceOmsConflictError();
const UPSTREAM = new Error("connection reset");

const missing = (type = "string") => [`Invalid input: expected ${type}, received undefined`];
const SHORT_KEY = ["Too small: expected string to have >=8 characters"];
const UNRECOGNIZED_EXTRA = ["Unrecognized key: \"extra\""];
const HOLD_REASON = [
  "Invalid option: expected one of \"payment_not_succeeded\"|\"inventory_review\"|\"risk_review\"|\"address_review\"|\"fulfillment_exception\"|\"manual_support\"",
];

interface MutationSpec {
  label: string;
  build: Build;
  port: keyof CommerceOmsHoldPort;
  body: Record<string, unknown>;
  /** The parsed body plus the authorizer's `actorUserId`. */
  args: Record<string, unknown>;
  result: unknown;
  data: unknown;
  badRequest: string;
  missingDetails: unknown;
  invalidDetails: unknown;
  invalidResponse: string;
  failed: string;
}

function mutationCases(spec: MutationSpec): Case[] {
  const call: Event = [`omsPort.${spec.port}`, spec.args];
  const answer = (value: unknown): Provided => ({ [spec.port]: async () => { await nextMacrotask(); return value; } });
  const reject = (error: Error): Provided => ({ [spec.port]: async () => { await nextMacrotask(); throw error; } });
  const rows: Array<Omit<Case, "build" | "method"> & { method?: string }> = [
    ...["GET", "PUT", "DELETE"].map((method) => ({
      name: `405 ${method}, before authorization`,
      method,
      expected: [allow("POST"), ...METHOD_NOT_ALLOWED],
    })),
    ...AUTH_REFUSALS.map(([actor, answerEvents]) => ({ name: `${actor} authorizer`, actor, expected: [AUTHORIZE, ...answerEvents] })),
    { name: "no body", body: undefined, expected: [AUTHORIZE, ...refused(400, "BAD_REQUEST", spec.badRequest, spec.missingDetails)] },
    { name: "invalid body", body: INVALID_BODY, expected: [AUTHORIZE, ...refused(400, "BAD_REQUEST", spec.badRequest, spec.invalidDetails)] },
    { name: "result the response schema refuses", port: answer(NOT_A_RESPONSE), expected: [AUTHORIZE, call, ...refused(502, "INVALID_RESPONSE", spec.invalidResponse)] },
    { name: "conflict with details", port: reject(CONFLICT), expected: [AUTHORIZE, call, ...refused(409, "CONFLICT", "Order already has an active hold", { reason: "hold_active", holdId: HOLD_ID })] },
    { name: "conflict with the default message and details", port: reject(BARE_CONFLICT), expected: [AUTHORIZE, call, ...refused(409, "CONFLICT", "Commerce OMS conflict", {})] },
    { name: "port throws", port: reject(UPSTREAM), expected: [AUTHORIZE, call, ...refused(503, "UPSTREAM_UNAVAILABLE", spec.failed)] },
    { name: "success sends the parsed result", port: answer(spec.result), expected: [AUTHORIZE, call, ...sent(200, { ok: true, data: spec.data })] },
  ];
  return rows.map((row) => ({ build: spec.build, method: "POST", body: spec.body, ...row, name: `${spec.label}: ${row.name}` }));
}

// --- hold and release (one shared response schema and message pair) ---

const HOLD = {
  id: HOLD_ID,
  orderId: ORDER_ID,
  status: "active",
  reason: "manual_support",
  note: null,
  createdAt: "2026-06-05T10:02:00+00:00",
  releasedAt: null,
};
const HOLD_DATA = { contractVersion: VERSION, hold: HOLD, operationId: OPERATION_ID, replayed: false };
const HOLD_RESULT = { ...HOLD_DATA, extra: "stripped by the response schema" };
const HOLD_PAIR = {
  result: HOLD_RESULT,
  data: HOLD_DATA,
  invalidResponse: "Admin commerce hold mutation returned invalid response",
  failed: "Admin commerce hold mutation failed",
};

const holdSpec: MutationSpec = {
  label: "hold",
  build: (d) => createAdminCommerceOrderHoldHandler({ authorizeAdmin: d.authorizeAdmin, omsPort: d.omsPort }),
  port: "createHold",
  body: { idempotencyKey: "  oms-hold-0001  ", orderId: ORDER_ID, reason: "manual_support" },
  args: { idempotencyKey: "oms-hold-0001", orderId: ORDER_ID, reason: "manual_support", actorUserId: ACTOR_ID },
  badRequest: "Invalid admin commerce order hold request",
  missingDetails: { formErrors: [], fieldErrors: { idempotencyKey: missing(), orderId: missing(), reason: HOLD_REASON } },
  invalidDetails: { formErrors: UNRECOGNIZED_EXTRA, fieldErrors: { idempotencyKey: SHORT_KEY, orderId: missing(), reason: HOLD_REASON } },
  ...HOLD_PAIR,
};

const releaseSpec: MutationSpec = {
  label: "release",
  build: (d) => createAdminCommerceOrderReleaseHoldHandler({ authorizeAdmin: d.authorizeAdmin, omsPort: d.omsPort }),
  port: "releaseHold",
  body: { idempotencyKey: "  oms-release-0001  ", holdId: HOLD_ID },
  args: { idempotencyKey: "oms-release-0001", holdId: HOLD_ID, actorUserId: ACTOR_ID },
  badRequest: "Invalid admin commerce order release request",
  missingDetails: { formErrors: [], fieldErrors: { idempotencyKey: missing(), holdId: missing() } },
  invalidDetails: { formErrors: UNRECOGNIZED_EXTRA, fieldErrors: { idempotencyKey: SHORT_KEY, holdId: missing() } },
  ...HOLD_PAIR,
};

// --- note ---

const NOTE_OPERATION = {
  id: OPERATION_ID,
  orderId: ORDER_ID,
  type: "support_note",
  holdId: null,
  actorUserId: null,
  occurredAt: "2026-06-05T10:06:00+00:00",
  payload: { note: "Call customer before shipment" },
};
const NOTE_DATA = { contractVersion: VERSION, operation: NOTE_OPERATION, replayed: false };

const noteSpec: MutationSpec = {
  label: "note",
  build: (d) => createAdminCommerceOrderNoteHandler({ authorizeAdmin: d.authorizeAdmin, omsPort: d.omsPort }),
  port: "addNote",
  body: { idempotencyKey: "  oms-note-0001  ", orderId: ORDER_ID, note: "  Call customer before shipment  " },
  args: { idempotencyKey: "oms-note-0001", orderId: ORDER_ID, note: "Call customer before shipment", actorUserId: ACTOR_ID },
  result: { ...NOTE_DATA, extra: "stripped by the response schema" },
  data: NOTE_DATA,
  badRequest: "Invalid admin commerce order note request",
  missingDetails: { formErrors: [], fieldErrors: { idempotencyKey: missing(), orderId: missing(), note: missing() } },
  invalidDetails: { formErrors: UNRECOGNIZED_EXTRA, fieldErrors: { idempotencyKey: SHORT_KEY, orderId: missing(), note: missing() } },
  invalidResponse: "Admin commerce note mutation returned invalid response",
  failed: "Admin commerce note mutation failed",
};

// --- shipping address (strict top level; the extra key rides inside `operation`) ---

const ADDRESS_INPUT = {
  recipientName: "Ala Kowalska",
  contactEmail: "ala@example.com",
  contactPhone: "500600700",
  line1: "Prosta 1",
  city: "Example City",
  postalCode: "00-001",
  country: "XX",
};
const DELIVERY_CONTACT = {
  schemaVersion: 1,
  source: "oms_order_override",
  revision: 2,
  recipientName: "Ala Kowalska",
  contactEmail: "ala@example.com",
  contactPhone: "500600700",
  line1: "Prosta 1",
  line2: null,
  city: "Example City",
  postalCode: "00-001",
  country: "XX",
  selectedDelivery: null,
  deliveryInstructions: null,
  courierInstructions: null,
};
const ADDRESS_OPERATION = {
  id: OPERATION_ID,
  orderId: ORDER_ID,
  type: "shipping_address_updated",
  holdId: null,
  actorUserId: null,
  occurredAt: "2026-06-05T10:05:00+00:00",
  payload: { source: "commerce.oms.v0" },
};
const ADDRESS_DATA = {
  contractVersion: VERSION,
  result: "applied",
  scope: "order",
  deliveryContact: DELIVERY_CONTACT,
  operation: ADDRESS_OPERATION,
  // The schema's key order, not the port's.
  address: {
    recipientName: "Ala Kowalska",
    contactEmail: "ala@example.com",
    contactPhone: "500600700",
    line1: "Prosta 1",
    line2: null,
    city: "Example City",
    postalCode: "00-001",
    country: "XX",
  },
  replayed: false,
};

const addressSpec: MutationSpec = {
  label: "shipping address",
  build: (d) => createAdminCommerceOrderUpdateShippingAddressHandler({ authorizeAdmin: d.authorizeAdmin, omsPort: d.omsPort }),
  port: "updateShippingAddress",
  body: {
    idempotencyKey: "  oms-address-0001  ",
    orderId: ORDER_ID,
    expectedRevision: 1,
    expectedContactDigest: "0123456789abcdef0123456789abcdef",
    address: ADDRESS_INPUT,
  },
  args: {
    idempotencyKey: "oms-address-0001",
    orderId: ORDER_ID,
    expectedRevision: 1,
    expectedContactDigest: "0123456789abcdef0123456789abcdef",
    address: ADDRESS_INPUT,
    actorUserId: ACTOR_ID,
  },
  result: {
    ...ADDRESS_DATA,
    operation: { ...ADDRESS_OPERATION, extra: "stripped by the operation schema" },
    address: { ...ADDRESS_INPUT, line2: null },
  },
  data: ADDRESS_DATA,
  badRequest: "Invalid admin commerce order shipping address request",
  missingDetails: {
    formErrors: [],
    fieldErrors: {
      idempotencyKey: missing(),
      orderId: missing(),
      expectedRevision: missing("number"),
      expectedContactDigest: missing(),
      address: missing("object"),
    },
  },
  invalidDetails: {
    formErrors: UNRECOGNIZED_EXTRA,
    fieldErrors: {
      idempotencyKey: SHORT_KEY,
      orderId: missing(),
      expectedRevision: missing("number"),
      expectedContactDigest: missing(),
      address: missing("object"),
    },
  },
  invalidResponse: "Admin commerce shipping address mutation returned invalid response",
  failed: "Admin commerce shipping address mutation failed",
};

// --- list and detail: method, authorization, bad request (before the gate) and success ---

const CUSTOMER = {
  id: CLIENT_ID,
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  phone: "+10000000000",
  lifecycleStage: "customer",
};
const MASKED_CUSTOMER = { ...CUSTOMER, email: "a***@example.com", phone: "***000" };
const PRICING = {
  subtotal: money(12900),
  productDiscount: money(0),
  shipping: money(0),
  shippingDiscount: money(0),
  discountTotal: money(0),
  finalTotal: money(12900),
  source: "order_columns",
};
const SUMMARY_COUNTS = {
  needsAttention: 1,
  activeHold: 0,
  readyForFulfillment: 0,
  paymentIssues: 0,
  inventoryRisk: 1,
  fulfillmentBlocked: 0,
  fulfillmentExceptions: 0,
  invoiceIssues: 0,
  omnipackDispatchedNotPicked: 0,
};
const SUMMARY_TOTALS = { gmv: money(12900), aov: money(12900), orderCount: 1, paidSubscriptionCycleCount: 0 };

/** One queue row as the port answers it: `providerOpsStatus` omitted, one extra key. */
const LIST_ROW = {
  orderId: ORDER_ID,
  orderNumber: "VP-1001",
  clientId: CLIENT_ID,
  customer: CUSTOMER,
  pet: null,
  status: "paid",
  mode: "one_time",
  paymentMethodLabel: "Karta",
  paymentProvider: "example-card",
  paymentStatus: "succeeded",
  fulfillmentStatus: null,
  customerFulfillmentStep: "paid",
  inventoryStatus: "missing",
  accountingStatus: "missing",
  providerOpsSla: null,
  providerOrderId: null,
  attentionReason: "missing_shipping_address",
  nextAction: "review_address",
  activeHoldCount: 0,
  activeHoldReasons: [],
  fulfillmentHealthDigest: { healthStatus: "ok", attentionReasons: [] },
  total: money(12900),
  pricingSummary: PRICING,
  createdAt: "2026-06-05T10:00:00+00:00",
  updatedAt: "2026-06-05T10:01:00+00:00",
  extra: "stripped by the row schema",
};
const LIST_RESULT = {
  contractVersion: VERSION,
  orders: [LIST_ROW],
  summaryCounts: SUMMARY_COUNTS,
  summaryTotals: SUMMARY_TOTALS,
  totalCount: 1,
  page: 2,
  pageSize: 25,
};
const LIST_QUERY = { page: "2", attentionOnly: "true", search: "  ada  " };
const LIST_PARSED = { page: 2, pageSize: 25, search: "ada", attentionOnly: true, sort: "created_desc" };
const LIST_DEFAULTS = { page: 1, pageSize: 25, sort: "created_desc" };

/** The answered row: `providerOpsStatus` filled in its schema place, the extra key gone. */
const rowData = (customer: unknown) => ({
  orderId: ORDER_ID,
  orderNumber: "VP-1001",
  clientId: CLIENT_ID,
  customer,
  pet: null,
  status: "paid",
  mode: "one_time",
  paymentMethodLabel: "Karta",
  paymentProvider: "example-card",
  paymentStatus: "succeeded",
  fulfillmentStatus: null,
  customerFulfillmentStep: "paid",
  inventoryStatus: "missing",
  accountingStatus: "missing",
  providerOpsStatus: "none",
  providerOpsSla: null,
  providerOrderId: null,
  attentionReason: "missing_shipping_address",
  nextAction: "review_address",
  activeHoldCount: 0,
  activeHoldReasons: [],
  fulfillmentHealthDigest: { healthStatus: "ok", attentionReasons: [] },
  total: money(12900),
  pricingSummary: PRICING,
  createdAt: "2026-06-05T10:00:00+00:00",
  updatedAt: "2026-06-05T10:01:00+00:00",
});
const listData = (customer: unknown) => ({
  contractVersion: VERSION,
  orders: [rowData(customer)],
  summaryCounts: SUMMARY_COUNTS,
  summaryTotals: SUMMARY_TOTALS,
  totalCount: 1,
  page: 2,
  pageSize: 25,
});

const SUBSCRIPTION = { subscriptionId: null, subscriptionCycleId: null, subscriptionCycleStatus: null, nextCycleAt: null, cyclePaidAt: null };
const ELIGIBLE = { allowed: true, reason: null };
const INVENTORY = {
  status: "reserved",
  reservationId: "93222222-2222-4222-8222-222222222222",
  reservationStatus: "reserved",
  expiresAt: "2026-06-05T10:30:00+00:00",
  locationId: "a2222222-2222-4222-8222-222222222222",
  locationCode: "pl-main",
};
const HEALTH = {
  healthStatus: "ok",
  attentionReasons: [],
  oldestAgeSeconds: null,
  opaqueIds: { orderId: ORDER_ID, fulfillmentOrderId: null, outboxEventId: null, dispatchRefFulfillmentOrderId: null, latestEvidenceFulfillmentOrderId: null },
};
const ACCOUNTING = {
  status: "missing",
  invoiceId: null,
  invoiceRef: null,
  providerKind: null,
  providerInvoiceNumber: null,
  ksefStatus: null,
  outboxStatus: null,
  outboxAttemptCount: null,
  outboxNextAttemptAt: null,
  outboxLastError: null,
  recoveryGuidance: "not_requested",
  updatedAt: null,
};
const ACTION_ELIGIBILITY = {
  addNote: ELIGIBLE,
  createHold: ELIGIBLE,
  releaseHold: { allowed: false, reason: "no_active_hold" },
  createFulfillment: ELIGIBLE,
  updateShippingAddress: ELIGIBLE,
  recordLabel: { allowed: false, reason: "fulfillment_not_ready_for_label" },
  handOff: { allowed: false, reason: "label_required_before_handoff" },
  recordTrackingEvent: { allowed: false, reason: "tracking_not_ready" },
  cancelFulfillment: { allowed: false, reason: "fulfillment_not_cancellable" },
  cancelOrder: { allowed: false, reason: "order_not_pending_payment" },
  markRefunded: ELIGIBLE,
};
const PAYMENT = { intentId: null, paymentId: null, status: "not_started", activeAttemptId: null, providerPaymentId: null, updatedAt: null };

/**
 * The port's detail: `deliverySelection`, `replacementChain`, `fulfillmentDebug` and the
 * fulfillment's optional fields omitted, `providerOpsStatus` and `fulfillmentEligibility`
 * out of schema order, and an extra key on the order and on the top level.
 */
const DETAIL_RESULT = {
  contractVersion: VERSION,
  order: {
    ...LIST_ROW,
    providerOpsStatus: "none",
    shippingAddress: null,
    billingAddress: null,
    lines: [],
    subscription: SUBSCRIPTION,
    inventory: INVENTORY,
    fulfillment: { fulfillmentOrderId: null, status: null, latestOperationType: null, latestOperationAt: null, providerTrackingId: null },
    fulfillmentHealth: HEALTH,
    accounting: ACCOUNTING,
    actionEligibility: ACTION_ELIGIBILITY,
    fulfillmentEligibility: ELIGIBLE,
    holds: [],
    operations: [],
    payment: PAYMENT,
    paymentAttempts: [],
    paymentTransitions: [],
    communicationDeliveries: [],
  },
  extra: "stripped by the response schema",
};
const detailData = (customer: unknown) => ({
  contractVersion: VERSION,
  order: {
    ...rowData(customer),
    shippingAddress: null,
    billingAddress: null,
    deliverySelection: null,
    lines: [],
    subscription: SUBSCRIPTION,
    fulfillmentEligibility: ELIGIBLE,
    inventory: INVENTORY,
    fulfillment: {
      fulfillmentOrderId: null,
      status: null,
      providerKind: null,
      latestOperationType: null,
      latestOperationAt: null,
      providerTrackingId: null,
      trackingUrl: null,
      carrierKind: null,
      service: null,
      trackingReferences: [],
      trackingTimeline: [],
      providerEvidence: [],
    },
    replacementChain: { sequenceNo: 0, replacesFulfillmentOrderId: null, replacementReason: null, supersededParcels: [] },
    fulfillmentHealth: HEALTH,
    fulfillmentDebug: { summary: "Brak danych fulfillmentu.", severity: "watch", nextAction: "wait", blockers: [], steps: [] },
    accounting: ACCOUNTING,
    actionEligibility: ACTION_ELIGIBILITY,
    holds: [],
    operations: [],
    payment: PAYMENT,
    paymentAttempts: [],
    paymentTransitions: [],
    communicationDeliveries: [],
  },
});

const auditCall = (route: string, query: Record<string, unknown>): Event => ["auditClient.rpc", "record_admin_audit_event", {
  p_actor_id: ACTOR_ID,
  p_action: "customer_read",
  p_source: "mcp_agent",
  p_entity_type: "customer_read",
  p_entity_id: null,
  p_old: null,
  p_new: { route, query, customer_ids: [CLIENT_ID] },
}];

const buildList: Build = (d) => createAdminCommerceOrdersListHandler({ authorizeAdmin: d.authorizeAdmin, omsPort: d.omsPort, governance: d.governance });
const buildDetail: Build = (d) => createAdminCommerceOrderDetailHandler({ authorizeAdmin: d.authorizeAdmin, omsPort: d.omsPort, governance: d.governance });
const listing: Provided = { listOrders: async () => LIST_RESULT };
const detailing: Provided = { getOrderDetail: async () => DETAIL_RESULT };

const LIST_CASES: Case[] = [
  ...["PUT", "DELETE"].map((method) => ({
    name: `405 ${method}, before authorization`,
    build: buildList,
    method,
    expected: [allow("GET, POST"), ...METHOD_NOT_ALLOWED],
  })),
  ...AUTH_REFUSALS.map(([actor, answer]) => ({
    name: `${actor} authorizer`,
    build: buildList,
    method: "GET",
    query: LIST_QUERY,
    actor,
    expected: [AUTHORIZE, ...answer],
  })),
  // A machine actor with the flag off: a gate reached before the parse would answer its own 503.
  {
    name: "invalid GET query, before the gate",
    build: buildList,
    method: "GET",
    query: { page: "0", unknown: "x" },
    actor: "machine",
    governance: "off",
    expected: [AUTHORIZE, ...refused(400, "BAD_REQUEST", "Invalid admin commerce orders request", {
      formErrors: ["Unrecognized key: \"unknown\""],
      fieldErrors: { page: ["Too small: expected number to be >=1"] },
    })],
  },
  {
    name: "invalid POST body, before the gate",
    build: buildList,
    method: "POST",
    body: { pageSize: 500, attentionOnly: "yes" },
    actor: "machine",
    governance: "off",
    expected: [AUTHORIZE, ...refused(400, "BAD_REQUEST", "Invalid admin commerce orders request", {
      formErrors: [],
      fieldErrors: { pageSize: ["Too big: expected number to be <=100"], attentionOnly: ["Invalid input"] },
    })],
  },
  {
    name: "human GET: the parsed query reaches the port, no audit, flag ignored",
    build: buildList,
    method: "GET",
    query: LIST_QUERY,
    actor: "human",
    governance: "off",
    port: listing,
    expected: [AUTHORIZE, ["omsPort.listOrders", LIST_PARSED], ...sent(200, { ok: true, data: listData(CUSTOMER) })],
  },
  {
    name: "machine GET with the flag on: parsed query, redacted audit query, masked rows",
    build: buildList,
    method: "GET",
    query: LIST_QUERY,
    actor: "machine",
    governance: "on",
    port: listing,
    expected: [
      AUTHORIZE,
      ["omsPort.listOrders", LIST_PARSED],
      auditCall("/api/bff/admin/commerce/orders", { page: 2, pageSize: 25, attentionOnly: true, sort: "created_desc", search: "[redacted]" }),
      ...sent(200, { ok: true, data: listData(MASKED_CUSTOMER) }),
    ],
  },
  {
    name: "human POST with an empty body: the defaults reach the port",
    build: buildList,
    method: "POST",
    body: {},
    port: listing,
    expected: [AUTHORIZE, ["omsPort.listOrders", LIST_DEFAULTS], ...sent(200, { ok: true, data: listData(CUSTOMER) })],
  },
  {
    name: "human POST without a body: the defaults reach the port",
    build: buildList,
    method: "POST",
    port: listing,
    expected: [AUTHORIZE, ["omsPort.listOrders", LIST_DEFAULTS], ...sent(200, { ok: true, data: listData(CUSTOMER) })],
  },
].map((c) => ({ ...c, name: `list: ${c.name}` }) as Case);

const DETAIL_CASES: Case[] = [
  ...["POST", "PUT"].map((method) => ({
    name: `405 ${method}, before authorization`,
    build: buildDetail,
    method,
    expected: [allow("GET"), ...METHOD_NOT_ALLOWED],
  })),
  ...AUTH_REFUSALS.map(([actor, answer]) => ({
    name: `${actor} authorizer`,
    build: buildDetail,
    method: "GET",
    query: { orderId: ORDER_ID },
    actor,
    expected: [AUTHORIZE, ...answer],
  })),
  {
    name: "invalid query, before the gate",
    build: buildDetail,
    method: "GET",
    query: { orderId: "not-a-uuid" },
    actor: "machine",
    governance: "off",
    expected: [AUTHORIZE, ...refused(400, "BAD_REQUEST", "Invalid admin commerce order detail request", {
      formErrors: [],
      fieldErrors: { orderId: ["Invalid GUID"] },
    })],
  },
  {
    name: "human: the parsed result, no audit, flag ignored",
    build: buildDetail,
    method: "GET",
    query: { orderId: ORDER_ID },
    actor: "human",
    governance: "off",
    port: detailing,
    expected: [AUTHORIZE, ["omsPort.getOrderDetail", { orderId: ORDER_ID }], ...sent(200, { ok: true, data: detailData(CUSTOMER) })],
  },
  {
    name: "machine with the flag on: audit query and masked order",
    build: buildDetail,
    method: "GET",
    query: { orderId: ORDER_ID },
    actor: "machine",
    governance: "on",
    port: detailing,
    expected: [
      AUTHORIZE,
      ["omsPort.getOrderDetail", { orderId: ORDER_ID }],
      auditCall("/api/bff/admin/commerce/orders/detail", { orderId: ORDER_ID }),
      ...sent(200, { ok: true, data: detailData(MASKED_CUSTOMER) }),
    ],
  },
].map((c) => ({ ...c, name: `detail: ${c.name}` }) as Case);

describe("commerce OMS handler envelopes (Q0 pin)", () => {
  const cases = [
    ...mutationCases(holdSpec),
    ...mutationCases(releaseSpec),
    ...mutationCases(noteSpec),
    ...mutationCases(addressSpec),
    ...LIST_CASES,
    ...DETAIL_CASES,
  ];

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    expect(await observe(c)).toStrictEqual({ calls: c.expected, console: [] });
  });
});
