import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** Risk supplies the incumbent commerce risk slot, never another event handler. */
export function createRiskContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  assessPaidOrder: ((...args: never[]) => unknown) | null;
  routes: Contribution["routes"];
}) {
  const contribution: Contribution = {
    manifest: {
      name: "@openlup/platform", version: input.version, kind: "rail",
      module: { id: "risk", kind: "capability", provides: ["./risk", "./risk/contracts", "./risk/server"], dependsOn: [{ module: "commerce", entries: ["./commerce"] }] },
      emits: [], handles: [], schedules: [], env: [], requiredPorts: ["assessPaidOrder"],
      routes: input.routes.map(route => route.id), requiredSchema: input.requiredSchema,
    },
    handlers: [], schedules: [], routes: input.routes,
  };
  return {
    contributions: [contribution],
    ports: input.assessPaidOrder ? { "@openlup/platform/risk:assessPaidOrder": input.assessPaidOrder } : {},
    routes: Object.fromEntries(input.routes.map(route => [`@openlup/platform/risk:${route.id}`, route.handle])),
    triggers: {},
  };
}
