import assert from 'node:assert/strict';
import test from 'node:test';
import type { InvoiceProviderPort } from '@openlup/platform/invoicing';
import { createOwnedInvoiceProvider } from './invoice-provider.ts';

test('createOwnedInvoiceProvider defaults to zero-credential native unsupported refusals', () => {
  const composed = createOwnedInvoiceProvider();
  assert.equal(composed.mode, 'sandbox');
  assert.equal(composed.provider, null);
  assert.ok(composed.unsupported);
});

test('createOwnedInvoiceProvider mounts a valid InvoiceProviderPort implementation', () => {
  const stubProvider: InvoiceProviderPort = {
    async issue() {
      return { kind: 'refused', code: 'provider_unavailable', retryable: false };
    },
    async correct() {
      return { kind: 'refused', code: 'provider_unavailable', retryable: false };
    },
    async read() {
      return { kind: 'unsupported', code: 'readback_unsupported' };
    },
    async void() {
      return { kind: 'unsupported', code: 'remote_void_unsupported' };
    },
  };
  const composed = createOwnedInvoiceProvider({ provider: stubProvider });
  assert.equal(composed.mode, 'provider');
  assert.equal(composed.provider, stubProvider);
  assert.equal(composed.unsupported, null);
});
