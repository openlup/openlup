declare const continuationIdBrand: unique symbol;
declare const commandKeyBrand: unique symbol;
declare const attemptNumberBrand: unique symbol;

/**
 * The identity of one buyer purchase and of its continuation record.
 *
 * It is the browser-side opaque handle for the server's journey identifier,
 * whose format the commerce entry's `checkoutContinuationJourneyIdSchema`
 * validates. This package does not validate it: a host that wants validation
 * applies that schema in its `IdentifierBinding.accepts`. A plain `string`, a
 * `CommandKey` and an `AttemptNumber` are not assignable to it.
 */
export type ContinuationId = string & { readonly [continuationIdBrand]: true };

/**
 * The replay identity of one command: a request sent again under the same key
 * is the same command. A plain `string` and a `ContinuationId` are not
 * assignable to it.
 */
export type CommandKey = string & { readonly [commandKeyBrand]: true };

/**
 * Counts payment attempts within one purchase. The first stored attempt is `0`.
 * A plain `number` is not assignable to it.
 */
export type AttemptNumber = number & { readonly [attemptNumberBrand]: true };

/**
 * Brands a value as a continuation identity. Returns the value unchanged and
 * never throws, so a host's codec can brand any stored value its own
 * acceptance check accepts.
 */
export function toContinuationId(value: string): ContinuationId {
  return value as ContinuationId;
}

/** Brands a value as a command key. Returns the value unchanged and never throws. */
export function toCommandKey(value: string): CommandKey {
  return value as CommandKey;
}

/** Brands a value as an attempt number. Returns the value unchanged and never throws. */
export function toAttemptNumber(value: number): AttemptNumber {
  return value as AttemptNumber;
}
