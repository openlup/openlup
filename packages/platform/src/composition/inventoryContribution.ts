import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** Structural selected callables keep inventory and catalog declarations independent. */
export function createInventoryContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  inventory: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  routes: Contribution["routes"];
}) {
  const contribution: Contribution = {
    manifest: {
      name: "@openlup/platform", version: input.version, kind: "rail",
      module: { id: "inventory", kind: "capability", provides: ["./inventory"], dependsOn: [] },
      emits: [], handles: [], schedules: [], env: [], requiredPorts: Object.keys(input.inventory),
      routes: input.routes.map(route => route.id), requiredSchema: input.requiredSchema,
    },
    handlers: [], schedules: [], routes: input.routes,
  };
  return {
    contributions: [contribution],
    ports: Object.fromEntries(Object.entries(input.inventory).filter(([, fn]) => typeof fn === "function").map(([name, fn]) => [`@openlup/platform/inventory:${name}`, fn])),
    routes: Object.fromEntries(input.routes.map(route => [`@openlup/platform/inventory:${route.id}`, route.handle])),
  };
}
