import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import type ProviderSdk from 'stripe';
import { createStripeTaxAdapter, makeStripeTaxRequestDigest, type StripeTaxAdapterOptions } from '@openlup/platform/tax/stripe';

import { field, literal, readAccount, readBalance, readHttpResponse, readProviderError, declineCode } from './provider-response.ts';

export { makeStripeTaxRequestDigest as makeReportingDigest };
export const sdkVersion = '22.5.0';
export const credentialRefusal = 'Inject a provider test-mode key for the intended test account.';
export const integrityRefusal = 'Re-obtain evidence for the original operation in the bound owner test account.';
export const accountId = /^acct_[A-Za-z0-9]{8,64}$/u;
const origin = 'https://api.stripe.com';
const apiVersion = '2026-07-29.dahlia';
const replayLimit = 23 * 60 * 60 * 1000;
const deadline = 10_000;

type Http = ProviderSdk.HttpClient;
type Options = StripeTaxAdapterOptions;
type WriteOptions = { idempotencyKey: string };
type Evidence = { operation: string; key: string; reference: string; effect?: 'unknown'; replayAgeMs?: number };
export class ProviderUnavailable extends Error {
  constructor() { super('Provider transport is unavailable. Reconcile the original operation in the bound test account.'); }
}

export class CardRejection extends Error {
  readonly code: ReturnType<typeof declineCode>;
  constructor(code: ReturnType<typeof declineCode>) {
    super('Check the original test intent in the bound account.');
    this.code = code;
  }
}

function oneRequest(...[host, port, path, method, headers, data, protocol, timeout]: Parameters<Http['makeRequest']>) {
  const url = new URL(path, origin);
  if (url.origin !== origin || host !== url.hostname || port !== '443' || protocol !== 'https'
    || !path.startsWith('/v1/') || Object.keys(headers).some(name => /^stripe-(?:account|context)$/iu.test(name) && headers[name])) {
    throw new Error(integrityRefusal);
  }
  return new Promise<Awaited<ReturnType<Http['makeRequest']>>>((resolve, reject) => {
    const outgoing = request(url, { method,
      headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== null && value !== undefined)),
      agent: false, signal: AbortSignal.timeout(Math.min(timeout, deadline)) }, async incoming => {
      try {
        const bytes: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          if ((size += chunk.length) > 4 * 1024 * 1024) throw new ProviderUnavailable();
          bytes.push(chunk as Buffer);
        }
        const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes)));
        const status = readHttpResponse(incoming);
        if (body === null || typeof body !== 'object' || Array.isArray(body) || status === undefined) throw new ProviderUnavailable();
        const headers = Object.fromEntries(
          Object.entries(incoming.headers).flatMap(([name, value]) => typeof value === 'string' ? [[name, value]] : []));
        resolve({ getStatusCode: () => status, getHeaders: () => headers, getRawResponse: () => ({}),
          toJSON: async () => body, toStream: () => undefined });
      } catch {
        incoming.destroy();
        reject(new ProviderUnavailable());
      }
    });
    outgoing.on('error', reject);
    outgoing.end(data);
  });
}

export function oneAttempt(wire: Http['makeRequest'] = oneRequest): Http {
  return {
    getClientName: () => 'qualified-node',
    async makeRequest(...args) {
      try {
        return await wire(...args);
      } catch {
        // The SDK retries closed connections before consulting maxNetworkRetries.
        throw new ProviderUnavailable();
      }
    },
  };
}

const taxRemedies = {
  tax_invalid_input: {
    '/input/destination/address': 'Supply a supported address.',
    '/input/taxDate': 'Supply a whole-second instant within the calculation window.',
    '/postedAt': 'Use a supported posting instant.',
    '/providerRequest': 'Check the documented inputs for this operation.',
  },
  tax_reference_conflict: {
    '/key': 'Reconcile the original request and reference.',
    '/transactionRef': 'Reconcile the original request and reference.',
    '/reversalRef': 'Reconcile the original request and reference.',
  },
  tax_calculation_expired: { '/calculationRef': 'Reconcile the original obligation.' },
  tax_calculation_unusable: {
    '/calculationRef': 'Re-obtain the original reference in the bound account.',
    '/originalRef': 'Re-obtain the original reference in the bound account.',
    '/transaction/id': 'Re-obtain the original reference in the bound account.',
  },
} as const;
type TaxCode = keyof typeof taxRemedies;

export function fixedTaxRemedy(code: string, field: string): string | undefined {
  if (!Object.hasOwn(taxRemedies, code)) return undefined;
  const fields: Readonly<Record<string, string>> = taxRemedies[code as TaxCode];
  return Object.hasOwn(fields, field) ? fields[field] : undefined;
}

export class TaxProviderRejection extends Error {
  readonly code: TaxCode;
  readonly field: string;
  constructor(code: TaxCode, field: string) {
    super(fixedTaxRemedy(code, field) ?? integrityRefusal);
    this.name = 'TaxProviderRejection';
    this.code = code;
    this.field = field;
  }
}

function taxRejection(operation: string, { code, parameter, httpCode, rawKind }: ReturnType<typeof readProviderError>) {
  if (httpCode === 404 || code === 'resource_missing') return new TaxProviderRejection('tax_calculation_unusable',
    operation === 'commit' || operation.startsWith('calculation') ? '/calculationRef'
      : operation === 'reverse' ? '/originalRef' : '/transaction/id');
  if (code === 'tax_calculation_expired') return new TaxProviderRejection('tax_calculation_expired', '/calculationRef');
  if (rawKind === 'idempotency_error' || code === 'reference_already_exists') return new TaxProviderRejection('tax_reference_conflict',
    rawKind === 'idempotency_error' ? '/key' : operation === 'reverse' ? '/reversalRef' : '/transactionRef');
  return new TaxProviderRejection('tax_invalid_input', code === 'customer_tax_location_invalid' ? '/input/destination/address'
    : parameter === 'tax_date' ? '/input/taxDate' : parameter === 'posted_at' ? '/postedAt' : '/providerRequest');
}

export const transportStringBytes = 255;
const wireText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= transportStringBytes;

type Input = 'text' | 'integer' | 'boolean' | 'metadata' | { vector: Input }
  | { fields: Readonly<Record<string, Input>>; required: readonly string[] };
const fields = (shape: Readonly<Record<string, Input>>, ...required: string[]): Input => ({ fields: shape, required });
const address = fields({ line1: 'text', line2: 'text', city: 'text', state: 'text', postal_code: 'text', country: 'text' });
const paging = { limit: 'integer', starting_after: 'text', ending_before: 'text' } as const;
const cost = { amount: 'integer', tax_code: 'text', tax_behavior: 'text' } as const;
const inputShapes = {
  customer: fields({ metadata: 'metadata' }),
  intent: fields({ amount: 'integer', currency: 'text', payment_method_types: { vector: 'text' }, capture_method: 'text',
    customer: 'text', metadata: 'metadata', setup_future_usage: 'text' }, 'amount', 'currency'),
  confirm: fields({ payment_method: 'text', return_url: 'text', use_stripe_sdk: 'boolean',
    off_session: 'boolean', error_on_requires_action: 'boolean' }),
  retrieve: fields({}),
  capture: fields({ amount_to_capture: 'integer' }),
  cancel: fields({}),
  charges: fields({}),
  calculation: fields({ currency: 'text', customer_details: fields({ address, address_source: 'text' }),
    ship_from_details: fields({ address }), expand: { vector: 'text' }, tax_date: 'integer',
    shipping_cost: fields(cost),
    line_items: { vector: fields({ ...cost, quantity: 'integer', reference: 'text', metadata: 'metadata' }, 'reference') } },
  'currency', 'line_items'),
  calculationRead: fields({}),
  calculationLines: fields({ ...paging, expand: { vector: 'text' } }),
  registrations: fields({ ...paging, status: 'text' }),
  commit: fields({ calculation: 'text', reference: 'text', posted_at: 'integer', metadata: 'metadata' }, 'calculation', 'reference'),
  reverse: fields({ original_transaction: 'text', reference: 'text', mode: 'text', metadata: 'metadata',
    shipping_cost: fields({ amount: 'integer', amount_tax: 'integer' }),
    line_items: { vector: fields({ amount: 'integer', amount_tax: 'integer', reference: 'text', original_line_item: 'text' },
      'reference', 'original_line_item') } }, 'original_transaction', 'reference', 'mode'),
  transactionRead: fields({}),
  transactionLines: fields(paging),
};
type Operation = keyof typeof inputShapes;
const targetOperations: ReadonlySet<Operation> = new Set(['confirm', 'retrieve', 'capture', 'cancel', 'charges',
  'calculationRead', 'calculationLines', 'transactionRead', 'transactionLines']);

function matchesInput(input: unknown, shape: Input): boolean {
  if (shape === 'text') return wireText(input);
  if (shape === 'integer') return typeof input === 'number' && Number.isSafeInteger(input);
  if (shape === 'boolean') return input === true || input === false;
  if (input === null || typeof input !== 'object') return false;
  if (typeof shape === 'object' && 'vector' in shape) {
    if (!Array.isArray(input)) return false;
    const indices = Object.keys(input);
    return indices.length === input.length && Reflect.ownKeys(input).length === input.length + 1
      && indices.every((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        return key === String(index) && descriptor !== undefined && Object.hasOwn(descriptor, 'value')
          && matchesInput(descriptor.value, shape.vector);
      });
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (shape !== 'metadata' && !shape.required.every(key => Object.hasOwn(input, key))) return false;
  return Reflect.ownKeys(input).every(key => {
    if (typeof key !== 'string' || !wireText(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return false;
    const item = shape === 'metadata' ? 'text' : Object.hasOwn(shape.fields, key) ? shape.fields[key] : undefined;
    return item !== undefined && matchesInput(descriptor.value, item);
  });
}

export async function openTestProvider(
  { secretKey, accountRef }: { secretKey: string; accountRef: string },
  { http = oneRequest, record = () => {}, now = Date.now }: { http?: Http['makeRequest']; record?: (entry: Evidence) => void; now?: () => number } = {},
) {
  if (!wireText(secretKey) || !/^sk_test_[A-Za-z0-9]+$/u.test(secretKey)) throw new Error(credentialRefusal);
  if (!wireText(accountRef) || !accountId.test(accountRef)) throw new Error(integrityRefusal);
  const { default: Sdk } = await import('stripe');
  if (Sdk.PACKAGE_VERSION !== sdkVersion) throw new Error(integrityRefusal);
  const sdk = new Sdk(secretKey, { apiVersion, maxNetworkRetries: 0, timeout: deadline, telemetry: false,
    emitEventBodies: false, httpClient: oneAttempt(http) });
  const scope = Object.freeze({ accountRef, mode: 'test' as const });
  let observedVersion: string | undefined;
  sdk.on('request', (event: ProviderSdk.RequestEvent) => { observedVersion = field(event, 'api_version', literal(apiVersion)); });
  try {
    const account = readAccount(await sdk.accounts.retrieveCurrent());
    if (account.kind !== 'account' || account.ref !== accountRef) throw new Error();
    const balance = readBalance(await sdk.balance.retrieve());
    if (balance.kind !== 'balance' || balance.live !== false || observedVersion !== apiVersion) throw new Error();
  } catch { throw new Error(integrityRefusal); }

  const salt = randomBytes(32);
  const hash = (value: string) => createHash('sha256').update(salt).update(value).digest('hex');
  const bindings = new Map<string, { request: unknown; sentAt: number; before: number; succeeded: boolean }>();
  async function call<T, P>(kind: 'card' | 'tax', operation: Operation, parameters: P,
    invoke: (request: P, options?: WriteOptions) => Promise<T>, target?: string,
    mutation?: { options: WriteOptions; ref?: (request: P) => unknown; before?: number }): Promise<T> {
    if (!matchesInput(parameters, inputShapes[operation]) || (targetOperations.has(operation) && !wireText(target))) {
      throw new Error(integrityRefusal);
    }
    const request = structuredClone(parameters);
    const key = mutation?.options?.idempotencyKey;
    let binding;
    let evidence: Evidence | undefined;
    let options: WriteOptions | undefined;
    if (mutation !== undefined) {
      if (!wireText(key)) throw new Error(integrityRefusal);
      const reference = mutation.ref === undefined ? target ?? key : mutation.ref(request);
      if (!wireText(reference)) throw new Error(integrityRefusal);
      const { before } = mutation;
      options = { idempotencyKey: key };
      const fingerprint = { kind, operation, reference, request };
      binding = bindings.get(key);
      const time = now();
      if (before !== undefined && !Number.isFinite(before)) throw new Error(integrityRefusal);
      const cutoff = before ?? Infinity;
      if (binding) {
        if (!isDeepStrictEqual(binding.request, fingerprint) || binding.succeeded !== true || cutoff > binding.before
          || time >= Math.min(cutoff, binding.before, binding.sentAt + replayLimit)) throw new Error(integrityRefusal);
        record({ operation, key: hash(key), reference: hash(reference), replayAgeMs: time - binding.sentAt });
      } else {
        if (time >= cutoff) throw new Error(integrityRefusal);
        binding = { request: structuredClone(fingerprint), sentAt: time, before: cutoff, succeeded: false };
        bindings.set(key, binding);
      }
      evidence = { operation, key: hash(key), reference: hash(reference) };
    }
    try {
      const result = await invoke(request, options);
      if (binding) binding.succeeded = true;
      return result;
    } catch (error) {
      if (error instanceof Sdk.errors.StripeError) {
        const rejected = readProviderError(error);
        if (rejected.httpCode === 400 || rejected.httpCode === 402 || rejected.httpCode === 404 || rejected.rawKind === 'idempotency_error') {
          if (kind === 'card') throw new CardRejection(declineCode(rejected.code));
          const refusal = taxRejection(operation, rejected);
          if (evidence !== undefined && refusal.code === 'tax_reference_conflict') record({ ...evidence, effect: 'unknown' });
          throw refusal;
        }
      }
      if (evidence) record({ ...evidence, effect: 'unknown' });
      throw new ProviderUnavailable();
    }
  }

  const card = Object.freeze({
    customer: (parameters: ProviderSdk.CustomerCreateParams, options: WriteOptions) =>
      call('card', 'customer', parameters, (body, bound) => sdk.customers.create(body, bound), undefined, { options }),
    create: (parameters: ProviderSdk.PaymentIntentCreateParams, options: WriteOptions) =>
      call('card', 'intent', parameters, (body, bound) => sdk.paymentIntents.create(body, bound), undefined, { options }),
    confirm: (id: string, parameters: ProviderSdk.PaymentIntentConfirmParams, options: WriteOptions) =>
      call('card', 'confirm', parameters, (body, bound) => sdk.paymentIntents.confirm(id, body, bound), id, { options }),
    retrieve: (id: string, timeout = deadline) =>
      call('card', 'retrieve', {}, () => sdk.paymentIntents.retrieve(id, { expand: ['latest_charge'] }, { timeout }), id),
    capture: (id: string, options: WriteOptions, before: number) =>
      call('card', 'capture', { amount_to_capture: 1000 }, (body, bound) => sdk.paymentIntents.capture(id, body, bound), id, { options, before }),
    cancel: (id: string, options: WriteOptions) =>
      call('card', 'cancel', {}, (body, bound) => sdk.paymentIntents.cancel(id, body, bound), id, { options }),
    charges: (id: string) => call('card', 'charges', {}, () => sdk.charges.list({ payment_intent: id, limit: 100 }), id),
  });
  const tax = Object.freeze({
    scope,
    calculations: Object.freeze({
      create: (params: ProviderSdk.Tax.CalculationCreateParams, options: WriteOptions) =>
        call('tax', 'calculation', params, (body, bound) => sdk.tax.calculations.create(body, bound), undefined,
          { options, ref: body => body.line_items[0]?.reference }),
      retrieve: (id: string) => call('tax', 'calculationRead', {},
        () => sdk.tax.calculations.retrieve(id, { expand: ['shipping_cost.tax_breakdown'] }), id),
      listLineItems: (id: string, params: ProviderSdk.Tax.CalculationListLineItemsParams) =>
        call('tax', 'calculationLines', params, body => sdk.tax.calculations.listLineItems(id, body), id),
    }),
    registrations: Object.freeze({ list: (params: ProviderSdk.Tax.RegistrationListParams) =>
      call('tax', 'registrations', params, body => sdk.tax.registrations.list(body)) }),
    transactions: Object.freeze({
      createFromCalculation: (params: ProviderSdk.Tax.TransactionCreateFromCalculationParams, options: WriteOptions, before?: number) =>
        call('tax', 'commit', params, (body, bound) => sdk.tax.transactions.createFromCalculation(body, bound), undefined,
          { options, ref: body => body.reference, ...(before === undefined ? {} : { before }) }),
      createReversal: (params: ProviderSdk.Tax.TransactionCreateReversalParams, options: WriteOptions, before?: number) =>
        call('tax', 'reverse', params, (body, bound) => sdk.tax.transactions.createReversal(body, bound), undefined,
          { options, ref: body => body.reference, ...(before === undefined ? {} : { before }) }),
      retrieve: (id: string) => call('tax', 'transactionRead', {}, () => sdk.tax.transactions.retrieve(id), id),
      listLineItems: (id: string, params: ProviderSdk.Tax.TransactionListLineItemsParams) =>
        call('tax', 'transactionLines', params, body => sdk.tax.transactions.listLineItems(id, body), id),
    }),
  } satisfies Options['client']);
  return Object.freeze({ scope, card, tax, apiVersion: observedVersion });
}

export type VerifiedTestProvider = Awaited<ReturnType<typeof openTestProvider>>;

export function composeProviderTax(provider: VerifiedTestProvider, options: Omit<Options, 'client'>) {
  return createStripeTaxAdapter({ ...options, client: provider.tax });
}
