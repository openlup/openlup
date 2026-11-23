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

const KNOWN_NATIVE_STORE_SLOT_KEYS = new Set([
  'row',
  'path',
  'replacedFunctions',
  'createdFunctions',
  'grantOnlyFunctions',
  'dataStatements',
  'settingsOnlyFunctions',
  'qualifiedCatalogueStorageSelect',
  'qualifiedPriceListBasisSelect',
  'qualifiedPriceSetupExecute',
  'ownerWindowRole',
  'insertSelectTables',
  'absorptionCensusTables',
  'existingTableStatements',
  'checkSupersets',
  'uniqueSupersets',
  'droppedIndexes',
  'createdViews',
  'createdTriggers',
  'purposeCheck',
  'previewNoopAcceptance',
]);

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

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);
const IGNORED_IDENTIFIERS = new Set([
  'select', 'where', 'set', 'values', 'default', 'null', 'true', 'false', 'and', 'or', 'not',
  'as', 'in', 'is', 'on', 'using', 'only', 'if', 'exists', 'cascade', 'restrict', 'public',
  'table', 'index', 'view', 'trigger', 'policy', 'function', 'procedure', 'schema', 'role',
  'all', 'each', 'row', 'statement', 'before', 'after', 'instead', 'of', 'insert', 'update',
  'delete', 'truncate', 'references', 'execute', 'for', 'to', 'from', 'with', 'check', 'return',
  'returns', 'begin', 'end', 'declare', 'into', 'new', 'old', 'excluded', 'lateral', 'unnest',
  'generate_series', 'jsonb_array_elements', 'jsonb_each', 'jsonb_to_recordset', 'coalesce',
  'current_setting', 'now', 'clock_timestamp', 'gen_random_uuid', 'lower', 'upper', 'trim',
  'length', 'substring', 'replace', 'format', 'raise', 'perform', 'found', 'record', 'void',
  'text', 'uuid', 'integer', 'bigint', 'boolean', 'numeric', 'jsonb', 'json', 'timestamptz',
  'timestamp', 'date', 'bytea', 'interval', 'smallint', 'varchar',
]);

function normalizeIdent(raw) {
  const cleaned = raw.replaceAll('"', '').trim().toLowerCase();
  if (!cleaned) return null;
  const parts = cleaned.split('.');
  if (parts.length === 2 && SYSTEM_SCHEMAS.has(parts[0])) return null;
  const normalized = parts.length === 1 ? `public.${parts[0]}` : `${parts[0]}.${parts[1]}`;
  if (IGNORED_IDENTIFIERS.has(parts.at(-1))) return null;
  return normalized;
}

function normalizeFnName(signatureOrName) {
  const head = String(signatureOrName ?? '').split('(')[0].trim();
  return normalizeIdent(head);
}

function stripSqlCommentsAndStrings(statement) {
  let out = '';
  const dollarBodies = [];
  for (let index = 0; index < statement.length;) {
    if (statement.startsWith('--', index)) {
      const end = statement.indexOf('\n', index);
      out += ' ';
      index = end < 0 ? statement.length : end + 1;
      continue;
    }
    if (statement.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < statement.length && depth > 0) {
        if (statement.startsWith('/*', index)) { depth++; index += 2; }
        else if (statement.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      out += ' ';
      continue;
    }
    if (statement[index] === "'") {
      index++;
      while (index < statement.length) {
        if (statement[index] === '\\') { index += 2; continue; }
        if (statement[index++] === "'") {
          if (statement[index] === "'") { index++; continue; }
          break;
        }
      }
      out += "''";
      continue;
    }
    if (statement[index] === '$' && !/[A-Za-z0-9_$]/u.test(statement[index - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(statement.slice(index))?.[0];
      if (tag) {
        const end = statement.indexOf(tag, index + tag.length);
        if (end >= 0) {
          dollarBodies.push(statement.slice(index + tag.length, end));
          out += ' $$ ';
          index = end + tag.length;
          continue;
        }
      }
    }
    out += statement[index++];
  }
  return { outer: out.replace(/\s+/gu, ' ').trim(), dollarBodies };
}

const IDENT = '(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)';
const QUAL_IDENT = `(?:${IDENT}\\.)?${IDENT}`;

const ALLOWED_SQL_HEAD = new RegExp(
  '^(?:' +
    'SELECT\\s+1$|' +
    'CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\b|' +
    'ALTER\\s+FUNCTION\\b|' +
    'CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\b|' +
    'ALTER\\s+TABLE\\b|' +
    'CREATE\\s+(?:UNIQUE\\s+)?INDEX\\b|' +
    'DROP\\s+INDEX\\b|' +
    'CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\b|' +
    'CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\b|' +
    'CREATE\\s+POLICY\\b|' +
    'ALTER\\s+POLICY\\b|' +
    'DROP\\s+POLICY\\b|' +
    'GRANT\\b|' +
    'REVOKE\\b|' +
    'INSERT\\s+INTO\\b|' +
    'UPDATE\\b|' +
    'DELETE\\s+FROM\\b|' +
    'COMMENT\\s+ON\\b' +
  ')',
  'iu',
);

function emptyFootprint() {
  return {
    rows: new Set(),
    relations: new Set(),
    functions: new Set(),
    roles: new Set(),
    indexes: new Set(),
    triggers: new Set(),
    views: new Set(),
    policies: new Set(),
    flags: new Set(),
  };
}

function scanSqlReferences(text, fp) {
  const relationRegexes = [
    new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES)\\s+(?:ONLY\\s+)?(${QUAL_IDENT})`, 'giu'),
    new RegExp(`\\b(?:CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?)(${QUAL_IDENT})`, 'giu'),
    new RegExp(`\\bON\\s+(?:TABLE\\s+)?(${QUAL_IDENT})`, 'giu'),
  ];
  for (const regex of relationRegexes) {
    for (const match of text.matchAll(regex)) {
      const ident = normalizeIdent(match[1]);
      if (ident) fp.relations.add(ident);
    }
  }
  const fnDefRegex = new RegExp(`\\b(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION|ALTER\\s+FUNCTION|FUNCTION)\\s+(${QUAL_IDENT})\\s*\\(`, 'giu');
  for (const match of text.matchAll(fnDefRegex)) {
    const fn = normalizeFnName(match[1]);
    if (fn) fp.functions.add(fn);
  }
  const fnCallRegex = new RegExp(`\\b(${IDENT}\\.${IDENT})\\s*\\(`, 'giu');
  for (const match of text.matchAll(fnCallRegex)) {
    const fn = normalizeFnName(match[1]);
    if (fn) fp.functions.add(fn);
  }
  const indexRegex = new RegExp(`\\b(?:CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?|DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?)(${QUAL_IDENT})`, 'giu');
  for (const match of text.matchAll(indexRegex)) {
    const idx = normalizeIdent(match[1]);
    if (idx) fp.indexes.add(idx);
  }
  const viewRegex = new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+(${QUAL_IDENT})`, 'giu');
  for (const match of text.matchAll(viewRegex)) {
    const view = normalizeIdent(match[1]);
    if (view) { fp.views.add(view); fp.relations.add(view); }
  }
  const triggerRegex = new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+(${IDENT})\\b`, 'giu');
  for (const match of text.matchAll(triggerRegex)) {
    fp.triggers.add(match[1].replaceAll('"', '').toLowerCase());
  }
  const policyRegex = new RegExp(`\\b(?:CREATE|ALTER|DROP)\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(${QUAL_IDENT})`, 'giu');
  for (const match of text.matchAll(policyRegex)) {
    const rel = normalizeIdent(match[2]);
    if (rel) {
      fp.relations.add(rel);
      fp.policies.add(`${rel}:${match[1].replaceAll('"', '').toLowerCase()}`);
    }
  }
  const roleRegex = new RegExp(`\\bOWNER\\s+TO\\s+(${IDENT})`, 'giu');
  for (const match of text.matchAll(roleRegex)) {
    const role = match[1].replaceAll('"', '').trim().toLowerCase();
    if (role && role !== 'public') fp.roles.add(role);
  }
  const grantRoleRegex = new RegExp(`\\b(?:GRANT|REVOKE)\\s+[\\s\\S]*?\\bON\\s+(?:TABLE|FUNCTION|SEQUENCE|VIEW)\\b[\\s\\S]*?\\b(?:TO|FROM)\\s+(${IDENT}(?:\\s*,\\s*${IDENT})*)`, 'giu');
  const standardRuntimeRoles = new Set(['public', 'service_role', 'authenticated', 'anon']);
  for (const match of text.matchAll(grantRoleRegex)) {
    for (const part of match[1].split(',')) {
      const role = part.replaceAll('"', '').trim().toLowerCase();
      if (role && !standardRuntimeRoles.has(role)) fp.roles.add(role);
    }
  }
}

/** Fail-closed SQL statement footprint extractor for disjointness verification. */
export function extractSqlFootprint(sqlText) {
  const fp = emptyFootprint();
  const statements = splitSqlStatements(sqlText);
  for (const statement of statements) {
    const { outer, dollarBodies } = stripSqlCommentsAndStrings(statement);
    if (!outer) continue;
    check(ALLOWED_SQL_HEAD.test(outer), `relocation refuses unsupported SQL statement shape: ${outer.slice(0, 64)}`);
    // Single-quoted and SQL-standard function bodies are opaque after string stripping.
    if (/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/iu.test(outer)) {
      check(dollarBodies.length === 1, 'relocation refuses function body without one dollar-quoted body');
    }
    // LIKE and INHERITS read another relation outside the simple DDL footprint grammar.
    if (/^CREATE\s+(?:UNLOGGED\s+)?TABLE\b/iu.test(outer)) {
      check(!/\b(?:LIKE|INHERITS)\b/iu.test(outer), 'relocation refuses CREATE TABLE LIKE or INHERITS');
    }
    if (/^(?:GRANT|REVOKE)\b/iu.test(outer)) {
      check(/\bON\s+(?:TABLE|FUNCTION|SEQUENCE|VIEW)\b/iu.test(outer), 'relocation refuses role-membership or schema-wide GRANT/REVOKE');
    }
    if (/^SELECT\s+1$/iu.test(outer)) continue;
    // Refuse dynamic SQL execution inside function bodies because referenced relations cannot be proven disjoint.
    for (const body of dollarBodies) {
      const strippedBody = stripSqlCommentsAndStrings(body).outer;
      check(!/\bEXECUTE\b/iu.test(strippedBody), 'relocation refuses dynamic EXECUTE in SQL function body');
      scanSqlReferences(strippedBody, fp);
    }
    scanSqlReferences(outer, fp);
  }
  return fp;
}

/** Fail-closed NativeStoreSlot metadata footprint extractor (rejects any unknown key). */
export function extractSlotMetadataFootprint(slot) {
  check(slot && typeof slot === 'object' && !Array.isArray(slot), 'invalid nativeStoreForwardClass slot');
  for (const key of Object.keys(slot)) {
    check(KNOWN_NATIVE_STORE_SLOT_KEYS.has(key), `relocation refuses unknown NativeStoreSlot key: ${key}`);
  }
  const fp = emptyFootprint();
  if (typeof slot.row === 'string' && slot.row) fp.rows.add(slot.row);
  for (const entry of slot.replacedFunctions ?? []) {
    const fn = normalizeFnName(entry?.signature ?? entry);
    if (fn) fp.functions.add(fn);
  }
  for (const entry of slot.createdFunctions ?? []) {
    const fn = normalizeFnName(entry?.signature ?? entry);
    if (fn) fp.functions.add(fn);
  }
  for (const entry of slot.grantOnlyFunctions ?? []) {
    const fn = normalizeFnName(entry?.signature ?? entry?.function ?? entry);
    if (fn) fp.functions.add(fn);
    for (const role of entry?.roles ?? []) fp.roles.add(String(role).toLowerCase());
  }
  for (const entry of slot.settingsOnlyFunctions ?? []) {
    const fn = normalizeFnName(entry?.signature ?? entry);
    if (fn) fp.functions.add(fn);
  }
  for (const table of [...(slot.insertSelectTables ?? []), ...(slot.absorptionCensusTables ?? [])]) {
    const rel = normalizeIdent(table);
    if (rel) fp.relations.add(rel);
  }
  for (const stmt of [...(slot.dataStatements ?? []), ...(slot.existingTableStatements ?? [])]) {
    scanSqlReferences(String(stmt), fp);
  }
  for (const item of [...(slot.checkSupersets ?? []), ...(slot.uniqueSupersets ?? [])]) {
    const rel = normalizeIdent(item?.table);
    if (rel) fp.relations.add(rel);
  }
  for (const item of slot.droppedIndexes ?? []) {
    const rel = normalizeIdent(item?.table);
    if (rel) fp.relations.add(rel);
    const idx = normalizeIdent(item?.name);
    if (idx) fp.indexes.add(idx);
  }
  for (const item of slot.createdViews ?? []) {
    const view = normalizeIdent(item?.name);
    if (view) { fp.views.add(view); fp.relations.add(view); }
  }
  for (const item of slot.createdTriggers ?? []) {
    const rel = normalizeIdent(item?.table);
    if (rel) fp.relations.add(rel);
    if (item?.name) fp.triggers.add(String(item.name).toLowerCase());
  }
  if (typeof slot.ownerWindowRole === 'string' && slot.ownerWindowRole) {
    fp.roles.add(slot.ownerWindowRole.toLowerCase());
  }
  if (slot.purposeCheck !== undefined) fp.flags.add('purposeCheck');
  for (const flag of [
    'qualifiedCatalogueStorageSelect',
    'qualifiedPriceListBasisSelect',
    'qualifiedPriceSetupExecute',
    'previewNoopAcceptance',
  ]) {
    if (slot[flag] !== undefined) fp.flags.add(flag);
  }
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
    const digest = sha256Hex(sqlText);
    check(forwardRow.sha256 === digest && sha256Hex(mirrorText) === digest, `relocation refused: SQL/mirror digest mismatch for ${path}`);
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
    check(slot && typeof sqlText === 'string', `relocation refused: main SQL ${path} is not a nativeStoreForwardClass slot`);
    expectedMainMirrors.add(`packages/platform/sql/${match[1]}_${match[2]}.sql`);
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
