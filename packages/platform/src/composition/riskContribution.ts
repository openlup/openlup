import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import { buildCapabilityContribution } from "./buildCapabilityContribution.js";

/** Risk supplies the incumbent commerce risk slot, never another event handler. */
export function createRiskContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  assessPaidOrder: ((...args: never[]) => unknown) | null;
  routes: Contribution["routes"];
}) {
  const built = buildCapabilityContribution({
    id: "risk",
    version: input.version,
    provides: ["./risk", "./risk/contracts", "./risk/server"],
    dependsOn: [{ module: "commerce", entries: ["./commerce"] }],
    requiredSchema: input.requiredSchema,
    ports: { assessPaidOrder: input.assessPaidOrder },
    includePort: Boolean,
    routes: input.routes,
  });
  return {
    contributions: [built.contribution],
    ports: input.assessPaidOrder ? { "@openlup/platform/risk:assessPaidOrder": input.assessPaidOrder } : {},
    routes: built.routes,
    triggers: {},
  };
}
