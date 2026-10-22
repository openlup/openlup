import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ReferenceFulfillmentPage from './ReferenceFulfillmentPage';
import { getAdminCommerceFulfillmentOrderDetail } from '@/domains/fulfillment/commerceFulfillmentClient';
vi.mock('@/domains/fulfillment/commerceFulfillmentClient', () => ({ getAdminCommerceFulfillmentOrderDetail: vi.fn() }));

it('stays unmounted and reads only on explicit opt-in interaction with visible failure', async () => {
  function runtimeFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? runtimeFiles(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [join(dir, entry.name)] : []);
  }
  const importers = runtimeFiles('src').filter(path => path !== 'src/pages/ReferenceFulfillmentPage.tsx')
    .filter(path => /(?:import|export|require)[\s\S]*?["'][^"']*ReferenceFulfillmentPage(?:\.[cm]?[jt]sx?)?["']/.test(readFileSync(path, 'utf8')));
  expect(importers).toEqual([]);
  vi.mocked(getAdminCommerceFulfillmentOrderDetail).mockResolvedValueOnce({ order: { orderId: 'order', status: 'in_transit', providerTrackingId: 'reference', latestOperation: { payload: { hidden: 'private payload' } } } } as Awaited<ReturnType<typeof getAdminCommerceFulfillmentOrderDetail>>);
  render(<ReferenceFulfillmentPage accessToken="host-session" orderId="order" />);
  expect(getAdminCommerceFulfillmentOrderDetail).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Read fulfillment' }));
  expect(await screen.findByText('reference')).toBeInTheDocument();
  expect(getAdminCommerceFulfillmentOrderDetail).toHaveBeenCalledExactlyOnceWith('host-session', { orderId: 'order' }, {});
  expect(screen.queryByText('private payload')).not.toBeInTheDocument();
  vi.mocked(getAdminCommerceFulfillmentOrderDetail).mockRejectedValueOnce(new Error('private'));
  fireEvent.click(screen.getByRole('button', { name: 'Read fulfillment' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Fulfillment read unavailable.');
  expect(screen.queryByText('reference')).not.toBeInTheDocument();
});
