import { checkReadiness, type ReadinessInput } from "@openlup/core/readiness";
import type { OutboxHandler } from "@openlup/core/outbox";
import { expect, it, vi } from "vitest";
import { createMarketingContribution } from "../../src/composition/index.js";

const schema = { version: "complete", migration: "host", objects: [] };

it("describes the installed entries and shares existing callables without invoking them", () => {
  const run = vi.fn(async () => ({ kind: "processed" as const }));
  const handler: OutboxHandler = { eventType: "marketing.fact.recorded", timeoutMs: 1000, handle: run };
  const result = createMarketingContribution({ version: "0.1.0", requiredSchema: schema, marketing: { execute: run, missing: null },
    handlers: [handler], routes: [{ id: "selected", handle: run }], schedules: [{ id: "selected", cadenceSeconds: 60, run }],
  });
  expect(result.contributions[0].manifest).toEqual({ name: "@openlup/platform", version: "0.1.0", kind: "rail",
    module: { id: "marketing", kind: "capability", provides: ["./marketing", "./marketing/contracts"], dependsOn: [] },
    emits: [], handles: ["marketing.fact.recorded"], schedules: [{ id: "selected", cadenceSeconds: 60 }], env: [],
    requiredPorts: ["execute", "missing"], routes: ["selected"], requiredSchema: schema,
  });
  expect(result.contributions[0].handlers).toEqual([{ eventType: handler.eventType, timeoutMs: 1000 }]);
  expect(result.contributions[0].handlers[0]).not.toHaveProperty("handle");
  expect(result.contributions[0].handlers[0]).not.toBe(handler);
  expect(Object.isFrozen(result.contributions[0].handlers[0])).toBe(true);
  expect(result.ports).toEqual({ "@openlup/platform/marketing:execute": run });
  expect(result.routes["@openlup/platform/marketing:selected"]).toBe(run);
  expect(result.triggers["@openlup/platform/marketing:selected"]).toBe(run);
  expect(run).not.toHaveBeenCalled();
});

it("keeps a null port required and lets Core report the missing binding", async () => {
  const result = createMarketingContribution({ version: "0.1.0", requiredSchema: schema, marketing: { execute: null },
    handlers: [], schedules: [], routes: [],
  });
  const input: ReadinessInput = {
    candidate: { artifact: "artifact", configuration: "config", environment: "local", database: "db", schema: "complete" }, inventoryComplete: true,
    loadedPackages: [{ name: "@openlup/core", kind: "kernel", version: "0.1.0" }, { name: "@openlup/platform", kind: "rail", version: "0.1.0", modules: ["marketing"] }],
    contributions: result.contributions, vocabulary: [], exemptions: [],
    bindings: { ports: result.ports, routes: result.routes, triggers: result.triggers, env: {} },
    schemaProbe: { observe: async () => ({ database: "db", version: schema.version, objects: [] }) },
  };
  expect(result.contributions[0].manifest.requiredPorts).toEqual(["execute"]);
  expect(result.ports).toEqual({});
  const report = await checkReadiness(input);
  expect(report.state).toBe("unsatisfied");
  expect(report.issues).toEqual([expect.objectContaining({ code: "OPENLUP_E_PORT_MISSING", subject: "execute", module: "marketing" })]);
});

it("refuses duplicate handler, schedule and route identities", () => {
  const run = vi.fn(), handler = { eventType: "marketing.fact.recorded", timeoutMs: 1000 };
  const schedule = { id: "selected", cadenceSeconds: 60, run }, route = { id: "selected", handle: run };
  for (const kind of ["handler", "schedule", "route"] as const) {
    expect(() => createMarketingContribution({ version: "0.1.0", requiredSchema: schema, marketing: { run },
      handlers: kind === "handler" ? [handler, handler] : [],
      schedules: kind === "schedule" ? [schedule, schedule] : [], routes: kind === "route" ? [route, route] : [],
    })).toThrow(`marketing_duplicate_${kind}`);
  }
  expect(run).not.toHaveBeenCalled();
});
