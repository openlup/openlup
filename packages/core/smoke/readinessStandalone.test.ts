import { describe, expect, it } from "vitest";
import { PLATFORM_OUTBOX_EVENT_TYPES, type OutboxEventTypeDeclaration, type OutboxHandler } from "@openlup/core/outbox";
import type { SqlExecutor } from "@openlup/core/platform-runtime";
import {
  READINESS_CODES,
  buildSchemaProbe,
  checkReadiness,
  readSchemaProbe,
  type Contribution,
  type PackageManifest,
  type ReadinessInput,
  type RequiredSchemaObject,
  type ScheduleDeclaration,
  type SchemaProbePort,
} from "@openlup/core/readiness";

// The codes are public API: renaming or removing one is a breaking change.
const PUBLIC_CODES =
  '{"PORT_MISSING":"OPENLUP_E_PORT_MISSING","EVENT_UNHANDLED":"OPENLUP_E_EVENT_UNHANDLED","EVENT_DUPLICATE":"OPENLUP_E_EVENT_DUPLICATE","SCHEDULE_UNBOUND":"OPENLUP_E_SCHEDULE_UNBOUND","SCHEMA_BEHIND":"OPENLUP_E_SCHEMA_BEHIND","SET_MISMATCH":"OPENLUP_E_SET_MISMATCH","ENV_MISSING":"OPENLUP_E_ENV_MISSING"}';

const RAIL = "@openlup/example-rail";
const CAPABILITY = "@openlup/example-capability";
const EXAMPLE_EVENT = "example.item.created";

const handlerFor = (eventType: string): OutboxHandler => ({
  eventType,
  timeoutMs: 1000,
  handle: async () => ({ kind: "processed" }),
});

const schedule: ScheduleDeclaration<"processed"> = {
  jobId: "example-dispatch",
  schedule: "*/5 * * * *",
  run: async () => ({ outcome: "processed", detail: { claimed: 0 } }),
};

const requiredObjects: RequiredSchemaObject[] = [
  { kind: "table", name: "public.example_events" },
  { kind: "column", name: "public.example_events.metadata" },
  { kind: "function", name: "public.example_claim", signature: "text[], integer" },
];

function railManifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    name: RAIL,
    version: "0.13.0",
    events: { handles: [EXAMPLE_EVENT], emits: [EXAMPLE_EVENT] },
    schedules: [{ jobId: schedule.jobId, schedule: schedule.schedule }],
    routes: [{ method: "POST", path: "/example" }],
    ports: [{ name: "store", wired: true }, { name: "lease", wired: true }],
    requiredSchema: { version: "0001_example_rail", objects: requiredObjects },
    env: ["EXAMPLE_SIGNING_KEY"],
    ...overrides,
  };
}

function capabilityManifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    name: CAPABILITY,
    version: "0.13.0",
    events: { handles: [], emits: ["commerce.order.paid"] },
    schedules: [],
    routes: [],
    ports: [{ name: "payments", wired: true }],
    requiredSchema: null,
    env: [],
    ...overrides,
  };
}

function rail(manifest = railManifest(), schedules: ScheduleDeclaration[] = [schedule]): Contribution {
  return {
    handlers: [handlerFor(EXAMPLE_EVENT)],
    schedules,
    routes: [{ method: "POST", path: "/example", handle: () => undefined }],
    manifest,
  };
}

function capability(manifest = capabilityManifest()): Contribution {
  return { handlers: [handlerFor("commerce.order.paid")], schedules: [], routes: [], manifest };
}

// Every platform type this example application does not handle is declared,
// by namespace prefix, so the complete composition is ready.
const declarations: OutboxEventTypeDeclaration[] = ["channel.", "commerce.", "personalization.", "subscription."].map(
  (eventType) => ({ eventType, state: "ignored", owner: eventType.slice(0, -1), reason: "Not composed here." }),
);

function probeOf(missing: ReadonlyArray<string> = []): SchemaProbePort & { calls: number } {
  const port = {
    calls: 0,
    probe: async (objects: ReadonlyArray<RequiredSchemaObject>) => {
      port.calls += 1;
      return objects.map((object) => !missing.includes(object.name));
    },
  };
  return port;
}

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    contributions: [rail(), capability()],
    env: { EXAMPLE_SIGNING_KEY: "configured" },
    schemaProbe: probeOf(),
    boundSchedules: [schedule.jobId],
    eventTypeDeclarations: declarations,
    packages: [{ name: "@openlup/core", version: "0.13.0" }],
    ...overrides,
  };
}

const codesOf = async (value: ReadinessInput): Promise<string[]> =>
  (await checkReadiness(value)).failures.map((failure) => failure.code);

describe("readiness standalone", () => {
  it("pins the public readiness codes byte for byte", () => {
    expect(JSON.stringify(READINESS_CODES)).toBe(PUBLIC_CODES);
    expect(Object.isFrozen(READINESS_CODES)).toBe(true);
  });

  it("passes a complete composition and reports its declared event types", async () => {
    const probe = probeOf();
    const report = await checkReadiness(input({ schemaProbe: probe }));

    expect(report).toMatchObject({ ok: true, failures: [] });
    expect(probe.calls).toBe(1);
    const declared = report.declared.map((entry) => entry.eventType);
    expect(declared).toHaveLength(PLATFORM_OUTBOX_EVENT_TYPES.length - 1);
    expect(declared).not.toContain("commerce.order.paid");
    expect(report.declared[0]).toEqual({ eventType: "channel.order.ingested", declaration: declarations[0] });
  });

  it("raises PORT_MISSING for a port supplied empty", async () => {
    const report = await checkReadiness(input({
      contributions: [rail(railManifest({ ports: [{ name: "store", wired: false }, { name: "lease", wired: true }] })), capability()],
    }));

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([{
      code: "OPENLUP_E_PORT_MISSING",
      package: RAIL,
      subject: "store",
      fix: `Pass a store port to the ${RAIL} factory.`,
    }]);
  });

  it("raises EVENT_UNHANDLED for an emitted type and for an undeclared platform type", async () => {
    const withoutHandler: Contribution = { ...rail(), handlers: [] };
    const report = await checkReadiness(input({
      contributions: [withoutHandler, capability()],
      eventTypeDeclarations: declarations.filter((entry) => entry.eventType !== "personalization."),
    }));

    expect(report.failures).toEqual([
      {
        code: "OPENLUP_E_EVENT_UNHANDLED",
        package: "@openlup/core",
        subject: "personalization.declension_requested",
        fix: "Compose a handler for personalization.declension_requested (platform event type, owner personalization), or declare it ignored or dormant.",
      },
      {
        code: "OPENLUP_E_EVENT_UNHANDLED",
        package: RAIL,
        subject: EXAMPLE_EVENT,
        fix: `Compose a handler for ${EXAMPLE_EVENT} (emitted by ${RAIL}), or declare it ignored or dormant.`,
      },
    ]);
  });

  it("names the claimant of an unhandled platform type, and a package that declared it handled", async () => {
    // A manifest claims a kernel-listed type it emits: the fix names that package, not the namespace.
    const silentCapability: Contribution = { ...capability(), handlers: [] };
    const allButPaid: OutboxEventTypeDeclaration[] = [
      ...declarations.filter((entry) => entry.eventType !== "commerce."),
      ...PLATFORM_OUTBOX_EVENT_TYPES.filter((entry) => entry.owner === "commerce" && entry.eventType !== "commerce.order.paid")
        .map((entry): OutboxEventTypeDeclaration => ({ eventType: entry.eventType, state: "ignored", owner: "commerce", reason: "Not composed here." })),
    ];
    const claimed = await checkReadiness(input({ contributions: [rail(), silentCapability], eventTypeDeclarations: allButPaid }));

    expect(claimed.failures).toEqual([{
      code: "OPENLUP_E_EVENT_UNHANDLED",
      package: CAPABILITY,
      subject: "commerce.order.paid",
      fix: `Compose a handler for commerce.order.paid (emitted by ${CAPABILITY}), or declare it ignored or dormant.`,
    }]);

    const promised = rail(railManifest({ events: { handles: [EXAMPLE_EVENT, "example.item.audited"], emits: [EXAMPLE_EVENT] } }));
    const declaredOnly = await checkReadiness(input({ contributions: [promised, capability()] }));
    expect(declaredOnly.failures.map(({ package: pkg, fix }) => [pkg, fix])).toEqual([[
      RAIL,
      `Compose a handler for example.item.audited (declared handled by ${RAIL}), or declare it ignored or dormant.`,
    ]]);
  });

  it("raises EVENT_DUPLICATE only for two non-kernel owners", async () => {
    // A manifest may claim a kernel-listed type it emits: one claimant is ready.
    await expect(codesOf(input())).resolves.toEqual([]);

    const second = capability(capabilityManifest({ name: "@openlup/example-second", events: { handles: [], emits: ["commerce.order.paid"] } }));
    const report = await checkReadiness(input({ contributions: [rail(), capability(), second] }));

    expect(report.failures.map(({ code, package: pkg, subject }) => [code, pkg, subject])).toEqual([
      ["OPENLUP_E_EVENT_DUPLICATE", CAPABILITY, "commerce.order.paid"],
      ["OPENLUP_E_EVENT_DUPLICATE", "@openlup/example-second", "commerce.order.paid"],
    ]);
    expect(report.failures[0].fix).toBe(
      `Keep commerce.order.paid in the emits of one package only; ${CAPABILITY}, @openlup/example-second all claim it.`,
    );
  });

  it("raises SCHEDULE_UNBOUND for a declared schedule without a trigger", async () => {
    const report = await checkReadiness(input({ boundSchedules: [] }));

    expect(report.failures).toEqual([{
      code: "OPENLUP_E_SCHEDULE_UNBOUND",
      package: RAIL,
      subject: "example-dispatch",
      fix: "Bind example-dispatch to a host trigger running at */5 * * * *.",
    }]);
    // A schedule the contribution runs but its manifest omits still needs a trigger.
    const undeclared = rail(railManifest({ schedules: [] }));
    await expect(codesOf(input({ contributions: [undeclared, capability()], boundSchedules: [] }))).resolves.toEqual([
      "OPENLUP_E_SCHEDULE_UNBOUND",
    ]);
  });

  it("raises SCHEMA_BEHIND for each missing object, naming the migration", async () => {
    const report = await checkReadiness(input({ schemaProbe: probeOf(["public.example_claim"]) }));

    expect(report.failures).toEqual([{
      code: "OPENLUP_E_SCHEMA_BEHIND",
      package: RAIL,
      subject: "function public.example_claim(text[], integer)",
      fix: `Apply ${RAIL}'s migrations up to 0001_example_rail, then run readiness again.`,
    }]);
  });

  it("raises SET_MISMATCH with one install command, and ignores packages outside the set", async () => {
    const report = await checkReadiness(input({
      contributions: [rail(railManifest({ version: "0.12.0" })), capability()],
      packages: [{ name: "@openlup/core", version: "0.13.0" }, { name: "example-adopter-extension", version: "2.0.0" }],
    }));
    const command = "npm install --save-exact @openlup/core@0.13.0 @openlup/example-capability@0.13.0 @openlup/example-rail@0.13.0";

    expect(report.failures).toEqual([{
      code: "OPENLUP_E_SET_MISMATCH",
      package: RAIL,
      subject: `${RAIL}@0.12.0`,
      fix: `Run ${command} so every @openlup package is 0.13.0.`,
    }]);
  });

  it("never targets a pre-release, and ranks it below its release", async () => {
    const versionsOf = async (rail0: string, capability0: string, core: string) => {
      const report = await checkReadiness(input({
        contributions: [rail(railManifest({ version: rail0 })), capability(capabilityManifest({ version: capability0 }))],
        packages: [{ name: "@openlup/core", version: core }],
      }));
      return report.failures.map(({ subject, fix }) => [subject, fix.match(/@openlup\/core@(\S+)/)?.[1]]);
    };

    // 0.13.0-rc.1 ranks below 0.13.0.
    await expect(versionsOf("0.13.0-rc.1", "0.13.0", "0.13.0")).resolves.toEqual([[`${RAIL}@0.13.0-rc.1`, "0.13.0"]]);
    // A newer pre-release does not pull the set forward: the newest release is the target.
    await expect(versionsOf("0.13.0-rc.1", "0.12.0", "0.12.0")).resolves.toEqual([[`${RAIL}@0.13.0-rc.1`, "0.12.0"]]);
    // With no set version loaded, precedence decides: rc.10 is above rc.2, numerically ...
    await expect(versionsOf("0.13.0-rc.2", "0.13.0-rc.10", "0.13.0-rc.2")).resolves.toEqual([
      [`@openlup/core@0.13.0-rc.2`, "0.13.0-rc.10"],
      [`${RAIL}@0.13.0-rc.2`, "0.13.0-rc.10"],
    ]);
    // ... and a pre-release ranks below the same version without one.
    await expect(versionsOf("0.13.0+local.1", "0.13.0-rc.1", "0.13.0-rc.1")).resolves.toEqual([
      [`@openlup/core@0.13.0-rc.1`, "0.13.0+local.1"],
      [`${CAPABILITY}@0.13.0-rc.1`, "0.13.0+local.1"],
    ]);
  });

  it("raises ENV_MISSING for an absent or blank variable", async () => {
    await expect(codesOf(input({ env: {} }))).resolves.toEqual(["OPENLUP_E_ENV_MISSING"]);
    const report = await checkReadiness(input({ env: { EXAMPLE_SIGNING_KEY: "  " } }));
    expect(report.failures).toEqual([{
      code: "OPENLUP_E_ENV_MISSING",
      package: RAIL,
      subject: "EXAMPLE_SIGNING_KEY",
      fix: "Set EXAMPLE_SIGNING_KEY in this deployment's environment.",
    }]);
  });

  it("reports every failure at once, in code order", async () => {
    const broken = rail(railManifest({
      version: "0.12.0",
      ports: [{ name: "store", wired: false }],
    }), [schedule]);
    const report = await checkReadiness(input({
      contributions: [{ ...broken, handlers: [] }, capability()],
      env: {},
      schemaProbe: probeOf(["public.example_events"]),
      boundSchedules: [],
      eventTypeDeclarations: [],
    }));
    const codes = [...new Set(report.failures.map((failure) => failure.code))];

    expect(codes).toEqual(Object.values(READINESS_CODES).filter((code) => code !== "OPENLUP_E_EVENT_DUPLICATE"));
    // Every platform type but the handled one, plus the rail's own type.
    expect(report.failures.filter((failure) => failure.code === "OPENLUP_E_EVENT_UNHANDLED")).toHaveLength(PLATFORM_OUTBOX_EVENT_TYPES.length);
    expect(report.declared).toEqual([]);
  });

  it("skips the probe when no contribution requires schema", async () => {
    const probe = probeOf();
    const report = await checkReadiness(input({
      contributions: [capability()],
      schemaProbe: probe,
      boundSchedules: [],
      env: {},
    }));

    expect(report.ok).toBe(true);
    expect(probe.calls).toBe(0);
  });

  it("refuses a malformed declaration or probe answer instead of guessing", async () => {
    for (const eventType of [".", "", " commerce.", "commerce..", "commerce..order"]) {
      await expect(checkReadiness(input({
        eventTypeDeclarations: [{ eventType, state: "ignored", owner: "example", reason: "reason" }],
      }))).rejects.toThrow(TypeError);
    }
    await expect(checkReadiness(input({
      eventTypeDeclarations: [{ eventType: "commerce.", state: "ignored", owner: " ", reason: "reason" }],
    }))).rejects.toThrow(TypeError);
    await expect(checkReadiness(input({
      schemaProbe: { probe: async () => [true] },
    }))).rejects.toThrow("schema probe answered 1 of 3 objects");
  });

  it("accepts only true or false from the probe, so a missing object never reads as present", async () => {
    for (const answer of ["f", "no", 0, 1, null]) {
      const probe: SchemaProbePort = { probe: async () => [true, answer, true] as unknown as boolean[] };
      await expect(checkReadiness(input({ schemaProbe: probe }))).rejects.toThrow(
        `schema probe answered ${JSON.stringify(answer)} for object 2; only true or false is an answer`,
      );
    }
  });
});

describe("schema probe builder and reader", () => {
  it("builds one parameterised catalogue query", () => {
    const query = buildSchemaProbe([
      ...requiredObjects,
      { kind: "table", name: "example_events" },
      { kind: "function", name: "example_noop", signature: "" },
      { kind: "function", name: "example_any" },
      { kind: "function", name: "example_padded", signature: " Timestamp   With Time Zone ,UUID " },
    ]);

    expect(query.values).toEqual([
      ["table", "column", "function", "table", "function", "function", "function"],
      ["public", "public", "public", null, null, null, null],
      ["example_events", "example_events", "example_claim", "example_events", "example_noop", "example_any", "example_padded"],
      [null, "metadata", null, null, null, null, null],
      [null, null, "text[], integer", null, "", null, "timestamp with time zone, uuid"],
    ]);
    expect(query.text).toContain("FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])");
    expect(query.text).toContain("pg_catalog.oidvectortypes(p.proargtypes) = probe.signature");
    expect(query.text).not.toMatch(/example_/);
  });

  it("pins each catalogue predicate in the branch it guards", () => {
    const text = buildSchemaProbe([]).text.replace(/\s+/g, " ");
    const [, table, column, fn] = text.split(/WHEN '(?:table|column|function)' THEN/);
    const searchPath =
      "CASE WHEN probe.schema_name IS NULL THEN n.nspname = ANY (pg_catalog.current_schemas(false)) ELSE n.nspname = probe.schema_name END";

    // A table is a relation of a table-like kind: not an index, sequence or type.
    expect(table).toContain("c.relkind IN ('r', 'p', 'v', 'm', 'f')");
    // A column is a user column that still exists: not a system column, not a dropped one.
    expect(column).toContain("a.attnum > 0");
    expect(column).toContain("NOT a.attisdropped");
    // A function matches its argument types when a signature is given.
    expect(fn).toContain("probe.signature IS NULL OR pg_catalog.oidvectortypes(p.proargtypes) = probe.signature");
    // Every branch resolves an unqualified name through the search path only.
    for (const branch of [table, column, fn]) expect(branch).toContain(searchPath);
  });

  it("refuses names it cannot probe exactly", () => {
    for (const object of [
      { kind: "table", name: "Example_Events" },
      { kind: "table", name: "a.b.c" },
      { kind: "column", name: "example_events" },
      { kind: "column", name: "a.b.c.d" },
      { kind: "function", name: "example_claim; drop table x" },
      { kind: "table", name: "example_events", signature: "integer" },
      { kind: "index", name: "example_events_pkey" },
    ] as RequiredSchemaObject[]) {
      expect(() => buildSchemaProbe([object])).toThrow(TypeError);
    }
  });

  it("reads one flag per object in request order", () => {
    expect(readSchemaProbe({ rows: [
      { index: 2, present: false },
      { index: "1", present: true },
      { index: 3, present: true },
    ] }, 3)).toEqual([true, false, true]);
    expect(readSchemaProbe({ rows: [] }, 0)).toEqual([]);
  });

  it("refuses rows that are not the probe's complete answer", () => {
    for (const rows of [
      [{ index: 1, present: true }],
      [{ index: 1, present: true }, { index: 1, present: false }],
      [{ index: 1, present: "true" }, { index: 2, present: true }],
      [{ index: 0, present: true }, { index: 1, present: true }],
      [{ index: 1, present: true }, { index: 3, present: true }],
    ]) {
      expect(() => readSchemaProbe({ rows }, 2)).toThrow(TypeError);
    }
  });

  it("composes into a probe port over a structural executor", async () => {
    const seen: Array<{ text: string; values?: ReadonlyArray<unknown> }> = [];
    const sql: SqlExecutor = {
      query: async (text, values) => {
        seen.push({ text, values });
        return { rows: [{ index: 1, present: true }, { index: 2, present: false }, { index: 3, present: true }] };
      },
    };
    const port: SchemaProbePort = {
      probe: async (objects) => {
        const query = buildSchemaProbe(objects);
        return readSchemaProbe(await sql.query(query.text, query.values), objects.length);
      },
    };

    await expect(port.probe(requiredObjects)).resolves.toEqual([true, false, true]);
    expect(seen).toHaveLength(1);
    expect(seen[0].values).toEqual(buildSchemaProbe(requiredObjects).values);
  });
});
