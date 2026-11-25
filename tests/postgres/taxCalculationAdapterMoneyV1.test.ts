import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
// eslint-disable-next-line no-restricted-imports -- witness the reporting verifier's private result for a refusal
import { checkedQuoteResult } from "../../packages/platform/src/tax/digest.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { beginSql, claim, completeSql, exclusiveKind, fixture, invoke, seal, verifiedAdapterMoney,
  type JsonPath } from "./commerceQuoteV2StorageFixture.js";

const signature = "public.tax_calculation_adapter_money_v1(jsonb,jsonb,jsonb)";
const validateSql = "SELECT public.tax_calculation_adapter_money_v1($1::jsonb,$2::jsonb,$3::jsonb) AS result";
const roles = ["anon", "authenticated", "service_role"];
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const asJson = (value: unknown) => value === undefined ? null : JSON.stringify(value);
type Validation = { moneyText: string; resultDigest: string | null } | null;
async function validate(db: Pool | PoolClient, money: unknown, pin?: unknown, body?: unknown) {
  const { rows } = await db.query<{ result: Validation }>(validateSql, [asJson(money), asJson(pin), asJson(body)]);
  return rows[0]!.result;
}
function edit<T>(original: T, path: JsonPath, value: unknown): T {
  const copy = structuredClone(original);
  const parent = path.slice(0, -1).reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], copy);
  (parent as Record<string | number, unknown>)[path.at(-1)!] = value;
  return copy;
}

const resources = storeJourneyResources();
let store: JourneyInstallation;
let sample: Awaited<ReturnType<typeof verifiedAdapterMoney>>;
beforeAll(async () => {
  store = await resources.installation("adapter-money");
  sample = await verifiedAdapterMoney(await fixture(store), "final", true);
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

it.each([
  ["final", true], ["final", false], ["estimate", true], ["estimate", false],
] as const)("matches verifier bytes and digest for %s with composition=%s", async (purpose, extended) => {
  const { result, pin, body } = purpose === "final" && extended ? sample
    : await verifiedAdapterMoney(await fixture(store), purpose, extended);
  expect(result.money.components.map(row => row.ref)).toEqual([
    { kind: "merchandise", lineKey: "item-a", sourceOrdinal: 1 },
    { kind: "merchandise", lineKey: "item-b", sourceOrdinal: 2 },
    { kind: "delivery", bucketKey: "shipping-a" }, { kind: "delivery", bucketKey: "handling-a" },
  ]);
  expect(result.money.components[0]!.allocations).toHaveLength(2);
  const positions = result.money.components[0]!.final.taxPositions;
  expect(positions.map(row => row.rateDecimal)).toEqual(["7.2500", undefined]);
  expect(positions[1]).not.toHaveProperty("rateDecimal");
  expect(result.evidence.positions.fees.map(row => row.scope.kind).sort()).toEqual(["delivery", "order"]);
  const moneyText = canonicalCatalogDraftJson(result.money);
  const resultDigest = sha256(canonicalCatalogDraftJson(["platform.tax.adapter-result-seal.v1",
    [result.kind, sha256(moneyText), result.evidenceDigest]]));
  expect(await validate(store.owner, result.money, pin, body)).toStrictEqual({ moneyText, resultDigest });
  expect(await validate(store.owner, result.money)).toStrictEqual({ moneyText, resultDigest: null });
});

it("returns no money text or digest for a refused result or incomplete context", async () => {
  const { request, result, pin, body } = sample;
  const checked = checkedQuoteResult(request, { kind: "refused", code: "tax_invalid_input", field: "/input", remedy: "Correct the input." });
  expect(checked).toHaveProperty("result", undefined);
  expect(await validate(store.owner, undefined, pin, { ...body, evidence: null, outcome: { kind: "refused" } })).toBeNull();
  expect(await validate(store.owner, result.money, pin, { ...body, evidence: null, outcome: { kind: "refused" } })).toBeNull();
  for (const [candidatePin, candidateBody] of [[pin, undefined], [undefined, body], [null, null], [pin, null], [null, body]]) {
    expect(await validate(store.owner, result.money, candidatePin, candidateBody)).toBeNull();
  }
});

const zeroState = { amountMinor: 0, netMinor: 0, taxMinor: 0, totalMinor: 0, taxPositions: [] };
const emptyMoney = { amountBasis: "exclusive", components: [], fees: [], netTotal: 0, taxTotal: 0, feeTotal: 0, payableMinor: 0 };
const component = { ref: { kind: "merchandise", lineKey: "item-a", sourceOrdinal: 1 }, initial: zeroState, final: zeroState, allocations: [] };
const adjustment = { adjustmentRef: "discount-a", sequence: 1, basisReductionMinor: 1, netReductionMinor: 1, taxReductionMinor: 0,
  beforeMinor: 1, afterMinor: 0, before: { ...zeroState, amountMinor: 1, netMinor: 1, totalMinor: 1 }, after: zeroState };
const position = { positionRef: "position-a", jurisdictionRef: "district-a", taxableMinor: 0, taxMinor: 0 };
const fee = { feeKey: "fee-a", amountMinor: 0 };

it("enforces closed nesting, safe integers, reference length and exact rate spelling", async () => {
  const { money } = sample.result;
  const first = money.components[0]!, allocation = first.allocations[0]!, state = allocation.before;
  const paths: [JsonPath, unknown][] = [
    [[], { ...money, extra: 0 }], [[], null], [[], []], [["components"], null],
    [["components", 0], { ...first, extra: 0 }], [["components", 0, "ref"], { ...first.ref, extra: 0 }],
    [["components", 2, "ref"], { ...money.components[2]!.ref, sourceOrdinal: 1 }],
    [["components", 0, "allocations", 0], { ...allocation, extra: 0 }],
    [["components", 0, "allocations", 0, "before"], { ...state, extra: 0 }],
    [["components", 0, "final", "taxPositions", 0], { ...position, "rateDecimal?": "0" }],
    [["components", 0, "final", "taxPositions", 0], { ...position, taxMinor: undefined }],
    [["fees", 0], { ...fee, extra: 0 }], [["fees", 0, "feeKey"], ""], [["fees", 0, "feeKey"], "🧪".repeat(64) + "x"],
    [["components", 0, "ref", "sourceOrdinal"], 0], [["components", 0, "allocations", 0, "sequence"], 0],
    [["components", 0, "allocations", 0, "basisReductionMinor"], 0],
    ...[null, "1", -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(value => [["netTotal"], value] as [JsonPath, unknown]),
    ...[null, 0, "00", "00.1", ".1", "1.", "1.0000001", "9007199254.740992", "1\n"].map(value =>
      [["components", 0, "final", "taxPositions", 0, "rateDecimal"], value] as [JsonPath, unknown]),
  ];
  for (const [path, value] of paths) {
    const candidate = path.length ? edit(money, path, value) : value;
    expect(await validate(store.owner, candidate), JSON.stringify(path)).toBeNull();
  }
  const limit = { ...emptyMoney, netTotal: Number.MAX_SAFE_INTEGER,
    components: [{ ...component, final: { ...zeroState, taxPositions: [
      { ...position, positionRef: "🧪".repeat(64), rateDecimal: "9007199254.740991" },
      { ...position, positionRef: "position-b", rateDecimal: "0.010000" },
    ] } }], fees: [{ ...fee, feeKey: "a".repeat(128) }] };
  expect(await validate(store.owner, limit)).toStrictEqual({ moneyText: canonicalCatalogDraftJson(limit), resultDigest: null });
  const numericWire = JSON.stringify({ ...emptyMoney, netTotal: 1 }).replace('"netTotal":1', '"netTotal":1.00');
  expect((await store.owner.query<{ result: Validation }>(validateSql, [numericWire, null, null])).rows[0]!.result)
    .toStrictEqual({ moneyText: canonicalCatalogDraftJson({ ...emptyMoney, netTotal: 1 }), resultDigest: null });
  for (const [invalid, code] of [["\0", "22P05"], ["\uD800", "22P02"], ["\uDFFF", "22P02"]]) {
    await expect(store.owner.query(validateSql, [JSON.stringify({ ...emptyMoney, fees: [{ ...fee, feeKey: invalid }] }), null, null]))
      .rejects.toMatchObject({ code });
  }
});

it("enforces all array ceilings and the exact UTF-8 byte boundary", async () => {
  for (const [key, limit, build] of [
    ["components", 512, (length: number) => ({ ...emptyMoney, components: Array.from({ length }, (_, i) =>
      ({ ...component, ref: { ...component.ref, lineKey: "item-" + i, sourceOrdinal: i + 1 } })) })],
    ["fees", 256, (length: number) => ({ ...emptyMoney, fees: Array.from({ length }, (_, i) => ({ ...fee, feeKey: "fee-" + i })) })],
    ["allocations", 256, (length: number) => ({ ...emptyMoney, components: [
      { ...component, allocations: Array.from({ length }, (_, i) => ({ ...adjustment, sequence: i + 1 })) },
    ] })],
    ["positions", 32, (length: number) => ({ ...emptyMoney, components: [{ ...component, final: {
      ...zeroState, taxPositions: Array.from({ length }, (_, i) => ({ ...position, positionRef: "position-" + i })),
    } }] })],
  ] as const) {
    const atLimit = build(limit);
    expect(await validate(store.owner, atLimit), key).toStrictEqual({ moneyText: canonicalCatalogDraftJson(atLimit), resultDigest: null });
    expect(await validate(store.owner, build(limit + 1)), key).toBeNull();
  }

  const state = () => ({ ...zeroState, taxPositions: Array.from({ length: 16 }, (_, i) =>
    ({ ...position, positionRef: "position-" + i, jurisdictionRef: "🧪" })) });
  const large = { ...emptyMoney, components: Array.from({ length: 192 }, (_, i) => ({
    ...component, ref: { ...component.ref, lineKey: "item-" + i, sourceOrdinal: i + 1 }, initial: state(), final: state(),
  })) };
  const positions = large.components.flatMap(({ initial, final }) => [...initial.taxPositions, ...final.taxPositions]);
  let remainingBytes = 1_048_576 - Buffer.byteLength(canonicalCatalogDraftJson(large), "utf8");
  for (const row of positions) {
    const count = Math.min(126, remainingBytes);
    row.jurisdictionRef += "a".repeat(count);
    remainingBytes -= count;
  }
  expect(remainingBytes).toBe(0);
  const moneyText = canonicalCatalogDraftJson(large);
  expect(Buffer.byteLength(moneyText, "utf8")).toBe(1_048_576);
  expect(await validate(store.owner, large)).toStrictEqual({ moneyText, resultDigest: null });
  positions.at(-1)!.jurisdictionRef += "a";
  expect(Buffer.byteLength(JSON.stringify(large), "utf8")).toBe(1_048_577);
  expect(await validate(store.owner, large)).toBeNull();
}, 30_000);

it("refuses independent component, allocation, position and fee mismatches", async () => {
  const { result: { money }, pin, body } = sample;
  const first = money.components[0]!, step = first.allocations[0]!;
  const mutations: [string, JsonPath, unknown][] = [
    ["component key", ["components", 0, "ref", "lineKey"], "item-other"],
    ["component ordinal", ["components", 0, "ref", "sourceOrdinal"], 3],
    ["component order", ["components"], [money.components[1], first, ...money.components.slice(2)]],
    ["delivery order", ["components"], [...money.components.slice(0, 2), money.components[3], money.components[2]]],
    ["delivery key", ["components", 2, "ref", "bucketKey"], "shipping-other"],
    ["initial basis", ["components", 0, "initial", "amountMinor"], first.initial.amountMinor - 1],
    ["final total", ["components", 0, "final", "totalMinor"], first.final.totalMinor - 1],
    ["allocation count", ["components", 0, "allocations"], [step]],
    ["allocation order", ["components", 0, "allocations"], [...first.allocations].reverse()],
    ["allocation identity", ["components", 0, "allocations", 0, "adjustmentRef"], "discount-other"],
    ["allocation sequence", ["components", 0, "allocations", 0, "sequence"], 4],
    ["basis reduction", ["components", 0, "allocations", 0, "basisReductionMinor"], step.basisReductionMinor + 1],
    ["net reduction", ["components", 0, "allocations", 0, "netReductionMinor"], step.netReductionMinor + 1],
    ["tax reduction", ["components", 0, "allocations", 0, "taxReductionMinor"], step.taxReductionMinor + 1],
    ["scalar before", ["components", 0, "allocations", 0, "beforeMinor"], step.beforeMinor - 1],
    ["scalar after", ["components", 0, "allocations", 0, "afterMinor"], step.afterMinor - 1],
    ["before state total", ["components", 0, "allocations", 0, "before", "totalMinor"], step.before.totalMinor + 1],
    ["after state basis", ["components", 0, "allocations", 0, "after", "amountMinor"], step.after.amountMinor + 1],
    ["position identity", ["components", 0, "final", "taxPositions", 0, "positionRef"], "position-other"],
    ["position order", ["components", 0, "final", "taxPositions"], [...first.final.taxPositions].reverse()],
    ["position jurisdiction", ["components", 0, "final", "taxPositions", 0, "jurisdictionRef"], "district-other"],
    ["position taxable amount", ["components", 0, "final", "taxPositions", 0, "taxableMinor"], 0],
    ["position tax", ["components", 0, "final", "taxPositions", 0, "taxMinor"], 0],
    ["exact rate spelling", ["components", 0, "final", "taxPositions", 0, "rateDecimal"], "7.25"],
    ["absent rate", ["components", 0, "final", "taxPositions", 1, "rateDecimal"], "2"],
    ["fee key", ["fees", 0, "feeKey"], "fee-other"],
    ["fee amount", ["fees", 0, "amountMinor"], 1],
    ["fee order", ["fees"], [...money.fees].reverse()],
  ];
  for (const [label, path, value] of mutations) {
    expect(await validate(store.owner, edit(money, path, value), pin, body), label).toBeNull();
  }
});

it("binds ordered projections to pin targets and hashed evidence, and checks derived totals", async () => {
  const { result: { money }, pin, body } = sample;
  const quote = body.outcome.quote;
  const step = money.components[0]!.allocations[0]!;
  const cellIndex = pin.request.input.required.findIndex(row => row.target.kind === "line");
  expect(cellIndex).toBeGreaterThanOrEqual(0);
  const pinMutations: [JsonPath, unknown][] = [
    [["request", "input", "money", "adjustments", 0, "target", "lineKeys"], ["item-b"]],
    [["request", "input", "money", "adjustments", 2, "target", "bucketKey"], "handling-a"],
    [["request", "input", "required", cellIndex, "sourcing"], "ship_from"],
  ];
  for (const [path, value] of pinMutations) {
    expect(await validate(store.owner, money, edit(pin, path, value), body), JSON.stringify(path)).toBeNull();
  }
  const bodyMutations: [JsonPath, unknown][] = [
    [["outcome", "quote", "deliveryBuckets", 0, "parts"], [...quote.deliveryBuckets[0]!.parts, quote.deliveryBuckets[0]!.parts[0]]],
    [["outcome", "quote", "deliveryBuckets", 0, "parts", 0, "sourceOrdinal"], 1],
    [["outcome", "quote", "lines", 0, "discountAllocations", 0, "before", "taxPositions", 0, "taxableMinor"], 0],
    [["outcome", "quote", "lines", 0, "discountAllocations", 0, "after", "taxPositions", 0, "taxableMinor"], 0],
    [["evidence", "adapterDigest"], "0".repeat(64)],
  ];
  for (const [path, value] of bodyMutations) {
    expect(await validate(store.owner, money, pin, edit(body, path, value)), JSON.stringify(path)).toBeNull();
  }
  const index = quote.feeLines.findIndex(row => row.scope.kind === "delivery");
  expect(index).toBeGreaterThanOrEqual(0);
  for (const [feePath, feeValue, evidencePath, evidenceValue] of [
    ["scope", { kind: "delivery", bucketKey: "handling-a" }, "scope", { kind: "delivery", key: "handling-a" }],
    ["jurisdictionRef", "district-b", "jurisdiction", "district-b"], ["feeKind", "fee-other", "feeKind", "fee-other"],
  ] as const) {
    const evidenceIndex = body.evidence.adapterEvidence.positions.fees.findIndex(row => row.feeKey === quote.feeLines[index]!.feeKey);
    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    const adapterEvidence = edit(body.evidence.adapterEvidence, ["positions", "fees", evidenceIndex, evidencePath], evidenceValue);
    const edited = edit(body, ["outcome", "quote", "feeLines", index, feePath], feeValue);
    expect(await validate(store.owner, money, pin, { ...edited, evidence: { ...edited.evidence, adapterEvidence,
      adapterDigest: sha256(canonicalCatalogDraftJson(["platform.tax.evidence.v1", adapterEvidence])) } }), feePath).toBeNull();
  }
  const wrongDelta = step.netReductionMinor + 1;
  expect(await validate(store.owner, edit(money, ["components", 0, "allocations", 0, "netReductionMinor"], wrongDelta),
    pin, edit(body, ["outcome", "quote", "lines", 0, "discountAllocations", 0, "netReductionMinor"], wrongDelta))).toBeNull();
  const netTotal = money.netTotal + 1, payableMinor = money.payableMinor + 1;
  expect(await validate(store.owner, { ...money, netTotal, payableMinor }, pin,
    { ...body, outcome: { ...body.outcome, quote: { ...quote, netTotal, payableMinor } } })).toBeNull();
});

const catalog = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
  baseline: { file: string }; forward: { file: string }[];
};
const forwardIndex = catalog.forward.findIndex(unit => unit.file.endsWith("_tax_calculation_adapter_money_v1.sql"));
const unit = catalog.forward[forwardIndex];
const schema = `SELECT jsonb_build_object(
  'relation', (SELECT to_jsonb(c)-'relpages'-'reltuples'-'relallvisible'-'relallfrozen' FROM pg_class c WHERE oid='public.tax_calculations'::regclass),
  'columns', (SELECT jsonb_agg(to_jsonb(a) ORDER BY attnum) FROM pg_attribute a WHERE attrelid='public.tax_calculations'::regclass AND attnum>0),
  'defaults', (SELECT jsonb_agg(pg_get_expr(adbin,adrelid) ORDER BY adnum) FROM pg_attrdef WHERE adrelid='public.tax_calculations'::regclass),
  'indexes', (SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid) FROM pg_index WHERE indrelid='public.tax_calculations'::regclass),
  'constraints', (SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.tax_calculations'::regclass),
  'triggers', (SELECT jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.tax_calculations'::regclass),
  'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY polname) FROM pg_policy p WHERE polrelid='public.tax_calculations'::regclass),
  'routines', (SELECT jsonb_object_agg(oid::regprocedure::text,jsonb_build_array(pg_get_functiondef(oid),proacl,proowner))
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'tax_calculation_%')) AS value`;
const privateAcl = `SELECT p.provolatile AS volatility,p.prosecdef AS definer,p.proisstrict AS strict,p.proconfig AS settings,
  pg_get_userbyid(p.proowner)=current_user AS migration_owner,
  p.proowner=(SELECT proowner FROM pg_proc WHERE oid='public.tax_calculation_complete_v1(jsonb)'::regprocedure) AS completion_owner,
  p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.tax_calculations'::regclass) AS table_owner,
  p.proowner=(SELECT proowner FROM pg_proc WHERE oid='public.tax_calculation_guard_v1()'::regprocedure) AS guard_owner,
  NOT EXISTS (SELECT FROM aclexplode(p.proacl) a WHERE a.grantee<>p.proowner) AS owner_only
  FROM pg_proc p WHERE oid=$1::regprocedure`;
const expectedAcl = { volatility: "s", definer: false, strict: false, settings: ["search_path=pg_catalog, pg_temp"],
  migration_owner: true, completion_owner: true, table_owner: true, guard_owner: true, owner_only: true };

it("preserves the exact predecessor lifecycle and installs only owner execution with optional roles present and absent", async () => {
  expect(unit).toBeDefined();
  let instance: PostgresContainer | undefined, owner: Pool | undefined, runtime: Pool | undefined;
  try {
    instance = await runPostgresContainer({ name: `adapter-money-prefix-${process.pid}`, password: "synthetic-adapter-money" });
    expect(await waitForPostgresTcpReady(instance.connectionString)).toBe(true);
    owner = new Pool({ connectionString: instance.connectionString });
    runtime = new Pool({ connectionString: instance.connectionString, options: "-c role=service_role" });
    await owner.query("CREATE ROLE service_role");
    for (const migration of [catalog.baseline, ...catalog.forward.slice(0, forwardIndex)]) {
      await owner.query(readFileSync(migration.file, "utf8"));
    }
    expect((await owner.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname", [roles])).rows)
      .toStrictEqual(roles.map(rolname => ({ rolname })));
    const value = await fixture({ owner, runtime, runtimeUrl: instance.connectionString });
    const input = value.begin(exclusiveKind, true);
    const grant = await claim(input, runtime);
    const command = seal(value, input, grant);
    const lookup = { operation: "lookup", identity: input.identity, invocation: input.invocation };
    const db = await owner.connect();
    try {
      await db.query("BEGIN");
      const predecessor = (await db.query(schema)).rows[0]!.value;
      const exercise = async () => {
        await db.query("SET LOCAL ROLE service_role");
        const pending = await invoke(db, beginSql, lookup);
        const complete = await invoke(db, completeSql, command);
        const beginReplay = await invoke(db, beginSql, input);
        const read = await invoke(db, beginSql, lookup);
        await db.query("RESET ROLE");
        const stored = (await db.query(`SELECT state, pin::text, pin_digest, locator, outcome_text, outcome_digest,
          provider_digest, contradiction FROM public.tax_calculations WHERE calculation_id=$1`, [grant.calculationId])).rows;
        return { pending, complete, beginReplay, read, stored };
      };
      await db.query("SAVEPOINT predecessor");
      const before = await exercise();
      expect(before.pending).toStrictEqual({ kind: "pending" });
      expect(before.complete).toStrictEqual({ kind: "terminal", outcome: command.seal.outcome, validUntil: command.seal.validUntil });
      expect(before.beginReplay).toStrictEqual(before.complete);
      expect(before.read).toStrictEqual(before.complete);
      expect(before.stored).toHaveLength(1);
      await db.query("ROLLBACK TO SAVEPOINT predecessor");

      const sql = readFileSync(unit!.file, "utf8");
      await db.query("SAVEPOINT optional_roles");
      await db.query("ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role");
      await db.query(sql);
      expect((await db.query(privateAcl, [signature])).rows).toStrictEqual([expectedAcl]);
      expect(await validate(db, emptyMoney)).toStrictEqual({ moneyText: canonicalCatalogDraftJson(emptyMoney), resultDigest: null });
      const candidate = (await db.query(schema)).rows[0]!.value;
      const { ["tax_calculation_adapter_money_v1(jsonb,jsonb,jsonb)"]: added, ...routines } = candidate.routines;
      expect(added).toBeDefined();
      expect({ ...candidate, routines }).toStrictEqual(predecessor);
      expect(await exercise()).toStrictEqual(before);

      await db.query("CREATE ROLE adapter_money_observer");
      for (const role of [...roles, "adapter_money_observer"]) {
        await db.query("SAVEPOINT attempt");
        await db.query(`SET LOCAL ROLE ${role}`);
        await expect(validate(db, emptyMoney)).rejects.toMatchObject({ code: "42501" });
        await db.query("ROLLBACK TO SAVEPOINT attempt");
      }
      await db.query("ROLLBACK TO SAVEPOINT optional_roles");
      await db.query("DROP OWNED BY anon,authenticated,service_role; DROP ROLE anon,authenticated,service_role");
      expect((await db.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1)", [roles])).rows).toEqual([]);
      await db.query(sql);
      expect((await db.query(privateAcl, [signature])).rows).toStrictEqual([expectedAcl]);
      expect(await validate(db, emptyMoney)).toStrictEqual({ moneyText: canonicalCatalogDraftJson(emptyMoney), resultDigest: null });
    } finally { await db.query("ROLLBACK"); db.release(); }
  } finally { await closePostgres(instance, [owner, runtime].filter((pool): pool is Pool => pool !== undefined)); }
}, postgresSetupTimeoutMs);
