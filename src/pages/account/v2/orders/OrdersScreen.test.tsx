import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { CustomerAccountV2Response } from '@/domains/customers/accountV2Contracts';
import { OrdersScreen } from './OrdersScreen';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

it.each([
  ['succeeded', ['paid', 'transit']],
  [null, ['transit']],
] as const)('uses real evidence at the OrdersScreen caller with payment %s', (paymentStatus, completed) => {
  const account = { subscriptions: [], recentOrders: [{ orderId: 'order', orderRef: 'order_example', orderNumber: null,
    status: 'paid', paymentStatus, fulfillmentStatus: 'in_transit', customerFulfillmentStep: 'transit',
    trackingTimeline: [], trackingReferences: [], trackingNumbers: [], trackingNumber: null, trackingUrl: null,
    total: { amountMinor: 100, currency: 'XXX' }, createdAt: '2026-10-22T00:00:00Z', invoice: null, deliverySelection: null,
  }] } as unknown as CustomerAccountV2Response;
  const view = render(<OrdersScreen account={account} lang="en" onDownloadInvoice={vi.fn()} onCompletePayment={vi.fn()} onRepairSubscriptionPayment={vi.fn()} />);
  expect([...view.container.querySelectorAll('[data-complete="true"]')].map(el => el.getAttribute('data-step'))).toEqual(completed);
  expect(view.container.querySelector('[aria-current="step"]')).toHaveAttribute('data-step', 'transit');
  expect(screen.getByText('account:dashboard.ordersV2.steps.accepted')).toHaveTextContent('oczekuje');
  expect(screen.getByText('account:dashboard.ordersV2.steps.packing')).toHaveTextContent('oczekuje');
});
