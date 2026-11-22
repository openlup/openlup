import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { argv, env, execPath, stdin, stdout, stderr } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { makeTaxQuoteRequest } from '@openlup/platform/tax';
import type { TaxCommitRequestV1, TaxQuoteInputV1, TaxReverseRequestV1, TaxCommitResultV1, TaxReverseResultV1, TaxRefusal, TaxUnavailable } from '@openlup/platform/tax/contracts';
import { pathToFileURL } from 'node:url';
import {
  accountId, CardRejection, composeProviderTax, credentialRefusal, declineCode, fixedTaxRemedy, integrityRefusal, makeReportingDigest, openTestProvider, ProviderUnavailable, sdkVersion, TaxProviderRejection,
  type VerifiedTestProvider,
} from './provider-transport.ts';

const usage = 'Run npm run provider:qualify -- --run --test-mode --account <id> --key-env <name> in an interactive session outside CI.';
const launcherSetup = 'Install the 1Password CLI and make it available on your PATH, then retry.';
const cardRefusal = 'Re-obtain evidence for the original test intent in the bound account.';
const statuses = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'canceled', 'succeeded'];
const id = (value: unknown, kind: string): value is string =>
  typeof value === 'string' && value.startsWith(kind + '_') && /^[A-Za-z0-9_]{4,128}$/u.test(value);
const reserved = /^(?:CI$|(?:NODE|NPM|OP|OPENSSL|LD|DYLD|UV|SSL|LC|BASH|GIT)_|PATH$|HOME$|TERM$|COLORTERM$|USER$|LANG$|LOGNAME$)/iu;
type Environment = Record<string, string | undefined>;
type RecordEntry = Record<string, string | number | boolean | null | undefined>;
const minor = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
type Witness = { hash: (value: string) => string; note: (entry: RecordEntry) => void };
type Card = VerifiedTestProvider['card'];
type Intent = Awaited<ReturnType<Card['retrieve']>>;

export function preflight(args: string[], interactive: boolean, environment: Environment) {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flags.has(flag)) throw new Error(usage);
    if (flag === '--run' || flag === '--test-mode') flags.set(flag, '');
    else if (flag === '--account' || flag === '--key-env') flags.set(flag, args[++index] ?? '');
    else throw new Error(usage);
  }
  const accountRef = flags.get('--account') ?? '', keyEnv = flags.get('--key-env') ?? '';
  if (flags.size !== 4 || !accountId.test(accountRef) || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(keyEnv) || reserved.test(keyEnv)
    || !interactive || ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'BUILD_BUILDID', 'BUILDKITE', 'JENKINS_URL']
      .some(name => Boolean(environment[name]))) throw new Error(usage);
  return { accountRef, keyEnv };
}

export function launch(args: string[], { interactive = stdin.isTTY === true, environment = env, spawn = spawnSync } = {}) {
  const { keyEnv } = preflight(args, interactive, environment);
  const reference = environment[keyEnv];
  if (!reference || !/^op:\/\/[^\s/]+\/[^\s/]+\/(?:[^\s/]+\/)?[^\s/]+$/u.test(reference)) throw new Error(credentialRefusal);
  const options = Object.fromEntries(['PATH', 'HOME', 'TERM', 'COLORTERM', 'USER', 'LANG', 'LOGNAME'].map(name => [name, environment[name]]));
  let missing = false;
  try {
    const result = spawn('op', ['run', '--', execPath, '--input-type=module', '-e',
      'try { const { runChild } = await import(process.argv[1]); await runChild(process.argv.slice(2)); } catch { process.exitCode = 1; }',
      '--', import.meta.url, ...args], { env: { ...options, [keyEnv]: reference }, stdio: ['inherit', 'inherit', 'ignore'] });
    if (result.status === 0) return;
    missing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  } catch { /* Keep launcher failures out of diagnostics. */ }
  if (missing) throw new Error(launcherSetup);
  throw new Error('Provider qualification did not complete. Check the test-account reference and qualification transcript.');
}

function requireCard(condition: unknown): asserts condition {
  if (!condition) throw new Error(cardRefusal);
}
const observedCharge = (intent: Intent) => typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
function hold(intent: Intent) {
  const charge = observedCharge(intent);
  const before = charge?.payment_method_details?.card?.capture_before;
  requireCard(intent.livemode === false && intent.status === 'requires_capture' && intent.capture_method === 'manual'
    && intent.amount === 1000 && intent.currency === 'usd' && intent.amount_received === 0 && intent.amount_capturable === 1000
    && charge?.livemode === false && id(charge.id, 'ch') && charge.payment_intent === intent.id
    && charge.captured === false && charge.amount_captured === 0 && Number.isSafeInteger(charge.created)
    && Number.isSafeInteger(before) && before! > charge.created && before! * 1000 > Date.now());
  return { charge, before: before! * 1000 };
}

async function loopback() {
  let redirect: string | undefined;
  let returnAt: number | undefined;
  const route = '/' + randomUUID();
  const start = route + '/start', callback = route + '/return', done = route + '/done';
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const path = request.url?.split('?', 1)[0];
    if (request.method !== 'GET' || request.headers.host !== new URL(base).host) response.writeHead(404).end();
    else if (path === start && redirect) response.writeHead(303, { Location: redirect }).end();
    else if (path === callback && redirect) {
      returnAt ??= performance.now();
      response.writeHead(303, { Location: done }).end();
    } else if (path === done) response.end('Return to the terminal.');
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  requireCard(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  return {
    returnUrl: base + callback, startUrl: base + start, returnedAt: () => returnAt,
    approve(value: string | null | undefined) {
      const url = value && URL.parse(value);
      requireCard(url && url.protocol === 'https:' && !url.username && !url.password);
      redirect = url.href;
    },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

export async function qualifyCard(card: Card, witness: Witness, prompt: (url: string) => void, signal: AbortSignal,
  openLoopback = loopback, pause: (milliseconds: number, value: undefined, options: { signal: AbortSignal }) => Promise<void> = delay,
  monotonic = () => performance.now()) {
  const key = () => ({ idempotencyKey: randomUUID() });
  const tag = randomUUID();
  const metadata = { qualification: tag };
  const pending = new Set<string>();
  const cancelAttempts = new Map<string, string>();
  const read = async (ref: string, budget?: number) => {
    const intent = await card.retrieve(ref, budget);
    requireCard(intent.id === ref && intent.livemode === false && intent.metadata?.qualification === tag && intent.currency === 'usd'
      && intent.amount === 1000 && intent.capture_method === 'manual');
    witness.note({ operation: 'intent_read', intent: witness.hash(ref),
      status: statuses.includes(intent.status) ? intent.status : 'unknown', at: new Date().toISOString(),
      currency: intent.currency, receivedMinor: minor(intent.amount_received), capturableMinor: minor(intent.amount_capturable),
      decline: declineCode(intent.last_payment_error?.code) });
    return intent;
  };
  const create = async (customer: string, setup = false) => {
    signal.throwIfAborted();
    const intent = await card.create({ amount: 1000, currency: 'usd', payment_method_types: ['card'], capture_method: 'manual',
      customer, metadata, ...(setup ? { setup_future_usage: 'off_session' } : {}) }, key());
    requireCard(id(intent.id, 'pi') && intent.livemode === false && intent.metadata?.qualification === tag && intent.customer === customer);
    pending.add(intent.id);
    return intent.id;
  };
  const confirm = async (ref: string, values: Parameters<Card['confirm']>[1]) => {
    signal.throwIfAborted();
    try { await card.confirm(ref, values, key()); }
    catch (error) {
      if (!(error instanceof CardRejection)) throw error;
      witness.note({ operation: 'confirmation_refused', intent: witness.hash(ref), decline: error.code });
    }
    return read(ref);
  };
  const captureRefused = async (ref: string, before: number) => {
    signal.throwIfAborted();
    try { await card.capture(ref, key(), before); }
    catch (error) {
      requireCard(error instanceof CardRejection && error.code === 'payment_intent_unexpected_state');
      const observed = await read(ref);
      requireCard(observed.amount_received === 0 && !observedCharge(observed)?.amount_captured);
      witness.note({ operation: 'capture_refused', verdict: 'pass', intent: witness.hash(ref) });
      return;
    }
    throw new Error(cardRefusal);
  };
  const verifyHold = (intent: Intent) => {
    const result = hold(intent);
    witness.note({ operation: 'hold', intent: witness.hash(intent.id), charge: witness.hash(result.charge.id),
      capture_before: new Date(result.before).toISOString(), holdWindowMs: result.before - result.charge.created * 1000, currency: 'usd', authorizedMinor: 1000 });
    return result;
  };
  const verifyCanceled = (intent: Intent, chargeId: string) => {
    const charge = observedCharge(intent);
    requireCard(intent.status === 'canceled' && intent.amount_received === 0 && intent.amount_capturable === 0
      && charge?.id === chargeId && charge.livemode === false && charge.payment_intent === intent.id
      && charge.captured === false && charge.amount_captured === 0);
    pending.delete(intent.id);
  };
  const cancel = async (intent: Intent) => {
    const { charge } = verifyHold(intent);
    requireCard(!cancelAttempts.has(intent.id));
    cancelAttempts.set(intent.id, charge.id);
    try { await card.cancel(intent.id, key()); }
    catch { /* Resolve the attempted cancellation by scoped readback. */ }
    verifyCanceled(await read(intent.id), charge.id);
  };
  const authorize = async (customer: string, method: string) => {
    const ref = await create(customer, true);
    const browser = await openLoopback();
    try {
      let intent = await confirm(ref, { payment_method: method, return_url: browser.returnUrl, use_stripe_sdk: false });
      requireCard(intent.status === 'requires_action' && intent.amount_received === 0);
      await captureRefused(ref, Date.now() + 10_000);
      const started = monotonic(), end = started + 300_000;
      browser.approve(intent.next_action?.redirect_to_url?.url);
      prompt(browser.startUrl);
      while (intent.status !== 'requires_capture' || browser.returnedAt() === undefined) {
        requireCard(intent.status === 'requires_action' || intent.status === 'processing' || intent.status === 'requires_capture');
        const remaining = end - monotonic();
        requireCard(remaining > 10);
        await pause(Math.min(2000, remaining - 10), undefined, { signal });
        const timeout = Math.floor(end - monotonic());
        requireCard(timeout > 0);
        intent = await read(ref, timeout);
      }
      const returned = browser.returnedAt();
      requireCard(returned !== undefined && returned >= started && returned <= end && monotonic() <= end
        && intent.customer === customer && intent.setup_future_usage === 'off_session' && id(intent.payment_method, 'pm'));
      hold(intent);
      witness.note({ operation: 'challenge_return', intent: witness.hash(ref), verdict: 'pass' });
      return { intent, method: intent.payment_method };
    } finally { await browser.close(); }
  };
  const capture = async (intent: Intent, replay: boolean) => {
    signal.throwIfAborted();
    const { before, charge } = verifyHold(intent);
    const options = key();
    const verifyCapture = async (receipt: Intent) => {
      const chargeId = typeof receipt.latest_charge === 'string' ? receipt.latest_charge : observedCharge(receipt)?.id;
      requireCard(receipt.id === intent.id && receipt.livemode === false && receipt.status === 'succeeded'
        && chargeId === charge.id && receipt.amount_received === intent.amount);
      const actual = await read(intent.id);
      const charges = await card.charges(intent.id), [posted] = charges.data;
      requireCard(actual.status === 'succeeded' && actual.amount_received === intent.amount
        && observedCharge(actual)?.id === charge.id && charges.has_more === false && charges.data.length === 1
        && posted?.id === charge.id && posted.livemode === false && posted.payment_intent === intent.id
        && posted.currency === 'usd' && posted.captured && posted.amount_captured === intent.amount);
      return posted;
    };
    const first = await verifyCapture(await card.capture(intent.id, options, before));
    const posted = replay ? await verifyCapture(await card.capture(intent.id, options, before)) : first;
    pending.delete(intent.id);
    witness.note({ operation: 'capture', verdict: 'pass', intent: witness.hash(intent.id), charge: witness.hash(posted.id), currency: 'usd', receivedMinor: 1000 });
  };
  signal.throwIfAborted();
  const customer = await card.customer({ metadata }, key());
  requireCard(id(customer.id, 'cus') && customer.livemode === false && customer.metadata?.qualification === tag);
  let unresolved = false;
  try {
    const setup = await authorize(customer.id, 'pm_card_authenticationRequiredOnSetup');
    await capture(setup.intent, true);
    const ordinary = await create(customer.id);
    await cancel(await confirm(ordinary, { payment_method: 'pm_card_visa' }));
    await captureRefused(ordinary, Date.now() + 10_000);
    const reuse = await create(customer.id);
    const reused = await confirm(reuse, { payment_method: setup.method, off_session: true });
    requireCard(reused.customer === customer.id && reused.payment_method === setup.method);
    await cancel(reused);
    const required = await authorize(customer.id, 'pm_card_authenticationRequired');
    await capture(required.intent, false);
    const recovery = await create(customer.id);
    const result = await confirm(recovery, { payment_method: required.method, off_session: true, error_on_requires_action: false });
    requireCard(result.status === 'requires_action' && result.amount_received === 0 && result.amount_capturable === 0
      && result.payment_method === required.method && !observedCharge(result)?.amount_captured);
    witness.note({ operation: 'recovery_link', verdict: 'pass', intent: witness.hash(recovery) });
  } finally {
    for (const ref of pending) {
      try {
        const intent = await read(ref);
        const attempted = cancelAttempts.get(ref);
        if (attempted !== undefined) verifyCanceled(intent, attempted);
        else if (intent.status === 'requires_capture') await cancel(intent);
      } catch {
        unresolved = true;
        witness.note({ operation: 'unresolved_hold', effect: 'unknown', intent: witness.hash(ref) });
      }
    }
  }
  if (unresolved) throw new Error(cardRefusal);
}

const taxRefusal = 'Check the documented test-account tax inputs and reconcile the original operation.';
const noReportingEffect = 'No reporting effect was observed. Check tax configuration in the bound test account.';
class TaxQualificationRefusal extends Error {
  constructor(result: TaxRefusal | TaxUnavailable) {
    if (result.kind === 'unavailable') {
      super(result.effect === 'unknown' ? integrityRefusal : noReportingEffect);
    } else {
      const fixed = fixedTaxRemedy(result.code, result.field);
      super(fixed !== undefined && fixed === result.remedy ? fixed
        : result.code === 'tax_scope_mismatch' || result.code === 'tax_reference_conflict' ? integrityRefusal : taxRefusal);
    }
  }
}
const reason = (value: unknown) => ['not_collecting', 'not_subject_to_tax', 'product_exempt', 'standard_rated', 'zero_rated',
  'product_exempt_holiday', 'customer_exempt', 'not_supported'].find(allowed => allowed === value) ?? 'other';
const fixtures = [
  { state: 'NY', city: 'New York', line1: '350 5th Ave', postal_code: '10118', shipping: 100 },
  { state: 'CA', city: 'San Francisco', line1: '1 Market St', postal_code: '94105', shipping: 0 },
];
type TaxOptions = Parameters<typeof composeProviderTax>[1];
type RecoveryOperation = 'quote' | 'post' | 'reverse';
type EvidenceByRef = (operation: RecoveryOperation, reference: string) => Promise<string | undefined>;

export const recoveryPrompt = (operation: RecoveryOperation, reference: string) =>
  `Find the original tax ${operation} with reference ${reference} in the bound test dashboard. Enter its ${operation === 'quote' ? 'calculation' : 'transaction'} ID, or leave blank: `;

export async function qualifyTax(provider: VerifiedTestProvider, witness: Witness, observeOriginal: EvidenceByRef, signal: AbortSignal) {
  const ref = 'qualification-' + randomUUID();
  const now = () => new Date();
  const second = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  function verify(condition: unknown): asserts condition {
    if (!condition) throw new Error(integrityRefusal);
  }
  const [ny, ca] = fixtures;
  const calc = async (fixture: typeof fixtures[number]) => {
    signal.throwIfAborted();
    const { shipping, ...address } = fixture;
    const destination = { ...address, country: 'US' };
    const quoteRef = `${ref}-${fixture.state.toLowerCase()}`;
    const params = {
      currency: 'usd', customer_details: { address: destination, address_source: 'shipping' }, ship_from_details: { address: destination },
      expand: ['shipping_cost.tax_breakdown'],
      shipping_cost: { amount: shipping, tax_behavior: 'exclusive', tax_code: 'txcd_92010001' },
      line_items: [{ amount: 1000, quantity: 1, reference: quoteRef, tax_behavior: 'exclusive', tax_code: 'txcd_99999999' }],
    } satisfies Parameters<typeof provider.tax.calculations.create>[0];
    const key = randomUUID();
    let calculated;
    try { calculated = await provider.tax.calculations.create(params, { idempotencyKey: key }); }
    catch (error) {
      if (!(error instanceof ProviderUnavailable)) throw error;
      witness.note({ operation: 'quote', effect: 'unknown', key: witness.hash(key), reference: witness.hash(quoteRef) });
      const original = await observeOriginal('quote', quoteRef);
      verify(id(original, 'taxcalc'));
      calculated = await provider.tax.calculations.retrieve(original);
      verify(calculated.id === original);
    }
    verify(id(calculated.id, 'taxcalc') && calculated.livemode === false && calculated.currency === 'usd');
    const list = await provider.tax.calculations.listLineItems(calculated.id, { limit: 100, expand: ['data.tax_breakdown'] });
    verify(list.has_more === false && list.url === '/v1/tax/calculations/' + calculated.id + '/line_items'
      && list.data.length === 1 && list.data[0]?.livemode === false && list.data[0].reference === quoteRef
      && list.data[0].amount === params.line_items[0]?.amount);
    const cost = calculated.shipping_cost;
    verify(Array.isArray(calculated.tax_breakdown) && Array.isArray(list.data[0].tax_breakdown)
      && (cost === null ? shipping === 0 : cost?.amount === shipping && Array.isArray(cost.tax_breakdown)));
    const shippingDetails = cost === null ? [] : cost.tax_breakdown!;
    const lineDetails = list.data[0].tax_breakdown;
    witness.note({ operation: 'tax_quote', region: fixture.state, calculation: witness.hash(calculated.id), currency: 'usd',
      payableMinor: minor(calculated.amount_total), shippingMinor: minor(calculated.shipping_cost?.amount),
      shippingShape: calculated.shipping_cost === null ? 'absent' : shippingDetails.length ? 'detail' : 'empty' });
    for (const [shape, rows] of [['header', calculated.tax_breakdown], ['shipping', shippingDetails], ['line', lineDetails]] as const) {
      for (const row of rows) {
        const rate = row.tax_rate_details;
        const rawRateType = shape === 'header' && rate && 'rate_type' in rate ? rate.rate_type : undefined;
        const rateType = rawRateType === null || rawRateType === 'percentage' || rawRateType === 'flat_amount' ? rawRateType : undefined;
        verify(shape !== 'header' || rateType !== undefined);
        witness.note({ operation: 'tax_breakdown', region: fixture.state, shape, taxability: reason(row.taxability_reason),
          amountMinor: minor(row.amount), basisMinor: minor(row.taxable_amount), rateType,
          fee: rate?.tax_type === 'retail_delivery_fee', hasRate: rate !== null });
      }
    }
    return [...lineDetails, ...shippingDetails];
  };
  const observed = await calc(ny!);
  await calc(ca!);
  signal.throwIfAborted();

  // Use the scoped quote to identify the fixture's reported jurisdictions. Registration evidence is read independently by the adapter.
  const jurisdictions = [...new Map(observed.map(({ jurisdiction, sourcing, tax_rate_details }) => {
    const name = [jurisdiction.level, jurisdiction.display_name].join('-');
    return [name, { jurisdiction: witness.hash(name), taxKind: 'sales', level: jurisdiction.level,
      sourcing: sourcing === 'origin' ? 'ship_from' as const : 'destination' as const,
      provider: jurisdiction, taxType: tax_rate_details?.tax_type ?? null }];
  })).values()];
  verify(jurisdictions.length && jurisdictions.every(row => !row.taxType || row.taxType === 'sales_tax'));
  const taxDate = second(), scope = { adapter: 'stripeTax', adapterVersion: '1', ...provider.scope };
  const address = { countryCode: 'US', subdivisionCode: 'US-NY', line1: ny!.line1, city: ny!.city, postalCode: ny!.postal_code };
  const delivery = { bucketKey: 'shipping', carrierRef: 'fixture', serviceRef: 'fixture', separatelyStated: true,
    taxClass: 'shipping', assignmentRef: 'shipping', cost: { ref: 'shipping', currency: 'USD', amountMinor: ny!.shipping } };
  const marketPack: TaxOptions['marketPack'] = { scope, market: 'qualification', currency: 'USD', policyRevision: 'test', classMapRevision: 'test',
    taxCodes: { merchandise: 'txcd_99999999', shipping: 'txcd_92010001' }, origins: { fixture: address },
    subdivisions: { US: { 'US-NY': 'NY' } }, delivery: [{ ...delivery, costIndependent: true, zeroAmount: false }],
    jurisdictions, registrations: jurisdictions.map(row => ({ jurisdiction: row.jurisdiction, taxKind: row.taxKind,
      country: 'US', state: 'NY', type: 'state_sales_tax', complete: true })), fees: [] };
  const input: TaxQuoteInputV1 = { scope, market: marketPack.market, currency: 'USD', purpose: 'final', taxDate,
    destination: { snapshotRef: 'fixture', digest: witness.hash('fixture-address'), policyRevision: 'test', address },
    shipFromRef: 'fixture', policyRevision: 'test', classMapRevision: 'test', delivery: [delivery],
    lines: [{ lineKey: 'item', sku: 'fixture', mode: 'one_time', taxClass: 'merchandise', assignmentRef: 'fixture' }],
    money: { amountBasis: 'exclusive', sources: [{ lineKey: 'item', sourceOrdinal: 1, quantity: 1, unitBasisMinor: 1000 }],
      delivery: [{ bucketKey: 'shipping', deliveryKind: 'shipping', amountMinor: ny!.shipping }], adjustments: [], fees: [] },
    required: jurisdictions.flatMap(({ jurisdiction, taxKind, level, sourcing }) => [
      { target: { kind: 'line', key: 'item' }, jurisdiction, taxKind, level, sourcing },
      { target: { kind: 'delivery', key: 'shipping' }, jurisdiction, taxKind, level, sourcing },
    ]),
    coverage: { schemaVersion: 1, accountRef: scope.accountRef, revision: 'test', declarations: jurisdictions.map(({ jurisdiction, taxKind }) =>
      ({ jurisdiction, taxKind, status: 'registered', actorRef: 'fixture', recordedAt: taxDate, effective: { from: taxDate } })) },
  };

  const effects: Partial<{ [Key in 'accepted' | 'commit' | 'reverse']: ReturnType<TaxOptions['effects'][Key]> }> = {};
  let lookup: string | undefined, observedId: string | undefined;
  const port = composeProviderTax(provider, { installationRef: ref, marketPack, now, effects: {
    accepted: () => effects.accepted, commit: () => effects.commit, reverse: () => effects.reverse,
    findTransactionIdByReference: reference => { lookup = reference; return observedId; },
  } });
  const request = makeTaxQuoteRequest(ref, input);
  const result = await port.quote(request);
  if (result.kind === 'unavailable' || result.kind === 'refused') throw new TaxQualificationRefusal(result);
  if (result.kind !== 'final') throw new Error(taxRefusal);
  effects.accepted = { request, result, closed: false };
  verify(result.money.feeTotal === 0);
  const { evidence, evidenceDigest } = result;
  const capturedAt = now().toISOString();
  // Wait for the first whole-second posting instant at or after capture.
  const postingTime = Math.ceil(Date.parse(capturedAt) / 1000) * 1000;
  const postingBudget = performance.now() + 2000;
  let remaining;
  while ((remaining = postingTime - Date.now()) > 0) {
    verify(remaining < postingBudget - performance.now());
    await delay(remaining, undefined, { signal });
  }
  const postedAt = new Date(postingTime).toISOString();
  const commit: TaxCommitRequestV1 = { calculationRef: { scope, ref: evidence.calculationRef, evidenceDigest },
    transactionRef: ref, postedAt, capturedAt, captureEvidenceRef: ref, intent: 'apply' };
  const capture = { ref, capturedAt, currency: 'USD', payableMinor: result.money.payableMinor };
  const send = { kind: 'ready' as const, before: evidence.expiresAt };
  effects.commit = { capture, requestDigest: makeReportingDigest({ operation: 'commit', request: commit, capture }), send };

  async function post<R extends TaxCommitResultV1 | TaxReverseResultV1>(name: 'post' | 'reverse',
    run: (intent: 'apply' | 'recover') => Promise<R>, resultId: (value: R) => string | undefined) {
    signal.throwIfAborted();
    lookup = undefined;
    observedId = undefined;
    const first = await run('apply');
    const firstId = resultId(first);
    if (firstId) {
      const replay = await run('apply');
      if (replay.kind === 'unavailable' || replay.kind === 'refused') throw new TaxQualificationRefusal(replay);
      verify(resultId(replay) === firstId && JSON.stringify(replay) === JSON.stringify(first));
      return first;
    }
    if (first.kind === 'unavailable' && first.effect === 'unknown' && lookup) {
      witness.note({ operation: name, effect: 'unknown', key: witness.hash(lookup), reference: witness.hash(lookup) });
      const original = await observeOriginal(name, lookup);
      if (id(original, 'tax')) {
        observedId = original;
        const recovered = await run('recover');
        if (resultId(recovered) === original) return recovered;
      }
      throw new Error(integrityRefusal);
    }
    if (first.kind === 'refused' || first.kind === 'unavailable') throw new TaxQualificationRefusal(first);
    throw new Error(integrityRefusal);
  }
  const posted = await post('post', intent => port.commit({ ...commit, intent }),
    row => row.kind === 'committed' ? row.providerTransactionRef : undefined);
  verify(posted.kind === 'committed');
  const units: NonNullable<typeof effects.reverse>['original']['units'][number][] = [];
  for (const component of result.money.components) {
    const lineRef = component.ref.kind === 'merchandise' ? evidence.providerLines?.[0]?.providerLineRef : 'shipping:' + evidence.calculationRef;
    const position = posted.positions.find(row => row.originalPositionRef === lineRef);
    verify(position);
    const merchandise = component.ref.kind === 'merchandise';
    units.push({ kind: merchandise ? 'line' : 'shipping', ...position, taxCode: merchandise ? 'txcd_99999999' : 'txcd_92010001',
      remainingNetMinor: component.final.amountMinor, remainingTaxMinor: component.final.taxMinor });
  }
  const reverse: TaxReverseRequestV1 = { scope, originalRef: posted.providerTransactionRef, reversalRef: ref,
    refundEvidenceRef: ref, currency: 'USD', fromMinor: 0, toMinor: result.money.payableMinor, intent: 'apply', mode: 'full',
    positions: units.map(unit => ({ originalPositionRef: unit.originalPositionRef,
      netDeltaMinor: -unit.remainingNetMinor || 0, taxDeltaMinor: -unit.remainingTaxMinor || 0, feeDeltaMinor: 0 })) };
  const original = { id: posted.providerTransactionRef, scope, currency: 'USD', taxDate, payableMinor: result.money.payableMinor, refundedMinor: 0, units };
  effects.reverse = { original, refundEvidenceRef: ref, send, requestDigest: makeReportingDigest({ operation: 'reverse', request: reverse, refundEvidenceRef: ref, original }) };
  const reversed = await post('reverse', intent => port.reverse({ ...reverse, intent }),
    row => row.kind === 'reversed' ? row.providerReversalRef : undefined);
  verify(reversed.kind === 'reversed');
  witness.note({ operation: 'tax_reporting', verdict: 'pass', currency: 'USD', payableMinor: result.money.payableMinor,
    taxMinor: result.money.taxTotal, sale: witness.hash(posted.providerTransactionRef), reversal: witness.hash(reversed.providerReversalRef) });
}

export function qualificationMessage(error: unknown): string {
  if (error instanceof TaxProviderRejection) return fixedTaxRemedy(error.code, error.field) ?? integrityRefusal;
  if (error instanceof TaxQualificationRefusal
    || (error instanceof Error && [credentialRefusal, integrityRefusal, cardRefusal, taxRefusal].includes(error.message))) return error.message;
  return 'Qualification could not verify the original operation. Check the bound test account.';
}

export async function runChild(args: string[], { interactive = stdin.isTTY === true, environment = env,
  open = openTestProvider, output = (text: string) => stdout.write(text), persist = writeFile } = {}) {
  const { accountRef, keyEnv } = preflight(args, interactive, environment);
  const secretKey = environment[keyEnv];
  delete environment[keyEnv];
  if (!secretKey) throw new Error(credentialRefusal);
  const records: RecordEntry[] = [];
  const salt = randomBytes(32);
  const witness: Witness = { hash: value => createHmac('sha256', salt).update(value).digest('hex'), note: entry => records.push(entry) };
  const signal = new AbortController();
  const stop = () => signal.abort();
  const startedAt = new Date().toISOString();
  const filename = 'provider-qualification-' + randomUUID() + '.json';
  let version: string | undefined, release: string | undefined;
  let result = 'fail';
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const provider = await open({ secretKey, accountRef }, { record: entry => witness.note(entry) });
    version = provider.apiVersion;
    const origin = JSON.parse(await readFile(new URL('../.starter-origin.json', import.meta.url), 'utf8'));
    requireCard(origin.mode === 'candidate' && /^\d+\.\d+\.\d+$/u.test(origin.setVersion));
    release = origin.setVersion;
    await qualifyCard(provider.card, witness, url => output('Open ' + url + ' in your browser.\n'), signal.signal);
    await qualifyTax(provider, witness, async (operation, reference) => {
      const input = createInterface({ input: stdin, output: stdout, terminal: false });
      try {
        return await input.question(recoveryPrompt(operation, reference),
          { signal: AbortSignal.any([signal.signal, AbortSignal.timeout(60_000)]) });
      } catch { return undefined; }
      finally { input.close(); }
    }, signal.signal);
    result = 'pass';
  } catch (error) {
    output(qualificationMessage(error) + '\n');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await persist(filename, JSON.stringify({ startedAt, endedAt: new Date().toISOString(), result, release, account: witness.hash(accountRef),
      apiVersion: version, sdk: 'stripe', sdkVersion, keyRetentionHours: 24, records }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    output('Read ' + filename + ' for qualification results.\n');
  }
  if (result !== 'pass') throw new Error('Provider qualification did not pass.');
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  try { launch(argv.slice(2)); }
  catch (error) {
    stderr.write((error instanceof Error ? error.message : usage) + '\n');
    process.exitCode = 1;
  }
}
