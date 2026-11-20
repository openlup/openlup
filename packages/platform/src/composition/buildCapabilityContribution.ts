import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

export interface CapabilityContributionSpec {
  id: string;
  version: string;
  provides: readonly string[];
  dependsOn: NonNullable<Contribution["manifest"]["module"]>["dependsOn"];
  requiredSchema?: RequiredSchema;
  ports: Readonly<Record<string, unknown>>;
  includePort?: (value: unknown) => boolean;
  handlers?: Contribution["handlers"];
  freezeHandlerDescriptors?: boolean;
  schedules?: Contribution["schedules"];
  routes?: Contribution["routes"];
  duplicateErrorPrefix?: string;
  routeDuplicateError?: string;
}

export interface BuiltCapabilityContribution {
  contribution: Contribution;
  ports: Record<string, unknown>;
  routes: { [k: string]: (...args: never[]) => unknown };
  triggers: { [k: string]: (...args: never[]) => unknown };
}

/** Internal shared builder for capability contribution factories; preserves exact per-module contracts. */
export function buildCapabilityContribution(spec: CapabilityContributionSpec): BuiltCapabilityContribution {
  const handlers = spec.handlers ?? [];
  const schedules = spec.schedules ?? [];
  const routes = spec.routes ?? [];

  if (spec.duplicateErrorPrefix) {
    for (const [kind, names] of [
      ["handler", handlers.map((handler) => handler.eventType)],
      ["schedule", schedules.map((schedule) => schedule.id)],
      ["route", routes.map((route) => route.id)],
    ] as const) {
      if (new Set(names).size !== names.length) {
        throw new Error(`${spec.duplicateErrorPrefix}_duplicate_${kind}`);
      }
    }
  } else if (spec.routeDuplicateError) {
    if (new Set(routes.map((route) => route.id)).size !== routes.length) {
      throw new Error(spec.routeDuplicateError);
    }
  }

  const includePort = spec.includePort ?? ((value: unknown) => typeof value === "function");
  const prefix = `@openlup/platform/${spec.id}`;
  const contribution: Contribution = {
    manifest: {
      name: "@openlup/platform",
      version: spec.version,
      kind: "rail",
      module: {
        id: spec.id,
        kind: "capability",
        provides: [...spec.provides],
        dependsOn: spec.dependsOn,
      },
      emits: [],
      handles: handlers.map((handler) => handler.eventType),
      schedules: schedules.map(({ id, cadenceSeconds }) => ({ id, cadenceSeconds })),
      env: [],
      requiredPorts: Object.keys(spec.ports),
      routes: routes.map((route) => route.id),
      ...(spec.requiredSchema !== undefined ? { requiredSchema: spec.requiredSchema } : {}),
    },
    handlers: spec.freezeHandlerDescriptors
      ? handlers.map(({ eventType, timeoutMs }) => Object.freeze({ eventType, timeoutMs }))
      : handlers,
    schedules,
    routes,
  };

  return {
    contribution,
    ports: Object.fromEntries(
      Object.entries(spec.ports)
        .filter(([, value]) => includePort(value))
        .map(([name, value]) => [`${prefix}:${name}`, value]),
    ),
    routes: Object.fromEntries(routes.map((route) => [`${prefix}:${route.id}`, route.handle])),
    triggers: Object.fromEntries(schedules.map((schedule) => [`${prefix}:${schedule.id}`, schedule.run])),
  };
}
