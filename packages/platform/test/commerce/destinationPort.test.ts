import { inspect } from "node:util";
import { createDestinationDocumentPrivacyContributor, createDestinationReceiptPrivacyContributor, createPersonalDataContributorRegistry } from "@openlup/platform/identity";
import { expect, it } from "vitest";
import { z } from "zod";
import { createCheckoutCommandSchemas } from "@openlup/platform/commerce";
import type { CheckoutCommandV2 } from "@openlup/platform/commerce/contracts";
import { createCheckoutCommandV2Schema, destinationV2Capabilities } from "@openlup/platform/commerce/server/destinations";
import {
  createPostgresDestinationPort, createPostgresDestinationPortV2,
  type DestinationContextV2, type DestinationDocument, type DestinationPortV2, type DestinationReadDocument,
} from "../../src/commerce/server/destinations/index.js";
import { ref } from "../../src/pricing/quoteMoneyValidationV2.js";

it("preserves the destination routine contract and refuses invalid responses", async () => {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  let rows: Record<string, unknown>[] = [{ result: { destinationId: "destination" } }];
  const port = createPostgresDestinationPort({ query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows };
  } });
  const address = { recipientName: "Example", line1: "Synthetic 1", city: "Example", postalCode: "00000", country: "XX" };
  const now = "2026-11-03T12:00:00.123456Z";
  const change = { actorId: "actor", clientId: "client", idempotencyKey: "change", subscriptionId: "subscription",
    newAddress: address, expectedVersion: 7, reason: "requested", now };
  expect(await port.registerOrder({ idempotencyKey: "register", orderId: "order", address, now })).toEqual(rows[0]!.result);
  expect(await port.read("shipment", "shipment")).toEqual(rows[0]!.result);
  expect(await port.changeShippingAddress(change)).toEqual(rows[0]!.result);
  expect(calls).toEqual([
    { sql: "SELECT public.commerce_register_order_destination($1,$2,$3,$4) AS result", values: ["register", "order", JSON.stringify(address), now] },
    { sql: "SELECT public.commerce_read_destination($1,$2) AS result", values: ["shipment", "shipment"] },
    { sql: "SELECT public.subscription_change_shipping_destination($1,$2,$3,$4,$5,$6,$7) AS result",
      values: ["actor", "client", "change", "subscription", JSON.stringify({ newAddress: address, reason: "requested" }), 7, now] },
  ]);
  for (rows of [[], [{ result: null }], [{ result: "invalid" }], [{ result: {} }, { result: {} }]]) {
    await expect(port.registerOrder({ idempotencyKey: "register", orderId: "order", address, now })).rejects.toThrow("commerce_destination_response_invalid");
    await expect(port.read("order", "order")).rejects.toThrow("commerce_destination_response_invalid");
    await expect(port.readWithSaved("order", "order")).rejects.toThrow("commerce_destination_response_invalid");
    await expect(port.changeShippingAddress(change)).rejects.toThrow("commerce_destination_response_invalid");
  }
});


it("keeps the existing typed reader and adds an explicitly saved-aware reader", async () => {
  const typed: DestinationDocument = { destinationId: "typed",revision: 1,clientId: "client",address: {
    recipientName: "Typed Recipient",line1: "Street 1",line2: null,city: "Example",postalCode: "12345",country: "ZZ",
    contactPhone: null,label: null,companyName: null,taxId: null,deliveryNotes: null,courierInstructions: null,
  } };
  let value: DestinationReadDocument = typed;
  const port = createPostgresDestinationPort({ query: async () => ({ rows: [{ result: value }] }) });
  const d = await port.read("order", "order");
  expect(d).toEqual(typed);
  value = { ...typed,address: { ...typed.address,savedAddressId: "saved",recipientName: null } };
  expect(await port.readWithSaved("order", "order")).toEqual(value);
  await expect(port.read("order", "order")).rejects.toThrow("commerce_destination_response_invalid");
});

const sku = z.literal("item");
const commandV1 = {
  version: "commerce.checkout_command.v1", idempotencyKey: " sample-key ", mode: "one_time",
  lines: [{ sku: "item", quantity: 1 }], currency: "XXX",
  customer: { firstName: " Example ", lastName: " Buyer ", email: " buyer@example.test ", phone: " 123456 " },
  shippingAddress: { street: "  Sample 1 ", postalCode: " 12345 ", city: " Sample ", country: " XX " },
};

it("checkout_v1_strict_bytes_unchanged", () => {
  const { checkoutCommandV1Schema } = createCheckoutCommandSchemas({ sku, paymentIntentStatus: z.string(), paymentAttemptStatus: z.string() });
  expect(JSON.stringify(checkoutCommandV1Schema.parse(commandV1))).toBe('{"version":"commerce.checkout_command.v1","idempotencyKey":"sample-key","mode":"one_time","lines":[{"sku":"item","quantity":1}],"customer":{"firstName":"Example","lastName":"Buyer","email":"buyer@example.test","phone":"123456"},"shippingAddress":{"street":"Sample 1","postalCode":"12345","city":"Sample","country":"XX"},"currency":"XXX"}');
  const result = checkoutCommandV1Schema.safeParse({ ...commandV1, shippingAddress: { ...commandV1.shippingAddress, line2: "2", subdivisionCode: "AA" } });
  expect(JSON.stringify(result.error?.issues)).toBe('[{"code":"unrecognized_keys","keys":["line2","subdivisionCode"],"path":["shippingAddress"],"message":"Unrecognized keys: \\"line2\\", \\"subdivisionCode\\""}]');
});

it("accepts a strict v2 destination with the incumbent checkout envelope", () => {
  const schema = createCheckoutCommandV2Schema({ sku });
  const shippingAddress = { line1: " Sample 1 ", line2: "2", subdivisionCode: "AA", postalCode: "12345", city: "Sample", countryCode: "XX" };
  const command: CheckoutCommandV2 = { ...commandV1, version: "commerce.checkout_command.v2", mode: "one_time", shippingAddress };
  expect(schema.parse(command)).toMatchObject({ idempotencyKey: "sample-key", customer: { firstName: "Example" }, shippingAddress });
  expect(schema.parse({ ...command, mode: "subscription", cadenceDays: 30 })).toMatchObject({ cadenceDays: 30 });
  const cases = [
    [commandV1, ["version"], "destination_dialect_invalid"],
    [{ ...command, shippingAddress: { ...shippingAddress, street: "Extra" } }, ["shippingAddress", "street"], "address_invalid_input"],
    [{ ...command, shippingAddress: { ...shippingAddress, line2: null } }, ["shippingAddress", "line2"], "address_invalid_input"],
    [{ ...command, shippingAddress: null }, ["shippingAddress"], "address_invalid_input"],
    [{ ...command, mode: "subscription" }, ["cadenceDays"], "address_invalid_input"],
    [{ ...command, cadenceDays: 30 }, ["cadenceDays"], "address_invalid_input"],
    [{ ...command, owner: "extra" }, ["owner"], "address_invalid_input"],
    [{ ...command, lines: [{ sku: "other", quantity: 1 }] }, ["lines", 0, "sku"], "address_invalid_input"],
  ] as const;
  for (const [input, path, refusalCode] of cases) {
    expect(schema.safeParse(input).error?.issues).toEqual([
      expect.objectContaining({ path, params: { refusalCode }, message: expect.stringMatching(/Submit|resubmit/) }),
    ]);
  }
});

it.each([["item", true], ["other", false]] as const)("matches v1 async SKU admission for %s", async (item, accepted) => {
  const sku = z.string().refine(async value => value === "item", "SKU is unavailable");
  const { checkoutCommandV1Schema } = createCheckoutCommandSchemas({ sku, paymentIntentStatus: z.string(), paymentAttemptStatus: z.string() });
  const lines = [{ sku: item, quantity: 1 }];
  const v1 = await checkoutCommandV1Schema.safeParseAsync({ ...commandV1, lines });
  expect(v1.success).toBe(accepted);
  const v2 = await createCheckoutCommandV2Schema({ sku }).safeParseAsync({
    ...commandV1, lines, version: "commerce.checkout_command.v2",
    shippingAddress: { line1: "Sample 1", city: "Sample", postalCode: "12345", countryCode: "XX" },
  });
  expect(v2.success).toBe(v1.success);
  if (v1.success) expect(v2.data?.lines).toEqual(v1.data.lines);
  else expect(v2.error?.issues).toEqual([expect.objectContaining({
    path: v1.error.issues[0]?.path, params: { refusalCode: "address_invalid_input" },
    message: expect.stringContaining("SKU is unavailable. Correct the indicated checkout input and resubmit."),
  })]);
});

it("discovers fresh destination issuance and saved address support independently", () => {
  const privacyRegistry = createPersonalDataContributorRegistry(
    [createDestinationReceiptPrivacyContributor(), createDestinationDocumentPrivacyContributor()],
    { requiredContributorIds: ["destination-receipts", "destination-documents"] },
  );
  expect(destinationV2Capabilities({ rail: "native", installed: true, issuanceEnabled: true, privacyRegistry })).toEqual({
    destinationAddressV2: { capability: "destinationAddressV2", supported: true, available: true },
    savedAddressV2: { capability: "savedAddressV2", supported: false, available: false, refusalCode: "destination_v2_unsupported_rail" },
  });
  for (const state of [{}, { installed: true }, { installed: true, issuanceEnabled: false }, { issuanceEnabled: true }, { installed: true, issuanceEnabled: true }]) {
    expect(destinationV2Capabilities({ rail: "native", ...state }).destinationAddressV2).toEqual({
      capability: "destinationAddressV2", supported: true, available: false, refusalCode: "destination_v2_unavailable",
    });
  }
  const managed = destinationV2Capabilities({ rail: "managed", installed: true, issuanceEnabled: true });
  for (const [capability, state] of Object.entries(managed)) {
    expect(state).toEqual({ capability, supported: false, available: false, refusalCode: "destination_v2_unsupported_rail" });
  }
});

const clientId = "00000000-0000-0000-0000-000000000001";
const scopeRef = "00000000-0000-0000-0000-000000000002";
const orderId = "00000000-0000-0000-0000-000000000003";
const shipmentId = "aaaa0000-0000-0000-0000-000000000004";
const snapshotRef = "00000000-0000-0000-0000-000000000005";
const selectionRevision = "00000000-0000-0000-0000-000000000006";
const eventId = "00000000-0000-0000-0000-000000000007";
const now = "2030-01-01T00:00:00.000Z";
const evidenceExpiresAt = "2030-01-02T00:00:00.000Z";
const owner = { installationRef: "example", principalKind: "customer", principalRef: orderId, customerOrSessionRef: clientId } as const;
const context: DestinationContextV2 = { clientId, scopeRef, owner };
const binding = { snapshotRef, schemaVersion: 2, destinationDigest: "a".repeat(64), policyRevision: " revision-1 " } as const;
const selection = { kind: "checkout", scopeRef, selectionRevision } as const;
const service = { deliverySelectionRef: "delivery", providerRef: "provider", carrierRef: "carrier", serviceRef: "service",
  servicePolicyRevision: "policy", adapterRevision: "adapter" };
const check = { kind: "checkout", scopeRef, expectedSelectionRevision: selectionRevision, expectedBinding: binding, expectedService: service } as const;
const address = { line1: "1 Example Street", city: "Example", postalCode: "00000" };
const contact = { recipientName: "Example Recipient" };
const original = { address: { ...address, countryCode: "XX", subdivisionCode: "AA" }, contact };
const projected = { ...original, policyRef: "policy", policyRevision: binding.policyRevision, classificationKeys: ["example"] };
const command = { dialect: "commerce.destination.snapshot.v2", requestKey: "request-key", requestDigest: "c".repeat(64),
  purpose: "checkout", scopeRef, original } as const;
const issued = { binding, selection, evidenceExpiresAt, eventId, replayed: false };
const verified = {
  binding, documentDigest: "b".repeat(64), evidenceExpiresAt,
  document: { ...binding, revision: 1, owner, clientId, policyRef: "policy", classificationKeys: ["example"],
    address: { ...address, country: "XX", subdivision: "AA" }, contact },
};
const selected = { binding, selection, service };
const sql = {
  snapshot: "SELECT public.commerce_snapshot_destination_v2($1::jsonb, $2::jsonb, $3::timestamptz) AS result",
  read: "SELECT public.commerce_read_destination_v2($1::jsonb, $2::text, $3::uuid, $4::jsonb) AS result",
  recheck: "SELECT public.commerce_recheck_destination_v2($1::jsonb, $2::text, $3::uuid, $4::uuid, $5::jsonb, $6::jsonb) AS result",
  registerOrder: "SELECT public.commerce_register_order_destination_v2($1::jsonb, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::jsonb, $7::jsonb) AS result",
};
const contextJson = JSON.stringify(context);
const checkValues = [check.kind, scopeRef, selectionRevision, JSON.stringify(binding), JSON.stringify(service)];

type Refusal = { outcome: "refused"; code: string; field: string; observed: string; cause: string; fix: string; recheck: string };
const refusal = (code: string, field: string, [observed, cause, fix, recheck]: [string, string, string, string]): Refusal =>
  ({ outcome: "refused", code, field, observed, cause, fix, recheck });
const malformed = (field: string) => refusal("address_invalid_input", field, [
  "A required input is missing or malformed.", "The destination operation requires valid authored input.",
  "Correct the indicated input.", "Resubmit valid authored input.",
]);
const transportRefusal = (field: string) => refusal("address_invalid_input", field, [
  "An argument cannot be sent as plain JSON.", "The native destination operation requires lossless JSON arguments.",
  "Supply plain JSON data in the indicated argument.", "Resubmit the original representable data.",
]);
const wrongKind = refusal("destination_dialect_invalid", "version", [
  "The entry kind is unsupported.", "This operation requires a supported destination kind.",
  "Use the supported entry.", "Invoke the supported checkout or retained-read entry.",
]);
const invalidBinding = refusal("destination_binding_invalid", "destination", [
  "The supplied tuple is malformed.", "The operation requires an authoritative binding and sealed pins.",
  "Re-obtain authoritative evidence.", "Obtain the original owned tuple.",
]);
const digestMismatch = refusal("destination_digest_mismatch", "destinationDigest", [
  "The supplied digest differs from the verified digest.", "The supplied digest must identify the original document.",
  "Replay the original document and its digest.", "Replay the authentic pair.",
]);
const storedDigest = refusal("destination_digest_mismatch", "documentDigest", [
  "A stored document or address digest failed verification.", "Retained digests must match the original stored evidence.",
  "Replay the original document and its digest.", "Use authorized review to recover the pair, or start a fresh selection where issuance is available.",
]);
const retainedChanged = refusal("destination_version_changed", "destinationDigest", [
  "The supplied binding differs from the recorded binding.", "A retained read requires the original order binding.",
  "Use the binding recorded for the original order.",
  "Take the order's binding from its sealed checkout evidence through the authorized order workflow, then repeat the read; never reselect for a placed order.",
]);
const storedPins = refusal("destination_binding_invalid", "orderBindings", [
  "Stored evidence failed verification.", "The stored binding and pins must match the issued evidence and scope.",
  "Send the retained evidence to the destination owner for review.",
  "After authorized resolution recheck retained evidence, or start a fresh selection where available.",
]);

function expectRefusal(result: unknown, expected: Refusal) {
  expect(Reflect.ownKeys(result as object).sort()).toEqual(["cause", "code", "field", "fix", "observed", "outcome", "recheck"]);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(result).toStrictEqual(expected);
}

function scriptedDestination(...results: unknown[]) {
  const calls: [string, unknown[] | undefined][] = [];
  const port: DestinationPortV2 = createPostgresDestinationPortV2({ query: async (statement, values) => {
    calls.push([statement, values]);
    return { rows: [{ result: results.shift() }] };
  } });
  return { port, calls };
}

it("issues and replays once per call, including omitted and obsolete projections and erased receipts", async () => {
  const fresh = { ...command, validated: projected };
  const obsolete = { ...command, validated: { oldAddress: [null, true, 1.25, " 𐌀 "] } };
  const replay = { ...issued, replayed: true };
  const erased = { evidenceDisposition: "erased" };
  const { port, calls } = scriptedDestination(issued, replay, replay, erased);
  for (const [input, result] of [[fresh, issued], [command, replay], [obsolete, replay], [obsolete, erased]] as const) {
    await expect(port.snapshot(context, input, now)).resolves.toStrictEqual(result);
  }
  expect(calls).toEqual([fresh, command, obsolete, obsolete].map(input => [sql.snapshot, [contextJson, JSON.stringify(input), now]]));
});

it("borrows each supplied reader or writer once with fixed casts and preserves every read kind", async () => {
  const { port, calls } = scriptedDestination(verified, verified, verified, selected);
  const freshWriter = scriptedDestination(binding);
  const replayWriter = scriptedDestination(binding);
  const variants = [["snapshot", snapshotRef], ["order", orderId], ["shipment", shipmentId]] as const;
  for (const [kind, id] of variants) await expect(port.read(context, kind, id, binding)).resolves.toStrictEqual(verified);
  await expect(port.recheck(context, check)).resolves.toStrictEqual(selected);
  await expect(freshWriter.port.registerOrder(context, orderId, check)).resolves.toStrictEqual(binding);
  await expect(replayWriter.port.registerOrder(context, orderId, check)).resolves.toStrictEqual(binding);
  expect(calls).toEqual([
    ...variants.map(([kind, id]) => [sql.read, [contextJson, kind, id, JSON.stringify(binding)]]),
    [sql.recheck, [contextJson, ...checkValues]],
  ]);
  for (const writer of [freshWriter, replayWriter]) {
    expect(writer.calls).toEqual([[sql.registerOrder, [contextJson, orderId, ...checkValues]]]);
  }
});

it("preserves each of the four idempotency refusals, including the two late issuance decisions", async () => {
  const conflicts = [
    "The supplied request digest disagrees with the original command.",
    "The receipt records a different original command.",
    "A receipt already exists for the same scoped key.",
    "The scoped receipt key was occupied during commit.",
  ].map(observed => refusal("destination_idempotency_conflict", "idempotencyKey", [
    observed, "A scoped issuance key must identify one consistent original command and receipt.",
    "Replay the original command or begin a distinct action.", "Use original inputs or a distinct action key.",
  ]));
  const replay = { ...issued, replayed: true };
  const { port, calls } = scriptedDestination(...conflicts, replay);
  const wrongDigest = { ...command, requestDigest: "d".repeat(64) };
  for (const [index, expected] of conflicts.entries()) {
    expectRefusal(await port.snapshot(context, index === 0 ? wrongDigest : command, now), expected);
  }
  await expect(port.snapshot(context, command, now)).resolves.toStrictEqual(replay);
  expect(calls).toEqual([wrongDigest, command, command, command, command]
    .map(input => [sql.snapshot, [contextJson, JSON.stringify(input), now]]));
});

it("keeps owner precedence and accepts corrected evidence on an explicit retry", async () => {
  const callerDefect = { ...binding, schemaVersion: 1 } as unknown as typeof binding;
  const digestDefect = { ...binding, destinationDigest: "0".repeat(64) };
  const badCheck = { ...check, expectedBinding: callerDefect, expectedService: { ...service, carrierRef: "" } };
  const { port, calls } = scriptedDestination(storedDigest, invalidBinding, selected, digestMismatch, verified, retainedChanged, verified, storedPins);
  expectRefusal(await port.recheck(context, badCheck), storedDigest);
  expectRefusal(await port.recheck(context, badCheck), invalidBinding);
  await expect(port.recheck(context, check)).resolves.toStrictEqual(selected);
  expectRefusal(await port.read(context, "snapshot", snapshotRef, digestDefect), digestMismatch);
  await expect(port.read(context, "snapshot", snapshotRef, binding)).resolves.toStrictEqual(verified);
  expectRefusal(await port.read(context, "order", orderId, digestDefect), retainedChanged);
  await expect(port.read(context, "order", orderId, binding)).resolves.toStrictEqual(verified);
  expectRefusal(await port.read(context, "shipment", shipmentId, callerDefect), storedPins);
  expect(calls.map(([, params]) => params)).toEqual([
    [contextJson, "checkout", scopeRef, selectionRevision, JSON.stringify(callerDefect), JSON.stringify(badCheck.expectedService)],
    [contextJson, "checkout", scopeRef, selectionRevision, JSON.stringify(callerDefect), JSON.stringify(badCheck.expectedService)],
    [contextJson, ...checkValues],
    [contextJson, "snapshot", snapshotRef, JSON.stringify(digestDefect)],
    [contextJson, "snapshot", snapshotRef, JSON.stringify(binding)],
    [contextJson, "order", orderId, JSON.stringify(digestDefect)],
    [contextJson, "order", orderId, JSON.stringify(binding)],
    [contextJson, "shipment", shipmentId, JSON.stringify(callerDefect)],
  ]);
});

it("routes invalid cast-bound inputs to SQL NULL and lets the owner choose which defect wins", async () => {
  const badCommand = { ...command, dialect: "unsupported" } as unknown as typeof command;
  const badKind = "invalid\u0000" as "order";
  const badCheck = { ...check, kind: Symbol("invalid"), scopeRef: "invalid", expectedSelectionRevision: "invalid" } as unknown as typeof check;
  const { port, calls } = scriptedDestination(wrongKind, malformed("orderId"), wrongKind, wrongKind, verified);
  expectRefusal(await port.snapshot(context, badCommand, "infinity"), wrongKind);
  expectRefusal(await port.read(context, "order", "invalid", binding), malformed("orderId"));
  expectRefusal(await port.read(context, badKind, "invalid", binding), wrongKind);
  expectRefusal(await port.registerOrder(context, "invalid", badCheck), wrongKind);
  const castableUuid = `{${shipmentId.replaceAll("-", "").toUpperCase()}}`;
  await expect(port.read(context, "shipment", castableUuid, binding)).resolves.toStrictEqual(verified);
  expect(calls).toEqual([
    [sql.snapshot, [contextJson, JSON.stringify(badCommand), null]],
    [sql.read, [contextJson, "order", null, JSON.stringify(binding)]],
    [sql.read, [contextJson, null, null, JSON.stringify(binding)]],
    [sql.registerOrder, [contextJson, null, null, null, null, JSON.stringify(binding), JSON.stringify(service)]],
    [sql.read, [contextJson, "shipment", castableUuid, JSON.stringify(binding)]],
  ]);
});

it("accepts only finite canonical UTC milliseconds in years 0001 through 9999", async () => {
  for (const value of ["0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "2032-02-29T12:34:56.123Z"]) {
    const result = { ...issued, evidenceExpiresAt: value };
    const { port, calls } = scriptedDestination(result);
    await expect(port.snapshot(context, command, value)).resolves.toStrictEqual(result);
    expect(calls[0]?.[1]?.[2]).toBe(value);
  }
  for (const value of ["0000-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", "2030-02-29T00:00:00.000Z",
    "2030-01-01T24:00:00.000Z", "2030-01-01T00:00:00Z", "2030-01-01T00:00:00.000+00:00", `${now}\n`, "infinity"]) {
    const { port, calls } = scriptedDestination(malformed("now"), { ...issued, evidenceExpiresAt: value });
    expectRefusal(await port.snapshot(context, command, value), malformed("now"));
    expect(calls[0]?.[1]?.[2]).toBeNull();
    await expect(port.snapshot(context, command, now)).rejects.toThrow("OPENLUP_E_DESTINATION_INFRASTRUCTURE");
  }
});

it("refuses non-JSON arguments with exact local fields and never evaluates accessors", async () => {
  const { port, calls } = scriptedDestination();
  const cycle: { self?: object } = {};
  cycle.self = cycle;
  let accessed = 0;
  const getter = { get hidden() { accessed++; return "value"; } };
  const hidden = Object.defineProperty({}, "hidden", { value: "value" });
  const sparse = Array(1);
  const arrayExtra = Object.assign([1], { extra: true });
  for (const invalid of [cycle, getter, hidden, { [Symbol()]: 1 }, sparse, arrayExtra, new Date(), NaN, Infinity, -0, 1n,
    () => null, { nested: undefined }, "\u0000", "\uD800", "\uDFFF", { ["bad\u0000key"]: 1 }]) {
    expectRefusal(await port.snapshot(context, { ...command, validated: invalid } as typeof command, now), transportRefusal("command"));
  }
  expectRefusal(await port.read(getter as unknown as typeof context, "order", orderId, binding), transportRefusal("owner"));
  expectRefusal(await port.read(context, "order", orderId, hidden as typeof binding), transportRefusal("destination"));
  expectRefusal(await port.recheck(context, { ...check, expectedBinding: cycle as typeof binding }), transportRefusal("destination"));
  expectRefusal(await port.registerOrder(context, orderId, { ...check, expectedService: { ...service, carrierRef: "\u0000" } }), transportRefusal("selectedDelivery"));
  expectRefusal(await port.recheck(context, getter as unknown as typeof check), transportRefusal("check"));
  expectRefusal(await port.recheck(context, { ...check, ...Object.fromEntries([["extra", undefined]]) }), transportRefusal("check"));
  expect(accessed).toBe(0);
  expect(calls).toEqual([]);
});

it("takes a synchronous snapshot of transparent JSON and preserves every transported key and string", async () => {
  const shared = { text: " \t𐌀é " };
  const validated = Object.assign(Object.create(null), { value: [shared, shared], toJSON: "literal" });
  Object.defineProperty(validated, "__proto__", { value: "literal", enumerable: true });
  const input = { ...command, validated };
  const before = JSON.stringify(input);
  let finish!: (reply: { rows: Record<string, unknown>[] }) => void;
  const values: unknown[][] = [];
  const port = createPostgresDestinationPortV2({ query: (_statement, args) => {
    values.push(args!);
    return new Promise(resolve => { finish = resolve; });
  } });
  const pending = port.snapshot(context, input, now);
  shared.text = "changed";
  finish({ rows: [{ result: issued }] });
  await expect(pending).resolves.toStrictEqual(issued);
  expect(values).toStrictEqual([[contextJson, before, now]]);
});

const infrastructureMessage = [
  "OPENLUP_E_DESTINATION_INFRASTRUCTURE",
  "Observed: The destination operation did not return a usable result.",
  "Cause: The native executor or installed destination contract could not complete the operation.",
  "Fix: Check the native app binding, driver initialization, database connection and TLS, runtime CONNECT, schema USAGE and EXECUTE privileges, and installed migrations.",
  "Recheck: Retry the same operation.",
].join("\n");

async function expectInfrastructure(result: Promise<unknown>, cause?: unknown) {
  const error = await result.catch((failure: unknown) => failure);
  expect(Reflect.ownKeys(error as object).filter(key => key !== "stack").sort()).toEqual(["cause", "message"]);
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  expect((error as Error).message).toBe(infrastructureMessage);
  const descriptor = Object.getOwnPropertyDescriptor(error, "cause");
  expect(descriptor).toMatchObject({ enumerable: false, configurable: true, writable: true });
  if (cause !== undefined) expect(descriptor?.value).toBe(cause);
  expect(JSON.stringify(error)).toBe("{}");
  return error as Error;
}

function expectMalformedCause(error: Error, rowCount: number | null) {
  expect(Reflect.ownKeys(error.cause as object).sort()).toEqual(["reason", "rowCount"]);
  expect(error.cause).toStrictEqual({ reason: "malformed_response", rowCount });
}

it("throws the fixed infrastructure error for executor failures, even if the cause resembles a refusal", async () => {
  for (const cause of [Object.assign(new Error("example driver detail"), { code: "42501" }), malformed("command")]) {
    const port = createPostgresDestinationPortV2({ query: async () => { throw cause; } });
    await expectInfrastructure(port.snapshot(context, command, now), cause);
  }
});

it("decodes success and owner refusals from an executor array subclass with metadata", async () => {
  class DriverRows extends Array<Record<string, unknown>> {
    count = 1;
    command = "SELECT";
    columns = [{ name: "result" }];
  }
  const results = [verified, retainedChanged];
  const port = createPostgresDestinationPortV2({ query: async () => ({ rows: new DriverRows({ result: results.shift() }) }) });
  await expect(port.read(context, "order", orderId, binding)).resolves.toStrictEqual(verified);
  expectRefusal(await port.read(context, "order", orderId, binding), retainedChanged);
});

it("uses the single own data row without invoking an index accessor", async () => {
  let accesses = 0;
  const rows = [{ result: verified }];
  Object.defineProperty(rows, "0", { get() { accesses++; return { result: verified }; } });
  const port = createPostgresDestinationPortV2({ query: async () => ({ rows }) });
  const error = await expectInfrastructure(port.read(context, "order", orderId, binding));
  expect(accesses).toBe(0);
  expectMalformedCause(error, 1);
});

it("keeps malformed read evidence out of the inspected infrastructure error", async () => {
  const response = { rows: [{ result: { ...verified, documentDigest: "invalid" } }] };
  const port = createPostgresDestinationPortV2({ query: async () => response });
  const error = await expectInfrastructure(port.read(context, "order", orderId, binding));
  const inspected = inspect(error, { depth: null });
  expect(inspected).not.toContain(verified.document.address.line1);
  expect(inspected).not.toContain(verified.document.contact.recipientName);
  expectMalformedCause(error, 1);
});

it("rejects malformed rows and expanded refusal or success shapes", async () => {
  const unreadable = { get code() { throw new Error("result getter ran"); } };
  const hidden = Object.defineProperty({ ...wrongKind }, "extra", { value: "hidden" });
  const extendedBinding = { ...binding, ["__proto__"]: "extra" };
  const outcomes = [null, JSON.stringify(issued), { ...wrongKind, code: "future_refusal" }, { ...wrongKind, field: "orderId" },
    { ...wrongKind, recheck: 1 }, { ...wrongKind, extra: true }, hidden, unreadable,
    { evidenceDisposition: "erased", binding }, { evidenceDisposition: "expired" },
    { ...issued, binding: extendedBinding }, { ...issued, binding: { ...binding, schemaVersion: "2" } },
    { ...issued, binding: { ...binding, destinationDigest: "A".repeat(64) } },
    { ...issued, selection: { ...selection, scopeRef: "wrong" } }, { ...issued, replayed: "true" }, { ...issued, eventId: 1 }];
  for (const rows of [[], [{ result: issued }, { result: issued }], [{}], [{ result: issued, extra: true }], ...outcomes.map(result => [{ result }])]) {
    const port = createPostgresDestinationPortV2({ query: async () => ({ rows }) });
    expectMalformedCause(await expectInfrastructure(port.snapshot(context, command, now)), rows.length);
  }
  const invalidRows = { length: 1 } as unknown as Record<string, unknown>[];
  const invalidExecutor = createPostgresDestinationPortV2({ query: async () => ({ rows: invalidRows }) });
  expectMalformedCause(await expectInfrastructure(invalidExecutor.snapshot(context, command, now)), null);
  const readVariants = [
    { ...verified, document: { ...verified.document, revision: 2 } },
    { ...verified, document: { ...verified.document, owner: { ...owner, principalKind: "guest" } } },
    { ...verified, document: { ...verified.document, classificationKeys: [false] } },
    { ...verified, document: { ...verified.document, address: original.address } },
    { ...verified, document: { ...verified.document, contact: { ...contact, unknown: "extra" } } },
    { ...verified, documentDigest: "bad-digest" },
  ];
  for (const result of readVariants) {
    const { port } = scriptedDestination(result);
    await expectInfrastructure(port.read(context, "order", orderId, binding));
  }
});

it("checks UTF-8 policy revision bytes and the owner's space-blank rule", async () => {
  for (const policyRevision of [" ", "", "é".repeat(361), "\uD800", "\u0000"]) {
    const { port } = scriptedDestination({ ...binding, policyRevision });
    await expectInfrastructure(port.registerOrder(context, orderId, check));
  }
  for (const policyRevision of ["é".repeat(360), "\t", " \u00A0 ", "revision"]) {
    const result = { ...binding, policyRevision };
    const { port } = scriptedDestination(result);
    await expect(port.registerOrder(context, orderId, check)).resolves.toStrictEqual(result);
  }
});

it("matches the landed quote ref validator on all six decoded service coordinates", async () => {
  const boundary = [
    "", " \t ", "𐌀", "é".repeat(256), "é".repeat(257), "𐌀".repeat(129), "𐌀".repeat(256), "𐌀".repeat(257),
    "\u0000", "\uD800", "\uDFFF", null, false,
  ];
  for (const key of Object.keys(service) as (keyof typeof service)[]) {
    for (const value of boundary) {
      const result = { ...selected, service: { ...service, [key]: value } };
      const { port } = scriptedDestination(result);
      const decision = port.recheck(context, check);
      if (ref.safeParse(value).success) await expect(decision).resolves.toStrictEqual(result);
      else await expectInfrastructure(decision);
    }
  }
  const { carrierRef: _carrierRef, ...missing } = service;
  for (const malformedService of [missing, { ...service, extra: "extra" }]) {
    const { port } = scriptedDestination({ ...selected, service: malformedService });
    await expectInfrastructure(port.recheck(context, check));
  }
});

const subscriptionCheck = { ...check, kind: "subscription" } as const;
const currentSubscription = { binding, selectionRevision, service };
const recheckedSubscription = { ...selected, selection: { ...selection, kind: "subscription" } };
const verifiedSubscription = { ...verified, ...recheckedSubscription, evidenceExpiresAt: null };

it("binds the three subscription arms with the incumbent casts and only current read uses SQL NULL", async () => {
  const input = malformed("subscriptionId");
  const { port, calls } = scriptedDestination(currentSubscription, verifiedSubscription, recheckedSubscription, input, invalidBinding);
  expect(await port.read(context, "subscription", scopeRef, null)).toStrictEqual(currentSubscription);
  expect(await port.read(context, "subscription", scopeRef, binding)).toStrictEqual(verifiedSubscription);
  expect(await port.recheck(context, subscriptionCheck)).toStrictEqual(recheckedSubscription);
  expectRefusal(await port.read(context, "subscription", "uncastable", null), input);
  expectRefusal(await port.read(context, "snapshot", scopeRef, null as never), invalidBinding);
  expect(calls).toStrictEqual([
    [sql.read, [contextJson, "subscription", scopeRef, null]],
    [sql.read, [contextJson, "subscription", scopeRef, JSON.stringify(binding)]],
    [sql.recheck, [contextJson, "subscription", ...checkValues.slice(1)]],
    [sql.read, [contextJson, "subscription", null, null]],
    [sql.read, [contextJson, "snapshot", scopeRef, "null"]],
  ]);
});

it("accepts the four new refusal pairs only on subscription routing", async () => {
  const decisions = [
    malformed("subscriptionId"),
    refusal("destination_evidence_unavailable", "subscriptionId", [
      "Owned evidence could not be established.", "The operation requires evidence in the authenticated owner scope.",
      "Re-obtain evidence through the authenticated owner.", "Repeat the authorized subscription lookup.",
    ]),
    refusal("destination_v2_selection_required", "subscriptionId", [
      "There is no current authorized selection.", "A retained subscription read requires an issued selection.",
      "Recover through direct address selection on a qualified edit rail.", "Verify the successful selection with the authorized read.",
    ]),
    refusal("destination_version_changed", "selectedDelivery", [
      "The current subscription destination coordinates differ.", "The operation requires the current subscription destination coordinates.",
      "Read the current subscription destination with commerce_read_destination_v2 and a null expected binding.",
      "Repeat the operation with the verified current binding and pins.",
    ]),
  ];
  for (const decision of decisions) {
    const { port } = scriptedDestination(...Array(9).fill(decision), { ...decision, extra: true }, { ...decision, field: "expectedTemplateVersion" });
    expectRefusal(await port.read(context, "subscription", scopeRef, null), decision);
    expectRefusal(await port.read(context, "subscription", scopeRef, binding), decision);
    expectRefusal(await port.recheck(context, subscriptionCheck), decision);
    for (const kind of ["snapshot", "order", "shipment"] as const) await expectInfrastructure(port.read(context, kind, scopeRef, binding));
    await expectInfrastructure(port.recheck(context, check));
    await expectInfrastructure(port.snapshot(context, command, now));
    await expectInfrastructure(port.registerOrder(context, orderId, subscriptionCheck as never));
    await expectInfrastructure(port.recheck(context, subscriptionCheck));
    await expectInfrastructure(port.recheck(context, subscriptionCheck));
  }
});

it("decodes only the closed subscription result shapes and preserves the service domain", async () => {
  const doc = verifiedSubscription.document;
  for (const output of [
    currentSubscription, { ...verifiedSubscription, evidenceExpiresAt }, { ...verifiedSubscription, evidenceExpiresAt: undefined },
    { ...verifiedSubscription, extra: true }, { ...verifiedSubscription, binding: { ...binding, extra: true } },
    { ...verifiedSubscription, selection }, { ...verifiedSubscription, selection: { ...recheckedSubscription.selection, extra: true } },
    { ...verifiedSubscription, service: { ...service, extra: true } }, { ...verifiedSubscription, document: { ...doc, extra: true } },
    { ...verifiedSubscription, document: { ...doc, classificationKeys: [{ extra: true }] } },
    ...(["owner", "address", "contact"] as const).map(key => ({ ...verifiedSubscription, document: { ...doc, [key]: { ...doc[key], extra: true } } })),
  ]) await expectInfrastructure(scriptedDestination(output).port.read(context, "subscription", scopeRef, binding));
  await expectInfrastructure(scriptedDestination(verifiedSubscription).port.read(context, "subscription", scopeRef, null));
  await expectInfrastructure(scriptedDestination({ ...currentSubscription, extra: true }).port.read(context, "subscription", scopeRef, null));
  await expectInfrastructure(scriptedDestination(verifiedSubscription).port.recheck(context, subscriptionCheck));
  await expectInfrastructure(scriptedDestination(selected).port.recheck(context, subscriptionCheck));
  const { port, calls } = scriptedDestination();
  expectRefusal(await port.recheck(context, { ...subscriptionCheck, extra: true } as typeof subscriptionCheck), transportRefusal("check"));
  expect(calls).toEqual([]);
  for (const key of Object.keys(service)) {
    const valid = { ...recheckedSubscription, service: { ...service, [key]: "😀".repeat(256) } };
    const invalid = { ...valid, service: { ...service, [key]: "😀".repeat(257) } };
    const { port } = scriptedDestination(valid, invalid);
    expect(await port.recheck(context, subscriptionCheck)).toStrictEqual(valid);
    await expectInfrastructure(port.recheck(context, subscriptionCheck));
  }
});
