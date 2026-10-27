import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** Describe existing selected marketing callables; never install another executor. */
export function createMarketingContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  marketing: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  handlers: Contribution["handlers"];
  schedules: Contribution["schedules"];
  routes: Contribution["routes"];
}) {
  for (const [kind, names] of [
    ["handler", input.handlers.map(handler => handler.eventType)],
    ["schedule", input.schedules.map(schedule => schedule.id)],
    ["route", input.routes.map(route => route.id)],
  ] as const) {
    if (new Set(names).size !== names.length) throw new Error(`marketing_duplicate_${kind}`);
  }
  const contribution: Contribution = {
    manifest: {
      name: "@openlup/platform", version: input.version, kind: "rail",
      module: { id: "marketing", kind: "capability", provides: ["./marketing", "./marketing/contracts", "./marketing/server"],
        // The server entry validates obligations with identity's runtime contract schema.
        dependsOn: [{ module: "identity", entries: ["./identity/contracts"] }] },
      emits: [], handles: input.handlers.map(handler => handler.eventType),
      schedules: input.schedules.map(({ id, cadenceSeconds }) => ({ id, cadenceSeconds })), env: [],
      requiredPorts: Object.keys(input.marketing), routes: input.routes.map(route => route.id), requiredSchema: input.requiredSchema,
    },
    handlers: input.handlers.map(({ eventType, timeoutMs }) => Object.freeze({ eventType, timeoutMs })), schedules: input.schedules, routes: input.routes,
  };
  return {
    contributions: [contribution],
    ports: Object.fromEntries(Object.entries(input.marketing).filter(([, fn]) => typeof fn === "function").map(([name, fn]) => [`@openlup/platform/marketing:${name}`, fn])),
    routes: Object.fromEntries(input.routes.map(route => [`@openlup/platform/marketing:${route.id}`, route.handle])),
    triggers: Object.fromEntries(input.schedules.map(schedule => [`@openlup/platform/marketing:${schedule.id}`, schedule.run])),
  };
}
