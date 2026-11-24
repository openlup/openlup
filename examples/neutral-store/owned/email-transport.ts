import {
  createInMemoryEmailTransport,
  guardEmailTransport,
  type EmailTransport,
  type InMemoryEmailTransport,
} from '@openlup/platform/communications';

export interface OwnedEmailTransportComposition {
  readonly mode: 'sandbox' | 'provider';
  readonly transport: EmailTransport;
  /** Captured in-memory sink when running in sandbox mode; null when a provider transport is mounted. */
  readonly captured: InMemoryEmailTransport | null;
}

export interface OwnedEmailTransportOptions {
  /** Optional provider email transport mounted by the adopter (e.g. `owned/adapters/communications/postmark`). */
  readonly transport?: EmailTransport;
}

/**
 * Application-owned email transport composition seam.
 *
 * By default (no provider transport supplied), the starter runs with a zero-credential
 * in-memory capture transport. To mount an external communications recipe, pass its
 * `EmailTransport` here; it is automatically wrapped with `guardEmailTransport`.
 */
export function createOwnedEmailTransport(
  options: OwnedEmailTransportOptions = {},
): OwnedEmailTransportComposition {
  if (!options.transport) {
    const captured = createInMemoryEmailTransport();
    return {
      mode: 'sandbox',
      transport: captured,
      captured,
    };
  }
  return {
    mode: 'provider',
    transport: guardEmailTransport(options.transport),
    captured: null,
  };
}
