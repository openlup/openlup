import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ReferenceFulfillmentPage from './ReferenceFulfillmentPage';
import type { AdminCommerceFulfillmentOrderDetailResponse } from '@/domains/fulfillment/commerceFulfillmentContracts';
import { getAdminCommerceFulfillmentOrderDetail } from '@/domains/fulfillment/commerceFulfillmentClient';
vi.mock('@/domains/fulfillment/commerceFulfillmentClient', () => ({ getAdminCommerceFulfillmentOrderDetail: vi.fn() }));

it('stays unmounted and reads only on explicit opt-in interaction with visible failure', async () => {
  function runtimeFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? runtimeFiles(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [join(dir, entry.name)] : []);
  }
  const importers = runtimeFiles('src').filter(path => path !== 'src/pages/ReferenceFulfillmentPage.tsx')
    .filter(path => /(?:import|export|require)[\s\S]*?["'][^"']*ReferenceFulfillmentPage(?:\.[cm]?[jt]sx?)?["']/.test(readFileSync(path, 'utf8')));
  expect(importers).toEqual([]);
  const id = '00000000-0000-4000-8000-000000000001';
  const occurredAt = '2026-01-01T00:00:00Z';
  const response: AdminCommerceFulfillmentOrderDetailResponse = {
    contractVersion: 'commerce.fulfillment.v0',
    order: {
      id, orderId: id, clientId: null, status: 'in_transit',
      providerKind: null, providerTrackingId: 'reference',
      shippingAddress: { addressId: id, clientId: id, label: null, line1: '1 Example Road', line2: null, city: 'Example City', postalCode: '00000', country: 'US' },
      lines: [{ id: null, orderItemId: id, skuId: id, sku: 'ITEM', title: null, quantity: 1, inventoryReservationIds: [], productSnapshot: {} }],
      payment: { paymentIntentId: id, paymentStatus: 'succeeded', providerPaymentId: null },
      inventory: { status: 'consumed', reservationId: null, reservationStatus: null, expiresAt: null, locationId: null, locationCode: null },
      omsEligibility: { allowed: true, reason: null },
      latestOperation: { id, type: 'tracking_event_recorded', occurredAt, actorUserId: null, payload: { hidden: 'private payload' } },
      createdAt: occurredAt, updatedAt: occurredAt,
    },
  };
  vi.mocked(getAdminCommerceFulfillmentOrderDetail).mockResolvedValueOnce(response);
  render(<ReferenceFulfillmentPage accessToken="host-session" orderId={id} />);
  expect(getAdminCommerceFulfillmentOrderDetail).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Read fulfillment' }));
  expect(await screen.findByText('reference')).toBeInTheDocument();
  expect(getAdminCommerceFulfillmentOrderDetail).toHaveBeenCalledExactlyOnceWith('host-session', { orderId: id }, {});
  expect(screen.queryByText('private payload')).not.toBeInTheDocument();
  vi.mocked(getAdminCommerceFulfillmentOrderDetail).mockRejectedValueOnce(new Error('private'));
  fireEvent.click(screen.getByRole('button', { name: 'Read fulfillment' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Fulfillment read unavailable.');
  expect(screen.queryByText('reference')).not.toBeInTheDocument();
});
