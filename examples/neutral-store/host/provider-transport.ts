import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import type ProviderSdk from 'stripe';
import { createStripeTaxAdapter, makeStripeTaxRequestDigest, type StripeTaxAdapterOptions } from '@openlup/platform/tax/stripe';

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

const declineCodes = ['authentication_required', 'card_declined', 'payment_intent_unexpected_state'] as const;
export function declineCode(code: unknown) {
  return declineCodes.find(allowed => allowed === code);
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
    const outgoing = request(url, { method, headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value != null)),
      agent: false, signal: AbortSignal.timeout(Math.min(timeout, deadline)) }, async incoming => {
      try {
        const bytes: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          if ((size += chunk.length) > 4 * 1024 * 1024) throw new ProviderUnavailable();
          bytes.push(chunk as Buffer);
        }
        const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes)));
        if (!body || typeof body !== 'object' || Array.isArray(body) || !incoming.statusCode) throw new ProviderUnavailable();
        const status = incoming.statusCode;
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

type Rejection = { code: string; field: string; remedy: string };
function taxRejection(operation: string, error: ProviderSdk.errors.StripeError): Rejection {
  const { code, param, statusCode, rawType } = error;
  if (statusCode === 404 || code === 'resource_missing') return {
    code: 'tax_calculation_unusable', field: operation === 'commit' || operation.startsWith('calculation') ? '/calculationRef'
      : operation === 'reverse' ? '/originalRef' : '/transaction/id', remedy: 'Re-obtain the original reference in the bound account.',
  };
  if (code === 'tax_calculation_expired') return { code: 'tax_calculation_expired', field: '/calculationRef', remedy: 'Reconcile the original obligation.' };
  if (rawType === 'idempotency_error' || code === 'reference_already_exists') return {
    code: 'tax_reference_conflict', field: rawType === 'idempotency_error' ? '/key' : operation === 'reverse' ? '/reversalRef' : '/transactionRef',
    remedy: 'Reconcile the original request and reference.',
  };
  const [field, remedy] = code === 'customer_tax_location_invalid'
    ? ['/input/destination/address', 'Supply a supported address.']
    : param === 'tax_date' ? ['/input/taxDate', 'Supply a whole-second instant within the calculation window.']
    : param === 'posted_at' ? ['/postedAt', 'Use a supported posting instant.']
    : ['/providerRequest', 'Check the documented inputs for this operation.'];
  return { code: 'tax_invalid_input', field: field!, remedy: remedy! };
}

export async function openTestProvider(
  { secretKey, accountRef }: { secretKey: string; accountRef: string },
  { http = oneRequest, record = () => {}, now = Date.now }: { http?: Http['makeRequest']; record?: (entry: Evidence) => void; now?: () => number } = {},
) {
  if (!/^sk_test_[A-Za-z0-9]+$/u.test(secretKey)) throw new Error(credentialRefusal);
  if (!accountId.test(accountRef)) throw new Error(integrityRefusal);
  const { default: Sdk } = await import('stripe');
  if (Sdk.PACKAGE_VERSION !== sdkVersion) throw new Error(integrityRefusal);
  const sdk = new Sdk(secretKey, { apiVersion, maxNetworkRetries: 0, timeout: deadline, telemetry: false,
    emitEventBodies: false, httpClient: oneAttempt(http) });
  const scope = Object.freeze({ accountRef, mode: 'test' as const });
  let observedVersion: string | undefined;
  sdk.on('request', (event: ProviderSdk.RequestEvent) => { observedVersion = event.api_version; });
  try {
    const account = await sdk.accounts.retrieveCurrent();
    if (account.object !== 'account' || account.id !== accountRef) throw new Error();
    const balance = await sdk.balance.retrieve();
    if (balance.object !== 'balance' || balance.livemode !== false || observedVersion !== apiVersion) throw new Error();
  } catch { throw new Error(integrityRefusal); }

  const salt = randomBytes(32);
  const hash = (value: string) => createHash('sha256').update(salt).update(value).digest('hex');
  const bindings = new Map<string, { request: unknown; sentAt: number; succeeded: boolean }>();
  async function call<T>(kind: 'card' | 'tax', operation: string, invoke: () => Promise<T>,
    mutation?: { key: string; reference: string; parameters: unknown; before?: number }): Promise<T> {
    let binding;
    let evidence: Evidence | undefined;
    if (mutation) {
      const { key, reference, parameters, before } = mutation;
      const fingerprint = { kind, operation, reference, parameters };
      binding = bindings.get(key);
      const time = now();
      if (binding) {
        if (!isDeepStrictEqual(binding.request, fingerprint) || !binding.succeeded
          || time >= Math.min(before ?? Infinity, binding.sentAt + replayLimit)) throw new Error(integrityRefusal);
        record({ operation, key: hash(key), reference: hash(reference), replayAgeMs: time - binding.sentAt });
      } else {
        if (before !== undefined && time >= before) throw new Error(integrityRefusal);
        binding = { request: structuredClone(fingerprint), sentAt: time, succeeded: false };
        bindings.set(key, binding);
      }
      evidence = { operation, key: hash(key), reference: hash(reference) };
    }
    try {
      const result = await invoke();
      if (binding) binding.succeeded = true;
      return result;
    } catch (error) {
      if (error instanceof Sdk.errors.StripeError && (error.statusCode === 400 || error.statusCode === 402
        || error.statusCode === 404 || error.rawType === 'idempotency_error')) {
        if (kind === 'card') throw new CardRejection(declineCode(error.code));
        const refusal = taxRejection(operation, error);
        if (evidence && refusal.code === 'tax_reference_conflict') record({ ...evidence, effect: 'unknown' });
        throw Object.assign(new Error(refusal.remedy), { name: 'TaxProviderRejection', field: refusal.field, code: refusal.code });
      }
      if (evidence) record({ ...evidence, effect: 'unknown' });
      throw new ProviderUnavailable();
    }
  }

  const write = <T>(kind: 'card' | 'tax', operation: string, reference: string, parameters: unknown, options: WriteOptions,
    invoke: () => Promise<T>, before?: number) => call(kind, operation, invoke,
      { key: options.idempotencyKey, reference, parameters, ...(before === undefined ? {} : { before }) });
  const card = Object.freeze({
    customer: (parameters: ProviderSdk.CustomerCreateParams, options: WriteOptions) =>
      write('card', 'customer', options.idempotencyKey, parameters, options, () => sdk.customers.create(parameters, options)),
    create: (parameters: ProviderSdk.PaymentIntentCreateParams, options: WriteOptions) =>
      write('card', 'intent', options.idempotencyKey, parameters, options, () => sdk.paymentIntents.create(parameters, options)),
    confirm: (id: string, parameters: ProviderSdk.PaymentIntentConfirmParams, options: WriteOptions) =>
      write('card', 'confirm', id, parameters, options, () => sdk.paymentIntents.confirm(id, parameters, options)),
    retrieve: (id: string, timeout = deadline) =>
      call('card', 'retrieve', () => sdk.paymentIntents.retrieve(id, { expand: ['latest_charge'] }, { timeout })),
    capture: (id: string, options: WriteOptions, before: number) =>
      write('card', 'capture', id, { amount_to_capture: 1000 }, options, () => sdk.paymentIntents.capture(id, { amount_to_capture: 1000 }, options), before),
    cancel: (id: string, options: WriteOptions) =>
      write('card', 'cancel', id, {}, options, () => sdk.paymentIntents.cancel(id, {}, options)),
    charges: (id: string) => call('card', 'charges', () => sdk.charges.list({ payment_intent: id, limit: 100 })),
  });
  const tax = Object.freeze({
    scope,
    calculations: Object.freeze({
      create: (params: ProviderSdk.Tax.CalculationCreateParams, options: WriteOptions) =>
        write('tax', 'calculation', options.idempotencyKey, params, options, () => sdk.tax.calculations.create(params, options)),
      retrieve: (id: string) => call('tax', 'calculationRead', () => sdk.tax.calculations.retrieve(id, { expand: ['shipping_cost.tax_breakdown'] })),
      listLineItems: (id: string, params: ProviderSdk.Tax.CalculationListLineItemsParams) =>
        call('tax', 'calculationLines', () => sdk.tax.calculations.listLineItems(id, params)),
    }),
    registrations: Object.freeze({ list: (params: ProviderSdk.Tax.RegistrationListParams) =>
      call('tax', 'registrations', () => sdk.tax.registrations.list(params)) }),
    transactions: Object.freeze({
      createFromCalculation: (params: ProviderSdk.Tax.TransactionCreateFromCalculationParams, options: WriteOptions, before?: number) =>
        write('tax', 'commit', params.reference, params, options, () => sdk.tax.transactions.createFromCalculation(params, options), before),
      createReversal: (params: ProviderSdk.Tax.TransactionCreateReversalParams, options: WriteOptions, before?: number) =>
        write('tax', 'reverse', params.reference, params, options, () => sdk.tax.transactions.createReversal(params, options), before),
      retrieve: (id: string) => call('tax', 'transactionRead', () => sdk.tax.transactions.retrieve(id)),
      listLineItems: (id: string, params: ProviderSdk.Tax.TransactionListLineItemsParams) =>
        call('tax', 'transactionLines', () => sdk.tax.transactions.listLineItems(id, params)),
    }),
  } satisfies Options['client']);
  return Object.freeze({ scope, card, tax, apiVersion: observedVersion });
}

export type VerifiedTestProvider = Awaited<ReturnType<typeof openTestProvider>>;

export function composeProviderTax(provider: VerifiedTestProvider, options: Omit<Options, 'client'>) {
  return createStripeTaxAdapter({ ...options, client: provider.tax });
}
