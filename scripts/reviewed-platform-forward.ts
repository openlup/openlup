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
type PolicyBinding = { table: string; name: string; beforeSha256: string };
type RuntimeForwardBinding = ForwardBinding & { privileges: string[]; retiredPolicies?: PolicyBinding[] };
type ForwardBinding = { path: string; sha256: string; functions: FunctionBinding[] };
export type ReviewedForwardRegistry = { schemaVersion: 1; baselineSha256: string; replacementForwards: ForwardBinding[]; creationForwards: ForwardBinding[]; runtimeForwards?: RuntimeForwardBinding[] };
export const sqlSha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const runtimeReplacements = new Set([
  "public.admin_clients_search_v3(text,integer,integer,text)",
  "public.subscription_list_due_for_renewal(integer,timestamp with time zone)",
  "public.customer_support_absorb_lead_v1(uuid,uuid,uuid,text,text,timestamp with time zone)",
  "public.marketing_rehome_client_lead_v1(uuid,timestamp with time zone)",
  "public.customer_support_correct_subject_email_v1(uuid,uuid,text,text,text,timestamp with time zone)",
]);
// Only the legacy browser policies activated by membership reads may be retired.
const runtimeRetiredPolicies = new Map([
  ["address_canon_localities", "admin_all_address_canon_localities"],
  ["address_canon_postal_localities", "admin_all_address_canon_postal_localities"],
  ["address_canon_streets", "admin_all_address_canon_streets"],
  ["addresses", "admin_all_addresses"],
  ["clients", "admin_all_clients"],
  ["customer_account_events", "admin_all_customer_account_events"],
  ["customer_orderer_profiles", "admin_all_customer_orderer_profiles"],
  ["pets", "admin_all_pets"],
]);
const runtimeExecutions = new Set([
  "public.record_admin_audit_event(uuid,text,text,text,text,jsonb,jsonb,text,text,uuid,text)",
  "public.subscription_current_template_snapshot(uuid)",
  "public.commerce_oms_normalize_search_text(text)",
  "public.commerce_oms_normalize_search_digits(text)",
]);
// These column sets are fixed by the reviewed runtime consumers, never supplied by the registry.
const runtimeColumns: Record<string, ReadonlySet<string>> = {
  admin_users: new Set(["id", "membership_state", "role", "is_machine_actor"]),
  platform_communication_operators: new Set(["principal_id", "active"]),
  email_sends: new Set(["status", "template_slug"]),
  email_events: new Set(["event_type"]),
  subscriptions: new Set(["id", "client_id", "cadence_days", "template_version", "currency", "region_code", "payment_method_kind", "status", "next_cycle_at", "updated_at"]),
  clients: new Set(["id", "email", "first_name", "last_name", "phone", "identity_kind", "lifecycle_stage", "created_at", "updated_at", "acquisition_source", "auth_user_id", "metadata", "marketing_contact_id"]),
  commerce_payment_method_refs: new Set(["subscription_id", "provider_kind", "provider_customer_ref", "provider_method_ref", "method_kind", "status", "active", "expires_at", "client_id", "updated_at", "created_at"]),
  subscription_cycles: new Set(["subscription_id", "status", "next_retry_at", "scheduled_at", "renewal_quarantined_until"]),
  catalog_products: new Set(["id", "slug", "status", "name", "description", "ingredients", "allergens", "marketing_content", "primary_sku_id"]),
  catalog_skus: new Set(["id", "product_id", "sku", "title", "pet_type", "status", "net_weight_g", "format_code", "unit_form_code", "is_addon", "sellable_standalone", "sellable_in_subscription", "requires_pet_profile", "min_order_qty"]),
  subscription_events: new Set(["subscription_id", "event_type", "occurred_at"]),
  commerce_carts: new Set(["client_id"]),
  commerce_checkout_sessions: new Set(["client_id"]),
  customer_delivery_preferences: new Set(["client_id"]),
  customer_external_refs: new Set(["client_id"]),
  customer_orderer_profiles: new Set(["client_id"]),
  customer_payment_preferences: new Set(["client_id"]),
  pets: new Set(["client_id"]),
  promotion_code_claims: new Set(["client_id"]),
  promotion_redemptions: new Set(["client_id"]),
  client_consents: new Set(["client_id", "consent_type", "captured_at"]),
  client_source_links: new Set(["client_id"]),
  customer_personalization: new Set(["client_id"]),
  commerce_orders: new Set(["id", "client_id", "order_number", "status", "created_at", "updated_at"]),
};
// Writes are limited to existing invoker mutations and updated_at on subscriptions for renewal row locking.
const runtimeUpdateColumns: Record<string, ReadonlySet<string>> = {
  subscriptions: new Set(["updated_at"]),
  clients: new Set(["email", "identity_kind", "marketing_contact_id", "metadata", "updated_at"]),
  client_consents: new Set(["client_id"]),
  client_source_links: new Set(["client_id"]),
  customer_personalization: new Set(["client_id"]),
};
const runtimeBrowserColumns: Record<string, ReadonlySet<string>> = {
  clients: new Set(["id", "auth_user_id", "email", "first_name", "last_name", "phone", "lifecycle_stage"]),
  admin_users: new Set(["id", "role", "membership_state", "email", "is_machine_actor", "created_at"]),
};
const runtimeBrowserExecutions = new Set([
  "public.commerce_oms_normalize_search_text(text)",
  "public.commerce_oms_normalize_search_digits(text)",
]);
function runtimePrivilegeKeys(statement: string): string[] {
  const columnGrant = /^GRANT (SELECT|UPDATE) \(([a-z_, ]+)\) ON public\.([a-z_]+) TO (service_role|authenticated);$/u.exec(statement);
  if (columnGrant) {
    const operation = columnGrant[1]!;
    const columns = columnGrant[2]!.split(",").map((column) => column.trim());
    const recipient = columnGrant[4]!;
    const allowed = (recipient === "authenticated" ? (operation === "SELECT" ? runtimeBrowserColumns : {}) : (operation === "SELECT" ? runtimeColumns : runtimeUpdateColumns))[columnGrant[3]!];
    if (allowed && columns.length > 0 && new Set(columns).size === columns.length && columns.every((column) => allowed.has(column))) return columns.map((column) => `${recipient} ${operation} ${columnGrant[3]}.${column}`);
  }
  const execute = /^GRANT EXECUTE ON FUNCTION (public\.[a-z_]+\([^)]*\)) TO (service_role|authenticated);$/u.exec(statement);
  if (execute && (execute[2] === "authenticated" ? runtimeBrowserExecutions : runtimeExecutions).has(execute[1]!)) return [`${execute[2]} EXECUTE ${execute[1]}`];
  throw new Error("reviewed replacement runtime privilege is outside the fixed capability allowlist");
}
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
  if (raw.runtimeForwards !== undefined) {
    if (!Array.isArray(raw.runtimeForwards) || raw.runtimeForwards.length !== 1) throw new Error("reviewed replacement runtime registry requires exactly one forward");
    const forward = raw.runtimeForwards[0]!;
    if (!/^supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(forward.path) || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== runtimeReplacements.size || !Array.isArray(forward.privileges) || forward.privileges.length === 0) throw new Error("reviewed replacement runtime registry has an invalid forward");
    const runtimeSignatures = new Set<string>();
    for (const binding of forward.functions) {
      if (!runtimeReplacements.has(binding.signature) || runtimeSignatures.has(binding.signature) || !hash(binding.beforeSha256) || !hash(binding.afterSha256)) throw new Error("reviewed replacement runtime registry has an invalid or duplicate existing signature");
      runtimeSignatures.add(binding.signature);
    }
    if (new Set(forward.privileges).size !== forward.privileges.length) throw new Error("reviewed replacement runtime registry has duplicate privileges");
    if (forward.retiredPolicies !== undefined) {
      if (!Array.isArray(forward.retiredPolicies) || forward.retiredPolicies.length !== runtimeRetiredPolicies.size) throw new Error("reviewed replacement runtime requires exactly eight retired browser policies");
      const retired = new Set<string>();
      for (const binding of forward.retiredPolicies) {
        if (Object.keys(binding).sort().join(",") !== "beforeSha256,name,table" || runtimeRetiredPolicies.get(binding.table) !== binding.name || retired.has(binding.table) || !hash(binding.beforeSha256)) throw new Error("reviewed replacement runtime has invalid or duplicate retired policy");
        retired.add(binding.table);
      }
    }
    const privilegeKeys = forward.privileges.flatMap(runtimePrivilegeKeys);
    if (new Set(privilegeKeys).size !== privilegeKeys.length) throw new Error("reviewed replacement runtime registry has duplicate privilege capabilities");
  }
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
    const match = /^(?:[a-z_][a-z0-9_]* )?(uuid|text|jsonb|integer|timestamp with time zone)(?: DEFAULT [\s\S]+)?$/iu.exec(argument.trim());
    if (!match) throw new Error("reviewed replacement has an unsupported argument identity");
    return match[1]!.toLowerCase();
  });
  const signature = `${name.toLowerCase()}(${types.join(",")})`;
  if (types.includes("timestamp with time zone") && !runtimeReplacements.has(signature)) throw new Error("reviewed replacement has an unsupported timestamp identity");
  return signature;
}

// The newly admitted due-reader alone has a timestamp default containing parentheses.
const identityHeaderSql = (statement: string) => statement.replace(/(public\.subscription_list_due_for_renewal\([^;]*timestamp with time zone DEFAULT )now\(\)/iu, "$1now");

export function reviewedFunctionDefinitions(bytes: Buffer, names?: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const statement of sqlStatements(bytes.toString("utf8"), names !== undefined)) {
    const prefix = /^CREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(/iu.exec(statement);
    if (!prefix || (names && !names.has(prefix[1]!.toLowerCase()))) continue;
    const header = /^CREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\) RETURNS /iu.exec(identityHeaderSql(statement));
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

/** Pin the actual policy statement, not a registry-supplied predicate. */
export function reviewedPolicyDefinitions(bytes: Buffer): Map<string, string> {
  const policies = new Map<string, string>();
  updatePolicyDefinitions(policies, bytes);
  return policies;
}
function updatePolicyDefinitions(policies: Map<string, string>, bytes: Buffer): void {
  for (const statement of sqlStatements(bytes.toString("utf8"), true)) {
    const create = /^CREATE POLICY ([a-z_]+) ON public\.([a-z_]+) /u.exec(statement);
    if (create) policies.set(`${create[2]}.${create[1]}`, sqlSha256(statement));
    const changed = /^(?:ALTER|DROP) POLICY ([a-z_]+) ON public\.([a-z_]+)(?: |;)/u.exec(statement);
    if (changed) policies.delete(`${changed[2]}.${changed[1]}`);
  }
}

/** Both required CI and release preparation use this exact path/byte/signature check. */
export function assertReviewedPlatformForward(root: string, base: string, head: string, path: string, bytes: Buffer, release = false): void {
  const targetRegistry = blob(root, head, REVIEWED_FORWARD_PATH);
  if (!targetRegistry) throw new Error(`non-expand-only forward has no reviewed replacement approval: ${path}`);
  const registry = readReviewedForwardRegistry(targetRegistry);
  const forward = [...registry.replacementForwards, ...registry.creationForwards, ...(registry.runtimeForwards ?? [])].find((entry) => entry.path === path);
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
  const priorPolicies = reviewedPolicyDefinitions(baseline);
  const priorStatements = new Map<string, string>();
  const collectPriorStatements = (source: Buffer) => {
    for (const statement of sqlStatements(source.toString("utf8"), true)) {
      const header = /^CREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\) RETURNS /iu.exec(identityHeaderSql(statement));
      if (header && names.has(header[1]!.toLowerCase())) priorStatements.set(functionSignature(header[1]!, header[2]!), statement);
    }
  };
  collectPriorStatements(baseline);
  const paths = git(root, ["ls-tree", "-r", "--name-only", head, "--", "supabase/migrations/"]).toString("utf8").trim().split("\n").filter((item) => item !== MANAGED_BASELINE && item < path).sort();
  for (const priorPath of paths) {
    const source = blob(root, head, priorPath)!;
    for (const [signature, sha256] of reviewedFunctionDefinitions(source, names)) prior.set(signature, sha256);
    collectPriorStatements(source);
    updatePolicyDefinitions(priorPolicies, source);
  }
  const definitions = reviewedFunctionDefinitions(bytes);
  if (registry.runtimeForwards?.includes(forward as RuntimeForwardBinding)) {
    const runtime = forward as RuntimeForwardBinding;
    const privileges: string[] = [];
    const retiredPolicies: string[] = [];
    const headerAttributes = (statement: string) => {
      const opening = /\bAS (\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/u.exec(statement);
      if (!opening) throw new Error("reviewed replacement runtime requires a dollar body");
      const closing = statement.indexOf(opening[1]!, opening.index + opening[0].length);
      if (closing < 0 || !/^\s*;\s*$/u.test(statement.slice(closing + opening[1]!.length))) throw new Error("reviewed replacement runtime refuses attributes after its dollar body");
      return statement.slice(0, opening.index).replace(/^CREATE OR REPLACE /u, "CREATE ");
    };
    for (const statement of sqlStatements(bytes.toString("utf8"))) {
      if (/^(?:BEGIN|COMMIT);$/iu.test(statement)) continue;
      const header = /^CREATE OR REPLACE FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\) RETURNS /iu.exec(identityHeaderSql(statement));
      if (header) {
        const signature = functionSignature(header[1]!, header[2]!);
        const preceding = priorStatements.get(signature);
        if (!runtimeReplacements.has(signature) || !preceding || headerAttributes(statement) !== headerAttributes(preceding)) throw new Error("reviewed replacement runtime function attributes drifted");
        continue;
      }
      const retired = /^DROP POLICY ([a-z_]+) ON public\.([a-z_]+);$/u.exec(statement);
      if (retired) {
        const binding = runtime.retiredPolicies?.[retiredPolicies.length];
        if (privileges.length || !binding || binding.name !== retired[1] || binding.table !== retired[2] || priorPolicies.get(`${binding.table}.${binding.name}`) !== binding.beforeSha256) throw new Error("reviewed replacement runtime policy retirement differs from exact ordered preimages");
        retiredPolicies.push(statement);
        continue;
      }
      runtimePrivilegeKeys(statement);
      privileges.push(statement);
    }
    if (retiredPolicies.length !== (runtime.retiredPolicies?.length ?? 0)) throw new Error("reviewed replacement runtime has missing policy retirements");
    if (privileges.length !== runtime.privileges.length || privileges.some((statement, index) => statement !== runtime.privileges[index])) throw new Error("reviewed replacement runtime privileges differ from exact statement pins");
  } else assertFunctionStatements(bytes, definitions);
  if (definitions.size !== forward.functions.length) throw new Error("reviewed replacement has missing or additional function signatures");
  for (const binding of forward.functions) {
    if (definitions.get(binding.signature) !== binding.afterSha256 || (prior.get(binding.signature) ?? null) !== binding.beforeSha256) throw new Error(`reviewed replacement definition drifted: ${binding.signature}`);
  }
}
