import assert from 'node:assert/strict';
import test from 'node:test';
import type { InvoiceProviderPort } from '@openlup/platform/invoicing/contracts';
import { createOwnedInvoiceProvider } from './invoice-provider.ts';

test('createOwnedInvoiceProvider defaults to zero-credential native unsupported refusals', () => {
  const composed = createOwnedInvoiceProvider();
  assert.equal(composed.mode, 'sandbox');
  assert.equal(composed.provider, null);
  assert.ok(composed.unsupported);
});

test('createOwnedInvoiceProvider mounts a valid InvoiceProviderPort implementation', () => {
  const unsupported = {
    kind: 'unsupported' as const,
    code: 'unsupported' as const,
    retryable: false as const,
    effectMayHaveSucceeded: false as const,
  };
  const stubProvider: InvoiceProviderPort = {
    async issue() {
      return unsupported;
    },
    async correct() {
      return unsupported;
    },
    async read() {
      return unsupported;
    },
    async void() {
      return unsupported;
    },
  };
  const composed = createOwnedInvoiceProvider({ provider: stubProvider });
  assert.equal(composed.mode, 'provider');
  assert.equal(composed.provider, stubProvider);
  assert.equal(composed.unsupported, null);
});

test('createOwnedInvoiceProvider refuses malformed provider objects missing required port methods', () => {
  assert.throws(
    () => createOwnedInvoiceProvider({ provider: {} as unknown as InvoiceProviderPort }),
    /owned_invoice_provider_methods_required/,
  );
});
