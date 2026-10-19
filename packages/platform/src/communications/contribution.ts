import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** Host-selected schema inventory: managed and direct installations have different objects. */
export function createCommunicationsContribution(options: {
  version: string;
  requiredSchema: RequiredSchema;
  routes?: Contribution["routes"];
  handlers?: Contribution["handlers"];
  schedules?: Contribution["schedules"];
  requiredPorts?: readonly string[];
}): Contribution {
  const routes = options.routes ?? [];
  const handlers = options.handlers ?? [];
  const schedules = options.schedules ?? [];
  return {
    manifest: {
      name: "@openlup/platform", version: options.version, kind: "rail",
      module: {
        id: "communications", kind: "capability", provides: ["./communications", "./communications/contracts"],
        dependsOn: [
          { module: "data", entries: ["./data"] },
          { module: "identity", entries: ["./identity"] },
          { module: "http", entries: ["./http"] },
        ],
      },
      requiredSchema: options.requiredSchema,
      emits: [], handles: handlers.map((handler) => handler.eventType),
      schedules: schedules.map(({ id, cadenceSeconds }) => ({ id, cadenceSeconds })), routes: routes.map((route) => route.id),
      requiredPorts: [...new Set(options.requiredPorts ?? [])], env: [],
    },
    handlers, schedules, routes,
  };
}
