// Frozen static query smoke matrix, 2026-10-29. This is not an agent-outcome benchmark.
// Usage: node scripts/agent-context/evaluate.mjs /absolute/cold-consumer-root
// Reads installed artifacts only. No writes, network, package installation or dependencies.
import { existsSync, readFileSync } from 'node:fs';
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
  { id: 'polish-with-symbol', query: 'Gdzie jest nextRetryAttemptAt i retry?', direct: 'nextRetryAttemptAt|retry', target: 'nextRetryAttemptAt' },
  { id: 'polish-freeform', query: 'Czy opóźniona dostawa przesuwa kolejny cykl wcześniej?', direct: 'opóźniona|dostawa|wcześniej', target: 'monotonic|late.payment|late.delivery', exploratory: true },
  { id: 'no-match-not-absence', query: 'quantumBananaSeam', direct: 'quantumBananaSeam', absent: true },
]);

const root = resolve(process.argv[2] ?? '.');
const cli = join(root, 'node_modules/@openlup/core/dist/agent-context-cli.js');
const scope = join(root, 'node_modules/@openlup');
for (const name of ['core', 'outbox', 'platform']) {
  if (!existsSync(join(scope, name, 'package.json'))) throw new Error(`The frozen matrix requires the selected ${name} artifact; use a full-set consumer`);
}
const results = [];
for (const task of tasks) {
  const start = performance.now();
  const run = spawnSync(process.execPath, [cli, 'search', task.query, '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 8_000_000 });
  const cliMs = performance.now() - start;
  if (run.status !== 0) throw new Error(`${task.id}: CLI refused: ${run.stderr}`);
  const output = JSON.parse(run.stdout);
  let readable = true;
  let relevant = 0;
  for (const hit of output.hits) {
    const lines = readFileSync(hit.file, 'utf8').split('\n');
    readable &&= Number.isInteger(hit.start) && Number.isInteger(hit.end) && hit.start >= 1 && hit.end >= hit.start && hit.end <= lines.length;
    if ((!task.packageName || task.packageName === hit.packageName) && task.target && new RegExp(task.target, 'iu').test(lines.slice(hit.start - 1, hit.end).join('\n'))) relevant++;
  }
  const directStart = performance.now();
  // A single manually selected rg expression per task over the same installed bytes.
  // This is an observable search comparator, not equal-budget autonomous agent work.
  const direct = spawnSync('rg', ['--no-heading', '--line-number', '--glob', '*.md', '--glob', '*.d.ts', '--glob', 'package.json', '--', task.direct, scope], { encoding: 'utf8', maxBuffer: 8_000_000 });
  const directMs = performance.now() - directStart;
  if (direct.status !== 0 && direct.status !== 1) throw new Error(`${task.id}: rg failed: ${direct.stderr}`);
  const directLines = direct.stdout.trim() ? direct.stdout.trim().split('\n') : [];
  const topDirect = directLines.slice(0, 8);
  const directRelevant = task.target ? topDirect.filter((line) => new RegExp(task.target, 'iu').test(line)).length : 0;
  const pass = readable && (task.absent ? output.hits.length === 0 : relevant > 0);
  results.push({ id: task.id, query: task.query, exploratory: task.exploratory ?? false, pass, cli: { ms: +cliMs.toFixed(2), hits: output.hits.length, readable, targetHitFraction: `${relevant}/${output.hits.length}`, citations: output.hits.map(({file,start,end}) => `${file}:${start}-${end}`) }, direct: { ms: +directMs.toFixed(2), matchingLines: directLines.length, firstEightTargetFraction: `${directRelevant}/${topDirect.length}`, expression: task.direct } });
}
console.log(JSON.stringify({ root, node: process.version, limits: ['Static source-target smoke checks; no agent completion/correctness claim.', 'One cold process per CLI query; OS caches are uncontrolled, one sample only.', 'rg uses frozen human-selected expressions and all packed Markdown/declarations; CLI selects its own narrower corpus.', 'Target-hit fractions measure textual relevance, not semantic precision or invariant comprehension.', 'Freeform Polish is exploratory; no translation capability is assumed.', 'An empty result proves no indexed match, never absence of a public seam.'], results }, null, 2));
if (results.some((result) => !result.exploratory && !result.pass)) process.exitCode = 1;
