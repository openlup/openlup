import { describe, expect, it, vi } from "vitest";
import type { ReadinessInput } from "@openlup/core/readiness";
import { verifyApp } from "../../src/lifecycle/appVerification.js";

function composition(): ReadinessInput {
  const neverRun = vi.fn(() => { throw new Error("diagnosis executed an effect"); });
  const requiredSchema = { version: "schema-current", migration: "app-migrations/current.sql", objects: [{ kind: "table" as const, name: "public.orders" }] };
  return {
    candidate: { artifact: "app-1", configuration: "config-1", environment: "local", database: "db-local", schema: "schema-current" },
    inventoryComplete: true,
    loadedPackages: [
      { name: "@openlup/core", version: "0.36.0", kind: "kernel" },
      { name: "@openlup/platform", version: "0.36.0", kind: "rail", modules: ["commerce"] },
    ],
    contributions: [{
      manifest: {
        name: "@openlup/platform", version: "0.36.0", kind: "rail",
        module: { id: "commerce", kind: "capability", provides: ["./commerce"], dependsOn: [] },
        requiredSchema, requiredPorts: ["orders"], emits: [], handles: [], env: [], routes: ["orders"],
        schedules: [{ id: "order-expiry", cadenceSeconds: 60 }],
      },
      handlers: [], schedules: [{ id: "order-expiry", cadenceSeconds: 60, run: neverRun }],
      routes: [{ id: "orders", handle: neverRun }],
    }],
    vocabulary: [], exemptions: [],
    bindings: { ports: {}, routes: { "@openlup/platform/commerce:orders": neverRun }, triggers: {}, env: {} },
    schemaProbe: { observe: vi.fn(async () => ({ database: "db-local", version: "schema-old", objects: [{ object: requiredSchema.objects[0]!, present: true }] })) },
  };
}

describe("composed application diagnosis", () => {
  it("reports the binder, stale schema and unwired schedule from existing readiness, then turns green after repair", async () => {
    const input = composition();
    const report = await verifyApp(input);
    expect(report.state).toBe("unsatisfied");
    expect(report.findings.map(item => item.code).sort()).toEqual(["OPENLUP_E_PORT_MISSING", "OPENLUP_E_SCHEDULE_UNBOUND", "OPENLUP_E_SCHEMA_BEHIND"]);
    for (const finding of report.findings) {
      expect(finding.observed).toBeTruthy();
      expect(finding.cause).toBeTruthy();
      expect(finding.fix).toBeTruthy();
      expect(finding.recheck).toContain("openlup verify");
      expect(finding.evidence.declared).toBeTruthy();
      expect(finding.evidence.bound).toBeTruthy();
      expect(finding.evidence.checked).toBeTruthy();
      expect(finding.evidence.unknown.length).toBeGreaterThan(0);
    }
    const port = report.findings.find(item => item.code === "OPENLUP_E_PORT_MISSING")!;
    expect(port.fix).toContain('bindings.ports["@openlup/platform/commerce:orders"]');
    const schedule = report.findings.find(item => item.code === "OPENLUP_E_SCHEDULE_UNBOUND")!;
    expect(schedule.fix).toContain('bindings.triggers["@openlup/platform/commerce:order-expiry"]');
    const schema = report.findings.find(item => item.code === "OPENLUP_E_SCHEMA_BEHIND")!;
    expect(schema.fix).toContain("app-migrations/current.sql");
    expect(schema.observed).toContain('"schema-old"');
    expect(schema.observed).toContain('"schema-current"');

    input.bindings = { ...input.bindings,
      ports: { "@openlup/platform/commerce:orders": { read: () => [] } },
      triggers: { "@openlup/platform/commerce:order-expiry": input.contributions[0]!.schedules[0]!.run },
    };
    input.schemaProbe = { observe: async requirement => ({ database: input.candidate.database, version: requirement.version, objects: requirement.objects.map(object => ({ object, present: true })) }) };
    expect((await verifyApp(input)).state).toBe("ready");
    expect((await verifyApp(input)).findings).toEqual([]);
    input.bindings = { ...input.bindings, routes: {} };
    const routeReport = await verifyApp(input);
    expect(routeReport.findings).toHaveLength(1);
    expect(routeReport.findings[0]!.fix).toContain('bindings.routes["@openlup/platform/commerce:orders"]');
    expect(routeReport.findings[0]!.observed).toContain("object/function supplied");
    expect(routeReport.findings[0]!.cause).toContain("route handler");
    expect(input.contributions[0]!.schedules[0]!.run).not.toHaveBeenCalled();
    expect(input.contributions[0]!.routes[0]!.handle).not.toHaveBeenCalled();
  });

  it("does not turn declaration-only ports or different schedule callables into bindings", async () => {
    const input = composition();
    input.bindings = { ...input.bindings,
      ports: { "@openlup/platform/commerce:orders": "orders-adapter" },
      triggers: { "@openlup/platform/commerce:order-expiry": () => undefined },
    };
    const report = await verifyApp(input);
    expect(report.findings.map(item => item.code)).toContain("OPENLUP_E_PORT_MISSING");
    expect(report.findings.map(item => item.code)).toContain("OPENLUP_E_SCHEDULE_UNBOUND");
  });

  it("keeps an unavailable or wrong-database schema unknown without leaking probe errors", async () => {
    const input = composition();
    input.schemaProbe = { observe: async () => { throw new Error("synthetic-private-connection-detail"); } };
    const report = await verifyApp(input);
    expect(report.state).toBe("unknown");
    expect(JSON.stringify(report)).not.toContain("synthetic-private-connection-detail");
    const schema = report.findings.find(item => item.code === "OPENLUP_E_SCHEMA_BEHIND")!;
    expect(schema.observed).toBe("probe_unavailable");
    expect(schema.evidence.checked).toContain("Unknown");
    input.schemaProbe = { observe: async requirement => ({ database: "other-database", version: requirement.version, objects: requirement.objects.map(object => ({ object, present: true })) }) };
    expect((await verifyApp(input)).state).toBe("unknown");
  });
});
