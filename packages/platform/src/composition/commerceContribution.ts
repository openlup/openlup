import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** Describe existing selected commerce callables; never install another executor. */
export function createCommerceContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  commerce: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  handlers: Contribution["handlers"];
  schedules: Contribution["schedules"];
  routes: Contribution["routes"];
}) {
  for (const [kind, names] of [
    ["handler", input.handlers.map(handler => handler.eventType)],
    ["schedule", input.schedules.map(schedule => schedule.id)],
    ["route", input.routes.map(route => route.id)],
  ] as const) {
    if (new Set(names).size !== names.length) throw new Error(`commerce_duplicate_${kind}`);
  }
  const contribution: Contribution = {
    manifest: {
      name: "@openlup/platform", version: input.version, kind: "rail",
      module: { id: "commerce", kind: "capability", provides: ["./commerce", "./commerce/contracts", "./commerce/server"], dependsOn: [] },
      emits: [], handles: input.handlers.map(handler => handler.eventType),
      schedules: input.schedules.map(({ id, cadenceSeconds }) => ({ id, cadenceSeconds })), env: [],
      requiredPorts: Object.keys(input.commerce), routes: input.routes.map(route => route.id), requiredSchema: input.requiredSchema,
    },
    handlers: input.handlers, schedules: input.schedules, routes: input.routes,
  };
  return {
    contributions: [contribution],
    ports: Object.fromEntries(Object.entries(input.commerce).filter(([, fn]) => typeof fn === "function").map(([name, fn]) => [`@openlup/platform/commerce:${name}`, fn])),
    routes: Object.fromEntries(input.routes.map(route => [`@openlup/platform/commerce:${route.id}`, route.handle])),
    triggers: Object.fromEntries(input.schedules.map(schedule => [`@openlup/platform/commerce:${schedule.id}`, schedule.run])),
  };
}
