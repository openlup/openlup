import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import { buildCapabilityContribution } from "./buildCapabilityContribution.js";

/** Structural selected callables keep shipping declarations independent. */
export function createShippingContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  shipping: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  routes: Contribution["routes"];
}) {
  const built = buildCapabilityContribution({
    id: "shipping",
    version: input.version,
    provides: ["./shipping"],
    dependsOn: [],
    requiredSchema: input.requiredSchema,
    ports: input.shipping,
    routes: input.routes,
  });
  return {
    contributions: [built.contribution],
    ports: built.ports as { [k: string]: ((...args: never[]) => unknown) | null },
    routes: built.routes,
  };
}
