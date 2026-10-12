import { describe, expect, it } from "vitest";
import { checkReadiness, createSchemaProbe, buildSchemaObjectProbe, buildGroupedPostgresSchemaProbe, decodeGroupedPostgresSchemaRows, type SchemaObject, type ReadinessInput } from "../src/readiness/index.js";
const handler = { eventType: "example.ready", timeoutMs: 100 };
const run = () => undefined;
function input(): ReadinessInput {
  return {
    candidate: { artifact: "candidate-1", configuration: "config-1", environment: "test", database: "db-1", schema: "schema-1" }, inventoryComplete: true,
    loadedPackages: [{ name: "@openlup/core", version: "0.12.0", kind: "kernel" }, { name: "@openlup/example", version: "0.12.0", kind: "rail" }],
    contributions: [{ handlers: [handler], schedules: [{ id: "dispatch", cadenceSeconds: 60, run }], routes: [], manifest: {
      name: "@openlup/example", version: "0.12.0", kind: "rail", emits: [handler.eventType], handles: [handler.eventType], schedules: [{ id: "dispatch", cadenceSeconds: 60 }], routes: [], requiredPorts: ["store"], env: ["EXAMPLE_OPTION"],
      requiredSchema: { version: "migration-1", migration: "0001.sql", objects: [{ kind: "table", name: "public.example" }, { kind: "column", name: "public.example.id" }, { kind: "function", name: "public.example_claim", signature: "integer" }] },
    } }], vocabulary: [{ eventType: handler.eventType, owner: "@openlup/core" }], exemptions: [],
    bindings: { ports: { "@openlup/example:store": { claim: run } }, triggers: { "@openlup/example:dispatch": run }, routes: {}, env: { EXAMPLE_OPTION: "synthetic" } },
    schemaProbe: { observe: async (req) => ({ database: "db-1", version: req.version, objects: req.objects.map((object) => ({ object, present: true })) }) },
  };
}
describe("candidate readiness", () => {
  it("checks inert observations without running handlers or jobs", async () => {
    const i = input(); let effects = 0;
    i.contributions[0].schedules[0].run = () => { effects++; };
    i.bindings.triggers = { "@openlup/example:dispatch": i.contributions[0].schedules[0].run };
    expect((await checkReadiness(i)).state).toBe("ready"); expect(effects).toBe(0);
  });
  it("reports all seven issue classes in stable order", async () => {
    const i = input(); i.bindings = { ports: {}, triggers: {}, routes: {}, env: {} };
    i.loadedPackages = [...i.loadedPackages, { name: "@openlup/other", version: "0.11.0", kind: "rail" }];
    i.vocabulary = [...i.vocabulary, { eventType: "example.unhandled", owner: "@openlup/core" }];
    i.contributions = [...i.contributions, { ...i.contributions[0], manifest: { ...i.contributions[0].manifest, name: "@openlup/other", version: "0.11.0" } }];
    i.schemaProbe = { observe: async (req) => ({ database: "db-1", version: req.version, objects: req.objects.map((object) => ({ object, present: false })) }) };
    const a = await checkReadiness(i), b = await checkReadiness(i);
    expect(a).toEqual(b); expect(new Set(a.issues.map((v) => v.code)).size).toBe(7); expect(a.state).toBe("unsatisfied");
  });
  it.each(["missing-core", "duplicate-package", "missing-contribution", "missing-package", "incomplete-inventory", "duplicate-contribution", "set-mismatch"])("refuses %s", async (mode) => {
    const i = input();
    if (mode === "missing-core") i.loadedPackages = i.loadedPackages.slice(1);
    if (mode === "duplicate-package") i.loadedPackages = [...i.loadedPackages, i.loadedPackages[1]];
    if (mode === "missing-contribution") i.contributions = [];
    if (mode === "missing-package") i.loadedPackages = i.loadedPackages.slice(0, 1);
    if (mode === "incomplete-inventory") i.inventoryComplete = false;
    if (mode === "duplicate-contribution") i.contributions = [...i.contributions, i.contributions[0]];
    if (mode === "set-mismatch") i.loadedPackages = [i.loadedPackages[0], { ...i.loadedPackages[1], version: "0.11.0" }];
    expect((await checkReadiness(i)).state).not.toBe("ready");
  });
  it.each(["throw", "timeout", "malformed", "incomplete", "duplicate", "wrong-overload", "unknown-version", "wrong-database", "unknown-object"])("refuses probe %s while retaining binding errors", async (mode) => {
    const i = input(); i.bindings = { ...i.bindings, env: {} }; i.probeTimeoutMs = 5;
    i.schemaProbe = { async observe(req) {
      if (mode === "throw") throw new Error("synthetic failure");
      if (mode === "timeout") return new Promise(() => {});
      if (mode === "malformed") return {} as never;
      const value = { database: mode === "wrong-database" ? "db-other" : "db-1", version: mode === "unknown-version" ? null : req.version, objects: req.objects.map((object) => ({ object, present: mode === "unknown-object" ? null : true })) };
      if (mode === "incomplete") value.objects.pop();
      if (mode === "duplicate") value.objects[1] = value.objects[0];
      if (mode === "wrong-overload") value.objects[2] = { object: { ...value.objects[2].object, signature: "text" }, present: true };
      return value;
    } };
    const r = await checkReadiness(i); expect(r.state).toBe("unknown");
    expect(r.issues.some((v) => v.code === "OPENLUP_E_ENV_MISSING")).toBe(true);
    expect(r.issues.some((v) => v.code === "OPENLUP_E_SCHEMA_BEHIND")).toBe(true);
  });
  it("keeps producer ownership distinct from consumer composition and owned exemptions", async () => {
    const i = input(); i.vocabulary = [...i.vocabulary, { eventType: "example.future", owner: "@openlup/core" }];
    i.exemptions = [{ pattern: "example.future", prefix: false, state: "dormant", reason: "No producer in this candidate", owner: "application" }];
    expect((await checkReadiness(i)).state).toBe("ready");
    i.exemptions = [{ ...i.exemptions[0], reason: "" }]; expect((await checkReadiness(i)).state).not.toBe("ready");
  });
  it("rejects malformed declarations and duplicate schema objects", async () => {
    const i = input(); const m = i.contributions[0].manifest;
    i.contributions = [{ ...i.contributions[0], manifest: { ...m, emits: ["example.ready", "example.ready"] } }];
    expect((await checkReadiness(i)).state).not.toBe("ready");
    i.contributions = [{ ...input().contributions[0], handlers: [] }];
    expect((await checkReadiness(i)).issues.some((v) => v.code === "OPENLUP_E_EVENT_DUPLICATE")).toBe(true);
  });
  it("probes actual qualified catalog identities with bound values", async () => {
    const queries: { text: string; values?: readonly unknown[] }[] = [];
    const probe = createSchemaProbe({ async query(text, values) { queries.push({ text, values }); return { rows: [{ present: true }] as never }; } }, async () => ({ database: "db-1", version: "migration-1" }));
    const i = input(); i.schemaProbe = probe; expect((await checkReadiness(i)).state).toBe("ready");
    expect(queries[2].values).toEqual(["public.example_claim(integer)"]);
    expect(buildSchemaObjectProbe({ kind: "column", name: "public.example.id" }).values).toEqual(["public.example", "id"]);
  });
  it.each(["null-handler", "null-schedule", "null-route", "null-exemption", "bad-reason", "fake-port", "bad-timeout", "no-probe", "null-input"])("malformed %s cannot admit or throw", async (mode) => {
    const i = input();
    if (mode === "null-handler") i.contributions[0].handlers = [null as never];
    if (mode === "null-schedule") i.contributions[0].schedules = [null as never];
    if (mode === "null-route") i.contributions[0].routes = [null as never];
    if (mode === "null-exemption") i.exemptions = [null as never];
    if (mode === "bad-reason") i.exemptions = [{pattern:"example",prefix:true,owner:"application",state:"dormant",reason:42 as never}];
    if (mode === "fake-port") i.bindings.ports = { "@openlup/example:store": true };
    if (mode === "bad-timeout") i.probeTimeoutMs = Infinity;
    if (mode === "no-probe") i.schemaProbe = null as never;
    const result = await checkReadiness(mode === "null-input" ? null as never : i);
    expect(result.state).not.toBe("ready");
  });

  it("refuses unrelated runnable schedule and route observations", async () => {
    const i = input(); i.bindings.triggers = { "@openlup/example:dispatch": () => undefined };
    const handle = () => undefined; i.contributions[0].routes = [{id:"example-route",handle}];
    i.contributions[0].manifest.routes = ["example-route"];i.bindings.routes = { "@openlup/example:example-route": () => undefined };
    const r=await checkReadiness(i);expect(r.state).toBe("unsatisfied");
    expect(r.issues.map(v=>v.code)).toEqual(expect.arrayContaining(["OPENLUP_E_SCHEDULE_UNBOUND","OPENLUP_E_PORT_MISSING"]));
    i.bindings.triggers = { "@openlup/example:dispatch": i.contributions[0].schedules[0].run };i.bindings.routes = { "@openlup/example:example-route": handle };
    expect((await checkReadiness(i)).state).toBe("ready");
  });

});

const objects: readonly SchemaObject[] = Object.freeze([
  Object.freeze({ kind: "table", name: "public.example" }),
  Object.freeze({ kind: "column", name: "public.example.value" }),
  Object.freeze({ kind: "function", name: "public.example_read", signature: "integer,text" }),
]);
describe("grouped PostgreSQL schema catalog", () => {
  it("binds scalar identities without interpolation and retains duplicates", () => {
    const hostile: SchemaObject = { kind: "table", name: "example'); select 1; --" };
    const query = buildGroupedPostgresSchemaProbe([...objects, objects[0], hostile]);
    expect(query.values).toEqual([
      ["table", "column", "function", "table", "table"],
      ["public.example", "public.example", "public.example_read(integer,text)", "public.example", hostile.name],
      [null, "value", null, null, null],
    ]);
    expect(query.text).not.toContain(hostile.name);
    expect(buildGroupedPostgresSchemaProbe([{ kind: "function", name: "example" }]).values[1]).toEqual(["example()"]);
    expect(buildGroupedPostgresSchemaProbe([{ kind: "column", name: "value" }]).values).toEqual([["column"], [""], ["value"]]);
  });
  it("accepts empty results only for empty requests", () => {
    expect(buildGroupedPostgresSchemaProbe([]).values).toEqual([[], [], []]);
    expect(decodeGroupedPostgresSchemaRows([], [])).toEqual([]);
    expect(() => decodeGroupedPostgresSchemaRows([], [{ ordinal: 1, present: false, shape: null }])).toThrow();
  });
  it("preserves JSON.parse key and nested order without rebuilding shapes or mutating inputs", () => {
    const shape = '{"z":[{"b":2,"a":1}],"a":null}';
    const rows = Object.freeze([
      Object.freeze({ ordinal: 1, present: true, shape, extra: "ignored" }),
      Object.freeze({ ordinal: 2, present: true, shape: '{"a":null,"z":[{"a":1,"b":2}]}' }),
      Object.freeze({ ordinal: 3, present: false, shape: null }),
    ]);
    const decoded = decodeGroupedPostgresSchemaRows(objects, rows);
    expect(JSON.stringify(decoded[0].shape)).toBe(shape);
    expect(JSON.stringify(decoded[1].shape)).toBe(rows[1].shape);
    expect(decoded[0].object).toBe(objects[0]);
    expect(decoded[2]).toEqual({ object: objects[2], present: false, shape: null });
    expect(decodeGroupedPostgresSchemaRows([objects[0], objects[0]], [rows[0], { ...rows[0], ordinal: 2 }])).toHaveLength(2);
  });
  it.each([
    [], [{ ordinal: 1, present: false, shape: null }, { ordinal: 2, present: false, shape: null }],
    [null], [{ ordinal: 0, present: false, shape: null }], [{ ordinal: 2, present: false, shape: null }],
    [{ ordinal: 1.5, present: false, shape: null }], [{ ordinal: "1", present: false, shape: null }],
    [{ ordinal: NaN, present: false, shape: null }], [{ ordinal: Infinity, present: false, shape: null }],
    [{ ordinal: 1, present: null, shape: null }], [{ ordinal: 1, present: "true", shape: {} }],
    [{ ordinal: 1, present: false, shape: {} }], [{ ordinal: 1, present: false, shape: "null" }],
    [{ ordinal: 1, present: true, shape: null }], [{ ordinal: 1, present: true }],
    ...["", "   ", "private-body", "null", "[]", "42", '"private-body"', "true", {}, [], 42, true].map(shape => [{ ordinal: 1, present: true, shape }]),
  ])("refuses malformed rows with a bounded generic error: %#", (...rows) => {
    expect(() => decodeGroupedPostgresSchemaRows([objects[0]], rows as never)).toThrow("Invalid grouped PostgreSQL schema rows");
  });
  it("rejects missing, extra, duplicate and reordered ordinals at full cardinality", () => {
    for (const ordinals of [[1, 1, 3], [2, 1, 3], [1, 2, 4]]) {
      expect(() => decodeGroupedPostgresSchemaRows(objects, ordinals.map(ordinal => ({ ordinal, present: false, shape: null })))).toThrow();
    }
  });
});
