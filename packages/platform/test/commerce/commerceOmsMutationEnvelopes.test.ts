import type { OmsAdminAuthResult as AdminAuthResult } from "../../src/commerce/server/handlerSupport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmsHandlerRequest as TestRequest } from "../../src/commerce/server/handlerSupport.js";
import type { TestResponse } from "./omsConformanceTestKit.js";
import {
  CommerceOmsConflictError,
  type CommerceOmsHoldPort,
  type CommerceOmsReadPort,
} from "../../src/commerce/oms/omsPorts.js";
import {
  createAdminCommerceOrderHoldHandler,
  createAdminCommerceOrderNoteHandler,
  createAdminCommerceOrderReleaseHoldHandler,
  createAdminCommerceOrderUpdateShippingAddressHandler,
} from "./omsEnvelopeTestBinding.js";

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
type Handler = (req: TestRequest, res: TestResponse) => Promise<void>;
type Actor = "human" | "machine" | "unauthorized" | "forbidden" | "throws";
type OmsPort = CommerceOmsReadPort & CommerceOmsHoldPort;
interface Deps {
  authorizeAdmin: (req: TestRequest) => Promise<AdminAuthResult>;
  omsPort: OmsPort;
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
function recordingResponse(calls: Event[]): TestResponse {
  const res = {} as TestResponse;
  Object.assign(res, recorder<TestResponse>("res", calls, RESPONSE_METHODS, {
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
  });
  const req = { method: c.method, body: c.body, query: c.query ?? {}, headers: {} } as unknown as TestRequest;
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
const XXX = (amountMinor: number) => ({ amountMinor, currency: "XXX" });

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
  recipientName: "Example Person",
  contactEmail: "person@example.invalid",
  contactPhone: "000000001",
  line1: "Example Road 1",
  city: "Example City",
  postalCode: "EXAMPLE-001",
  country: "XX",
};
const DELIVERY_CONTACT = {
  schemaVersion: 1,
  source: "oms_order_override",
  revision: 2,
  recipientName: "Example Person",
  contactEmail: "person@example.invalid",
  contactPhone: "000000001",
  line1: "Example Road 1",
  line2: null,
  city: "Example City",
  postalCode: "EXAMPLE-001",
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
    recipientName: "Example Person",
    contactEmail: "person@example.invalid",
    contactPhone: "000000001",
    line1: "Example Road 1",
    line2: null,
    city: "Example City",
    postalCode: "EXAMPLE-001",
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

describe("neutral OMS mutation envelopes", () => {
  const cases = [...mutationCases(holdSpec), ...mutationCases(releaseSpec), ...mutationCases(noteSpec), ...mutationCases(addressSpec)];
  it.each(cases.map(c => [c.name, c] as const))("%s", async (_name, c) => {
    expect(await observe(c)).toStrictEqual({ calls: c.expected, console: [] });
  });
});
