import { createHash } from "node:crypto";
import { expect, expectTypeOf, it } from "vitest";
import { createCapturedFulfillmentAdapter, runFulfillmentAdapterConformance as run } from "../../src/fulfillment/testing/index.js";
import type { FulfillmentAdapterTestSubject } from "../../src/fulfillment/testing/index.js";
import type { FulfillmentAdapterConformanceSubject } from "../../src/fulfillment/contracts/index.js";
import { FULFILLMENT_REFUSAL_REASONS } from "../../src/fulfillment/contracts/dispatch.js";
import { isCapturedFulfillmentAdapter } from "../../src/fulfillment/capturedAdapter.js";
import { refusal } from "../../src/fulfillment/conformanceSchema.js";
import { request } from "./fixtures.js";

it("types every sync slot with mutually exclusive success and failure roles", () => {
  type Kit = NonNullable<FulfillmentAdapterTestSubject["certification"]>;
  type Row = NonNullable<Kit["stockSync"]>[number] | NonNullable<Kit["productSync"]>[number];
  type AcceptsMixed<R extends Row> = R extends Row ? {
    input: R["success"]["input"]; expected: R["success"]["expected"]; throws: R["failure"]["throws"];
  } extends R["success"] | R["failure"] ? true : false : never;
  expectTypeOf<AcceptsMixed<Row>>().toEqualTypeOf<false>();
  expectTypeOf<Row["success"]>().not.toExtend<Row["failure"]>();
  expectTypeOf<Row["failure"]>().not.toExtend<Row["success"]>();
  type Ensure = Extract<NonNullable<Kit["productSync"]>[number], { operation: "ensureProduct" }>;
  expectTypeOf<Ensure["success"]["expected"]["replayed"]>().toEqualTypeOf<false>();
  expectTypeOf<NonNullable<Kit["paging"]>["failure"]["expected"]["kind"]>().toEqualTypeOf<"failed">();
  expectTypeOf<NonNullable<Kit["paging"]>["exhausted"]["expected"]["kind"]>().toEqualTypeOf<"page_exhausted">();
  type Void = NonNullable<NonNullable<FulfillmentAdapterTestSubject["fixtures"]["label"]>["void"]>[number]["expected"];
  expectTypeOf<{ canProceed: true; providerDeletion: "unconfirmed"; labelDeleted: false; refusal: { reason: "unsupported"; phase: "dispatch"; retryable: false } }>().not.toExtend<Void>();
  expectTypeOf<Extract<Void, { canProceed: true }>["refusal"]>().toEqualTypeOf<undefined>();
});

function capturedSubject(): Omit<FulfillmentAdapterTestSubject, "fixtures"> & Pick<FulfillmentAdapterConformanceSubject, "fixtures"> {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
      : JSON.stringify(value) ?? "null";
  const captures = ["accepted", "unknown", "not_dispatched"].map((kind, index) => ({ request: { ...request(), requestKey: `request-${index}` },
    outcome: kind === "accepted" ? { kind: "accepted" as const, externalRef: "external-a" } : { kind: kind as "unknown" | "not_dispatched" } }));
  const adapter = createCapturedFulfillmentAdapter({ providerRef: "warehouse-a", selected: true, captures });
  return { subjectId: "captured-dispatch", adapter, readIoCount: adapter.readSubmissionCount, sensitiveValues: ["Example"], certification: { profile: "dispatch-only" },
    fixtures: { dispatch: [...captures.map(capture => {
      const commandFingerprint = createHash("sha256").update(canonical(capture.request)).digest("hex");
      const evidence = { commandFingerprint, contactRevision: capture.request.contactRevision, providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a" };
      return { input: capture.request, expectedPrepare: { kind: "prepared" as const, evidence }, replay: true,
        expectedDispatch: capture.outcome.kind === "accepted" ? { kind: "accepted" as const, externalRef: "external-a", evidence,
          providerAttemptKey: `captured-attempt:${commandFingerprint}`, labelKey: `captured-receipt:${commandFingerprint}` }
          : capture.outcome.kind === "unknown" ? { kind: "unknown" as const, effectMayHaveSucceeded: true as const, refusal: { reason: "io_failure" as const, phase: "dispatch" as const, retryable: true } }
            : { kind: "not_dispatched" as const, effectMayHaveSucceeded: false as const, refusal: { reason: "not_dispatchable" as const, phase: "dispatch" as const, retryable: false } } };
    }), { input: { ...request(), lines: [] }, expectedPrepare: { kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } } }] } };
}

it("qualifies the captured adapter only for its dispatch profile, including unknown replay", async () => {
  const result = await run([capturedSubject()], { mode: "full" });
  expect(result.cases.at(-1)?.operation).toBe("full:dispatch-only (no other capability certified)");
  expect(result.cases.some(row => row.operation.includes("paging"))).toBe(false);
});

it("retains baseline callers and fails full qualification on omitted fixtures or an inflated profile", async () => {
  const baseline = capturedSubject(); delete baseline.certification;
  await expect(run([baseline])).resolves.toHaveProperty("subjects");
  await expect(run([baseline], { mode: "full" })).rejects.toThrow("full certification fixtures required");
  await expect(run([], { mode: "full" })).rejects.toThrow("full subjects required");
  const missing = capturedSubject(); missing.fixtures.dispatch = missing.fixtures.dispatch.filter(row => row.expectedDispatch?.kind !== "unknown");
  await expect(run([missing], { mode: "full" })).rejects.toThrow("unknown replay required");
  const inflated = capturedSubject();
  expect(() => { inflated.adapter.capabilities.operations = { ...inflated.adapter.capabilities.operations, pickupPoint: { supported: true } }; }).toThrow(TypeError);
  inflated.adapter = { ...inflated.adapter, capabilities: { ...inflated.adapter.capabilities, operations: { ...inflated.adapter.capabilities.operations, pickupPoint: { supported: true } } } };
  await expect(run([inflated], { mode: "full" })).rejects.toThrow("capability_not_certifiable:dispatch-only brand");
});

it("rejects unknown replay declared on a preparation refusal instead of an executed replay", async () => {
  const subject = capturedSubject(), rows = subject.fixtures.dispatch;
  const unknown = rows.find(row => row.expectedDispatch?.kind === "unknown")!;
  subject.fixtures.dispatch = rows.map(row => row.expectedPrepare.kind === "refused"
    ? { ...row, expectedDispatch: unknown.expectedDispatch, replay: true }
    : { ...row, replay: row === unknown ? false : row.replay });
  await expect(run([subject], { mode: "full" })).rejects.toThrow("refused preparation cannot declare dispatch or replay");
});

it("rejects a dispatch-only adapter that refuses every preparation despite declared dispatch outcomes", async () => {
  const subject = capturedSubject();
  const refused = { kind: "refused" as const, refusal: { reason: "not_dispatchable" as const, phase: "prepare" as const, retryable: false } };
  subject.fixtures.dispatch = subject.fixtures.dispatch.map(row => ({ ...row, expectedPrepare: refused }));
  await expect(run([subject], { mode: "full" })).rejects.toThrow("refused preparation cannot declare dispatch or replay");
});

it.each(["baseline", "full"] as const)("rejects unreachable dispatch expectations and replay flags in %s mode", async mode => {
  for (const declaration of ["expectedDispatch", "replay"] as const) {
    const subject = capturedSubject(), rows = subject.fixtures.dispatch;
    subject.fixtures.dispatch = rows.map(row => row.expectedPrepare.kind === "refused"
      ? { ...row, ...(declaration === "expectedDispatch" ? { expectedDispatch: rows[0]!.expectedDispatch } : { replay: true }) } : row);
    await expect(run([subject], { mode })).rejects.toThrow("refused preparation cannot declare dispatch or replay");
  }
});

it("requires an executed unknown replay even when unknown dispatch itself was compared", async () => {
  const subject = capturedSubject();
  subject.fixtures.dispatch = subject.fixtures.dispatch.map(row => row.expectedPrepare.kind === "refused" ? row : ({ ...row, replay: row.expectedDispatch?.kind === "unknown" ? false : row.replay }));
  await expect(run([subject], { mode: "full" })).rejects.toThrow("full unknown replay required");
});

it.each(["unknown", "not_dispatched"] as const)("rejects a %s discriminant with a contradictory effect flag", async kind => {
  const subject = capturedSubject(), dispatch = subject.adapter.dispatch.dispatch;
  const row = subject.fixtures.dispatch.find(row => row.expectedDispatch?.kind === kind)!;
  Object.assign(row.expectedDispatch!, { effectMayHaveSucceeded: kind !== "unknown" });
  subject.adapter = { ...subject.adapter, dispatch: { ...subject.adapter.dispatch, dispatch: async (...input) => {
    const result = await dispatch(...input);
    return result.kind === kind && !input[1].commandFingerprint.endsWith(":mismatch")
      ? Object.assign(result, { effectMayHaveSucceeded: kind !== "unknown" }) : result;
  } } };
  await expect(run([subject], { mode: "full" })).rejects.toThrow("validation:fixtures");
});

it("audit 14 refuses non-array and empty subjects and records mode, profile, capabilities and its ledger", async () => {
  for (const value of [[], { length: 1, *[Symbol.iterator]() {} }]) await expect(run(value as FulfillmentAdapterTestSubject[], { mode: "full" })).rejects.toThrow("full subjects required");
  const forged = Object.assign([capturedSubject()], { map: () => [] });
  await expect(run(forged, { mode: "full" })).rejects.toThrow("validation:subjects");
  const proof = await run([capturedSubject()], { mode: "full" });
  expect(proof.mode).toBe("full"); expect(proof.qualifications[0]).toMatchObject({ profile: "dispatch-only", capabilityDigest: expect.stringMatching(/^[a-f0-9]{64}$/), declarations: [{ capability: "courierPickup", declared: "unsupported", probe: "no_port" }] });
  expect(proof.qualifications[0]!.ledger.some(row => row.capability === "dispatch" && row.role === "success")).toBe(true);
});
it("audit 6 snapshots options once and rejects hidden or accessor capability data", async () => {
  const options = { get mode() { return "full" as const; } };
  await expect(run([capturedSubject()], options)).rejects.toThrow("validation:uncloneable_data");
  const value = capturedSubject(); value.adapter = { ...value.adapter, capabilities: structuredClone(value.adapter.capabilities) };
  Object.defineProperty(value.adapter.capabilities.operations, "labelCreate", { enumerable: false, value: { supported: true } });
  await expect(run([value], { mode: "full" })).rejects.toThrow("validation:uncloneable_data");
});
it("audit 9 refuses a dispatch-only profile without the captured adapter brand", async () => {
  const value = capturedSubject(); value.adapter = { ...value.adapter };
  await expect(run([value], { mode: "full" })).rejects.toThrow("capability_not_certifiable:dispatch-only brand");
});

it.each(["port", "prepare", "dispatch"] as const)("binds audit 9's brand to the frozen original %s and refuses swapped qualification", async slot => {
  const value = capturedSubject(), adapter = value.adapter, port = adapter.dispatch;
  const replacement = { ...port, prepare: port.prepare.bind(port), dispatch: port.dispatch.bind(port) };
  expect(Reflect.set(slot === "port" ? adapter : port, slot === "port" ? "dispatch" : slot, slot === "port" ? replacement : replacement[slot])).toBe(false);
  expect(isCapturedFulfillmentAdapter(adapter, port, port.prepare, port.dispatch)).toBe(true);
  expect(isCapturedFulfillmentAdapter(adapter, slot === "port" ? replacement : port, slot === "prepare" ? replacement.prepare : port.prepare, slot === "dispatch" ? replacement.dispatch : port.dispatch)).toBe(false);
  for (const object of [adapter, port, port.prepare, port.dispatch, adapter.capabilities, adapter.capabilities.operations.dispatch]) expect(Object.isFrozen(object)).toBe(true);
  value.adapter = { ...adapter, dispatch: slot === "port" ? replacement : { ...port, [slot]: replacement[slot] } };
  await expect(run([value], { mode: "full" })).rejects.toThrow("capability_not_certifiable:dispatch-only brand");
  delete value.certification!.profile;
  await expect(run([value], { mode: "full" })).rejects.toThrow("full unsupported labelCreate refusal probe required");
});

it("derives every refusal fixture reason from the dispatch contract tuple", () => {
  expect(Object.isFrozen(FULFILLMENT_REFUSAL_REASONS)).toBe(true);
  for (const reason of FULFILLMENT_REFUSAL_REASONS) expect(refusal.parse({ reason, phase: "prepare", retryable: false }).reason).toBe(reason);
  expect(refusal.safeParse({ reason: "invented", phase: "prepare", retryable: false }).success).toBe(false);
});

it("types testing dispatch fixtures as exclusive refused-preparation and prepared-dispatch roles", () => {
  type Row = FulfillmentAdapterTestSubject["fixtures"]["dispatch"][number];
  type Input = Row["input"];
  type Prepared = Extract<Awaited<ReturnType<FulfillmentAdapterTestSubject["adapter"]["dispatch"]["prepare"]>>, { kind: "prepared" }>;
  type Refused = Extract<Awaited<ReturnType<FulfillmentAdapterTestSubject["adapter"]["dispatch"]["prepare"]>>, { kind: "refused" }>;
  expectTypeOf<{ input: Input; expectedPrepare: Prepared }>().not.toExtend<Row>();
  expectTypeOf<{ input: Input; expectedPrepare: Refused; replay: true }>().not.toExtend<Row>();
  expectTypeOf<{ input: Input; expectedPrepare: Refused; expectedDispatch: NonNullable<Row["expectedDispatch"]> }>().not.toExtend<Row>();
  expectTypeOf<{ input: Input; expectedPrepare: Refused }>().toExtend<Row>();
  expectTypeOf<FulfillmentAdapterConformanceSubject["fixtures"]>().not.toExtend<FulfillmentAdapterTestSubject["fixtures"]>();
});
