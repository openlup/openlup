import { expect, it } from 'vitest';
import { createM08FulfillmentReferenceBinding as referenceBinding } from '../../server/runtime/public-reference/m08FulfillmentBinding.js';
import { createNativeFulfillmentBinding as packageBinding } from '@openlup/platform/fulfillment/native';

it('keeps the old runtime constructor identical to the public built-package entry', () => {
  expect(referenceBinding).toBe(packageBinding);
});
