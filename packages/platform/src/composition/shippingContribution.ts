import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** Structural selected callables keep shipping declarations independent. */
export function createShippingContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  shipping: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  routes: Contribution["routes"];
}) {
  const contribution: Contribution = {
    manifest: {
      name: "@openlup/platform", version: input.version, kind: "rail",
      module: { id: "shipping", kind: "capability", provides: ["./shipping"], dependsOn: [] },
      emits: [], handles: [], schedules: [], env: [], requiredPorts: Object.keys(input.shipping),
      routes: input.routes.map(route => route.id), requiredSchema: input.requiredSchema,
    },
    handlers: [], schedules: [], routes: input.routes,
  };
  return {
    contributions: [contribution],
    ports: Object.fromEntries(Object.entries(input.shipping).filter(([, fn]) => typeof fn === "function").map(([name, fn]) => [`@openlup/platform/shipping:${name}`, fn])),
    routes: Object.fromEntries(input.routes.map(route => [`@openlup/platform/shipping:${route.id}`, route.handle])),
  };
}
