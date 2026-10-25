import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderReviewAdminReadPort, OrderReviewLifecyclePort } from "../../src/commerce/orderReviewPorts.js";
import * as adminHandlersModule from "../../src/commerce/server/orderReviewAdminHandlers.js";
import { createOrderReviewAdminHandlers } from "../../src/commerce/server/orderReviewAdminHandlers.js";
import * as customerHandlersModule from "../../src/commerce/server/orderReviewHandlers.js";
import { createOrderReviewHandlers } from "../../src/commerce/server/orderReviewHandlers.js";

/**
 * Q0 pin (CR-03, CR-05) for the HTTP-neutral order-review handlers,
 * `createOrderReviewHandlers` and `createOrderReviewAdminHandlers`. Each case
 * records one ordered call list across both ports (every method of the lifecycle
 * and admin read ports), plus every console call, and compares them strictly
 * together with the exact handler result, so the presence of `replayed` (also
 * `replayed: undefined`) counts. Port arguments are recorded wire-serialised, so
 * key order counts and an `undefined` field is absent. The inputs list their keys
 * out of schema order and `submit` pads its comment, so a raw input reaching a
 * port is red. Port results carry an extra key, which reaches the handler result
 * unchanged (no result schema runs in the handlers). The ports are recorders: a
 * method the case did not provide is recorded and then throws. Every port fake
 * settles in a later macrotask, so a port call that is not awaited is red.
 * Expected literals were captured from the current handlers' output.
 */

type Event = readonly unknown[];
type Provided = Record<string, (...args: never[]) => unknown>;
interface Handlers {
  customer: ReturnType<typeof createOrderReviewHandlers>;
  admin: ReturnType<typeof createOrderReviewAdminHandlers>;
}
interface Case {
  name: string;
  invoke: (handlers: Handlers) => Promise<unknown>;
  port?: Provided;
  result: unknown;
  calls: Event[];
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

const LIFECYCLE_METHODS = ["read", "submit", "createMediaIntent", "confirmMedia", "moderate", "revoke"];
const READ_PORT_METHODS = ["list", "read"];

/** Settles after a macrotask, later than every microtask a non-awaited caller would run. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every listed method records its single argument wire-serialised; one the case did not provide then throws. */
function recorder<T extends object>(name: string, calls: Event[], methods: readonly string[], provided: Provided): T {
  return Object.fromEntries(methods.map((method) => [method, (...args: unknown[]) => {
    calls.push([`${name}.${method}`, ...args.map((arg) => JSON.stringify(arg))]);
    const implementation = provided[`${name}.${method}`] as ((...args: unknown[]) => unknown) | undefined;
    if (!implementation) throw new Error(`unexpected call: ${name}.${method}`);
    return implementation(...args);
  }])) as T;
}

async function observe(c: Case): Promise<{ result: unknown; calls: Event[]; console: Event[] }> {
  const calls: Event[] = [];
  const lifecycle = recorder<OrderReviewLifecyclePort>("lifecycle", calls, LIFECYCLE_METHODS, c.port ?? {});
  const readPort = recorder<OrderReviewAdminReadPort>("readPort", calls, READ_PORT_METHODS, c.port ?? {});
  const result = await c.invoke({
    customer: createOrderReviewHandlers(lifecycle),
    admin: createOrderReviewAdminHandlers(lifecycle, readPort),
  });
  // Copied at once: every port fake settles in a later macrotask.
  return { result, calls: [...calls], console: [...consoleEvents] };
}

const answer = (method: string, value: unknown): Provided => ({ [method]: async () => { await nextMacrotask(); return value; } });
const reject = (method: string, error: unknown): Provided => ({ [method]: async () => { await nextMacrotask(); throw error; } });
const coded = (code: unknown) => Object.assign(new Error("port failed"), { code });

const GRANT = "review-grant:123e4567-e89b-12d3-a456-426614174000";
const REVIEW_REF = "order-review:123e4567-e89b-12d3-a456-426614174001";
const MEDIA_REF = "order-review-media:123e4567-e89b-12d3-a456-426614174002";
const DIGEST = "c".repeat(64);
const ACTOR = "admin-user-7";
const EXTRA = { extra: "passed through unparsed" };
const REVIEW = {
  contractVersion: "commerce.order-review.v1",
  reviewRef: REVIEW_REF,
  rating: 5,
  comment: "Works as described",
  moderation: "pending",
  createdAt: "2026-10-05T10:00:00+00:00",
};
const PENDING_MEDIA = {
  mediaRef: MEDIA_REF,
  declaredContentType: "image/png",
  declaredByteLength: 2048,
  state: "pending",
  observedContentType: null,
  observedByteLength: null,
  observedDigest: null,
};
const STORED_MEDIA = { ...PENDING_MEDIA, state: "stored", observedContentType: "image/png", observedByteLength: 2048, observedDigest: DIGEST };

const INVALID = { ok: false, error: { kind: "invalid" } };
const CONFLICT = { ok: false, error: { kind: "conflict" } };
const UNAVAILABLE = { ok: false, error: { kind: "unavailable" } };
const ERROR_TABLE: Array<[string, unknown, unknown]> = [
  ["code 23505", coded("23505"), CONFLICT],
  ["code order_review_conflict", coded("order_review_conflict"), CONFLICT],
  ["code order_review_invalid", coded("order_review_invalid"), INVALID],
  ["code 22023", coded("22023"), INVALID],
  ["an unknown string code", coded("P0001"), UNAVAILABLE],
  ["a numeric code 23505", coded(23505), UNAVAILABLE],
  ["no code", new Error("port failed"), UNAVAILABLE],
];
const REPLAYED: Array<[string, boolean | undefined]> = [["true", true], ["false", false], ["absent", undefined]];
const withReplayed = (value: Record<string, unknown>, replayed: boolean | undefined) =>
  replayed === undefined ? value : { ...value, replayed };

interface CommandSpec {
  label: string;
  /** `lifecycle.<method>`. */
  port: string;
  invoke: (handlers: Handlers, input: unknown, actor: string) => Promise<unknown>;
  input: Record<string, unknown>;
  /** The parsed input as the port receives it, wire-serialised. */
  args: string;
  invalidInputs: Array<[string, unknown]>;
  /** The port's result and the handler's `value` for one `replayed` form. */
  success: (replayed: boolean | undefined) => { result: unknown; value: unknown };
  admin?: boolean;
}

function commandCases(spec: CommandSpec): Case[] {
  const call: Event = [spec.port, spec.args];
  const run = (input: unknown, actor = ACTOR) => (handlers: Handlers) => spec.invoke(handlers, input, actor);
  const rows: Case[] = [
    ...spec.invalidInputs.map(([label, input]) => ({ name: `invalid input: ${label}`, invoke: run(input), result: INVALID, calls: [] })),
    ...REPLAYED.map(([label, replayed]) => {
      const { result, value } = spec.success(replayed);
      return {
        name: `success, replayed ${label}`,
        invoke: run(spec.input),
        port: answer(spec.port, result),
        result: { ok: true, value, replayed },
        calls: [call],
      };
    }),
    ...ERROR_TABLE.map(([label, error, result]) => ({
      name: `port throws, ${label}`,
      invoke: run(spec.input),
      port: reject(spec.port, error),
      result,
      calls: [call],
    })),
  ];
  if (spec.admin) {
    for (const actor of ["", "bad actor"]) {
      rows.push(
        { name: `invalid actor "${actor}", valid input`, invoke: run(spec.input, actor), result: UNAVAILABLE, calls: [] },
        { name: `invalid actor "${actor}", invalid input`, invoke: run(spec.invalidInputs[0][1], actor), result: UNAVAILABLE, calls: [] },
      );
    }
  }
  return rows.map((row) => ({ ...row, name: `${spec.label}: ${row.name}` }));
}

const submitCases = commandCases({
  label: "submit",
  port: "lifecycle.submit",
  invoke: ({ customer }, input) => customer.submit(input),
  input: { fingerprint: DIGEST, comment: "  Works as described  ", rating: 5, grant: GRANT },
  args: JSON.stringify({ grant: GRANT, rating: 5, comment: "Works as described", fingerprint: DIGEST }),
  invalidInputs: [
    ["an extra key", { grant: GRANT, rating: 5, fingerprint: DIGEST, extra: true }],
    ["a blank comment", { grant: GRANT, rating: 5, comment: "   ", fingerprint: DIGEST }],
    ["a rating of 6", { grant: GRANT, rating: 6, fingerprint: DIGEST }],
    ["not an object", null],
  ],
  success: (replayed) => ({ result: withReplayed({ value: { ...REVIEW, ...EXTRA } }, replayed), value: { ...REVIEW, ...EXTRA } }),
});

const intentResult = (replayed: boolean | undefined) =>
  withReplayed({ media: PENDING_MEDIA, uploadExpiresAt: "2026-10-05T10:15:00+00:00", ...EXTRA }, replayed);
const createMediaIntentCases = commandCases({
  label: "createMediaIntent",
  port: "lifecycle.createMediaIntent",
  invoke: ({ customer }, input) => customer.createMediaIntent(input),
  input: { commandKey: "intent:1", capabilityDigest: DIGEST, byteLength: 2048, contentType: "image/png", grant: GRANT },
  args: JSON.stringify({ grant: GRANT, contentType: "image/png", byteLength: 2048, capabilityDigest: DIGEST, commandKey: "intent:1" }),
  invalidInputs: [
    ["an extra key", { grant: GRANT, contentType: "image/png", byteLength: 2048, capabilityDigest: DIGEST, commandKey: "intent:1", extra: true }],
    ["a GIF", { grant: GRANT, contentType: "image/gif", byteLength: 2048, capabilityDigest: DIGEST, commandKey: "intent:1" }],
    ["over 20 MiB", { grant: GRANT, contentType: "image/png", byteLength: 20 * 1024 * 1024 + 1, capabilityDigest: DIGEST, commandKey: "intent:1" }],
  ],
  success: (replayed) => ({ result: intentResult(replayed), value: intentResult(replayed) }),
});

const confirmMediaCases = commandCases({
  label: "confirmMedia",
  port: "lifecycle.confirmMedia",
  invoke: ({ customer }, input) => customer.confirmMedia(input),
  input: { commandKey: "confirm:1", digest: DIGEST, mediaRef: MEDIA_REF, grant: GRANT },
  args: JSON.stringify({ grant: GRANT, mediaRef: MEDIA_REF, digest: DIGEST, commandKey: "confirm:1" }),
  invalidInputs: [
    ["an extra key", { grant: GRANT, mediaRef: MEDIA_REF, digest: DIGEST, commandKey: "confirm:1", extra: true }],
    ["an uppercase digest", { grant: GRANT, mediaRef: MEDIA_REF, digest: "C".repeat(64), commandKey: "confirm:1" }],
  ],
  success: (replayed) => ({ result: withReplayed({ value: { ...STORED_MEDIA, ...EXTRA } }, replayed), value: { ...STORED_MEDIA, ...EXTRA } }),
});

const moderateCases = commandCases({
  label: "admin moderate",
  port: "lifecycle.moderate",
  admin: true,
  invoke: ({ admin }, input, actor) => admin.moderate(actor, input),
  input: { idempotencyKey: "moderate:1", action: "publish", reviewRef: REVIEW_REF },
  args: JSON.stringify({ reviewRef: REVIEW_REF, action: "publish", idempotencyKey: "moderate:1", actorRef: ACTOR }),
  invalidInputs: [
    ["an unknown action", { reviewRef: REVIEW_REF, action: "delete", idempotencyKey: "moderate:1" }],
    ["an extra key", { reviewRef: REVIEW_REF, action: "hide", idempotencyKey: "moderate:1", actorRef: "spoofed" }],
  ],
  success: (replayed) => ({ result: withReplayed({ value: { ...REVIEW, ...EXTRA } }, replayed), value: { ...REVIEW, ...EXTRA } }),
});

const revokeCases = commandCases({
  label: "admin revoke",
  port: "lifecycle.revoke",
  admin: true,
  invoke: ({ admin }, input, actor) => admin.revoke(actor, input as never),
  input: { idempotencyKey: "revoke:1", reviewRef: REVIEW_REF },
  args: JSON.stringify({ reviewRef: REVIEW_REF, idempotencyKey: "revoke:1", actorRef: ACTOR }),
  invalidInputs: [
    ["a malformed reviewRef", { reviewRef: "order-review:nope", idempotencyKey: "revoke:1" }],
    ["an extra key", { reviewRef: REVIEW_REF, idempotencyKey: "revoke:1", actorRef: "spoofed" }],
  ],
  success: (replayed) => ({ result: withReplayed({ ...EXTRA }, replayed), value: withReplayed({ ...EXTRA }, replayed) }),
});

const READ_RESULT = { review: null, media: [], ...EXTRA };
const customerReadCases: Case[] = [
  { name: "read: null", invoke: ({ customer }) => customer.read(GRANT), port: answer("lifecycle.read", null), result: UNAVAILABLE, calls: [["lifecycle.read", JSON.stringify(GRANT)]] },
  {
    name: "read: a value, unparsed and without replayed",
    invoke: ({ customer }) => customer.read(GRANT),
    port: answer("lifecycle.read", READ_RESULT),
    result: { ok: true, value: READ_RESULT },
    calls: [["lifecycle.read", JSON.stringify(GRANT)]],
  },
  ...ERROR_TABLE.map(([label, error, result]): Case => ({
    name: `read: port throws, ${label}`,
    invoke: ({ customer }) => customer.read(GRANT),
    port: reject("lifecycle.read", error),
    result,
    calls: [["lifecycle.read", JSON.stringify(GRANT)]],
  })),
];

const LIST_RESULT = { items: [{ ...REVIEW, ...EXTRA }], nextCursor: "cursor-2", ...EXTRA };
const listCall = (limit: number, cursor?: string): Event => ["readPort.list", JSON.stringify({ actorRef: ACTOR, cursor, limit })];
const adminListCases: Case[] = [
  { name: "admin list: invalid actor", invoke: ({ admin }) => admin.list("bad actor", { limit: 10 }), result: UNAVAILABLE, calls: [] },
  ...([[0, 1], [1, 1], [undefined, 25], [100, 100], [999, 100], [-5, 1]] as Array<[number | undefined, number]>).map(([limit, bounded]): Case => ({
    name: `admin list: limit ${String(limit)} reaches the port as ${bounded}`,
    invoke: ({ admin }) => admin.list(ACTOR, { cursor: "cursor-1", limit }),
    port: answer("readPort.list", LIST_RESULT),
    result: { ok: true, value: LIST_RESULT },
    calls: [listCall(bounded, "cursor-1")],
  })),
  {
    name: "admin list: no cursor",
    invoke: ({ admin }) => admin.list(ACTOR, {}),
    port: answer("readPort.list", LIST_RESULT),
    result: { ok: true, value: LIST_RESULT },
    calls: [listCall(25)],
  },
  {
    name: "admin list: a coded throw is unavailable",
    invoke: ({ admin }) => admin.list(ACTOR, {}),
    port: reject("readPort.list", coded("23505")),
    result: UNAVAILABLE,
    calls: [listCall(25)],
  },
];

const DETAIL = { review: { ...REVIEW, ...EXTRA }, media: [STORED_MEDIA], ...EXTRA };
const readCall: Event = ["readPort.read", JSON.stringify({ actorRef: ACTOR, reviewRef: REVIEW_REF })];
const adminReadCases: Case[] = [
  { name: "admin read: invalid actor", invoke: ({ admin }) => admin.read("", REVIEW_REF), result: UNAVAILABLE, calls: [] },
  { name: "admin read: a bad reference", invoke: ({ admin }) => admin.read(ACTOR, "order-review:nope"), result: UNAVAILABLE, calls: [] },
  { name: "admin read: null", invoke: ({ admin }) => admin.read(ACTOR, REVIEW_REF), port: answer("readPort.read", null), result: UNAVAILABLE, calls: [readCall] },
  {
    name: "admin read: a value, unparsed",
    invoke: ({ admin }) => admin.read(ACTOR, REVIEW_REF),
    port: answer("readPort.read", DETAIL),
    result: { ok: true, value: DETAIL },
    calls: [readCall],
  },
  {
    name: "admin read: a coded throw is unavailable",
    invoke: ({ admin }) => admin.read(ACTOR, REVIEW_REF),
    port: reject("readPort.read", coded("order_review_invalid")),
    result: UNAVAILABLE,
    calls: [readCall],
  },
];

describe("order review handler results (Q0 pins)", () => {
  it.each([
    ...customerReadCases,
    ...submitCases,
    ...createMediaIntentCases,
    ...confirmMediaCases,
    ...moderateCases,
    ...revokeCases,
    ...adminListCases,
    ...adminReadCases,
  ])("$name", async (c) => {
    expect(await observe(c)).toStrictEqual({ result: c.result, calls: c.calls, console: [] });
  });

  it("keeps the exact runtime export names of orderReviewAdminHandlers.ts", () => {
    expect(Object.keys(adminHandlersModule).sort()).toStrictEqual(["createOrderReviewAdminHandlers"]);
  });

  it("keeps the current runtime exports of orderReviewHandlers.ts (Q1 adds one)", () => {
    const exported = customerHandlersModule as Record<string, unknown>;
    expect(["createOrderReviewHandlers"].map((name) => [name, typeof exported[name]])).toStrictEqual([
      ["createOrderReviewHandlers", "function"],
    ]);
  });
});
