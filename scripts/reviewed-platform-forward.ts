import { createHash } from "node:crypto";
import { PLATFORM_BASELINE_FILE, QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE, QUALIFIED_IMPORT_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE, QUALIFIED_OWNER_PATH_FILE, ADMIN_BASELINE_FILE, ADMIN_ACTOR_FILE, ADMIN_ACQUISITION_FILE, ADMIN_RUNTIME_FILE, ADMIN_IMPORT_FILE, REVISED_ADMIN_ACTOR_FILE, REVISED_ADMIN_ACQUISITION_FILE, REVISED_ADMIN_RUNTIME_FILE, REVISED_ADMIN_IMPORT_FILE, isQualifiedPlatformMigrationPath } from "./platform-migration-manifest.ts";
import { documentationGit, readDocumentationObjects } from "./documentation-git.ts";

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
const qualifiedInstallationPaths = [QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE, QUALIFIED_IMPORT_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE, QUALIFIED_OWNER_PATH_FILE, ADMIN_BASELINE_FILE, ADMIN_ACTOR_FILE, ADMIN_ACQUISITION_FILE, ADMIN_RUNTIME_FILE, ADMIN_IMPORT_FILE, REVISED_ADMIN_ACTOR_FILE, REVISED_ADMIN_ACQUISITION_FILE, REVISED_ADMIN_RUNTIME_FILE, REVISED_ADMIN_IMPORT_FILE];
const qualifiedOwnerPathSignatures = [
  "acquisition_private.keyed_digest(text,jsonb)",
  "acquisition_private.case_projection(uuid)",
  "acquisition_private.refuse_append_only_mutation()",
  "public.acquisition_case_submit_v1(text,text,text,text,boolean,text,text,text,text,text,text,text,text,timestamptz)",
  "public.acquisition_case_operator_list_v1(uuid,timestamptz,uuid,integer)",
  "public.acquisition_case_transition_v1(uuid,text,bigint,text,text,text,timestamptz)",
  "public.acquisition_case_active_count_v1()",
  "public.customer_subject_capture_lifecycle()",
  "public.subscription_delivery_alignment_guard_cycle_insert()",
] as const;
type FunctionBinding = { signature: string; beforeSha256: string | null; afterSha256: string };
type PolicyBinding = { table: string; name: string; beforeSha256: string };
type RuntimeForwardBinding = ForwardBinding & { privileges: string[]; retiredPolicies?: PolicyBinding[] };
type ForwardBinding = { path: string; sha256: string; functions: FunctionBinding[] };
export type BatchedForwardBinding = ForwardBinding & { statements: { sha256: string; sql?: string }[] };
export type ManagedCommerceForwardBinding = BatchedForwardBinding & { constraints?: { table: string; name: string; beforeSha256: string; beforeSql: string }[] };
export type SupportAuthorityForwardBinding = ManagedCommerceForwardBinding;
export type ReviewedForwardRegistry = { qualifiedInstallations?: (PortableCreationBinding | ForwardBinding)[]; supportAuthorityForwards?: SupportAuthorityForwardBinding[]; managedCommerceForwards?: ManagedCommerceForwardBinding[]; batchedForwards?: BatchedForwardBinding[]; schemaVersion: 1; baselineSha256: string; replacementForwards: ForwardBinding[]; creationForwards: ForwardBinding[]; runtimeForwards?: RuntimeForwardBinding[]; portableReplacementForwards?: ForwardBinding[]; portableCreationForwards?: PortableCreationBinding[]; managedInvoicingForwards?: ForwardBinding[] };
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

// Only approval-history comparison may read the exact prior inventories.
// Candidate admission always uses the strict public reader above.
function readForwardRegistry(bytes: Buffer, historical: boolean): ReviewedForwardRegistry {
  const raw = JSON.parse(bytes.toString("utf8")) as ReviewedForwardRegistry;
  if (raw.schemaVersion !== 1 || !hash(raw.baselineSha256) || !Array.isArray(raw.replacementForwards) || raw.replacementForwards.length !== 2 || !Array.isArray(raw.creationForwards) || raw.creationForwards.length !== 1) throw new Error("reviewed replacement registry requires one baseline, two replacement forwards and one creation forward");
  const paths = new Set<string>(), signatures = new Set<string>(), replaced = new Set<string>();
  if (raw.qualifiedInstallations !== undefined) {
    if (!Array.isArray(raw.qualifiedInstallations) || ![4, 5, 6, 7, 12, 16].includes(raw.qualifiedInstallations.length)) throw new Error("qualified installation approval requires an exact issued prefix or all four revised restricted identities");
    for (const [index, entry] of raw.qualifiedInstallations.entries()) {
      if (!entry || entry.path !== qualifiedInstallationPaths[index] || !hash(entry.sha256)) throw new Error("qualified installation approval has an invalid fixed identity or hash");
      if (index !== 6) {
        if (Object.keys(entry).sort().join(",") !== "path,sha256") throw new Error("qualified installation approval has an invalid fixed identity or hash");
      } else {
        const forward = entry as ForwardBinding;
        if (Object.keys(forward).sort().join(",") !== "functions,path,sha256"
          || !Array.isArray(forward.functions)
          || JSON.stringify(forward.functions.map(fn => fn?.signature)) !== JSON.stringify(qualifiedOwnerPathSignatures)
          || forward.functions.some(fn => !fn || Object.keys(fn).sort().join(",") !== "afterSha256,beforeSha256,signature" || !hash(fn.beforeSha256) || !hash(fn.afterSha256))) throw new Error("qualified installation approval has an invalid owner path function binding");
      }
      paths.add(entry.path);
    }
  }
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
  if (raw.managedCommerceForwards !== undefined) {
    if (!raw.batchedForwards) throw new Error("reviewed M11 commerce requires the complete M10 controls");
    validateManagedCommerceForwards(raw.managedCommerceForwards, paths, historical);
  }
  if (raw.supportAuthorityForwards !== undefined) validateSupportAuthorityForwards(raw.supportAuthorityForwards, paths);
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

function qualifiedFunctionIdentity(statement: string): string | null {
  const header = /^CREATE(?: OR REPLACE)? FUNCTION ((?:public|acquisition_private)\.[a-z_][a-z0-9_]*)\(([\s\S]*?)\)\s+RETURNS\s/iu.exec(statement);
  if (!header) return null;
  const args = header[2]!.trim();
  const types = args ? args.split(",").map(argument => {
    const match = /^(?:[a-z_][a-z0-9_]*\s+)?(uuid|text|jsonb|integer|bigint|boolean|timestamptz)$/iu.exec(argument.trim());
    if (!match) throw new Error("qualified owner path forward has an unsupported function identity");
    return match[1]!.toLowerCase();
  }) : [];
  return `${header[1]!.toLowerCase()}(${types.join(",")})`;
}

/** The reviewed tail may only replace the nine exact definitions with a pinned path. */
export function assertQualifiedOwnerPathForward(binding: ForwardBinding, bytes: Buffer, issuedSources: readonly Buffer[]): void {
  if (binding.path !== QUALIFIED_OWNER_PATH_FILE || sqlSha256(bytes) !== binding.sha256) throw new Error("qualified owner path forward path or bytes drifted");
  const previous = new Map<string, string>();
  for (const source of issuedSources) for (const statement of sqlStatements(source.toString("utf8"))) {
    const signature = qualifiedFunctionIdentity(statement);
    if (signature && qualifiedOwnerPathSignatures.includes(signature as typeof qualifiedOwnerPathSignatures[number])) previous.set(signature, statement);
  }
  const statements = sqlStatements(bytes.toString("utf8"));
  if (statements.length !== qualifiedOwnerPathSignatures.length || previous.size !== statements.length) throw new Error("qualified owner path forward has a missing or extra definition");
  for (const [index, statement] of statements.entries()) {
    const pin = binding.functions[index]!, signature = qualifiedOwnerPathSignatures[index]!;
    const prior = previous.get(signature);
    if (!prior || qualifiedFunctionIdentity(statement) !== signature || pin.signature !== signature
      || sqlSha256(prior) !== pin.beforeSha256 || sqlSha256(statement) !== pin.afterSha256) throw new Error("qualified owner path function identity or preimage drifted");
    const expected = prior.replace(/^CREATE FUNCTION /u, "CREATE OR REPLACE FUNCTION ")
      .replace(/SET search_path = pg_catalog(\s+AS\b)/u, "SET search_path = pg_catalog, pg_temp$1");
    if (expected === prior || statement !== expected) throw new Error("qualified owner path forward changes more than the pinned name-resolution attribute");
  }
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

const FORWARD_LISTS = ["replacementForwards", "creationForwards", "runtimeForwards", "portableReplacementForwards", "portableCreationForwards", "managedInvoicingForwards", "batchedForwards", "managedCommerceForwards", "supportAuthorityForwards", "qualifiedInstallations"] as const;
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
  const previous = readReviewedForwardRegistry(before);
  for (const path of changedForwardApprovals(before, after)) {
    if (isQualifiedPlatformMigrationPath(path)) throw new Error("qualified installation bytes require separate exact approval before SQL introduction");
    if (!previous.supportAuthorityForwards && supportAuthorityShapes.some(shape => shape.path === path)) throw new Error("reviewed M12 support class must be approved separately before its SQL");
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
  if (before && after && !before.equals(after)) {
    const previousData = JSON.parse(before.toString("utf8")) as { qualifiedInstallations?: unknown } | null;
    const currentData = JSON.parse(after.toString("utf8")) as { qualifiedInstallations?: unknown } | null;
    if (previousData?.qualifiedInstallations !== undefined || currentData?.qualifiedInstallations !== undefined) {
      const previous = readForwardRegistry(before, true), current = readReviewedForwardRegistry(after);
      for (const [index, entry] of (previous.qualifiedInstallations ?? []).entries()) {
        if (canonical(current.qualifiedInstallations?.[index]) !== canonical(entry)) {
          throw new Error("issued qualified installation approvals are immutable");
        }
      }
    }
  }
  const added = git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, head, "--", "db/platform/migrations/", "supabase/migrations/"]).toString("utf8").split("\0").filter((path) => path.endsWith(".sql"));
  if (before && after && before.equals(after) && !added.some(isQualifiedPlatformMigrationPath)) return;
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
  const forward = [...candidates, ...(registry.batchedForwards ?? []), ...(registry.managedCommerceForwards ?? []), ...(registry.supportAuthorityForwards ?? []), ...(registry.qualifiedInstallations ?? [])].find((entry) => entry.path === path);
  if (!forward) throw new Error(`non-expand-only forward differs from reviewed replacement path or bytes: ${path}`);
  if (isQualifiedPlatformMigrationPath(path) && sqlSha256(bytes) !== forward.sha256) throw new Error(`qualified installation differs from its exact approved bytes: ${path}`);
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
  if (isQualifiedPlatformMigrationPath(path)) {
    assertUnchangedForwardApproval(root, approval, head, path);
    if (path === QUALIFIED_OWNER_PATH_FILE) {
      const acquisition = blob(root, head, QUALIFIED_ACQUISITION_FILE);
      const retained = blob(root, head, QUALIFIED_IMPORT_FILE);
      if (!acquisition || !retained) throw new Error("qualified owner path forward requires both issued definition sources");
      assertQualifiedOwnerPathForward(forward as ForwardBinding, bytes, [acquisition, retained]);
    }
    return;
  }
  const baselinePath = portable ? PLATFORM_BASELINE_FILE : MANAGED_BASELINE;
  const baseline = blob(root, approval, baselinePath);
  if (!baseline || (!portable && sqlSha256(baseline) !== registry.baselineSha256)) throw new Error("reviewed replacement immutable baseline drifted");
  if (registry.supportAuthorityForwards?.includes(forward as SupportAuthorityForwardBinding)) {
    const entries = git(root, ["ls-tree", "-rz", "--full-tree", head, "--", portable ? "db/platform/migrations/" : "supabase/migrations/"]).toString("utf8").split("\0").filter(Boolean);
    const preceding = entries.flatMap(entry => {
      const priorPath = entry.slice(entry.indexOf("\t") + 1);
      if (!priorPath.endsWith(".sql") || priorPath >= path) return [];
      const regular = /^100644 blob ([a-f0-9]{40})\t/u.exec(entry);
      if (!regular) throw new Error(`reviewed replacement requires a regular file: ${priorPath}`);
      return [{ path: priorPath, oid: regular[1]! }];
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const sources = readDocumentationObjects(root, preceding.map(source => source.oid));
    assertSupportAuthorityForward(registry, path, bytes, preceding.map((source, index) => ({ path: source.path, bytes: sources[index]! })));
    return;
  }
  if (registry.managedCommerceForwards?.includes(forward as ManagedCommerceForwardBinding)) {
    const paths = git(root, ["ls-tree", "-r", "--name-only", head, "--", "supabase/migrations/"]).toString("utf8").trim().split("\n").filter(item => item.endsWith(".sql") && item < path).sort();
    assertManagedCommerceForward(registry, path, bytes, paths.map(path => ({ path, bytes: blob(root, head, path)! })));
    return;
  }
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
  ["supabase/migrations/20261025090000_subscription_dunning_attempt_replay.sql", ["public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz)","public.subscription_handle_payment_failure_dunning(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,text)","public.subscription_open_dunning_before_sub_lock(text,uuid,text,text,timestamptz,text)","public.subscription_open_dunning_from_failed_payment_result(text,uuid,text,text,timestamptz,text)","public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,uuid)","public.subscription_handle_payment_failure_dunning(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,text,uuid)","public.subscription_open_dunning_before_sub_lock(text,uuid,text,text,timestamptz,text,uuid)","public.subscription_open_dunning_from_failed_payment_result(text,uuid,text,text,timestamptz,text,uuid)","public.commerce_payment_control_apply_reconciliation_result(text,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,timestamptz,jsonb,text,text)"]],
  ["supabase/migrations/20261025090100_subscription_dunning_attributed_advance.sql", ["public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,uuid)","public.commerce_payment_control_apply_reconciliation_result(text,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,timestamptz,jsonb,text,text)"]],
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
  // accepted for history. Current candidates always require the new 18-pin set.
  const shapes = historical && forwards?.length === 14
    ? [...batchedShapes].slice(0, 16).filter(([path]) => !/20261024184[56]00_/u.test(path))
      .map(([path, signatures]) => [path.includes("20261022160000_subscription_retry_lifecycle") ? path : path.replace("20261024", "20261022"), signatures] as const)
    : historical && forwards?.length === 16 ? [...batchedShapes].slice(0, 16) : [...batchedShapes];
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

// M10-9 admits only these four donor-exact prerequisite statements, on this
// one forward. Repinning data cannot authorize another backfill or DDL shape.
const attemptReplayPath = "supabase/migrations/20261025090000_subscription_dunning_attempt_replay.sql";
const attemptReplayPrerequisites = new Set([
  "a9c64efde021272fde97a37c765e9092a248e768ed46ca5761cb298455102ca7",
  "f9101fc9cdbbdac49442466a880a866169a3fce02c71bc40f8cc404d5837aa22",
  "d2adfee2b00eb83f3d85f93ea99e3dc3b5acb78ba85445acfdd1629157e34126",
  "11370721c06fe0d4a6bf9604f3365b768758d1157746769bdbd449c536475d2b",
]);
const attemptReplayPrivileges = new Set([
  "REVOKE ALL ON FUNCTION public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,uuid) FROM PUBLIC, anon, authenticated, service_role;",
  "REVOKE ALL ON FUNCTION public.subscription_open_dunning_before_sub_lock(text,uuid,text,text,timestamptz,text,uuid) FROM PUBLIC, anon, authenticated, service_role;",
  "REVOKE ALL ON FUNCTION public.subscription_handle_payment_failure_dunning(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,text,uuid) FROM PUBLIC, anon, authenticated;",
  "GRANT EXECUTE ON FUNCTION public.subscription_handle_payment_failure_dunning(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz,text,uuid) TO service_role;",
  "REVOKE ALL ON FUNCTION public.subscription_open_dunning_from_failed_payment_result(text,uuid,text,text,timestamptz,text,uuid) FROM PUBLIC, anon, authenticated;",
  "GRANT EXECUTE ON FUNCTION public.subscription_open_dunning_from_failed_payment_result(text,uuid,text,text,timestamptz,text,uuid) TO service_role;",
]);

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
  if (forward.path === attemptReplayPath || forward.path === "supabase/migrations/20261025090100_subscription_dunning_attributed_advance.sql") {
    const actual = statements.filter(sql => !/^CREATE(?: OR REPLACE)? FUNCTION /iu.test(sql)).map(sqlSha256);
    const expected = forward.path === attemptReplayPath ? [...attemptReplayPrerequisites, ...[...attemptReplayPrivileges].map(sqlSha256)] : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("reviewed batch M10-9 ordered prerequisite/ACL inventory drifted");
  }
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
    if (forward.path === attemptReplayPath && (attemptReplayPrerequisites.has(sqlSha256(statement)) || attemptReplayPrivileges.has(statement))) continue;
    if (/^(?:GRANT EXECUTE ON FUNCTION|REVOKE ALL ON FUNCTION) /iu.test(statement)) {
      if (forward.path === attemptReplayPath) throw new Error("reviewed batch M10-9 privilege drifted");
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

// M11 inventory pinned by managedCommerceForwards in config/reviewed-platform-forwards.json.
// The registry and real migration rails are authoritative; keep M09/M10 shapes separate.
// Header pins include argument names/defaults, return, language, security and path;
// only whitespace is normalized. Raw CREATE and whole-file pins bind bytes.
const managedCommerceSingleShapes = [
  ["20261025100000_checkout_preference_write_scope.sql", "public.commerce_configurator_persist_intent(jsonb)", false, "8bbc2d529811c4bf065460dcc2ac5306ad3692cec3c73f8146256f3d59b2e328"],
  ["20261025103000_return_request_owner_binding.sql", "public.commerce_return_request_create(text,uuid,jsonb,text,text,uuid)", false, "56e41099b294eaca73007fb00af584b343fb711618a826e60589daff8816522b"],
  ["20261025104000_checkout_operator_receipt.sql", "public.admin_checkout_payment_link_record_receipt(uuid,uuid,uuid,text,text,boolean,uuid)", true, "08d52ebc4f681fe228685f61fd303de1562c647330592e8da9496b52f2ce0171"],
  ["20261025105000_acquisition_metadata.sql", "private.commerce_acquisition_metadata(jsonb)", true, "21c44186472d3d63ebb03562473f0c55ff004864b123de70cc7ae0f0a2837716"],
  ["20261025106000_subscription_acquisition_terms.sql", "public.commerce_subscription_acquisition_terms(timestamptz)", true, "563fbd0f8546b8927078c16de55493c243b655d80b1ff1b71329f0b16bcfc48e"],
  ["20261025107000_checkout_acquisition_admission.sql", "private.commerce_assert_acquisition_admission(jsonb,uuid)", true, "165cc113d3c1ec21199d5ab588e74db33208c7a34433a7e601031fb0dd0e064c"],
  ["20261025108000_checkout_finalize_acquisition_admission.sql", "public.commerce_finalize_order_for_checkout(text,uuid,text,uuid,uuid,uuid,jsonb,jsonb,jsonb)", false, "ba2caf9f34d1a81fb364ef5a8802569b389e09cec0df882ead91acc4a5759a85"],
  ["20261025109000_inventory_new_purchase_stock_read.sql", "public.inventory_new_purchase_stock_read(jsonb,timestamptz)", true, "6c37031e5226cecfe4c19149012a816e96c60783cc9e523fdd725a9aa8c569cb"],
] as const;
const managedCommerceShapes = [
  ...managedCommerceSingleShapes.map(([file, signature, creation, header]) => ({ file, functions: [{ signature, creation, header }] })),
  {
    file: "20261025110000_starter_graduation_cadence.sql",
    functions: [
      { signature: "public.subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb)", creation: false, header: "0b6abf8e2ee6d360fa929a28fd73197424d246f15780e6d0778c22c94cc3bf74" },
      { signature: "public.subscription_apply_starter_graduation(uuid,text,text)", creation: false, header: "6383689a88940a2db69b41339162d896a258a43530edd450160b4d2f3510973c" },
    ],
  },
];
// The invoker header is readable only with its exact prior approval identity.
// SQL candidate admission uses managedCommerceShapes and the owner-privilege header.
const managedCommerceStockReaderHistory = {
  header: "5e4747468d7d38dd9e35544bf793650175431fd44e3532d2de3dd30fde6fc5ed",
  sha256: "d865ca086c379e24b37a0d541112925176f332600b4d61c47777a26930630bb5",
  afterSha256: "ef52b366a3a0641910020244aa9c49b06308fb5f0aca2867d49be092064efa61",
};
const commerceAuditTable = "public.admin_audit_events";
const commerceAuditConstraint = "admin_audit_events_action_check";
const commerceAuditBefore = "455c350e221aead32209302842a733e3bd39fd171c20fefb5b03d2224b4167b5";
const commerceAuditStatements = [
  "f90aea28aa7b613181a40931bb083f91d436b169d7903cbd969e97a0c71f86c2", // SET LOCAL lock_timeout
  "cd595b2bfc8826d0a097cb5a34e08be6990819c1c843f2528b80582f9b9a9ac7", // exact DROP
  "9c3f2af2de818ea355fc76d3eccef1640eac0f29924f5b731d5768d22d93c41d", // exact ADD, NOT VALID
];
function validateManagedCommerceForwards(forwards: ManagedCommerceForwardBinding[], paths: Set<string>, historical = false): void {
  // The prior seven/eight-pin classes remain readable only for approval history.
  const shapes = historical && [7, 8].includes(forwards?.length) ? managedCommerceShapes.slice(0, forwards.length) : managedCommerceShapes;
  if (!Array.isArray(forwards) || forwards.length !== shapes.length) throw new Error("reviewed M11 commerce requires exactly nine forwards");
  for (const [index, forward] of forwards.entries()) {
    const { file, functions } = shapes[index]!;
    const audit = index === 2;
    if (!forward || Object.keys(forward).sort().join(",") !== (audit ? "constraints,functions,path,sha256,statements" : "functions,path,sha256,statements") || forward.path !== `supabase/migrations/${file}` || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== functions.length) throw new Error("reviewed M11 commerce path, order or function inventory drifted");
    paths.add(forward.path);
    for (const [position, fn] of forward.functions.entries()) {
      const { signature, creation } = functions[position]!;
      if (!fn || Object.keys(fn).sort().join(",") !== "afterSha256,beforeSha256,signature" || fn.signature !== signature || !hash(fn.afterSha256) || (creation ? fn.beforeSha256 !== null : !hash(fn.beforeSha256))) throw new Error("reviewed M11 commerce signature or creation/replacement class drifted");
    }
    const statementCount = (audit ? 3 : 0) + functions.reduce((count, fn) => count + (fn.signature.startsWith("private.") ? 2 : 3), 0);
    if (!Array.isArray(forward.statements) || forward.statements.length !== statementCount) throw new Error("reviewed M11 commerce statement inventory drifted");
    for (const pin of forward.statements) {
      if (!pin || !hash(pin.sha256) || !["sha256", "sha256,sql"].includes(Object.keys(pin).sort().join(",")) || (pin.sql !== undefined && (typeof pin.sql !== "string" || sqlSha256(pin.sql) !== pin.sha256))) throw new Error("reviewed M11 commerce invalid statement pin");
    }
    if (index === 7) {
      const legacy = managedCommerceStockReaderHistory;
      const legacyPin = (pin: string) => pin === legacy.sha256 || pin === legacy.afterSha256;
      // Every legacy identifier belongs to the complete history-only tuple.
      if ([forward.sha256, forward.functions[0]!.afterSha256, ...forward.statements.map(pin => pin.sha256)].some(legacyPin)
        && (!historical || ![8, 9].includes(forwards.length) || forward.sha256 !== legacy.sha256
          || forward.functions[0]!.afterSha256 !== legacy.afterSha256 || forward.statements[0]!.sha256 !== legacy.afterSha256
          || forward.statements.slice(1).some(pin => legacyPin(pin.sha256)))) {
        throw new Error(`reviewed M11 commerce header ${legacy.header} requires exact approval history`);
      }
    }
    if (audit) {
      const constraint = forward.constraints?.[0];
      if (!Array.isArray(forward.constraints) || forward.constraints.length !== 1 || !constraint || Object.keys(constraint).sort().join(",") !== "beforeSha256,beforeSql,name,table" || constraint.table !== commerceAuditTable || constraint.name !== commerceAuditConstraint || constraint.beforeSha256 !== commerceAuditBefore || typeof constraint.beforeSql !== "string" || sqlSha256(constraint.beforeSql) !== constraint.beforeSha256) throw new Error("reviewed M11 commerce audit CHECK binding drifted");
    }
  }
}

/** The caller supplies the complete preceding managed rail, in filename order.
 * M11 versions follow every earlier same-rail pin; each pin requires all earlier
 * same-rail pins present with exact bytes. Production reads the registry and rail
 * from Git; tests supply registry pins. */
export function assertManagedCommerceForward(registry: ReviewedForwardRegistry, path: string, bytes: Buffer, preceding: { path: string; bytes: Buffer }[]): void {
  if (!registry.managedCommerceForwards) throw new Error("reviewed M11 commerce has no registry approval");
  validateManagedCommerceForwards(registry.managedCommerceForwards, new Set());
  validateBatchedForwards(registry.batchedForwards!, new Set(), false);
  const index = registry.managedCommerceForwards.findIndex(forward => forward.path === path);
  const forward = registry.managedCommerceForwards[index];
  if (!forward || sqlSha256(bytes) !== forward.sha256) throw new Error("reviewed M11 commerce path or bytes drifted");
  if (bytes.some(byte => (byte < 0x20 && byte !== 9 && byte !== 10) || byte === 0x7f)) throw new Error("reviewed M11 commerce refuses control characters");
  if (preceding[0]?.path !== MANAGED_BASELINE || sqlSha256(preceding[0].bytes) !== registry.baselineSha256 || preceding.some((source, i) => !/^supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(source.path) || source.path >= path || (i > 0 && source.path <= preceding[i - 1]!.path))) throw new Error("reviewed M11 commerce requires the ordered preceding managed rail and immutable baseline");
  for (const pin of [...registry.batchedForwards!, ...registry.managedCommerceForwards.slice(0, index)].filter(pin => pin.path.startsWith("supabase/"))) {
    const source = preceding.find(source => source.path === pin.path);
    if (!source || pin.path >= path || sqlSha256(source.bytes) !== pin.sha256) throw new Error("reviewed M11 commerce requires every earlier same-rail M10/M11 pin landed first");
  }
  const statements = sqlStatements(bytes.toString("utf8"));
  const definitions = batchedFunctionDefinitions(bytes);
  const names = new Set(forward.functions.map(fn => fn.signature.split("(")[0]!));
  const prior = new Map<string, string>();
  for (const source of preceding) {
    for (const statement of sqlStatements(source.bytes.toString("utf8"), true)) {
      // The immutable dump is bound by its hash. Later function DDL must use the
      // existing reader's supported spelling, rather than silently hiding a
      // replacement behind comments, quoted names or keyword whitespace.
      if (source.path !== MANAGED_BASELINE && /^(?:CREATE|ALTER|DROP)\b/iu.test(statement) && /\bFUNCTION\b/iu.test(statement) && !/^CREATE(?: OR REPLACE)? FUNCTION (?:public|private)\.[a-z_][a-z0-9_]*\s*\(/iu.test(statement)) throw new Error("reviewed M11 commerce refuses unsupported preceding function DDL");
      for (const [signature, digest] of batchedFunctionDefinitions(Buffer.from(statement), names)) prior.set(signature, digest);
    }
  }
  if (definitions.size !== forward.functions.length || forward.functions.some(fn => definitions.get(fn.signature) !== fn.afterSha256 || (prior.get(fn.signature) ?? null) !== fn.beforeSha256)) throw new Error("reviewed M11 commerce function preimage or definition drifted");
  if (statements.length !== forward.statements.length) throw new Error("reviewed M11 commerce missing or extra statements");
  const audit = index === 2;
  for (const [position, statement] of statements.entries()) {
    const pin = forward.statements[position]!;
    if (sqlSha256(statement) !== pin.sha256 || (pin.sql !== undefined && statement !== pin.sql)) throw new Error("reviewed M11 commerce ordered statement pin drifted");
  }
  if (audit && statements.slice(0, 3).some((statement, position) => sqlSha256(statement) !== commerceAuditStatements[position] || forward.statements[position]!.sql !== statement)) throw new Error("reviewed M11 commerce audit CHECK replacement drifted");
  let routineIndex = audit ? 3 : 0;
  for (const [position, fn] of forward.functions.entries()) {
    const shape = managedCommerceShapes[index]!.functions[position]!;
    const routine = statements[routineIndex]!;
    // Preserve the existing header normalization; body and file pins bind bytes.
    const header = headerAttributes(routine).replace(/\s+/gu, " ").trim();
    if (sqlSha256(header) !== shape.header || routine.startsWith("CREATE OR REPLACE FUNCTION ") !== !shape.creation || batchedFunctionDefinitions(Buffer.from(routine)).get(fn.signature) !== fn.afterSha256) throw new Error("reviewed M11 commerce function header or order drifted");
    const privateFunction = fn.signature.startsWith("private.");
    const stockReader = fn.signature === "public.inventory_new_purchase_stock_read(jsonb,timestamptz)";
    const acl = [
      `REVOKE ALL ON FUNCTION ${fn.signature} FROM PUBLIC,anon,authenticated${privateFunction ? ",service_role" : stockReader ? ",openlup_mcp_reader" : ""};`,
      ...privateFunction ? [] : [`GRANT EXECUTE ON FUNCTION ${fn.signature} TO service_role;`],
    ];
    for (const [offset, expected] of acl.entries()) {
      const statement = statements[routineIndex + offset + 1]!;
      if (forward.statements[routineIndex + offset + 1]!.sql !== statement || statement.replace(/\s+/gu, " ").replace(/, /gu, ",") !== expected) throw new Error("reviewed M11 commerce function ACL drifted");
    }
    routineIndex += 1 + acl.length;
  }
  if (audit) {
    let beforeSql: string | undefined;
    for (const source of preceding) for (const statement of sqlStatements(source.bytes.toString("utf8"), true)) {
      if (/^CREATE TABLE public\.admin_audit_events\s*\(/u.test(statement)) {
        if (beforeSql !== undefined) throw new Error("reviewed M11 commerce audit CHECK preimage is ambiguous");
        beforeSql = /^\s*(CONSTRAINT admin_audit_events_action_check CHECK .+)$/mu.exec(statement)?.[1];
      }
      // No earlier audit-table mutation is part of this fixed preimage class.
      // Refuse instead of trying to interpret arbitrary ALTER/DROP syntax.
      if (source.path !== MANAGED_BASELINE && /^(?:ALTER|DROP)\b/iu.test(statement) && /\badmin_audit_events\b/iu.test(statement)) throw new Error("reviewed M11 commerce audit CHECK preimage changed in the preceding rail");
    }
    const binding = forward.constraints![0]!;
    if (beforeSql !== binding.beforeSql || sqlSha256(beforeSql ?? "") !== binding.beforeSha256) throw new Error("reviewed M11 commerce audit CHECK preimage drifted");
  }
}

// M12 is a separate fixed inventory. Registry pins bind bodies, never enlarge
// paths, headers, companions, ACLs or the retired combined entry point.
const supportAuthorityShapes = [
  {
    path: "db/platform/migrations/20261026120000_account_support_operator_authority.sql",
    functions: [
      {"signature": "public.customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamptz)", "position": 0, "creation": true, "before": null, "header": "5f1a0bc213ef78334f8d12744ca4b462fc9fcd1ae0b1394fed49cf688d7c1c31"},
      {"signature": "public.customer_support_issue_recovery(uuid,uuid,uuid,text,text,text,timestamptz,text)", "position": 2, "creation": false, "before": "7d122383fed301abad32682e46af6f3c99bcbffada388df7eae60b2ee3f412ca", "header": "8a577b349e310980f5498c56ebc706803aedcf2da46102fd95e7ceb6cc985a80"},
      {"signature": "public.customer_support_absorb_lead_v1(uuid,uuid,uuid,text,text,timestamptz)", "position": 4, "creation": false, "before": "d445077001d914a5e6b827ccf71ff4028369e0033e2c1a8e7b16286364355bd2", "header": "e3933000432578de96569f4944b79b73a0d169df5cf9dd6c9a272577bcf5ad5d"},
    ],
    statements: [
      null, // 1
      "5dc5b9caa35ebb254096c05c09dd3413b0d43589afefe0a3898f36ed9b7aece2", // 2
      null, // 3
      "139591109daab786c335f48f75c95ff76cad66a403a1141ec40011352379ab52", // 4
      null, // 5
      "918f2562147f9b445752a5e2caa9b9e37976a0514b62486fe089380fdc395e97", // 6
    ],
    constraints: [
    ],
  },
  {
    path: "supabase/migrations/20261026120100_account_support_current_authority.sql",
    functions: [
      {"signature": "public.customer_support_admit_subject_email_v1(uuid,uuid,text,text,text,timestamptz)", "position": 5, "creation": true, "before": null, "header": "a984fea5557ea92ce31b0b4ba07f059985489b975eeb74621c53c4221abcb21e"},
      {"signature": "public.customer_support_claim_subject_email_v1(text)", "position": 6, "creation": true, "before": null, "header": "f9971aa137bffba06a2efe3f70d848dbecfbc4da10646211689feb9f01e97d99"},
      {"signature": "public.customer_support_guard_identity_email_v1()", "position": 7, "creation": true, "before": null, "header": "32f0409041f185f2409bd253823b3243815e766e355b15b7000f8b7f377774fa"},
      {"signature": "public.customer_support_settle_subject_email_v1(text,uuid,text)", "position": 9, "creation": true, "before": null, "header": "4767b2baf5769cb5a98535d1d9713093cad42a6e8054a749793446a388757391"},
      {"signature": "public.customer_support_correct_subject_email_v1(uuid,uuid,text,text,text,timestamptz)", "position": 10, "creation": false, "before": "bcbdf0a0ed2b8bdd69ab6b37d6955eab8b98570b8bc43b0e647654587647ed57", "header": "db1686760a5f27d5874bbcac0e904318b3d1a201c6ca79964caad9eea9dfcd7f", "retired": "751cf9e8e4f9173698b47397b3db60a5bae3d6e19222d9090f2176ce9af205c6"},
      {"signature": "public.customer_support_link_subject_account_v1(uuid,uuid,text,uuid,text,timestamptz)", "position": 29, "creation": true, "before": null, "header": "248aaf7b1a9131d9ca3c31c49259050cbe27d4f7e46cfbe73af81dde954ea746"},
      {"signature": "public.customer_support_issue_recovery(uuid,uuid,uuid,text,text,text,timestamptz,text)", "position": 34, "creation": false, "before": "766d3c653584772cf4596bd7eb21beedbc758297b8f09f7163fddfa4da69d801", "header": "85888e6f1dcb72ff98d075426a6708f9497a024e5285caf422ecf668092a383f"},
    ],
    statements: [
      "2e263b5d96d79d32a68c23f85798123f86936061e042f62f2a63bb52bd266f90", // 1
      "89b862d55af58fcbbebc309fc74943939d2a58d673f3251683c887c232e587f8", // 2
      "bfb8033c3aa42d501067555ada2ccf9699749987ca25a273d9f15fc92a662acc", // 3
      "d4b86c4dce46a16c3b9ff36062cdf0509aab790c2549ff31b478825581a2f30a", // 4
      "5f2c32c76e753d4cbe29cbd769f75f0a497208b34a25f06d40a29821d64dde6e", // 5
      null, // 6
      null, // 7
      null, // 8
      "4a1e6fc40dc3caa2f7978cd1efd7582c08733a908f9a8bf8f340508e04e11012", // 9
      null, // 10
      null, // 11
      "f099fee07da72ce5be4ca1e8f1a1bff0fb551f293bf671768e971913fd24bb25", // 12
      "e5824315f9f7231582c60cc22e5d0729db03d1d775f33b27e866e71f883761d3", // 13
      "9331c67b1aec91d11c5f46427939cedbe616ec820658c3808ad0425a1183d544", // 14
      "aa2784e694946d80255043891b6488d440b619187c1c5aa4f33f693580cc3f9c", // 15
      "c584446905b78993637baf9492c8d2f222ad4c96c852d3914a745b280554ae7e", // 16
      "2ce086a107810fc40db02714588a8ea795b99759e50d1f6640e1dc721d0257e5", // 17
      "2f1c4e4c03acda4a296df0cf39cb28025e605471240700455fa03e635581c96e", // 18
      "091153e8291f84e0ee852d0dae6af3ae29433ad409f3ff36566d18d5bc01a425", // 19
      "287e98e0423e05b11676b21bdde8356e02e969476b19a842fe98cf42620b2367", // 20
      "e4c44d21eeaa8f0fbaa90d96b6a631828f2e974c6294d6fa7e6687fc2ac27edf", // 21
      "e6b9644ceec52c9587cbcaa393dde034042d0150090bd49e4dc4beae3b695a21", // 22
      "74f27120a7e8367bd653bb8717973d0c4f7a576e3acea6fa512285bd59fc9cb4", // 23
      "0696bfaa24e17fb3ebe0a17dcba0182886920e21a8879fc197e7927e837b328b", // 24
      "013da6cd7c4cfc54bb489e342d67fae6d6289de54c8acac895244e4e9bebfb10", // 25
      "c4c1cbac78ce3585790e679f4bcfb70ad15c2fbd8dc1c9d0f05f25ee9e97f625", // 26
      "6a41306125d4a93047ba64f594f24b9fecadf9c02acde4a4c03978cb523e01e5", // 27
      "45755b1786c7d1b63794daa8193a12c1dcbce15de27c76ca6cb6f6f1fea0bd91", // 28
      "e23b7cfc3e97497234695e030752b99c5940eb87d9c89f7cb59b7387cfd016d0", // 29
      null, // 30
      "0db302624111fd83b62812d87970acb8f6bed3e3707dccd252675fd0b4f098ec", // 31
      "43240838565c1d67dddc5c812e253e88cc0c2e556140bb26ec9c74557bfbba31", // 32
      "feac234e282365c9a08c51924d716287f4fe5c7b9237099ff7b833f54fd75d57", // 33
      "dd4ea44b0dc61f211af97a85e1404e8990e9430fa862335508e0d52c191d00a1", // 34
      null, // 35
      "6860509f5f7a23b394161299b5766b6cac8f844b853ec70649805a7bd9c5bba2", // 36
      "5a9b660c411c1f621e4339c99ef87dd89b595e1ca2cc954950f1a29eefba4ac3", // 37
    ],
    constraints: [
      {"table": "public.admin_audit_events", "name": "admin_audit_events_action_check", "beforeSha256": "9c3f2af2de818ea355fc76d3eccef1640eac0f29924f5b731d5768d22d93c41d"},
      {"table": "public.customer_support_subscription_commands", "name": "customer_support_subscription_commands_kind_check", "beforeSha256": "caf59a5bf9928875fb4f1cf28e0dfda39f9f6dc8e493550c65774008d490ea16"},
      {"table": "public.customer_support_subscription_audit_events", "name": "customer_support_subscription_audit_events_kind_check", "beforeSha256": "2a385a7fbb861517ffe8effe4f1ef953bf20210e937a1dcde2a627d6d3c6c312"},
    ],
  },
] as const;

function validateSupportAuthorityForwards(forwards: SupportAuthorityForwardBinding[], paths: Set<string>): void {
  if (!Array.isArray(forwards) || forwards.length !== supportAuthorityShapes.length) throw new Error("reviewed M12 support requires exactly two forwards");
  for (const [index, forward] of forwards.entries()) {
    const shape = supportAuthorityShapes[index]!;
    if (!forward || Object.keys(forward).sort().join(",") !== (index === 0 ? "functions,path,sha256,statements" : "constraints,functions,path,sha256,statements") || forward.path !== shape.path || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== shape.functions.length) throw new Error("reviewed M12 support path, order or function inventory drifted");
    paths.add(forward.path);
    for (const [position, fn] of forward.functions.entries()) {
      const expected = shape.functions[position]!;
      if (!fn || Object.keys(fn).sort().join(",") !== "afterSha256,beforeSha256,signature" || fn.signature !== expected.signature || !hash(fn.afterSha256) || fn.beforeSha256 !== expected.before) throw new Error("reviewed M12 support signature, creation class or preimage binding drifted");
    }
    if (!Array.isArray(forward.statements) || forward.statements.length !== shape.statements.length) throw new Error("reviewed M12 support statement inventory drifted");
    for (const [position, pin] of forward.statements.entries()) {
      const fixed = shape.statements[position];
      if (!pin || Object.keys(pin).sort().join(",") !== (fixed === null ? "sha256" : "sha256,sql") || !hash(pin.sha256) || (fixed !== null && (pin.sha256 !== fixed || typeof pin.sql !== "string" || sqlSha256(pin.sql) !== fixed))) throw new Error("reviewed M12 support companion statement drifted");
    }
    if (index === 1) {
      if (!Array.isArray(forward.constraints) || forward.constraints.length !== shape.constraints.length) throw new Error("reviewed M12 support requires three CHECK preimages");
      for (const [position, binding] of forward.constraints.entries()) {
        const fixed = shape.constraints[position]!;
        if (!binding || Object.keys(binding).sort().join(",") !== "beforeSha256,beforeSql,name,table" || binding.table !== fixed.table || binding.name !== fixed.name || binding.beforeSha256 !== fixed.beforeSha256 || typeof binding.beforeSql !== "string" || sqlSha256(binding.beforeSql) !== fixed.beforeSha256) throw new Error("reviewed M12 support CHECK preimage binding drifted");
      }
    }
  }
}

/** Bounded lexical admission only; PostgreSQL owns semantic/catalog proof.
 * Read each complete rail in filename order. An absent class remains valid in
 * historical registries; new introductions require every earlier same-rail pin.
 */
export function assertSupportAuthorityForward(registry: ReviewedForwardRegistry, path: string, bytes: Buffer, preceding: { path: string; bytes: Buffer }[]): void {
  if (!registry.supportAuthorityForwards) throw new Error("reviewed M12 support has no registry approval");
  validateSupportAuthorityForwards(registry.supportAuthorityForwards, new Set());
  const index = registry.supportAuthorityForwards.findIndex(pin => pin.path === path);
  const forward = registry.supportAuthorityForwards[index], shape = supportAuthorityShapes[index];
  if (!forward || !shape || sqlSha256(bytes) !== forward.sha256) throw new Error("reviewed M12 support path or bytes drifted");
  if (bytes.some(byte => (byte < 0x20 && byte !== 9 && byte !== 10) || byte === 0x7f)) throw new Error("reviewed M12 support refuses control characters");
  const portable = index === 0;
  const baseline = portable ? PLATFORM_BASELINE_FILE : MANAGED_BASELINE;
  const directory = portable ? "db/platform/migrations/" : "supabase/migrations/";
  if (preceding[0]?.path !== baseline || (!portable && sqlSha256(preceding[0].bytes) !== registry.baselineSha256) || preceding.some((source, position) => !source.path.startsWith(directory) || !/^\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(source.path.slice(directory.length)) || source.path >= path || (position > 0 && source.path <= preceding[position - 1]!.path))) throw new Error("reviewed M12 support requires the ordered complete same-rail prefix and baseline");
  // Validate prerequisite class shapes without changing their historical readers.
  if (!registry.batchedForwards || (!portable && !registry.managedCommerceForwards)) throw new Error("reviewed M12 support requires M10 and managed M11 controls");
  validateBatchedForwards(registry.batchedForwards, new Set(), false);
  if (!portable) validateManagedCommerceForwards(registry.managedCommerceForwards!, new Set());
  for (const pin of [...registry.batchedForwards, ...registry.managedCommerceForwards ?? [], ...registry.supportAuthorityForwards].filter(pin => pin.path.startsWith(directory) && pin.path < path)) {
    const source = preceding.find(source => source.path === pin.path);
    if (!source || sqlSha256(source.bytes) !== pin.sha256) throw new Error("reviewed M12 support requires every earlier same-rail pin landed first");
  }
  const statements = sqlStatements(bytes.toString("utf8"));
  if (statements.length !== shape.statements.length) throw new Error("reviewed M12 support missing or extra statements");
  const definitions = batchedFunctionDefinitions(bytes);
  if (definitions.size !== forward.functions.length) throw new Error("reviewed M12 support definition inventory drifted");
  for (const [position, statement] of statements.entries()) {
    const pin = forward.statements[position]!;
    if (sqlSha256(statement) !== pin.sha256 || (pin.sql !== undefined && pin.sql !== statement)) throw new Error("reviewed M12 support ordered statement pin drifted");
  }
  for (const [position, fn] of forward.functions.entries()) {
    const fixed = shape.functions[position]!;
    const statement = statements[fixed.position]!;
    if (sqlSha256(headerAttributes(statement).replace(/\s+/gu, " ").trim()) !== fixed.header || statement.startsWith("CREATE OR REPLACE FUNCTION ") !== !fixed.creation || definitions.get(fn.signature) !== fn.afterSha256 || batchedFunctionDefinitions(Buffer.from(statement)).get(fn.signature) !== fn.afterSha256) throw new Error("reviewed M12 support function header, definition or order drifted");
    if ("retired" in fixed && fn.afterSha256 !== fixed.retired) throw new Error("reviewed M12 support combined email entry must stay retired");
  }
  const names = new Set(forward.functions.map(fn => fn.signature.split("(")[0]!));
  const prior = new Map<string, string>();
  const checks = new Map<string, string>();
  for (const source of preceding) for (const statement of sqlStatements(source.bytes.toString("utf8"), true)) {
    if (source.path !== baseline && [...names].some(name => statement.includes(name.split(".")[1]!)) && /^(?:CREATE|ALTER|DROP)\b/iu.test(statement) && /\bFUNCTION\b/iu.test(statement) && !/^CREATE(?: CONSTRAINT)? TRIGGER /iu.test(statement) && !/^CREATE(?: OR REPLACE)? FUNCTION (?:public|private)\.[a-z_][a-z0-9_]*\s*\(/iu.test(statement)) throw new Error("reviewed M12 support refuses unsupported preceding function DDL");
    for (const [signature, digest] of batchedFunctionDefinitions(Buffer.from(statement), names)) prior.set(signature, digest);
    if (!portable) for (const binding of forward.constraints!) {
      if (statement === binding.beforeSql) checks.set(binding.name, statement);
      // The baseline is immutable. Outside it, only M11's exact audit pair
      // may mutate these tables before M12. Comments/quoted syntax refuse too.
      if (source.path !== baseline && /^(?:ALTER|DROP)\b/iu.test(statement) && statement.includes(binding.table.split(".")[1]!)) {
        const m11 = registry.managedCommerceForwards![2]!;
        if (source.path !== m11.path || !m11.statements.slice(1, 3).some(pin => pin.sql === statement)) throw new Error("reviewed M12 support CHECK preimage changed in the preceding rail");
      }
    }
  }
  for (const fn of forward.functions) if ((prior.get(fn.signature) ?? null) !== fn.beforeSha256) throw new Error("reviewed M12 support actual function preimage drifted");
  for (const binding of forward.constraints ?? []) if (checks.get(binding.name) !== binding.beforeSql) throw new Error("reviewed M12 support actual CHECK preimage drifted");
}
