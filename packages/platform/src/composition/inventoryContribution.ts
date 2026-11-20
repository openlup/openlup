import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import { buildCapabilityContribution } from "./buildCapabilityContribution.js";

/** Structural selected callables keep inventory and catalog declarations independent. */
export function createInventoryContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  inventory: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  routes: Contribution["routes"];
}) {
  const built = buildCapabilityContribution({
    id: "inventory",
    version: input.version,
    provides: ["./inventory"],
    dependsOn: [],
    requiredSchema: input.requiredSchema,
    ports: input.inventory,
    routes: input.routes,
  });
  return {
    contributions: [built.contribution],
    ports: built.ports as { [k: string]: ((...args: never[]) => unknown) | null },
    routes: built.routes,
  };
}
