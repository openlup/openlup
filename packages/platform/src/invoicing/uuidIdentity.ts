const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Native UUID identifiers compare by value; opaque host references stay exact. */
export function sameInvoiceIdentifier(left: string, right: string): boolean {
  return left === right || (uuid.test(left) && uuid.test(right) && left.toLowerCase() === right.toLowerCase());
}
