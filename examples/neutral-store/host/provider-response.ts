export type Read<T> = (value: unknown) => T;

export function field<T>(value: unknown, key: string, decode: Read<T>): T {
  const descriptor = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key) : undefined;
  return decode(descriptor?.value);
}

export const literal = <const T extends string | number | null>(...choices: readonly T[]): Read<T | undefined> =>
  value => choices.find(choice => choice === value);
export const flag: Read<boolean | undefined> = value => value === true || value === false ? value : undefined;
export const integer: Read<number | undefined> = value =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
export const text: Read<string | undefined> = value =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 ? value : undefined;
export const reference = (prefix: string): Read<string | undefined> => value =>
  typeof value === 'string' && value.startsWith(prefix + '_') && /^[A-Za-z0-9_]{4,128}$/u.test(value) ? value : undefined;
const nullable = <T>(read: Read<T>): Read<T | null> => value => value === null ? null : read(value);
const array = <T>(read: Read<T>): Read<T[] | undefined> => value => Array.isArray(value) ? value.map(read) : undefined;

const status = literal('requires_payment_method', 'requires_confirmation', 'requires_action', 'processing',
  'requires_capture', 'canceled', 'succeeded');
export const declineCode = literal('authentication_required', 'card_declined', 'payment_intent_unexpected_state');
const currency = literal('usd');
const qualification = (value: unknown) => field(value, 'qualification', text);

export const readAccount = (value: unknown) => ({
  kind: field(value, 'object', literal('account')), ref: field(value, 'id', reference('acct')),
});
export const readBalance = (value: unknown) => ({
  kind: field(value, 'object', literal('balance')), live: field(value, 'livemode', flag),
});
export const httpStatus: Read<number | undefined> = value => {
  const code = integer(value);
  return code !== undefined && code >= 100 && code <= 599 ? code : undefined;
};
export const readHttpResponse = (value: unknown) => field(value, 'statusCode', httpStatus);

export const readProviderError = (value: unknown) => ({
  httpCode: field(value, 'statusCode', httpStatus),
  code: field(value, 'code', literal('resource_missing', 'tax_calculation_expired', 'reference_already_exists', 'customer_tax_location_invalid',
    'authentication_required', 'card_declined', 'payment_intent_unexpected_state')),
  parameter: field(value, 'param', literal('tax_date', 'posted_at')),
  rawKind: field(value, 'rawType', literal('idempotency_error')),
});

export const readCustomer = (value: unknown) => ({
  ref: field(value, 'id', reference('cus')), live: field(value, 'livemode', flag), tag: field(value, 'metadata', qualification),
});

export const readCharge = (value: unknown) => ({
  ref: field(value, 'id', reference('ch')), live: field(value, 'livemode', flag),
  intentRef: field(value, 'payment_intent', reference('pi')), currency: field(value, 'currency', currency),
  didCapture: field(value, 'captured', flag), capturedMinor: field(value, 'amount_captured', integer),
  createdAt: field(value, 'created', integer),
  captureBefore: field(value, 'payment_method_details', details => field(details, 'card', card => field(card, 'capture_before', integer))),
});

export const readIntent = (value: unknown) => ({
  ref: field(value, 'id', reference('pi')), live: field(value, 'livemode', flag), tag: field(value, 'metadata', qualification),
  state: field(value, 'status', status), currency: field(value, 'currency', currency),
  captureMethod: field(value, 'capture_method', literal('manual')),
  authorizedMinor: field(value, 'amount', integer), receivedMinor: field(value, 'amount_received', integer),
  capturableMinor: field(value, 'amount_capturable', integer),
  decline: field(value, 'last_payment_error', error => field(error, 'code', declineCode)),
  charge: field(value, 'latest_charge', nullable(readCharge)),
  unexpandedChargeRef: field(value, 'latest_charge', reference('ch')),
  customerRef: field(value, 'customer', reference('cus')), methodRef: field(value, 'payment_method', reference('pm')),
  futureUsage: field(value, 'setup_future_usage', literal('off_session')),
  challengeUrl: field(value, 'next_action', action => field(action, 'redirect_to_url', redirect => field(redirect, 'url', text))),
});

export const readPage = <T>(value: unknown, read: Read<T>) => ({
  more: field(value, 'has_more', flag), path: field(value, 'url', text), rows: field(value, 'data', array(read)),
});

const reason = literal('not_collecting', 'not_subject_to_tax', 'product_exempt', 'standard_rated', 'zero_rated',
  'product_exempt_holiday', 'customer_exempt', 'not_supported');
const rateLayout = (value: unknown) => {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  return { type: field(value, 'rate_type', raw => raw === undefined ? undefined : raw === null ? null
    : literal('percentage', 'flat_amount')(raw) ?? 'other'),
    hasPercentage: field(value, 'percentage_decimal', text) !== undefined,
    fee: field(value, 'tax_type', literal('retail_delivery_fee')) === 'retail_delivery_fee' };
};

export function taxScopeMatches(value: unknown, accountRef: string, requireMode: boolean) {
  return field(value, 'account', raw => raw === undefined || reference('acct')(raw) === accountRef)
    && field(value, 'livemode', raw => flag(raw) === false || (!requireMode && raw === undefined));
}

const breakdownRow = (value: unknown) => ({
  taxMinor: field(value, 'amount', integer), basisMinor: field(value, 'taxable_amount', integer),
  reason: field(value, 'taxability_reason', reason) ?? 'other', rate: field(value, 'tax_rate_details', rateLayout),
});
const header = (value: unknown) => ({ ...breakdownRow(value), inclusive: field(value, 'inclusive', flag) });
const component = (value: unknown) => ({
  taxMinor: field(value, 'amount_tax', integer), chargeMinor: field(value, 'amount', integer),
  breakdown: field(value, 'tax_breakdown', array(breakdownRow)),
});
export const readTaxLine = (value: unknown) => ({ ...component(value), ref: field(value, 'reference', text) });
export const readCalculation = (value: unknown) => ({
  ref: field(value, 'id', reference('taxcalc')), payableMinor: field(value, 'amount_total', integer),
  expires: field(value, 'expires_at', nullable(integer)), inclusive: field(value, 'tax_amount_inclusive', integer),
  exclusive: field(value, 'tax_amount_exclusive', integer), headers: field(value, 'tax_breakdown', array(header)),
  shipping: field(value, 'shipping_cost', value => value === undefined || value === null ? value : component(value)),
});

const taxReceiptFields = (value: unknown) => ({
  ref: field(value, 'reference', text), kind: field(value, 'type', literal('transaction', 'reversal')),
});
export const readTaxTransaction = (value: unknown) => ({
  ...taxReceiptFields(value), id: field(value, 'id', reference('tax')),
  original: field(value, 'reversal', nullable(row => field(row, 'original_transaction', reference('tax')))),
  shippingTax: field(value, 'shipping_cost', raw => raw === null ? 0 : field(raw, 'amount_tax', integer)),
});
export const readTaxTransactionLine = (value: unknown) => ({
  ...taxReceiptFields(value), id: field(value, 'id', text),
  original: field(value, 'reversal', nullable(row => field(row, 'original_line_item', text))),
  taxMinor: field(value, 'amount_tax', integer),
});
