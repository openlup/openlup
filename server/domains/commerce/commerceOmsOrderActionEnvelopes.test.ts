import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  CommerceOmsConflictError,
  type CommerceOmsHoldPort,
  type CommerceOmsReadPort,
} from "../../../src/domains/commerce/omsPorts.js";
import * as cancelOrderModule from "./commerceOmsCancelOrderHandler.js";
import { createAdminCommerceOrderCancelHandler } from "./commerceOmsCancelOrderHandler.js";
import * as omsHandlersModule from "./commerceOmsHandlers.js";
import type { AdminAuthResult } from "./commerceOmsHandlers.js";
import * as markRefundedModule from "./commerceOmsMarkRefundedHandler.js";
import { createAdminCommerceOrderMarkRefundedHandler } from "./commerceOmsMarkRefundedHandler.js";
import * as replacementShipmentModule from "./commerceOmsReplacementShipmentHandler.js";
import { createAdminCommerceOrderRequestReplacementShipmentHandler } from "./commerceOmsReplacementShipmentHandler.js";

/**
 * Q0 pin (CO-01 to CO-04) for the three sibling OMS order actions: cancel unpaid,
 * mark refunded and replacement shipment. Each case records one ordered call list
 * across the response, the authorizer, the mutations flag and the OMS port (every
 * method of both port interfaces), plus every console call, and compares both
 * strictly. Response bodies are recorded wire-serialised, so key order counts. The
 * response and the port are recorders: a method the case did not provide is
 * recorded and then throws. Request strings are padded, so a raw body reaching
 * the port is red; the replacement result carries an extra key and omits a
 * defaulted field, and the cancel and mark-refunded results arrive in reverse key
 * order, so a raw result in the answer is red. The port fakes settle on a
 * macrotask, so a dropped `await` on the sender is red. The runtime export names
 * of the sibling files, and the factories and `authorize` of
 * `commerceOmsHandlers.ts`, are pinned too. Expected literals were captured from
 * the current handlers' output.
 */

type Event = readonly unknown[];
type Provided = Record<string, (...args: never[]) => unknown>;
type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>;
type Actor = "admin" | "unauthorized" | "forbidden" | "throws";
type OmsPort = CommerceOmsReadPort & CommerceOmsHoldPort;
interface Deps {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  omsPort: OmsPort;
  mutationsEnabled: () => boolean;
}
type Build = (deps: Deps) => Handler;
interface Case {
  name: string;
  build: Build;
  method: string;
  body?: unknown;
  actor?: Actor;
  port?: Provided;
  flag?: boolean;
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
    admin: { ok: true, userId: ACTOR_ID, isMachineActor: false },
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
    authorizeAdmin: authorizer(calls, c.actor ?? "admin"),
    omsPort: recorder<OmsPort>("omsPort", calls, PORT_METHODS, c.port ?? {}),
    mutationsEnabled: () => {
      calls.push(["mutationsEnabled"]);
      return c.flag ?? true;
    },
  });
  const req = { method: c.method, body: c.body, query: {}, headers: {} } as unknown as VercelRequest;
  await handler(req, recordingResponse(calls));
  // Copied at once, so a write after the handler's promise settled is missing. The
  // port fakes settle on a macrotask, so a sender the handler does not await has not
  // written yet when the copy is taken.
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
const FLAG: Event = ["mutationsEnabled"];
const METHOD_NOT_ALLOWED = refused(405, "METHOD_NOT_ALLOWED", "Method not allowed");
const AUTH_REFUSALS: Array<[Actor, Event[]]> = [
  ["unauthorized", refused(401, "UNAUTHORIZED", "Admin session required")],
  ["forbidden", refused(403, "FORBIDDEN", "Admin role required")],
  ["throws", refused(503, "UPSTREAM_UNAVAILABLE", "Admin authorization failed")],
];

const ORDER_ID = "42222222-2222-4222-8222-222222222221";
const VERSION = "commerce.v0";

// Too short once trimmed, and a key no strict request schema admits.
const INVALID_BODY = { idempotencyKey: "  short  ", extra: true };
const NOT_A_RESPONSE = { replayed: "no" };
const CONFLICT = new CommerceOmsConflictError("Order is not pending payment", { reason: "order_not_pending_payment" });
const BARE_CONFLICT = new CommerceOmsConflictError();
const UPSTREAM = new Error("connection reset");

const MISSING = ["Invalid input: expected string, received undefined"];
const SHORT_KEY = ["Too small: expected string to have >=8 characters"];
const UNRECOGNIZED_EXTRA = ["Unrecognized key: \"extra\""];

interface ActionSpec {
  label: string;
  build: Build;
  port: keyof CommerceOmsHoldPort;
  body: Record<string, unknown>;
  /** The parsed body plus the authorizer's `actorUserId`. */
  args: Record<string, unknown>;
  result: unknown;
  data: unknown;
  /** The flag-off message, for the handlers behind `mutationsEnabled`. */
  disabled?: string;
  badRequest: string;
  missingDetails: unknown;
  invalidDetails: unknown;
  invalidResponse: string;
  failed: string;
}

function actionCases(spec: ActionSpec): Case[] {
  // The flag is read once, right after authorization, by the flagged handlers only.
  const authorized: Event[] = spec.disabled ? [AUTHORIZE, FLAG] : [AUTHORIZE];
  const call: Event = [`omsPort.${spec.port}`, spec.args];
  const answer = (value: unknown): Provided => ({ [spec.port]: async () => { await nextMacrotask(); return value; } });
  const reject = (error: Error): Provided => ({ [spec.port]: async () => { await nextMacrotask(); throw error; } });
  const disabled = spec.disabled === undefined ? [] : [
    { name: "flag off, valid body", flag: false, expected: [AUTHORIZE, FLAG, ...refused(403, "FORBIDDEN", spec.disabled)] },
    { name: "flag off, invalid body", flag: false, body: INVALID_BODY, expected: [AUTHORIZE, FLAG, ...refused(403, "FORBIDDEN", spec.disabled)] },
  ];
  const rows: Array<Omit<Case, "build" | "method"> & { method?: string }> = [
    ...["GET", "PUT", "DELETE"].map((method) => ({
      name: `405 ${method}, before authorization`,
      method,
      expected: [["res.setHeader", "Allow", "POST"], ...METHOD_NOT_ALLOWED],
    })),
    ...AUTH_REFUSALS.map(([actor, answerEvents]) => ({ name: `${actor} authorizer`, actor, expected: [AUTHORIZE, ...answerEvents] })),
    ...disabled,
    { name: "no body", body: undefined, expected: [...authorized, ...refused(400, "BAD_REQUEST", spec.badRequest, spec.missingDetails)] },
    { name: "invalid body", body: INVALID_BODY, expected: [...authorized, ...refused(400, "BAD_REQUEST", spec.badRequest, spec.invalidDetails)] },
    { name: "result the response schema refuses", port: answer(NOT_A_RESPONSE), expected: [...authorized, call, ...refused(502, "INVALID_RESPONSE", spec.invalidResponse)] },
    { name: "conflict with details", port: reject(CONFLICT), expected: [...authorized, call, ...refused(409, "CONFLICT", "Order is not pending payment", { reason: "order_not_pending_payment" })] },
    { name: "conflict with the default message and details", port: reject(BARE_CONFLICT), expected: [...authorized, call, ...refused(409, "CONFLICT", "Commerce OMS conflict", {})] },
    { name: "port throws", port: reject(UPSTREAM), expected: [...authorized, call, ...refused(503, "UPSTREAM_UNAVAILABLE", spec.failed)] },
    { name: "success sends the parsed result", port: answer(spec.result), expected: [...authorized, call, ...sent(200, { ok: true, data: spec.data })] },
  ];
  return rows.map((row) => ({ build: spec.build, method: "POST", body: spec.body, ...row, name: `${spec.label}: ${row.name}` }));
}

// The cancel and mark-refunded response schema is strict with scalar fields only, so the
// port answers in reverse key order: the parsed answer has the schema's order, and a raw
// result sent on would not.
const CANCELLED = { contractVersion: VERSION, orderId: ORDER_ID, status: "cancelled", replayed: false };
const REFUNDED = { contractVersion: VERSION, orderId: ORDER_ID, status: "refunded", replayed: false };
const CANCELLED_RESULT = { replayed: false, status: "cancelled", orderId: ORDER_ID, contractVersion: VERSION };
const REFUNDED_RESULT = { replayed: false, status: "refunded", orderId: ORDER_ID, contractVersion: VERSION };

const cancelSpec: ActionSpec = {
  label: "cancel",
  build: (d) => createAdminCommerceOrderCancelHandler({ authorizeAdmin: d.authorizeAdmin, omsPort: d.omsPort, mutationsEnabled: d.mutationsEnabled }),
  port: "cancelOrder",
  body: { idempotencyKey: "  oms-cancel-0001  ", orderId: ORDER_ID, reason: "  customer asked to cancel  " },
  args: { idempotencyKey: "oms-cancel-0001", orderId: ORDER_ID, reason: "customer asked to cancel", actorUserId: ACTOR_ID },
  result: CANCELLED_RESULT,
  data: CANCELLED,
  disabled: "Commerce OMS order cancellation is not enabled",
  badRequest: "Invalid admin commerce order cancellation request",
  missingDetails: { formErrors: [], fieldErrors: { idempotencyKey: MISSING, orderId: MISSING, reason: MISSING } },
  invalidDetails: { formErrors: UNRECOGNIZED_EXTRA, fieldErrors: { idempotencyKey: SHORT_KEY, orderId: MISSING, reason: MISSING } },
  invalidResponse: "Admin commerce order cancellation returned invalid response",
  failed: "Admin commerce order cancellation failed",
};

const markRefundedSpec: ActionSpec = {
  label: "mark refunded",
  build: (d) => createAdminCommerceOrderMarkRefundedHandler({ authorizeAdmin: d.authorizeAdmin, omsPort: d.omsPort, mutationsEnabled: d.mutationsEnabled }),
  port: "markRefunded",
  body: { idempotencyKey: "  oms-refund-0001  ", orderId: ORDER_ID, reason: "  operator confirmed the panel refund  " },
  args: { idempotencyKey: "oms-refund-0001", orderId: ORDER_ID, reason: "operator confirmed the panel refund", actorUserId: ACTOR_ID },
  result: REFUNDED_RESULT,
  data: REFUNDED,
  disabled: "Commerce OMS refund mutations are not enabled",
  badRequest: "Invalid admin commerce order mark-refunded request",
  missingDetails: { formErrors: [], fieldErrors: { idempotencyKey: MISSING, orderId: MISSING, reason: MISSING } },
  invalidDetails: { formErrors: UNRECOGNIZED_EXTRA, fieldErrors: { idempotencyKey: SHORT_KEY, orderId: MISSING, reason: MISSING } },
  invalidResponse: "Admin commerce mark-refunded mutation returned invalid response",
  failed: "Admin commerce mark-refunded mutation failed",
};

const REPLACEMENT_OPERATION = {
  id: "e1111111-1111-4111-8111-111111111111",
  orderId: ORDER_ID,
  type: "replacement_shipment_requested",
  holdId: null,
  actorUserId: null,
  occurredAt: "2026-08-19T10:00:00.000Z",
  payload: { reason: "lost" },
};
const REPLACEMENT = {
  fulfillmentOrderId: "c1111111-1111-4111-8111-111111111111",
  orderId: ORDER_ID,
  sequenceNo: 1,
  replacesFulfillmentOrderId: "d1111111-1111-4111-8111-111111111111",
  reason: "lost",
  status: "created",
};
const REPLACEMENT_REASON = ["Invalid option: expected one of \"damaged\"|\"lost\"|\"returned_undelivered\"|\"other\""];

const replacementSpec: ActionSpec = {
  label: "replacement shipment",
  build: (d) => createAdminCommerceOrderRequestReplacementShipmentHandler({ authorizeAdmin: d.authorizeAdmin, omsPort: d.omsPort }),
  port: "requestReplacementShipment",
  body: { idempotencyKey: "  oms-replacement-0001  ", orderId: ORDER_ID, reason: "lost" },
  args: { idempotencyKey: "oms-replacement-0001", orderId: ORDER_ID, reason: "lost", actorUserId: ACTOR_ID },
  // `releasedHoldIds` omitted (the schema defaults it to []) and one extra key (stripped).
  result: { contractVersion: VERSION, operation: REPLACEMENT_OPERATION, replacement: REPLACEMENT, replayed: false, extra: "stripped by the response schema" },
  data: { contractVersion: VERSION, operation: REPLACEMENT_OPERATION, replacement: REPLACEMENT, releasedHoldIds: [], replayed: false },
  badRequest: "Invalid admin commerce replacement shipment request",
  missingDetails: { formErrors: [], fieldErrors: { idempotencyKey: MISSING, orderId: MISSING, reason: REPLACEMENT_REASON } },
  invalidDetails: { formErrors: UNRECOGNIZED_EXTRA, fieldErrors: { idempotencyKey: SHORT_KEY, orderId: MISSING, reason: REPLACEMENT_REASON } },
  invalidResponse: "Admin commerce replacement shipment returned invalid response",
  failed: "Admin commerce replacement shipment failed",
};

const CANCEL_STATUS_MISMATCH: Case = {
  name: "cancel: a valid result whose status is not cancelled",
  build: cancelSpec.build,
  method: "POST",
  body: cancelSpec.body,
  port: { cancelOrder: async () => REFUNDED },
  expected: [
    AUTHORIZE,
    FLAG,
    ["omsPort.cancelOrder", cancelSpec.args],
    ...refused(502, "INVALID_RESPONSE", "Admin commerce order cancellation returned invalid response"),
  ],
};

describe("commerce OMS order action envelopes (Q0 pin)", () => {
  const cases = [
    ...actionCases(cancelSpec),
    CANCEL_STATUS_MISMATCH,
    ...actionCases(markRefundedSpec),
    ...actionCases(replacementSpec),
  ];

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    expect(await observe(c)).toStrictEqual({ calls: c.expected, console: [] });
  });
});

describe("commerce OMS public names (Q0 pin, CO-04)", () => {
  // Sorted: the pin is the name set, not the declaration order.
  it("keeps the exact runtime export names of the three sibling files", () => {
    expect({
      cancel: Object.keys(cancelOrderModule).sort(),
      markRefunded: Object.keys(markRefundedModule).sort(),
      replacementShipment: Object.keys(replacementShipmentModule).sort(),
    }).toStrictEqual({
      cancel: ["createAdminCommerceOrderCancelHandler"],
      markRefunded: ["createAdminCommerceOrderMarkRefundedHandler"],
      replacementShipment: ["createAdminCommerceOrderRequestReplacementShipmentHandler"],
    });
  });

  // Q1 adds its two helpers to this file as exports, so its full list is not pinned.
  it("keeps the six factories and authorize of commerceOmsHandlers.ts", () => {
    const exported = omsHandlersModule as Record<string, unknown>;
    const names = [
      "authorize",
      "createAdminCommerceOrderDetailHandler",
      "createAdminCommerceOrderHoldHandler",
      "createAdminCommerceOrderNoteHandler",
      "createAdminCommerceOrderReleaseHoldHandler",
      "createAdminCommerceOrderUpdateShippingAddressHandler",
      "createAdminCommerceOrdersListHandler",
    ];
    expect(names.map((name) => [name, typeof exported[name]])).toStrictEqual([
      ["authorize", "function"],
      ["createAdminCommerceOrderDetailHandler", "function"],
      ["createAdminCommerceOrderHoldHandler", "function"],
      ["createAdminCommerceOrderNoteHandler", "function"],
      ["createAdminCommerceOrderReleaseHoldHandler", "function"],
      ["createAdminCommerceOrderUpdateShippingAddressHandler", "function"],
      ["createAdminCommerceOrdersListHandler", "function"],
    ]);
  });
});
