import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module';
import { env } from 'node:process';
import readline from 'node:readline/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catalogInternalGtin, type CatalogProductInput } from '@openlup/platform/catalog';
import { selectConfiguration } from '../owned/store.config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const workerFlag = 'OPENLUP_CATALOGUE_APPLY_TEST_CHILD';
const currency = selectConfiguration().market.currency;
const actorId = '11111111-1111-4111-8111-111111111111';
const priceListId = '22222222-2222-4222-8222-222222222222';
const policy = { revisionId: '33333333-3333-4333-8333-333333333333', discountBps: 500,
  roundingQuantumMinor: 10, roundingRule: 'FLOOR_TO_QUANTUM' };
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
type State = { drafts: Record<number, Draft>; decisions: Record<string, object>;
  publications: Record<string, Publication>; prices: Record<string, { key: string; current: Price }>;
  head: Head | null };
type Options = { declaration?: unknown; args?: string[]; noTerminal?: boolean; mediaIoError?: boolean;
  missingProduct?: boolean; wrongTarget?: boolean; closeAt?: 'email' | 'token'; declineAt?: number;
  failAt?: number; refusal?: Partial<Finding>; failRetry?: boolean; state?: State };
type Observation = { trace: string[]; state: State; retry: { key: string; body: unknown }[] };
type Output = Observation & { report: { findings: Finding[]; receipts: { stage: string; outcome: string }[] }; status: number };

if (env[workerFlag] === '1') {
  const options: Options = JSON.parse(readFileSync(0, 'utf8'));
  const state: State = options.state ?? { drafts: {}, decisions: {}, publications: {}, prices: {}, head: null };
  const trace: string[] = [], retry: Observation['retry'] = [];
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
      if (step === 'approval') return ++approvals === options.declineAt ? 'decline' : 'approve';
      return step === 'email' ? 'operator@example.test' : 'fixture-token';
    },
  }) });
  syncBuiltinESMExports();
  process.on('exit', () => process.stderr.write('\nfixture: ' + JSON.stringify({ trace, state, retry }) + '\n'));
  const response = (value: unknown, headers?: Record<string, string>) => Response.json({ ok: true, value }, { headers });
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
      : skuCode ? action + ':' + skuCode : action;
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
    if (step === 'redeem') return response({ expiresAt: '2099-01-01T00:00:00Z' }, { 'Set-Cookie': 'starter_session=' + 'x'.repeat(43) });
    assert.equal(new Headers(init?.headers).get('cookie'), 'starter_session=' + 'x'.repeat(43));
    switch (action) {
      case 'price-target': return response({ actorId, priceListId, currency, policy });
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
          actorId, commandKey: key, payload: fields.payload };
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
        const receipt = { actorId, commandKey: key, ...fields };
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
        const receipt = { actorId, commandKey: key, productId: record.productId, previousHead: state.head, head };
        state.publications[key] = receipt;
        state.head = head;
        return response({ outcome: 'committed', receipt });
      }
      case 'price-preview': {
        assert.deepEqual(fields, { variantId: fields.variantId, priceListId });
        assert.ok(skuCode);
        const current = state.prices[fields.variantId]?.current ?? null;
        return response({ listEffective: true, priceSetup: { inGate: false, current, currentCount: Number(!!current),
          subscription: { ...policy, kind: 'derived' } } });
      }
      case 'price-apply': {
        assert.ok(skuCode);
        assert.equal(state.head?.revision === 1 || !!options.state, true);
        const current = { entryId: 'entry-' + skuCode, unitPriceMinor: fields.unitPriceMinor };
        const saved = state.prices[fields.variantId];
        if (saved) assert.deepEqual({ key, current }, saved);
        else state.prices[fields.variantId] = { key, current };
        return response({ currency, outcome: saved ? 'replayed' : 'committed', receipt: { current } });
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
  return { ...observation, report, status: result.status! };
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

if (!env[workerFlag]) {
  test('catalogue apply validates authored input and resumes after each local refusal', async context => {
    const media = (mediaRef: string) => ({ ...authored, product: { ...authored.product, presentation: { title: 'Notebook', mediaRef } } });
    const cases: [Options, string, RegExp, string[]][] = [
      [{ missingProduct: true }, 'OPENLUP_E_CATALOGUE_PRODUCT_REQUIRED', /Add the documented product/u, []],
      [{ declaration: { ...authored, basePrices: { FIRST: 1900 } } }, 'OPENLUP_E_CATALOGUE_BASE_PRICES_MISMATCH', /Match the price keys/u, []],
      ...[0, 1.5, 2_147_483_648].map((FIRST): [Options, string, RegExp, string[]] => [
        { declaration: { ...authored, basePrices: { ...authored.basePrices, FIRST } } },
        'starter_catalogue_price_invalid', /whole minor-unit amount from 1 to 2147483647/u, [],
      ]),
      [{ declaration: { ...authored, basePrices: { ...authored.basePrices, FIRST: 1 } } },
        'starter_catalogue_derived_price_zero', /Choose a base that derives a positive/u, ordered.slice(0, 6)],
      [{ declaration: { ...authored, product: { ...authored.product, document: { content: 'é'.repeat(34_000) } } } },
        'starter_catalogue_save_too_large', /Shorten optional content/u, []],
      [{ declaration: { ...authored, product: { ...authored.product, presentation: { title: ' ' } } } },
        'starter_catalogue_presentation_invalid', /Supply a title/u, []],
      [{ declaration: media('/media/missing-proof.svg') }, 'starter_catalogue_media_invalid', /match the filename case/u, []],
      [{ declaration: media('/media/light.svg'), mediaIoError: true },
        'catalog_publication_media_validation_unavailable', /Check the starter.s local media directory/u, []],
      [{ noTerminal: true }, 'OPENLUP_E_CATALOGUE_TERMINAL_REQUIRED', /interactive terminal/u, []],
      [{ closeAt: 'email' }, 'starter_catalogue_sign_in_incomplete', /complete operator sign-in/u, ordered.slice(0, 2)],
      [{ closeAt: 'token' }, 'starter_catalogue_sign_in_incomplete', /complete operator sign-in/u, ordered.slice(0, 4)],
      [{ declineAt: 1 }, 'OPENLUP_E_CATALOGUE_CONFIRMATION_INVALID', /confirm only if you intend to publish/u, ordered.slice(0, 11)],
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

  test('catalogue apply orders no-amount previews before prices, issues two revisions and exactly replays', () => {
    const first = invoke();
    complete(first);
    assert.deepEqual(first.trace, ordered);
    assert.deepEqual(Object.keys(first.state.drafts), ['1', '2']);
    assert.equal(Object.keys(first.state.decisions).length, 2);
    assert.equal(Object.keys(first.state.publications).length, 2);
    assert.equal(Object.keys(first.state.prices).length, 2);
    const replay = invoke({ state: first.state });
    complete(replay);
    assert.deepEqual(replay.state, first.state);
    assert.ok(replay.report.receipts.every(row => ['observed', 'replayed'].includes(row.outcome)));
    assert.ok(replay.trace.every(step => !/^(?:approve|publish|prepare):/u.test(step)));
  });

  test('catalogue apply stops and resumes at each refused host stage', async context => {
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
      ['price-preview:FIRST', 'expected_state_mismatch', /route any correction to the pricing owner/u, 'last'],
      ['price-preview:SECOND', 'expected_state_mismatch', /route any correction to the pricing owner/u, 'last'],
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
    owners.push(['price-apply:SECOND', 'expected_state_mismatch', /route any correction to the pricing owner/u]);
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
      finding(refused, 'OPENLUP_E_CATALOGUE_CONFIRMATION_INVALID', /confirm only if you intend to publish/u);
      assert.deepEqual(refused.trace, ordered.slice(0, ordered.lastIndexOf('approval') + 1));
      assert.equal(refused.state.head?.revision, 1);
      complete(invoke({ state: refused.state }));
    });
  });

  test('catalogue apply retries the identical startup Publish once and retains the final native finding', () => {
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

  test('catalogue copy requires Release and Activation, then refuses unchanged presentation with a recoverable remedy', () => {
    const args = ['--copy'];
    const beforeRelease = invoke({ args });
    finding(beforeRelease, 'starter_catalogue_copy_requires_published', /npm run catalogue:apply without --copy/u);
    assert.deepEqual(beforeRelease.trace, ordered.slice(0, 7));
    const first = invoke({ failAt: ordered.indexOf('lookup:2') + 1 });
    assert.equal(first.state.head?.revision, 1);
    const beforeActivation = invoke({ args, state: first.state });
    finding(beforeActivation, 'starter_catalogue_copy_requires_published', /npm run catalogue:apply without --copy/u);
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

  test('the starter guide declaration runs through the CLI with the installed type version', async () => {
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
  });
}
