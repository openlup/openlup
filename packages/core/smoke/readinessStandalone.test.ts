import { afterAll, describe, expect, it } from "vitest";
import { checkReadiness as evaluateReadiness, createSchemaProbe, buildSchemaObjectProbe, buildGroupedPostgresSchemaProbe, decodeGroupedPostgresSchemaRows, type SchemaObject, type ReadinessInput } from "../src/readiness/index.js";
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
// B0 legacy corpus: these existing cases and the inert factory/admission shapes
// below capture full reports, including array/property order, before source changes.
describe("candidate readiness", () => {
  const reports: { case: string | undefined; report: string }[] = [];
  const checkReadiness: typeof evaluateReadiness = async (facts) => {
    const report = await evaluateReadiness(facts);
    reports.push({ case: expect.getState().currentTestName, report: JSON.stringify(report) });
    return report;
  };
  afterAll(() => { expect(JSON.stringify(reports)).toBe(JSON.stringify(legacyGoldenReports)); });
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

  // Copies the inert declaration shape from outbox/src/factory.ts, postgres.ts
  // and runtime/outbox/candidateAdmission.ts; no rail import or effect invocation.
  it.each(["factory", "reference", "missing-store", "missing-lease", "missing-compactor", "missing-dispatch", "missing-prune", "wrong-core", "wrong-outbox", "wrong-platform", "incomplete", "no-platform"])("legacy outbox/admission %s", async (mode) => {
    const i = input();
    const requiredSchema: NonNullable<ReadinessInput["contributions"][number]["manifest"]["requiredSchema"]> = {
      version: "outbox-1", migration: "sql/0001_outbox.sql", objects: [
        { kind: "table", name: "public.outbox_events" }, { kind: "table", name: "public.outbox_dormant_event_types" },
        ...["id", "created_at", "available_at", "processed_at", "aggregate_type", "aggregate_id", "event_type", "idempotency_key", "status", "attempts", "payload", "error", "metadata"].map(name => ({ kind: "column" as const, name: `public.outbox_events.${name}` })),
        ...[
          ["public.outbox_claim_batch", "text[],text[],integer,integer,integer"],
          ["public.outbox_mark_processed", "uuid,text,jsonb"],
          ["public.outbox_mark_failed", "uuid,text,text,text,integer,integer,integer,integer"],
          ["public.outbox_release_unprocessed", "uuid[],text[],integer"],
          ["pg_catalog.pg_input_is_valid", "text,text"],
        ].map(([name, signature]) => ({ kind: "function" as const, name, signature })),
      ],
    };
    i.candidate = { artifact: "one", configuration: "one", environment: "test", database: "test-db", schema: "one" };
    i.loadedPackages = [{ name: "@openlup/core", version: "0.15.0", kind: "kernel" }, { name: "@openlup/outbox", version: "0.15.0", kind: "rail" }];
    const schedules = [{ id: "outbox-dispatch", cadenceSeconds: 60, run }, { id: "outbox-prune", cadenceSeconds: 86400, run }];
    i.contributions = [{ handlers: [{ eventType: "example.created", timeoutMs: 100 }], schedules, routes: [], manifest: {
      name: "@openlup/outbox", version: "0.15.0", kind: "rail", emits: [], handles: ["example.created"],
      schedules: schedules.map(({ id, cadenceSeconds }) => ({ id, cadenceSeconds })), routes: [], requiredPorts: ["store", "lease", "compactor"], env: [], requiredSchema,
    } }];
    i.bindings = { ports: { "@openlup/outbox:store": {}, "@openlup/outbox:lease": {}, "@openlup/outbox:compactor": {} }, triggers: Object.fromEntries(schedules.map(s => [`@openlup/outbox:${s.id}`, s.run])), routes: {}, env: {} };
    i.vocabulary = [{ eventType: "example.created", owner: "application" }];
    i.schemaProbe = { observe: async req => ({ database: "test-db", version: req.version, objects: req.objects.map(object => ({ object, present: true })) }) };
    if (mode !== "factory" && mode !== "no-platform") {
      const platform = { name: "@openlup/platform", version: "0.15.0", kind: "rail" as const };
      i.loadedPackages = [...i.loadedPackages, platform];
      i.contributions = [...i.contributions, { handlers: [], schedules: [], routes: [], manifest: { ...platform, emits: [], handles: [], schedules: [], routes: [], requiredPorts: [], env: [] } }];
    }
    if (mode.startsWith("missing-")) {
      const key = mode.slice(8);
      i.bindings.ports = Object.fromEntries(Object.entries(i.bindings.ports).filter(([name]) => name !== `@openlup/outbox:${key}`));
      i.bindings.triggers = Object.fromEntries(Object.entries(i.bindings.triggers).filter(([name]) => name !== `@openlup/outbox:outbox-${key}`));
    }
    if (mode.startsWith("wrong-")) i.loadedPackages = i.loadedPackages.map(p => p.name === `@openlup/${mode.slice(6)}` ? { ...p, version: "0.0.1" } : p);
    if (mode === "incomplete") i.inventoryComplete = false;
    const report = await checkReadiness(i);
    expect(report.state).toBe(["factory", "reference", "no-platform"].includes(mode) ? "ready" : mode === "incomplete" ? "unknown" : "unsatisfied");
  });

});

function moduleInput(): ReadinessInput {
  const i = input();
  i.loadedPackages = [i.loadedPackages[0], { name: "@openlup/platform", version: "0.12.0", kind: "rail", modules: ["foundation", "identity"] }];
  i.contributions = ["foundation", "identity"].map((id) => ({
    handlers: [{ eventType: `${id}.ready`, timeoutMs: 100 }],
    schedules: [{ id: `${id}-schedule`, cadenceSeconds: 60, run }], routes: [{ id: `${id}-route`, handle: run }],
    manifest: {
      name: "@openlup/platform", version: "0.12.0", kind: "rail",
      module: { id, kind: id === "foundation" ? "kernel" : "capability", provides: [id === "foundation" ? "./bff" : "./identity/contracts"], dependsOn: id === "identity" ? [{ module: "foundation", entries: ["./bff"] }] : [] },
      emits: [`${id}.ready`], handles: [`${id}.ready`], schedules: [{ id: `${id}-schedule`, cadenceSeconds: 60 }], routes: [`${id}-route`], requiredPorts: ["store"], env: id === "identity" ? ["IDENTITY_OPTION"] : [],
      requiredSchema: { version: `${id}-1`, migration: `${id}-0001.sql`, objects: [{ kind: "table", name: `public.${id}` }] },
    },
  }));
  i.vocabulary = []; i.bindings = { ports: {}, triggers: {}, routes: {}, env: { IDENTITY_OPTION: "synthetic" } };
  bindModules(i);
  return i;
}
function bindModules(i: ReadinessInput): void {
  i.bindings.ports = Object.fromEntries(i.contributions.map(c => [`${c.manifest.name}/${c.manifest.module!.id}:store`, {}]));
  i.bindings.triggers = Object.fromEntries(i.contributions.flatMap(c => c.schedules.map(s => [`${c.manifest.name}/${c.manifest.module!.id}:${s.id}`, s.run])));
  i.bindings.routes = Object.fromEntries(i.contributions.flatMap(c => c.routes.map(r => [`${c.manifest.name}/${c.manifest.module!.id}:${r.id}`, r.handle])));
}
describe("selected logical module readiness", () => {
  it("admits foundation and identity with independent schema identities and shared port names", async () => {
    const i = moduleInput(), observed: string[] = [];
    const probe = i.schemaProbe;
    i.schemaProbe = { observe: req => { observed.push(req.version); return probe.observe(req); } };
    expect(await evaluateReadiness(i)).toMatchObject({ state: "ready", issues: [] });
    expect(observed).toEqual(["foundation-1", "identity-1"]);
  });
  it.each(["module-without-selection", "legacy-with-selection", "empty-with-module", "empty-with-legacy", "empty"])("fails closed for mixed/empty mode: %s", async mode => {
    const i = moduleInput();
    if (mode === "module-without-selection") delete i.loadedPackages[1].modules;
    if (mode === "legacy-with-selection" || mode === "empty-with-legacy") for (const c of i.contributions) delete c.manifest.module;
    if (mode.startsWith("empty")) i.loadedPackages[1].modules = [];
    if (mode === "empty") i.contributions = [];
    const report = await evaluateReadiness(i);
    expect(report.state).toBe(mode === "empty" ? "ready" : "unsatisfied");
    if (mode !== "empty") expect(report.issues.some(issue => issue.code === "OPENLUP_E_SET_MISMATCH")).toBe(true);
  });
  it.each(["missing-module", "missing-dependency", "uncomposed-dependency", "undeclared-entry", "later-layer", "cross-artifact"])("refuses module/dependency gap: %s", async mode => {
    const i = moduleInput();
    if (mode === "missing-module") i.contributions = i.contributions.slice(0, 1);
    if (mode === "missing-dependency" || mode === "cross-artifact") { i.loadedPackages[1].modules = ["identity"]; i.contributions = i.contributions.slice(1); }
    if (mode === "cross-artifact") {
      const other = moduleInput().contributions[0]; other.manifest.name = "@openlup/other";
      i.loadedPackages = [...i.loadedPackages, { name: "@openlup/other", version: "0.12.0", kind: "rail", modules: ["foundation"] }];
      i.contributions = [...i.contributions, other]; bindModules(i);
    }
    if (mode === "uncomposed-dependency") i.contributions = i.contributions.slice(1);
    if (mode === "undeclared-entry") i.contributions[1].manifest.module!.dependsOn = [{ module: "foundation", entries: ["./undeclared"] }];
    if (mode === "later-layer") i.contributions[0].manifest.module!.kind = "implementation";
    const report = await evaluateReadiness(i);
    expect(report.state).toBe("unsatisfied");
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OPENLUP_E_SET_MISMATCH", package: "@openlup/platform", module: "identity", subject: mode === "missing-module" ? "contribution" : mode === "undeclared-entry" ? "dependency:foundation:./undeclared" : "dependency:foundation" })]));
  });
  it.each(["absent", "version", "timeout"])("attributes only identity's schema failure: %s", async mode => {
    const i = moduleInput(); i.probeTimeoutMs = 5;
    const observed: string[] = [];
    i.schemaProbe = { async observe(req) {
      observed.push(req.version);
      if (mode === "timeout" && req.version === "identity-1") return new Promise(() => {});
      return { database: "db-1", version: mode === "version" && req.version === "identity-1" ? "identity-0" : req.version, objects: req.objects.map(object => ({ object, present: !(mode === "absent" && req.version === "identity-1") })) };
    } };
    const report = await evaluateReadiness(i);
    expect(observed).toEqual(["foundation-1", "identity-1"]);
    expect(report.state).toBe(mode === "timeout" ? "unknown" : "unsatisfied");
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ code: "OPENLUP_E_SCHEMA_BEHIND", package: "@openlup/platform", module: "identity", subject: mode === "absent" ? "table:public.identity" : "identity-1" });
    expect(report.issues[0].fix).toContain("identity-0001.sql");
  });
  it.each(["emitter", "handler", "schedule", "route", "module"])("refuses duplicate %s ownership", async mode => {
    const i = moduleInput(), [foundation, identity] = i.contributions;
    if (mode === "emitter") identity.manifest.emits = foundation.manifest.emits;
    if (mode === "handler") { identity.manifest.handles = foundation.manifest.handles; identity.handlers = foundation.handlers; }
    if (mode === "schedule") { identity.manifest.schedules = foundation.manifest.schedules; identity.schedules = foundation.schedules; bindModules(i); }
    if (mode === "route") { identity.manifest.routes = foundation.manifest.routes; identity.routes = foundation.routes; bindModules(i); }
    if (mode === "module") i.contributions = [...i.contributions, foundation];
    const report = await evaluateReadiness(i);
    expect(report.state).toBe("unsatisfied");
    expect(report.issues.some(issue => issue.module && issue.code === (["emitter", "handler"].includes(mode) ? "OPENLUP_E_EVENT_DUPLICATE" : "OPENLUP_E_SET_MISMATCH"))).toBe(true);
    if (mode === "emitter") expect(report.issues.filter(issue => issue.code === "OPENLUP_E_EVENT_DUPLICATE").map(issue => issue.module)).toEqual(["foundation", "identity"]);
  });
  it.each(["version", "artifact", "artifact-kind", "unlisted", "port-key", "trigger-key", "route-key", "trigger-function", "route-function"])("refuses wrong module binding: %s", async mode => {
    const i = moduleInput(), c = i.contributions[1];
    if (mode === "version") c.manifest.version = "0.11.0";
    if (mode === "artifact") c.manifest.name = "@openlup/other";
    if (mode === "artifact-kind") c.manifest.kind = "capability";
    if (mode === "unlisted") c.manifest.module!.id = "unselected";
    const key = "@openlup/platform/identity:";
    if (mode === "port-key") i.bindings.ports = { "@openlup/platform/foundation:store": {}, "@openlup/platform:store": {} };
    if (mode === "trigger-key") i.bindings.triggers = { "@openlup/platform/foundation:foundation-schedule": run, "@openlup/platform:identity-schedule": run };
    if (mode === "route-key") i.bindings.routes = { "@openlup/platform/foundation:foundation-route": run, "@openlup/platform:identity-route": run };
    if (mode === "trigger-function") i.bindings.triggers = { ...i.bindings.triggers, [`${key}identity-schedule`]: () => undefined };
    if (mode === "route-function") i.bindings.routes = { ...i.bindings.routes, [`${key}identity-route`]: () => undefined };
    const report = await evaluateReadiness(i);
    expect(report.state).toBe("unsatisfied");
    expect(report.issues.some(issue => issue.module === "identity" || issue.module === "unselected")).toBe(true);
  });
  it("ignores disabled identity without its port, environment or schema probe", async () => {
    const i = moduleInput(); i.loadedPackages[1].modules = ["foundation"]; i.contributions = i.contributions.slice(0, 1);
    i.bindings.env = {}; bindModules(i);
    i.schemaProbe = { async observe(req) {
      expect(req.version).toBe("foundation-1");
      return { database: "db-1", version: req.version, objects: req.objects.map(object => ({ object, present: true })) };
    } };
    expect((await evaluateReadiness(i)).state).toBe("ready");
  });
  it.each(["mixed-set", "incomplete-inventory"])("retains artifact admission refusal: %s", async mode => {
    const i = moduleInput();
    if (mode === "mixed-set") i.loadedPackages[1].version = "0.11.0";
    else i.inventoryComplete = false;
    const report = await evaluateReadiness(i);
    expect(report.state).toBe(mode === "mixed-set" ? "unsatisfied" : "unknown");
    expect(report.issues.some(issue => issue.code === "OPENLUP_E_SET_MISMATCH")).toBe(true);
  });
  it.each(["duplicate-selection", "bad-id", "bad-kind", "duplicate-provides", "bad-entry", "duplicate-dependency", "duplicate-used-entry"])("validates optional module declarations: %s", async mode => {
    const i = moduleInput(), m = i.contributions[1].manifest.module!;
    if (mode === "duplicate-selection") i.loadedPackages[1].modules = ["identity", "identity"];
    if (mode === "bad-id") m.id = "identity:store";
    if (mode === "bad-kind") m.kind = "invalid" as never;
    if (mode === "duplicate-provides") m.provides = ["./identity/contracts", "./identity/contracts"];
    if (mode === "bad-entry") m.provides = ["./../escape"];
    if (mode === "duplicate-dependency") m.dependsOn = [m.dependsOn[0], m.dependsOn[0]];
    if (mode === "duplicate-used-entry") m.dependsOn = [{ module: "foundation", entries: ["./bff", "./bff"] }];
    expect((await evaluateReadiness(i)).state).not.toBe("ready");
  });
  it("keeps legacy and module artifacts in the same candidate", async () => {
    const i = moduleInput(), legacy = input();
    i.loadedPackages = [...i.loadedPackages, legacy.loadedPackages[1]];
    i.contributions = [...i.contributions, legacy.contributions[0]];
    i.bindings = {
      ports: { ...i.bindings.ports, ...legacy.bindings.ports },
      routes: { ...i.bindings.routes, ...legacy.bindings.routes },
      triggers: { ...i.bindings.triggers, ...legacy.bindings.triggers },
      env: { ...i.bindings.env, ...legacy.bindings.env },
    };
    expect((await evaluateReadiness(i)).state).toBe("ready");
  });
  it("attributes module event gaps and preserves owned exemptions", async () => {
    const i = moduleInput(); i.contributions[1].handlers = []; i.contributions[1].manifest.handles = [];
    const report = await evaluateReadiness(i);
    expect(report.issues).toEqual([expect.objectContaining({ code: "OPENLUP_E_EVENT_UNHANDLED", package: "@openlup/platform", module: "identity", subject: "identity.ready" })]);
    i.exemptions = [{ pattern: "identity.", prefix: true, owner: "application", reason: "Disabled consumer in this candidate", state: "dormant" }];
    expect((await evaluateReadiness(i)).state).toBe("ready");
  });
  it("accepts the root public entry as an explicit dependency contract", async () => {
    const i = moduleInput(); i.contributions[0].manifest.module!.provides = ["."];
    i.contributions[1].manifest.module!.dependsOn = [{ module: "foundation", entries: ["."] }];
    expect((await evaluateReadiness(i)).state).toBe("ready");
  });
  it("keeps artifact kernel exemptions independent from logical module kinds", async () => {
    const i = moduleInput();
    i.contributions[0].manifest.emits = i.contributions[1].manifest.emits;
    // Foundation's logical kernel kind cannot exempt a non-kernel artifact producer.
    expect((await evaluateReadiness(i)).issues.some(issue => issue.code === "OPENLUP_E_EVENT_DUPLICATE")).toBe(true);
    i.loadedPackages[1].kind = "kernel";
    for (const c of i.contributions) c.manifest.kind = "kernel";
    expect((await evaluateReadiness(i)).issues.some(issue => issue.code === "OPENLUP_E_SET_MISMATCH" && issue.subject === "version")).toBe(true);
  });
});

// Captured on pre-B0 main a711b9d, before editing any readiness source.
// JSON strings preserve the complete report and the original issue/property order.
const legacyGoldenReports = [
  {
    "case": "candidate readiness > checks inert observations without running handlers or jobs",
    "report": "{\"state\":\"ready\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[]}"
  },
  {
    "case": "candidate readiness > reports all seven issue classes in stable order",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/other\",\"version\":\"0.11.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/other\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_EVENT_DUPLICATE\",\"package\":\"@openlup/example,@openlup/other\",\"subject\":\"example.ready\",\"fix\":\"Use one non-kernel producer owner and one composed consumer per event.\"},{\"code\":\"OPENLUP_E_EVENT_DUPLICATE\",\"package\":\"@openlup/example,@openlup/other\",\"subject\":\"example.ready\",\"fix\":\"Use one non-kernel producer owner and one composed consumer per event.\"},{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"example.unhandled\",\"fix\":\"Register a handler or an explicit owned ignored/dormant declaration.\"},{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"store\",\"fix\":\"Bind the selected adapter port in composition.\"},{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/other\",\"subject\":\"store\",\"fix\":\"Bind the selected adapter port in composition.\"},{\"code\":\"OPENLUP_E_SCHEDULE_UNBOUND\",\"package\":\"@openlup/example\",\"subject\":\"dispatch\",\"fix\":\"Bind the actual schedule with its declared cadence to one host trigger.\"},{\"code\":\"OPENLUP_E_SCHEDULE_UNBOUND\",\"package\":\"@openlup/other\",\"subject\":\"dispatch\",\"fix\":\"Bind the actual schedule with its declared cadence to one host trigger.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"column:public.example.id\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"function:public.example_claim(integer)\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"table:public.example\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/other\",\"subject\":\"column:public.example.id\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/other\",\"subject\":\"function:public.example_claim(integer)\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/other\",\"subject\":\"table:public.example\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/other\",\"subject\":\"version\",\"fix\":\"Align the complete set: npm install @openlup/core@0.12.0 @openlup/example@0.12.0 @openlup/other@0.12.0\"}]}"
  },
  {
    "case": "candidate readiness > reports all seven issue classes in stable order",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/other\",\"version\":\"0.11.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/other\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_EVENT_DUPLICATE\",\"package\":\"@openlup/example,@openlup/other\",\"subject\":\"example.ready\",\"fix\":\"Use one non-kernel producer owner and one composed consumer per event.\"},{\"code\":\"OPENLUP_E_EVENT_DUPLICATE\",\"package\":\"@openlup/example,@openlup/other\",\"subject\":\"example.ready\",\"fix\":\"Use one non-kernel producer owner and one composed consumer per event.\"},{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"example.unhandled\",\"fix\":\"Register a handler or an explicit owned ignored/dormant declaration.\"},{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"store\",\"fix\":\"Bind the selected adapter port in composition.\"},{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/other\",\"subject\":\"store\",\"fix\":\"Bind the selected adapter port in composition.\"},{\"code\":\"OPENLUP_E_SCHEDULE_UNBOUND\",\"package\":\"@openlup/example\",\"subject\":\"dispatch\",\"fix\":\"Bind the actual schedule with its declared cadence to one host trigger.\"},{\"code\":\"OPENLUP_E_SCHEDULE_UNBOUND\",\"package\":\"@openlup/other\",\"subject\":\"dispatch\",\"fix\":\"Bind the actual schedule with its declared cadence to one host trigger.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"column:public.example.id\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"function:public.example_claim(integer)\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"table:public.example\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/other\",\"subject\":\"column:public.example.id\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/other\",\"subject\":\"function:public.example_claim(integer)\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/other\",\"subject\":\"table:public.example\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_absent\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/other\",\"subject\":\"version\",\"fix\":\"Align the complete set: npm install @openlup/core@0.12.0 @openlup/example@0.12.0 @openlup/other@0.12.0\"}]}"
  },
  {
    "case": "candidate readiness > refuses missing-core",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/core\",\"subject\":\"kernel\",\"fix\":\"Observe exactly one core kernel.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"version\",\"fix\":\"Align the complete set: npm install @openlup/example@<set-version>\"}]}"
  },
  {
    "case": "candidate readiness > refuses duplicate-package",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"inventory\",\"fix\":\"Observe each loaded package exactly once.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"manifest\",\"fix\":\"Match the contribution to its observed installed package.\"}]}"
  },
  {
    "case": "candidate readiness > refuses missing-contribution",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"example.ready\",\"fix\":\"Register a handler or an explicit owned ignored/dormant declaration.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"contribution\",\"fix\":\"Compose exactly one contribution for each loaded non-kernel package.\"}]}"
  },
  {
    "case": "candidate readiness > refuses missing-package",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"}],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"manifest\",\"fix\":\"Match the contribution to its observed installed package.\"}]}"
  },
  {
    "case": "candidate readiness > refuses incomplete-inventory",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/core\",\"subject\":\"inventory\",\"fix\":\"Observe the complete installed package inventory, including core.\"}]}"
  },
  {
    "case": "candidate readiness > refuses duplicate-contribution",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_DUPLICATE\",\"package\":\"@openlup/example,@openlup/example\",\"subject\":\"example.ready\",\"fix\":\"Use one non-kernel producer owner and one composed consumer per event.\"},{\"code\":\"OPENLUP_E_EVENT_DUPLICATE\",\"package\":\"@openlup/example,@openlup/example\",\"subject\":\"example.ready\",\"fix\":\"Use one non-kernel producer owner and one composed consumer per event.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"contribution\",\"fix\":\"Compose exactly one contribution for each loaded non-kernel package.\"}]}"
  },
  {
    "case": "candidate readiness > refuses set-mismatch",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.11.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"manifest\",\"fix\":\"Match the contribution to its observed installed package.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"version\",\"fix\":\"Align the complete set: npm install @openlup/core@0.12.0 @openlup/example@0.12.0\"}]}"
  },
  {
    "case": "candidate readiness > refuses probe throw while retaining binding errors",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"migration-1\",\"fix\":\"Observe the selected adapter and apply 0001.sql through your migration chain.\",\"observation\":\"probe_unavailable\"}]}"
  },
  {
    "case": "candidate readiness > refuses probe timeout while retaining binding errors",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"migration-1\",\"fix\":\"Observe the selected adapter and apply 0001.sql through your migration chain.\",\"observation\":\"probe_unavailable\"}]}"
  },
  {
    "case": "candidate readiness > refuses probe malformed while retaining binding errors",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"migration-1\",\"fix\":\"Return one valid observation for every requested schema object.\",\"observation\":\"probe_malformed_or_incomplete\"}]}"
  },
  {
    "case": "candidate readiness > refuses probe incomplete while retaining binding errors",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"migration-1\",\"fix\":\"Return one valid observation for every requested schema object.\",\"observation\":\"probe_malformed_or_incomplete\"}]}"
  },
  {
    "case": "candidate readiness > refuses probe duplicate while retaining binding errors",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"migration-1\",\"fix\":\"Return one valid observation for every requested schema object.\",\"observation\":\"probe_malformed_or_incomplete\"}]}"
  },
  {
    "case": "candidate readiness > refuses probe wrong-overload while retaining binding errors",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"migration-1\",\"fix\":\"Return one valid observation for every requested schema object.\",\"observation\":\"probe_malformed_or_incomplete\"}]}"
  },
  {
    "case": "candidate readiness > refuses probe unknown-version while retaining binding errors",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"migration-1\",\"fix\":\"Observe the exact candidate database and applied migration identity.\",\"observation\":\"identity_or_version_unknown\"}]}"
  },
  {
    "case": "candidate readiness > refuses probe wrong-database while retaining binding errors",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"migration-1\",\"fix\":\"Observe the exact candidate database and applied migration identity.\",\"observation\":\"identity_or_version_unknown\"}]}"
  },
  {
    "case": "candidate readiness > refuses probe unknown-object while retaining binding errors",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_ENV_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"EXAMPLE_OPTION\",\"fix\":\"Supply the named environment variable without exposing its value.\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"column:public.example.id\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_unknown\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"function:public.example_claim(integer)\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_unknown\"},{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/example\",\"subject\":\"table:public.example\",\"fix\":\"Apply 0001.sql for the selected adapter.\",\"observation\":\"object_unknown\"}]}"
  },
  {
    "case": "candidate readiness > keeps producer ownership distinct from consumer composition and owned exemptions",
    "report": "{\"state\":\"ready\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[]}"
  },
  {
    "case": "candidate readiness > keeps producer ownership distinct from consumer composition and owned exemptions",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"example.future\",\"fix\":\"Register a handler or an explicit owned ignored/dormant declaration.\"},{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"exemptions\",\"fix\":\"Supply explicit owned exemptions with reasons.\"}]}"
  },
  {
    "case": "candidate readiness > rejects malformed declarations and duplicate schema objects",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"example.ready\",\"fix\":\"Register a handler or an explicit owned ignored/dormant declaration.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/core\",\"subject\":\"manifest\",\"fix\":\"Supply a valid complete manifest with unique declarations.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"contribution\",\"fix\":\"Compose exactly one contribution for each loaded non-kernel package.\"}]}"
  },
  {
    "case": "candidate readiness > rejects malformed declarations and duplicate schema objects",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_DUPLICATE\",\"package\":\"@openlup/example\",\"subject\":\"example.ready\",\"fix\":\"Match each declared consumer to exactly one composed handler descriptor.\"},{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"example.ready\",\"fix\":\"Register a handler or an explicit owned ignored/dormant declaration.\"}]}"
  },
  {
    "case": "candidate readiness > probes actual qualified catalog identities with bound values",
    "report": "{\"state\":\"ready\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[]}"
  },
  {
    "case": "candidate readiness > malformed null-handler cannot admit or throw",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"@openlup/example\",\"fix\":\"Supply valid shared handler descriptors.\"},{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"example.ready\",\"fix\":\"Register a handler or an explicit owned ignored/dormant declaration.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"contribution\",\"fix\":\"Compose exactly one contribution for each loaded non-kernel package.\"}]}"
  },
  {
    "case": "candidate readiness > malformed null-schedule cannot admit or throw",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"example.ready\",\"fix\":\"Register a handler or an explicit owned ignored/dormant declaration.\"},{\"code\":\"OPENLUP_E_SCHEDULE_UNBOUND\",\"package\":\"@openlup/core\",\"subject\":\"@openlup/example\",\"fix\":\"Supply actual runnable schedules.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"contribution\",\"fix\":\"Compose exactly one contribution for each loaded non-kernel package.\"}]}"
  },
  {
    "case": "candidate readiness > malformed null-route cannot admit or throw",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"example.ready\",\"fix\":\"Register a handler or an explicit owned ignored/dormant declaration.\"},{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/core\",\"subject\":\"@openlup/example\",\"fix\":\"Supply actual route registrations.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/example\",\"subject\":\"contribution\",\"fix\":\"Compose exactly one contribution for each loaded non-kernel package.\"}]}"
  },
  {
    "case": "candidate readiness > malformed null-exemption cannot admit or throw",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"exemptions\",\"fix\":\"Supply explicit owned exemptions with reasons.\"}]}"
  },
  {
    "case": "candidate readiness > malformed bad-reason cannot admit or throw",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_EVENT_UNHANDLED\",\"package\":\"@openlup/core\",\"subject\":\"exemptions\",\"fix\":\"Supply explicit owned exemptions with reasons.\"}]}"
  },
  {
    "case": "candidate readiness > malformed fake-port cannot admit or throw",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"store\",\"fix\":\"Bind the selected adapter port in composition.\"}]}"
  },
  {
    "case": "candidate readiness > malformed bad-timeout cannot admit or throw",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/core\",\"subject\":\"probeTimeoutMs\",\"fix\":\"Use a bounded probe timeout from 1 to 30000 ms.\"}]}"
  },
  {
    "case": "candidate readiness > malformed no-probe cannot admit or throw",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SCHEMA_BEHIND\",\"package\":\"@openlup/core\",\"subject\":\"schemaProbe\",\"fix\":\"Bind a schema observation port.\"}]}"
  },
  {
    "case": "candidate readiness > malformed null-input cannot admit or throw",
    "report": "{\"state\":\"unknown\",\"loadedPackages\":[],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/core\",\"subject\":\"input\",\"fix\":\"Supply complete candidate observations.\"}]}"
  },
  {
    "case": "candidate readiness > refuses unrelated runnable schedule and route observations",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/example\",\"subject\":\"example-route\",\"fix\":\"Bind the declared route to its actual host entry.\"},{\"code\":\"OPENLUP_E_SCHEDULE_UNBOUND\",\"package\":\"@openlup/example\",\"subject\":\"dispatch\",\"fix\":\"Bind the actual schedule with its declared cadence to one host trigger.\"}]}"
  },
  {
    "case": "candidate readiness > refuses unrelated runnable schedule and route observations",
    "report": "{\"state\":\"ready\",\"candidate\":{\"artifact\":\"candidate-1\",\"configuration\":\"config-1\",\"environment\":\"test\",\"database\":\"db-1\",\"schema\":\"schema-1\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.12.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/example\",\"version\":\"0.12.0\",\"kind\":\"rail\"}],\"issues\":[]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission factory",
    "report": "{\"state\":\"ready\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission reference",
    "report": "{\"state\":\"ready\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission missing-store",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/outbox\",\"subject\":\"store\",\"fix\":\"Bind the selected adapter port in composition.\"}]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission missing-lease",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/outbox\",\"subject\":\"lease\",\"fix\":\"Bind the selected adapter port in composition.\"}]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission missing-compactor",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_PORT_MISSING\",\"package\":\"@openlup/outbox\",\"subject\":\"compactor\",\"fix\":\"Bind the selected adapter port in composition.\"}]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission missing-dispatch",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SCHEDULE_UNBOUND\",\"package\":\"@openlup/outbox\",\"subject\":\"outbox-dispatch\",\"fix\":\"Bind the actual schedule with its declared cadence to one host trigger.\"}]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission missing-prune",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SCHEDULE_UNBOUND\",\"package\":\"@openlup/outbox\",\"subject\":\"outbox-prune\",\"fix\":\"Bind the actual schedule with its declared cadence to one host trigger.\"}]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission wrong-core",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.0.1\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/outbox\",\"subject\":\"version\",\"fix\":\"Align the complete set: npm install @openlup/core@0.0.1 @openlup/outbox@0.0.1 @openlup/platform@0.0.1\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/platform\",\"subject\":\"version\",\"fix\":\"Align the complete set: npm install @openlup/core@0.0.1 @openlup/outbox@0.0.1 @openlup/platform@0.0.1\"}]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission wrong-outbox",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.0.1\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/outbox\",\"subject\":\"manifest\",\"fix\":\"Match the contribution to its observed installed package.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/outbox\",\"subject\":\"version\",\"fix\":\"Align the complete set: npm install @openlup/core@0.15.0 @openlup/outbox@0.15.0 @openlup/platform@0.15.0\"}]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission wrong-platform",
    "report": "{\"state\":\"unsatisfied\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.0.1\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/platform\",\"subject\":\"manifest\",\"fix\":\"Match the contribution to its observed installed package.\"},{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/platform\",\"subject\":\"version\",\"fix\":\"Align the complete set: npm install @openlup/core@0.15.0 @openlup/outbox@0.15.0 @openlup/platform@0.15.0\"}]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission incomplete",
    "report": "{\"state\":\"unknown\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"},{\"name\":\"@openlup/platform\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[{\"code\":\"OPENLUP_E_SET_MISMATCH\",\"package\":\"@openlup/core\",\"subject\":\"inventory\",\"fix\":\"Observe the complete installed package inventory, including core.\"}]}"
  },
  {
    "case": "candidate readiness > legacy outbox/admission no-platform",
    "report": "{\"state\":\"ready\",\"candidate\":{\"artifact\":\"one\",\"configuration\":\"one\",\"environment\":\"test\",\"database\":\"test-db\",\"schema\":\"one\"},\"loadedPackages\":[{\"name\":\"@openlup/core\",\"version\":\"0.15.0\",\"kind\":\"kernel\"},{\"name\":\"@openlup/outbox\",\"version\":\"0.15.0\",\"kind\":\"rail\"}],\"issues\":[]}"
  }
];

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
