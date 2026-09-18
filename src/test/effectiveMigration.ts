import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the migration that is *currently effective* for a SQL object, rather
 * than the migration that first introduced it.
 *
 * Why this exists: a `CREATE OR REPLACE FUNCTION` in a later migration replaces
 * the whole body. A boundary test that reads the introducing migration by a
 * hardcoded path therefore keeps passing while asserting text that no longer
 * describes anything the database executes. The assertion survives; its meaning
 * does not. Resolving the newest definition instead makes the proof track the
 * deployed behaviour.
 *
 * Resolution is by function NAME, not by signature: an overload set is treated
 * as one object, which is what the boundary claims (`fn is service-role-only`)
 * actually mean. A name whose newest `DROP FUNCTION` is newer than its newest
 * definition throws rather than returning a body that no longer exists.
 */

const MIGRATIONS_DIR = "supabase/migrations";

export type Migration = { readonly file: string; readonly content: string };

let cached: readonly Migration[] | null = null;

/** Every migration in the tree, oldest first (filenames are timestamp-ordered). */
export function allMigrations(): readonly Migration[] {
  if (cached) return cached;
  const dir = join(process.cwd(), MIGRATIONS_DIR);
  cached = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      file: `${MIGRATIONS_DIR}/${name}`,
      content: readFileSync(join(dir, name), "utf8"),
    }));
  return cached;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function definitionPattern(functionName: string): RegExp {
  return new RegExp(
    `^[ \\t]*CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${escapeRegExp(functionName)}\\s*\\(`,
    "im",
  );
}

function dropPattern(functionName: string): RegExp {
  return new RegExp(
    `^[ \\t]*DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?${escapeRegExp(functionName)}\\b`,
    "im",
  );
}

function grantPattern(functionName: string): RegExp {
  return new RegExp(
    `^[ \\t]*(?:GRANT|REVOKE)\\b[\\s\\S]*?\\bFUNCTION\\s+(?:public\\.)?${escapeRegExp(functionName)}\\s*\\(`,
    "im",
  );
}

/** Every migration that defines `functionName`, oldest first. */
export function migrationsDefining(functionName: string): readonly string[] {
  const pattern = definitionPattern(functionName);
  return allMigrations().filter((m) => pattern.test(m.content)).map((m) => m.file);
}

/** Every migration that issues GRANT/REVOKE on `functionName`, oldest first. */
export function migrationsGranting(functionName: string): readonly string[] {
  const pattern = grantPattern(functionName);
  return allMigrations().filter((m) => pattern.test(m.content)).map((m) => m.file);
}

function newestMatch(functionName: string, pattern: RegExp, what: string): Migration {
  const matches = allMigrations().filter((m) => pattern.test(m.content));
  const newest: Migration | undefined = matches[matches.length - 1];
  if (!newest) throw new Error(`no migration ${what} public.${functionName}`);
  return newest;
}

/** The newest migration that defines `functionName`. */
export function effectiveDefinitionMigration(functionName: string): Migration {
  const newest = newestMatch(functionName, definitionPattern(functionName), "defines");
  const drops = allMigrations().filter((m) => dropPattern(functionName).test(m.content));
  const newestDrop: Migration | undefined = drops[drops.length - 1];
  if (newestDrop && newestDrop.file > newest.file) {
    throw new Error(
      `public.${functionName} is dropped by ${newestDrop.file}, newer than its last definition ${newest.file}`,
    );
  }
  return newest;
}

/** The newest migration that grants or revokes on `functionName`. */
export function effectiveGrantMigration(functionName: string): Migration {
  return newestMatch(functionName, grantPattern(functionName), "grants on");
}

/**
 * The full `CREATE [OR REPLACE] FUNCTION` statement that is effective today,
 * body included — the text the database actually runs, isolated from whatever
 * else its migration happens to ship.
 */
export function effectiveFunctionBody(functionName: string): string {
  const migration = effectiveDefinitionMigration(functionName);
  const start = migration.content.search(definitionPattern(functionName));
  const rest = migration.content.slice(start);
  const opener = /\bAS\s+\$(\w*)\$/.exec(rest);
  if (!opener) throw new Error(`public.${functionName} in ${migration.file} has no dollar-quoted body`);
  const tag = `$${opener[1]}$`;
  const bodyEnd = rest.indexOf(tag, opener.index + opener[0].length);
  if (bodyEnd < 0) throw new Error(`public.${functionName} in ${migration.file} has an unterminated body`);
  const terminator = rest.indexOf(";", bodyEnd + tag.length);
  return rest.slice(0, terminator < 0 ? rest.length : terminator + 1);
}

/** Every function name in the migration corpus starting with `prefix`, sorted. */
export function functionNamesWithPrefix(prefix: string): readonly string[] {
  const pattern = new RegExp(
    `^[ \\t]*CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?(${escapeRegExp(prefix)}\\w*)\\s*\\(`,
    "gim",
  );
  const names = new Set<string>();
  for (const migration of allMigrations()) {
    for (const match of migration.content.matchAll(pattern)) names.add(match[1]);
  }
  return [...names].sort();
}
