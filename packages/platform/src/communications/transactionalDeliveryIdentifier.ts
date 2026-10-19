/** Narrow, portable receipt contract for the captured transactional action. */

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Bounded opaque identifiers keep commands and persisted evidence content-free. */
export function isTransactionalDeliveryIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

