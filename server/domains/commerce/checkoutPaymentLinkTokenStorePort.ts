/**
 * The durable writes an operator-minted checkout payment link needs. The domain
 * declares the port; `server/adapters/managed/commerce/checkoutPaymentLinkTokenStore.ts`
 * implements it structurally, without importing this file.
 */

/** Only the four columns both schema lineages declare NOT NULL and undefaulted. */
export interface CheckoutPaymentLinkTokenInsert {
  orderId: string;
  clientId: string;
  tokenHash: string;
  expiresAt: string;
}

/**
 * What the delivery rail needs to send the freshly minted link, and nothing else.
 * `tokenId` is the row the mint just wrote, so the enqueue is idempotent per mint.
 */
export interface CheckoutRecoveryEmailEnqueue {
  orderId: string;
  tokenId: string;
  rawToken: string;
  mode: string;
  expiresAt: string;
}

export interface CheckoutPaymentLinkTokenStore {
  /** Retire every link that is still live for this order; idempotent. */
  revokeActive(orderId: string): Promise<void>;
  /** Returns the id of the row just written; the enqueue keys its idempotency on it. */
  insert(input: CheckoutPaymentLinkTokenInsert): Promise<string>;
  /** Hand the minted link to the durable delivery rail; a replay is a success. */
  enqueueRecoveryEmail(input: CheckoutRecoveryEmailEnqueue): Promise<void>;
}
