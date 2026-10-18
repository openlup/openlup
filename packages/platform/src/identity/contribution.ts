import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** Host-selected schema inventory: managed and direct installations have different objects. */
export function createIdentityContribution(options: {
  version: string;
  requiredSchema: RequiredSchema;
  routes?: Contribution["routes"];
  requiredPorts?: readonly string[];
}): Contribution {
  const routes = options.routes ?? [];
  return {
    manifest: {
      name: "@openlup/platform", version: options.version, kind: "rail",
      module: {
        id: "identity", kind: "capability", provides: ["./identity", "./identity/contracts"],
        dependsOn: [
          { module: "bff", entries: ["./bff"] },
          { module: "data", entries: ["./data"] },
          { module: "kernel", entries: ["./kernel"] },
          { module: "http", entries: ["./http"] },
        ],
      },
      requiredSchema: options.requiredSchema,
      emits: [], handles: [], schedules: [], routes: routes.map((route) => route.id),
      requiredPorts: options.requiredPorts ?? [], env: [],
    },
    handlers: [], schedules: [], routes,
  };
}
