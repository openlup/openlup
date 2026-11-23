import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { argv, env, execPath, stdin, stdout, stderr } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  accountId, CardRejection, credentialRefusal, integrityRefusal, openTestProvider, sdkVersion,
  type VerifiedTestProvider,
} from './provider-transport.ts';
import { declineCode, field, readCharge, readCustomer, readIntent, readPage, text } from './provider-response.ts';

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

function qualificationMessage(error: unknown): string {
  if (error instanceof Error && [credentialRefusal, integrityRefusal, cardRefusal].includes(error.message)) return error.message;
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
    result = 'pass';
  } catch (error) {
    output(qualificationMessage(error) + '\n');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    output('Tax qualification runs in a separate step after the card qualification.\n');
    await persist(filename, JSON.stringify({ startedAt, endedAt: new Date().toISOString(), result, release, account: witness.hash(accountRef),
      tax: 'not_run',
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
