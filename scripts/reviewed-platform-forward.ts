import { createHash } from "node:crypto";
import { PLATFORM_BASELINE_FILE } from "./platform-migration-manifest.ts";
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
const portableReplacements = new Set([
  "public.dunning_lifecycle_handle_failure(uuid,timestamptz,text,text,integer,timestamptz,text,text)",
]);
const paymentTerminalSignature = "public.payment_truth_apply_terminal(uuid,text,text,timestamptz,text,text,jsonb,text,text,text)";
const managedInvoicing = [
  { path: "supabase/migrations/20261022193000_invoicing_correction_claims.sql", creation: true, signatures: [
    "public.accounting_invoice_correction_outbox_claim(integer,integer,text)",
    "public.accounting_invoice_correction_outbox_succeed(uuid,text,text,jsonb,integer)",
    "public.accounting_invoice_correction_outbox_fail(uuid,jsonb,integer,integer)",
  ] },
  { path: "supabase/migrations/20261022193100_invoicing_correction_compatibility.sql", creation: false, signatures: [
    "public.accounting_invoice_correction_outbox_claim(integer,integer)",
    "public.accounting_invoice_correction_outbox_succeed(uuid,text,text,jsonb)",
    "public.accounting_invoice_correction_outbox_fail(uuid,jsonb,integer)",
  ] },
  { path: "supabase/migrations/20261022195100_invoicing_seller_revision.sql", creation: true, signatures: [
    "public.invoicing_managed_request_with_seller_policy(text,text,uuid,text,jsonb)",
    "public.invoicing_managed_claim_with_seller(integer,uuid,jsonb,text)",
    "public.invoicing_managed_claim_corrections_with_seller(integer,jsonb,text)",
  ] },
];
const portableCreationPaths = [
  "db/platform/migrations/20261022080000_fulfillment_command_ledger.sql",
  "db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql",
  "db/platform/migrations/20261022190000_invoicing_durable_duties.sql",
  "db/platform/migrations/20261022191000_invoicing_document_effects.sql",
  "db/platform/migrations/20261022195000_invoicing_seller_revision.sql",
];
type PortableCreationBinding = { path: string; sha256: string };
type FunctionBinding = { signature: string; beforeSha256: string | null; afterSha256: string };
type PolicyBinding = { table: string; name: string; beforeSha256: string };
type RuntimeForwardBinding = ForwardBinding & { privileges: string[]; retiredPolicies?: PolicyBinding[] };
type ForwardBinding = { path: string; sha256: string; functions: FunctionBinding[] };
export type BatchedForwardBinding = ForwardBinding & { statements: { sha256: string; sql?: string }[] };
export type ReviewedForwardRegistry = { batchedForwards?: BatchedForwardBinding[]; schemaVersion: 1; baselineSha256: string; replacementForwards: ForwardBinding[]; creationForwards: ForwardBinding[]; runtimeForwards?: RuntimeForwardBinding[]; portableReplacementForwards?: ForwardBinding[]; portableCreationForwards?: PortableCreationBinding[]; managedInvoicingForwards?: ForwardBinding[] };
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
// Reconcile create/link, checkout soft-account link and operator invitations consume only these service capabilities.
const identityColumns: Record<string, Record<string, ReadonlySet<string>>> = {
  clients: { INSERT: new Set(["email", "auth_user_id", "acquisition_source", "lifecycle_stage"]), UPDATE: new Set(["auth_user_id"]) },
  admin_users: { INSERT: new Set(["id", "email", "role", "membership_state", "membership_provenance", "membership_accepted_at"]), SELECT: new Set(["email"]) },
};
function identityPrivilegeKeys(statement: string): string[] {
  const grant = /^GRANT (INSERT|UPDATE|SELECT) \(([a-z_, ]+)\) ON public\.(clients|admin_users) TO service_role;$/u.exec(statement);
  if (grant) {
    const columns = grant[2]!.split(",").map((column) => column.trim());
    const allowed = identityColumns[grant[3]!]?.[grant[1]!];
    if (allowed && columns.length > 0 && new Set(columns).size === columns.length && columns.every((column) => allowed.has(column))) return columns.map((column) => `service_role ${grant[1]} ${grant[3]}.${column}`);
  }
  throw new Error("reviewed replacement identity privilege is outside the fixed capability allowlist");
}
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export function readReviewedForwardRegistry(bytes: Buffer): ReviewedForwardRegistry {
  return readForwardRegistry(bytes, false);
}

// Only approval-history comparison may read the exact pre-CTL-2 inventory.
// Candidate admission always uses the strict public reader above.
function readForwardRegistry(bytes: Buffer, historical: boolean): ReviewedForwardRegistry {
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
    if (!Array.isArray(raw.runtimeForwards) || raw.runtimeForwards.length < 1 || raw.runtimeForwards.length > 2) throw new Error("reviewed replacement runtime registry requires one or two forwards");
    for (const [index, forward] of raw.runtimeForwards.entries()) {
      if (!/^supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(forward.path) || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== (index === 0 ? runtimeReplacements.size : 0) || (index === 1 && "retiredPolicies" in forward) || !Array.isArray(forward.privileges) || forward.privileges.length === 0) throw new Error("reviewed replacement runtime registry has an invalid forward");
      paths.add(forward.path);
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
      const privilegeKeys = forward.privileges.flatMap(index === 0 ? runtimePrivilegeKeys : identityPrivilegeKeys);
      if (new Set(privilegeKeys).size !== privilegeKeys.length) throw new Error("reviewed replacement runtime registry has duplicate privilege capabilities");
    }
  }
  if (raw.portableReplacementForwards !== undefined) {
    if (!Array.isArray(raw.portableReplacementForwards) || ![1,2,3].includes(raw.portableReplacementForwards.length)) throw new Error("reviewed portable replacement registry requires one, two or three fixed forwards");
    for (const [index, forward] of raw.portableReplacementForwards.entries()) {
      if (!forward || Object.keys(forward).sort().join(",") !== "functions,path,sha256" || !/^db\/platform\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(forward.path) || paths.has(forward.path) || raw.portableReplacementForwards.findIndex(entry => entry.path === forward.path) !== index || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== 1) throw new Error("reviewed portable replacement registry has an invalid forward");
      paths.add(forward.path);
      const binding = forward.functions[0]!;
      if (Object.keys(binding).sort().join(",") !== "afterSha256,beforeSha256,signature" || !(index === 0 ? portableReplacements.has(binding.signature) : index === 1 ? forward.path === "db/platform/migrations/20261022192000_invoicing_payment_decoupling.sql" && binding.signature === paymentTerminalSignature : forward.path === "db/platform/migrations/20261022165000_fulfillment_stock_evidence_replay_reopen.sql" && binding.signature === "public.fulfillment_record_stock_evidence(text,text,text,text,text,text,integer,integer)") || !hash(binding.beforeSha256) || !hash(binding.afterSha256)) throw new Error("reviewed portable replacement registry must bind exactly the approved existing signature");
    }
  }
  if (raw.managedInvoicingForwards !== undefined) {
    if (!Array.isArray(raw.managedInvoicingForwards) || raw.managedInvoicingForwards.length !== managedInvoicing.length) throw new Error("reviewed managed invoicing requires exactly three fixed forwards");
    for (const [index, forward] of raw.managedInvoicingForwards.entries()) {
      const allowed = managedInvoicing[index]!;
      if (!forward || Object.keys(forward).sort().join(",") !== "functions,path,sha256" || forward.path !== allowed.path || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== allowed.signatures.length) throw new Error("reviewed managed invoicing has an invalid forward");
      paths.add(forward.path);
      for (const [position, binding] of forward.functions.entries()) {
        if (Object.keys(binding).sort().join(",") !== "afterSha256,beforeSha256,signature" || binding.signature !== allowed.signatures[position] || !hash(binding.afterSha256) || (allowed.creation ? binding.beforeSha256 !== null : !hash(binding.beforeSha256))) throw new Error("reviewed managed invoicing signature or creation/replacement class drifted");
      }
    }
  }
  if (raw.portableCreationForwards !== undefined) {
    if (!Array.isArray(raw.portableCreationForwards) || ![2,portableCreationPaths.length].includes(raw.portableCreationForwards.length)) throw new Error("reviewed portable creation registry requires exactly the approved forwards");
    for (const [index, forward] of raw.portableCreationForwards.entries()) {
      if (!forward || Object.keys(forward).sort().join(",") !== "path,sha256" || forward.path !== portableCreationPaths[index] || paths.has(forward.path) || raw.portableReplacementForwards?.some((entry) => entry.path === forward.path) || !hash(forward.sha256)) throw new Error("reviewed portable creation registry has an invalid or duplicate forward");
      paths.add(forward.path);
    }
  }
  if (raw.batchedForwards !== undefined) validateBatchedForwards(raw.batchedForwards, paths, historical);
  return raw;
}

/** Split top-level SQL only. Comments, quoted literals and dollar bodies cannot introduce statements. */
export function sqlStatements(sql: string, dump = false, creation = false): string[] {
  const statements: string[] = [];
  let start = -1;
  for (let index = 0; index < sql.length;) {
    if (creation && sql.charCodeAt(index) > 0x7f) throw new Error("reviewed portable creation refuses non-ASCII outside strings, comments and dollar bodies");
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
        if (sql.startsWith("/*", index)) {
          if (creation) throw new Error("reviewed portable creation refuses nested block comments");
          depth++; index += 2;
        }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) throw new Error("reviewed replacement SQL has an unterminated comment");
      continue;
    }
    if (start < 0) start = index;
    if (creation && (sql[index] === "\\" || (/^(?:E'|U&['"])/iu.test(sql.slice(index)) && !/[A-Za-z0-9_$]/u.test(sql[index - 1] ?? "")))) throw new Error("reviewed portable creation refuses backslashes and escape strings outside dollar bodies");
    const quote = sql[index];
    if (quote === "'" || quote === '"') {
      index++; let closed = false;
      while (index < sql.length) {
        if (creation && quote === '"' && sql.charCodeAt(index) > 0x7f) throw new Error("reviewed portable creation refuses non-ASCII identifiers");
        if (creation && (sql[index] === "\n" || (quote === '"' && /[;$]/u.test(sql[index]!)))) throw new Error("reviewed portable creation refuses multiline quotes and statement or dollar delimiters in identifiers");
        if (sql[index] === "\\") {
          if (creation) throw new Error("reviewed portable creation refuses backslashes outside dollar bodies");
          index += 2; continue;
        }
        if (sql[index++] === quote) { if (sql[index] === quote) { index++; continue; } closed = true; break; }
      }
      if (!closed) throw new Error("reviewed replacement SQL has an unterminated literal");
      continue;
    }
    const tag = sql[index] === "$" ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0] : undefined;
    // The pinned files open bodies only as AS $$. PostgreSQL includes an
    // identifier-adjacent dollar in that identifier, so never guess here.
    if (creation && sql[index] === "$" && (tag !== "$$" || !/(?:^|[^A-Za-z0-9_$])AS[ \t\n]+$/iu.test(sql.slice(0, index)))) throw new Error("reviewed portable creation requires dollar bodies immediately after AS and whitespace");
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
    const match = /^(?:[a-z_][a-z0-9_]* )?(uuid|text|jsonb|integer|timestamp with time zone|timestamptz)(?: DEFAULT [\s\S]+)?$/iu.exec(argument.trim());
    if (!match) throw new Error("reviewed replacement has an unsupported argument identity");
    return match[1]!.toLowerCase();
  });
  const signature = `${name.toLowerCase()}(${types.join(",")})`;
  if (types.includes("timestamp with time zone") && !runtimeReplacements.has(signature)) throw new Error("reviewed replacement has an unsupported timestamp identity");
  if (types.includes("timestamptz") && !portableReplacements.has(signature) && signature !== paymentTerminalSignature) throw new Error("reviewed replacement has an unsupported portable timestamp identity");
  return signature;
}

// The newly admitted due-reader alone has a timestamp default containing parentheses.
const identityHeaderSql = (statement: string) => statement.replace(/(public\.subscription_list_due_for_renewal\([^;]*timestamp with time zone DEFAULT )now\(\)/iu, "$1now");

export function reviewedFunctionDefinitions(bytes: Buffer, names?: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const statement of sqlStatements(bytes.toString("utf8"), names !== undefined)) {
    const prefix = /^CREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(/iu.exec(statement);
    if (!prefix || (names && !names.has(prefix[1]!.toLowerCase()))) continue;
    const header = /^CREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\)\s+RETURNS\s+/iu.exec(identityHeaderSql(statement));
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

/** Account for structural parentheses first; every remaining identifier before `(` is an expression. */
function expandOnlyExpressions(tokens: string[]): boolean {
  const calls = new Set(["BTRIM", "GEN_RANDOM_UUID", "JSONB_TYPEOF", "LENGTH", "LOWER", "NOW", "TRANSLATE", "CHAR_LENGTH", "CLOCK_TIMESTAMP", "OCTET_LENGTH"]);
  const constructs = new Set(["IN", "AND", "OR", "NOT", "COALESCE", "NULLIF", "CAST"]);
  const modifiers = new Set(["NUMERIC", "DECIMAL", "VARCHAR", "CHAR", "CHARACTER", "BIT", "VARBIT", "TIMESTAMP", "TIMESTAMPTZ", "TIME", "TIMETZ", "INTERVAL"]);
  const identifier = (token = "") => /^[A-Z_][A-Z0-9_]*$/u.test(token) || token.startsWith('"');
  const structural = new Set<number>(), qualified = new Set<number>(), arrays = new Set<number>(), closing = new Map<number, number>();
  const stack: number[] = [];
  for (const [index, token] of tokens.entries()) {
    // Refuse constructors/subscripts before any comma splitter; only empty type brackets remain.
    if ((token === "[" && tokens[index + 1] !== "]") || (token === "]" && tokens[index - 1] !== "[")) return false;
    if (token === "(") stack.push(index);
    if (token === ")") { const open = stack.pop(); if (open === undefined) return false; closing.set(open, index); }
  }
  if (stack.length) return false;
  // Object/column type names are outside expression regions. Preserve their dots separately.
  const nameEnd = (start: number) => {
    if (!identifier(tokens[start])) return -1;
    let end = start + 1;
    while (tokens[end] === ".") {
      if (!identifier(tokens[end + 1])) return -1;
      qualified.add(end); end += 2;
    }
    return end;
  };
  const typeModifier = (start: number) => {
    let end = nameEnd(start);
    if (end < 0) return false;
    if (tokens[end] === "(" && modifiers.has(tokens[end - 1]!) && (end === start + 1 || (end === start + 3 && tokens[start] === "PG_CATALOG"))) {
      structural.add(end);
      if (!tokens.slice(end + 1, closing.get(end)).every((token) => token === "<literal>" || token === ",")) return false;
      end = closing.get(end)! + 1;
    }
    if (tokens[end] === "(") return false;
    while (tokens[end] === "[" && tokens[end + 1] === "]") { arrays.add(end); arrays.add(end + 1); end += 2; }
    return true;
  };
  const indexStatement = tokens[1] === "INDEX" || (tokens[1] === "UNIQUE" && tokens[2] === "INDEX");
  let open: number;
  if (indexStatement) {
    const object = tokens[1] === "UNIQUE" ? 3 : 2;
    const on = nameEnd(tokens.slice(object, object + 3).join(" ") === "IF NOT EXISTS" ? object + 3 : object);
    if (on < 0 || tokens[on] !== "ON") return false;
    open = nameEnd(on + 1);
    if (open < 0) return false;
    if (tokens[open] === "USING") {
      if (!identifier(tokens[open + 1])) return false;
      open += 2;
    }
  } else if (tokens[0] === "CREATE") {
    open = nameEnd(tokens.slice(2, 5).join(" ") === "IF NOT EXISTS" ? 5 : 2);
  } else {
    const add = nameEnd(2);
    if (add < 0 || tokens[add] !== "ADD") return false;
    open = -1;
  }
  if (tokens[0] === "CREATE" && (open < 0 || tokens[open] !== "(")) return false;
  if (open >= 0) structural.add(open);

  if (indexStatement) {
    const end = closing.get(open);
    if (end === undefined) return false;
    // A key is one column, call or parenthesized expression, followed only by ordering.
    for (let start = open + 1; start < end;) {
      let keyEnd = start + 1;
      if (tokens[start] === "(") keyEnd = closing.get(start)! + 1;
      else {
        while (tokens[keyEnd] === ".") keyEnd += 2;
        if (tokens[keyEnd] === "(") keyEnd = closing.get(keyEnd)! + 1;
        else if (!identifier(tokens[start])) return false;
      }
      let next = keyEnd;
      while (next < end && tokens[next] !== ",") next++;
      if (!/^(?:(?:ASC|DESC)(?: |$))?(?:NULLS (?:FIRST|LAST))?$/u.test(tokens.slice(keyEnd, next).join(" "))) return false;
      start = next + 1;
    }
    // INCLUDE column lists and storage parameters are structural, not calls.
    let suffix = end + 1;
    for (const clause of ["INCLUDE", "WITH"]) {
      if (tokens[suffix] !== clause) continue;
      if (tokens[suffix + 1] !== "(") return false;
      structural.add(suffix + 1);
      const close = closing.get(suffix + 1)!;
      if (clause === "INCLUDE" && !/^[A-Z_][A-Z0-9_]*(?: , [A-Z_][A-Z0-9_]*)*$/u.test(tokens.slice(suffix + 2, close).map((token) => token.startsWith('"') ? token.slice(1, -1) : token).join(" "))) return false;
      suffix = close + 1;
    }
    if (suffix < tokens.length && tokens[suffix] !== "WHERE") return false;
  } else {
    const end = open >= 0 ? closing.get(open) : tokens.length;
    if (end === undefined) return false;
    for (let start = open >= 0 ? open + 1 : nameEnd(2); start < end;) {
      let next = start;
      while (next < end && tokens[next] !== ",") next = tokens[next] === "(" ? closing.get(next)! + 1 : next + 1;
      let column = start;
      if (open < 0) {
        if (tokens[column++] !== "ADD") return false;
        if (tokens[column] === "COLUMN") column++;
        if (tokens.slice(column, column + 3).join(" ") === "IF NOT EXISTS") column += 3;
      }
      const constraint = ["CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK"].includes(tokens[column]!);
      if (!constraint && (!identifier(tokens[column]) || !typeModifier(column + 1))) return false;
      // Start after the column/type or constraint name, never at a keyword-shaped column name.
      let index = constraint ? column : nameEnd(column + 1);
      if (tokens[index] === "CONSTRAINT") {
        if (!identifier(tokens[index + 1])) return false;
        index += 2;
      }
      for (; index < next; index++) {
        const token = tokens[index];
        if (token === "REFERENCES") {
          const targetEnd = nameEnd(index + 1);
          if (targetEnd < 0) return false;
          if (tokens[targetEnd] === "(") structural.add(targetEnd);
          index = targetEnd - 1;
        }
        if ((token === "CHECK" || token === "UNIQUE" || (token === "KEY" && ["PRIMARY", "FOREIGN"].includes(tokens[index - 1]!))) && tokens[index + 1] === "(") structural.add(index + 1);
        if (token === "GENERATED") {
          const as = tokens[index + 1] === "ALWAYS" ? index + 2 : tokens.slice(index + 1, index + 3).join(" ") === "BY DEFAULT" ? index + 3 : -1;
          if (as < 0 || tokens[as] !== "AS") return false;
          const expression = tokens[as + 1] === "IDENTITY" ? as + 2 : as + 1;
          if (tokens[expression] === "(") structural.add(expression);
          index = expression - 1;
        }
        if (token === "(") index = closing.get(index)!;
      }
      start = next + 1;
    }
  }
  for (const [index, token] of tokens.entries()) {
    if ((token === "[" || token === "]") && !arrays.has(index)) return false;
    if (token === "CAST" && tokens[index + 1] === "(") {
      const end = closing.get(index + 1)!;
      let as = index + 2;
      while (as < end && tokens[as] !== "AS") as = tokens[as] === "(" ? closing.get(as)! + 1 : as + 1;
      if (as === end) return false;
      if (tokens[as + 2] === "." && (tokens[as + 1] !== "PG_CATALOG" || tokens[as + 4] === ".")) return false;
      if (!typeModifier(as + 1)) return false;
    }
    if (token === "." && !qualified.has(index) && !(tokens[index - 1] === "PG_CATALOG" && calls.has(tokens[index + 1]!) && tokens[index + 2] === "(" && tokens[index - 2] !== ".")) return false;
    if (token !== "(" || structural.has(index) || !identifier(tokens[index - 1])) continue;
    const previous = tokens[index - 1]!;
    if (!calls.has(previous) && !(tokens[index - 2] !== "." && constructs.has(previous))) return false;
  }
  return true;
}

/** A deliberately bounded SQL admission check, not a general SQL interpreter.
 * Refuses control characters other than tab and line feed (PostgreSQL also ends a `--` comment at a carriage return, so no classifier models line ends differently); procedural/dynamic SQL also refuses.
 * Existing SQL is frozen, so only new forwards pass through this predicate.
 */
export function isExpandOnlyPlatformForward(sql: string, reviewedCreationTable = false): boolean {
  if (Buffer.from(sql, "utf8").some((byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f)) return false;
  const tokens: string[] = [];
  for (let index = 0; index < sql.length;) {
    const rest = sql.slice(index);
    // PostgreSQL treats non-ASCII bytes as identifier characters, not separators.
    if (!reviewedCreationTable && rest.charCodeAt(0) > 0x7f) return false;
    if ((reviewedCreationTable ? /^\s/u : /^[ \t\n]/u).test(rest)) { index++; continue; }
    if (rest.startsWith("--")) { const end = sql.indexOf("\n", index); index = end < 0 ? sql.length : end; continue; }
    if (rest.startsWith("/*")) {
      let depth = 1; index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) { depth++; index += 2; }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) return false;
      continue;
    }
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0]; let value = "", closed = false; index++;
      while (index < sql.length) {
        if (!reviewedCreationTable && quote === '"' && sql.charCodeAt(index) > 0x7f) return false;
        if (sql[index] === "\\") return false; // Refuse escape-string ambiguity.
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { value += quote; index += 2; continue; }
          index++; closed = true; break;
        }
        value += sql[index++];
      }
      if (!closed) return false;
      if (!reviewedCreationTable && quote === '"' && value === ";") return false; // Preserve the original delimiter refusal.
      tokens.push(quote === "'" ? "<literal>" : reviewedCreationTable ? value.toUpperCase() : `"${value.toUpperCase()}"`); continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest)?.[0];
    if (word) { tokens.push(word.toUpperCase()); index += word.length; continue; }
    const number = /^[0-9]+(?:\.[0-9]+)?/u.exec(rest)?.[0];
    if (number) { tokens.push("<literal>"); index += number.length; continue; }
    if (!";.,()+-=[]".includes(rest[0]!) && !(reviewedCreationTable && "<>:~".includes(rest[0]!))) return false;
    tokens.push(rest[0]!); index++;
  }
  const statements: string[][] = [[]];
  for (const token of tokens) { if (token === ";") statements.push([]); else statements.at(-1)!.push(token); }
  const nonempty = statements.filter((statement) => statement.length);
  return nonempty.length > 0 && nonempty.every((quoted) => {
    const statement = reviewedCreationTable ? quoted : quoted.map((token) => token.startsWith('"') ? token.slice(1, -1) : token);
    const text = statement.join(" ");
    if (!reviewedCreationTable) {
      if (quoted.includes("OPERATOR") || quoted.some((token, index) => token === "OWNED" && quoted[index + 1] === "BY")) return false;
      if (/^INSERT INTO /u.test(text)) {
        const values = quoted.indexOf("VALUES"), conflict = quoted.indexOf("ON", values);
        if (!/^INSERT INTO [A-Z_][A-Z0-9_]*(?: \. [A-Z_][A-Z0-9_]*)*(?: \( [A-Z_][A-Z0-9_]*(?: , [A-Z_][A-Z0-9_]*)* \))? VALUES$/u.test(quoted.slice(0, values + 1).join(" "))) return false;
        if (!/ ON CONFLICT(?: \( [A-Z_][A-Z0-9_]*(?: , [A-Z_][A-Z0-9_]*)* \)| ON CONSTRAINT [A-Z_][A-Z0-9_]*)? DO NOTHING$/u.test(quoted.join(" "))) return false;
        if (!quoted.slice(values + 1, conflict).every((token) => ["<literal>", "TRUE", "FALSE", "NULL", "(", ")", ",", "+", "-"].includes(token))) return false;
      }
      if (/^CREATE SCHEMA /u.test(text) && !/^CREATE SCHEMA (?:IF NOT EXISTS )?[A-Z_][A-Z0-9_]*$/u.test(quoted.join(" "))) return false;
      if (/^(?:CREATE (?:UNIQUE )?(?:TABLE|INDEX)|ALTER TABLE) /u.test(text)) {
        // No evaluated forward uses LIKE, including its expression-operator form.
        if (quoted.includes("LIKE") || quoted.some((token, index) => token === "PARTITION" && quoted[index + 1] === "OF")) return false;
        if (!expandOnlyExpressions(quoted)) return false;
        let depth = 0;
        for (const token of quoted) {
          if (token === "(") depth++;
          if (token === ")") depth--;
          if (quoted[0] === "CREATE" && quoted[1] === "TABLE" && depth === 0 && token === "AS") return false;
        }
      } else if (quoted.includes("[") || quoted.includes("]")) return false;
    }
    // Base admission remains unchanged; the expand-only checks above only add refusals.
    // Pinned new tables use scalar operators/casts and these foreign-key actions.
    // Mask only those actions, leaving standalone DELETE/SET and every other refusal intact.
    const checked = reviewedCreationTable && /^CREATE TABLE /u.test(text) ? text.replace(/ ON DELETE (?:CASCADE|SET NULL)(?= |$)/gu, "").split(" ") : statement;
    if (checked.some((token) => ["DROP", "TRUNCATE", "RENAME", "OWNER", "SET", "APP", "DELETE", "UPDATE", "REPLACE", "SELECT", "EXECUTE", "CALL", "DETACH", "ATTACH", "INHERIT", "INHERITS", "DISABLE", "ENABLE", "VALIDATE", "AUTHORIZATION"].includes(token))) return false;
    if (text === "BEGIN" || text === "COMMIT") return true;
    if (/^INSERT INTO /u.test(text)) {
      const values = statement.indexOf("VALUES"), conflict = statement.indexOf("ON", values);
      if (values < 0 || conflict < 0 || !/ ON CONFLICT(?: \( [A-Z_][A-Z0-9_]*(?: , [A-Z_][A-Z0-9_]*)* \)| ON CONSTRAINT [A-Z_][A-Z0-9_]*)? DO NOTHING$/u.test(text)) return false;
      // Seed values are literals only; no subquery, function or dynamic execution.
      return statement.slice(values + 1, conflict).every((token) => ["<literal>", "TRUE", "FALSE", "NULL", "(", ")", ",", "+", "-"].includes(token)) && statement.filter((token) => token === "DO").length === 1;
    }
    if (statement.includes("DO")) return false;
    if (/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TYPE|SEQUENCE|SCHEMA) /u.test(text)) return !statement.includes("ALTER") && statement.filter((token) => token === "CREATE").length === 1;
    if (/^ALTER TABLE /u.test(text)) {
      const add = statement.indexOf("ADD");
      if (add <= 2 || statement.slice(2, add).includes(",") || statement.filter((token) => token === "ALTER").length !== 1) return false;
      let depth = 0;
      for (let index = add; index < statement.length; index++) {
        if (statement[index] === "(") depth++;
        if (statement[index] === ")") depth--;
        if (depth < 0 || (depth === 0 && statement[index] === "," && statement[index + 1] !== "ADD")) return false;
      }
      return depth === 0;
    }
    return false;
  });
}

/** A pinned creation file may add invoker objects, never redefine earlier objects.
 * Trigger attachments to existing public tables are intentional: both the trigger
 * name and its zero-argument trigger function must be new in this file.
 * This is a bounded statement classifier, not a general SQL/body safety analyser;
 * the separately approved whole-file hash binds every body and expression.
 */
export function assertPortableCreationStatements(bytes: Buffer, preceding: Buffer[]): void {
  const relations = new Set<string>(), functions = new Set<string>(), triggers = new Set<string>(), priorTables = new Set<string>();
  for (const source of preceding) {
    for (const statement of sqlStatements(source.toString("utf8"), true)) {
      const relation = /^CREATE (?:(?:OR REPLACE|UNIQUE|MATERIALIZED|UNLOGGED) )?(?:TABLE|INDEX|VIEW|SEQUENCE|TYPE) (?:IF NOT EXISTS )?(?:public\.)?"?([a-z_][a-z0-9_]*)"?(?:\s|\()/iu.exec(statement);
      if (relation) relations.add(`public.${relation[1]!.toLowerCase()}`);
      if (relation && /^CREATE (?:UNLOGGED )?TABLE /iu.test(statement)) priorTables.add(`public.${relation[1]!.toLowerCase()}`);
      const routine = /^CREATE(?: OR REPLACE)? FUNCTION public\."?([a-z_][a-z0-9_]*)"?\s*\(/iu.exec(statement);
      if (routine) functions.add(`public.${routine[1]!.toLowerCase()}`);
      const trigger = /^CREATE(?: OR REPLACE)? TRIGGER "?([a-z_][a-z0-9_]*)"?\s/iu.exec(statement);
      if (trigger) triggers.add(trigger[1]!.toLowerCase());
    }
  }
  const tables = new Set<string>(), views = new Set<string>(), indexes = new Set<string>();
  const definitions = new Set<string>(), createdFunctions = new Set<string>(), triggerFunctions = new Set<string>(), addedTriggers = new Set<string>();
  const triggerTables = new Map<string, string>();
  const add = (name: string, existing: Set<string>, added: Set<string>) => {
    if (existing.has(name) || added.has(name)) throw new Error(`reviewed portable creation refuses a pre-existing or duplicate object: ${name}`);
    existing.add(name); added.add(name);
  };
  const argumentTypes = (args: string): string => args.trim() === "" ? "" : args.split(",").map((argument) => {
    const type = /^(?:[a-z_][a-z0-9_]*\s+)?(uuid|text|jsonb|integer|bigint|boolean|timestamptz|public\.[a-z_][a-z0-9_]*)(?:\s+DEFAULT\s+(?:NULL|false|\d+|now\(\)))?$/iu.exec(argument.trim())?.[1]?.toLowerCase();
    if (!type || (type.startsWith("public.") && !tables.has(type))) throw new Error("reviewed portable creation refuses an unsupported argument type or default");
    return type;
  }).join(",");
  let cutoverSeeded = false;
  for (const statement of sqlStatements(bytes.toString("utf8"), false, true)) {
    if (/^(?:BEGIN|COMMIT);$/iu.test(statement)) continue;
    const table = /^CREATE TABLE (public\.[a-z_][a-z0-9_]*)\s*\([\s\S]+\);$/iu.exec(statement);
    if (table && isExpandOnlyPlatformForward(statement, true)) { const name = table[1]!.toLowerCase(); add(name, relations, tables); continue; }
    // One exact install-time snapshot into the newly created keyed M09 table.
    // This does not admit arbitrary INSERT SELECT or alter the expand-only class.
    if (tables.has("public.invoicing_cutover") && !cutoverSeeded && statement.replace(/\s+/gu," ").trim() ===
      "INSERT INTO public.invoicing_cutover(source_kind,source_id) SELECT 'paid',id FROM public.commerce_settlement_transitions UNION ALL SELECT 'handoff',id FROM public.fulfillment_shipment_operations ON CONFLICT DO NOTHING;") {
      cutoverSeeded = true;
      continue;
    }
    const insert = /^INSERT INTO (public\.[a-z_][a-z0-9_]*)(?=\s|\()/iu.exec(statement);
    if (insert && tables.has(insert[1]!.toLowerCase()) && isExpandOnlyPlatformForward(statement)) continue;
    const index = /^CREATE(?: UNIQUE)? INDEX ([a-z_][a-z0-9_]*)\s+ON (public\.[a-z_][a-z0-9_]*)\s*\([\s\S]+;$/iu.exec(statement);
    if (index && tables.has(index[2]!.toLowerCase()) && isExpandOnlyPlatformForward(statement)) { add(`public.${index[1]!.toLowerCase()}`, relations, indexes); continue; }
    const view = /^CREATE VIEW (public\.[a-z_][a-z0-9_]*)(?:\s+WITH \(security_invoker=true\))?\s+AS\s+SELECT\s+[\s\S]+;$/iu.exec(statement);
    if (view) { add(view[1]!.toLowerCase(), relations, views); continue; }
    // Admit only the attributes present in the approved invoker definitions.
    const routine = /^CREATE FUNCTION (public\.[a-z_][a-z0-9_]*)\(([\s\S]*?)\)\s+RETURNS\s+((?:SETOF\s+)?(?:boolean|jsonb|text|void|trigger|public\.[a-z_][a-z0-9_]*))\s+LANGUAGE\s+(?:sql|plpgsql)\s+(?:(?:IMMUTABLE|STABLE)\s+)?(?:SECURITY INVOKER\s+)?SET search_path\s*=\s*pg_catalog\s+AS (\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/iu.exec(statement);
    if (routine) {
      const closing = statement.indexOf(routine[4]!, routine[0].length);
      if (closing < 0 || !/^\s*;\s*$/u.test(statement.slice(closing + routine[4]!.length))) throw new Error("reviewed portable creation refuses attributes after its first closing dollar tag");
      const name = routine[1]!.toLowerCase(), types = argumentTypes(routine[2]!);
      const returns = routine[3]!.toLowerCase();
      if (returns.startsWith("public.") && !tables.has(returns)) throw new Error("reviewed portable creation refuses a pre-existing return row type");
      // Refuse all overloads of an earlier name as well as exact identity collisions.
      add(name, functions, createdFunctions);
      definitions.add(`${name}(${types})`);
      if (returns === "trigger" && types === "") triggerFunctions.add(name);
      continue;
    }
    const trigger = /^CREATE TRIGGER ([a-z_][a-z0-9_]*)\s+(?:BEFORE|AFTER) (?:INSERT|UPDATE(?: OF [a-z_, ]+)?)(?: OR (?:INSERT|UPDATE(?: OF [a-z_, ]+)?))*\s+ON (public\.[a-z_][a-z0-9_]*)\s+FOR EACH ROW EXECUTE FUNCTION (public\.[a-z_][a-z0-9_]*)\(\);$/iu.exec(statement);
    if (trigger && (priorTables.has(trigger[2]!.toLowerCase()) || tables.has(trigger[2]!.toLowerCase())) && triggerFunctions.has(trigger[3]!.toLowerCase())) {
      const name = trigger[1]!.toLowerCase();
      add(name, triggers, addedTriggers); triggerTables.set(name, trigger[2]!.toLowerCase()); continue;
    }
    const revoke = /^REVOKE ALL ON (FUNCTION |TABLE )?([\s\S]+) FROM ([a-z_, ]+);$/iu.exec(statement);
    if (revoke && revoke[3]!.split(",").every((role) => ["public", "anon", "authenticated"].includes(role.trim().toLowerCase()))) {
      if (revoke[1]?.toUpperCase() === "FUNCTION ") {
        const target = /^(public\.[a-z_][a-z0-9_]*)\(([^)]*)\)$/iu.exec(revoke[2]!);
        if (target && definitions.has(`${target[1]!.toLowerCase()}(${argumentTypes(target[2]!)})`)) continue;
      } else if (revoke[2]!.split(",").every((target) => tables.has(target.trim().toLowerCase()) || (!revoke[1] && views.has(target.trim().toLowerCase())))) continue;
    }
    const comment = /^COMMENT ON (TABLE|VIEW|INDEX|COLUMN) (public\.[a-z_][a-z0-9_]*)(\.[a-z_][a-z0-9_]*)? IS\s+'(?:[^']|'')*';$/iu.exec(statement);
    if (comment) {
      const kind = comment[1]!.toUpperCase(), name = comment[2]!.toLowerCase();
      if (kind === "COLUMN" ? !!comment[3] && (tables.has(name) || views.has(name)) : !comment[3] && (kind === "TABLE" ? tables : kind === "VIEW" ? views : indexes).has(name)) continue;
    }
    const functionComment = /^COMMENT ON FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\) IS\s+'(?:[^']|'')*';$/iu.exec(statement);
    if (functionComment && definitions.has(`${functionComment[1]!.toLowerCase()}(${argumentTypes(functionComment[2]!)})`)) continue;
    const triggerComment = /^COMMENT ON TRIGGER ([a-z_][a-z0-9_]*) ON (public\.[a-z_][a-z0-9_]*) IS\s+'(?:[^']|'')*';$/iu.exec(statement);
    if (triggerComment && triggerTables.get(triggerComment[1]!.toLowerCase()) === triggerComment[2]!.toLowerCase()) continue;
    throw new Error(`reviewed portable creation refuses an unsupported statement, pre-existing target or function attributes: ${statement.slice(0, 100)}`);
  }
}

/** Fixed M09 managed graph: donor definer attributes, service-only execution,
 * exactly one optional seller table, no triggers or additional statements.
 * Whole-file pins and before/after definitions remain independently required.
 */
export function assertManagedInvoicingStatements(bytes: Buffer, path: string): void {
  const allowed = managedInvoicing.find(entry => entry.path === path);
  if (!allowed) throw new Error("reviewed managed invoicing path is not approved");
  const definitions = new Set<string>(), grants = new Set<string>(), revokes = new Set<string>();
  let tables = 0, rls = 0;
  for (const statement of sqlStatements(bytes.toString("utf8"), false, true)) {
    const routine = /^CREATE( OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(([\s\S]*?)\)\s+RETURNS jsonb\s+LANGUAGE (?:sql|plpgsql)\s+SECURITY DEFINER\s+SET search_path = public, pg_catalog\s+AS (\$\$)/u.exec(statement);
    if (routine) {
      const signature = functionSignature(routine[2]!, routine[3]!);
      const closing = statement.indexOf("$$", routine[0].length);
      if (closing < 0 || !/^\s*;$/u.test(statement.slice(closing + 2)) || !!routine[1] === allowed.creation || !allowed.signatures.includes(signature) || definitions.has(signature)) throw new Error("reviewed managed invoicing definition or attributes drifted");
      definitions.add(signature); continue;
    }
    if (allowed === managedInvoicing[2] && /^CREATE TABLE public\.invoicing_managed_seller_revisions\s*\(/u.test(statement) && isExpandOnlyPlatformForward(statement, true) && tables++ === 0) continue;
    if (allowed === managedInvoicing[2] && statement === "REVOKE ALL ON TABLE public.invoicing_managed_seller_revisions FROM PUBLIC, anon, authenticated;") {
      if (revokes.has("table")) throw new Error("reviewed managed invoicing duplicate table revoke");
      revokes.add("table"); continue;
    }
    if (allowed === managedInvoicing[2] && statement === "ALTER TABLE public.invoicing_managed_seller_revisions ENABLE ROW LEVEL SECURITY;" && rls++ === 0) continue;
    const privilege = /^(REVOKE ALL|GRANT EXECUTE) ON FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\) (FROM PUBLIC, anon, authenticated|TO service_role);$/u.exec(statement);
    if (privilege) {
      const signature = functionSignature(privilege[2]!, privilege[3]!);
      const revoke = privilege[1] === "REVOKE ALL";
      const seen = revoke ? revokes : grants;
      if (!definitions.has(signature) || seen.has(signature) || privilege[4] !== (revoke ? "FROM PUBLIC, anon, authenticated" : "TO service_role")) throw new Error("reviewed managed invoicing privilege drifted");
      seen.add(signature); continue;
    }
    throw new Error("reviewed managed invoicing refuses statement or donor attribute drift");
  }
  if (definitions.size !== allowed.signatures.length || grants.size !== definitions.size || revokes.size !== definitions.size + (allowed === managedInvoicing[2] ? 1 : 0) || tables !== (allowed === managedInvoicing[2] ? 1 : 0) || rls !== (allowed === managedInvoicing[2] ? 1 : 0)) throw new Error("reviewed managed invoicing has missing definitions or service-only ACLs");
}

const git = (root: string, args: string[]) => documentationGit(root, args);
function blob(root: string, revision: string, path: string): Buffer | undefined {
  const listing = git(root, ["ls-tree", "-z", revision, "--", path]).toString("utf8");
  if (!listing) return undefined;
  const match = /^100644 blob ([a-f0-9]{40})\t[^\0]+\0$/u.exec(listing);
  if (!match) throw new Error(`reviewed replacement requires a regular file: ${path}`);
  return git(root, ["cat-file", "blob", match[1]!]);
}

const FORWARD_LISTS = ["replacementForwards", "creationForwards", "runtimeForwards", "portableReplacementForwards", "portableCreationForwards", "managedInvoicingForwards", "batchedForwards"] as const;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const sharedApproval = (registry: ReviewedForwardRegistry) => Object.fromEntries(Object.entries(registry).filter(([key]) => !FORWARD_LISTS.includes(key as typeof FORWARD_LISTS[number])));
const approvalBinding = (registry: ReviewedForwardRegistry, path: string) => {
  for (const list of FORWARD_LISTS) {
    const index = registry[list]?.findIndex((entry) => entry.path === path) ?? -1;
    if (index >= 0) return { list, index, entry: registry[list]![index] };
  }
  return null;
};

/** Only an existing policy class may bind the SQL introduced by this candidate. */
export function changedForwardApprovals(before: Buffer, after: Buffer): string[] {
  const prior = readReviewedForwardRegistry(before), current = readReviewedForwardRegistry(after);
  if (canonical(sharedApproval(prior)) !== canonical(sharedApproval(current))) throw new Error("reviewed replacement shared approval fields must be approved separately");
  const changed: string[] = [];
  for (const list of FORWARD_LISTS) {
    const previous = prior[list] ?? [], next = current[list] ?? [];
    if (next.length < previous.length) throw new Error("reviewed replacement approval removal must be approved separately");
    for (const [index, entry] of next.entries()) {
      if (previous[index] && previous[index]!.path !== entry.path) throw new Error("reviewed replacement approval positions must be approved separately");
      if (canonical(previous[index]) !== canonical(entry)) changed.push(entry.path);
    }
  }
  return changed;
}

export function assertForwardApproval(root: string, base: string, head: string): void {
  const before = blob(root, base, REVIEWED_FORWARD_PATH), after = blob(root, head, REVIEWED_FORWARD_PATH);
  if (!before || !after) throw new Error("reviewed replacement registry must be approved separately before introducing SQL");
  if (before.equals(after)) return;
  for (const path of changedForwardApprovals(before, after)) {
    if (blob(root, base, path) || !blob(root, head, path)) throw new Error(`reviewed replacement pin must be approved separately unless its SQL is introduced in this PR: ${path}`);
  }
}

export function assertUnchangedForwardApproval(root: string, base: string, head: string, path?: string): void {
  const before = blob(root, base, REVIEWED_FORWARD_PATH), after = blob(root, head, REVIEWED_FORWARD_PATH);
  if (before && after) {
    if (path === undefined && before.equals(after)) return;
    // Release pins each approval's content and position so later controls may append unrelated approvals.
    if (path !== undefined) {
      try {
        const prior = readForwardRegistry(before, true), current = readForwardRegistry(after, true);
        const previous = approvalBinding(prior, path), next = approvalBinding(current, path);
        if (canonical(sharedApproval(prior)) === canonical(sharedApproval(current)) && previous && next && canonical(previous) === canonical(next)) return;
      } catch { /* Invalid historical approvals cannot authorize a release. */ }
    }
  }
  throw new Error("reviewed replacement allowlist must be approved separately before a feature PR adds SQL");
}

/** Run from trusted main. Candidate objects are data; their validator is never loaded. */
export function assertCoLocatedForwardApproval(root: string, base: string, head: string, trustedBase = base): void {
  const before = blob(root, base, REVIEWED_FORWARD_PATH), after = blob(root, head, REVIEWED_FORWARD_PATH);
  if (before && after && before.equals(after)) return;
  const added = git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, head, "--", "db/platform/migrations/", "supabase/migrations/"]).toString("utf8").split("\0").filter((path) => path.endsWith(".sql"));
  if (added.length === 0) return; // Existing control-only preparation remains available.
  if (!before || !after) throw new Error("reviewed replacement registry must be approved separately before introducing SQL");
  const controls = ["scripts/reviewed-platform-forward.ts", "scripts/platform-migration-manifest.ts", "scripts/documentation-git.ts", "scripts/documentation-routing.ts", "package.json", "package-lock.json"];
  const changed = [head, trustedBase].flatMap((revision) => git(root, ["diff", "--name-only", "--no-renames", "-z", base, revision]).toString("utf8").split("\0"));
  const releaseTool = (path: string) => /^scripts\/(?:agent-review-|oss-|source-|packages\/)/u.test(path) && !/\.test\.[cm]?[jt]sx?$/u.test(path);
  if (changed.some((path) => controls.includes(path) || path.startsWith(".github/") || releaseTool(path))) throw new Error("reviewed replacement admission machinery must be approved separately before co-located SQL/pins");
  assertForwardApproval(root, base, head);
  const registry = readReviewedForwardRegistry(after);
  for (const list of FORWARD_LISTS) for (const entry of registry[list] ?? []) {
    if (added.includes(entry.path)) assertReviewedPlatformForward(root, base, head, entry.path, blob(root, head, entry.path)!);
  }
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

function headerAttributes(statement: string): string {
  const opening = /\bAS (\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/u.exec(statement);
  if (!opening) throw new Error("reviewed replacement runtime requires a dollar body");
  const closing = statement.indexOf(opening[1]!, opening.index + opening[0].length);
  if (closing < 0 || !/^\s*;\s*$/u.test(statement.slice(closing + opening[1]!.length))) throw new Error("reviewed replacement runtime refuses attributes after its dollar body");
  return statement.slice(0, opening.index).replace(/^CREATE OR REPLACE /u, "CREATE ");
}

/** Both required CI and release preparation use this exact path/byte/signature check. */
export function assertReviewedPlatformForward(root: string, base: string, head: string, path: string, bytes: Buffer, release = false): void {
  const controlByte = (byte: number) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f;
  if (bytes.some(controlByte)) throw new Error(`reviewed replacement refuses control characters in a forward: ${path}`);
  const targetRegistry = blob(root, head, REVIEWED_FORWARD_PATH);
  if (!targetRegistry) throw new Error(`non-expand-only forward has no reviewed replacement approval: ${path}`);
  const registry = readReviewedForwardRegistry(targetRegistry);
  const portable = path.startsWith("db/platform/migrations/");
  const candidates = portable ? [...registry.portableReplacementForwards ?? [], ...registry.portableCreationForwards ?? []] : [...registry.replacementForwards, ...registry.creationForwards, ...(registry.runtimeForwards ?? []), ...(registry.managedInvoicingForwards ?? [])];
  const forward = [...candidates, ...(registry.batchedForwards ?? [])].find((entry) => entry.path === path);
  if (!forward) throw new Error(`non-expand-only forward differs from reviewed replacement path or bytes: ${path}`);
  let approval = base;
  if (release) {
    // Bind at the unique mainline introduction, never at a later repair of the pins.
    const commits = git(root, ["log", "--first-parent", "--format=%H", "--diff-filter=A", `${base}..${head}`, "--", path]).toString("utf8").trim().split("\n").filter(Boolean);
    if (commits.length !== 1) throw new Error("reviewed replacement requires one unambiguous forward introduction");
    approval = git(root, ["rev-parse", `${commits[0]}^`]).toString("utf8").trim();
    git(root, ["merge-base", "--is-ancestor", approval, head]);
    try { assertUnchangedForwardApproval(root, approval, commits[0]!, path); }
    catch { assertForwardApproval(root, approval, commits[0]!); }
    assertUnchangedForwardApproval(root, commits[0]!, head, path);
  } else {
    assertForwardApproval(root, base, head);
  }
  if (sqlSha256(bytes) !== forward.sha256) throw new Error(`non-expand-only forward differs from reviewed replacement path or bytes: ${path}`);
  const baselinePath = portable ? PLATFORM_BASELINE_FILE : MANAGED_BASELINE;
  const baseline = blob(root, approval, baselinePath);
  if (!baseline || (!portable && sqlSha256(baseline) !== registry.baselineSha256)) throw new Error("reviewed replacement immutable baseline drifted");
  if (registry.batchedForwards?.includes(forward as BatchedForwardBinding)) {
    for (const prior of registry.batchedForwards!) {
      if (prior.path >= path || prior.path.startsWith("db/") !== portable) continue;
      const landed = blob(root, head, prior.path);
      if (!landed || sqlSha256(landed) !== prior.sha256) throw new Error("reviewed batch requires every earlier same-rail pin landed first");
    }
    const paths = git(root, ["ls-tree", "-r", "--name-only", head, "--", portable ? "db/platform/migrations/" : "supabase/migrations/"]).toString("utf8").trim().split("\n").filter((item) => item < path).sort();
    assertBatchedForward(forward as BatchedForwardBinding, bytes, paths.map((priorPath) => blob(root, head, priorPath)!));
    return;
  }
  if (registry.portableCreationForwards?.includes(forward)) {
    const paths = git(root, ["ls-tree", "-r", "--name-only", head, "--", "db/platform/migrations/"]).toString("utf8").trim().split("\n").filter((item) => item < path).sort();
    assertPortableCreationStatements(bytes, paths.map((priorPath) => blob(root, head, priorPath)!));
    return;
  }
  // Creation-only entries returned above; existing classes retain their function bindings.
  const functionForward = forward as ForwardBinding;
  const names = new Set(functionForward.functions.map(({ signature }) => signature.split("(")[0]!));
  const prior = reviewedFunctionDefinitions(baseline, names);
  const priorPolicies = reviewedPolicyDefinitions(baseline);
  const priorStatements = new Map<string, string>();
  const collectPriorStatements = (source: Buffer) => {
    for (const statement of sqlStatements(source.toString("utf8"), true)) {
      const header = /^CREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\)\s+RETURNS\s+/iu.exec(identityHeaderSql(statement));
      if (header && names.has(header[1]!.toLowerCase())) priorStatements.set(functionSignature(header[1]!, header[2]!), statement);
    }
  };
  collectPriorStatements(baseline);
  // The portable manifest validator requires strict filename order and exact catalogue coverage.
  // Thus path order below is the same as portable installation order; never read the managed rail.
  const directory = portable ? "db/platform/migrations/" : "supabase/migrations/";
  const paths = git(root, ["ls-tree", "-r", "--name-only", head, "--", directory]).toString("utf8").trim().split("\n").filter((item) => item !== baselinePath && item < path).sort();
  for (const priorPath of paths) {
    const source = blob(root, head, priorPath)!;
    for (const [signature, sha256] of reviewedFunctionDefinitions(source, names)) prior.set(signature, sha256);
    collectPriorStatements(source);
    updatePolicyDefinitions(priorPolicies, source);
  }
  const definitions = reviewedFunctionDefinitions(bytes);
  if (portable) {
    const statements = sqlStatements(bytes.toString("utf8"));
    const statement = statements[0]!;
    const preceding = priorStatements.get(functionForward.functions[0]!.signature);
    if (statements.length !== 1 || !/^CREATE OR REPLACE FUNCTION public\.[a-z_][a-z0-9_]*\(/u.test(statement)) throw new Error("reviewed portable replacement requires only one CREATE OR REPLACE FUNCTION");
    if (!preceding || headerAttributes(statement) !== headerAttributes(preceding)) throw new Error("reviewed portable replacement function attributes drifted");
  } else if (registry.runtimeForwards?.includes(forward as RuntimeForwardBinding)) {
    const runtime = forward as RuntimeForwardBinding;
    const identity = registry.runtimeForwards[1] === runtime;
    const privileges: string[] = [];
    const retiredPolicies: string[] = [];
    for (const statement of sqlStatements(bytes.toString("utf8"))) {
      if (/^(?:BEGIN|COMMIT);$/iu.test(statement)) continue;
      const header = /^CREATE OR REPLACE FUNCTION (public\.[a-z_][a-z0-9_]*)\(([^)]*)\)\s+RETURNS\s+/iu.exec(identityHeaderSql(statement));
      if (header && !identity) {
        const signature = functionSignature(header[1]!, header[2]!);
        const preceding = priorStatements.get(signature);
        if (!runtimeReplacements.has(signature) || !preceding || headerAttributes(statement) !== headerAttributes(preceding)) throw new Error("reviewed replacement runtime function attributes drifted");
        continue;
      }
      const retired = /^DROP POLICY ([a-z_]+) ON public\.([a-z_]+);$/u.exec(statement);
      if (retired && !identity) {
        const binding = runtime.retiredPolicies?.[retiredPolicies.length];
        if (privileges.length || !binding || binding.name !== retired[1] || binding.table !== retired[2] || priorPolicies.get(`${binding.table}.${binding.name}`) !== binding.beforeSha256) throw new Error("reviewed replacement runtime policy retirement differs from exact ordered preimages");
        retiredPolicies.push(statement);
        continue;
      }
      (identity ? identityPrivilegeKeys : runtimePrivilegeKeys)(statement);
      privileges.push(statement);
    }
    if (retiredPolicies.length !== (runtime.retiredPolicies?.length ?? 0)) throw new Error("reviewed replacement runtime has missing policy retirements");
    if (privileges.length !== runtime.privileges.length || privileges.some((statement, index) => statement !== runtime.privileges[index])) throw new Error("reviewed replacement runtime privileges differ from exact statement pins");
  } else if (registry.managedInvoicingForwards?.includes(functionForward)) {
    assertManagedInvoicingStatements(bytes, path);
  } else assertFunctionStatements(bytes, definitions);
  if (definitions.size !== functionForward.functions.length) throw new Error("reviewed replacement has missing or additional function signatures");
  for (const binding of functionForward.functions) {
    if (definitions.get(binding.signature) !== binding.afterSha256 || (prior.get(binding.signature) ?? null) !== binding.beforeSha256) throw new Error(`reviewed replacement definition drifted: ${binding.signature}`);
  }
}


// This list is separate from the legacy classes: no timestamp/private-schema
// widening reaches #267/#295/#300. Per rail, pins must land as a prefix in version order.
const batchedShapes = new Map<string, readonly string[]>([
  ["db/platform/migrations/20261022160000_subscription_retry_lifecycle.sql", ["public.subscription_retry_read(uuid)","public.subscription_retry_candidates(integer,timestamptz)","public.subscription_retry_apply_failure(uuid,text,jsonb)","public.subscription_retry_open_case(uuid,text,text)","public.subscription_retry_authorize_recovery(uuid,uuid,text,text,timestamptz)","public.subscription_retry_schedule_recovery(uuid,text,uuid,timestamptz)","public.subscription_retry_prepare(uuid,text,jsonb,timestamptz)","public.subscription_retry_record_recovery(uuid,text,jsonb)","public.subscription_retry_note_row_outcome(uuid,text,jsonb)"]],
  ["db/platform/migrations/20261024170000_subscription_command_lifecycle.sql", ["public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)","public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz)"]],
  ["db/platform/migrations/20261024180000_subscription_stock_wait.sql", ["public.subscription_stock_wait_projection(public.subscription_stock_wait_cases)","public.subscription_stock_wait_read(uuid)","public.subscription_stock_wait_frozen(uuid,timestamptz)","public.subscription_stock_wait_deficits(jsonb,uuid,timestamptz)","public.subscription_stock_wait_enqueue(public.subscription_stock_wait_cases,text)","public.subscription_stock_wait_recover_refusal(uuid,text,text,timestamptz)","public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz)","public.subscription_stock_wait_candidates(integer,timestamptz)","public.subscription_stock_wait_normal_due(integer,timestamptz)","public.subscription_stock_wait_mark_resumed(uuid)","public.subscription_stock_wait_summary(text)","public.subscription_stock_wait_bind_notice(uuid,uuid,jsonb)"]],
  ["db/platform/migrations/20261024183000_inventory_available_to_promise.sql", ["public.inventory_channel_exposure_quantity(text,text)","public.inventory_available_to_promise(text,text,timestamptz,boolean)","public.inventory_new_purchase_stock_read(text,jsonb,timestamptz)"]],
  ["db/platform/migrations/20261024184000_subscription_renewal_reserve_uses_seam.sql", ["public.fulfillment_reserve_subscription_renewal(uuid,uuid,integer,timestamptz)"]],
  ["db/platform/migrations/20261024184500_subscription_retry_late_positive_stock.sql", ["public.subscription_retry_record_recovery(uuid,text,jsonb)"]],
  ["db/platform/migrations/20261024184600_subscription_retry_candidate_payment_filter.sql", ["public.subscription_retry_candidates(integer,timestamptz)"]],
  ["supabase/migrations/20261024155000_refunds_preserve_subscription_lifecycle.sql", ["public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)"]],
  ["supabase/migrations/20261024160000_subscription_dunning_continuity.sql", ["public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz)","public.subscription_record_payment_recovery_before_expired_resume(text,text,text,text,timestamptz)","public.subscription_try_schedule_recovery_retry(uuid,text,timestamptz,text)","public.subscription_list_due_for_renewal(integer,timestamptz)","public.commerce_payment_control_prepare_provider_attempt(text,uuid,text,text,text,text,text,jsonb)"]],
  ["supabase/migrations/20261024175000_inventory_available_to_promise.sql", ["public.inventory_channel_exposure_quantity(uuid)","public.inventory_available_to_promise(uuid,timestamptz,boolean)"]],
  ["supabase/migrations/20261024180000_subscription_stock_wait.sql", ["public.subscription_stock_wait_projection(public.subscription_stock_wait_cases)","public.subscription_stock_wait_read(uuid)","public.subscription_stock_wait_frozen(uuid,timestamptz)","public.subscription_stock_wait_deficits(jsonb,uuid,timestamptz)","public.subscription_stock_wait_enqueue(public.subscription_stock_wait_cases,text)","public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz)","public.subscription_stock_wait_candidates(integer,timestamptz)","public.subscription_stock_wait_mark_resumed(uuid)","public.subscription_stock_wait_normal_due(integer,timestamptz)","public.subscription_stock_wait_summary(text)","public.subscription_stock_wait_bind_notice(uuid,uuid,jsonb)"]],
  ["supabase/migrations/20261024181000_subscription_stock_wait_due.sql", ["public.subscription_list_due_for_renewal(integer,timestamptz)"]],
  ["supabase/migrations/20261024182000_subscription_lifecycle_message_scan.sql", ["private.outbox_resend_event_types()","public.communication_email_delivery_template_for_event(text)","public.subscription_list_due_for_winback(integer)"]],
  ["supabase/migrations/20261024184000_inventory_reserve_order_uses_seam.sql", ["public.inventory_reserve_order(text,uuid,uuid,uuid,uuid,integer,text,text,timestamptz,jsonb,text)"]],
  ["supabase/migrations/20261024185000_provider_refund_evidence.sql", ["public.commerce_order_provider_refund_evidence(uuid)"]],
  ["supabase/migrations/20261024185100_m07_refund_parity.sql", ["public.commerce_emit_order_refunded_outbox()","public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)"]],
]);
const batchIdentity = (name: string, args: string): string => {
  const types = args.trim() ? args.split(",").map(argument => {
    const type = /^(?:[a-z_][a-z0-9_]*\s+)?(uuid|text|jsonb|integer|bigint|boolean|timestamptz|timestamp with time zone|public\.subscription_stock_wait_cases)(?:\s+DEFAULT\s+[\s\S]+)?$/iu.exec(argument.trim())?.[1];
    if (!type) throw new Error("reviewed batch refuses unsupported argument identity");
    return type.toLowerCase().replace("timestamp with time zone", "timestamptz");
  }) : [];
  return `${name.toLowerCase()}(${types.join(",")})`;
};

/** Separate identity reader; raw CREATE bytes, including defaults, stay hashed. */
export function batchedFunctionDefinitions(bytes: Buffer, names?: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const statement of sqlStatements(bytes.toString("utf8"), true)) {
    const prefix = /^CREATE(?: OR REPLACE)? FUNCTION ((?:public|private)\.[a-z_][a-z0-9_]*)\s*\(/iu.exec(statement);
    if (names && (!prefix || !names.has(prefix[1]!.toLowerCase()))) continue;
    const header = /^CREATE(?: OR REPLACE)? FUNCTION ((?:public|private)\.[a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*RETURNS\s/iu.exec(statement);
    if (!header) {
      if (/^CREATE(?: OR REPLACE)? FUNCTION /iu.test(statement)) throw new Error("reviewed batch refuses unsupported function header");
      continue;
    }
    const signature = batchIdentity(header[1]!, header[2]!);
    if (result.has(signature)) throw new Error(`reviewed batch duplicate signature: ${signature}`);
    result.set(signature, sqlSha256(statement));
  }
  return result;
}

function validateBatchedForwards(forwards: BatchedForwardBinding[], paths: Set<string>, historical: boolean): void {
  // Only the exact old identities and ordering used at N1's introduction are
  // accepted for history. Current candidates always require the new 16-pin set.
  const shapes = historical && forwards?.length === 14
    ? [...batchedShapes].filter(([path]) => !/20261024184[56]00_/u.test(path))
      .map(([path, signatures]) => [path.includes("20261022160000_subscription_retry_lifecycle") ? path : path.replace("20261024", "20261022"), signatures] as const)
    : [...batchedShapes];
  if (!Array.isArray(forwards) || forwards.length !== shapes.length) throw new Error("reviewed batch requires exactly the approved forwards");
  const last = new Map<string, string>();
  for (const [index, forward] of forwards.entries()) {
    const shape = shapes[index]!;
    if (!forward || Object.keys(forward).sort().join(",") !== "functions,path,sha256,statements" || forward.path !== shape[0] || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || JSON.stringify(forward.functions.map(fn => fn.signature)) !== JSON.stringify(shape[1]) || !Array.isArray(forward.statements) || !forward.statements.length) throw new Error("reviewed batch has an invalid path, order or signature inventory");
    paths.add(forward.path);
    for (const fn of forward.functions) {
      if (Object.keys(fn).sort().join(",") !== "afterSha256,beforeSha256,signature" || !hash(fn.afterSha256) || (fn.beforeSha256 !== null && !hash(fn.beforeSha256))) throw new Error("reviewed batch has invalid definition hashes");
      const key = `${forward.path.startsWith("db/") ? "native" : "managed"}:${fn.signature}`;
      if (last.has(key) && fn.beforeSha256 !== last.get(key)) throw new Error("reviewed batch replacement chain is reordered or discontinuous");
      last.set(key, fn.afterSha256);
    }
    for (const statement of forward.statements) {
      if (!statement || !hash(statement.sha256) || !["sha256", "sha256,sql"].includes(Object.keys(statement).sort().join(",")) || (statement.sql !== undefined && (typeof statement.sql !== "string" || sqlSha256(statement.sql) !== statement.sha256))) throw new Error("reviewed batch has an invalid statement pin");
    }
  }
}

/** Lexer is a pre-filter. Required real-PG/pgTAP tests prove the catalog delta. */
export function assertBatchedForward(forward: BatchedForwardBinding, bytes: Buffer, preceding: Buffer[]): void {
  if (bytes.some(byte => (byte < 0x20 && byte !== 9 && byte !== 10) || byte === 0x7f)) throw new Error("reviewed batch refuses control characters");
  if (!batchedShapes.has(forward.path) || sqlSha256(bytes) !== forward.sha256) throw new Error("reviewed batch path or bytes drifted");
  const definitions = batchedFunctionDefinitions(bytes);
  const prior = new Map<string, string>();
  const names = new Set(forward.functions.map(fn => fn.signature.split("(")[0]!));
  for (const source of preceding) for (const [signature, digest] of batchedFunctionDefinitions(source, names)) prior.set(signature, digest);
  if (definitions.size !== forward.functions.length) throw new Error("reviewed batch missing or extra signatures");
  for (const fn of forward.functions) {
    if (definitions.get(fn.signature) !== fn.afterSha256 || (prior.get(fn.signature) ?? null) !== fn.beforeSha256) throw new Error(`reviewed batch definition drifted: ${fn.signature}`);
  }
  const statements = sqlStatements(bytes.toString("utf8"));
  // Fixed native body replacements retain their prior headers and ACLs. Dates
  // cannot classify N1 or the interleaved, already-landed M08/M09 forwards.
  const nativeReplacement = [
    "db/platform/migrations/20261024184000_subscription_renewal_reserve_uses_seam.sql",
    "db/platform/migrations/20261024184500_subscription_retry_late_positive_stock.sql",
    "db/platform/migrations/20261024184600_subscription_retry_candidate_payment_filter.sql",
  ].includes(forward.path);
  if (forward.path.startsWith("db/") && !nativeReplacement) assertPortableCreationStatements(bytes, preceding);
  if (statements.length !== forward.statements.length) throw new Error("reviewed batch missing or extra statements");
  for (const [index, statement] of statements.entries()) {
    const pin = forward.statements[index]!;
    if (sqlSha256(statement) !== pin.sha256 || (pin.sql !== undefined && statement !== pin.sql)) throw new Error("reviewed batch ordered statement pin drifted");
    const routine = /^CREATE(?: OR REPLACE)? FUNCTION ((?:public|private)\.[a-z_][a-z0-9_]*)\s*\(/iu.exec(statement);
    if (routine) {
      headerAttributes(statement);
      continue;
    }
    // Every non-function statement carries its exact SQL as well as its hash.
    if (pin.sql !== statement) throw new Error("reviewed batch requires exact non-function statements");
    if (/^(?:GRANT EXECUTE ON FUNCTION|REVOKE ALL ON FUNCTION) /iu.test(statement)) {
      const target = /^(GRANT EXECUTE|REVOKE ALL) ON FUNCTION ((?:public|private)\.[a-z_][a-z0-9_]*)\(([^)]*)\) (TO|FROM) ([a-z_, ]+);$/iu.exec(statement);
      if (target && definitions.has(batchIdentity(target[2]!, target[3]!)) && (target[1]!.toUpperCase() !== "GRANT EXECUTE" || (forward.path.startsWith("supabase/") && forward.functions.some(fn => fn.signature === batchIdentity(target[2]!, target[3]!) && fn.beforeSha256 === null))) && (target[1]!.toUpperCase() === "GRANT EXECUTE" ? target[4]!.toUpperCase() === "TO" && target[5] === "service_role" : target[4]!.toUpperCase() === "FROM" && target[5]!.split(",").every(role => ["public", "anon", "authenticated", "openlup_mcp_reader"].includes(role.trim().toLowerCase())))) continue;
      throw new Error("reviewed batch function privilege target or grantee drifted");
    }
    if (forward.path.endsWith("20261024160000_subscription_dunning_continuity.sql") && statement === "GRANT SELECT (id, retry_attempt) ON public.subscription_cycles TO service_role;") continue;
    if (forward.path === "supabase/migrations/20261024180000_subscription_stock_wait.sql" && statement === "GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscription_stock_wait_cases TO service_role;") continue;
    if (/^ALTER TABLE public\.subscription_stock_wait_cases ENABLE ROW LEVEL SECURITY;$/u.test(statement)) continue;
    if (/^INSERT INTO public\.comms_notification_controls\(slug,enabled\) VALUES\s+\('subscription-stock-wait-started',true\),\('subscription-stock-wait-resumed',true\) ON CONFLICT\(slug\) DO NOTHING;$/u.test(statement)) continue;
    if (/^INSERT INTO public\.client_absorption_policy \(table_name, disposition, note\) VALUES\s+\('subscription_stock_wait_cases', 'block',\s+'A frozen subscription delivery is a commercial obligation bound to its original client; never carry or rebind it when absorbing a lead\.'\);$/u.test(statement)) continue;
    if (/^COMMENT ON FUNCTION public\.commerce_emit_order_refunded_outbox\(\) IS\s+'(?:[^']|'')*';$/u.test(statement)) continue;
    const revokeTable = /^REVOKE ALL ON (?:TABLE )?([a-z_., ]+) FROM ([a-z_, ]+);$/iu.exec(statement);
    if (revokeTable) {
      const tables = new Set(statements.flatMap(sql => /^CREATE TABLE (public\.[a-z_][a-z0-9_]*)\s*\(/u.exec(sql)?.[1] ?? []));
      if (revokeTable[1]!.split(",").every(target => tables.has(target.trim())) && revokeTable[2]!.split(",").every(role => ["public", "anon", "authenticated", "openlup_mcp_reader"].includes(role.trim().toLowerCase()))) continue;
      throw new Error("reviewed batch table revocation target or role drifted");
    }
    if (/^CREATE (?:TABLE|INDEX) /u.test(statement)) {
      // New-object safety is checked by the native classifier where applicable;
      // all actual objects/ACLs are independently inventoried by PostgreSQL.
      if (!forward.functions.every(fn => fn.beforeSha256 === null)) throw new Error("reviewed batch replacement cannot create relations");
      continue;
    }
    throw new Error(`reviewed batch unexpected statement kind: ${statement.slice(0,100)}`);
  }
  if (nativeReplacement) {
    const statement = statements[0]!;
    const name = forward.functions[0]!.signature;
    const previous = preceding.flatMap(source => sqlStatements(source.toString("utf8"), true)).filter(sql => batchedFunctionDefinitions(Buffer.from(sql), names).has(name)).at(-1);
    if (statements.length !== 1 || !/^CREATE OR REPLACE FUNCTION /u.test(statement) || !previous || headerAttributes(statement) !== headerAttributes(previous)) throw new Error("reviewed batch portable replacement attributes drifted");
  }
}
