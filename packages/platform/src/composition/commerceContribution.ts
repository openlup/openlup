import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import { buildCapabilityContribution } from "./buildCapabilityContribution.js";

/** Describe existing selected commerce callables; never install another executor. */
export function createCommerceContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  commerce: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  handlers: Contribution["handlers"];
  schedules: Contribution["schedules"];
  routes: Contribution["routes"];
}) {
  const built = buildCapabilityContribution({
    id: "commerce",
    version: input.version,
    provides: ["./commerce", "./commerce/contracts", "./commerce/server"],
    dependsOn: [],
    requiredSchema: input.requiredSchema,
    ports: input.commerce,
    handlers: input.handlers,
    freezeHandlerDescriptors: true,
    schedules: input.schedules,
    routes: input.routes,
    duplicateErrorPrefix: "commerce",
  });
  return {
    contributions: [built.contribution],
    ports: built.ports as { [k: string]: ((...args: never[]) => unknown) | null },
    routes: built.routes,
    triggers: built.triggers,
  };
}
