// Parity tooling for the managed pgTAP lane: per-assertion TAP comparison,
// the post-replay catalog snapshot, the environment fingerprint and the local
// sabotage switches. They remain the regression witness for the adapter after
// the Supabase CLI lane was retired. Nothing here changes the tested SQL.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// pg_prove --verbose prints `<path> ..` before each file's TAP stream and a
// verdict after it. Files are keyed by basename so the lanes' different
// scratch directories compare equal.
const FILE_HEADER = /^(\S+\.(?:sql|pg)) \.{2,}(?: (.*))?$/u;
const PLAN = /^1\.\.(\d+)(?:\s+#\s*(.*))?$/u;
// pgTAP always numbers its results; a bare `ok`/`Failed …` line is pg_prove's file verdict.
const RESULT = /^(not ok|ok) (\d+)(?:$|\s+-\s*|\s+)(.*)$/u;
const VERDICT = /^(?:ok|skipped:.*|Failed \d+\/\d+ subtests.*|All \d+ subtests passed.*|Dubious.*|No subtests run.*)$/u;

function splitDirective(text) {
  // A TAP directive is an unescaped `#` followed by SKIP or TODO.
  const match = /(^|[^\\])#\s*(SKIP|TODO)\b\s*(.*)$/iu.exec(text);
  if (!match) return { description: text.trim(), directive: "" };
  return {
    description: text.slice(0, match.index + match[1].length).trim(),
    directive: `${match[2].toUpperCase()} ${match[3].trim()}`.trim(),
  };
}

/** Parse a pg_prove --verbose log into ordered per-file assertion records. */
export function parseTapLog(text) {
  const files = new Map();
  let current;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/\s+$/u, "");
    const header = FILE_HEADER.exec(line);
    if (header) {
      const name = header[1].split("/").at(-1);
      if (files.has(name)) throw new Error(`duplicate TAP file entry: ${name}`);
      current = { plan: null, planDirective: "", assertions: [], verdict: (header[2] ?? "").trim() };
      files.set(name, current);
      continue;
    }
    // Diagnostics (`#`), indented subtest output and summary lines are not compared.
    if (!current || line === "" || /^\s/u.test(line)) continue;
    const plan = PLAN.exec(line);
    if (plan && current.plan === null) {
      current.plan = Number(plan[1]);
      current.planDirective = (plan[2] ?? "").trim();
      continue;
    }
    const result = RESULT.exec(line);
    if (result) {
      const { description, directive } = splitDirective(result[3]);
      current.assertions.push({ ok: result[1] === "ok", number: Number(result[2]), description, directive });
      continue;
    }
    if (VERDICT.test(line)) current.verdict = line;
  }
  return files;
}

const show = value => value
  ? `${value.ok ? "ok" : "not ok"} ${value.number} - ${value.description}${value.directive ? ` # ${value.directive}` : ""}`
  : "(missing)";

/** Deterministic per-file comparison; returns readable differences (empty = identical). */
export function compareTapLogs(left, right, labels = ["left", "right"]) {
  const differences = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(name);
    const b = right.get(name);
    if (!a || !b) {
      differences.push(`${name}: present only in ${a ? labels[0] : labels[1]}`);
      continue;
    }
    if (a.plan !== b.plan || a.planDirective !== b.planDirective) {
      differences.push(`${name}: plan ${a.plan}${a.planDirective ? ` # ${a.planDirective}` : ""} != ${b.plan}${b.planDirective ? ` # ${b.planDirective}` : ""}`);
    }
    for (let index = 0; index < Math.max(a.assertions.length, b.assertions.length); index++) {
      const x = a.assertions[index];
      const y = b.assertions[index];
      if (!x || !y || x.ok !== y.ok || x.number !== y.number || x.description !== y.description || x.directive !== y.directive) {
        differences.push(`${name} #${index + 1}: ${labels[0]} ${show(x)} | ${labels[1]} ${show(y)}`);
      }
    }
  }
  return differences;
}

export function summariseTap(files) {
  const summary = { files: files.size, assertions: 0, notOk: 0, directives: 0, filesWithoutPlan: 0 };
  for (const file of files.values()) {
    summary.assertions += file.assertions.length;
    summary.notOk += file.assertions.filter(item => !item.ok).length;
    summary.directives += file.assertions.filter(item => item.directive).length;
    if (file.plan === null) summary.filesWithoutPlan += 1;
  }
  return summary;
}

// Each query returns (section, item) rows of normalised text, so two lanes
// compare by exact set equality. An empty search_path makes every deparsed
// name schema-qualified identically.
// Byte order (COLLATE "C"): the lanes' libc collations order punctuation differently.
const acl = expression => `coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text COLLATE "C") FROM unnest(${expression}) a), '-')`;

/** Post-replay contract of `public` and `private`, plus triggers on and foreign keys into `auth`. */
export const CATALOG_SNAPSHOT_SQL = `
SET search_path = '';
WITH s AS (SELECT oid, nspname FROM pg_namespace WHERE nspname IN ('public', 'private'))
SELECT section, item FROM (
  SELECT 'schema' AS section, n.nspname || ' owner=' || pg_get_userbyid(n.nspowner) || ' acl=' || ${acl("n.nspacl")} AS item
    FROM pg_namespace n JOIN s ON s.oid = n.oid
  UNION ALL
  SELECT 'relation', s.nspname || '.' || c.relname || ' kind=' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner)
      || ' rls=' || c.relrowsecurity || '/' || c.relforcerowsecurity || ' acl=' || ${acl("c.relacl")}
      || ' options=' || coalesce(array_to_string(c.reloptions, ','), '-')
    FROM pg_class c JOIN s ON s.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT 'column', s.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || ' notnull=' || a.attnotnull || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
      || ' generated=' || a.attgenerated::text || ' identity=' || a.attidentity::text || ' collation=' || a.attcollation::regcollation::text
      || ' acl=' || ${acl("a.attacl")}
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN s ON s.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  UNION ALL
  SELECT 'constraint', s.nspname || '.' || c.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid, true)
      || ' deferrable=' || con.condeferrable || '/' || con.condeferred
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN s ON s.oid = c.relnamespace
  UNION ALL
  SELECT 'index', pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN s ON s.oid = c.relnamespace
  UNION ALL
  SELECT 'view', s.nspname || '.' || c.relname || ' md5=' || md5(pg_get_viewdef(c.oid, true))
    FROM pg_class c JOIN s ON s.oid = c.relnamespace WHERE c.relkind IN ('v', 'm')
  UNION ALL
  SELECT 'function', p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner) || ' secdef=' || p.prosecdef
      || ' volatility=' || p.provolatile::text || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-') || ' acl=' || ${acl("p.proacl")}
      || ' md5=' || md5(CASE WHEN p.prokind = 'a' THEN p.oid::regprocedure::text ELSE pg_get_functiondef(p.oid) END)
    FROM pg_proc p JOIN s ON s.oid = p.pronamespace
  UNION ALL
  SELECT 'policy', schemaname || '.' || tablename || ' ' || policyname || ' ' || permissive || ' ' || cmd
      || ' roles=' || array_to_string(ARRAY(SELECT unnest(roles) ORDER BY 1), ',')
      || ' using=' || coalesce(qual, '-') || ' check=' || coalesce(with_check, '-')
    FROM pg_policies WHERE schemaname IN ('public', 'private')
  UNION ALL
  SELECT 'trigger', pg_get_triggerdef(t.oid, true) || ' enabled=' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND (n.nspname IN ('public', 'private') OR (n.nspname = 'auth' AND c.relname = 'users'))
  UNION ALL
  SELECT 'type', s.nspname || '.' || t.typname || ' ' || t.typtype::text || ' owner=' || pg_get_userbyid(t.typowner)
      || ' labels=' || coalesce((SELECT string_agg(e.enumlabel::text, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '-')
      || ' acl=' || ${acl("t.typacl")}
    FROM pg_type t JOIN s ON s.oid = t.typnamespace
    WHERE t.typtype IN ('e', 'd') OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
  UNION ALL
  SELECT 'auth-fk', con.conrelid::regclass::text || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid, true)
    FROM pg_constraint con JOIN pg_class r ON r.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = r.relnamespace
    JOIN pg_class c ON c.oid = con.conrelid JOIN s ON s.oid = c.relnamespace
    WHERE con.contype = 'f' AND rn.nspname = 'auth'
) rows ORDER BY section, item;
`;

const namedRoles = "('postgres', 'anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin', 'supabase_auth_admin', 'openlup_mcp_reader')";

/** Environment the tests run in: server, roles, settings, grants on auth/extensions/cron, extensions. */
export const ENVIRONMENT_FINGERPRINT_SQL = `
SELECT 'setting', 'search_path=' || current_setting('search_path');
SET search_path = '';
SELECT section, item FROM (
  SELECT 'server' AS section, 'version_num=' || current_setting('server_version_num') AS item
  UNION ALL
  SELECT 'setting', name || '=' || setting FROM pg_settings
    WHERE name IN ('TimeZone', 'DateStyle', 'IntervalStyle', 'lc_messages', 'lc_monetary', 'lc_numeric', 'lc_time',
      'server_encoding', 'standard_conforming_strings', 'statement_timeout', 'lock_timeout',
      'idle_in_transaction_session_timeout', 'default_transaction_isolation', 'extra_float_digits',
      'row_security', 'check_function_bodies', 'password_encryption', 'cron.database_name',
      'shared_preload_libraries', 'default_text_search_config', 'bytea_output', 'jit', 'session_preload_libraries')
  UNION ALL
  SELECT 'database', datname || ' encoding=' || pg_encoding_to_char(encoding) || ' collate=' || datcollate || ' ctype=' || datctype
      || ' provider=' || datlocprovider::text || ' locale=' || coalesce(datlocale, '-') || ' icurules=' || coalesce(daticurules, '-')
      || ' collversion=' || coalesce(datcollversion, '-') || ' owner=' || pg_get_userbyid(datdba) || ' acl=' || ${acl("datacl")}
    FROM pg_database WHERE datname = current_database()
  UNION ALL
  SELECT 'role', rolname || ' super=' || rolsuper || ' inherit=' || rolinherit || ' createrole=' || rolcreaterole
      || ' createdb=' || rolcreatedb || ' login=' || rolcanlogin || ' replication=' || rolreplication
      || ' bypassrls=' || rolbypassrls || ' config=' || coalesce(array_to_string(rolconfig, ','), '-')
    FROM pg_roles WHERE rolname !~ '^pg_'
  UNION ALL
  SELECT 'membership', pg_get_userbyid(m.roleid) || ' > ' || pg_get_userbyid(m.member) || ' admin=' || m.admin_option
      || ' inherit=' || m.inherit_option || ' set=' || m.set_option
    FROM pg_auth_members m WHERE pg_get_userbyid(m.member) IN ${namedRoles} OR pg_get_userbyid(m.roleid) IN ${namedRoles}
  UNION ALL
  SELECT 'role-setting', coalesce(d.datname, '*') || ' ' || coalesce(pg_get_userbyid(nullif(s.setrole, 0)), '*') || ' ' || array_to_string(s.setconfig, ',')
    FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase
  UNION ALL
  SELECT 'default-acl', pg_get_userbyid(a.defaclrole) || ' ' || coalesce(n.nspname, '*') || ' ' || a.defaclobjtype::text || ' ' || ${acl("a.defaclacl")}
    FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid = a.defaclnamespace
  UNION ALL
  SELECT 'schema', n.nspname || ' owner=' || pg_get_userbyid(n.nspowner) || ' acl=' || ${acl("n.nspacl")}
    FROM pg_namespace n WHERE n.nspname IN ('auth', 'extensions', 'cron', 'public', 'private')
  UNION ALL
  SELECT 'extension', e.extname || ' ' || e.extversion || ' schema=' || n.nspname || ' owner=' || pg_get_userbyid(e.extowner)
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  UNION ALL
  SELECT 'relation', n.nspname || '.' || c.relname || ' kind=' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner)
      || ' rls=' || c.relrowsecurity || ' acl=' || ${acl("c.relacl")}
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('auth', 'cron', 'extensions') AND c.relkind IN ('r', 'p', 'v', 'S')
  UNION ALL
  SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
      || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'auth' AND c.relname IN ('users', 'identities') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'auth-constraint', con.conrelid::regclass::text || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid, true)
    FROM pg_constraint con WHERE con.conrelid IN (to_regclass('auth.users'), to_regclass('auth.identities'))
  UNION ALL
  SELECT 'parameter-acl', parname || ' ' || ${acl("paracl")} FROM pg_parameter_acl
  UNION ALL
  SELECT 'auth-index', pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid IN (to_regclass('auth.users'), to_regclass('auth.identities'))
  UNION ALL
  SELECT 'policy', schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' roles=' || array_to_string(roles, ',')
      || ' using=' || coalesce(qual, '-') FROM pg_policies WHERE schemaname IN ('auth', 'cron')
  UNION ALL
  SELECT 'auth-function', p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner) || ' acl=' || ${acl("p.proacl")}
      || ' definition=' || pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'auth' AND p.proname IN ('uid', 'role', 'jwt', 'email')
  UNION ALL
  SELECT 'function-acl', p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner) || ' secdef=' || p.prosecdef || ' acl=' || ${acl("p.proacl")}
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('auth', 'cron')
) rows ORDER BY section, item;
`;

/** Run one (section, item) query in a container through its own psql over TCP. */
export function captureRows(container, sql, { user = "postgres", password = "postgres" } = {}) {
  const result = spawnSync("docker", ["exec", "-i", "-e", `PGPASSWORD=${password}`, container, "psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-h", "127.0.0.1", "-U", user, "-d", "postgres", "-Atq", "-F", "\t", "-R", "\u001e"], { input: sql, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`catalog capture failed in ${container}: ${result.stderr || result.error?.message}`);
  return parseRows(result.stdout);
}

export function parseRows(output) {
  return output.split("\u001e").map(row => row.replace(/^\n+|\n+$/gu, "")).filter(Boolean).map(row => {
    const tab = row.indexOf("\t");
    if (tab < 0) throw new Error(`malformed captured row: ${row.slice(0, 80)}`);
    return { section: row.slice(0, tab), item: row.slice(tab + 1) };
  });
}

/** Set difference of two captured row lists: `-` left only, `+` right only. */
export function diffRows(left, right) {
  const key = row => `${row.section}\t${row.item}`;
  const a = new Set(left.map(key));
  const b = new Set(right.map(key));
  return [
    ...[...a].filter(row => !b.has(row)).map(row => `- ${row}`),
    ...[...b].filter(row => !a.has(row)).map(row => `+ ${row}`),
  ].sort((x, y) => x.slice(2).localeCompare(y.slice(2)) || x.localeCompare(y));
}

// Local sabotage switches, applied by a superuser after replay. Each must make
// the run fail; none is committed SQL in the shipped test tree. The last two
// change server or connection setup, so their SQL is empty.
export const SABOTAGE = Object.freeze({
  "auth-uid-null": "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;",
  "drop-rls-policy": "DROP POLICY customer_select_addresses ON public.addresses;",
  "revoke-service-role-grant": "REVOKE ALL ON TABLE public.clients FROM service_role;",
  "no-pg-cron": "",
  "wrong-dblink-password": "",
});

export function sabotageSql(name) {
  if (name === undefined) return "";
  if (!Object.hasOwn(SABOTAGE, name)) throw new Error(`unknown sabotage: ${name}; expected one of ${Object.keys(SABOTAGE).join(", ")}`);
  return SABOTAGE[name];
}

function compareCommand([leftPath, rightPath]) {
  if (!leftPath || !rightPath) throw new Error("usage: pgtap-parity.mjs compare <left.log> <right.log>");
  const left = parseTapLog(readFileSync(leftPath, "utf8"));
  const right = parseTapLog(readFileSync(rightPath, "utf8"));
  console.log(`left  ${leftPath} ${JSON.stringify(summariseTap(left))}`);
  console.log(`right ${rightPath} ${JSON.stringify(summariseTap(right))}`);
  if (left.size === 0 || right.size === 0) {
    console.log("TAP parity: an input contains no test file");
    return 1;
  }
  const differences = compareTapLogs(left, right, ["left", "right"]);
  for (const line of differences) console.log(line);
  console.log(differences.length === 0 ? "TAP parity: identical" : `TAP parity: ${differences.length} difference(s)`);
  return differences.length === 0 ? 0 : 1;
}

function diffCommand([leftPath, rightPath]) {
  if (!leftPath || !rightPath) throw new Error("usage: pgtap-parity.mjs diff <left.json> <right.json>");
  const differences = diffRows(JSON.parse(readFileSync(leftPath, "utf8")), JSON.parse(readFileSync(rightPath, "utf8")));
  for (const line of differences) console.log(line);
  console.log(differences.length === 0 ? "rows identical" : `${differences.length} differing row(s)`);
  return differences.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "compare") process.exitCode = compareCommand(rest);
    else if (command === "diff") process.exitCode = diffCommand(rest);
    else throw new Error("usage: pgtap-parity.mjs compare <left.log> <right.log> | diff <left.json> <right.json>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
