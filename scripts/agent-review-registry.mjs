// Closed registry syntax and exact insertion-only unions. Candidate code is data.
export const REGISTRY_PATHS = [
  'config/openlup-publication-catalog.json',
  'packages/platform/test/packageBoundary.test.ts',
  'scripts/packages/platform-cold-consumer.ts',
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
function gaps(base, side) {
  const result = Array.from({ length: base.length + 1 }, () => []); let cursor = 0;
  for (const value of side) {
    if (cursor < base.length && key(value) === key(base[cursor])) {
      check(JSON.stringify(value) === JSON.stringify(base[cursor]), 'changed base entry'); cursor++;
    } else {
      check(!base.some(old => key(old) === key(value)), 'removed or reordered base entry'); result[cursor].push(value);
    }
  }
  check(cursor === base.length, 'removed base entry'); return result;
}
export function registryUnion(path, baseSource, leftSource, rightSource) {
  const [base, left, right] = [baseSource, leftSource, rightSource].map(source => readRegistry(path, source));
  check(base.outside === left.outside && base.outside === right.outside, 'changed carrier outside named arrays');
  const allLeft = new Set(); const allRight = new Set();
  const unions = base.lists.map((entries, index) => {
    const a = gaps(entries, left.lists[index]); const b = gaps(entries, right.lists[index]);
    a.flat().forEach(value => allLeft.add(key(value))); b.flat().forEach(value => allRight.add(key(value)));
    const result = [];
    for (let gap = 0; gap <= entries.length; gap++) {
      const x = [...a[gap]], y = [...b[gap]];
      while (x.length || y.length) result.push(!y.length || (x.length && compare(key(x[0]), key(y[0])) < 0) ? x.shift() : y.shift());
      if (gap < entries.length) result.push(entries[gap]);
    }
    validEntries(result); return result;
  });
  check(![...allLeft].some(value => allRight.has(value)), 'overlapping additions');
  let result = base.source;
  for (const { range: [start, end], index } of base.ranges.map((range, index) => ({ range, index })).sort((a, b) => b.range[0] - a.range[0])) {
    const original = base.source.slice(start, end); const values = unions[index];
    const replacement = path === REGISTRY_PATHS[0] ? JSON.stringify(values, null, 2).replaceAll('\n', '\n  ')
      : original.includes('\n') ? `[\n${values.map(value => `  ${JSON.stringify(value)},`).join('\n')}\n]` : `[${values.map(value => JSON.stringify(value)).join(', ')}]`;
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  readRegistry(path, result); return result;
}
