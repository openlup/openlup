// Closed derived carriers. Candidate source is data, never executable tooling.
import { strictRegistryJson } from './agent-review-registry.mjs';
export const INVENTORY_PATH = 'tests/postgres/current-installation-inventory.json';
export const MIGRATION_REGISTRIES = ['config/platform-migration-manifest.json', 'config/reviewed-platform-forwards.json'];
const check = (ok, reason) => { if (!ok) throw new Error(`derived: ${reason}`); };
const json = value => JSON.stringify(value);

export function inventoryEnvelope(source) {
  const value = strictRegistryJson(source);
  check(Object.keys(value).sort().join(',') === 'current,historical', 'inventory sections differ');
  // Locate the top-level current value after validating the complete JSON grammar.
  let depth = 0, quoted = false, escaped = false, start = -1, end = -1;
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') {
      if (depth === 1) {
        const match = /^"current"\s*:\s*/u.exec(source.slice(at));
        if (match) { start = at + match[0].length; at = start - 1; continue; }
      }
      quoted = true;
    } else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--; if (start >= 0 && end < 0 && depth === 1) end = at + 1;
    }
  }
  check(start >= 0 && end > start && value.current && typeof value.current === 'object' && !Array.isArray(value.current), 'invalid current inventory');
  return { value, before: source.slice(0, start), after: source.slice(end) };
}
export function inventoryOnlyCurrent(base, left, right, committed) {
  try {
    const envelopes = [base, left, right, committed].map(inventoryEnvelope);
    return envelopes.every(item => item.before === envelopes[0].before && item.after === envelopes[0].after) &&
      json(envelopes[3].value.current) !== json(envelopes[1].value.current);
  } catch { return false; }
}
const at = (object, path) => path.reduce((value, part) => value[part], object);
function unionRows(base, left, right) {
  const key = row => row.file ?? row.path;
  const slot = row => /(?:^|\/)((?:[a-z][a-z0-9]*_)?\d{14})_[A-Za-z0-9_-]+\.sql$/u.exec(key(row) ?? '')?.[1];
  const validate = rows => {
    check(Array.isArray(rows), 'registry array missing');
    check(rows.every(row => row && typeof row === 'object' && slot(row)), 'invalid registry slot');
    check(new Set(rows.map(key)).size === rows.length, 'duplicate entry');
  };
  [base, left, right].forEach(validate);
  for (const side of [left, right]) check(base.every((row, index) => json(row) === json(side[index])), 'edited existing entry');
  const additions = [...left.slice(base.length), ...right.slice(base.length)];
  validate([...base, ...additions]);
  const slots = new Set(base.map(slot));
  for (const row of additions) { check(!slots.has(slot(row)), 'duplicate slot'); slots.add(slot(row)); }
  additions.sort((a, b) => slot(a).localeCompare(slot(b)));
  return [...base, ...additions];
}
export function migrationRegistryUnion(path, baseSource, leftSource, rightSource, inventorySource) {
  check(MIGRATION_REGISTRIES.includes(path), 'unknown registry');
  const [base, left, right] = [baseSource, leftSource, rightSource].map(strictRegistryJson);
  const result = structuredClone(base);
  const arrays = path === MIGRATION_REGISTRIES[0] ? [['forward'], ['qualified', 'forward'], ['qualifiedAdmin', 'forward']]
    : Object.keys(base).filter(key => Array.isArray(base[key])).map(key => [key]).concat([['nativeStoreForwardClass', 'slots']]);
  const mask = value => {
    const copy = structuredClone(value);
    for (const parts of arrays) at(copy, parts.slice(0, -1))[parts.at(-1)] = null;
    if (path === MIGRATION_REGISTRIES[0]) for (const plan of [copy, copy.qualified, copy.qualifiedAdmin]) plan.objectInventorySha256 = null;
    return copy;
  };
  check(json(mask(base)) === json(mask(left)) && json(mask(base)) === json(mask(right)), 'edited registry outside entries');
  for (const parts of arrays) at(result, parts.slice(0, -1))[parts.at(-1)] = unionRows(at(base, parts), at(left, parts), at(right, parts));
  if (path === MIGRATION_REGISTRIES[0]) {
    check(inventorySource, 'measured inventory required');
    const profiles = inventoryEnvelope(inventorySource).value.current.profiles;
    const hash = name => { const value = profiles[name].objectInventorySha256; check(/^[a-f0-9]{64}$/u.test(value), 'invalid inventory digest'); return value; };
    result.objectInventorySha256 = hash('legacy');
    result.qualified.objectInventorySha256 = { bootstrapMigrator: { withRestore: hash('bootstrap') }, separateMigrator: { withRestore: hash('separate') } };
    result.qualifiedAdmin.objectInventorySha256 = { installerManaged: hash('admin-managed'), operatorProvisioned: hash('admin-operator') };
  }
  return JSON.stringify(result, null, 2) + '\n';
}
