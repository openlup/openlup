import { createNativeFulfillmentBinding } from '@openlup/platform/fulfillment/native';
import { createFulfillmentContribution } from '@openlup/platform/composition';

/** Host-owned composition; preparation and edits belong to the packaged binding. */
export function createM08FulfillmentReferenceBinding(input: Parameters<typeof createNativeFulfillmentBinding>[0]) {
  const { services, version, requiredSchema, dispatch, prepare, editAuthoritative } = createNativeFulfillmentBinding(input);
  const contribution = createFulfillmentContribution({ version, requiredSchema,
    fulfillment: { dispatch }, handlers: [], schedules: [], routes: [],
  });
  return { services, ...contribution, prepare, editAuthoritative };
}
