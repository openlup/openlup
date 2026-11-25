import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module';
import { env } from 'node:process';
import { join } from 'node:path';
import readline from 'node:readline/promises';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catalogInternalGtin, type CatalogProductInput } from '@openlup/platform/catalog';
import { canonicalCatalogDraftJson } from '@openlup/platform/catalog/contracts';
import { CATALOG_PRICE_SETUP_HARD_REFUSALS, deriveSubscriptionUnitPrice } from '@openlup/platform/pricing';
import { selectConfiguration } from '../owned/store.config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const workerFlag = 'OPENLUP_CATALOGUE_APPLY_TEST_CHILD';
// Nested extraction checks reuse the checkout's dependencies. The packed consumer installs its own and runs these CLI witnesses.
const extractionSharesDependencies = existsSync(join(root, '.starter-origin.json'))
  && !existsSync(join(root, 'node_modules/@openlup/platform/package.json'));
const nestedSkip = extractionSharesDependencies && 'The packed starter suite runs the CLI witness.';
const currency = selectConfiguration().market.currency;
const actorId = '11111111-1111-4111-8111-111111111111';
const alternate = '44444444-4444-4444-8444-444444444444';
const priceListId = '22222222-2222-4222-8222-222222222222';
const policy = { revisionId: '33333333-3333-4333-8333-333333333333', discountBps: 500,
  roundingQuantumMinor: 10, roundingRule: 'FLOOR_TO_QUANTUM' } as const;
const nextPolicy = { ...policy, revisionId: '55555555-5555-4555-8555-555555555555', discountBps: 1000 };
const coarsePolicy = { ...nextPolicy, discountBps: 0, roundingQuantumMinor: 3000 };
const hash = (value: unknown) => createHash('sha256').update(canonicalCatalogDraftJson(value)).digest('hex');
const digest = 'a'.repeat(64);
const grams = (unscaled: string) => ({ dimension: 'mass', unit: 'openlup:g', unscaled, scale: 0 } as const);
const sku = (code: string, sequence: number) => ({ code, title: code, options: {}, netContent: grams('100'),
  grossMass: grams('120'), identifiers: [{ scheme: 'gs1:gtin', issuer: 'starter:internal',
    value: catalogInternalGtin(sequence), packagingLevel: 'unit' as const }],
  sell: { oneTime: true, subscription: false }, logisticsRef: 'starter:fulfilment/notebook' });
const authored = {
  draftId: 'd9176a9d-274b-4a4a-90d8-2a0db738f181',
  product: { namespace: 'starter', type: { key: 'starter:item', version: 2 }, slug: 'proof-notebook',
    name: 'Field notebook', presentation: { title: 'Field notebook' },
    skus: [{ ...sku('FIRST', 204), primary: true }, sku('SECOND', 205)] } satisfies CatalogProductInput,
  basePrices: { FIRST: 1900, SECOND: 2700 },
  copyPresentation: { title: 'Second edition' },
};

type Finding = { code: string; fix: string; recheck: string; observed: string; cause: string;
  path: string; reason?: string; subject?: string; issues?: unknown[] };
type Head = { publicationId: string; revision: number; documentDigest: string };
type Draft = { draftId: string; productId: string; revision: number; actorId: string; commandKey: string;
  payload: { product: { id: string; type: { version: number }; documentRevision: { digest: string } };
    skus: { id: string; code: string }[] } };
type Publication = { productId: string; actorId: string; head: Head; previousHead: Head | null; commandKey: string };
type Price = { entryId: string; unitPriceMinor: number };
type PriceReceipt = { actorId: string; key: string; body: unknown; previous: Price | null; current: Price };
type State = { drafts: Record<number, Draft>; decisions: Record<string, object>;
  publications: Record<string, Publication>; prices: Record<string, { key: string; current: Price }>;
  priceReceipts: Record<string, PriceReceipt>;
  head: Head | null };
type PriceCommand = { variantId: string; unitPriceMinor: number; expected?: { entryId: string | null; unitPriceMinor: number | null } };
function writeBase(state: State, actor: string, key: string, skuCode: string, body: PriceCommand) {
  const { variantId, unitPriceMinor, expected } = body;
  const previous = state.prices[variantId]?.current ?? null;
  const saved = state.priceReceipts[key];
  if (saved) {
    if (saved.actorId !== actor) return { code: 'operator_mismatch' };
    assert.deepEqual(saved.body, body);
    return { outcome: 'replayed', receipt: saved };
  }
  if ((expected?.entryId ?? null) !== (previous?.entryId ?? null)
    || (expected?.unitPriceMinor ?? null) !== (previous?.unitPriceMinor ?? null))
    return { code: 'expected_state_mismatch' };
  const current = { entryId: 'entry-' + skuCode + '-' + Object.keys(state.priceReceipts).length, unitPriceMinor };
  const receipt = { actorId: actor, key, body, previous, current };
  state.priceReceipts[key] = receipt;
  state.prices[variantId] = { key, current };
  return { outcome: 'committed', receipt };
}
type Options = { declaration?: unknown; args?: string[]; noTerminal?: boolean; mediaIoError?: boolean;
  missingProduct?: boolean; wrongTarget?: boolean; closeAt?: 'email' | 'token'; declineAt?: number;
  failAt?: number; refusal?: Partial<Finding>; failRetry?: boolean; state?: State; actor?: string; approveAfter?: Options;
  pending?: string[]; pendingAfterReview?: string; pendingOnAmount?: string; refreshBeforeApply?: boolean;
  ambiguous?: string[]; ineligible?: string[]; stale?: string; rolledPolicy?: boolean; loseRepriceReply?: boolean;
  stopSecond?: 'policy' | 'expired' | 'zero-old' | 'derived-zero' | 'list';
  refresh?: 'same' | 'actor' | 'list'; readback?: 'list' | 'missing' | 'entry' | 'amount' | 'figure' | 'policy' | 'pending' };
type Observation = { trace: string[]; state: State; retry: { key: string; body: unknown }[];
  prompts: string[]; changes: { actor: string; key: string; code: string; expected: Price }[] };
type PriceItem = Price & { skuId: string; currency: string; policyRevisionId?: string; subscriptionUnitPriceMinor?: number; previous?: Price };
type Output = Observation & { report: { findings: Finding[]; receipts: { stage: string; outcome: string; prices: PriceItem[] }[] };
  status: number; stderr: string };

if (env[workerFlag] === '1') {
  const options: Options = JSON.parse(await text(process.stdin));
  const state: State = options.state ?? { drafts: {}, decisions: {}, publications: {}, prices: {}, priceReceipts: {}, head: null };
  const trace: string[] = [], retry: Observation['retry'] = [];
  const prompts: string[] = [], changes: Observation['changes'] = [];
  const actor = options.actor ?? actorId;
  const pending = new Set(options.pending);
  let refreshed = false, signIns = 0, now = Date.now();
  let effectivePolicy = options.rolledPolicy ? coarsePolicy : policy;
  let readbackSku: string | undefined;
  if (options.refresh || options.stopSecond === 'expired') Date.now = () => now;
  const fixture = new URL('../lifecycle.mjs', import.meta.url).href;
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === './owned/catalogue.ts' && context.parentURL === fixture) {
      const source = options.missingProduct ? 'export {}' : 'export const catalogueProduct = ' + JSON.stringify(options.declaration ?? authored);
      return { url: 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'), shortCircuit: true };
    }
    return next(specifier, context);
  } });
  if (options.mediaIoError) fs.open = async () => { throw Object.assign(new Error('fixture I/O'), { code: 'EACCES' }); };
  Object.defineProperty(process.stdin, 'isTTY', { value: !options.noTerminal });
  Object.defineProperty(process.stderr, 'isTTY', { value: !options.noTerminal });
  let approvals = 0;
  Object.assign(readline, { createInterface: () => ({
    on() {}, close() {},
    async question(prompt: string) {
      const step = prompt.startsWith('Invited') ? 'email' : prompt === '' ? 'token' : 'approval';
      trace.push(step);
      if (options.closeAt === step) throw new Error('terminal closed');
      if (step === 'approval') {
        prompts.push(prompt);
        if (options.approveAfter) {
          const competing = invoke({ ...options.approveAfter, state });
          assert.equal(competing.status, 0, JSON.stringify(competing.report.findings));
          Object.assign(state, competing.state);
        }
        if (options.pendingAfterReview) pending.add(options.pendingAfterReview);
        if (options.refreshBeforeApply) now += 1000;
        return ++approvals === options.declineAt ? 'decline' : 'approve';
      }
      return step === 'email' ? 'operator@example.test' : 'fixture-token';
    },
  }) });
  syncBuiltinESMExports();
  process.on('exit', () => process.stderr.write('\nfixture: ' + JSON.stringify({ trace, state, retry, prompts, changes }) + '\n'));
  const response = (value: unknown, headers?: Record<string, string>) => Response.json({ ok: true, value }, headers && { headers });
  const refused = (details: Partial<Finding>) => Response.json({ ok: false, ...details }, { status: 409 });
  let lookups = 0, candidateRevision = 0;
  globalThis.fetch = async (url, init) => {
    const operation = new URL(String(url)).pathname.split('/').at(-1);
    const { action, ...fields } = JSON.parse(String(init?.body));
    const key = new Headers(init?.headers).get('Idempotency-Key')!;
    const revision = action === 'create' || action === 'revise' ? fields.expectedRevision + 1 : fields.expectedRevision;
    const skuCode = Object.values(state.drafts).flatMap(draft => draft.payload.skus).find(row => row.id === fields.variantId)?.code;
    const step = operation === 'catalogue.demoTarget' ? 'marker' : operation === 'auth.operator'
      ? fields.email ? 'challenge' : 'redeem'
      : action === 'receipt' ? 'lookup:' + ++lookups
      : action === 'create' || action === 'revise' ? 'save:' + revision
      : action === 'prepare' ? 'prepare:' + revision
      : action === 'approve' || action === 'publish' ? action + ':' + candidateRevision
      : action === 'exact' ? 'exact:' + fields.head.revision
      : skuCode ? action + ':' + skuCode + (action === 'price-preview' && fields.unitPriceMinor !== undefined ? ':amount' : '') : action;
    trace.push(step);
    if (options.refusal?.code === 'publication_price_readiness' && action === 'publish') {
      retry.push({ key, body: { action, ...fields } });
      if (options.failRetry && trace.length === (options.failAt ?? 0) + 1) return refused(options.refusal);
    }
    if (trace.length === options.failAt) {
      if (!options.refusal) throw new Error('fixture transport unavailable');
      return refused(options.refusal);
    }
    if (step === 'marker') {
      assert.deepEqual(fields, {});
      assert.equal(new Headers(init?.headers).has('cookie'), false);
      return response({ marked: !options.wrongTarget, configurationId: selectConfiguration().id });
    }
    if (step === 'challenge') return response({ accepted: true });
    if (step === 'redeem') {
      refreshed = ++signIns > 1;
      const expiresAt = options.refresh || options.stopSecond === 'expired'
        ? new Date(now + 1000).toISOString() : '2099-01-01T00:00:00Z';
      return response({ expiresAt }, { 'Set-Cookie': 'starter_session=' + 'x'.repeat(43) });
    }
    assert.equal(new Headers(init?.headers).get('cookie'), 'starter_session=' + 'x'.repeat(43));
    switch (action) {
      case 'price-target': return response({
        actorId: refreshed && options.refresh === 'actor' ? alternate : actor,
        priceListId: refreshed && options.refresh === 'list' ? alternate : priceListId, currency, policy: effectivePolicy,
      });
      case 'receipt': {
        const receipt = state.publications[fields.commandKey];
        return response(receipt ? { outcome: 'found', receipt } : { outcome: 'missing' });
      }
      case 'current': return response({ head: state.head });
      case 'exact': {
        const publication = Object.values(state.publications).find(item => item.head.revision === fields.head.revision)!;
        return response({ product: { id: publication.productId }, head: publication.head });
      }
      case 'get': return response({ record: state.drafts[fields.revision] });
      case 'create':
      case 'revise': {
        const record: Draft = { draftId: fields.draftId, productId: fields.payload.product.id, revision,
          actorId: actor, commandKey: key, payload: fields.payload };
        const saved = state.drafts[revision];
        if (saved) assert.deepEqual(record, saved);
        else state.drafts[revision] = record;
        return response({ outcome: saved ? 'replayed' : 'committed', record });
      }
      case 'prepare':
        candidateRevision = revision;
        assert.deepEqual(fields.expectedHead, state.head);
        return response({ expectedHead: state.head, candidateRef: 'candidate-' + revision, candidateDigest: digest,
          preparation: { postStateDigest: digest }, impact: { productId: state.drafts[revision]!.productId } });
      case 'approve': {
        const receipt = { actorId: actor, commandKey: key, ...fields };
        const saved = state.decisions[key];
        if (saved) assert.deepEqual(receipt, saved);
        else state.decisions[key] = receipt;
        return response({ outcome: saved ? 'replayed' : 'committed', receipt });
      }
      case 'publish': {
        assert.deepEqual(fields.expectedHead, state.head);
        assert.equal(fields.candidateRef, 'candidate-' + candidateRevision);
        const record = state.drafts[candidateRevision]!;
        const head = { publicationId: 'publication-' + candidateRevision, revision: candidateRevision,
          documentDigest: record.payload.product.documentRevision.digest };
        const receipt = { actorId: actor, commandKey: key, productId: record.productId, previousHead: state.head, head };
        state.publications[key] = receipt;
        state.head = head;
        return response({ outcome: 'committed', receipt });
      }
      case 'price-preview': {
        assert.ok(skuCode);
        assert.equal(fields.priceListId, priceListId);
        const ambiguous = options.ambiguous?.includes(skuCode);
        if (fields.unitPriceMinor !== undefined) {
          if (ambiguous) return refused({ code: 'base_price_ambiguous' });
          if (pending.has(skuCode)) return refused({ code: 'expected_state_mismatch' });
        }
        const readback = readbackSku === skuCode ? options.readback : undefined;
        if (readback === 'policy') return refused({ code: 'starter_catalogue_d2c_policy_required',
          reason: 'policy_changed', issues: [{ code: 'policy_changed' }] });
        let current = ambiguous ? null : state.prices[fields.variantId]?.current ?? null;
        if (current && readback === 'entry') current = { ...current, entryId: 'other-entry' };
        if (current && readback === 'amount') current = { ...current, unitPriceMinor: current.unitPriceMinor + 10 };
        if (readback === 'missing') current = null;
        const derivedUnitPriceMinor = current && readback !== 'figure'
          ? deriveSubscriptionUnitPrice(current.unitPriceMinor, effectivePolicy) : null;
        return response({ listEffective: readback !== 'list', currency, priceSetup: {
          inGate: (state.head?.revision ?? 0) >= 2 && !options.ineligible?.includes(skuCode),
          current, currentCount: ambiguous ? 2 : Number(!!current),
          hasPending: pending.has(skuCode) || readback === 'pending' ||
            (fields.unitPriceMinor !== undefined && options.pendingOnAmount === skuCode),
          subscription: { ...effectivePolicy, kind: 'derived', derivedUnitPriceMinor },
          ...(fields.unitPriceMinor !== undefined && { proposed: { unitPriceMinor: fields.unitPriceMinor } }),
        } });
      }
      case 'price-apply': {
        assert.ok(skuCode);
        assert.equal(state.head?.revision === 1 || !!options.state, true);
        const expected = fields.expected;
        if (expected) {
          assert.equal(key, hash(['reprice', actor, priceListId, fields.variantId, fields.unitPriceMinor, expected]));
          changes.push({ actor, key, code: skuCode, expected });
        }
        if (expected && skuCode === 'SECOND' && options.stopSecond) {
          if (options.stopSecond === 'list') return refused({ code: 'price_list_not_active' });
          if (options.stopSecond === 'derived-zero') return refused({ code: 'starter_catalogue_derived_price_zero' });
          if (options.stopSecond === 'expired') now += 1000;
          effectivePolicy = options.stopSecond === 'zero-old' ? coarsePolicy : nextPolicy;
        }
        if (fields.policyRevisionId !== effectivePolicy.revisionId)
          return refused({ code: 'starter_catalogue_d2c_policy_required' });
        if ((options.stale === skuCode || pending.has(skuCode)) && !state.priceReceipts[key])
          return refused({ code: 'expected_state_mismatch' });
        const result = writeBase(state, actor, key, skuCode, fields);
        if (result.code) return refused({ code: result.code });
        if (expected) {
          readbackSku = skuCode;
          if (options.refresh) now += 1000;
          if (options.loseRepriceReply) throw new Error('fixture lost price reply after commit');
        }
        return response({ currency, ...result });
      }
      default: assert.fail('unexpected fixture request: ' + step);
    }
  };
}

function invoke(options: Options = {}): Output {
  const result = spawnSync(process.execPath,
    ['--import', fileURLToPath(import.meta.url), 'lifecycle.mjs', 'catalogue', 'apply', '--json', ...options.args ?? []],
    { cwd: root, env: { ...env, [workerFlag]: '1' }, input: JSON.stringify(options), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.ok(result.stderr.includes('\nfixture: '), result.stderr);
  const observation: Observation = JSON.parse(result.stderr.split('\nfixture: ').at(-1)!);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, report.exitCode);
  assert.ok(!result.stderr.includes('fixture-token'));
  return { ...observation, report, status: result.status!, stderr: result.stderr };
}

function finding(result: Output, code: string, remedy: RegExp): Finding {
  assert.equal(result.status, 2, JSON.stringify(result.report));
  assert.equal(result.report.findings.length, 1);
  const row = result.report.findings[0]!;
  assert.equal(row.code, code);
  assert.match(row.fix, remedy);
  for (const field of ['observed', 'cause', 'recheck'] as const) assert.ok(row[field].length > 0, field);
  return row;
}

function complete(result: Output) {
  assert.equal(result.status, 0, JSON.stringify(result.report.findings));
  assert.equal(result.state.head?.revision, 2);
}

const ordered = ['marker', 'email', 'challenge', 'token', 'redeem', 'price-target', 'lookup:1', 'current',
  'save:1', 'prepare:1', 'approval', 'approve:1', 'publish:1', 'exact:1', 'lookup:2', 'current',
  'price-preview:FIRST', 'price-preview:SECOND', 'price-apply:FIRST', 'price-preview:FIRST',
  'price-apply:SECOND', 'price-preview:SECOND', 'save:2', 'prepare:2', 'approval', 'approve:2', 'publish:2', 'exact:2'];
const repriceArgs = ['--reprice'];
const recovery = /verify committed prices read-only, then rerun with --reprice to review any remaining change/u;
const replacement = { ...authored, basePrices: { ...authored.basePrices, FIRST: 2200 } };
const observed = [...ordered.slice(0, 7), 'exact:1', 'lookup:2', 'exact:2', 'price-preview:FIRST', 'price-preview:SECOND'];
const committed = (out: Output) => out.report.receipts.filter(row => row.stage === 'price.reprice');
const writes = (out: Output) => out.trace.filter(step => /^(?:save|prepare|approve|publish|price-apply):/u.test(step));
const price = (state: State, index = 0) => state.prices[state.drafts[1]!.payload.skus[index]!.id]!.current;
const noWrites = (out: Output, state: State) => {
  assert.deepEqual(writes(out), []);
  assert.deepEqual(out.state, state);
};
function unverified(out: Output) {
  const row = finding(out, 'starter_catalogue_reprice_readback_unverified', recovery);
  assert.equal(row.observed, 'committed; figure not verified');
  assert.equal(row.subject, 'FIRST');
  assert.equal(row.path, 'basePrices');
  assert.equal(committed(out).length, 1);
  const item = committed(out)[0]!.prices[0]!;
  assert.deepEqual({ entryId: item.entryId, unitPriceMinor: item.unitPriceMinor }, price(out.state));
  assert.equal(item.policyRevisionId, undefined);
  assert.equal(item.subscriptionUnitPriceMinor, undefined);
  return row;
}

if (!env[workerFlag]) {
  test('catalogue apply validates authored input and resumes after each local refusal', { skip: nestedSkip }, async context => {
    const media = (mediaRef: string) => ({ ...authored, product: { ...authored.product, presentation: { title: 'Notebook', mediaRef } } });
    const cases: [Options, string, RegExp, string[]][] = [
      [{ missingProduct: true }, 'OPENLUP_E_CATALOGUE_PRODUCT_REQUIRED', /Add the documented product/u, []],
      [{ declaration: { ...authored, basePrices: { FIRST: 1900 } } }, 'OPENLUP_E_CATALOGUE_BASE_PRICES_MISMATCH', /Match the price keys/u, []],
      ...[0, 1.5, 2_147_483_648].map((FIRST): [Options, string, RegExp, string[]] => [
        { declaration: { ...authored, basePrices: { ...authored.basePrices, FIRST } } },
        'starter_catalogue_price_invalid', /whole minor-unit amount from 1 to 2147483647/u, [],
      ]),
      [{ declaration: { ...authored, basePrices: { ...authored.basePrices, FIRST: 1 } } },
        'starter_catalogue_derived_price_zero', /Choose a base that derives a positive/u, ordered.slice(0, 7)],
      [{ args: ['--reprice', '--copy'] }, 'starter_argument_unknown', /documented options/u, []],
      [{ args: ['--reprice', '--prepare-only'] }, 'starter_argument_unknown', /documented options/u, []],
      [{ declaration: { ...authored, product: { ...authored.product, document: { content: 'é'.repeat(34_000) } } } },
        'starter_catalogue_save_too_large', /Shorten optional content/u, []],
      [{ declaration: { ...authored, product: { ...authored.product, presentation: { title: ' ' } } } },
        'starter_catalogue_presentation_invalid', /Supply a title/u, []],
      [{ declaration: media('/media/missing-proof.svg') }, 'starter_catalogue_media_invalid', /match the filename case/u, []],
      [{ declaration: media('/media/light.svg'), mediaIoError: true },
        'catalog_publication_media_validation_unavailable', /Check the starter.s local media directory/u, []],
      [{ noTerminal: true }, 'OPENLUP_E_CATALOGUE_TERMINAL_REQUIRED', /type approve only if you intend it/u, []],
      [{ closeAt: 'email' }, 'starter_catalogue_sign_in_incomplete', /complete operator sign-in/u, ordered.slice(0, 2)],
      [{ closeAt: 'token' }, 'starter_catalogue_sign_in_incomplete', /complete operator sign-in/u, ordered.slice(0, 4)],
      [{ declineAt: 1 }, 'OPENLUP_E_CATALOGUE_CONFIRMATION_INVALID', /type approve only if you intend it/u, ordered.slice(0, 11)],
      [{ wrongTarget: true }, 'starter_seed_demonstration_database_required', /Select the intended marked demo/u, ['marker']],
    ];
    for (const [options, code, remedy, steps] of cases) await context.test(code, () => {
      const refused = invoke(options);
      finding(refused, code, remedy);
      assert.deepEqual(refused.trace, steps);
      assert.deepEqual(Object.keys(refused.state.publications), []);
      const corrected = options.mediaIoError ? { declaration: media('/media/light.svg') } : {};
      complete(invoke({ ...corrected, state: refused.state }));
    });
  });

  test('catalogue apply orders previews before initial prices, issues two revisions and then verifies', { skip: nestedSkip }, () => {
    const first = invoke();
    complete(first);
    assert.deepEqual(first.trace, ordered);
    assert.deepEqual(Object.keys(first.state.drafts), ['1', '2']);
    assert.equal(Object.keys(first.state.decisions).length, 2);
    assert.equal(Object.keys(first.state.publications).length, 2);
    assert.equal(Object.keys(first.state.prices).length, 2);
    const verified = invoke({ state: first.state });
    complete(verified);
    noWrites(verified, first.state);
    assert.deepEqual(verified.trace, observed);
    assert.deepEqual(verified.report.receipts.map(row => row.stage), ['release.publish', 'activation.publish', 'price.apply', 'price.apply']);
    assert.ok(verified.report.receipts.every(row => row.outcome === 'observed'));
    assert.deepEqual(verified.report.receipts.slice(2).map(row => row.prices[0]?.subscriptionUnitPriceMinor), [1800, 2560]);
  });

  test('catalogue apply stops and resumes at each refused host stage', { skip: nestedSkip }, async context => {
    const owners: [string, string, RegExp, 'last'?][] = [
      ['challenge', 'operator_required', /active human store administrator/u],
      ['redeem', 'starter_auth_invalid', /Request a fresh challenge/u],
      ['price-target', 'starter_catalogue_currency_mismatch', /use the same currency/u],
      ['price-target', 'catalog_price_setup_basis_mismatch', /effective gross list/u],
      ['lookup:1', 'publisher_not_authorized', /original issuing administrator/u],
      ['current', 'head_conflict', /Reload the current draft and head/u],
      ['current', 'head_conflict', /Reload the current draft and head/u, 'last'],
      ['save:1', 'publication_draft_advanced', /Reload the current draft and head/u],
      ['prepare:1', 'publication_post_state_changed', /Reload the current draft and head/u],
      ['approve:1', 'publication_command_key_reused', /Retry the unchanged original request/u],
      ['publish:1', 'publication_approval_missing', /Reload the current draft and head/u],
      ['exact:1', 'catalog_publication_receipt_invalid', /Reload the current draft and head/u],
      ['lookup:2', 'operator_required', /active human store administrator/u],
      ['price-preview:FIRST', 'price_list_not_active', /Restore the effective list/u],
      ['price-preview:SECOND', 'sku_archived', /Select an eligible SKU/u],
      ['price-preview:FIRST', 'expected_state_mismatch', /restore the declared amount to it and resume/u, 'last'],
      ['price-preview:SECOND', 'expected_state_mismatch', /restore the declared amount to it and resume/u, 'last'],
      ['price-apply:FIRST', 'readiness_would_fail', /Review the typed readiness findings/u],
      ['price-apply:FIRST', 'starter_catalogue_d2c_policy_required', /Restore one valid effective D2C policy/u],
      ['price-apply:SECOND', 'operator_mismatch', /original issuing administrator/u],
      ['price-apply:SECOND', 'command_key_reused', /Retry the unchanged original request/u],
      ['save:2', 'publication_draft_advanced', /Reload the current draft and head/u],
      ['prepare:2', 'publication_post_state_changed', /Reload the current draft and head/u],
      ['approve:2', 'publication_approval_missing', /Reload the current draft and head/u],
      ['publish:2', 'publication_sku_price_not_ready', /Set the missing positive gross base/u],
      ['publish:2', 'publication_price_readiness', /Use the native readiness remedy/u],
      ['exact:2', 'catalog_publication_receipt_invalid', /Reload the current draft and head/u],
    ];
    await context.test('transport unavailable before marker', () => {
      const denied = invoke({ failAt: 1 });
      finding(denied, 'OPENLUP_E_CATALOGUE_APPLY_UNAVAILABLE', /Check the running demo/u);
      assert.deepEqual(denied.trace, ['marker']);
      complete(invoke({ state: denied.state }));
    });
    owners.push(['price-apply:SECOND', 'expected_state_mismatch', /restore the declared amount to it and resume/u]);
    owners.push(['price-apply:FIRST', 'starter_catalogue_derived_price_zero', /Choose a base that derives a positive/u]);
    for (const [stage, code, remedy, occurrence] of owners) await context.test(stage + ' ' + code + (occurrence ? ' readback' : ''), () => {
      const failAt = (occurrence ? ordered.lastIndexOf(stage) : ordered.indexOf(stage)) + 1;
      assert.ok(failAt > 0);
      const issues = [{ code: 'fixture_owner_issue', path: 'basePrices' }];
      const refused = invoke({ failAt, refusal: { code, issues } });
      const row = finding(refused, code, remedy);
      assert.deepEqual(refused.trace, ordered.slice(0, failAt));
      assert.deepEqual(row.issues, issues);
      if (stage.startsWith('price-apply:')) {
        assert.equal(row.subject, stage.split(':')[1]);
        assert.equal(row.reason, code);
        assert.equal(row.path, 'basePrices');
      }
      complete(invoke({ state: refused.state }));
    });
    await context.test('Activation approval declined', () => {
      const refused = invoke({ declineAt: 2 });
      finding(refused, 'OPENLUP_E_CATALOGUE_CONFIRMATION_INVALID', /type approve only if you intend it/u);
      assert.deepEqual(refused.trace, ordered.slice(0, ordered.lastIndexOf('approval') + 1));
      assert.equal(refused.state.head?.revision, 1);
      complete(invoke({ state: refused.state }));
    });
  });

  test('catalogue apply retries the identical startup Publish once and retains the final native finding', { skip: nestedSkip }, () => {
    const failAt = ordered.indexOf('publish:2') + 1;
    const message = 'Observed: Job unready Cause: Startup Fix: Check the promotion job Recheck: Retry the original request';
    const refusal = { code: 'publication_price_readiness', reason: 'promotion_watchdog_not_ready', path: 'pricing.readiness',
      subject: 'promotion_watchdog_not_ready', issues: [{ code: 'publication_price_readiness' }], message };
    const refused = invoke({ failAt, refusal, failRetry: true });
    const row = finding(refused, refusal.code, /Check the promotion job/u);
    assert.equal(row.path, refusal.path);
    assert.equal(row.reason, refusal.reason);
    assert.equal(row.subject, refusal.subject);
    assert.deepEqual(row.issues, refusal.issues);
    assert.equal(row.recheck, 'Retry the original request');
    assert.deepEqual(refused.trace, [...ordered.slice(0, failAt), 'publish:2']);
    assert.deepEqual(refused.retry.at(-1), refused.retry.at(-2));
    complete(invoke({ state: refused.state }));
    complete(invoke({ failAt, refusal }));
  });

  test('catalogue copy requires Release and Activation, then refuses unchanged presentation with a recoverable remedy', { skip: nestedSkip }, () => {
    const args = ['--copy'];
    const beforeRelease = invoke({ args });
    finding(beforeRelease, 'starter_catalogue_copy_requires_published', /npm run catalogue:apply without --copy or --reprice/u);
    assert.deepEqual(beforeRelease.trace, ordered.slice(0, 7));
    const first = invoke({ failAt: ordered.indexOf('lookup:2') + 1 });
    assert.equal(first.state.head?.revision, 1);
    const beforeActivation = invoke({ args, state: first.state });
    finding(beforeActivation, 'starter_catalogue_copy_requires_published', /npm run catalogue:apply without --copy or --reprice/u);
    assert.deepEqual(beforeActivation.trace, [...ordered.slice(0, 7), 'exact:1', 'lookup:2']);
    const active = invoke({ state: beforeActivation.state });
    complete(active);
    const unchanged = invoke({ args, state: active.state,
      declaration: { ...authored, copyPresentation: authored.product.presentation } });
    finding(unchanged, 'starter_catalogue_copy_unchanged', /Edit the intended presentation in copyPresentation/u);
    assert.deepEqual(unchanged.trace.slice(-3), ['lookup:2', 'exact:2', 'get']);
    assert.deepEqual(unchanged.state, active.state);
    const copied = invoke({ args, state: unchanged.state });
    assert.equal(copied.status, 0, JSON.stringify(copied.report.findings));
    assert.equal(copied.state.head?.revision, 3);
  });

  test('reprice reviews the live base and estimate before approval and verifies each committed price', { skip: nestedSkip }, () => {
    for (const subscription of [false, true]) {
      const first = authored.product.skus[0]!;
      const product = { ...authored.product, skus: [{ ...first, sell: { oneTime: !subscription, subscription } }, authored.product.skus[1]!] };
      const initial = invoke({ declaration: { ...authored, product } });
      complete(initial);
      const options = { args: repriceArgs, declaration: { ...replacement, product }, state: initial.state };
      const declined = invoke({ ...options, declineAt: 1 });
      finding(declined, 'OPENLUP_E_CATALOGUE_CONFIRMATION_INVALID', /type approve only if you intend it/u);
      noWrites(declined, initial.state);
      const changed = invoke(options);
      complete(changed);
      assert.deepEqual(changed.trace.slice(-5), ['price-preview:FIRST:amount', 'price-preview:SECOND', 'approval',
        'price-apply:FIRST', 'price-preview:FIRST']);
      const [title, proposal, scope, prompt] = changed.prompts[0]!.split('\n');
      assert.equal(title, 'Change live base prices.');
      assert.equal(scope, 'Subscription figures are estimates under the policy effective now. Approval covers the base amounts only.');
      assert.equal(prompt, 'Type approve: ');
      const skuId = initial.state.drafts[1]!.payload.skus[0]!.id;
      const previous = price(initial.state);
      assert.deepEqual(JSON.parse(proposal!).changes, [{ code: 'FIRST', skuId, from: previous, to: { unitPriceMinor: 2200 },
        subscriptionEstimate: { from: 1800, to: 2090 } }]);
      assert.equal(Object.keys(changed.state.priceReceipts).length, Object.keys(initial.state.priceReceipts).length + 1);
      assert.deepEqual(committed(changed)[0], { stage: 'price.reprice', outcome: 'committed',
        productId: initial.state.drafts[1]!.productId, draftId: authored.draftId, draftRevision: 2, head: initial.state.head, currency,
        prices: [{ ...price(changed.state), skuId, currency, previous, policyRevisionId: policy.revisionId, subscriptionUnitPriceMinor: 2090 }] });
      const rerun = invoke({ ...options, state: changed.state });
      complete(rerun);
      noWrites(rerun, changed.state);
      assert.deepEqual(rerun.trace, observed);
      assert.deepEqual(rerun.prompts, []);
      assert.match(rerun.stderr, /No price changes\./u);
    }
  });

  test('another administrator can reprice and verify after a presentation successor', { skip: nestedSkip }, () => {
    const initial = invoke();
    complete(initial);
    const changed = invoke({ args: repriceArgs, actor: alternate, state: initial.state, declaration: replacement });
    complete(changed);
    assert.equal(changed.state.priceReceipts[changed.changes[0]!.key]!.actorId, alternate);
    const copied = invoke({ args: ['--copy'], state: changed.state, declaration: replacement });
    assert.equal(copied.state.head?.revision, 3);
    for (const state of [changed.state, copied.state]) {
      const verified = invoke({ actor: alternate, state, declaration: replacement });
      assert.equal(verified.status, 0, JSON.stringify(verified.report.findings));
      noWrites(verified, state);
      assert.deepEqual(verified.trace, observed);
      assert.equal(verified.report.receipts[2]!.prices[0]!.subscriptionUnitPriceMinor, 2090);
    }
    const copy = invoke({ args: ['--copy'], actor: alternate, state: changed.state, declaration: replacement });
    finding(copy, 'publisher_not_authorized', /original issuing administrator/u);
    noWrites(copy, changed.state);
    const release = invoke({ failAt: ordered.indexOf('lookup:2') + 1 });
    for (const args of [[], ['--prepare-only']]) {
      const resume = invoke({ args, actor: alternate, state: release.state });
      finding(resume, 'publisher_not_authorized', /original issuing administrator/u);
      noWrites(resume, release.state);
    }
    for (const state of [undefined, release.state]) {
      const unpublished = invoke({ args: repriceArgs, ...(state && { state }) });
      const row = finding(unpublished, 'starter_catalogue_copy_requires_published', /without --copy or --reprice first/u);
      assert.equal(row.recheck, 'Check that Activation is published before using --copy or --reprice.');
      assert.deepEqual(writes(unpublished), []);
    }
  });

  test('concurrent reviews use distinct administrator keys and stop the stale attempt', { skip: nestedSkip }, () => {
    const initial = invoke();
    complete(initial);
    const options = { args: repriceArgs, declaration: replacement, state: initial.state };
    const raced = invoke({ ...options, actor: alternate, approveAfter: options });
    const row = finding(raced, 'expected_state_mismatch', recovery);
    assert.equal(row.reason, 'expected_state_mismatch');
    assert.equal(row.subject, 'FIRST');
    assert.deepEqual(committed(raced), []);
    assert.equal(raced.trace.at(-1), 'price-apply:FIRST');
    assert.equal(price(raced.state).unitPriceMinor, 2200);
    const receipts = Object.values(raced.state.priceReceipts);
    assert.equal(receipts.length, Object.keys(initial.state.priceReceipts).length + 1);
    const winner = receipts.at(-1)!;
    assert.equal(winner.actorId, actorId);
    assert.deepEqual(winner.previous, raced.changes[0]!.expected);
    assert.notEqual(winner.key, raced.changes[0]!.key);
    const rerun = invoke({ ...options, actor: alternate, state: raced.state });
    complete(rerun);
    noWrites(rerun, raced.state);
    assert.deepEqual(rerun.prompts, []);
  });

  test('published price checks distinguish replacements, missing bases, schedules and ambiguity', { skip: nestedSkip }, () => {
    const initial = invoke();
    complete(initial);
    const state = initial.state;
    const skuId = state.drafts[1]!.payload.skus[0]!.id;
    const missing = structuredClone(state);
    delete missing.prices[skuId];
    delete missing.priceReceipts[state.prices[skuId]!.key];
    for (const args of [[], ['--copy'], repriceArgs]) {
      const options = { args, declaration: replacement, state };
      for (const [extra, code, remedy] of [
        [{ state: missing }, 'starter_catalogue_reprice_base_missing', /authorized price action with no prior entry/u],
        [{ state: missing, pending: ['FIRST'] }, 'starter_catalogue_price_scheduled', /clear the scheduled base price first/u],
        [{ pending: ['FIRST'] }, 'starter_catalogue_price_scheduled', /clear the scheduled base price first/u],
        [{ ambiguous: ['FIRST'] }, 'base_price_ambiguous', /Route the duplicate to the pricing owner/u],
        [{ ineligible: ['FIRST'] }, 'starter_catalogue_reprice_requires_active', /Publish Activation for a draft product/u],
      ] as const) {
        const result = invoke({ ...options, ...extra } as Options);
        const row = finding(result, code, remedy);
        assert.equal(row.subject, 'FIRST');
        assert.equal(row.path, 'basePrices');
        noWrites(result, 'state' in extra ? extra.state : state);
        if (args !== repriceArgs) assert.ok(!result.trace.some(step => step.endsWith(':amount')));
        if (code === 'starter_catalogue_price_scheduled') assert.equal(result.trace.at(-1), 'price-preview:FIRST');
      }
      if (args !== repriceArgs) {
        const required = invoke(options);
        assert.ok(!required.trace.some(step => step.endsWith(':amount')));
        const row = finding(required, 'starter_catalogue_reprice_required', /set the declared amount to the live price/u);
        assert.equal(row.subject, 'FIRST');
        assert.equal(required.trace.at(-1), 'price-preview:SECOND');
        noWrites(required, state);
      }
      const matchedSchedule = invoke({ args, state, pending: ['FIRST'] });
      finding(matchedSchedule, 'starter_catalogue_price_scheduled', /clear the scheduled base price first/u);
      noWrites(matchedSchedule, state);
      assert.ok(!matchedSchedule.trace.some(step => step.endsWith(':amount')));
      const restored = invoke({ args, state });
      assert.equal(restored.status, 0, JSON.stringify(restored.report.findings));
    }
    const repaired = structuredClone(missing);
    const repair = writeBase(repaired, actorId, 'repair', 'FIRST', { variantId: skuId, unitPriceMinor: 1900,
      expected: { entryId: null, unitPriceMinor: null } });
    assert.equal(repair.outcome, 'committed');
    assert.equal(repair.receipt?.previous, null);
    const verified = invoke({ state: repaired });
    complete(verified);
    noWrites(verified, repaired);
    assert.equal(verified.report.receipts[2]!.prices[0]!.entryId, repair.receipt?.current.entryId);
    const changed = invoke({ state, args: repriceArgs, declaration: replacement });
    complete(changed);
    for (const args of [[], ['--copy']]) {
      const verified = invoke({ args, state: changed.state, declaration: replacement });
      assert.equal(verified.status, 0, JSON.stringify(verified.report.findings));
      assert.ok(!writes(verified).some(step => step.startsWith('price-apply')));
    }
  });

  test('a stale second SKU leaves the first receipt and immediate verification intact', { skip: nestedSkip }, () => {
    const initial = invoke();
    complete(initial);
    const result = invoke({ args: repriceArgs, state: initial.state, stale: 'SECOND',
      declaration: { ...replacement, basePrices: { ...replacement.basePrices, SECOND: 3000 } } });
    const row = finding(result, 'expected_state_mismatch', recovery);
    assert.equal(row.subject, 'SECOND');
    assert.deepEqual(result.trace.slice(-4), ['approval', 'price-apply:FIRST', 'price-preview:FIRST', 'price-apply:SECOND']);
    assert.equal(committed(result).length, 1);
    assert.equal(committed(result)[0]!.prices[0]!.policyRevisionId, policy.revisionId);
    assert.equal(committed(result)[0]!.prices[0]!.subscriptionUnitPriceMinor, 2090);
    assert.deepEqual(price(result.state, 1), price(initial.state, 1));
    assert.equal(Object.keys(result.state.priceReceipts).length, Object.keys(initial.state.priceReceipts).length + 1);
  });

  test('a schedule reported in the amount review or added after approval prevents a write', { skip: nestedSkip }, () => {
    const initial = invoke();
    complete(initial);
    const options = { args: repriceArgs, state: initial.state, declaration: replacement };
    const reviewed = invoke({ ...options, pendingOnAmount: 'FIRST' });
    finding(reviewed, 'starter_catalogue_price_scheduled', /clear the scheduled base price first/u);
    assert.equal(reviewed.trace.at(-1), 'price-preview:FIRST:amount');
    assert.deepEqual(reviewed.prompts, []);
    noWrites(reviewed, initial.state);
    const refused = invoke({ ...options, pendingAfterReview: 'FIRST' });
    finding(refused, 'expected_state_mismatch', recovery);
    assert.deepEqual(refused.trace.slice(-2), ['approval', 'price-apply:FIRST']);
    assert.deepEqual(refused.state, initial.state);
  });

  test('reprice preserves its receipt and stops when readback cannot verify', { skip: nestedSkip }, () => {
    const initial = invoke();
    complete(initial);
    const options = { args: repriceArgs, state: initial.state, declaration: replacement };
    const declaration = { ...replacement, basePrices: { ...replacement.basePrices, SECOND: 3000 } };
    for (const refresh of ['actor', 'list'] as const) {
      const refused = invoke({ ...options, refresh, refreshBeforeApply: true });
      finding(refused, 'starter_catalogue_reprice_review_required', recovery);
      noWrites(refused, initial.state);
      const result = invoke({ ...options, refresh });
      const row = unverified(result);
      assert.equal(row.reason, 'starter_catalogue_reprice_review_required');
      assert.match(row.recheck, /Check the default report/u);
      assert.equal(result.trace.at(-1), 'price-target');
    }
    for (const readback of ['list', 'missing', 'entry', 'amount', 'figure', 'policy', 'pending'] as const) {
      const result = invoke({ ...options, readback, declaration });
      const row = unverified(result);
      assert.equal(row.reason, readback === 'policy' ? 'starter_catalogue_d2c_policy_required' :
        readback === 'pending' ? 'starter_catalogue_price_scheduled' : undefined);
      assert.deepEqual(row.issues, readback === 'policy' ? [{ code: 'policy_changed' }] : undefined);
      assert.equal(result.trace.at(-1), 'price-preview:FIRST');
      assert.deepEqual(writes(result), ['price-apply:FIRST']);
      assert.deepEqual(price(result.state, 1), price(initial.state, 1));
      const verified = invoke({ state: result.state, declaration });
      const remaining = finding(verified, 'starter_catalogue_reprice_required', /set the declared amount to the live price/u);
      assert.equal(remaining.subject, 'SECOND');
      assert.ok(!verified.trace.some(step => step.endsWith(':amount')));
      noWrites(verified, result.state);
      assert.equal(verified.report.receipts[2]!.prices[0]!.subscriptionUnitPriceMinor, 2090);
      assert.equal(verified.report.receipts[2]!.prices[0]!.policyRevisionId, policy.revisionId);
    }
  });

  test('a policy, list or amount refusal stops on the second SKU with only the first receipt', { skip: nestedSkip }, () => {
    const initial = invoke();
    complete(initial);
    const declaration = { ...replacement, basePrices: { ...replacement.basePrices, SECOND: 3000 } };
    assert.equal(deriveSubscriptionUnitPrice(price(initial.state, 1).unitPriceMinor, coarsePolicy), 0);
    assert.ok(deriveSubscriptionUnitPrice(declaration.basePrices.SECOND, coarsePolicy) > 0);
    for (const stopSecond of ['policy', 'expired', 'zero-old', 'derived-zero', 'list'] as const) {
      const result = invoke({ args: repriceArgs, state: initial.state, declaration, stopSecond });
      const code = stopSecond === 'list' ? 'price_list_not_active' : stopSecond === 'derived-zero'
        ? 'starter_catalogue_derived_price_zero' : 'starter_catalogue_d2c_policy_required';
      const row = finding(result, code, recovery);
      assert.equal(row.subject, 'SECOND');
      assert.notEqual(row.observed, 'committed; figure not verified');
      assert.deepEqual(result.trace.slice(-4), ['approval', 'price-apply:FIRST', 'price-preview:FIRST', 'price-apply:SECOND']);
      assert.equal(committed(result).length, 1);
      assert.equal(committed(result)[0]!.prices[0]!.subscriptionUnitPriceMinor, 2090);
      assert.deepEqual(price(result.state, 1), price(initial.state, 1));
      assert.equal(Object.keys(result.state.priceReceipts).length, Object.keys(initial.state.priceReceipts).length + 1);
    }
  });

  test('default observes a committed entry before refusing an unapplied amount after policy rollover', { skip: nestedSkip }, () => {
    const initial = invoke();
    complete(initial);
    const declaration = { ...replacement, basePrices: { FIRST: 3200, SECOND: 2900 } };
    const result = invoke({ args: repriceArgs, state: initial.state, declaration, loseRepriceReply: true });
    const lost = finding(result, 'OPENLUP_E_CATALOGUE_APPLY_UNAVAILABLE', recovery);
    assert.notEqual(lost.observed, 'committed; figure not verified');
    assert.deepEqual(result.trace.slice(-2), ['approval', 'price-apply:FIRST']);
    assert.deepEqual(committed(result), []);
    assert.equal(price(result.state).unitPriceMinor, 3200);
    assert.deepEqual(price(result.state, 1), price(initial.state, 1));
    const verified = invoke({ state: result.state, declaration, rolledPolicy: true });
    const rejected = finding(verified, 'starter_catalogue_derived_price_zero', /Choose a base that derives a positive/u);
    assert.equal(rejected.subject, 'SECOND');
    noWrites(verified, result.state);
    assert.deepEqual(verified.trace, observed);
    assert.deepEqual(verified.report.receipts[2]?.prices[0], { ...price(result.state),
      skuId: initial.state.drafts[1]!.payload.skus[0]!.id, currency,
      policyRevisionId: coarsePolicy.revisionId, subscriptionUnitPriceMinor: 3000 });
  });

  test('native price evidence refusals retain the owner code and use the batch recovery', { skip: nestedSkip }, () => {
    const initial = invoke();
    complete(initial);
    const options = { args: repriceArgs, state: initial.state, declaration: replacement };
    const failAt = observed.length + 3;
    for (const code of CATALOG_PRICE_SETUP_HARD_REFUSALS) {
      const result = invoke({ ...options, failAt, refusal: { code } });
      const row = finding(result, code, recovery);
      assert.equal(row.reason, code);
      assert.equal(row.subject, 'FIRST');
      assert.equal(result.trace.at(-1), 'price-apply:FIRST');
      assert.deepEqual(result.state, initial.state);
    }
  });

  test('the starter guide publishes, reprices and verifies its declaration using the installed type version', { skip: nestedSkip }, async () => {
    const { starterCatalogue } = await import('../host/editor-catalogue.ts');
    const version = starterCatalogue().current!.version;
    const guide = readFileSync(new URL('docs/guide/how-to/build/customize-the-starter.md',
      import.meta.resolve('@openlup/core/package.json')), 'utf8');
    const snippet = guide.split('### Release, price and activate a demo product')[1]?.split('```ts\n')[1]?.split('```')[0];
    assert.ok(snippet);
    const source = stripTypeScriptTypes(snippet.replace('"@openlup/platform/catalog"', JSON.stringify(import.meta.resolve('@openlup/platform/catalog'))));
    const { demoCatalogueProduct } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const result = invoke({ declaration: demoCatalogueProduct(version) });
    complete(result);
    assert.equal(result.state.drafts[1]!.payload.product.type.version, version);
    assert.deepEqual(Object.values(result.state.prices).map(row => row.current.unitPriceMinor), [1900]);
    const recipe = guide.split("### Change a product's price")[1]!.split('###')[0]!;
    const command = /npm run catalogue:apply -- (\S+)`/u.exec(recipe)?.[1];
    assert.equal(command, '--reprice');
    const declaration = demoCatalogueProduct(version);
    const code = Object.keys(declaration.basePrices)[0]!;
    declaration.basePrices[code] = 2200;
    const changed = invoke({ args: [command], state: result.state, declaration });
    complete(changed);
    assert.equal(price(changed.state).unitPriceMinor, 2200);
    assert.equal(committed(changed)[0]!.prices[0]!.subscriptionUnitPriceMinor, 2090);
    const verified = invoke({ state: changed.state, declaration });
    complete(verified);
    noWrites(verified, changed.state);
    assert.equal(verified.report.receipts[2]!.prices[0]!.policyRevisionId, policy.revisionId);
  });
}
