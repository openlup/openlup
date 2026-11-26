/**
 * The neutral starter's checkout classifier agrees with the storefront example classifier for the starter's
 * action-result envelope. The starter adds two kinds of rows, listed here by name: the paid order statuses, and the
 * refusals its create answers before anything is created, including a fresh create that arrived too late.
 */
import { describe, expect, it } from 'vitest';
import { classifyCheckoutAnswer } from '../../examples/neutral-store/shared/storefront-bindings.ts';
// eslint-disable-next-line no-restricted-imports -- compare with the storefront example classifier the unit witness proves, not a copy
import { classifyStarterAnswer } from '../../packages/platform/test/storefront/outcomeClassifierExamples.ts';

const ok = (value: unknown) => ({ ok: true, value });
const no = (code: string, status?: 503) => ({ ok: false, code, ...(status ? { status } : {}) });

/** Every row the example classifier distinguishes. */
const exampleRows: unknown[] = [
  null, 'answer', [], { ok: 'maybe' }, ok(null), ok('value'),
  no('starter_input_invalid'), no('starter_email_invalid'), no('starter_checkout_expired'), no('starter_checkout_not_payable'),
  no('starter_checkout_changed'), no('starter_dependency_unavailable', 503), { ok: false },
  ok({ status: 'paid' }), ok({ status: 'pending_payment' }), ok({ status: 'pending_payment', attemptState: null }),
  ok({ status: 'pending_payment', attemptState: 'refused' }), ok({ status: 'pending_payment', attemptState: 'dispatched' }),
  ok({ status: 'pending_payment', attemptState: 'indeterminate' }), ok({ status: 'pending_payment', attemptState: 'captured' }),
  ok({ status: 'cancelled' }), ok({ status: 'expired' }), ok({ status: 'refunded' }), ok({}),
];

/** The starter's additions: each differs from the example, which answers `unknown`, only as listed. */
const additions: Array<[string, unknown, string]> = [
  ['paid status fulfillment_pending', ok({ status: 'fulfillment_pending' }), 'settled'],
  ['paid status fulfilled', ok({ status: 'fulfilled' }), 'settled'],
  ...['starter_terms_required', 'starter_expected_total_required', 'starter_quote_price_changed', 'starter_quote_refresh_required',
    'acquisition_terms_capability_required', 'acquisition_terms_changed', 'catalog_admission_quote_authority_required',
    'cart_invalid', 'cart_configuration_changed', 'cart_empty', 'unknown_sku', 'quantity_invalid', 'duplicate_sku',
    'purchase_mode_unavailable', 'cadence_unavailable', 'minimum_units', 'maximum_units', 'amount_overflow',
    'starter_checkout_request_stale']
    .map((code): [string, unknown, string] => [`refusal before create ${code}`, no(code), 'refused']),
];

describe('the neutral starter checkout classifier', () => {
  it('equals the example classifier on every row the example lists', () => {
    for (const answer of exampleRows) expect(classifyCheckoutAnswer(answer), JSON.stringify(answer)).toBe(classifyStarterAnswer(answer));
  });

  it('differs only on the listed additions', () => {
    for (const [name, answer, expected] of additions) {
      expect(classifyStarterAnswer(answer), name).toBe('unknown');
      expect(classifyCheckoutAnswer(answer), name).toBe(expected);
    }
  });
});
