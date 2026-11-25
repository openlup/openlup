import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor } from "@openlup/platform/data";
import { beginTaxCalculation, completeTaxCalculation, evaluationDigest, localRateTable, makeTaxQuoteRequest,
  type TaxCalculationTransactionLane } from "@openlup/platform/tax";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { beginSql, bindEditedSeal, completeSql, contaminate, exclusiveKind, expectError, fiscalKind, fixture, invoke,
  mutate, paths, rejected, rollback, rowFor, seal, terminalRoutine, type Begin, type Completion, type Fixture,
  type JsonPath } from "./commerceQuoteV2StorageFixture.js";

type ClaimInput = Extract<Parameters<typeof beginTaxCalculation>[1], { operation: "claim" }>;
type CompleteInput = Exclude<Parameters<typeof completeTaxCalculation>[1], Uint8Array>;
type Adapter = CompleteInput["adapter"];
type SqlCompletion = Omit<Completion, "seal"> & { seal: Omit<Completion["seal"], "evidence"> & { evidence: object } };
const bytes = (input: unknown) => new TextEncoder().encode(JSON.stringify(input));
const documented = "Supply the documented input.";

function expectRefusal(value: unknown, field: string, code = "tax_invalid_input", remedy = documented) {
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Reflect.ownKeys(value as object).filter(key => key !== "stack").sort()).toStrictEqual(["code", "field", "kind", "remedy"]);
  expect(value).toStrictEqual({ kind: "refused", code, field, remedy });
  expect((value as { message?: unknown }).message).toBeUndefined();
}

function wrappedClaim(data: Fixture, input: Begin): ClaimInput {
  const { requestDigest: _requestDigest, ...pin } = input.pin;
  const request = pin.kind === exclusiveKind ? makeTaxQuoteRequest(input.identity.evaluationKey, data.fullInput) : pin.request;
  return { ...input, pin: { ...pin, request } } as ClaimInput;
}

function wrappedSeal(input: SqlCompletion, adapter?: Adapter): CompleteInput {
  const { operation: _operation, seal: sql, ...common } = input;
  const { disposition: _disposition, evidence: wireEvidence, ...rest } = sql;
  const { compositionDigest, ...evidence } = wireEvidence as { compositionDigest?: string };
  return { ...common, seal: { ...rest, evidence, ...(compositionDigest === undefined ? {} : { compositionDigest }) },
    ...(adapter ? { adapter } : {}) } as CompleteInput;
}

function capture() {
  const requests: Array<Record<string, unknown>> = [];
  const lane: TaxCalculationTransactionLane = { run: work => work({
    async query(_statement, parameters) {
      if (parameters) requests.push(JSON.parse(String(parameters[0])));
      return { rows: [{ result: { kind: "missing" } }] };
    },
  }) };
  return { lane, requests };
}

describe("native composition wrapper wire", () => {
  const resources = storeJourneyResources();
  let store: JourneyInstallation;
  beforeAll(async () => { store = await resources.installation("quote-composition-wire"); }, postgresSetupTimeoutMs);
  afterAll(() => resources.close(), postgresTeardownTimeoutMs);
  const runtimeLane = () => createPostgresRoleFreeTransactionLane<PgQueryExecutor>({ connectionString: store.runtimeUrl }, { pool: store.runtime });
  const fieldFor = async (pin: unknown, submission: unknown = null) => (await store.owner.query<{ value: string | null }>(
    `SELECT public.tax_calculation_check_domain_v1(
      '{"lines":[{"sku":"item"}],"deliverySelector":"delivery","paymentSelector":"payment"}'::jsonb,$1::jsonb,$2::jsonb,$3) AS value`,
    [JSON.stringify(pin), JSON.stringify(submission), submission === null ? false : null],
  )).rows[0]!.value;

  it.each([fiscalKind, exclusiveKind] as const)("forwards the exact %s pin and rebuilds the exact seal before replay", async kind => {
    const value = await fixture(store);
    const input = value.begin(kind, true);
    const lane = runtimeLane();
    const wrapper = wrappedClaim(value, input);
    const capturedClaim = capture();
    expect(await beginTaxCalculation(capturedClaim.lane, wrapper)).toStrictEqual({ kind: "missing" });
    expect(capturedClaim.requests).toStrictEqual([input]);
    const grant = await beginTaxCalculation(lane, wrapper);
    expect(grant.kind).toBe("claimed");
    if (grant.kind !== "claimed") throw new Error("Expected a claim");
    expect(grant.pin.composition).toStrictEqual(input.pin.composition);

    const original = seal(value, input, grant);
    let sql: SqlCompletion = original;
    let adapter: Adapter;
    if (kind === exclusiveKind) {
      const request = makeTaxQuoteRequest(input.identity.evaluationKey, value.fullInput);
      const { scope, market, currency, taxDate } = request.input;
      const { jurisdiction, taxKind } = request.input.required[0]!;
      const effective = { from: taxDate };
      const result = await localRateTable({ scope, market, currency, now: () => new Date().toISOString(),
        calculationLifetimeMs: 120_000, validityWindowMs: 2_000, rounding: "half_up_largest_remainder",
        rules: [{ kind: "rate", jurisdiction, taxKind, taxClass: request.input.lines[0]!.taxClass,
          ruleRef: "rule-a", legalBasisRef: "rulebook-a", effective, ratePercent: "0" }],
        registrations: [{ state: "active", jurisdiction, taxKind, evidenceRef: "registration-a", effective }],
      }).quote(request);
      if (result.kind !== "final") throw new Error("Expected a verified final adapter result: " + JSON.stringify(result));
      adapter = { request, result };
      const validUntil = result.evidence.expiresAt;
      const withValidity = { ...original, seal: { ...original.seal, validUntil,
        outcome: { ...original.seal.outcome, quote: { ...original.seal.outcome.quote,
        taxEvidence: { ...original.seal.outcome.quote.taxEvidence, expiresAt: validUntil },
      } } } };
      sql = bindEditedSeal(withValidity, grant, { ...original.seal.evidence, adapterEvidence: result.evidence, adapterDigest: result.evidenceDigest });
    }
    const command = wrappedSeal(sql, adapter);
    const captured = capture();
    expect(await completeTaxCalculation(captured.lane, command)).toStrictEqual({ kind: "missing" });
    expect(captured.requests).toStrictEqual([sql]);
    expect(await fieldFor({ ...input.pin, ...grant.pin }, sql.seal)).toBeNull();
    expect(sql.seal.outcome.quote.paymentLimits.revision).toBe("42");
    expect(await completeTaxCalculation(lane, bytes(command))).toStrictEqual({
      kind: "terminal", outcome: sql.seal.outcome, freshness: "current", validUntil: sql.seal.validUntil,
    });
    const rows = await rowFor(store, input);
    expect(rows).toHaveLength(1);
    expect(await invoke(store.runtime, completeSql, sql)).toStrictEqual({
      kind: "terminal", outcome: sql.seal.outcome, validUntil: sql.seal.validUntil,
    });
    expect(await rowFor(store, input)).toStrictEqual(rows);
  });

  it.each([fiscalKind, exclusiveKind] as const)("enforces closure of every new %s composition object and array element in both layers", async kind => {
    const value = await fixture(store);
    const input = value.begin(kind, true);
    const wrapper = wrappedClaim(value, input);
    const { lane, requests } = capture();
    const root = ["pin", "composition"];
    const composition = input.pin.composition!;
    expect(await fieldFor(input.pin)).toBeNull();
    for (const target of paths(composition).filter(node => node.object)) {
      const field = "/" + [...root, ...target.path].join("/");
      for (const key of ["contactEmail", "line1"]) {
        expectRefusal(await beginTaxCalculation(lane, bytes(contaminate(wrapper, root, target, key))), field);
        expect(await fieldFor(contaminate(input, root, target, key).pin), field).toBe("/pin");
      }
    }
    const { fiscal, ...other } = composition;
    const invalidArm = kind === fiscalKind ? other : {
      ...other, fiscal: value.begin(fiscalKind, true).pin.composition!.fiscal,
    };
    const field = "/pin/composition" + (kind === fiscalKind ? "/fiscal" : "");
    expectRefusal(await beginTaxCalculation(lane, bytes({ ...wrapper, pin: { ...wrapper.pin, composition: invalidArm } })), field);
    expect(await fieldFor({ ...input.pin, composition: invalidArm })).toBe("/pin");
    expectRefusal(await beginTaxCalculation(lane, bytes({ ...wrapper, pin: { ...wrapper.pin, composition: null } })), "/pin/composition");
    expect(await fieldFor({ ...input.pin, composition: null })).toBe("/pin");
    expect(fiscal === undefined).toBe(kind === exclusiveKind);
    expect(requests).toStrictEqual([]);
    expect(await rowFor(store, input)).toStrictEqual([]);
  });

  it("admits exact pricing variants and enums and witnesses the narrower TypeScript domains", async () => {
    const value = await fixture(store);
    const input = value.begin(fiscalKind, true);
    const wrapper = wrappedClaim(value, input);
    const { lane, requests } = capture();
    const composition = input.pin.composition!;
    const baseline = composition.planInput.baseline;
    const adjustment = composition.planInput.selected!.adjustments[0]!;
    const root = ["pin", "composition"];
    const patch = <T,>(rootValue: T, path: JsonPath, value: unknown): T => {
      const copy = JSON.parse(JSON.stringify(rootValue)) as T;
      const parent = path.slice(0, -1).reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], copy);
      (parent as Record<string | number, unknown>)[path.at(-1)!] = value;
      return copy;
    };
    const count = <T,>(n: number, row: (i: number) => T) => Array.from({ length: n }, (_, i) => row(i));
    const line = composition.planInput.lines[0]!;
    const delivery = baseline.delivery[0]!;
    const fee = baseline.feeLines[0]!;
    const accepted: [JsonPath, unknown][] = [
      [["planInput", "engine"], "promotion-engine.v2"], [["planInput", "listBasis"], null],
      [["planInput", "listBasis"], "exclusive"], [["planInput", "baseline", "amountBasis"], "exclusive"],
      [["planInput", "lines", 0, "mode"], "one_time"], [["planInput", "lines", 0, "amountKind"], "net"],
      [["planInput", "baseline", "delivery", 0, "kind"], "handling"], [["limits", "mode"], "live"],
      [["planInput", "baseline", "feeLines", 0, "scope"], { kind: "order" }],
      [["planInput", "selected", "adjustments", 0], { ...adjustment, appliesTo: "order_total" }],
      [["planInput", "lines", 0, "quantity"], 99], [["planInput", "lines", 0, "unitBasisMinor"], 2_147_483_647],
      [["planInput", "lines"], count(50, i => ({ ...line, lineKey: "line-" + i, sourceOrdinal: i + 1 }))],
      [["planInput", "baseline", "delivery"], count(256, i => ({ ...delivery, bucketKey: "bucket-" + i }))],
      [["planInput", "baseline", "feeLines"], count(256, i => ({ ...fee, feeKey: "fee-" + i }))],
      [["planInput", "selected", "adjustments"], count(20, i => ({ ...adjustment, adjustmentRef: "adjustment-" + i }))],
      [["planInput", "selected", "adjustments", 0, "target", "lineKeys"], count(50, i => "item-" + i)],
    ];
    for (const [path, leaf] of accepted) {
      const result = patch(wrapper, [...root, ...path], leaf);
      expect(await beginTaxCalculation(lane, bytes(result)), path.join("/")).toStrictEqual({ kind: "missing" });
      expect(requests.pop()).toStrictEqual(patch(input, [...root, ...path], leaf));
    }

    const narrower: [JsonPath, unknown, JsonPath?][] = [
      [["planInput", "engine"], "unknown"], [["planInput", "listBasis"], "other"],
      [["planInput", "baseline", "amountBasis"], "other"], [["planInput", "selected", "amountBasis"], "other"],
      [["planInput", "lines", 0, "mode"], "other"], [["planInput", "lines", 0, "amountKind"], "other"],
      [["planInput", "baseline", "delivery", 0, "kind"], "other"],
      [["planInput", "baseline", "feeLines", 0, "scope"], { kind: "other" }, ["kind"]],
      [["planInput", "baseline", "feeLines", 0, "scope"], { kind: "order", bucketKey: delivery.bucketKey }, []],
      [["planInput", "baseline", "feeLines", 0, "scope"], { kind: "delivery" }, ["bucketKey"]],
      [["planInput", "selected", "adjustments", 0, "appliesTo"], "other"],
      [["planInput", "selected", "adjustments", 0, "target"], { lineKeys: [line.lineKey], bucketKey: delivery.bucketKey }, []],
      [["planInput", "selected", "adjustments", 1, "target"], { lineKeys: [line.lineKey], bucketKey: delivery.bucketKey }, []],
      [["planInput", "selected", "adjustments", 0, "target"], {}, ["lineKeys"]],
      [["planInput", "selected", "adjustments", 1, "target"], {}, ["bucketKey"]],
      [["planInput", "lines", 0, "quantity"], 0], [["planInput", "lines", 0, "quantity"], 100],
      [["planInput", "lines", 0, "quantity"], 1.5], [["planInput", "lines", 0, "unitBasisMinor"], 2_147_483_648],
      [["planInput", "lines"], []],
      [["planInput", "lines"], count(51, i => ({ ...line, lineKey: "line-" + i, sourceOrdinal: i + 1 }))],
      [["planInput", "lines"], [line, { ...line, sourceOrdinal: 2 }], [1, "lineKey"]],
      [["planInput", "lines"], [line, { ...line, lineKey: "line-b" }], [1, "sourceOrdinal"]],
      [["planInput", "baseline", "delivery"], count(257, i => ({ ...delivery, bucketKey: "bucket-" + i }))],
      [["planInput", "baseline", "delivery"], [delivery, delivery], [1, "bucketKey"]],
      [["planInput", "baseline", "feeLines"], count(257, i => ({ ...fee, feeKey: "fee-" + i }))],
      [["planInput", "baseline", "feeLines"], [fee, fee], [1, "feeKey"]],
      [["planInput", "selected", "adjustments"], []],
      [["planInput", "selected", "adjustments"], count(21, i => ({ ...adjustment, adjustmentRef: "adjustment-" + i }))],
      [["planInput", "selected", "adjustments"], [adjustment, adjustment], [1, "adjustmentRef"]],
      [["planInput", "selected", "adjustments", 0, "target", "lineKeys"], []],
      [["planInput", "selected", "adjustments", 0, "target", "lineKeys"], count(51, i => "item-" + i)],
    ];
    for (const [path, leaf, suffix = []] of narrower) {
      const target = [...root, ...path];
      const expected = "/" + [...target, ...suffix].join("/");
      expectRefusal(await beginTaxCalculation(lane, bytes(patch(wrapper, target, leaf))), expected);
      expect(await fieldFor(patch(input, target, leaf).pin), expected).toBeNull();
    }

    const shared: [JsonPath, unknown, unknown][] = [
      [["catalogueEvidenceRef"], "😀".repeat(256), "😀".repeat(257)],
      [["planInput", "lines", 0, "lineKey"], "😀".repeat(64), "😀".repeat(64) + "x"],
      [["limits", "profileRef"], "😀".repeat(50), "😀".repeat(50) + "x"],
      [["limits", "revision"], 1, 0], [["limits", "revision"], 2_147_483_647, 2_147_483_648],
      [["limits", "revision"], 42, "42"], [["limits", "revision"], 42, 1.1],
      [["limits", "effective", "minMinor"], 0, -1], [["limits", "effective", "maxMinor"], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1],
      [["fiscal", "facts", "vatRateBps"], 0, -1], [["fiscal", "facts", "vatRateBps"], 10_000, 10_001],
      [["fiscal", "facts", "country"], "XA", "xA"], [["limits", "mode"], "test", "other"],
      [["planInput", "currency"], "XXX", "xxx"], [["planInput", "price", "priceContextDigest"], "a".repeat(64), "A".repeat(64)],
      [["selection", "kind"], "checkout", "other"],
      [["selection", "selectionRevision"], "aaaaaaaa-0000-0000-0000-000000000000", "AAAAAAAA-0000-0000-0000-000000000000"],
      [["evidenceExpiresAt"], "0001-01-01T00:00:00.000Z", "0000-01-01T00:00:00.000Z"],
      [["evidenceExpiresAt"], "9999-12-31T23:59:59.999Z", "2026-02-30T00:00:00.000Z"],
    ];
    for (const [path, valid, invalid] of shared) {
      const target = [...root, ...path];
      const expected = "/" + target.join("/");
      expect(await beginTaxCalculation(lane, bytes(patch(wrapper, target, valid))), expected).toStrictEqual({ kind: "missing" });
      expect(await fieldFor(patch(input, target, valid).pin), expected).toBeNull();
      expect(requests.pop()).toStrictEqual(patch(input, target, valid));
      expectRefusal(await beginTaxCalculation(lane, bytes(patch(wrapper, target, invalid))), expected);
      expect(await fieldFor(patch(input, target, invalid).pin), expected).toBe("/pin");
    }
    expect(requests).toStrictEqual([]);
  });

  it("closes fiscal success evidence and restricts the wrapper digest to success", async () => {
    const value = await fixture(store);
    const input = value.begin(fiscalKind, true);
    const grant = await invoke<Parameters<typeof seal>[2]>(store.runtime, beginSql, input);
    const sql = seal(value, input, grant);
    const wrapper = wrappedSeal(sql);
    const { lane, requests } = capture();
    for (const target of paths(sql.seal.evidence).filter(node => node.object)) {
      for (const key of ["contactEmail", "line1"]) {
        const root = ["seal", "evidence"];
        expectRefusal(await completeTaxCalculation(lane, bytes(contaminate(wrapper, root, target, key))), "/seal");
        expect(await fieldFor(input.pin, contaminate(sql, root, target, key).seal)).toBe("/seal");
      }
    }
    for (const change of [{ coverage: { kind: "other" } }, { posting: "required" }, { policyRevision: "A".repeat(64) }]) {
      const evidence = { ...(wrapper.seal.evidence as object), ...change };
      expectRefusal(await completeTaxCalculation(lane, bytes({ ...wrapper, seal: { ...wrapper.seal, evidence } })), "/seal");
    }
    for (const outcome of [
      { kind: "indeterminate" }, { kind: "unavailable", code: "tax_adapter_unavailable" },
      { kind: "refused", code: "tax_calculation_expired", field: "/taxEvidence/expiresAt", remedy: "Select the destination again and obtain a fresh quote." },
    ]) expectRefusal(await completeTaxCalculation(lane, bytes({ ...wrapper, seal: { ...wrapper.seal, outcome } })), "/seal");
    const rootDigest = { ...sql, seal: { ...sql.seal, compositionDigest: wrapper.seal.compositionDigest } };
    expect(await fieldFor(input.pin, rootDigest.seal)).toBe("/seal");
    const { compositionDigest: _digest, ...legacy } = wrapper.seal;
    const misplaced = { ...wrapper, seal: { ...legacy, evidence: sql.seal.evidence } };
    expectRefusal(await completeTaxCalculation(lane, bytes(misplaced)), "/seal");
    expect(requests).toStrictEqual([]);
  });

  it("keeps a directly stored pin with mixed variants from granting recovery authority", async () => {
    const data = await fixture(store);
    const input = data.begin(exclusiveKind, true);
    const composition = input.pin.composition!;
    const baseline = composition.planInput.baseline;
    const fee = baseline.feeLines[0]!;
    const bad = { ...input, pin: { ...input.pin, composition: { ...composition, planInput: {
      ...composition.planInput, baseline: { ...baseline, feeLines: [{ ...fee, scope: { ...fee.scope, kind: "order" } }] },
    } } } };
    const grant = await invoke<Parameters<typeof seal>[2]>(store.runtime, beginSql, bad);
    expect(grant).toMatchObject({ kind: "claimed", generation: 1 });
    const owner = await store.owner.connect();
    try {
      await owner.query("BEGIN; ALTER TABLE public.tax_calculations DISABLE TRIGGER tax_calculation_guard");
      await owner.query("UPDATE public.tax_calculations SET lease_until=clock_timestamp()-interval '1 second' WHERE calculation_id=$1",
        [grant.calculationId]);
      await owner.query("ALTER TABLE public.tax_calculations ENABLE TRIGGER tax_calculation_guard; COMMIT");
    } finally { await owner.query("ROLLBACK"); owner.release(); }
    const before = await rowFor(store, input);
    const { pin: _pin, ...takeover } = wrappedClaim(data, input);
    expectRefusal(await beginTaxCalculation(runtimeLane(), takeover), "/taxEvidence", "tax_evaluation_integrity_invalid",
      "Recover the original evaluation from its authoritative owner.");
    expect(await rowFor(store, input)).toStrictEqual(before);
  });

  it("binds a quote revision to the pinned integer as canonical decimal and leaves bad seals pending", async () => {
    const value = await fixture(store);
    const input = value.begin(fiscalKind, true);
    const grant = await invoke<Parameters<typeof seal>[2]>(store.runtime, beginSql, input);
    const sql = seal(value, input, grant);
    const limits = sql.seal.outcome.quote.paymentLimits;
    const edits = ["042", " 42", "+42", "42 ", "43", "٤٢", "2147483648"].map(revision =>
      bindEditedSeal(sql, grant, sql.seal.evidence, { ...limits, revision }));
    const before = await rowFor(store, input);
    // Temporarily disabled the pinned payment limit comparison in the disposable database.
    await mutate(store, terminalRoutine,
      "quote->'paymentLimits' IS DISTINCT FROM jsonb_build_object(",
      "false AND quote->'paymentLimits' IS DISTINCT FROM jsonb_build_object(", async () => {
        for (const command of edits) expect(await rollback(store, db => invoke(db, completeSql, command))).toHaveProperty("kind", "terminal");
      });
    for (const command of edits) {
      expectError(await rejected(store.runtime, completeSql, command), "tax_reference_conflict", "/taxEvidence");
      expectRefusal(await completeTaxCalculation(runtimeLane(), wrappedSeal(command)), "/taxEvidence", "tax_reference_conflict",
        "Replay the original invocation and evidence.");
    }
    expect(await rowFor(store, input)).toStrictEqual(before);
    expect(await completeTaxCalculation(runtimeLane(), wrappedSeal(sql))).toMatchObject({ kind: "terminal", outcome: sql.seal.outcome });
    expect(await invoke(store.runtime, completeSql, sql)).toMatchObject({ kind: "terminal", outcome: sql.seal.outcome });
  });

  it("keeps the native frame and request encoding boundaries on the extended entry", async () => {
    const value = await fixture(store);
    const input = value.begin(fiscalKind, true);
    const wrapper = wrappedClaim(value, input);
    const { lane, requests } = capture();
    const text = canonicalCatalogDraftJson(wrapper);
    const atLimit = text + " ".repeat(1_048_576 - Buffer.byteLength(text));
    expect(await beginTaxCalculation(lane, new TextEncoder().encode(atLimit))).toStrictEqual({ kind: "missing" });
    expectRefusal(await beginTaxCalculation(lane, new TextEncoder().encode(atLimit + " ")), "/");
    const ref = '"catalogue-a"';
    const index = text.indexOf(ref);
    expect(index).toBeGreaterThan(0);
    const malformed = Buffer.concat([Buffer.from(text.slice(0, index + 1)), Buffer.from([0xc0, 0x80]),
      Buffer.from(text.slice(index + ref.length - 1))]);
    expectRefusal(await beginTaxCalculation(lane, malformed), "/");
    const ancient = { ...wrapper, pin: { ...wrapper.pin, request: { basis: "inclusive", taxDate: "0000-02-29T00:00:00.000Z" } } };
    expectRefusal(await beginTaxCalculation(lane, bytes(ancient)), "/pin/request/taxDate");
    const withoutComposition = { ...ancient, pin: { destination: input.pin.destination, kind: fiscalKind, request: ancient.pin.request,
      coverage: null, recovery: null, validUntil: input.pin.validUntil } };
    expect(await beginTaxCalculation(lane, bytes(withoutComposition))).toStrictEqual({ kind: "missing" });
    let nested: unknown = null;
    for (let i = 1; i < 48; i++) nested = [nested];
    expect(evaluationDigest("evaluation-composition", nested)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => evaluationDigest("evaluation-composition", [nested])).toThrow("draft_json_depth");
    const tag = "evaluation-composition";
    const remaining = 1_048_576 - Buffer.byteLength(canonicalCatalogDraftJson(["platform.tax." + tag + ".v1", ""]));
    const payload = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
    expect(evaluationDigest(tag, payload)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => evaluationDigest(tag, payload + "x")).toThrow("draft_payload_too_large");
    expect(requests).toHaveLength(2);
  });
});
