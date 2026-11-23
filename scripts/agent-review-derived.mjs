// Closed derived carriers. Candidate source is data, never executable tooling.
import { createHash } from 'node:crypto';
import { readRegistry, REGISTRY_PATHS, strictRegistryJson } from './agent-review-registry.mjs';
export const INVENTORY_PATH = 'tests/postgres/current-installation-inventory.json';
export const MIGRATION_REGISTRIES = ['config/platform-migration-manifest.json', 'config/reviewed-platform-forwards.json'];
const PLAIN_PLATFORM_FORWARD = /^db\/platform\/migrations\/(\d{14})_([A-Za-z0-9_-]+)\.sql$/u;
const check = (ok, reason) => { if (!ok) throw new Error(`derived: ${reason}`); };
const json = value => JSON.stringify(value);
const compareCodePoint = (a, b) => a < b ? -1 : a > b ? 1 : 0;

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
  const leftAdditions = left.slice(base.length);
  const leftSerialized = new Set(leftAdditions.map(json));
  const additions = [...leftAdditions, ...right.slice(base.length).filter(row => !leftSerialized.has(json(row)))];
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

function formatUtcSlot(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** Advance a valid 14-digit UTC migration slot by exactly +1 second with calendar carry. */
export function nextUtcMigrationSlot(afterSlot) {
  check(typeof afterSlot === 'string' && /^\d{14}$/u.test(afterSlot), 'invalid UTC migration slot');
  const year = Number(afterSlot.slice(0, 4));
  const month = Number(afterSlot.slice(4, 6));
  const day = Number(afterSlot.slice(6, 8));
  const hour = Number(afterSlot.slice(8, 10));
  const minute = Number(afterSlot.slice(10, 12));
  const second = Number(afterSlot.slice(12, 14));
  const current = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  check(!Number.isNaN(current.getTime()) && formatUtcSlot(current) === afterSlot, 'non-calendar UTC migration slot');
  const next = new Date(Date.UTC(year, month - 1, day, hour, minute, second + 1));
  const formatted = formatUtcSlot(next);
  check(/^\d{14}$/u.test(formatted) && formatted > afterSlot, 'UTC slot overflow');
  return formatted;
}

/**
 * Deterministically allocate strictly later UTC slots for PR-added plain platform forwards
 * that collide with or precede `main`'s highest migration slot. Returns `[]` when no
 * relocation is needed. Fails closed on non-plain/qualified/supabase additions or collisions.
 */
export function planRelocatedSlots(prAddedPaths, mainMigrationPaths, allExistingPaths = []) {
  const mainSet = new Set(mainMigrationPaths);
  const existing = new Set([...mainMigrationPaths, ...allExistingPaths]);
  let maxMainSlot = '';
  for (const path of mainMigrationPaths) {
    const match = PLAIN_PLATFORM_FORWARD.exec(path);
    if (match && match[1] > maxMainSlot) maxMainSlot = match[1];
  }
  check(maxMainSlot.length === 14, 'main migration slot ceiling unavailable');
  const parsed = prAddedPaths.map(path => {
    const match = PLAIN_PLATFORM_FORWARD.exec(path);
    check(match, 'relocation supports only plain db/platform/migrations/<14digits>_<slug>.sql forwards');
    check(!mainSet.has(path), 'relocation refused: exact migration filename already exists on origin/main');
    return { path, slot: match[1], slug: match[2], basename: `${match[1]}_${match[2]}.sql` };
  });
  parsed.sort((a, b) => compareCodePoint(a.slot, b.slot) || compareCodePoint(a.path, b.path));
  for (let index = 1; index < parsed.length; index++) {
    check(parsed[index].slot > parsed[index - 1].slot, 'duplicate or non-increasing PR migration slots');
  }
  if (parsed.every(item => item.slot > maxMainSlot)) return [];
  let cursor = maxMainSlot;
  const relocations = [];
  for (const item of parsed) {
    if (item.slot <= cursor) {
      const newSlot = nextUtcMigrationSlot(cursor);
      const newBasename = `${newSlot}_${item.slug}.sql`;
      const newPath = `db/platform/migrations/${newBasename}`;
      const oldMirror = `packages/platform/sql/${item.basename}`;
      const newMirror = `packages/platform/sql/${newBasename}`;
      check(!existing.has(newPath) && !existing.has(newMirror), 'allocated relocation target already exists');
      existing.add(newPath);
      existing.add(newMirror);
      relocations.push({
        oldPath: item.path,
        newPath,
        oldMirror,
        newMirror,
        oldSlot: item.slot,
        newSlot,
        oldBasename: item.basename,
        newBasename,
      });
      cursor = newSlot;
    } else {
      cursor = item.slot;
    }
  }
  return relocations;
}

const CLOSED_SLOT_KEYS = new Set(['row', 'path', 'replacedFunctions', 'createdFunctions']);

/** Strict top-level SQL splitter matching PostgreSQL comments, quotes and dollar bodies. */
export function splitSqlStatements(sql) {
  check(typeof sql === 'string', 'SQL text must be a string');
  const statements = [];
  let start = -1;
  for (let index = 0; index < sql.length;) {
    const ch = sql[index];
    if (/\s/u.test(ch)) { index++; continue; }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) { depth++; index += 2; }
        else if (sql.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      check(depth === 0, 'unterminated SQL block comment');
      continue;
    }
    check(sql.charCodeAt(index) <= 0x7f, 'non-ASCII character outside SQL literals or comments');
    if (start < 0) start = index;
    if (ch === "'" || ch === '"') {
      index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '\\') { index += 2; continue; }
        if (sql[index++] === ch) {
          if (sql[index] === ch) { index++; continue; }
          closed = true;
          break;
        }
      }
      check(closed, 'unterminated SQL quoted literal or identifier');
      continue;
    }
    if (ch === '$' && !/[A-Za-z0-9_$]/u.test(sql[index - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        check(end >= 0, 'unterminated SQL dollar-quoted body');
        index = end + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      const body = sql.slice(start, index).trim();
      if (body) statements.push(body);
      start = -1;
      index++;
      continue;
    }
    index++;
  }
  if (start >= 0) {
    const trailing = sql.slice(start).trim();
    if (trailing) statements.push(trailing);
  }
  return statements;
}

// The relocation proof recognizes complete statements only. Identifiers in this
// grammar are unquoted and fully qualified in public, so every table operand has
// one canonical PostgreSQL identity. Other SQL takes the reviewed resolution path.
const CLOSED_IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const CLOSED_RELATION = `public\\.(${CLOSED_IDENT})`;
const CLOSED_COLUMN = `${CLOSED_IDENT}\\s+(?:uuid|text|integer|bigint|boolean|numeric|jsonb|bytea|timestamptz)(?:\\s+(?:NOT\\s+NULL|PRIMARY\\s+KEY))?`;
const CLOSED_CREATE_TABLE = new RegExp(`^CREATE\\s+TABLE\\s+${CLOSED_RELATION}\\s*\\(\\s*${CLOSED_COLUMN}(?:\\s*,\\s*${CLOSED_COLUMN})*\\s*\\)$`, 'iu');
const CLOSED_ADD_COLUMN = new RegExp(`^ALTER\\s+TABLE\\s+${CLOSED_RELATION}\\s+ADD\\s+COLUMN\\s+${CLOSED_COLUMN}$`, 'iu');

function emptyFootprint() {
  return {
    rows: new Set(), relations: new Set(), functions: new Set(), roles: new Set(),
    indexes: new Set(), triggers: new Set(), views: new Set(), policies: new Set(), flags: new Set(),
  };
}

/** Parse every admitted statement and record its sole table operand. */
export function extractSqlFootprint(sqlText) {
  const fp = emptyFootprint();
  const statements = splitSqlStatements(sqlText);
  check(statements.length > 0, 'relocation refuses empty SQL');
  for (const statement of statements) {
    if (/^SELECT\s+1$/iu.test(statement)) continue;
    const match = CLOSED_CREATE_TABLE.exec(statement) ?? CLOSED_ADD_COLUMN.exec(statement);
    check(match, 'relocation refuses SQL outside closed table grammar');
    // A successful grammar match has exactly one captured relation operand.
    check(typeof match[1] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(match[1]),
      'relocation refuses unrecognized relation operand');
    fp.relations.add(`public.${match[1].toLowerCase()}`);
  }
  return fp;
}

/** Only metadata with no hidden object operands is eligible for relocation. */
export function extractSlotMetadataFootprint(slot) {
  check(slot && typeof slot === 'object' && !Array.isArray(slot), 'invalid nativeStoreForwardClass slot');
  check(Object.keys(slot).every(key => CLOSED_SLOT_KEYS.has(key)),
    'relocation refuses unsupported NativeStoreSlot metadata');
  check(typeof slot.row === 'string' && slot.row.length > 0 &&
    typeof slot.path === 'string' && PLAIN_PLATFORM_FORWARD.test(slot.path) &&
    Array.isArray(slot.replacedFunctions) && slot.replacedFunctions.length === 0 &&
    Array.isArray(slot.createdFunctions) && slot.createdFunctions.length === 0,
  'relocation refuses nonempty or malformed NativeStoreSlot metadata');
  const fp = emptyFootprint();
  fp.rows.add(slot.row);
  return fp;
}

function mergeFootprints(items) {
  const merged = emptyFootprint();
  for (const item of items) {
    for (const field of Object.keys(merged)) {
      for (const value of item[field]) merged[field].add(value);
    }
  }
  return merged;
}

/** Verify complete disjointness between PR and main migrations (metadata + SQL statements). */
export function assertDisjointRelocationFootprints(prSlots, mainSlots, prSqlTexts, mainSqlTexts) {
  const prFootprint = mergeFootprints([
    ...prSlots.map(extractSlotMetadataFootprint),
    ...prSqlTexts.map(extractSqlFootprint),
  ]);
  const mainFootprint = mergeFootprints([
    ...mainSlots.map(extractSlotMetadataFootprint),
    ...mainSqlTexts.map(extractSqlFootprint),
  ]);
  for (const field of Object.keys(prFootprint)) {
    for (const value of prFootprint[field]) {
      check(!mainFootprint[field].has(value), `relocation refused: overlapping ${field} footprint (${value})`);
    }
  }
}

/** Barrier 3: no PR-changed non-carrier file or PR SQL file may hardcode an old basename or timestamp. */
export function assertNoStaleRelocationRefs(relocations, filesByPath) {
  for (const { oldBasename, oldSlot } of relocations) {
    for (const [path, content] of filesByPath) {
      check(typeof content === 'string', `relocation refused: binary or unreadable file ${path}`);
      check(!content.includes(oldBasename) && !content.includes(oldSlot), `relocation refused: stale migration reference in ${path}`);
    }
  }
}

/** Rewrite PR's copy of a migration registry by substituting relocated paths before unioning. */
export function rewriteMigrationRegistryForRelocation(path, leftSource, relocations) {
  check(MIGRATION_REGISTRIES.includes(path), 'unknown migration registry');
  const map = new Map(relocations.map(item => [item.oldPath, item.newPath]));
  const parsed = strictRegistryJson(leftSource);
  if (path === MIGRATION_REGISTRIES[0]) {
    for (const plan of [parsed, parsed.qualified, parsed.qualifiedAdmin]) {
      for (const row of plan.forward) {
        if (map.has(row.file)) row.file = map.get(row.file);
      }
    }
    return JSON.stringify(parsed, null, 2) + '\n';
  }
  // reviewed-platform-forwards.json: relocated paths may appear ONLY in nativeStoreForwards and nativeStoreForwardClass.slots.
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'nativeStoreForwards' && Array.isArray(value)) {
      for (const row of value) {
        if (map.has(row.path)) row.path = map.get(row.path);
      }
    } else if (key === 'nativeStoreForwardClass' && value && Array.isArray(value.slots)) {
      for (const slot of value.slots) {
        if (map.has(slot.path)) slot.path = map.get(slot.path);
      }
    } else if (Array.isArray(value)) {
      for (const row of value) {
        check(!map.has(row?.path), `relocation refused: migration registered outside nativeStoreForwards (${key})`);
      }
    }
  }
  return JSON.stringify(parsed, null, 2) + '\n';
}

/** Rewrite PR's copy of config/openlup-publication-catalog.json substituting relocated SQL + mirror paths. */
export function rewriteCatalogForRelocation(leftSource, relocations) {
  const parsed = readRegistry(REGISTRY_PATHS[0], leftSource);
  const map = new Map();
  for (const item of relocations) {
    map.set(item.oldPath, item.newPath);
    map.set(item.oldMirror, item.newMirror);
  }
  const rewritten = parsed.lists[0].map(row => map.has(row.path) ? { path: map.get(row.path), class: row.class } : row);
  rewritten.sort((a, b) => compareCodePoint(a.path, b.path));
  const [start, end] = parsed.ranges[0];
  const replacement = JSON.stringify(rewritten, null, 2).replaceAll('\n', '\n  ');
  const output = leftSource.slice(0, start) + replacement + leftSource.slice(end);
  readRegistry(REGISTRY_PATHS[0], output);
  return output;
}

const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');

function assertClosedForwardRow(row, path, sqlText) {
  check(row && typeof row === 'object' && !Array.isArray(row) &&
    Object.keys(row).sort().join(',') === 'functions,path,sha256' &&
    row.path === path && row.sha256 === sha256Hex(sqlText) &&
    Array.isArray(row.functions) && row.functions.length === 0,
  `relocation refused: nonempty or malformed native forward metadata for ${path}`);
}

/**
 * Shared fail-closed Barriers 1, 3, and 4 validator used by both `landingMerge --relocate-slots`
 * (pre-merge fail-fast) and `proveReviewIntegration` (`derived-relocated` proof).
 */
export function validateRelocationPlan({
  baseForwardsSource,
  headForwardsSource,
  mainForwardsSource,
  prSqlAdded,
  prSqlModifiedOrDeleted,
  mainSqlAdded,
  mainSqlModifiedOrDeleted,
  mainAllMigrationPaths,
  allExistingPaths,
  prSqlBlobsByPath,
  prMirrorBlobsByPath,
  mainSqlBlobsByPath,
  prNonCarrierFilesByPath,
}) {
  check(prSqlModifiedOrDeleted.length === 0, 'relocation refused: PR modifies or deletes existing SQL');
  check(mainSqlModifiedOrDeleted.length === 0, 'relocation refused: main modified or deleted existing SQL');
  const prRailAdditions = prSqlAdded.filter(path => !path.startsWith('packages/platform/sql/'));
  if (prRailAdditions.length === 0) return [];
  const relocations = planRelocatedSlots(prRailAdditions, mainAllMigrationPaths, allExistingPaths);
  if (relocations.length === 0) return [];

  const [baseForwards, headForwards, mainForwards] = [baseForwardsSource, headForwardsSource, mainForwardsSource].map(strictRegistryJson);
  const baseSlotCount = baseForwards.nativeStoreForwardClass?.slots?.length ?? 0;
  const headAddedSlots = (headForwards.nativeStoreForwardClass?.slots ?? []).slice(baseSlotCount);
  const mainAddedSlots = (mainForwards.nativeStoreForwardClass?.slots ?? []).slice(baseSlotCount);
  const headForwardRows = new Map((headForwards.nativeStoreForwards ?? []).map(row => [row.path, row]));
  const mainForwardRows = new Map((mainForwards.nativeStoreForwards ?? []).map(row => [row.path, row]));
  const headSlotByPath = new Map(headAddedSlots.map(slot => [slot.path, slot]));
  const mainSlotByPath = new Map(mainAddedSlots.map(slot => [slot.path, slot]));

  // Barrier 1: every PR addition must be a nativeStoreForwardClass slot with byte-identical mirror.
  const prSlots = [];
  const prSqlTexts = [];
  for (const path of prRailAdditions) {
    const match = PLAIN_PLATFORM_FORWARD.exec(path);
    check(match, `relocation refused: PR migration ${path} is not a plain platform forward`);
    const mirrorPath = `packages/platform/sql/${match[1]}_${match[2]}.sql`;
    const slot = headSlotByPath.get(path);
    const forwardRow = headForwardRows.get(path);
    const sqlText = prSqlBlobsByPath.get(path);
    const mirrorText = prMirrorBlobsByPath.get(mirrorPath);
    check(slot && forwardRow, `relocation refused: PR migration ${path} is not a nativeStoreForwardClass slot`);
    check(typeof sqlText === 'string' && typeof mirrorText === 'string', `relocation refused: missing SQL or mirror for ${path}`);
    assertClosedForwardRow(forwardRow, path, sqlText);
    check(mirrorText === sqlText, `relocation refused: SQL/mirror bytes differ for ${path}`);
    prSlots.push(slot);
    prSqlTexts.push(sqlText);
  }
  // Ensure PR added no unmirrored or stray packages/platform/sql/ files beyond relocated mirrors.
  const expectedPrMirrors = new Set(prRailAdditions.map(path => `packages/platform/sql/${path.slice('db/platform/migrations/'.length)}`));
  for (const path of prSqlAdded) {
    if (path.startsWith('packages/platform/sql/')) {
      check(expectedPrMirrors.has(path), `relocation refused: unexpected PR mirror SQL ${path}`);
    }
  }

  // Barrier 1 (main side): every SQL added on main must be a plain nativeStoreForwardClass forward + its mirror.
  const mainRailAdditions = mainSqlAdded.filter(path => !path.startsWith('packages/platform/sql/'));
  const mainSlots = [];
  const mainSqlTexts = [];
  const expectedMainMirrors = new Set();
  for (const path of mainRailAdditions) {
    const match = PLAIN_PLATFORM_FORWARD.exec(path);
    check(match, `relocation refused: main added non-plain SQL ${path}`);
    const slot = mainSlotByPath.get(path);
    const sqlText = mainSqlBlobsByPath.get(path);
    const mirrorPath = `packages/platform/sql/${match[1]}_${match[2]}.sql`;
    const mirrorText = mainSqlBlobsByPath.get(mirrorPath);
    check(slot && typeof sqlText === 'string' && typeof mirrorText === 'string',
      `relocation refused: main SQL ${path} lacks a nativeStoreForwardClass slot or mirror`);
    assertClosedForwardRow(mainForwardRows.get(path), path, sqlText);
    check(mirrorText === sqlText, `relocation refused: main SQL/mirror bytes differ for ${path}`);
    expectedMainMirrors.add(mirrorPath);
    mainSlots.push(slot);
    mainSqlTexts.push(sqlText);
  }
  for (const path of mainSqlAdded) {
    if (path.startsWith('packages/platform/sql/')) {
      check(expectedMainMirrors.has(path), `relocation refused: main added unmatched mirror SQL ${path}`);
    }
  }

  // Barrier 3: zero stale filename/timestamp references in PR non-carrier files or PR SQL itself.
  assertNoStaleRelocationRefs(relocations, [...prNonCarrierFilesByPath, ...prSqlBlobsByPath]);

  // Barrier 4: complete metadata + SQL statement footprint disjointness.
  assertDisjointRelocationFootprints(prSlots, mainSlots, prSqlTexts, mainSqlTexts);

  return relocations;
}
