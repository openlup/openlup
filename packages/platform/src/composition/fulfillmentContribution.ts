import type { Contribution, RequiredSchema } from '@openlup/core/readiness';

/** Structural callables keep composition independent of fulfillment implementation types. */
export function createFulfillmentContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  fulfillment: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  handlers: Contribution['handlers'];
  schedules: Contribution['schedules'];
  routes: Contribution['routes'];
}) {
  const contribution: Contribution = {
    manifest: {
      name: '@openlup/platform', version: input.version, kind: 'rail',
      module: { id: 'fulfillment', kind: 'capability', provides: ['./fulfillment'], dependsOn: [] },
      emits: [], handles: input.handlers.map(handler => handler.eventType),
      schedules: input.schedules.map(({ id, cadenceSeconds }) => ({ id, cadenceSeconds })), env: [],
      requiredPorts: Object.keys(input.fulfillment), routes: input.routes.map(route => route.id), requiredSchema: input.requiredSchema,
    },
    handlers: input.handlers, schedules: input.schedules, routes: input.routes,
  };
  return {
    contributions: [contribution],
    ports: Object.fromEntries(Object.entries(input.fulfillment).filter(([, fn]) => typeof fn === 'function').map(([name, fn]) => [`@openlup/platform/fulfillment:${name}`, fn])),
    routes: Object.fromEntries(input.routes.map(route => [`@openlup/platform/fulfillment:${route.id}`, route.handle])),
    triggers: Object.fromEntries(input.schedules.map(schedule => [`@openlup/platform/fulfillment:${schedule.id}`, schedule.run])),
  };
}
