// Frozen static query smoke matrix, 2026-10-29, plus one per-symbol maturity row. This is not an agent-outcome benchmark.
// The maturity row is the one deliberate exception to a frozen matrix: it names no symbol in advance. It takes the first
// symbol declared experimental inside a stable subpath of the installed core, so promoting a symbol never breaks the matrix.
// Usage: node scripts/agent-context/evaluate.mjs /absolute/cold-consumer-root
// Reads installed artifacts only. No writes, network, package installation or dependencies.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

const tasks = Object.freeze([
  { id: 'exact-retry', query: 'nextRetryAttemptAt', direct: 'nextRetryAttemptAt', target: 'nextRetryAttemptAt' },
  { id: 'exact-upgrade', query: 'planAppUpgrade', direct: 'planAppUpgrade', target: 'planAppUpgrade' },
  { id: 'exact-http', query: 'createNodeHttpRuntime', direct: 'createNodeHttpRuntime', target: 'createNodeHttpRuntime' },
  { id: 'critical-cycle', query: 'late delivery monotonic clamp', direct: 'monotonic|late.delivery', target: 'monotonic' },
  { id: 'upgrade-conflict', query: 'application file upgrade local edits conflict', direct: 'divergent changed files|local edits', target: 'refuses divergent changed files' },
  { id: 'role-proof-boundary', query: 'legacy bootstrap role install readiness', direct: 'rolePrerequisitesMet|install readiness', target: 'rolePrerequisitesMet[\\s\\S]{0,60}does not establish' },
  { id: 'transaction-outbox', query: 'PostgreSQL enqueue transaction', direct: 'enqueue|transaction', target: 'enqueue', packageName: '@openlup/outbox' },
  { id: 'catalogue-net-content', query: 'publish net content ml', direct: 'Discover the grammar', target: '^## Discover the grammar(?:\\n|$)', guide: 'how-to/extend/catalogue-extension.md' },
  { id: 'catalogue-refusal-fix', query: 'catalogue refusal code fix', direct: 'Catalogue refusal code fixes', target: '^## Catalogue refusal code fixes(?:\\n|$)', guide: 'reference/refusal-codes.md' },
  { id: 'polish-with-symbol', query: 'Gdzie jest nextRetryAttemptAt i retry?', direct: 'nextRetryAttemptAt|retry', target: 'nextRetryAttemptAt' },
  { id: 'polish-freeform', query: 'Czy opóźniona dostawa przesuwa kolejny cykl wcześniej?', direct: 'opóźniona|dostawa|wcześniej', target: 'monotonic|late.payment|late.delivery', exploratory: true },
  { id: 'symbol-maturity', maturity: 'experimental' },
  { id: 'no-match-not-absence', query: 'quantumBananaSeam', direct: 'quantumBananaSeam', absent: true },
]);

const root = realpathSync(resolve(process.argv[2] ?? '.'));
const cli = join(root, 'node_modules/@openlup/core/dist/agent-context-cli.js');
const scope = join(root, 'node_modules/@openlup');
for (const name of ['core', 'outbox', 'platform']) {
  if (!existsSync(join(scope, name, 'package.json'))) throw new Error(`The frozen matrix requires the selected ${name} artifact; use a full-set consumer`);
}
// Walks each stable subpath's entry file and the files it re-exports with `export *`; a declaration written at the start
// of a line in those files is exported by the subpath. Returns undefined when the installed core has no such symbol.
function experimentalInStableSubpath() {
  const core = join(scope, 'core');
  const surface = JSON.parse(readFileSync(join(core, 'release-gates.json'), 'utf8')).packageSurface;
  const declaration = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*\nexport declare (?:function|const|class|interface|type|enum|namespace) ([A-Za-z_$][\w$]*)/gu;
  for (const subpath of Object.keys(surface).sort()) {
    if (surface[subpath].maturity !== 'stable' || typeof surface[subpath].entrypoint !== 'string') continue;
    const queue = [join(core, surface[subpath].entrypoint)];
    const seen = new Set();
    while (queue.length) {
      const file = queue.shift();
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(declaration)) {
        if (/(?:^|\s)@experimental(?![\w$-])/u.test(match[1])) return { subpath, symbol: match[2] };
      }
      for (const match of text.matchAll(/^export (?:type )?\* from ["'](\.[^"']+)["']/gmu)) {
        queue.push(resolve(file, '..', match[1].replace(/\.js$/u, '.d.ts')));
      }
    }
  }
}
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

const results = [];
for (const row of tasks) {
  let task = row;
  if (row.maturity) {
    const found = experimentalInStableSubpath();
    if (!found) {
      results.push({ id: row.id, query: null, exploratory: false, pass: true, skipped: 'the installed core declares no experimental symbol inside a stable subpath' });
      continue;
    }
    // The target matches the package.json line that an export hit for the subpath cites.
    task = { ...row, query: found.symbol, direct: found.symbol, target: `"${escapeRegExp(found.subpath)}"`, packageName: '@openlup/core', subpath: found.subpath };
  }
  const start = performance.now();
  const run = spawnSync(process.execPath, [cli, 'search', task.query, '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 8_000_000 });
  const cliMs = performance.now() - start;
  if (run.status !== 0) throw new Error(`${task.id}: CLI refused: ${run.stderr}`);
  const output = JSON.parse(run.stdout);
  const target = task.target && new RegExp(task.target, 'iu');
  const guide = task.guide && join(scope, 'core/docs/guide', task.guide);
  let readable = true;
  let relevant = 0;
  for (const hit of output.hits) {
    const lines = readFileSync(hit.file, 'utf8').split('\n');
    readable &&= Number.isInteger(hit.start) && Number.isInteger(hit.end) && hit.start >= 1 && hit.end >= hit.start && hit.end <= lines.length;
    if ((!task.packageName || task.packageName === hit.packageName)
      && (!guide || hit.packageName === '@openlup/core' && hit.file === guide)
      && target?.test(lines.slice(hit.start - 1, hit.end).join('\n'))) relevant++;
  }
  const directStart = performance.now();
  // A single manually selected rg expression per task over the same installed bytes.
  // This is an observable search comparator, not equal-budget autonomous agent work.
  const direct = spawnSync('rg', ['--no-heading', '--line-number', '--glob', '*.md', '--glob', '*.d.ts', '--glob', 'package.json', '--', task.direct, scope], { encoding: 'utf8', maxBuffer: 8_000_000 });
  const directMs = performance.now() - directStart;
  if (direct.status !== 0 && direct.status !== 1) throw new Error(`${task.id}: rg failed: ${direct.stderr}`);
  const directLines = direct.stdout.trim() ? direct.stdout.trim().split('\n') : [];
  const topDirect = directLines.slice(0, 8);
  const directRelevant = target ? topDirect.filter((line) => {
    if (!guide) return target.test(line);
    const prefix = `${guide}:`;
    if (!line.startsWith(prefix)) return false;
    const heading = /^\d+:(.*)$/u.exec(line.slice(prefix.length))?.[1];
    return heading !== undefined && target.test(heading);
  }).length : 0;
  // Some declared public export hit for the symbol reports the declared maturity.
  const maturityHit = task.maturity && output.hits.find((hit) => hit.reason === 'declared public export' && hit.title.endsWith(`(${task.query})`) && hit.maturity === task.maturity);
  const pass = readable && (task.absent ? output.hits.length === 0 : relevant > 0)
    && (!guide || directRelevant > 0) && (!task.maturity || Boolean(maturityHit));
  results.push({ id: task.id, query: task.query, exploratory: task.exploratory ?? false, pass, ...(task.maturity ? { maturity: { subpath: task.subpath, expected: task.maturity, reported: output.hits.find((hit) => hit.reason === 'declared public export' && hit.title.endsWith(`(${task.query})`))?.maturity ?? null } } : {}), cli: { ms: +cliMs.toFixed(2), hits: output.hits.length, readable, targetHitFraction: `${relevant}/${output.hits.length}`, citations: output.hits.map(({file,start,end}) => `${file}:${start}-${end}`) }, direct: { ms: +directMs.toFixed(2), matchingLines: directLines.length, firstEightTargetFraction: `${directRelevant}/${topDirect.length}`, expression: task.direct } });
}
console.log(JSON.stringify({ root, node: process.version, limits: ['Static source-target smoke checks; no agent completion/correctness claim.', 'One cold process per CLI query; OS caches are uncontrolled, one sample only.', 'rg uses frozen human-selected expressions and all packed Markdown/declarations; CLI selects its own narrower corpus.', 'Target-hit fractions measure textual relevance, not semantic precision or invariant comprehension.', 'Freeform Polish is exploratory; no translation capability is assumed.', 'An empty result proves no indexed match, never absence of a public seam.'], results }, null, 2));
if (results.some((result) => !result.exploratory && !result.pass)) process.exitCode = 1;
