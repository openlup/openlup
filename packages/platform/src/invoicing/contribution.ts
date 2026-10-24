import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** Inert descriptors for the host's existing registry and executor. No registration. */
export function createInvoiceContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  invoicing: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  handlers: Contribution["handlers"];
  schedules: Contribution["schedules"];
  routes: Contribution["routes"];
}) {
  const contribution: Contribution = {
    manifest: {
      name: "@openlup/platform", version: input.version, kind: "rail",
      module: { id: "invoicing", kind: "capability", provides: ["./invoicing"], dependsOn: [] },
      emits: [], handles: input.handlers.map(handler => handler.eventType), env: [],
      schedules: input.schedules.map(({ id, cadenceSeconds }) => ({ id, cadenceSeconds })),
      requiredPorts: Object.keys(input.invoicing), routes: input.routes.map(route => route.id), requiredSchema: input.requiredSchema,
    },
    handlers: input.handlers, schedules: input.schedules, routes: input.routes,
  };
  return {
    contributions: [contribution],
    ports: Object.fromEntries(Object.entries(input.invoicing).filter(([, fn]) => typeof fn === "function").map(([name, fn]) => [`@openlup/platform/invoicing:${name}`, fn])),
    routes: Object.fromEntries(input.routes.map(route => [`@openlup/platform/invoicing:${route.id}`, route.handle])),
    triggers: Object.fromEntries(input.schedules.map(schedule => [`@openlup/platform/invoicing:${schedule.id}`, schedule.run])),
  };
}
