import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { FulfillmentDeliveryStatus } from './FulfillmentDeliveryStatus';

it.each([null, '<img src=x onerror=alert(1)>'])('renders the projected reference %s as inert text', trackingReference => {
  const view = render(<FulfillmentDeliveryStatus status="in_transit" trackingReference={trackingReference} />);
  expect(screen.getByText('in_transit')).toBeInTheDocument();
  expect(screen.getByText(trackingReference ?? 'Unavailable')).toBeInTheDocument();
  expect(view.container.querySelector('a, img')).toBeNull();
});
