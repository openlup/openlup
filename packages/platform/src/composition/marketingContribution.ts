import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import { buildCapabilityContribution } from "./buildCapabilityContribution.js";

/** Describe existing selected marketing callables; never install another executor. */
export function createMarketingContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  marketing: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  handlers: Contribution["handlers"];
  schedules: Contribution["schedules"];
  routes: Contribution["routes"];
}) {
  const built = buildCapabilityContribution({
    id: "marketing",
    version: input.version,
    provides: ["./marketing", "./marketing/contracts", "./marketing/server"],
    // The server entry validates obligations with identity's runtime contract schema.
    dependsOn: [{ module: "identity", entries: ["./identity/contracts"] }],
    requiredSchema: input.requiredSchema,
    ports: input.marketing,
    handlers: input.handlers,
    freezeHandlerDescriptors: true,
    schedules: input.schedules,
    routes: input.routes,
    duplicateErrorPrefix: "marketing",
  });
  return {
    contributions: [built.contribution],
    ports: built.ports as { [k: string]: ((...args: never[]) => unknown) | null },
    routes: built.routes,
    triggers: built.triggers,
  };
}
