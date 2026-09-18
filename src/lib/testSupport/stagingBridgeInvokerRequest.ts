import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The request a staging `pg_cron` bridge invoker actually builds, read out of SQL.
//
// The four bridges are two halves that never meet in one test. The SQL half -
// `private.invoke_*_scheduler()` - decides the method, the path and the headers.
// The Node half - `api/cron/**` - decides what it will accept. When the 2026-08-31
// retarget moved the SQL half's target from the Supabase Edge origin to this
// deployment's own routes, both halves stayed green while the bridge was broken:
// the sweep route was GET-only against a `net.http_post` caller, and the driver
// header that the removed Edge wrappers used to add was not carried into the
// invokers, so the omnipack jobs claimed their lease as `vercel_cron` and the
// ledger refused them as `inactive_driver`.
//
// So the contract suites that use this refuse to restate either half. They read
// what the invoker builds and drive the real route function with exactly that.
// Reading the LATEST defining migration rather than one pinned filename is
// deliberate: the next retarget is covered without editing anything, and a
// retarget that changes the request shape has to face those assertions.

const MIGRATIONS_DIR = "supabase/migrations";

export type InvokerRequest = {
  /** Filename of the migration the request was read from. */
  migration: string;
  method: "GET" | "POST";
  /** The route path segment appended to the configured `/api/cron` base. */
  path: string;
  headers: Record<string, string>;
};

/**
 * The request the named invoker builds, taken from the most recent migration that
 * defines it. `cronSecret` stands in for the vault value the body concatenates
 * into its bearer header.
 */
export function readInvokerRequest(invoker: string, cronSecret: string): InvokerRequest {
  const { migration, body } = latestDefinition(invoker);
  const verb = /\bnet\.http_(post|get)\s*\(/i.exec(body);
  if (!verb) throw new Error(`${invoker}: no net.http_post/net.http_get call found`);

  const path = /v_base_url\s*\|\|\s*'(\/[a-z0-9-]+)'/i.exec(body);
  if (!path) throw new Error(`${invoker}: no '<base> || /<route>' target expression found`);

  return {
    migration,
    method: verb[1].toLowerCase() === "post" ? "POST" : "GET",
    path: path[1],
    headers: readHeaderObject(invoker, body, cronSecret),
  };
}

/**
 * Node lower-cases inbound header names before a handler sees them, and the SQL
 * spells `Authorization` and `Content-Type` in title case. Modelling that here is
 * what keeps a contract test honest about which spelling the route actually reads.
 */
export function buildInvokerRequest(
  sent: InvokerRequest,
  overrides: Record<string, string> = {},
): { method: string; headers: Record<string, string>; query: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...sent.headers, ...overrides })) {
    headers[name.toLowerCase()] = value;
  }
  return { method: sent.method, headers, query: {} };
}

/** The body of the last migration (in filename order) that defines `invoker`. */
function latestDefinition(invoker: string): { migration: string; body: string } {
  const define = new RegExp(`create\\s+or\\s+replace\\s+function\\s+private\\.${invoker}\\s*\\(`, "i");
  const anyDefine = /create\s+or\s+replace\s+function\s+private\./i;
  const migrations = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  for (let index = migrations.length - 1; index >= 0; index -= 1) {
    const sql = readFileSync(join(MIGRATIONS_DIR, migrations[index]), "utf8");
    const start = define.exec(sql);
    if (!start) continue;
    const rest = sql.slice(start.index + start[0].length);
    const next = anyDefine.exec(rest);
    return { migration: migrations[index], body: next ? rest.slice(0, next.index) : rest };
  }
  throw new Error(`no migration defines private.${invoker}`);
}

/**
 * The header pairs the invoker builds. Only two value shapes are understood - a
 * plain literal and `'Bearer ' || <secret variable>` - and anything else throws
 * rather than being guessed at, because a header a contract cannot resolve is a
 * header it would silently stop testing.
 */
function readHeaderObject(invoker: string, body: string, cronSecret: string): Record<string, string> {
  const anchor = /(?:v_headers\s*:=|headers\s*:=)\s*jsonb_build_object\s*\(/i.exec(body);
  if (!anchor) throw new Error(`${invoker}: no headers := jsonb_build_object(...) found`);

  const parts = splitTopLevel(balanced(body, anchor.index + anchor[0].length - 1));
  if (parts.length === 0 || parts.length % 2 !== 0) {
    throw new Error(`${invoker}: header object has ${parts.length} arguments, expected key/value pairs`);
  }

  const headers: Record<string, string> = {};
  for (let index = 0; index < parts.length; index += 2) {
    const key = /^'([^']*)'$/.exec(parts[index]);
    if (!key) throw new Error(`${invoker}: header name ${parts[index]} is not a literal`);
    headers[key[1]] = resolveHeaderValue(invoker, parts[index + 1], cronSecret);
  }
  return headers;
}

function resolveHeaderValue(invoker: string, expression: string, cronSecret: string): string {
  const literal = /^'([^']*)'$/.exec(expression);
  if (literal) return literal[1];
  const bearer = /^'Bearer '\s*\|\|\s*[a-z_][a-z0-9_]*$/i.exec(expression);
  if (bearer) return `Bearer ${cronSecret}`;
  throw new Error(`${invoker}: header value ${expression} is not a shape this contract understands`);
}

/** The text inside the parenthesis group that opens at `open`. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  throw new Error("unbalanced parenthesis in migration body");
}

/** Split on commas that are not nested inside parentheses or a quoted literal. */
function splitTopLevel(argumentList: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of argumentList) {
    if (character === "'") quoted = !quoted;
    if (!quoted && character === "(") depth += 1;
    if (!quoted && character === ")") depth -= 1;
    if (!quoted && depth === 0 && character === ",") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}
