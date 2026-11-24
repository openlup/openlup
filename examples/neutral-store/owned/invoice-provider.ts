import {
  createNativeUnsupportedInvoicePorts,
  type InvoiceProviderPort,
} from '@openlup/platform/invoicing';

export type NativeUnsupportedInvoicePorts = ReturnType<typeof createNativeUnsupportedInvoicePorts>;

export interface OwnedInvoiceProviderComposition {
  readonly mode: 'sandbox' | 'provider';
  readonly provider: InvoiceProviderPort | null;
  /** Honest zero-I/O refusal ports when no invoicing provider is mounted. */
  readonly unsupported: NativeUnsupportedInvoicePorts | null;
}

export interface OwnedInvoiceProviderOptions {
  /** Optional invoicing provider port mounted by the adopter. Empty keeps native unsupported refusals. */
  readonly provider?: InvoiceProviderPort;
}

/**
 * Application-owned invoice provider composition seam.
 *
 * By default (no provider supplied), invoicing stays in zero-credential sandbox mode with
 * honest native unsupported refusals. Supply an `InvoiceProviderPort` implementation here
 * to connect a code-owned invoicing adapter.
 */
export function createOwnedInvoiceProvider(
  options: OwnedInvoiceProviderOptions = {},
): OwnedInvoiceProviderComposition {
  if (!options.provider) {
    return {
      mode: 'sandbox',
      provider: null,
      unsupported: createNativeUnsupportedInvoicePorts(),
    };
  }
  const { issue, correct, read } = options.provider;
  if (
    typeof issue !== 'function' ||
    typeof correct !== 'function' ||
    typeof read !== 'function' ||
    typeof options.provider.void !== 'function'
  ) {
    throw new TypeError('owned_invoice_provider_methods_required');
  }
  return {
    mode: 'provider',
    provider: options.provider,
    unsupported: null,
  };
}
