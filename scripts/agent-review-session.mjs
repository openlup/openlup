// Local Git and state adapters for native supervisor process evidence.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { env as processEnvironment } from 'node:process';
import { computeRegroupAdvisory, digest, explainSession, protectedCoveragePath, carryOver, cumulativeRepairPrefix, fullReviewReports, deferFinding, demand, integrationReviewContext, prepareCandidate, receiptBody, receiptSummary, recordRegroup, recordReport, verdict } from './agent-review-decide.mjs';
import { REGISTRY_PATHS, RULE_SNAPSHOT_REGISTRY_PATHS, registryUnion } from './agent-review-registry.mjs';
import { INVENTORY_PATH, MIGRATION_REGISTRIES, inventoryOnlyCurrent, migrationRegistryUnion, reslotRegistryJson } from './agent-review-derived.mjs';
import { MATURITY_REFERENCE, generatedCarrier, ownerOutputCarrier, runDerivedOutputGenerators, runLandingGenerators, withPredictedTree } from './agent-review-generators.mjs';
import { isUtcMigrationSlot, MIGRATION_RAILS, migrationIdentity } from './migration-slots.mjs';
import { join as joinPath } from 'node:path';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
/** @param {string} cwd @param {...string} args */
export async function git(cwd, ...args) {
  return (await execute('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false', '-c', 'merge.conflictStyle=merge', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: { ...processEnvironment, PATH: '/usr/bin:/bin' } })).stdout;
}
/** @param {string} cwd @param {string} base @param {string} head @param {typeof git} [runGit] */
export async function captureCommittedReviewCandidate(cwd, base, head, runGit = git) {
  demand(SHA.test(base) && SHA.test(head), 'base and head must be full commit digests');
  const tree = (await runGit(cwd, 'rev-parse', '--verify', `${head}^{tree}`)).trim();
  const raw = (await runGit(cwd, 'diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, head)).split('\0').filter(Boolean);
  const changedPaths = []; let modeChanged = false;
  for (let index = 0; index < raw.length; index += 2) {
    const modes = /^:(\d{6}) (\d{6}) /u.exec(raw[index]); demand(modes && raw[index + 1], 'unreadable diff');
    changedPaths.push(raw[index + 1]);
    const [oldMode, newMode] = modes.slice(1);
    modeChanged ||= oldMode === '120000' || newMode === '120000' || (oldMode === '000000' ? newMode !== '100644' : newMode === '000000' ? oldMode !== '100644' : oldMode !== newMode);
  }
  return { base, head, tree, changedPaths, modeChanged, clean: true };
}
export async function captureSessionCandidate(cwd, base, { runGit = git, env = processEnvironment } = {}) {
  const head = (await runGit(cwd, 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
  const forks = (await runGit(cwd, 'merge-base', '--all', head, 'origin/main')).trim().split('\n');
  demand(forks.length === 1 && SHA.test(forks[0]), 'HEAD must have a single fork point with origin/main');
  const pinned = env.OPENLUP_STACK_BASE;
  demand(pinned === undefined || SHA.test(pinned), 'OPENLUP_STACK_BASE must be a full commit digest');
  base ??= pinned ?? forks[0];
  if (pinned) {
    demand(base === pinned, 'stack base changed', 'stale');
    try { await runGit(cwd, 'merge-base', '--is-ancestor', forks[0], base); await runGit(cwd, 'merge-base', '--is-ancestor', base, head); }
    catch { throw new Error('invalid: OPENLUP_STACK_BASE must lie between the fork point and HEAD'); }
  } else demand(base === forks[0], 'fork point changed; prepare again', 'stale');
  const candidate = await captureCommittedReviewCandidate(cwd, base, head, runGit);
  candidate.clean = !(await runGit(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).context/scratch')).length;
  return candidate;
}
async function ancestor(runGit, cwd, base, head) {
  try { await runGit(cwd, 'merge-base', '--is-ancestor', base, head); return true; } catch { return false; }
}
// Normalize lineage evidence only; the candidate/receipt still binds the actual tip.
async function integrationParents(cwd, head) {
  const [parentLine, tree] = (await git(cwd, 'show', '-s', '--format=%P%n%T', head)).trimEnd().split('\n');
  const parents = parentLine.split(' ').filter(Boolean);
  if (parents.length !== 1) return parents;
  // Pretty-printed %B truncates at NUL; validate the complete raw message instead.
  const commit = await git(cwd, 'cat-file', 'commit', head); const boundary = commit.indexOf('\n\n');
  if (boundary < 0 || commit.includes('\0')) return parents;
  const [subject, ...body] = commit.slice(boundary + 2).trimEnd().split('\n');
  if (!subject?.trim() || body[0] !== '' ||
    !body.some(line => /^OpenLup-Doc-Impact:[ \t]*\S/u.test(line)) ||
    !body.every(line => line === '' || /^(?:OpenLup-Doc-Impact|Signed-off-by):[ \t]*\S[^\r\n]*$/u.test(line))) return parents;
  const [mergeParents, mergeTree] = (await git(cwd, 'show', '-s', '--format=%P%n%T', parents[0])).trim().split('\n');
  const joined = mergeParents.split(' ').filter(Boolean);
  // Do not recurse: two trailer commits, or a trailer on a non-merge, cannot qualify.
  return tree === mergeTree && joined.length === 2 ? joined : parents;
}
// This literal anchors the one-time transition in trusted main's first-parent history.
const PORTABLE_REVIEW = 'openlup-portable-review-20261103';
const DERIVED_REVIEW = 'openlup-derived-review-20261110';
const SESSION_PATH = 'scripts/agent-review-session.mjs';

// Review evidence binds to the candidate's own change: a clean merge onto a later base keeps it.
export async function carryOverSourceReview(cwd, candidate, group, runGit = git) {
  const baseAncestor = await ancestor(runGit, cwd, candidate.base, group.base);
  let predictedTree;
  if (baseAncestor && candidate.tree !== group.tree) {
    try { predictedTree = (await runGit(cwd, 'merge-tree', '--write-tree', `--merge-base=${candidate.base}`, group.base, candidate.head)).trim(); } catch { predictedTree = null; }
  }
  return carryOver({ reviewedTree: candidate.tree, groupTree: group.tree, baseAncestor, predictedTree });
}
// Source objects are parsed, never imported as candidate modules.
export async function captureReviewRules(cwd, candidate, runGit = git) {
  let source;
  try { source = await runGit(cwd, 'show', `${candidate.base}:scripts/agent-review-decide.mjs`); } catch { return undefined; }
  if (!/^export const REVIEW_RULES_VERSION = 3;$/mu.test(source)) return undefined;
  const snapshot = async revision => {
    const rows = (await runGit(cwd, 'ls-tree', '-rz', '--full-tree', revision)).split('\0').filter(Boolean);
    return digest(rows.filter(row => {
      const path = row.slice(row.indexOf('\t') + 1);
      return protectedCoveragePath(path) && !RULE_SNAPSHOT_REGISTRY_PATHS.includes(path);
    }).sort());
  };
  return { version: 3, base: await snapshot(candidate.base), head: await snapshot(candidate.head) };
}
export async function objectInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/git', ['--no-replace-objects', '-C', cwd, '-c', 'core.fsmonitor=false', ...args],
      { env: { ...processEnvironment, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let error = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 16 * 1024 * 1024) child.kill('SIGTERM'); });
    child.stderr.on('data', bytes => { error += bytes; }); child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(output.trim()); else reject(new Error(`Git object write refused: ${error}`)); });
    child.stdin.end(input);
  });
}
export async function replaceTreeBlobs(cwd, tree, replacements, removals = new Set()) {
  const rows = (await git(cwd, 'ls-tree', '-z', tree)).split('\0').filter(Boolean);
  const existing = new Map();
  const output = [];
  for (const row of rows) {
    const match = /^(\d{6}) (blob|tree) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row); demand(match, 'unreadable merge tree');
    const [, mode, type, oid, name] = match;
    existing.set(name, { mode, type, oid });
    if (removals.has(name)) continue;
    let next = replacements.get(name) ?? oid;
    const nestedRep = new Map([...replacements].filter(([path]) => path.startsWith(name + '/')).map(([path, value]) => [path.slice(name.length + 1), value]));
    const nestedRem = new Set([...removals].filter(path => path.startsWith(name + '/')).map(path => path.slice(name.length + 1)));
    if (nestedRep.size || nestedRem.size) { demand(type === 'tree', 'registry parent is not a tree'); next = await replaceTreeBlobs(cwd, oid, nestedRep, nestedRem); }
    output.push(`${mode} ${type} ${next}\t${name}\0`);
  }
  const topAdditions = [...replacements.entries()].filter(([path]) => !path.includes('/') && !existing.has(path));
  for (const [name, oid] of topAdditions) output.push(`100644 blob ${oid}\t${name}\0`);
  const missingNested = [...replacements.keys()].filter(path => path.includes('/') && !existing.has(path.split('/')[0]));
  demand(missingNested.length === 0, 'registry absent from merge tree');
  return objectInput(cwd, ['mktree', '-z'], output.join(''));
}

const DO_DDL_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE']);
const wordAt = (tokens, index) => tokens[index]?.kind === 'word' ? tokens[index].value.toUpperCase() : '';
function skipWords(tokens, pos, ...words) {
  for (let i = 0; i < words.length; i += 1) if (wordAt(tokens, pos + i) !== words[i]) return pos;
  return pos + words.length;
}
function tokenizeSql(sql) {
  const tokens = [];
  if (typeof sql !== 'string') return { tokens, opaque: true };
  for (let index = 0; index < sql.length;) {
    const ch = sql[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') { index += 1; continue; }
    if (sql.charCodeAt(index) > 0x7f) return { tokens, opaque: true };
    if (sql.startsWith('--', index)) {
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1; index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) { depth += 1; index += 2; }
        else if (sql.startsWith('*/', index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth > 0) return { tokens, opaque: true };
      continue;
    }
    if ((ch === 'U' || ch === 'u') && sql[index + 1] === '&' && (sql[index + 2] === "'" || sql[index + 2] === '"')) {
      return { tokens, opaque: true };
    }
    if ((ch === 'E' || ch === 'e') && sql[index + 1] === "'") {
      index += 2; let value = ''; let closed = false;
      while (index < sql.length) {
        const cur = sql[index];
        if (cur === '\\') {
          if (index + 1 >= sql.length) break;
          const next = sql[index + 1];
          const escaped = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[next] ?? next;
          value += escaped; index += 2; continue;
        }
        if (cur === "'") {
          if (sql[index + 1] === "'") { value += "'"; index += 2; continue; }
          index += 1; closed = true; break;
        }
        value += cur; index += 1;
      }
      if (!closed) return { tokens, opaque: true };
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === "'" || ch === '"') {
      const kind = ch === "'" ? 'string' : 'quoted';
      index += 1; let value = ''; let closed = false;
      while (index < sql.length) {
        const cur = sql[index];
        if (cur === ch) {
          if (sql[index + 1] === ch) { value += ch; index += 2; continue; }
          index += 1; closed = true; break;
        }
        value += cur; index += 1;
      }
      if (!closed) return { tokens, opaque: true };
      tokens.push({ kind, value });
      continue;
    }
    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end < 0) return { tokens, opaque: true };
        tokens.push({ kind: 'dollar', value: sql.slice(index + tag.length, end) });
        index = end + tag.length;
        continue;
      }
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(sql.slice(index))?.[0];
    if (word) { tokens.push({ kind: 'word', value: word }); index += word.length; continue; }
    const num = /^[0-9]+(?:\.[0-9]+)?/u.exec(sql.slice(index))?.[0];
    if (num) { tokens.push({ kind: 'number', value: num }); index += num.length; continue; }
    tokens.push({ kind: 'symbol', value: ch }); index += 1;
  }
  return { tokens, opaque: false };
}
function splitSqlStatements(tokens) {
  const statements = [];
  let current = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'symbol' && token.value === '(') depth += 1;
    else if (token.kind === 'symbol' && token.value === ')') {
      depth -= 1;
      if (depth < 0) return { statements, opaque: true };
    } else if (token.kind === 'symbol' && token.value === ';' && depth === 0) {
      if (current.length) { statements.push(current); current = []; }
      continue;
    }
    current.push(token);
  }
  if (depth !== 0) return { statements, opaque: true };
  if (current.length) statements.push(current);
  return { statements, opaque: false };
}
function normalizeSqlIdent(token, result) {
  if (token?.kind === 'word') return token.value.toLowerCase();
  if (token?.kind === 'quoted') {
    if (token.value.length > 0 && /^[\x20-\x7e]+$/u.test(token.value) && !token.value.includes('.')) return token.value;
    result.opaque = true;
    return null;
  }
  return null;
}
function readQualifiedSqlName(tokens, pos, result, defaultSchema = 'public') {
  const first = normalizeSqlIdent(tokens[pos], result);
  if (!first) return null;
  if (tokens[pos + 1]?.kind === 'symbol' && tokens[pos + 1].value === '.') {
    const second = normalizeSqlIdent(tokens[pos + 2], result);
    if (!second) return null;
    if (tokens[pos + 3]?.kind === 'symbol' && tokens[pos + 3].value === '.') {
      result.opaque = true;
      return null;
    }
    return { qual: `${first}.${second}`, schema: first, name: second, nextPos: pos + 3 };
  }
  return { qual: `${defaultSchema}.${first}`, schema: defaultSchema, name: first, nextPos: pos + 1 };
}
function findTopLevelWord(tokens, start, target) {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.kind === 'symbol' && tok.value === '(') depth += 1;
    else if (tok.kind === 'symbol' && tok.value === ')') depth -= 1;
    else if (depth === 0 && tok.kind === 'word' && tok.value.toUpperCase() === target) return i;
  }
  return -1;
}
function skipParenGroup(tokens, pos) {
  if (tokens[pos]?.kind !== 'symbol' || tokens[pos].value !== '(') return pos;
  let depth = 1; pos += 1;
  while (pos < tokens.length && depth > 0) {
    if (tokens[pos].kind === 'symbol' && tokens[pos].value === '(') depth += 1;
    else if (tokens[pos].kind === 'symbol' && tokens[pos].value === ')') depth -= 1;
    pos += 1;
  }
  return pos;
}
function mergeSqlObjects(target, source) {
  for (const item of source.objects) target.objects.add(item);
  for (const item of source.tablesMutated) target.tablesMutated.add(item);
  for (const item of source.tableTargets) target.tableTargets.add(item);
  target.opaque ||= source.opaque;
}
function extractDoBlock(stmt, result) {
  let pos = 1;
  if (wordAt(stmt, pos) === 'LANGUAGE' && (stmt[pos + 1]?.kind === 'word' || stmt[pos + 1]?.kind === 'quoted')) pos += 2;
  const body = stmt[pos];
  if (!body || (body.kind !== 'dollar' && body.kind !== 'string')) { result.opaque = true; return; }
  pos += 1;
  if (wordAt(stmt, pos) === 'LANGUAGE' && (stmt[pos + 1]?.kind === 'word' || stmt[pos + 1]?.kind === 'quoted')) pos += 2;
  if (pos !== stmt.length) { result.opaque = true; return; }
  const inner = tokenizeSql(body.value);
  if (inner.opaque) { result.opaque = true; return; }
  for (let i = 0; i < inner.tokens.length; i += 1) {
    const tok = inner.tokens[i];
    if (tok.kind !== 'word') continue;
    const upper = tok.value.toUpperCase();
    if (upper === 'EXECUTE') {
      const arg = inner.tokens[i + 1];
      const next = inner.tokens[i + 2];
      const staticFollow = !next || (next.kind === 'symbol' && next.value === ';') ||
        (next.kind === 'word' && ['INTO', 'USING'].includes(next.value.toUpperCase()));
      if ((arg?.kind === 'string' || arg?.kind === 'dollar') && staticFollow) {
        mergeSqlObjects(result, extractSqlObjects(arg.value));
        i += 1;
      } else {
        result.opaque = true;
      }
      continue;
    }
    if (DO_DDL_KEYWORDS.has(upper)) result.opaque = true;
  }
}
function addTableTargetObject(stmt, pos, prefix, result, { rename = false, allowOnly = false } = {}) {
  const name = normalizeSqlIdent(stmt[pos], result);
  const onIdx = findTopLevelWord(stmt, pos + 1, 'ON');
  if (!name || onIdx < 0) { result.opaque = true; return; }
  let tblPos = onIdx + 1;
  if (allowOnly && wordAt(stmt, tblPos) === 'ONLY') tblPos += 1;
  const tbl = readQualifiedSqlName(stmt, tblPos, result);
  if (!tbl) { result.opaque = true; return; }
  result.objects.add(`${prefix}:${tbl.qual}.${name}`);
  result.tableTargets.add(tbl.qual);
  if (rename && wordAt(stmt, tbl.nextPos) === 'RENAME' && wordAt(stmt, tbl.nextPos + 1) === 'TO') {
    const nextName = normalizeSqlIdent(stmt[tbl.nextPos + 2], result);
    if (nextName) result.objects.add(`${prefix}:${tbl.qual}.${nextName}`);
  }
}
function extractCreateDdl(stmt, result) {
  let pos = skipWords(stmt, 1, 'OR', 'REPLACE');
  if (['FUNCTION', 'PROCEDURE'].includes(wordAt(stmt, pos))) {
    pos = skipWords(stmt, pos + 1, 'IF', 'NOT', 'EXISTS');
    const fn = readQualifiedSqlName(stmt, pos, result);
    if (!fn) { result.opaque = true; return; }
    result.objects.add(`function:${fn.qual}`);
    return;
  }
  const trigPos = wordAt(stmt, pos) === 'CONSTRAINT' ? pos + 1 : pos;
  if (wordAt(stmt, trigPos) === 'TRIGGER') { addTableTargetObject(stmt, trigPos + 1, 'trigger', result); return; }
  if (wordAt(stmt, pos) === 'POLICY') { addTableTargetObject(stmt, pos + 1, 'policy', result); return; }
  if (wordAt(stmt, pos) === 'RULE') {
    const ruleName = normalizeSqlIdent(stmt[pos + 1], result);
    const toIdx = wordAt(stmt, pos + 2) === 'AS' && wordAt(stmt, pos + 3) === 'ON' && wordAt(stmt, pos + 5) === 'TO'
      ? pos + 5 : findTopLevelWord(stmt, pos + 2, 'TO');
    const tbl = ruleName && toIdx >= 0 ? readQualifiedSqlName(stmt, toIdx + 1, result) : null;
    if (!tbl) { result.opaque = true; return; }
    result.objects.add(`rule:${tbl.qual}.${ruleName}`);
    result.tableTargets.add(tbl.qual);
    return;
  }
  let viewPos = pos;
  if (['TEMP', 'TEMPORARY'].includes(wordAt(stmt, viewPos))) viewPos += 1;
  if (wordAt(stmt, viewPos) === 'RECURSIVE') viewPos += 1;
  if (wordAt(stmt, viewPos) === 'MATERIALIZED') viewPos += 1;
  if (wordAt(stmt, viewPos) === 'VIEW') {
    viewPos = skipWords(stmt, viewPos + 1, 'IF', 'NOT', 'EXISTS');
    const view = readQualifiedSqlName(stmt, viewPos, result);
    if (!view) { result.opaque = true; return; }
    result.objects.add(`view:${view.qual}`);
    return;
  }
  let tblPos = pos;
  if (['GLOBAL', 'LOCAL'].includes(wordAt(stmt, tblPos))) tblPos += 1;
  if (['TEMP', 'TEMPORARY', 'UNLOGGED'].includes(wordAt(stmt, tblPos))) tblPos += 1;
  if (wordAt(stmt, tblPos) === 'TABLE') {
    tblPos = skipWords(stmt, tblPos + 1, 'IF', 'NOT', 'EXISTS');
    const tbl = readQualifiedSqlName(stmt, tblPos, result);
    if (!tbl) { result.opaque = true; return; }
    result.objects.add(`table:${tbl.qual}`);
    result.tablesMutated.add(tbl.qual);
    if (wordAt(stmt, tbl.nextPos) === 'PARTITION' && wordAt(stmt, tbl.nextPos + 1) === 'OF') {
      const parent = readQualifiedSqlName(stmt, tbl.nextPos + 2, result);
      if (parent) result.tableTargets.add(parent.qual);
    }
    return;
  }
  let idxPos = wordAt(stmt, pos) === 'UNIQUE' ? pos + 1 : pos;
  if (wordAt(stmt, idxPos) === 'INDEX') {
    idxPos += 1;
    if (wordAt(stmt, idxPos) === 'CONCURRENTLY') idxPos += 1;
    idxPos = skipWords(stmt, idxPos, 'IF', 'NOT', 'EXISTS');
    if (wordAt(stmt, idxPos) === 'ON') {
      let onTbl = idxPos + 1;
      if (wordAt(stmt, onTbl) === 'ONLY') onTbl += 1;
      const tbl = readQualifiedSqlName(stmt, onTbl, result);
      if (!tbl) { result.opaque = true; return; }
      result.tableTargets.add(tbl.qual);
      return;
    }
    const idxName = normalizeSqlIdent(stmt[idxPos], result);
    if (!idxName || wordAt(stmt, idxPos + 1) !== 'ON') { result.opaque = true; return; }
    let onTbl = idxPos + 2;
    if (wordAt(stmt, onTbl) === 'ONLY') onTbl += 1;
    const tbl = readQualifiedSqlName(stmt, onTbl, result);
    if (!tbl) { result.opaque = true; return; }
    result.objects.add(`index:${tbl.schema}.${idxName}`);
    result.tableTargets.add(tbl.qual);
    return;
  }
  if (wordAt(stmt, pos) === 'TYPE' || wordAt(stmt, pos) === 'DOMAIN') {
    const prefix = wordAt(stmt, pos).toLowerCase();
    const obj = readQualifiedSqlName(stmt, skipWords(stmt, pos + 1, 'IF', 'NOT', 'EXISTS'), result);
    if (!obj) { result.opaque = true; return; }
    result.objects.add(`${prefix}:${obj.qual}`);
    return;
  }
  let seqPos = ['TEMP', 'TEMPORARY', 'UNLOGGED'].includes(wordAt(stmt, pos)) ? pos + 1 : pos;
  if (wordAt(stmt, seqPos) === 'SEQUENCE') {
    const seq = readQualifiedSqlName(stmt, skipWords(stmt, seqPos + 1, 'IF', 'NOT', 'EXISTS'), result);
    if (!seq) { result.opaque = true; return; }
    result.objects.add(`sequence:${seq.qual}`);
    return;
  }
  if (wordAt(stmt, pos) === 'SCHEMA') {
    let schPos = skipWords(stmt, pos + 1, 'IF', 'NOT', 'EXISTS');
    if (wordAt(stmt, schPos) === 'AUTHORIZATION') schPos += 1;
    const sch = normalizeSqlIdent(stmt[schPos], result);
    if (!sch) { result.opaque = true; return; }
    result.objects.add(`schema:${sch}`);
  }
}
function extractAlterDdl(stmt, result) {
  let pos = 1;
  if (wordAt(stmt, pos) === 'MATERIALIZED') pos += 1;
  const kind = wordAt(stmt, pos);
  if (kind === 'TRIGGER' || kind === 'POLICY' || kind === 'RULE') {
    addTableTargetObject(stmt, pos + 1, kind.toLowerCase(), result, { rename: true, allowOnly: kind === 'TRIGGER' });
    return;
  }
  if (kind === 'SCHEMA') {
    const sch = normalizeSqlIdent(stmt[pos + 1], result);
    if (!sch) { result.opaque = true; return; }
    result.objects.add(`schema:${sch}`);
    if (wordAt(stmt, pos + 2) === 'RENAME' && wordAt(stmt, pos + 3) === 'TO') {
      const nextSch = normalizeSqlIdent(stmt[pos + 4], result);
      if (nextSch) result.objects.add(`schema:${nextSch}`);
    }
    return;
  }
  const prefixes = { FUNCTION: 'function', PROCEDURE: 'function', VIEW: 'view', TABLE: 'table', INDEX: 'index', TYPE: 'type', DOMAIN: 'domain', SEQUENCE: 'sequence' };
  const prefix = prefixes[kind];
  if (!prefix) return;
  pos = skipWords(stmt, pos + 1, 'IF', 'EXISTS');
  if (kind === 'TABLE' && wordAt(stmt, pos) === 'ONLY') pos += 1;
  const obj = readQualifiedSqlName(stmt, pos, result);
  if (!obj) { result.opaque = true; return; }
  result.objects.add(`${prefix}:${obj.qual}`);
  if (kind === 'TABLE') result.tablesMutated.add(obj.qual);
  if (wordAt(stmt, obj.nextPos) === 'RENAME' && wordAt(stmt, obj.nextPos + 1) === 'TO') {
    const nextName = normalizeSqlIdent(stmt[obj.nextPos + 2], result);
    if (nextName) {
      const renamed = `${obj.schema}.${nextName}`;
      result.objects.add(`${prefix}:${renamed}`);
      if (kind === 'TABLE') result.tablesMutated.add(renamed);
    }
  }
}
function extractDropDdl(stmt, result) {
  let pos = 1;
  if (wordAt(stmt, pos) === 'MATERIALIZED') pos += 1;
  const kind = wordAt(stmt, pos);
  if (kind === 'TRIGGER' || kind === 'POLICY' || kind === 'RULE') {
    addTableTargetObject(stmt, skipWords(stmt, pos + 1, 'IF', 'EXISTS'), kind.toLowerCase(), result);
    return;
  }
  if (kind === 'SCHEMA') {
    pos = skipWords(stmt, pos + 1, 'IF', 'EXISTS');
    while (pos < stmt.length) {
      const sch = normalizeSqlIdent(stmt[pos], result);
      if (!sch) { result.opaque = true; return; }
      result.objects.add(`schema:${sch}`);
      pos += 1;
      if (stmt[pos]?.kind === 'symbol' && stmt[pos].value === ',') { pos += 1; continue; }
      break;
    }
    return;
  }
  const prefixes = { FUNCTION: 'function', PROCEDURE: 'function', VIEW: 'view', TABLE: 'table', INDEX: 'index', TYPE: 'type', DOMAIN: 'domain', SEQUENCE: 'sequence' };
  const prefix = prefixes[kind];
  if (!prefix) return;
  pos += 1;
  if (kind === 'INDEX' && wordAt(stmt, pos) === 'CONCURRENTLY') pos += 1;
  pos = skipWords(stmt, pos, 'IF', 'EXISTS');
  while (pos < stmt.length) {
    const obj = readQualifiedSqlName(stmt, pos, result);
    if (!obj) { result.opaque = true; return; }
    result.objects.add(`${prefix}:${obj.qual}`);
    if (kind === 'TABLE') result.tablesMutated.add(obj.qual);
    pos = obj.nextPos;
    if (prefix === 'function' && stmt[pos]?.kind === 'symbol' && stmt[pos].value === '(') pos = skipParenGroup(stmt, pos);
    if (stmt[pos]?.kind === 'symbol' && stmt[pos].value === ',') { pos += 1; continue; }
    break;
  }
}
export function extractSqlObjects(sql) {
  const result = { objects: new Set(), tablesMutated: new Set(), tableTargets: new Set(), opaque: false };
  const tokenized = tokenizeSql(sql);
  if (tokenized.opaque) result.opaque = true;
  const { statements, opaque } = splitSqlStatements(tokenized.tokens);
  if (opaque) result.opaque = true;
  for (const stmt of statements) {
    const head = wordAt(stmt, 0);
    if (head === 'DO') extractDoBlock(stmt, result);
    else if (head === 'CREATE') extractCreateDdl(stmt, result);
    else if (head === 'ALTER') extractAlterDdl(stmt, result);
    else if (head === 'DROP') extractDropDdl(stmt, result);
    else if (head === 'TRUNCATE') {
      let pos = wordAt(stmt, 1) === 'TABLE' ? 2 : 1;
      while (pos < stmt.length) {
        if (wordAt(stmt, pos) === 'ONLY') pos += 1;
        const tbl = readQualifiedSqlName(stmt, pos, result);
        if (!tbl) { result.opaque = true; break; }
        result.objects.add(`table:${tbl.qual}`);
        result.tablesMutated.add(tbl.qual);
        pos = tbl.nextPos;
        if (stmt[pos]?.kind === 'symbol' && stmt[pos].value === ',') { pos += 1; continue; }
        break;
      }
    }
  }
  return result;
}
function setsIntersect(left, right) {
  for (const item of left) if (right.has(item)) return true;
  return false;
}
function sqlObjectsOverlap(moved, reslotted) {
  if (moved.opaque || reslotted.opaque) return true;
  return setsIntersect(moved.objects, reslotted.objects) ||
    setsIntersect(moved.tablesMutated, reslotted.tablesMutated) ||
    setsIntersect(moved.tablesMutated, reslotted.tableTargets) ||
    setsIntersect(reslotted.tablesMutated, moved.tableTargets);
}

const PORTABLE_FORWARD_PATH = /^db\/platform\/migrations\/(\d{14})_([a-z][a-z0-9_]*)\.sql$/u;
async function blobOid(cwd, revision, path) {
  const line = (await git(cwd, 'ls-tree', revision, '--', path)).trim();
  const match = /^100644 blob ([a-f0-9]{40})\t/u.exec(line);
  return match ? match[1] : null;
}
async function pathExists(cwd, revision, path) {
  return (await git(cwd, 'ls-tree', revision, '--', path)).trim().length > 0;
}

async function detectByteIdenticalReslot(cwd, previous, current, prediction) {
  const empty = { changes: [], addBlobs: new Map(), removePaths: new Set(), overlapPaths: new Set() };
  const prAdded = (await git(cwd, 'diff', '--name-only', '--diff-filter=A', '--no-renames', '-z', previous.base, previous.head))
    .split('\0').filter(path => PORTABLE_FORWARD_PATH.test(path)).sort();
  if (!prAdded.length) return empty;
  const missing = [];
  for (const oldPath of prAdded) {
    if (!(await pathExists(cwd, current.tree, oldPath))) missing.push(oldPath);
  }
  if (!missing.length) return empty;
  const predAdded = (await git(cwd, 'diff', '--name-only', '--diff-filter=A', '--no-renames', '-z', prediction, current.tree))
    .split('\0').filter(path => PORTABLE_FORWARD_PATH.test(path));
  demand(predAdded.length === missing.length, 'reslot count differs');
  const mainPaths = (await git(cwd, 'ls-tree', '-r', '--name-only', '-z', current.base, '--', ...MIGRATION_RAILS))
    .split('\0').filter(Boolean);
  const maxMainSlot = mainPaths.map(p => migrationIdentity(p)?.version ?? '').filter(Boolean).sort().at(-1) ?? '00000000000000';
  const movedSqlPaths = (await git(cwd, 'diff', '--name-only', '--no-renames', '-z', previous.base, current.base, '--', ...MIGRATION_RAILS))
    .split('\0').filter(path => path.endsWith('.sql'));
  const movedObjects = { objects: new Set(), tablesMutated: new Set(), tableTargets: new Set(), opaque: false };
  for (const movedPath of movedSqlPaths) {
    const curOid = await blobOid(cwd, current.base, movedPath);
    const prevOid = await blobOid(cwd, previous.base, movedPath);
    if ((await pathExists(cwd, current.base, movedPath)) && !curOid) movedObjects.opaque = true;
    if ((await pathExists(cwd, previous.base, movedPath)) && !prevOid) movedObjects.opaque = true;
    if (curOid) mergeSqlObjects(movedObjects, extractSqlObjects(await git(cwd, 'show', `${current.base}:${movedPath}`)));
    if (prevOid && prevOid !== curOid) mergeSqlObjects(movedObjects, extractSqlObjects(await git(cwd, 'show', `${previous.base}:${movedPath}`)));
  }
  const slugOf = p => PORTABLE_FORWARD_PATH.exec(p)?.[2];
  const bySlug = new Map();
  for (const p of [...predAdded].sort()) {
    const slug = slugOf(p);
    demand(slug, 'invalid reslot target slug');
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(p);
  }
  const changes = [];
  const reslotMap = new Map();
  const addBlobs = new Map();
  const removePaths = new Set();
  const overlapPaths = new Set();
  const sortedMissing = [...missing].sort();
  let lastNewSlot = maxMainSlot;
  for (const oldPath of sortedMissing) {
    const oldId = migrationIdentity(oldPath);
    const targets = bySlug.get(slugOf(oldPath));
    const target = targets?.shift();
    demand(target && target !== oldPath, 'reslot target missing');
    const newId = migrationIdentity(target);
    demand(oldId && newId && isUtcMigrationSlot(newId.version) && newId.version > oldId.version && newId.version > lastNewSlot,
      'reslot target slot must be strictly later valid UTC above main and original slot');
    lastNewSlot = newId.version;
    const oldOid = await blobOid(cwd, previous.head, oldPath);
    const newOid = await blobOid(cwd, current.tree, target);
    demand(oldOid && newOid && oldOid === newOid, 'reslot SQL bytes differ');
    demand(!(await pathExists(cwd, current.base, oldPath)), 'reslot old path exists on main');
    demand(!(await pathExists(cwd, current.base, target)), 'reslot target exists on main');
    const reslotObjects = extractSqlObjects(await git(cwd, 'show', `${current.tree}:${target}`));
    const overlaps = sqlObjectsOverlap(movedObjects, reslotObjects);
    changes.push({ path: oldPath, target });
    reslotMap.set(oldPath, target);
    removePaths.add(oldPath);
    addBlobs.set(target, newOid);
    if (overlaps) overlapPaths.add(target);
    const oldMirror = `packages/platform/sql/${oldPath.split('/').at(-1)}`;
    const newMirror = `packages/platform/sql/${target.split('/').at(-1)}`;
    const oldMirrorOid = await blobOid(cwd, previous.head, oldMirror);
    if (oldMirrorOid) {
      demand(!(await pathExists(cwd, current.tree, oldMirror)), 'old SQL mirror still present');
      demand(!(await pathExists(cwd, current.base, oldMirror)), 'reslot old mirror exists on main');
      demand(!(await pathExists(cwd, current.base, newMirror)), 'reslot target mirror exists on main');
      const newMirrorOid = await blobOid(cwd, current.tree, newMirror);
      demand(newMirrorOid === newOid, 'reslot SQL mirror bytes differ');
      removePaths.add(oldMirror);
      addBlobs.set(newMirror, newMirrorOid);
      if (overlaps) overlapPaths.add(newMirror);
    }
  }
  // Preserve reviewed relative execution order across ALL PR forwards (kept + reslotted).
  const finalVersions = prAdded.map(p => migrationIdentity(reslotMap.get(p) ?? p)?.version ?? '');
  for (let i = 1; i < finalVersions.length; i += 1) {
    demand(finalVersions[i] > finalVersions[i - 1], 'reslot inverted reviewed PR migration order');
  }
  return { changes, addBlobs, removePaths, overlapPaths };
}
export async function proveReviewIntegration(cwd, previous, current, portable = false, { legacy = false, resolvedOwnerOutputs = [] } = {}) {
  const parents = await integrationParents(cwd, current.head);
  demand(parents.length === 2 && parents[0] === previous.head && parents[1] === current.base, 'integration parents differ');
  demand(await ancestor(git, cwd, previous.base, current.base), 'integration base ancestry differs');
  const own = (await captureCommittedReviewCandidate(cwd, previous.base, previous.head)).changedPaths;
  const moved = (await captureCommittedReviewCandidate(cwd, previous.base, current.base)).changedPaths;
  let prediction; let conflicts = [];
  try { prediction = (await git(cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', previous.head, current.base)).split('\0')[0]; }
  catch (error) {
    if (error.code !== 1) throw error;
    const parts = error.stdout.split('\0'); prediction = parts.shift(); conflicts = parts.filter(Boolean);
    demand(conflicts.length > 0, 'integration conflict list missing');
  }
  demand(SHA.test(prediction), 'merge prediction missing'); const replacements = new Map();
  const registryConflicts = conflicts.filter(path => REGISTRY_PATHS.includes(path));
  const registryBaseMatches = registryConflicts.length > 0 && (await git(cwd, 'merge-base', '--all', ...parents)).trim() === previous.base;
  // Git's clean merge stands for every carrier it merged. A conflicting carrier
  // can take the deterministic union of its named arrays from the reviewed
  // merge base. Other carrier resolutions retain their review.
  for (const path of registryBaseMatches ? registryConflicts : []) {
    const blobs = [];
    for (const revision of [previous.base, previous.head, current.base]) {
      if ((await git(cwd, 'ls-tree', revision, '--', path)).trim().startsWith('100644 blob ')) blobs.push(await git(cwd, 'show', `${revision}:${path}`));
    }
    let union; try { union = blobs.length === 3 ? registryUnion(path, ...blobs) : undefined; } catch { union = undefined; }
    if (union !== undefined) replacements.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], union));
  }
  // A union counts only when it is what was committed; any other carrier bytes are reviewed.
  for (const [path, blob] of replacements) {
    if ((await git(cwd, 'ls-tree', current.tree, '--', path)).trim() !== `100644 blob ${blob}\t${path}`) replacements.delete(path);
  }
  if (replacements.size) prediction = await replaceTreeBlobs(cwd, prediction, replacements);
  const oldPrediction = prediction;
  const exactParents = (await git(cwd, 'show', '-s', '--format=%P', current.head)).trim().split(' ');
  const onMain = await ancestor(git, cwd, current.base, 'origin/main');
  let derived = false;
  let reslotOverlapPaths = new Set();
  const provenDerived = new Set();
  // Preserve historical receipt identities; derived proof is selected only by
  // trusted main after this machinery lands. Errors retain the old resolution.
  if (!legacy && exactParents.length === 2 && exactParents[0] === previous.head && exactParents[1] === current.base && onMain) {
    try {
      const read = async (revision, path) => {
        demand((await git(cwd, 'ls-tree', revision, '--', path)).trim().startsWith('100644 blob '), 'derived carrier mode differs');
        return git(cwd, 'show', `${revision}:${path}`);
      };
      const reslot = await detectByteIdenticalReslot(cwd, previous, current, prediction);
      const inventories = await Promise.all([previous.base, previous.head, current.base, current.tree].map(revision => read(revision, INVENTORY_PATH)));
      const currentOnly = inventoryOnlyCurrent(...inventories);
      const inventorySame = inventories.every(source => source === inventories[0]);
      demand(currentOnly || inventorySame, 'historical inventory or envelope differs');
      const derivedBlobs = new Map(reslot.addBlobs);
      if (currentOnly) derivedBlobs.set(INVENTORY_PATH, await objectInput(cwd, ['hash-object', '-w', '--stdin'], inventories[3]));
      for (const path of MIGRATION_REGISTRIES) {
        const inputs = await Promise.all([previous.base, previous.head, current.base].map(revision => read(revision, path)));
        if (reslot.changes.length) inputs[1] = reslotRegistryJson(path, inputs[1], reslot.changes);
        const union = migrationRegistryUnion(path, ...inputs, inventories[3]);
        demand(union === await read(current.tree, path), 'registry union differs');
        derivedBlobs.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], union));
      }
      // Authored catalogue rows still come only from the existing closed union.
      // Its generated command inventory may then be reproduced by the owner.
      const catalogue = REGISTRY_PATHS[0];
      if (conflicts.includes(catalogue) && !replacements.has(catalogue)) {
        demand(registryBaseMatches, 'registry union requires the reviewed merge base');
        const inputs = await Promise.all([previous.base, previous.head, current.base].map(revision => read(revision, catalogue)));
        if (reslot.changes.length) {
          const reslotMirrorChanges = reslot.changes.flatMap(({ path: oldPath, target }) => [
            { path: oldPath, target },
            ...(oldPath.startsWith('db/platform/migrations/') ? [{
              path: `packages/platform/sql/${oldPath.split('/').at(-1)}`,
              target: `packages/platform/sql/${target.split('/').at(-1)}`,
            }] : []),
          ]);
          inputs[1] = reslotRegistryJson(catalogue, inputs[1], reslotMirrorChanges);
        }
        derivedBlobs.set(catalogue, await objectInput(cwd, ['hash-object', '-w', '--stdin'], registryUnion(catalogue, ...inputs)));
      }
      let predicted = await replaceTreeBlobs(cwd, prediction, derivedBlobs, reslot.removePaths);
      const delta = await captureCommittedReviewCandidate(cwd, predicted, current.tree);
      // SQL and modes always retain their mechanical result, including mirrors.
      // A committed conflict-marker blob has no delta from merge-tree. It still
      // needs its own generator proof; another derived carrier proves nothing
      // about that blob. SQL conflicts, including mirrors, never take this lane.
      const ownerPaths = [...new Set([...delta.changedPaths, ...conflicts].filter(ownerOutputCarrier))];
      const trustedPaths = ['scripts/agent-review-generators.mjs', 'scripts/agent-review-session.mjs',
        'scripts/build-packages-incremental.mjs', 'scripts/settings-catalogue.ts',
        'config/openlup-packages.json', 'package-lock.json',
        ...ownerPaths.filter(path => /\/api\//u.test(path)).map(path => `packages/${path.split('/')[1]}/scripts/api-contract.ts`),
        ...(ownerPaths.some(path => path.startsWith('packages/core/api/')) ? ['packages/core/scripts/public-api-config.ts'] : []),
        ...(ownerPaths.includes(MATURITY_REFERENCE) ? ['packages/core/scripts/documentation-contract.ts', 'packages/ui/smoke/neutrality.ts'] : [])];
      const trustedRows = ownerPaths.length ? await Promise.allSettled(trustedPaths.map(async path =>
        [path, await read(current.base, path)])) : [];
      const trusted = Object.fromEntries(trustedRows.filter(row => row.status === 'fulfilled').map(row => row.value));
      const ownerReplayAvailable = existsSync(joinPath(cwd, 'node_modules')) && trustedRows.every(row => row.status === 'fulfilled') &&
        trustedPaths.every(path => readFileSync(joinPath(cwd, path), 'utf8') === trusted[path]);
      const carrierPaths = [...new Set([...delta.changedPaths, ...conflicts].filter(path => generatedCarrier(path) && !path.endsWith('.sql') &&
        !resolvedOwnerOutputs.includes(path) && (ownerReplayAvailable || !ownerOutputCarrier(path)))
        .concat(derivedBlobs.has(REGISTRY_PATHS[0]) ? [REGISTRY_PATHS[0]] : []))];
      if (carrierPaths.length) {
        const outputs = withPredictedTree(cwd, predicted, (root, paths) => {
          runLandingGenerators(root, paths);
          if (carrierPaths.some(ownerOutputCarrier)) withPredictedTree(cwd, current.base, mainRoot =>
            runDerivedOutputGenerators(root, mainRoot, cwd, carrierPaths, trusted));
          return carrierPaths.map(path => [path, readFileSync(joinPath(root, path), 'utf8')]);
        });
        for (const [path, output] of outputs) {
          demand(output === await read(current.tree, path), 'generated bytes differ');
          derivedBlobs.set(path, await objectInput(cwd, ['hash-object', '-w', '--stdin'], output));
        }
      }
      // Exclude semantically overlapping byte-identical re-slotted SQL paths only after
      // generators verify the full projection, so only the overlapping SQL remains unresolved.
      for (const path of reslot.overlapPaths) derivedBlobs.delete(path);
      if (carrierPaths.length || reslot.overlapPaths.size) {
        predicted = await replaceTreeBlobs(cwd, prediction, derivedBlobs, reslot.removePaths);
      }
      derived = predicted !== prediction; prediction = predicted;
      reslotOverlapPaths = reslot.overlapPaths;
      // Publish exemptions only after the complete derivation succeeds. Each
      // replacement above was checked against the committed regular-file blob.
      for (const path of derivedBlobs.keys()) if (!path.endsWith('.sql')) provenDerived.add(path);
    } catch { prediction = oldPrediction; derived = false; reslotOverlapPaths = new Set(); }
  }
  const delta = await captureCommittedReviewCandidate(cwd, prediction, current.tree);
  demand(conflicts.every(path => replacements.has(path) || delta.changedPaths.includes(path) || provenDerived.has(path)), 'integration commits a conflict without resolving it');
  const resolution = delta.changedPaths; const modeChanged = delta.modeChanged;
  const kind = resolution.length ? 'resolution' : derived ? 'derived' : conflicts.length ? 'registry-union' : 'git';
  const reslotOverlap = reslotOverlapPaths.size > 0 && resolution.length > 0 && !modeChanged && resolution.every(path => reslotOverlapPaths.has(path));
  return { kind: portable ? 'portable-' + kind : kind, tree: current.tree, own, moved, ...(derived ? { derived: true } : {}), ...(reslotOverlap ? { reslotOverlap: true } : {}), ...(resolution.length ? { resolution, prediction, modeChanged } : {}) };
}

export async function captureCoverageEdge(cwd, session, observed, now, historicalKind, {
  abbreviatedIndex = false, allowDerived = historicalKind === undefined, resolvedOwnerOutputs = [],
} = {}) {
  if (!session || !observed.rules ||
    digest(observed.intent) !== digest(session.history.findLast(event => event.type === 'prepare').intent) ||
    observed.authorSessionId !== session.history.findLast(event => event.type === 'prepare').authorSessionId) return undefined;
  const decision = verdict(session, session.candidate, now);
  const sameBase = session.candidate.base === observed.base;
  const priorFull = !decision.ok && sameBase && fullReviewReports(session);
  const cumulative = !priorFull && sameBase && decision.code === 'needs_agent_review'
    ? cumulativeRepairPrefix(session) : undefined;
  if (!decision.ok && !priorFull && !cumulative) return undefined;
  let proof; let kind; let from = session.candidate.head; let to = observed.head;
  if (!sameBase) {
    // An integration base must be on main; a repair keeps its existing (possibly stacked) base.
    if (!await ancestor(git, cwd, observed.base, 'origin/main')) return undefined;
    kind = 'integration';
    try {
      const entry = await git(cwd, 'ls-tree', observed.base, '--', SESSION_PATH);
      const source = entry ? await git(cwd, 'show', `${observed.base}:${SESSION_PATH}`) : '';
      const portable = source.includes(`const PORTABLE_REVIEW = '${PORTABLE_REVIEW}';`);
      // The landed base selects the proof. A receipt cannot opt into the old
      // selector after the rollout, even when historical fingerprints match.
      // A session from before the version-3 rules can inherit only through the portable proof.
      if ((historicalKind && historicalKind.startsWith('portable-') !== portable) || (!portable && session.candidate.rules?.version !== 3)) return undefined;
      const derivedEnabled = source.includes(`const DERIVED_REVIEW = '${DERIVED_REVIEW}';`);
      const historicalLegacy = !allowDerived && historicalKind && !['derived', 'portable-derived'].includes(historicalKind);
      proof = await proveReviewIntegration(cwd, session.candidate, observed, portable, { legacy: !derivedEnabled || historicalLegacy, resolvedOwnerOutputs });
      if (proof.prediction) { from = proof.prediction; to = observed.tree; }
    } catch { return undefined; }
  }
  try {
    if (sameBase) {
      if (session.candidate.rules?.version !== 3) return undefined;
      from = cumulative?.candidate.head ?? from;
      const delta = await captureCommittedReviewCandidate(cwd, from, observed.head);
      const commits = (await git(cwd, 'rev-list', '--merges', `${from}..${observed.head}`)).trim();
      if (!await ancestor(git, cwd, session.candidate.head, observed.head) || commits || !delta.changedPaths.length) return undefined;
      if (cumulative && !await ancestor(git, cwd, from, session.candidate.head)) return undefined;
      proof = { paths: delta.changedPaths, modeChanged: delta.modeChanged, ...(cumulative ? { cumulativeFrom: from } : {}) }; kind = 'repair';
    }
    // Full object names keep the digest identical in every clone; abbreviated ones
    // lengthen with the number of objects in the repository that runs git.
    const index = abbreviatedIndex ? [] : ['--full-index'];
    return { kind, previous: digest(session.history), from: { base: session.candidate.base, head: session.candidate.head, tree: session.candidate.tree },
      delta: digest(await git(cwd, 'diff', '--binary', ...index, '--no-renames', from, to)), proof };
  } catch (error) {
    if (cumulative) return undefined;
    throw error;
  }
}
// Trusted admission and local verify rederive every recorded exceptional edge.
export async function validateEconomySession(cwd, session, runGit = git) {
  if (session.version !== 3) return;
  for (let index = 0; index < session.history.length; index++) {
    const event = session.history[index];
    if (event.type === 'prepare') {
      const actual = await captureCommittedReviewCandidate(cwd, event.candidate.base, event.candidate.head, runGit);
      for (const key of ['base', 'head', 'tree', 'changedPaths', 'modeChanged']) demand(digest(actual[key]) === digest(event.candidate[key]), 'recorded candidate diff differs');
      const rules = await captureReviewRules(cwd, actual, runGit);
      demand(rules === undefined ? event.candidate.rules === undefined :
        event.candidate.rules !== undefined && digest(rules) === digest(event.candidate.rules), 'recorded policy or base rules differ');
      if (event.candidate.coverage) {
        const prefix = session.history.slice(0, session.history[index - 1]?.type === 'rules' ? index - 1 : index); const prior = prefix.findLast(item => item.type === 'prepare');
        const version = prefix.some(item => item.type === 'rules' || item.candidate?.rules?.version === 3) ? 3 : 2;
        const before = { ...session, version, candidate: prior.candidate, history: prefix, preparedAt: prior.at };
        const observed = { ...actual, rules, intent: event.intent, authorSessionId: event.authorSessionId };
        const recorded = digest(event.candidate.coverage); const kind = event.candidate.coverage.proof?.kind;
        const resolvedOwnerOutputs = (event.candidate.coverage.proof?.resolution ?? []).filter(ownerOutputCarrier);
        const edge = await captureCoverageEdge(cwd, before, observed, event.at, kind,
          { allowDerived: event.candidate.coverage.proof?.derived === true, resolvedOwnerOutputs });
        // An edge recorded before full-index digests replays through the abbreviated diff it was recorded with.
        const legacy = edge && !edge.proof.cumulativeFrom && digest(edge) !== recorded ? await captureCoverageEdge(cwd, before, observed, event.at, kind,
          { abbreviatedIndex: true, allowDerived: event.candidate.coverage.proof?.derived === true, resolvedOwnerOutputs }) : undefined;
        demand(edge && (digest(edge) === recorded || (legacy && digest(legacy) === recorded)), 'recorded coverage proof differs');
      }
    }
  }
}
export async function assertMergePreflight(cwd, candidate, { runGit = git, env = processEnvironment } = {}) {
  const main = (await runGit(cwd, 'rev-parse', '--verify', 'origin/main^{commit}')).trim();
  demand(SHA.test(main), 'origin/main commit identity is invalid');
  // A stacked candidate may be reviewed before its prerequisite lands. Hosted
  // admission still requires its exact pin on main before it can enter the queue.
  if (env.OPENLUP_STACK_BASE === candidate.base && !await ancestor(runGit, cwd, candidate.base, main)) return;
  let tree;
  try { tree = (await runGit(cwd, 'merge-tree', '--write-tree', main, candidate.head)).trim(); }
  catch (error) {
    if (error.code === 1) throw new Error('merge_preflight: candidate conflicts with origin/main; merge main and resolve before review or verification');
    throw new Error(`merge_preflight: cannot compute merge with origin/main: ${error.message}`);
  }
  demand(SHA.test(tree), 'merge preflight did not produce a tree', 'merge_preflight');
  const decision = await carryOverSourceReview(cwd, candidate, { base: main, tree, trustedMain: main }, runGit);
  demand(decision.ok, `clean merge cannot carry over source review: ${decision.reason}`, 'merge_preflight');
}
async function boundedJson(path, limit = 1024 * 1024) {
  const handle = await open(path, 'r');
  try {
    demand((await handle.stat()).size <= limit, 'JSON input exceeds size bound');
    const bytes = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    demand(bytesRead <= limit, 'JSON input exceeds size bound'); return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}
async function saveState(path, state) {
  const bytes = `${JSON.stringify(state, null, 2)}\n`; demand(Buffer.byteLength(bytes) <= 8 * 1024 * 1024, 'session exceeds 8 MiB; previous state preserved');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export function runReviewCommand(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT'); const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); resolve(code ?? 1); });
  });
}
export async function verifyCandidateCommand({ cwd, session, command, args = [], resource, env = processEnvironment, snapshot = captureSessionCandidate, run = runReviewCommand }) {
  demand(env.AI_RESOURCE_GATE_ACTIVE !== '1' && !env.OPENLUP_HEAVY_ACTIVE, 'nested verification inside the resource broker is refused');
  const before = await snapshot(cwd, session.candidate.base, { env }); const decision = verdict(session, before, Date.now()); demand(decision.ok, decision.reason, decision.code);
  await validateEconomySession(cwd, session);
  await assertMergePreflight(cwd, before, { env });
  if (resource) {
    demand(/^[a-z][a-z0-9:-]{0,127}$/u.test(resource), 'resource profile is invalid');
    const broker = (env.PATH ?? '').split(delimiter).map(path => join(path, 'ai-resource-gate')).find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
    demand(broker, 'ai-resource-gate is unavailable');
    // The broker matches lane keywords in the full key: a worktree name must
    // not introduce another keyword (even hexadecimal hashes can contain e2e).
    const worktree = createHash('sha256').update(resolve(cwd)).digest().readBigUInt64BE().toString(10);
    args = ['run', '--wait', `${resource}:wt${worktree}`, '--', command, ...args]; command = broker;
  }
  const code = await run(command, args, cwd, { ...env, OPENLUP_HEAVY_ACTIVE: cwd });
  await validateEconomySession(cwd, session);
  const after = await snapshot(cwd, before.base, { env }); const final = verdict(session, after, Date.now()); demand(final.ok, final.reason, final.code);
  return code;
}
const SESSION_HELP = `Usage:
  node scripts/agent-review-session.mjs --help
  node scripts/agent-review-session.mjs prepare [--new] [intent.json]
  node scripts/agent-review-session.mjs status [--explain]
  node scripts/agent-review-session.mjs record <report.json>
  node scripts/agent-review-session.mjs defer <findingId> --to <target> --decision <ref> --reason <text>
  node scripts/agent-review-session.mjs regroup --summary <note>
  node scripts/agent-review-session.mjs verify
  node scripts/agent-review-session.mjs receipt <PR>
  node scripts/agent-review-session.mjs verify-command [--resource PROFILE] -- <command> [args...]

status prints the raw recorded session JSON.
status --explain compares the recorded session with the local checkout without writing Git objects, running generators or claiming verify completion.`;

export async function sessionMain(argv = process.argv.slice(2), { cwd = process.cwd(), env = processEnvironment } = {}) {
  const [verb, ...args] = argv;
  if (verb === '--help' || verb === '-h' || verb === 'help') {
    demand(args.length === 0, 'use --help without extra arguments');
    console.log(SESSION_HELP); return 0;
  }
  demand(['prepare', 'record', 'defer', 'regroup', 'verify', 'status', 'receipt', 'verify-command'].includes(verb), 'use prepare [--new] <intent.json>, record <report.json>, defer <findingId> --to <target> --decision <ref> --reason <text>, regroup --summary <note>, verify, status [--explain], receipt <PR>, verify-command or --help');
  const directory = join(cwd, '.context', 'scratch', 'agent-review'); const path = join(directory, 'session.json');
  let lock;
  if (['prepare', 'record', 'defer', 'regroup'].includes(verb)) {
    await mkdir(directory, { recursive: true });
    try { lock = await open(join(directory, '.session.lock'), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('invalid: session is busy; retry after the active transaction finishes'); throw error; }
  }
  try {
    let session; try { session = await boundedJson(path, 8 * 1024 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (verb === 'prepare') {
      const fresh = args[0] === '--new'; if (fresh) args.shift();
      const spec = await boundedJson(args[0] ?? join(directory, 'intent.json'));
      const observed = { ...await captureSessionCandidate(cwd, undefined, { env }), intent: spec.intent, authorSessionId: spec.authorSessionId ?? env.CODEX_THREAD_ID };
      if (!fresh && session?.candidate && session.candidate.head !== observed.head) {
        try { await git(cwd, 'merge-base', '--is-ancestor', session.candidate.head, observed.head); }
        catch { throw new Error('invalid: rebased history; use prepare --new'); }
      }
      if (!fresh && session?.version === 3 && session.candidate &&
        session.candidate.base === observed.base && session.candidate.head !== observed.head &&
        observed.clean) {
        const lastPrepare = session.history?.findLast(event => event.type === 'prepare');
        const expectedAuthor = lastPrepare?.authorSessionId ?? session.authorSessionId;
        const expectedIntent = lastPrepare?.intent ?? session.intent;
        if (expectedAuthor === observed.authorSessionId && digest(expectedIntent) === digest(observed.intent)) {
          const regroup = computeRegroupAdvisory(session);
          if (regroup.triggered) {
            throw new Error(`REGROUP_REQUIRED: ${regroup.reason} Run node scripts/agent-review-session.mjs regroup --summary "<root cause and new approach>" before preparing a new repair round.`);
          }
        }
      }
      await assertMergePreflight(cwd, observed, { env });
      const now = Date.now();
      const rules = await captureReviewRules(cwd, observed);
      if (rules) observed.rules = rules;
      if (!fresh && session?.candidate && session.candidate.head !== observed.head) {
        const parents = await integrationParents(cwd, observed.head);
        const baseAncestor = await ancestor(git, cwd, session.candidate.base, observed.base) &&
          await ancestor(git, cwd, observed.base, 'origin/main');
        const integration = integrationReviewContext(session, observed, { parents, baseAncestor }, now);
        if (integration) {
          try {
            integration.mechanical = (await git(cwd, 'merge-tree', '--write-tree', session.candidate.head, observed.base)).trim() === observed.tree;
          } catch (error) {
            if (error.code !== 1) throw new Error(`invalid: cannot verify mechanical integration: ${error.message}`);
          }
          observed.integration = integration;
        }
      }
      if (!fresh && session?.candidate.head !== observed.head) {
        const coverage = await captureCoverageEdge(cwd, session, observed, now); if (coverage) observed.coverage = coverage;
      }
      const next = prepareCandidate(session, observed, now, fresh);
      await saveState(path, next);
      console.log(JSON.stringify(next, null, 2)); return 0;
    }
    demand([2, 3].includes(session?.version), 'prepare a version-2 session before review');
    if (verb === 'regroup') {
      demand(args.length === 2 && args[0] === '--summary' && Boolean(args[1]?.trim()), 'use regroup --summary <note>');
      session = recordRegroup(session, args[1], Date.now());
      await saveState(path, session);
      return 0;
    }
    if (verb === 'status') {
      demand(args.length === 0 || (args.length === 1 && args[0] === '--explain'), 'use status [--explain]');
      if (!args.length) { console.log(JSON.stringify(session, null, 2)); return 0; }
      let observed;
      try {
        observed = await captureSessionCandidate(cwd, undefined, {
          env, runGit: (root, ...gitArgs) => git(root, '--no-optional-locks', ...gitArgs),
        });
      } catch (error) { observed = { error: error.message }; }
      console.log(JSON.stringify(explainSession(session, observed, Date.now()), null, 2));
      return 0;
    }
    if (verb === 'verify-command') {
      const resource = args[0] === '--resource' ? args.splice(0, 2)[1] : undefined;
      demand(args.shift() === '--' && args[0], 'verify-command [--resource PROFILE] -- CMD ARGS...');
      return verifyCandidateCommand({ cwd, session, command: args[0], args: args.slice(1), resource, env });
    }
    const observed = await captureSessionCandidate(cwd, session.candidate.base, { env });
    demand(observed.clean, 'commit source changes before review', 'dirty');
    demand(['base', 'head', 'tree'].every(key => observed[key] === session.candidate[key]), 'candidate changed; prepare again', 'stale');
    if (verb === 'record') { session = recordReport(session, await boundedJson(args[0]), Date.now()); await saveState(path, session); return 0; }
    if (verb === 'defer') {
      const findingId = args.shift();
      let target; let decision; let reason;
      while (args.length) {
        const flag = args.shift();
        if (flag === '--to') target = args.shift();
        else if (flag === '--decision') decision = args.shift();
        else if (flag === '--reason') reason = args.shift();
        else demand(false, `unknown defer option: ${flag}`);
      }
      session = deferFinding(session, { findingId, target, decision, reason }, Date.now());
      await saveState(path, session);
      return 0;
    }
    await validateEconomySession(cwd, session);
    const decision = verdict(session, observed, Date.now()); demand(decision.ok, decision.reason, decision.code);
    if (verb === 'receipt') await assertMergePreflight(cwd, observed, { env });
    if (verb === 'receipt') console.log(receiptBody(receiptSummary(session, Number(args[0]), Date.now())));
    else console.log('reviewed');
    return 0;
  } finally { if (lock) { await lock.close(); await rm(join(directory, '.session.lock')); } }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) sessionMain().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
