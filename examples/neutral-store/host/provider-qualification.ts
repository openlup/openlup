import { isDeepStrictEqual } from 'node:util';
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
  accountId, CardRejection, composeProviderTax, credentialRefusal, fixedTaxRemedy, integrityRefusal, makeReportingDigest, openTestProvider, ProviderUnavailable, sdkVersion, TaxProviderRejection,
  type VerifiedTestProvider,
} from './provider-transport.ts';
import { declineCode, field, integer, literal, readCalculation, readCharge, readCustomer, readIntent, readPage, readTaxLine, reference, text,
  type readDetail, type readHeader } from './provider-response.ts';

const usage = 'Run npm run provider:qualify -- --run --test-mode --account <id> --key-env <name> in an interactive session outside CI.';
const launcherSetup = 'Install the 1Password CLI and make it available on your PATH, then retry.';
const cardRefusal = 'Re-obtain evidence for the original test intent in the bound account.';
const reserved = /^(?:CI$|(?:NODE|NPM|OP|OPENSSL|LD|DYLD|UV|SSL|LC|BASH|GIT)_|PATH$|HOME$|TERM$|COLORTERM$|USER$|LANG$|LOGNAME$)/iu;
type Environment = Record<string, string | undefined>;
type RecordEntry = Record<string, string | number | boolean | null | undefined>;
type Witness = { hash: (value: string) => string; note: (entry: RecordEntry) => void };
type Card = VerifiedTestProvider['card'];
type Intent = ReturnType<typeof readIntent>;
type ScopedIntent = Intent & { ref: string };

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
  if (typeof reference !== 'string' || !/^op:\/\/[^\s/]+\/[^\s/]+\/(?:[^\s/]+\/)?[^\s/]+$/u.test(reference)) throw new Error(credentialRefusal);
  const options = Object.fromEntries(['PATH', 'HOME', 'TERM', 'COLORTERM', 'USER', 'LANG', 'LOGNAME'].map(name => [name, environment[name]]));
  let missing = false;
  try {
    const result = spawn('op', ['run', '--', execPath, '--input-type=module', '-e',
      'try { const { runChild } = await import(process.argv[1]); await runChild(process.argv.slice(2)); } catch { process.exitCode = 1; }',
      '--', import.meta.url, ...args], { env: { ...options, [keyEnv]: reference }, stdio: ['inherit', 'inherit', 'ignore'] });
    const { status } = result;
    if (status === 0) return;
    missing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  } catch { /* Keep launcher failures out of diagnostics. */ }
  if (missing) throw new Error(launcherSetup);
  throw new Error('Provider qualification did not complete. Check the test-account reference and qualification transcript.');
}

function requireCard(condition: boolean): asserts condition {
  if (condition !== true) throw new Error(cardRefusal);
}
function hasNoCapture(intent: ScopedIntent) {
  const charge = intent.charge;
  return intent.receivedMinor === 0 && intent.capturableMinor === 0
    && (charge === null || (charge.live === false && charge.intentRef === intent.ref
      && charge.didCapture === false && charge.capturedMinor === 0));
}
function hold(intent: ScopedIntent) {
  const charge = intent.charge;
  requireCard(intent.live === false && intent.state === 'requires_capture' && intent.captureMethod === 'manual'
    && intent.authorizedMinor === 1000 && intent.currency === 'usd' && intent.receivedMinor === 0 && intent.capturableMinor === 1000
    && charge?.live === false && charge.ref !== undefined && charge.intentRef === intent.ref
    && charge.didCapture === false && charge.capturedMinor === 0 && charge.createdAt !== undefined
    && charge.captureBefore !== undefined && charge.captureBefore > charge.createdAt && charge.captureBefore * 1000 > Date.now());
  return { chargeRef: charge.ref, createdAt: charge.createdAt, before: charge.captureBefore * 1000 };
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
    else if (path === start && redirect !== undefined) response.writeHead(303, { Location: redirect }).end();
    else if (path === callback && redirect !== undefined) {
      returnAt ??= performance.now();
      response.writeHead(303, { Location: done }).end();
    } else if (path === done) response.end('Return to the terminal.');
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  requireCard(address !== null && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  return {
    returnUrl: base + callback, startUrl: base + start, returnedAt: () => returnAt,
    approve(value: string | null | undefined) {
      const url = typeof value === 'string' ? URL.parse(value) : null;
      requireCard(url !== null && url.protocol === 'https:' && url.username === '' && url.password === '');
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
  const read = async (ref: string, budget?: number): Promise<ScopedIntent> => {
    const intent = readIntent(await card.retrieve(ref, budget));
    requireCard(intent.ref === ref && intent.live === false && intent.tag === tag && intent.currency === 'usd'
      && intent.authorizedMinor === 1000 && intent.captureMethod === 'manual');
    const { receivedMinor, capturableMinor } = intent;
    witness.note({ operation: 'intent_read', intent: witness.hash(ref),
      status: intent.state ?? 'unknown', at: new Date().toISOString(),
      currency: intent.currency, receivedMinor, capturableMinor, decline: intent.decline });
    requireCard(intent.state !== undefined && receivedMinor !== undefined && receivedMinor >= 0
      && capturableMinor !== undefined && capturableMinor >= 0);
    return { ...intent, ref };
  };
  const create = async (customer: string, setup = false) => {
    signal.throwIfAborted();
    const intent = readIntent(await card.create({ amount: 1000, currency: 'usd', payment_method_types: ['card'], capture_method: 'manual',
      customer, metadata, ...(setup ? { setup_future_usage: 'off_session' } : {}) }, key()));
    requireCard(intent.ref !== undefined && intent.live === false && intent.tag === tag && intent.customerRef === customer);
    pending.add(intent.ref);
    return intent.ref;
  };
  const confirm = async (ref: string, values: Parameters<Card['confirm']>[1]) => {
    signal.throwIfAborted();
    try { await card.confirm(ref, values, key()); }
    catch (error) {
      if (!(error instanceof CardRejection)) throw error;
      witness.note({ operation: 'confirmation_refused', intent: witness.hash(ref), decline: field(error, 'code', declineCode) });
    }
    return read(ref);
  };
  const captureRefused = async (ref: string, status: 'requires_action' | 'canceled') => {
    signal.throwIfAborted();
    try { await card.capture(ref, key(), Date.now() + 10_000); }
    catch (error) {
      requireCard(error instanceof CardRejection && field(error, 'code', declineCode) === 'payment_intent_unexpected_state');
      const observed = await read(ref);
      requireCard(observed.state === status && hasNoCapture(observed));
      witness.note({ operation: 'capture_refused', verdict: 'pass', intent: witness.hash(ref) });
      return;
    }
    throw new Error(cardRefusal);
  };
  const verifyHold = (intent: ScopedIntent) => {
    const result = hold(intent);
    witness.note({ operation: 'hold', intent: witness.hash(intent.ref), charge: witness.hash(result.chargeRef),
      capture_before: new Date(result.before).toISOString(), holdWindowMs: result.before - result.createdAt * 1000, currency: 'usd', authorizedMinor: 1000 });
    return result;
  };
  const verifyCanceled = (intent: ScopedIntent, chargeRef: string) => {
    requireCard(intent.state === 'canceled' && intent.charge?.ref === chargeRef && hasNoCapture(intent));
    pending.delete(intent.ref);
  };
  const cancel = async (intent: ScopedIntent) => {
    const { chargeRef } = verifyHold(intent);
    requireCard(!cancelAttempts.has(intent.ref));
    cancelAttempts.set(intent.ref, chargeRef);
    try { await card.cancel(intent.ref, key()); }
    catch { /* Resolve the attempted cancellation by scoped readback. */ }
    verifyCanceled(await read(intent.ref), chargeRef);
  };
  const authorize = async (customer: string, method: string) => {
    const ref = await create(customer, true);
    const browser = await openLoopback();
    try {
      let intent = await confirm(ref, { payment_method: method, return_url: browser.returnUrl, use_stripe_sdk: false });
      requireCard(intent.state === 'requires_action' && intent.receivedMinor === 0);
      await captureRefused(ref, 'requires_action');
      const started = monotonic(), end = started + 300_000;
      browser.approve(intent.challengeUrl);
      prompt(browser.startUrl);
      while (intent.state !== 'requires_capture' || browser.returnedAt() === undefined) {
        requireCard(intent.state === 'requires_action' || intent.state === 'processing' || intent.state === 'requires_capture');
        const remaining = end - monotonic();
        requireCard(remaining > 10);
        await pause(Math.min(2000, remaining - 10), undefined, { signal });
        const timeout = Math.floor(end - monotonic());
        requireCard(timeout > 0);
        intent = await read(ref, timeout);
      }
      const returned = browser.returnedAt();
      requireCard(returned !== undefined && returned >= started && returned <= end && monotonic() <= end
        && intent.customerRef === customer && intent.futureUsage === 'off_session' && intent.methodRef !== undefined);
      hold(intent);
      witness.note({ operation: 'challenge_return', intent: witness.hash(ref), verdict: 'pass' });
      return { intent, method: intent.methodRef };
    } finally { await browser.close(); }
  };
  const capture = async (intent: ScopedIntent, replay: boolean) => {
    signal.throwIfAborted();
    const { before, chargeRef } = verifyHold(intent);
    const options = key();
    const capturedCharge = (row: Intent['charge'] | undefined) =>
      row?.ref === chargeRef && row.live === false && row.intentRef === intent.ref && row.currency === 'usd'
      && row.didCapture === true && row.capturedMinor === intent.authorizedMinor;
    const capturedIntent = (row: Intent) => row.state === 'succeeded' && row.authorizedMinor === intent.authorizedMinor
      && row.receivedMinor === intent.authorizedMinor && row.capturableMinor === 0;
    const verifyCapture = async (raw: unknown) => {
      const receipt = readIntent(raw);
      requireCard(receipt.ref === intent.ref && receipt.live === false && capturedIntent(receipt)
        && (receipt.unexpandedChargeRef === chargeRef || capturedCharge(receipt.charge)));
      const actual = await read(intent.ref);
      requireCard(capturedIntent(actual) && capturedCharge(actual.charge));
      const charges = readPage(await card.charges(intent.ref), readCharge);
      requireCard(charges.more === false && charges.rows?.length === 1 && capturedCharge(charges.rows[0]));
    };
    await verifyCapture(await card.capture(intent.ref, options, before));
    if (replay) await verifyCapture(await card.capture(intent.ref, options, before));
    pending.delete(intent.ref);
    witness.note({ operation: 'capture', verdict: 'pass', intent: witness.hash(intent.ref), charge: witness.hash(chargeRef), currency: 'usd', receivedMinor: 1000 });
  };
  signal.throwIfAborted();
  const customer = readCustomer(await card.customer({ metadata }, key()));
  requireCard(customer.ref !== undefined && customer.live === false && customer.tag === tag);
  let unresolved = false;
  try {
    const setup = await authorize(customer.ref, 'pm_card_authenticationRequiredOnSetup');
    await capture(setup.intent, true);
    const ordinary = await create(customer.ref);
    await cancel(await confirm(ordinary, { payment_method: 'pm_card_visa' }));
    await captureRefused(ordinary, 'canceled');
    const reuse = await create(customer.ref);
    const reused = await confirm(reuse, { payment_method: setup.method, off_session: true });
    requireCard(reused.customerRef === customer.ref && reused.methodRef === setup.method);
    await cancel(reused);
    const required = await authorize(customer.ref, 'pm_card_authenticationRequired');
    await capture(required.intent, false);
    const recovery = await create(customer.ref);
    const result = await confirm(recovery, { payment_method: required.method, off_session: true, error_on_requires_action: false });
    requireCard(result.state === 'requires_action' && result.methodRef === required.method && hasNoCapture(result));
    witness.note({ operation: 'recovery_link', verdict: 'pass', intent: witness.hash(recovery) });
  } finally {
    for (const ref of pending) {
      try {
        const intent = await read(ref);
        const attempted = cancelAttempts.get(ref);
        if (attempted !== undefined) verifyCanceled(intent, attempted);
        else if (intent.state === 'requires_capture') await cancel(intent);
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
      super(field(result, 'effect', literal('none')) === 'none' ? noReportingEffect : integrityRefusal);
    } else {
      const fixed = fixedTaxRemedy(result.code, result.field);
      super(fixed !== undefined && fixed === result.remedy ? fixed
        : result.code === 'tax_scope_mismatch' || result.code === 'tax_reference_conflict' ? integrityRefusal : taxRefusal);
    }
  }
}
const fixtures = [
  { state: 'NY', city: 'New York', line1: '350 5th Ave', postal_code: '10118', shipping: 100 },
  { state: 'CA', city: 'San Francisco', line1: '1 Market St', postal_code: '94105', shipping: 0 },
] as const;

type Header = ReturnType<typeof readHeader>;
type Detail = ReturnType<typeof readDetail>;

function verifyQuoteRows(region: 'NY' | 'CA', payable: number, headers: Header[], lines: Detail[], shipping: Detail[]) {
  // The qualification fixtures expect one state header and one detail per taxable component.
  const rated = region === 'NY';
  const regionName = rated ? 'New York' : 'California';
  const reason = rated ? 'standard_rated' : 'not_subject_to_tax';
  const rateType = rated ? 'percentage' : null;
  const taxType = rated ? 'sales_tax' : null;
  const percentage = rated ? lines[0]?.rate?.percentage : '0';
  if (percentage === undefined || (rated && percentage === '0')) throw new Error(integrityRefusal);
  const [whole, fraction = ''] = percentage.split('.');
  const rate = BigInt(whole + fraction.padEnd(6, '0'));
  const taxFor = (basis: number) => Number((BigInt(basis) * rate + 50_000_000n) / 100_000_000n);
  const lineTax = taxFor(1000), shippingTax = taxFor(rated ? 100 : 0);
  const totalTax = lineTax + shippingTax;
  const basis = rated ? 1100 : 1000;
  const headerRate = { country: 'US', region, taxType, rateType, percentage, flatAmount: null };
  const expectedHeaders = [{ taxMinor: totalTax, basisMinor: basis, reason, inclusive: false, rate: headerRate }];
  const detail = (basisMinor: number, taxMinor: number) => ({
    taxMinor, basisMinor, reason, jurisdiction: { country: 'US', region, level: 'state', name: regionName },
    sourcing: 'destination', rate: rated ? { taxType, percentage } : null,
  });
  if (payable !== basis + totalTax || !isDeepStrictEqual(headers, expectedHeaders) || !isDeepStrictEqual(lines, [detail(1000, lineTax)])
    || !isDeepStrictEqual(shipping, rated ? [detail(100, shippingTax)] : [])) {
    throw new Error(integrityRefusal);
  }
}
type TaxOptions = Parameters<typeof composeProviderTax>[1];
const reportingRef = reference('tax');
type RecoveryOperation = 'quote' | 'post' | 'reverse';
type EvidenceByRef = (operation: RecoveryOperation, reference: string) => Promise<string | undefined>;

export const recoveryPrompt = (operation: RecoveryOperation, reference: string) =>
  `Find the original tax ${operation} with reference ${reference} in the bound test dashboard. Enter its ${operation === 'quote' ? 'calculation' : 'transaction'} ID, or leave blank: `;

export async function qualifyTax(provider: VerifiedTestProvider, witness: Witness, observeOriginal: EvidenceByRef, signal: AbortSignal) {
  const ref = 'qualification-' + randomUUID();
  const now = () => new Date();
  const second = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  function verify(condition: boolean): asserts condition {
    if (condition !== true) throw new Error(integrityRefusal);
  }
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
    try { calculated = readCalculation(await provider.tax.calculations.create(params, { idempotencyKey: key })); }
    catch (error) {
      if (!(error instanceof ProviderUnavailable)) throw error;
      witness.note({ operation: 'quote', effect: 'unknown', key: witness.hash(key), reference: witness.hash(quoteRef) });
      const original = reference('taxcalc')(await observeOriginal('quote', quoteRef));
      verify(original !== undefined);
      calculated = readCalculation(await provider.tax.calculations.retrieve(original));
      verify(calculated.ref === original);
    }
    const { ref: calculationRef, payableMinor, headers, shipping: cost } = calculated;
    verify(calculationRef !== undefined && calculated.live === false && calculated.currency === 'usd' && payableMinor !== undefined);
    const list = readPage(await provider.tax.calculations.listLineItems(calculationRef, { limit: 100, expand: ['data.tax_breakdown'] }), readTaxLine);
    const item = list.rows?.[0];
    verify(list.more === false && list.path === '/v1/tax/calculations/' + calculationRef + '/line_items'
      && list.rows?.length === 1 && item?.live === false && item.ref === quoteRef && item.chargeMinor === 1000);
    const lines = item.breakdown;
    verify(headers !== undefined && lines !== undefined && cost !== undefined
      && (cost === null ? shipping === 0 : cost.chargeMinor === shipping && cost.breakdown !== undefined));
    const delivery = cost === null ? [] : cost.breakdown!;
    witness.note({ operation: 'tax_quote', region: fixture.state, calculation: witness.hash(calculationRef), currency: 'usd',
      payableMinor, shippingMinor: cost?.chargeMinor, shippingShape: cost === null ? 'absent' : delivery.length > 0 ? 'detail' : 'empty' });
    for (const row of headers) {
      witness.note({ operation: 'tax_breakdown', region: fixture.state, shape: 'header', taxability: row.reason,
        amountMinor: row.taxMinor, basisMinor: row.basisMinor, rateType: row.rate.rateType,
        fee: row.rate.taxType === 'retail_delivery_fee', hasRate: true });
    }
    for (const [shape, rows] of [['line', lines], ['shipping', delivery]] as const) {
      for (const row of rows) {
        witness.note({ operation: 'tax_breakdown', region: fixture.state, shape, taxability: row.reason,
          amountMinor: row.taxMinor, basisMinor: row.basisMinor, fee: row.rate?.taxType === 'retail_delivery_fee', hasRate: row.rate !== null });
      }
    }
    verifyQuoteRows(fixture.state, payableMinor, headers, lines, delivery);
  };
  const [ny, ca] = fixtures;
  await calc(ny);
  await calc(ca);
  signal.throwIfAborted();

  const jurisdictions = [{ jurisdiction: witness.hash('state-New York'), taxKind: 'sales', level: 'state', sourcing: 'destination' as const,
    provider: { country: 'US', state: 'NY', level: 'state', display_name: 'New York' }, taxType: 'sales_tax' }];
  const accountRef = field(provider.scope, 'accountRef', reference('acct'));
  const mode = field(provider.scope, 'mode', literal('test'));
  verify(accountRef !== undefined && mode === 'test');
  const taxDate = second(), scope = { adapter: 'stripeTax', adapterVersion: '1', accountRef, mode };
  const address = { countryCode: 'US', subdivisionCode: 'US-NY', line1: ny.line1, city: ny.city, postalCode: ny.postal_code };
  const delivery = { bucketKey: 'shipping', carrierRef: 'fixture', serviceRef: 'fixture', separatelyStated: true,
    taxClass: 'shipping', assignmentRef: 'shipping', cost: { ref: 'shipping', currency: 'USD', amountMinor: ny.shipping } };
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
      delivery: [{ bucketKey: 'shipping', deliveryKind: 'shipping', amountMinor: ny.shipping }], adjustments: [], fees: [] },
    required: jurisdictions.flatMap(({ jurisdiction, taxKind, level, sourcing }) => [
      { target: { kind: 'line', key: 'item' }, jurisdiction, taxKind, level, sourcing },
      { target: { kind: 'delivery', key: 'shipping' }, jurisdiction, taxKind, level, sourcing },
    ]),
    coverage: { schemaVersion: 1, accountRef: scope.accountRef, revision: 'test', declarations: jurisdictions.map(({ jurisdiction, taxKind }) =>
      ({ jurisdiction, taxKind, status: 'registered', actorRef: 'fixture', recordedAt: taxDate, effective: { from: taxDate } })) },
  };

  const effects: Partial<{ [Key in 'accepted' | 'commit' | 'reverse']: ReturnType<TaxOptions['effects'][Key]> }> = {};
  let observation: { reference?: string; transactionRef?: string } = {};
  const port = composeProviderTax(provider, { installationRef: ref, marketPack, now, effects: {
    accepted: () => effects.accepted, commit: () => effects.commit, reverse: () => effects.reverse,
    findTransactionIdByReference: reference => { observation.reference = reference; return observation.transactionRef; },
  } });
  const request = makeTaxQuoteRequest(ref, input);
  const result = await port.quote(request);
  if (result.kind === 'unavailable' || result.kind === 'refused') throw new TaxQualificationRefusal(result);
  if (result.kind !== 'final') throw new Error(taxRefusal);
  effects.accepted = { request, result, closed: false };
  const money = result.money;
  const payable = field(money, 'payableMinor', integer), taxes = field(money, 'taxTotal', integer);
  verify(field(money, 'feeTotal', integer) === 0 && payable !== undefined && taxes !== undefined);
  const { evidence, evidenceDigest } = result;
  const calculationRef = field(evidence, 'calculationRef', reference('taxcalc'));
  verify(calculationRef !== undefined);
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
  const commit: TaxCommitRequestV1 = { calculationRef: { scope, ref: calculationRef, evidenceDigest },
    transactionRef: ref, postedAt, capturedAt, captureEvidenceRef: ref, intent: 'apply' };
  const capture = { ref, capturedAt, currency: 'USD', payableMinor: payable };
  const expiry = field(evidence, 'expiresAt', text);
  verify(expiry !== undefined);
  const send = { kind: 'ready' as const, before: expiry };
  effects.commit = { capture, requestDigest: makeReportingDigest({ operation: 'commit', request: commit, capture }), send };

  async function post<R extends TaxCommitResultV1 | TaxReverseResultV1>(name: 'post' | 'reverse',
    run: (intent: 'apply' | 'recover') => Promise<R>, resultId: (value: R) => string | undefined) {
    signal.throwIfAborted();
    observation = {};
    const first = await run('apply');
    const firstId = resultId(first);
    if (firstId !== undefined) {
      const replay = await run('apply');
      if (replay.kind === 'unavailable' || replay.kind === 'refused') throw new TaxQualificationRefusal(replay);
      verify(resultId(replay) === firstId && JSON.stringify(replay) === JSON.stringify(first));
      return first;
    }
    const { reference } = observation;
    if (first.kind === 'unavailable' && field(first, 'effect', literal('unknown')) === 'unknown' && typeof reference === 'string' && reference.length > 0) {
      witness.note({ operation: name, effect: 'unknown', key: witness.hash(reference), reference: witness.hash(reference) });
      const original = await observeOriginal(name, reference);
      if (original !== undefined && reportingRef(original) !== undefined) {
        observation.transactionRef = original;
        const recovered = await run('recover');
        if (resultId(recovered) === original) return recovered;
      }
      throw new Error(integrityRefusal);
    }
    if (first.kind === 'refused' || first.kind === 'unavailable') throw new TaxQualificationRefusal(first);
    throw new Error(integrityRefusal);
  }
  const posted = await post('post', intent => port.commit({ ...commit, intent }),
    row => row.kind === 'committed' ? field(row, 'providerTransactionRef', reportingRef) : undefined);
  verify(posted.kind === 'committed');
  const saleRef = field(posted, 'providerTransactionRef', reportingRef);
  verify(saleRef !== undefined);
  const units: NonNullable<typeof effects.reverse>['original']['units'][number][] = [];
  for (const component of result.money.components) {
    const merchandise = component.ref.kind === 'merchandise';
    const lineRef = merchandise ? field(evidence.providerLines?.[0], 'providerLineRef', text) : 'shipping:' + calculationRef;
    const position = posted.positions.find(row => field(row, 'originalPositionRef', text) === lineRef);
    const postedRef = field(position, 'postedPositionRef', text);
    const netMinor = field(component.final, 'amountMinor', integer), taxMinor = field(component.final, 'taxMinor', integer);
    verify(lineRef !== undefined && postedRef !== undefined && netMinor !== undefined && taxMinor !== undefined);
    units.push({ kind: merchandise ? 'line' : 'shipping', originalPositionRef: lineRef, postedPositionRef: postedRef,
      taxCode: merchandise ? 'txcd_99999999' : 'txcd_92010001', remainingNetMinor: netMinor, remainingTaxMinor: taxMinor });
  }
  const reverse: TaxReverseRequestV1 = { scope, originalRef: saleRef, reversalRef: ref,
    refundEvidenceRef: ref, currency: 'USD', fromMinor: 0, toMinor: payable, intent: 'apply', mode: 'full',
    positions: units.map(unit => ({ originalPositionRef: unit.originalPositionRef,
      netDeltaMinor: unit.remainingNetMinor === 0 ? 0 : -unit.remainingNetMinor,
      taxDeltaMinor: unit.remainingTaxMinor === 0 ? 0 : -unit.remainingTaxMinor, feeDeltaMinor: 0 })) };
  const original = { id: saleRef, scope, currency: 'USD', taxDate, payableMinor: payable, refundedMinor: 0, units };
  effects.reverse = { original, refundEvidenceRef: ref, send, requestDigest: makeReportingDigest({ operation: 'reverse', request: reverse, refundEvidenceRef: ref, original }) };
  const reversed = await post('reverse', intent => port.reverse({ ...reverse, intent }),
    row => row.kind === 'reversed' ? field(row, 'providerReversalRef', reportingRef) : undefined);
  verify(reversed.kind === 'reversed');
  const reversalRef = field(reversed, 'providerReversalRef', reportingRef);
  verify(reversalRef !== undefined);
  witness.note({ operation: 'tax_reporting', verdict: 'pass', currency: 'USD', payableMinor: payable,
    taxMinor: taxes, sale: witness.hash(saleRef), reversal: witness.hash(reversalRef) });
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
  if (typeof secretKey !== 'string' || secretKey.length === 0) throw new Error(credentialRefusal);
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
    version = field(provider, 'apiVersion', text);
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
