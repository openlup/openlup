/**
 * The starter's storefront proof kit: what a PostgreSQL-tier storefront proof needs from the host, and nothing from
 * the UI. It reads the owned proof file, matches the starter's checkout commands, drives the sandbox outcomes through
 * the starter's marker, binds the package observer to one database session, names the build, and judges and reports
 * each verdict.
 *
 * It holds no configuration id, route or page locator: those come from the proof file and the storefront anchors.
 * The one selector it builds is the sandbox outcome marker. It imports no browser library at run time, so a command
 * can import it.
 */
import { lstat, mkdir, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import {
  createPostgresStorefrontObserver, serializeStorefrontVerdict,
  type PageHandle, type StorefrontObserver, type StorefrontScenario,
} from '@openlup/platform/storefront/testing';
import {
  digestStorefrontFiles, parseStorefrontProofFile, parseStorefrontVerdict,
  type StorefrontProofFile, type StorefrontVerdict,
} from '@openlup/platform/lifecycle';
import { refusal } from '../shared/refusals.ts';
import { actionPath } from '../shared/transport.ts';
import { sandboxOutcomeAttribute } from '../shared/storefront-bindings.ts';
import { routes } from '../shared/routes.ts';
import { selectionEntryPath } from '../shared/selection-entry.ts';
import type { Operation } from '../shared/api.ts';
import { configurations } from '../owned/store.config.ts';

/** The owned proof file, relative to the application root. */
const proofPath = 'owned/storefront-proof.json';
/** Where verdicts are written, relative to the application root. */
const verdictDirectory = '.context/storefront-verdicts';
/** The served client build, relative to the application root. */
const clientRoot = 'dist';
const tier = 'postgres_sandbox';
const proofRecheck = 'Run `npm run proof:postgres` again; it reads the proof file before any database or host starts.';
const packageNames = ['@openlup/core', '@openlup/outbox', '@openlup/platform'] as const;
/** The outcome kinds the storefront runner knows; a scenario needing any other kind is never admitted. */
const runnerOutcomes: ReadonlySet<string> = new Set(['declined', 'pending', 'settled', 'settled_after_pending', 'activation_pending']);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The proof file this starter ships, built from its own sources: the first configuration, the default locale's
 * catalogue, cart, checkout and account routes, and per purchase mode a cart route selecting the configuration's
 * first product at the offer's minimum units. A store without `owned/storefront-proof.json` is proven with these
 * values; a repository test pins them to the shipped file.
 */
export const shippedStorefrontProof: StorefrontProofFile = deepFreeze((() => {
  const id = Object.keys(configurations)[0]!;
  const config = configurations[id]!;
  const locale = config.market.defaultLocale;
  const line = { sku: config.offer.products[0]!.sku, quantity: config.offer.minUnits };
  return {
    formatVersion: 1 as const,
    configurations: [id],
    widths: [1280],
    routes: {
      surfaces: { product: routes.catalog[locale], cart: routes.cart[locale], checkout: routes.checkout[locale], account: routes.account[locale] },
      selectionEntry: {
        one_time: selectionEntryPath(locale, { mode: 'one_time', lines: [line] }),
        subscription: selectionEntryPath(locale, { mode: 'subscription', lines: [line] }),
      },
    },
    changedPayloadPolicy: 'refuse_changed',
    autoProgress: [],
    recheck: 'npm run proof:postgres -- --scenario {scenario}',
  };
})());

/** The proof this run uses: the owned file, or the shipped values when the store has no file. */
export type StorefrontProof = {
  source: 'file' | 'shipped';
  proofFile: StorefrontProofFile;
  /** The digest of the file's bytes, or `null` for the shipped values. */
  digest: string | null;
  /** The one configuration this tier proves. */
  configuration: string;
};

/**
 * Reads `owned/storefront-proof.json` under `root`, or the shipped values when it is absent. The package parser owns
 * the file's shape; this tier adds three rules: one configuration, which must exist, and no adapter module (the
 * managed pages are proven on their anchors, and a module is never imported). Every refusal has four parts.
 */
export async function readStorefrontProof(root: string): Promise<StorefrontProof> {
  const path = join(root, proofPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { source: 'shipped', proofFile: shippedStorefrontProof, digest: null, configuration: shippedStorefrontProof.configurations[0]! };
    }
    throw refusal('starter_storefront_proof_file_unreadable', proofPath, `${proofPath} exists but cannot be read as a file (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`,
      'The storefront proof reads its configuration, widths and routes from this file.',
      `Make ${proofPath} a readable regular file, or remove it to prove the shipped values.`, proofRecheck);
  }
  const parsed = parseStorefrontProofFile(bytes.toString('utf8'));
  if (!parsed.ok) {
    const { code, observed, cause, fix, recheck } = parsed.refusal;
    throw refusal(code, proofPath, observed, cause, fix, recheck);
  }
  const proofFile = parsed.proofFile;
  if (proofFile.adapterModule !== undefined) {
    throw refusal('starter_storefront_adapter_unsupported', `${proofPath}#adapterModule`, `${proofPath} names the adapter module ${JSON.stringify(proofFile.adapterModule)}.`,
      'At this tier the starter proves its managed pages on their storefront anchors; an adapter module would run store code before any container starts, so it is never imported.',
      'Remove adapterModule from the proof file.', proofRecheck);
  }
  const known = Object.keys(configurations);
  if (proofFile.configurations.length !== 1) {
    throw refusal('starter_storefront_proof_configuration_count', `${proofPath}#configurations`,
      `${proofPath} lists ${proofFile.configurations.length} configurations: ${proofFile.configurations.map(item => JSON.stringify(item)).join(', ')}.`,
      'This tier installs and proves one configuration, and never picks one of several for you.',
      'List exactly one configuration id in configurations.', proofRecheck);
  }
  const configuration = proofFile.configurations[0]!;
  if (!known.includes(configuration)) {
    throw refusal('starter_storefront_proof_configuration_unknown', `${proofPath}#configurations`,
      `${proofPath} names the configuration ${JSON.stringify(configuration)}, which owned/store.config.ts does not define.`,
      'The proof installs the configuration it names, so it must be one of the store configurations.',
      `Name one of ${known.join(', ')}.`, proofRecheck);
  }
  return { source: 'file', proofFile, digest: await digestStorefrontFiles([{ path: proofPath, bytes }]), configuration };
}

/**
 * Refuses a page handle that cannot clear the browser's client state between the clean and the control buyer.
 * Without it the control run would meet the clean buyer's stored purchase, and every scenario with a control would
 * end `not_run`.
 */
export function assertRunnerIsolates(handle: object & { clearClientState?: unknown }, platformVersion: string): void {
  if (typeof handle.clearClientState === 'function') return;
  throw refusal('starter_storefront_runner_unisolated', 'page handle', `The page handle of the installed @openlup/platform ${platformVersion} has no clearClientState.`,
    'The clean and the control run are two buyers; the runner clears cookies and storage between them only through this member.',
    'Install an @openlup/platform release whose createPageHandle provides clearClientState, or pass a page handle that has it.', proofRecheck);
}

type MatchedRequest = { readonly method: string; readonly path: string };
const createPath = actionPath('checkout.create');
/** Every authoritative status read the managed pages send. Sandbox outcomes have operations of their own. */
const readPaths: ReadonlySet<string> = new Set((['checkout.read', 'checkout.continuation', 'checkout.recovery', 'checkout.payment'] satisfies Operation[]).map(actionPath));

/** The starter's create and read matchers and its command key header. */
export const starterStorefrontCommands = Object.freeze({
  create: (request: MatchedRequest): boolean => request.method === 'POST' && request.path === createPath,
  read: (request: MatchedRequest): boolean => request.method === 'POST' && readPaths.has(request.path),
  keyHeader: 'idempotency-key',
});

/** The outcomes the starter's sandbox produces at this tier, each with the marker value of its simulate button. */
export const starterSandboxOutcomes: Readonly<Record<string, 'captured' | 'refused' | 'expired' | 'indeterminate'>> = Object.freeze({
  declined: 'refused',
  settled: 'captured',
});

/** The one selector the kit builds: a sandbox simulate button with this outcome value. */
function sandboxOutcomeSelector(value: string): string {
  return `[${sandboxOutcomeAttribute}="${value}"]`;
}

/** Counts every element matching a selector; a Playwright page satisfies it. */
export type ElementCounter = { locator: (selector: string) => { count(): Promise<number> } };

/**
 * The outcome driver over the sandbox simulate buttons. `produce` waits up to `timeoutMs` for the button marked with
 * the outcome's value, refuses when more than one element carries that value (nothing is clicked), and clicks it
 * through the page handle. A missing, disabled or ambiguous control rejects with a four-part refusal.
 */
export function createStarterOutcomeDriver(page: Pick<PageHandle, 'find' | 'perform'>, options: { readonly timeoutMs: number; readonly counter: ElementCounter }) {
  return {
    capabilities: Object.keys(starterSandboxOutcomes),
    async produce(outcome: string, _context?: { readonly subject: string }): Promise<void> {
      if (!Object.hasOwn(starterSandboxOutcomes, outcome)) {
        throw refusal('starter_storefront_outcome_undeclared', 'outcome driver', `The runner asked for the outcome ${JSON.stringify(outcome)}.`,
          `The starter's sandbox driver declares only ${Object.keys(starterSandboxOutcomes).join(' and ')}, so the runner never admits a scenario needing another outcome.`,
          'Run the scenario with an outcome driver that declares this outcome.', proofRecheck);
      }
      const value = starterSandboxOutcomes[outcome]!;
      const target = { locator: sandboxOutcomeSelector(value) };
      const missing = (detail: string) => refusal('starter_storefront_outcome_control_missing', 'outcome driver',
        `No enabled sandbox control for the outcome ${outcome} (marker value ${value}) ${detail}.`,
        `The driver clicks the sandbox simulate button whose ${sandboxOutcomeAttribute} is ${value}.`,
        `Show one enabled sandbox simulate button carrying ${sandboxOutcomeAttribute} with the value ${value} when the payment is awaited.`, proofRecheck);
      if (await page.find(target, { timeoutMs: options.timeoutMs }) === null) throw missing(`appeared within ${options.timeoutMs} ms`);
      const count = await options.counter.locator(target.locator).count();
      if (count > 1) {
        throw refusal('starter_storefront_outcome_control_ambiguous', 'outcome driver',
          `${count} elements carry ${sandboxOutcomeAttribute} with the value ${value} for the outcome ${outcome}.`,
          'The driver clicks exactly one control and never guesses between several.',
          'Render one sandbox simulate group at a time, so each marker value is on one button.', proofRecheck);
      }
      if (!await page.perform(target, { timeoutMs: options.timeoutMs })) throw missing('could be clicked');
    },
  };
}

/**
 * The package observer over one database session (`exclusive`: the database belongs to this proof). `close` ends
 * the session.
 */
export async function openStorefrontObserver(connectionString: string): Promise<{ observer: StorefrontObserver; close(): Promise<void> }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return { observer: createPostgresStorefrontObserver(client, { exclusive: true }), close: async () => { await client.end(); } };
  } catch (error) {
    await client.end();
    throw error;
  }
}

type BuildIdentity = {
  build: { source: 'claimed'; packages: { name: string; version: string; integrity?: string }[]; clients: { name: string; digest: string }[]; proofFile: string | null };
  harness: { runnerVersion: string };
};

async function regularFiles(root: string, directory: string): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await regularFiles(root, path));
    else if (entry.isFile()) files.push({ path, bytes: await readFile(join(root, path)) });
  }
  return files;
}

/**
 * The build this proof exercises: the installed package versions with their lock integrity when the lock has one,
 * the digest of every regular file under `dist/` (paths relative to it), the proof file's digest, and the installed
 * platform version as the runner version. The source is always `claimed`: the store's own harness runs the runner.
 */
export async function storefrontBuildIdentity(root: string, proof: StorefrontProof): Promise<BuildIdentity> {
  const unavailable = (observed: string, fix: string) => refusal('starter_storefront_build_identity_unavailable', observed, observed,
    'A verdict names the exact build it proved: the installed packages and the served client.', fix, proofRecheck);
  let lock: { packages?: Record<string, { integrity?: unknown }> } = {};
  try { lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')); } catch { /* No lock: no integrity. */ }
  const packages: BuildIdentity['build']['packages'] = [];
  for (const name of packageNames) {
    let version: unknown;
    try { version = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { version = undefined; }
    if (typeof version !== 'string' || version.length === 0) throw unavailable(`${name} is not installed.`, 'Run `npm ci` in the application.');
    const integrity = lock.packages?.[`node_modules/${name}`]?.integrity;
    packages.push({ name, version, ...(typeof integrity === 'string' ? { integrity } : {}) });
  }
  let client: Array<{ path: string; bytes: Uint8Array }>;
  try {
    if (!(await lstat(join(root, clientRoot))).isDirectory()) throw new Error('not a directory');
    client = await regularFiles(join(root, clientRoot), '');
  } catch {
    throw unavailable(`The client build ${clientRoot} is missing.`, 'Run `npm run build` in the application.');
  }
  return {
    build: { source: 'claimed', packages, clients: [{ name: 'managed', digest: await digestStorefrontFiles(client) }], proofFile: proof.digest },
    harness: { runnerVersion: packages.find(item => item.name === '@openlup/platform')!.version },
  };
}

/** The result a scenario must end with, given the outcomes the driver declares. */
export type ExpectedStorefrontResult = {
  scenario: string;
  result: 'passed' | 'safety_only' | 'not_run';
  /** Required outcomes the driver does not declare or the runner does not know. */
  missing: string[];
  /** The driver's declaration, sorted. */
  declared: string[];
};

/** Admitted only when every required outcome is declared and known; then `safety_only` without a control, else `passed`. */
export function expectedStorefrontResult(scenario: StorefrontScenario, declared: readonly string[]): ExpectedStorefrontResult {
  const missing = scenario.requires.outcomes.filter(outcome => !runnerOutcomes.has(outcome) || !declared.includes(outcome));
  const result = missing.length > 0 ? 'not_run' : scenario.control.kind === 'none' ? 'safety_only' : 'passed';
  return { scenario: scenario.id, result, missing, declared: [...declared].sort() };
}

/** The run a verdict must belong to. */
export type StorefrontProofRun = { runId: string; scenario: string; width: number; proof: StorefrontProof; identity: BuildIdentity };
export type StorefrontJudgement =
  | { ok: true }
  | { ok: false; reason: string; detail: string; refusal?: { code: string; observed: string; cause: string; fix: string; recheck: string } };

const sameList = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(a) === JSON.stringify(b);
const packageKey = (item: { name: string; version: string; integrity?: string | undefined }) => JSON.stringify([item.name, item.version, item.integrity ?? null]);

/**
 * Green only when the verdict belongs to this run and build, and its result is the expected one: `passed` or
 * `safety_only` as expected for an admitted scenario, or for a scenario that is not admitted a `not_run` with exactly
 * one `tier_unreachable` finding for the whole scenario, no steps, no stimulus, no control applied and the kit's
 * declaration. Every other combination is red, including a result added to the open set later. Finding prose is
 * never read.
 */
export function judgeStorefrontVerdict(expected: ExpectedStorefrontResult, verdict: StorefrontVerdict | string | null | undefined, run: StorefrontProofRun): StorefrontJudgement {
  const red = (reason: string, detail: string): StorefrontJudgement => ({ ok: false, reason, detail });
  if (verdict === undefined || verdict === null) return red('verdict_missing', `No verdict was written for ${run.scenario} at ${run.width} in run ${run.runId}.`);
  const parsed = parseStorefrontVerdict(typeof verdict === 'string' ? verdict : JSON.stringify(verdict));
  if (!parsed.ok) return { ok: false, reason: 'verdict_invalid', detail: parsed.refusal.observed, refusal: parsed.refusal };
  const found = parsed.verdict;
  const { build, harness } = found;
  const checks: Array<[boolean, string, string]> = [
    [found.runId === run.runId, 'run_id_mismatch', `runId ${found.runId}, expected ${run.runId}`],
    [found.scenario === run.scenario && expected.scenario === run.scenario, 'scenario_mismatch', `scenario ${found.scenario}, expected ${run.scenario}`],
    [found.tier === tier, 'tier_mismatch', `tier ${found.tier}, expected ${tier}`],
    [found.profile === run.proof.configuration, 'profile_mismatch', `profile ${found.profile}, expected ${run.proof.configuration}`],
    [found.channel === 'browser_ui', 'channel_mismatch', `channel ${found.channel}, expected browser_ui`],
    [found.width === run.width, 'width_mismatch', `width ${String(found.width)}, expected ${run.width}`],
    [build.proofFile === run.proof.digest && build.proofFile === run.identity.build.proofFile, 'proof_file_mismatch', `proof file ${String(build.proofFile)}, expected ${String(run.proof.digest)}`],
    [sameList(build.clients.map(item => [item.name, item.digest]), run.identity.build.clients.map(item => [item.name, item.digest])), 'clients_mismatch', 'the client digests differ from this build'],
    [sameList(build.packages.map(packageKey).sort(), run.identity.build.packages.map(packageKey).sort()), 'packages_mismatch', 'the package set differs from the installed packages'],
    [harness.adapter.kind === 'default' && harness.adapter.fields.length === 0 && harness.adapter.digest === null, 'adapter_mismatch', `adapter ${harness.adapter.kind}, expected default`],
    [harness.observer === 'package', 'observer_mismatch', `observer ${harness.observer}, expected package`],
    [sameList(harness.declaredOutcomes, expected.declared), 'declared_outcomes_mismatch', `declared ${harness.declaredOutcomes.join(', ')}, expected ${expected.declared.join(', ')}`],
    [harness.runnerVersion === run.identity.harness.runnerVersion, 'runner_version_mismatch', `runner ${harness.runnerVersion}, expected ${run.identity.harness.runnerVersion}`],
    [sameList(harness.autoProgress, run.proof.proofFile.autoProgress ?? []), 'auto_progress_mismatch', `autoProgress ${harness.autoProgress.join(', ')}`],
    [harness.catalogueVersion === 1, 'catalogue_version_mismatch', `catalogue version ${harness.catalogueVersion}, expected 1`],
  ];
  for (const [holds, reason, detail] of checks) if (!holds) return red(reason, detail);
  const unexpected = red('result_unexpected', `result ${found.result}, expected ${expected.result}`);
  if (found.result !== expected.result) return unexpected;
  if (expected.result === 'not_run') {
    const only = found.findings.length === 1 ? found.findings[0]! : null;
    const declaredOnly = only !== null && only.code === 'tier_unreachable' && only.run === null && only.step === null;
    const nothingRan = found.steps.length === 0 && Object.keys(found.stimulus).length === 0 && found.control.applied === false;
    if (!declaredOnly || !nothingRan || !sameList(harness.declaredOutcomes, expected.declared)) {
      return red('result_unexpected', 'not_run is expected only as tier_unreachable for the whole scenario, before anything ran');
    }
  }
  return { ok: true };
}

/**
 * Writes the verdict as one new file `.context/storefront-verdicts/<scenario>.<width>.<runId>.json`, through the
 * package serializer, readable by the owner only. A run's file is never overwritten. Resolves the path.
 */
export async function writeStorefrontVerdict(root: string, verdict: StorefrontVerdict): Promise<string> {
  const text = serializeStorefrontVerdict(verdict);
  const directory = join(root, verdictDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `${verdict.scenario}.${String(verdict.width)}.${verdict.runId}.json`);
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/** A run subject's e-mail, which names the run; summaries print `<subject>` instead. */
const runSubject = /storefront-[A-Za-z0-9-]+@example\.test/g;
const redact = (text: string) => text.replace(runSubject, '<subject>');

/**
 * One summary line, then per verdict its findings, each on one line with its code, run, step and four parts. A
 * verdict whose judgement is red first gets a line `UNEXPECTED <result>`. Run subjects are replaced by `<subject>`.
 */
export function formatStorefrontProofSummary(entries: ReadonlyArray<{ verdict: StorefrontVerdict; judgement: StorefrontJudgement }>,
  context: { configuration: string; clientDigest: string }): string {
  const counts = { passed: 0, safety_only: 0, not_run: 0, other: 0 };
  const lines: string[] = [];
  for (const { verdict, judgement } of entries) {
    const at = `  ${verdict.scenario} at ${String(verdict.width)}:`;
    const result = verdict.result;
    if (judgement.ok && (result === 'passed' || result === 'safety_only' || result === 'not_run')) counts[result as keyof typeof counts] += 1;
    else {
      counts.other += 1;
      lines.push(redact(`${at} UNEXPECTED ${verdict.result} (${judgement.ok ? 'result_unexpected' : `${judgement.reason}: ${judgement.detail}`})`));
    }
    for (const item of verdict.findings) {
      const place = item.run === null ? 'whole scenario' : `${item.run} step ${item.step === null ? '-' : String(item.step)}`;
      lines.push(redact(`${at} ${item.code} (${place}): observed ${item.observed} cause ${item.cause} fix ${item.fix} recheck ${item.recheck}`));
    }
  }
  const head = `storefront proof: tier ${tier}; configuration ${context.configuration}; client root ${clientRoot}; client digest ${context.clientDigest}; `
    + `verdicts ${verdictDirectory}; ${counts.passed} passed, ${counts.safety_only} safety_only, ${counts.not_run} not_run (declared), ${counts.other} other`;
  return [redact(head), ...lines].join('\n');
}
