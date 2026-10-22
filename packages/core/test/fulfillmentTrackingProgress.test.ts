import { expect, it } from 'vitest';
import { fulfillmentProgressPresentation } from '../src/fulfillment/index.js';
import type { CustomerFulfillmentStep } from '../src/fulfillment/index.js';

it.each([
  ['paid', 'succeeded', null, 'paid', [], ['paid'], null],
  ['paid', null, 'in_transit', 'transit', [], ['transit'], 'transit'],
  ['paid', 'succeeded', 'in_transit', 'transit', ['provider_received'], ['paid', 'transit', 'accepted'], 'transit'],
  ['fulfilled', 'paid', 'delivered', 'delivered', [], ['paid', 'delivered'], null],
  ['pending_payment', null, null, 'paid', [], null, null],
  ['draft', 'succeeded', null, 'paid', [], null, null],
  ['expired', 'succeeded', null, 'paid', [], null, null],
  ['cancelled', 'succeeded', 'delivered', 'delivered', [], null, null],
  ['refunded', 'succeeded', 'delivered', 'delivered', [], null, null],
  ['paid', 'succeeded', 'exception', 'exception', [], null, null],
  ['paid', 'succeeded', 'cancelled', 'cancelled', [], null, null],
  ['paid', 'succeeded', 'packed', 'packing', ['delivered', 'created'], ['paid', 'packing'], 'packing'],
] as const)('completes only actual milestones: %s / %s / %s / %s', (status, paymentStatus, fulfillmentStatus, step, events, completedSteps, currentStep) => {
  const progress = fulfillmentProgressPresentation({ status, paymentStatus, fulfillmentStatus, trackingTimeline: events.map(eventType => ({ eventType })) }, step as CustomerFulfillmentStep);
  expect(progress).toEqual(completedSteps === null ? null : { completedSteps, currentStep });
});
