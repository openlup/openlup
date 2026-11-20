import type { Contribution, RequiredSchema } from '@openlup/core/readiness';
import { buildCapabilityContribution } from './buildCapabilityContribution.js';

/** Structural callables keep composition independent of fulfillment implementation types. */
export function createFulfillmentContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  fulfillment: Readonly<Record<string, ((...args: never[]) => unknown) | null>>;
  handlers: Contribution['handlers'];
  schedules: Contribution['schedules'];
  routes: Contribution['routes'];
}) {
  const built = buildCapabilityContribution({
    id: 'fulfillment',
    version: input.version,
    provides: ['./fulfillment'],
    dependsOn: [],
    requiredSchema: input.requiredSchema,
    ports: input.fulfillment,
    handlers: input.handlers,
    schedules: input.schedules,
    routes: input.routes,
  });
  return {
    contributions: [built.contribution],
    ports: built.ports as { [k: string]: ((...args: never[]) => unknown) | null },
    routes: built.routes,
    triggers: built.triggers,
  };
}
