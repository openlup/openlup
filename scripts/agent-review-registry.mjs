// Closed registry syntax and exact three-way unions. Candidate code is data.
export const REGISTRY_PATHS = [
  'config/openlup-publication-catalog.json',
  'packages/platform/test/packageBoundary.test.ts',
  'scripts/packages/platform-cold-consumer.ts',
  'config/vitest-shard-weights.json',
  'config/ci-postgres-suite-closures.json',
];
export const SHARD_WEIGHTS_PATH = REGISTRY_PATHS[3];
export const PG_SUITE_CLOSURES_PATH = REGISTRY_PATHS[4];
// Review-rule snapshots predate the shard weights and PostgreSQL closures carriers; recorded digests keep their bytes.
export const RULE_SNAPSHOT_REGISTRY_PATHS = REGISTRY_PATHS.slice(0, 3);
export const CONTROL_POSTGRES_SUITES = [
  'tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts',
  'tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts',
  'tests/postgres/reviewedBatchForwards.test.ts',
  'tests/postgres/subscriptionExactInstallation.test.ts',
];
export const PG_CLOSURE_AXES = [
  '@api',
  '@catalogPacks',
  '@dataDoc',
  '@examples',
  '@identityTests',
  '@managedCompat',
  '@mcp',
  '@src',
  '@starter',
];
const refuse = message => { throw new Error(`registry: ${message}`); };
const check = (ok, message) => { if (!ok) refuse(message); };
const key = value => typeof value === 'string' ? value : value.path;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// JSON.parse alone accepts duplicate object keys. Scan the complete JSON grammar
// as well, keeping duplicate detection independent of application validators.
export function strictRegistryJson(source) {
  let at = 0;
  const whitespace = () => { while (/[ \t\r\n]/u.test(source[at] ?? '') && at < source.length) at++; };
  const string = () => {
    const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/u.exec(source.slice(at));
    check(match, 'invalid JSON string'); at += match[0].length; return JSON.parse(match[0]);
  };
  function value() {
    whitespace();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; whitespace(); const result = Object.create(null); const seen = new Set();
      if (source[at] === '}') { at++; return result; }
      while (at < source.length) {
        whitespace(); const name = string(); check(!seen.has(name), 'duplicate JSON key'); seen.add(name);
        whitespace(); check(source[at++] === ':', 'expected colon'); result[name] = value(); whitespace();
        if (source[at] === '}') { at++; return result; }
        check(source[at++] === ',', 'expected object comma');
      }
    } else if (source[at] === '[') {
      at++; whitespace(); const result = [];
      if (source[at] === ']') { at++; return result; }
      while (at < source.length) {
        result.push(value()); whitespace(); if (source[at] === ']') { at++; return result; }
        check(source[at++] === ',', 'expected array comma');
      }
    } else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(at));
      check(match, 'invalid JSON value'); at += match[0].length; return JSON.parse(match[0]);
    }
    refuse('unterminated JSON');
  }
  const parsed = value(); whitespace(); check(at === source.length, 'trailing JSON'); return parsed;
}

function arrayRange(source, start) {
  let depth = 0; let quoted = false; let escaped = false;
  for (let at = start; at < source.length; at++) {
    const char = source[at];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return [start, at + 1];
  }
  refuse('unterminated array');
}
function strings(source) {
  check(/^\[\s*(?:["'][A-Za-z0-9_./-]+["']\s*(?:,\s*["'][A-Za-z0-9_./-]+["']\s*)*,?\s*)?\]$/u.test(source), 'not a flat literal');
  const tokens = [...source.matchAll(/(["'])([A-Za-z0-9_./-]+)\1/gu)].map(match => match[2]);
  // Independently consume every literal: mismatched quotes must not be skipped.
  const residue = source.replace(/(["'])[A-Za-z0-9_./-]+\1/gu, '').replace(/[\s,[\]]/gu, '');
  check(residue === '', 'invalid literal quotes');
  return tokens;
}
function validEntries(entries) {
  const keys = entries.map(key);
  check(new Set(keys).size === keys.length, 'duplicate entry');
  check(keys.every(path => typeof path === 'string' && !/[\\\x00-\x1f\x7f]/u.test(path) && path.normalize('NFC') === path && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || part === '')), 'invalid entry path');
}
export function readRegistry(path, source) {
  check(typeof source === 'string' && Buffer.byteLength(source) <= 1024 * 1024 && !source.includes('\uFFFD') && !source.includes('\0'), 'unreadable or oversized blob');
  if (path === SHARD_WEIGHTS_PATH) return readShardWeights(source);
  if (path === PG_SUITE_CLOSURES_PATH) return readPgSuiteClosures(source);
  const ranges = []; const lists = [];
  if (path === REGISTRY_PATHS[0]) {
    const parsed = strictRegistryJson(source);
    check(parsed.schemaVersion === 3 && Array.isArray(parsed.publicPaths), 'catalog schema');
    const matches = [...source.matchAll(/"publicPaths"\s*:\s*(\[)/gu)]; check(matches.length === 1, 'ambiguous catalog');
    const match = matches[0]; ranges.push(arrayRange(source, match.index + match[0].lastIndexOf('[')));
    check(parsed.publicPaths.every(row => row && Object.keys(row).sort().join(',') === 'class,path' && ['agent-guidance', 'contributor-interface', 'entrypoint', 'platform-documentation', 'policy', 'policy-registry', 'public-output', 'publication-catalog', 'release-contract'].includes(row.class)), 'catalog row');
    check(parsed.publicPaths.every((row, index) => index === 0 || compare(parsed.publicPaths[index - 1].path, row.path) < 0), 'catalog entry order');
    lists.push(parsed.publicPaths);
  } else if (path === REGISTRY_PATHS[1]) {
    check(source.split('it("gives every module its public entry and exactly its declared contracts sub-entry"').length === 2, 'ambiguous boundary test');
    const matches = [...source.matchAll(/assertModuleExports\(modules, graph, manifest\.exports, \(path\) => existsSync\(join\(SOURCE_ROOT, path\)\), (\[[^\]]*\])\);/gu)];
    check(matches.length === 1, 'ambiguous nested entries'); const match = matches[0];
    const start = match.index + match[0].indexOf(match[1]); ranges.push([start, start + match[1].length]); lists.push(strings(match[1]));
    const prefix = source.slice(0, start); check(prefix.lastIndexOf('it("gives every module its public entry and exactly its declared contracts sub-entry"') > prefix.lastIndexOf('  });'), 'nested literal outside named test');
  } else if (path === REGISTRY_PATHS[2]) {
    for (const name of ['NON_ADAPTER_ENTRIES', 'ADAPTER_ENTRIES']) {
      const matches = [...source.matchAll(new RegExp(`^export const ${name} = (\\[[\\s\\S]*?\\]) as const;`, 'gmu'))];
      check(matches.length === 1, 'ambiguous cold entries'); const match = matches[0]; const start = match.index + match[0].indexOf('[');
      ranges.push([start, start + match[1].length]); lists.push(strings(match[1]));
    }
    check(new Set(lists.flat()).size === lists.flat().length, 'entry moved between adapter classes');
  } else refuse('unknown carrier');
  lists.forEach(validEntries);
  // Fixed outer bytes are compared as well as the interpreted lists.
  const order = ranges.map((range, index) => ({ range, index })).sort((a, b) => a.range[0] - b.range[0]);
  let outside = ''; let at = 0;
  for (const { range: [start, end], index } of order) { outside += source.slice(at, start) + `\0${index}\0`; at = end; }
  outside += source.slice(at);
  return { source, outside, ranges, lists };
}
// Shard weights: a closed object of sorted, positive test-file durations in the
// exact bytes JSON.stringify(value, null, 2) writes, plus a trailing newline.
const shardWeightsSource = weights => `${JSON.stringify(weights, null, 2)}\n`;
const positiveWeight = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
function readShardWeights(source) {
  const weights = strictRegistryJson(source);
  check(weights && typeof weights === 'object' && !Array.isArray(weights) &&
    Object.keys(weights).join(',') === 'schemaVersion,defaultDurationMs,durationsMs' && weights.schemaVersion === 1, 'shard weights schema');
  check(positiveWeight(weights.defaultDurationMs), 'shard weights default');
  const durations = weights.durationsMs;
  check(durations && typeof durations === 'object' && !Array.isArray(durations), 'shard weights map');
  const keys = Object.keys(durations);
  check(keys.every((entry, index) => index === 0 || compare(keys[index - 1], entry) < 0), 'shard weights key order');
  check(keys.every(entry => positiveWeight(durations[entry])), 'shard weights value');
  validEntries(keys);
  check(source === shardWeightsSource(weights), 'shard weights formatting');
  return { source, outside: '', ranges: [], lists: [keys], weights };
}
const changedBaseWeight = name => `branch changed a base shard weight: ${name}
Observed. The union stopped.
Cause. The branch changed or removed a value that exists at the merge base; its test timeout changes with it.
Fix. Resolve the carrier manually and obtain resolution review.
Recheck. Run \`node scripts/agent-review-session.mjs status --explain\` on the committed resolution.`;
// Main owns calibration: its values win for base keys and for keys both sides
// added. The branch contributes only keys main lacks and may not edit base weights.
function shardWeightsUnion(baseSource, leftSource, rightSource) {
  const [base, left, right] = [baseSource, leftSource, rightSource].map(source => readShardWeights(source).weights);
  for (const field of ['schemaVersion', 'defaultDurationMs']) check(left[field] === base[field], changedBaseWeight(field));
  const weight = (side, name) => Object.hasOwn(side.durationsMs, name) ? side.durationsMs[name] : undefined;
  const names = new Set([base, left, right].flatMap(side => Object.keys(side.durationsMs)));
  const durationsMs = Object.create(null);
  for (const name of [...names].sort(compare)) {
    const [original, branch, main] = [base, left, right].map(side => weight(side, name));
    if (original !== undefined) check(branch === original, changedBaseWeight(name));
    const value = main ?? (original === undefined ? branch : undefined);
    if (value !== undefined) durationsMs[name] = value;
  }
  const result = shardWeightsSource({ schemaVersion: right.schemaVersion, defaultDurationMs: right.defaultDurationMs, durationsMs });
  readShardWeights(result); return result;
}
// PostgreSQL suite closures: a closed map of sorted non-control suite paths to
// sorted dependency inputs in the exact bytes JSON.stringify(value, null, 2) + '\n' writes.
const pgSuiteClosuresSource = closures => `${JSON.stringify(closures, null, 2)}\n`;
const PG_SUITE_KEY = /^tests\/postgres\/[A-Za-z0-9_./-]+\.test\.ts$/u;
const toSet = (value, fallback) => {
  if (value === undefined) return new Set(fallback);
  if (value instanceof Set) return value;
  return Array.isArray(value) ? new Set(value) : new Set(Object.keys(value));
};
const validPgInputPath = path => {
  if (typeof path !== 'string' || !path || path === 'tests/postgres/' || /[\\\x00-\x1f\x7f]/u.test(path) || path.normalize('NFC') !== path || path.startsWith('/') || path.includes('//')) return false;
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed.length > 0 && !trimmed.split('/').some(part => part === '..' || part === '.' || part === '');
};
export function readPgSuiteClosures(source, {
  controlSuites = CONTROL_POSTGRES_SUITES,
  pendingSuites = [],
  validAxes = PG_CLOSURE_AXES,
} = {}) {
  check(typeof source === 'string' && Buffer.byteLength(source) <= 1024 * 1024 && !source.includes('\uFFFD') && !source.includes('\0'), 'unreadable or oversized blob');
  const closures = strictRegistryJson(source);
  check(closures && typeof closures === 'object' && !Array.isArray(closures) &&
    Object.keys(closures).join(',') === 'schemaVersion,suites' && closures.schemaVersion === 1, 'pg suite closures schema');
  const suites = closures.suites;
  check(suites && typeof suites === 'object' && !Array.isArray(suites), 'pg suite closures map');
  const controlSet = toSet(controlSuites, CONTROL_POSTGRES_SUITES);
  const pendingSet = toSet(pendingSuites, []);
  const axisSet = toSet(validAxes, PG_CLOSURE_AXES);
  const keys = Object.keys(suites);
  check(keys.every((entry, index) => index === 0 || compare(keys[index - 1], entry) < 0), 'pg suite closures key order');
  for (const suite of keys) {
    check(PG_SUITE_KEY.test(suite) && !suite.includes('..') && !suite.includes('//') && !suite.includes('\\') &&
      !suite.split('/').some(part => part === '.' || part === '..' || part === '' || part.startsWith('.')), `pg suite closures invalid suite key: ${suite}`);
    check(!controlSet.has(suite), `pg suite closures control suite collision: ${suite}`);
    check(!pendingSet.has(suite), `pg suite closures pending suite collision: ${suite}`);
    const inputs = suites[suite];
    check(Array.isArray(inputs), `pg suite closures inputs array: ${suite}`);
    check(inputs.every((entry, index) => typeof entry === 'string' && (index === 0 || compare(inputs[index - 1], entry) < 0)), `pg suite closures input order: ${suite}`);
    for (const input of inputs) {
      if (input.startsWith('@')) check(axisSet.has(input), `pg suite closures unknown axis: ${input}`);
      else {
        check(input !== 'tests/postgres/', 'pg suite closures broad tests/postgres/ prefix is not allowed');
        check(validPgInputPath(input), `pg suite closures invalid input: ${input}`);
      }
    }
  }
  check(source === pgSuiteClosuresSource(closures), 'pg suite closures formatting');
  return { source, outside: '', ranges: [], lists: [keys], closures };
}
const changedBaseClosure = name => `branch changed or removed a base PostgreSQL suite closure: ${name}
Observed. The union stopped.
Cause. The branch edited or removed a suite or input that exists at the merge base.
Fix. Resolve the carrier manually and obtain resolution review.
Recheck. Run \`node scripts/agent-review-session.mjs status --explain\` on the committed resolution.`;
const divergentClosureAddition = name => `divergent PostgreSQL suite closure additions: ${name}
Observed. The union stopped.
Cause. Both sides modified or added the same PostgreSQL suite with different inputs.
Fix. Resolve the carrier manually and obtain resolution review.
Recheck. Run \`node scripts/agent-review-session.mjs status --explain\` on the committed resolution.`;
export function pgSuiteClosuresUnion(baseSource, leftSource, rightSource) {
  const [base, left, right] = [baseSource, leftSource, rightSource].map(source => readPgSuiteClosures(source).closures);
  check(left.schemaVersion === base.schemaVersion, changedBaseClosure('schemaVersion'));
  const closure = (side, name) => Object.hasOwn(side.suites, name) ? side.suites[name] : undefined;
  const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  const names = new Set([base, left, right].flatMap(side => Object.keys(side.suites)));
  const suites = Object.create(null);
  for (const name of [...names].sort(compare)) {
    const [original, branch, main] = [base, left, right].map(side => closure(side, name));
    if (original === undefined) {
      if (branch !== undefined && main !== undefined) check(sameList(branch, main), divergentClosureAddition(name));
      const value = main ?? branch;
      if (value !== undefined) suites[name] = value;
      continue;
    }
    check(branch !== undefined && original.every(input => branch.includes(input)), changedBaseClosure(name));
    if (sameList(branch, original)) {
      if (main !== undefined) suites[name] = main;
      continue;
    }
    check(main !== undefined, changedBaseClosure(name));
    if (sameList(main, original) || sameList(main, branch)) {
      suites[name] = branch;
      continue;
    }
    refuse(divergentClosureAddition(name));
  }
  const result = pgSuiteClosuresSource({ schemaVersion: right.schemaVersion, suites });
  readPgSuiteClosures(result); return result;
}
function partitionEntries(basePositions, side, catalogue) {
  const gaps = new Map();
  const retained = new Map();
  let previous = -1;
  let pending = [];
  for (const value of side) {
    const entryKey = key(value);
    const position = basePositions.get(entryKey);
    if (position === undefined) {
      pending.push(value);
      continue;
    }
    check(position > previous, 'removed or reordered base entry');
    previous = position;
    retained.set(entryKey, JSON.stringify(value));
    // Catalogue additions share one slot because their paths determine output order.
    if (!catalogue && pending.length) {
      gaps.set(position, pending);
      pending = [];
    }
  }
  gaps.set(basePositions.size, pending);
  return { gaps, retained };
}
function retainBaseEntry(entry, left, right) {
  const original = JSON.stringify(entry);
  if (left !== undefined && right !== undefined) {
    check(left === original && right === original, 'changed base entry');
    return true;
  }
  check((left ?? right ?? original) === original, `modify/delete conflict
Observed. The union stopped.
Cause. One side removed a base entry and the other edited it.
Fix. Resolve the carrier manually and obtain resolution review.
Recheck. Run \`node scripts/agent-review-session.mjs status --explain\` on the committed resolution.`);
  return false;
}
export function registryUnion(path, baseSource, leftSource, rightSource) {
  if (path === SHARD_WEIGHTS_PATH) return shardWeightsUnion(baseSource, leftSource, rightSource);
  if (path === PG_SUITE_CLOSURES_PATH) return pgSuiteClosuresUnion(baseSource, leftSource, rightSource);
  const [base, left, right] = [baseSource, leftSource, rightSource].map(source => readRegistry(path, source));
  check(base.outside === left.outside && base.outside === right.outside, 'changed carrier outside named arrays');
  const catalogue = path === REGISTRY_PATHS[0];
  const positions = base.lists.map(entries => new Map(entries.map((value, index) => [key(value), index])));
  if (path === REGISTRY_PATHS[2]) {
    for (const side of [left, right]) {
      for (const [index, entries] of side.lists.entries()) {
        check(!entries.some(value => positions[1 - index].has(value)), 'entry moved between adapter classes');
      }
    }
  }
  const allLeft = new Set(); const allRight = new Set();
  const unions = base.lists.map((entries, index) => {
    const a = partitionEntries(positions[index], left.lists[index], catalogue);
    const b = partitionEntries(positions[index], right.lists[index], catalogue);
    const retained = entries.map(entry => retainBaseEntry(entry, a.retained.get(key(entry)), b.retained.get(key(entry))));
    const result = [];
    for (let gap = 0; gap <= entries.length; gap++) {
      const x = [...(a.gaps.get(gap) ?? [])];
      const xByKey = new Map(x.map(value => [key(value), JSON.stringify(value)]));
      const y = [];
      for (const value of b.gaps.get(gap) ?? []) {
        const entryKey = key(value);
        if (xByKey.has(entryKey)) {
          check(xByKey.get(entryKey) === JSON.stringify(value), 'overlapping additions');
          continue;
        }
        y.push(value);
      }
      x.forEach(value => allLeft.add(key(value)));
      y.forEach(value => allRight.add(key(value)));
      while (x.length || y.length) result.push(!y.length || (x.length && compare(key(x[0]), key(y[0])) < 0) ? x.shift() : y.shift());
      if (retained[gap]) result.push(entries[gap]);
    }
    if (catalogue) result.sort((left, right) => compare(key(left), key(right)));
    return result;
  });
  check(![...allLeft].some(value => allRight.has(value)), 'overlapping additions');
  unions.forEach(validEntries);
  let result = base.source;
  for (const { range: [start, end], index } of base.ranges.map((range, index) => ({ range, index })).sort((a, b) => b.range[0] - a.range[0])) {
    const original = base.source.slice(start, end); const values = unions[index];
    const replacement = catalogue ? JSON.stringify(values, null, 2).replaceAll('\n', '\n  ')
      : original.includes('\n') ? `[\n${values.map(value => `  ${JSON.stringify(value)},`).join('\n')}\n]` : `[${values.map(value => JSON.stringify(value)).join(', ')}]`;
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  readRegistry(path, result); return result;
}
