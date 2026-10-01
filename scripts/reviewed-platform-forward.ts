import { createHash } from "node:crypto";
import { documentationGit } from "./documentation-git.ts";

export const REVIEWED_FORWARD_PATH = "config/reviewed-platform-forwards.json";
export const MANAGED_BASELINE = "supabase/migrations/00000000000000_platform_schema_baseline.sql";
const replacements = new Set([
  "public.commerce_offer_policy_v2_readiness()",
  "public.subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb)",
  "public.subscription_apply_starter_graduation(uuid,text,text)",
]);
const creations = new Set([
  "public.catalog_price_setup_preview(uuid,uuid,integer)",
  "public.catalog_price_setup_apply(text,text)",
]);
type FunctionBinding = { signature: string; beforeSha256: string | null; afterSha256: string };
type ForwardBinding = { path: string; sha256: string; functions: FunctionBinding[] };
export type ReviewedForwardRegistry = { schemaVersion: 1; baselineSha256: string; replacementForwards: ForwardBinding[]; creationForwards: ForwardBinding[] };
export const sqlSha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export function readReviewedForwardRegistry(bytes: Buffer): ReviewedForwardRegistry {
  const raw = JSON.parse(bytes.toString("utf8")) as ReviewedForwardRegistry;
  if (raw.schemaVersion !== 1 || !hash(raw.baselineSha256) || !Array.isArray(raw.replacementForwards) || raw.replacementForwards.length !== 2 || !Array.isArray(raw.creationForwards) || raw.creationForwards.length !== 1) throw new Error("reviewed replacement registry requires one baseline, two replacement forwards and one creation forward");
  const paths = new Set<string>(), signatures = new Set<string>(), replaced = new Set<string>();
  for (const forward of [...raw.replacementForwards, ...raw.creationForwards]) {
    if (!/^supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(forward.path) || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length === 0) throw new Error("reviewed replacement registry has an invalid or duplicate forward");
    paths.add(forward.path);
    for (const binding of forward.functions) {
      if (!/^public\.[a-z_][a-z0-9_]*\((?:(?:uuid|text|jsonb|integer)(?:,(?:uuid|text|jsonb|integer))*)?\)$/u.test(binding.signature) || signatures.has(binding.signature) || !hash(binding.afterSha256) || (binding.beforeSha256 !== null && !hash(binding.beforeSha256))) throw new Error("reviewed replacement registry has an invalid or duplicate signature");
      if ((binding.beforeSha256 === null) !== raw.creationForwards.includes(forward)) throw new Error("reviewed replacement and creation approvals must remain separate");
      signatures.add(binding.signature);
      if (binding.beforeSha256 !== null) replaced.add(binding.signature);
    }
  }
  if (replaced.size !== replacements.size || [...replacements].some((signature) => !replaced.has(signature))) throw new Error("reviewed replacement registry must bind exactly the three approved existing signatures");
  if (signatures.size !== replacements.size + creations.size || [...creations].some((signature) => !signatures.has(signature) || replaced.has(signature))) throw new Error("reviewed replacement registry must also bind exactly the two companion creations");
  return raw;
}

/** Split top-level SQL only. Comments, quoted literals and dollar bodies cannot introduce statements. */
function sqlStatements(sql: string, dump = false): string[] {
  const statements: string[] = [];
  let start = -1;
  for (let index = 0; index < sql.length;) {
    if (/\s/u.test(sql[index]!)) { index++; continue; }
    if (dump && start < 0 && sql[index] === "\\") {
      const command = /^\\(?:un)?restrict [A-Za-z0-9]+(?:\r?\n|$)/u.exec(sql.slice(index))?.[0];
      if (!command) throw new Error("reviewed replacement baseline has an unsupported dump command");
      index += command.length; continue;
    }
    if (sql.startsWith("--", index)) { const end = sql.indexOf("\n", index); index = end < 0 ? sql.length : end; continue; }
    if (sql.startsWith("/*", index)) {
      let depth = 1; index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) { depth++; index += 2; }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) throw new Error("reviewed replacement SQL has an unterminated comment");
      continue;
    }
    if (start < 0) start = index;
    const quote = sql[index];
    if (quote === "'" || quote === '"') {
      index++; let closed = false;
      while (index < sql.length) {
        if (sql[index] === "\\") { index += 2; continue; }
        if (sql[index++] === quote) { if (sql[index] === quote) { index++; continue; } closed = true; break; }
      }
      if (!closed) throw new Error("reviewed replacement SQL has an unterminated literal");
      continue;
    }
    const tag = sql[index] === "$" ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0] : undefined;
    if (tag) {
      const end = sql.indexOf(tag, index + tag.length);
      if (end < 0) throw new Error("reviewed replacement SQL has an unterminated body");
      index = end + tag.length; continue;
    }
    if (sql[index++] === ";") { statements.push(sql.slice(start, index)); start = -1; }
  }
  if (start >= 0) throw new Error("reviewed replacement SQL requires terminated statements");
  return statements;
}

/** Hash the raw CREATE statement, including its terminating semicolon; argument names/defaults are not identity. */
function functionSignature(name: string, argumentsText: string): string {
  const types = argumentsText.trim() === "" ? [] : argumentsText.split(",").map((argument) => {
    const match = /^(?:[a-z_][a-z0-9_]* )?(uuid|text|jsonb|integer)(?: DEFAULT [\s\S]+)?$/iu.exec(argument.trim());
    if (!match) throw new Error("reviewed replacement has an unsupported argument identity");
    return match[1]!.toLowerCase();
  });
  return `${name.toLowerCase()}(${types.join(",")})`;
}

export function reviewedFunctionDefinitions(bytes: Buffer, names?: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const statement of sqlStatements(bytes.toString("utf8"), names !== undefined)) {
    const prefix = /^CREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(/iu.exec(statement);
    if (!prefix || (names && !names.has(prefix[1]!.toLowerCase()))) continue;
    const header = /^CREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\) RETURNS /iu.exec(statement);
    if (!header) throw new Error("reviewed replacement has an unsupported function header");
    const signature = functionSignature(header[1]!, header[2]!);
    if (result.has(signature)) throw new Error(`reviewed replacement has a duplicate signature: ${signature}`);
    result.set(signature, sqlSha256(statement));
  }
  return result;
}

/** Fixed function forwards may only define functions and set privileges/comments on those definitions. */
function assertFunctionStatements(bytes: Buffer, definitions: Map<string, string>): void {
  for (const statement of sqlStatements(bytes.toString("utf8"))) {
    if (/^(?:BEGIN|COMMIT);$/iu.test(statement)) continue;
    if (/^CREATE(?: OR REPLACE)? FUNCTION public\.[a-z_][a-z0-9_]*\(/iu.test(statement)) continue;
    const privilege = /^(GRANT (?:EXECUTE|ALL) ON FUNCTION|REVOKE (?:EXECUTE|ALL) ON FUNCTION) (public\.[a-z_][a-z0-9_]*)\(([^)]*)\) (TO|FROM) ([a-z_, ]+);$/iu.exec(statement);
    if (privilege) {
      const grant = privilege[1]!.toUpperCase().startsWith("GRANT");
      const roles = privilege[5]!.split(",").map((role) => role.trim().toLowerCase());
      if (privilege[4]!.toUpperCase() === (grant ? "TO" : "FROM") && definitions.has(functionSignature(privilege[2]!, privilege[3]!)) && roles.every((role) => (grant ? ["authenticated", "service_role"] : ["public", "anon", "authenticated", "service_role"]).includes(role))) continue;
    }
    const comment = /^COMMENT ON FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\) IS '(?:[^']|'')*';$/iu.exec(statement);
    if (comment && definitions.has(functionSignature(comment[1]!, comment[2]!))) continue;
    throw new Error("reviewed replacement refuses an unrelated statement, schema or function privilege");
  }
}

const git = (root: string, args: string[]) => documentationGit(root, args);
function blob(root: string, revision: string, path: string): Buffer | undefined {
  const listing = git(root, ["ls-tree", "-z", revision, "--", path]).toString("utf8");
  if (!listing) return undefined;
  const match = /^100644 blob ([a-f0-9]{40})\t[^\0]+\0$/u.exec(listing);
  if (!match) throw new Error(`reviewed replacement requires a regular file: ${path}`);
  return git(root, ["cat-file", "blob", match[1]!]);
}

export function assertUnchangedForwardApproval(root: string, base: string, head: string): void {
  const before = blob(root, base, REVIEWED_FORWARD_PATH), after = blob(root, head, REVIEWED_FORWARD_PATH);
  if (!before || !after || !before.equals(after)) throw new Error("reviewed replacement allowlist must be approved separately before a feature PR adds SQL");
}

/** Both required CI and release preparation use this exact path/byte/signature check. */
export function assertReviewedPlatformForward(root: string, base: string, head: string, path: string, bytes: Buffer, release = false): void {
  const targetRegistry = blob(root, head, REVIEWED_FORWARD_PATH);
  if (!targetRegistry) throw new Error(`non-expand-only forward has no reviewed replacement approval: ${path}`);
  const registry = readReviewedForwardRegistry(targetRegistry);
  const forward = [...registry.replacementForwards, ...registry.creationForwards].find((entry) => entry.path === path);
  if (!forward || sqlSha256(bytes) !== forward.sha256) throw new Error(`non-expand-only forward differs from reviewed replacement path or bytes: ${path}`);
  let approval = base;
  if (release) {
    // A preview can include the earlier control PR and later feature PRs. The approval must
    // already exist in the parent of the commit that first introduces each SQL file.
    const commits = git(root, ["log", "--format=%H", "--diff-filter=A", `${base}..${head}`, "--", path]).toString("utf8").trim().split("\n").filter(Boolean);
    if (commits.length !== 1) throw new Error("reviewed replacement requires one unambiguous forward introduction");
    approval = git(root, ["rev-parse", `${commits[0]}^`]).toString("utf8").trim();
    git(root, ["merge-base", "--is-ancestor", approval, head]);
  }
  assertUnchangedForwardApproval(root, approval, head);
  const baseline = blob(root, approval, MANAGED_BASELINE);
  if (!baseline || sqlSha256(baseline) !== registry.baselineSha256) throw new Error("reviewed replacement immutable baseline drifted");
  const names = new Set(forward.functions.map(({ signature }) => signature.split("(")[0]!));
  const prior = reviewedFunctionDefinitions(baseline, names);
  const paths = git(root, ["ls-tree", "-r", "--name-only", head, "--", "supabase/migrations/"]).toString("utf8").trim().split("\n").filter((item) => item !== MANAGED_BASELINE && item < path).sort();
  for (const priorPath of paths) for (const [signature, sha256] of reviewedFunctionDefinitions(blob(root, head, priorPath)!, names)) prior.set(signature, sha256);
  const definitions = reviewedFunctionDefinitions(bytes);
  assertFunctionStatements(bytes, definitions);
  if (definitions.size !== forward.functions.length) throw new Error("reviewed replacement has missing or additional function signatures");
  for (const binding of forward.functions) {
    if (definitions.get(binding.signature) !== binding.afterSha256 || (prior.get(binding.signature) ?? null) !== binding.beforeSha256) throw new Error(`reviewed replacement definition drifted: ${binding.signature}`);
  }
}
