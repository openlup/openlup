import { PLATFORM_BASELINE_FILE, QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE, QUALIFIED_IMPORT_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE, QUALIFIED_OWNER_PATH_FILE, QUALIFIED_LOCK_AND_CONFLICT_COMPLETION_FILE, ADMIN_BASELINE_FILE, ADMIN_ACTOR_FILE, ADMIN_ACQUISITION_FILE, ADMIN_RUNTIME_FILE, ADMIN_IMPORT_FILE, REVISED_ADMIN_ACTOR_FILE, REVISED_ADMIN_ACQUISITION_FILE, REVISED_ADMIN_RUNTIME_FILE, REVISED_ADMIN_IMPORT_FILE } from "../platform-migration-manifest.ts";
import { cataloguePublicationAuthorityPath, hash, MANAGED_BASELINE, sqlSha256, type BatchedForwardBinding, type ForwardBinding, type ManagedCommerceForwardBinding, type ReviewedForwardRegistry, type SupportAuthorityForwardBinding } from "./types.ts";
import { cachedCreateFunctionIndex, cachedDumpSqlStatements, headerAttributes, isExpandOnlyPlatformForward, qualifiedFunctionIdentity, sqlStatements } from "./sql-tokenizer.ts";

export const replacements = new Set([
  "public.commerce_offer_policy_v2_readiness()",
  "public.subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb)",
  "public.subscription_apply_starter_graduation(uuid,text,text)",
]);
export const creations = new Set([
  "public.catalog_price_setup_preview(uuid,uuid,integer)",
  "public.catalog_price_setup_apply(text,text)",
]);
export const portableReplacements = new Set([
  "public.dunning_lifecycle_handle_failure(uuid,timestamptz,text,text,integer,timestamptz,text,text)",
]);
export const accountWithdrawalSignature = "public.customer_communication_preferences_set_as_actor(boolean,timestamptz)";
export const paymentTerminalSignature = "public.payment_truth_apply_terminal(uuid,text,text,timestamptz,text,text,jsonb,text,text,text)";
export const managedInvoicing = [
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
export const portableCreationPaths = [
  "db/platform/migrations/20261022080000_fulfillment_command_ledger.sql",
  "db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql",
  "db/platform/migrations/20261022190000_invoicing_durable_duties.sql",
  "db/platform/migrations/20261022191000_invoicing_document_effects.sql",
  "db/platform/migrations/20261022195000_invoicing_seller_revision.sql",
];
export const qualifiedInstallationPaths = [
  QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE, QUALIFIED_IMPORT_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE, QUALIFIED_OWNER_PATH_FILE,
  ADMIN_BASELINE_FILE, ADMIN_ACTOR_FILE, ADMIN_ACQUISITION_FILE, ADMIN_RUNTIME_FILE, ADMIN_IMPORT_FILE,
  REVISED_ADMIN_ACTOR_FILE, REVISED_ADMIN_ACQUISITION_FILE, REVISED_ADMIN_RUNTIME_FILE, REVISED_ADMIN_IMPORT_FILE,
  QUALIFIED_LOCK_AND_CONFLICT_COMPLETION_FILE,
  cataloguePublicationAuthorityPath,
];
export const qualifiedOwnerPathSignatures = [
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
export const runtimeReplacements = new Set([
  "public.admin_clients_search_v3(text,integer,integer,text)",
  "public.subscription_list_due_for_renewal(integer,timestamp with time zone)",
  "public.customer_support_absorb_lead_v1(uuid,uuid,uuid,text,text,timestamp with time zone)",
  "public.marketing_rehome_client_lead_v1(uuid,timestamp with time zone)",
  "public.customer_support_correct_subject_email_v1(uuid,uuid,text,text,text,timestamp with time zone)",
]);
// Only the legacy browser policies activated by membership reads may be retired.
export const runtimeRetiredPolicies = new Map([
  ["address_canon_localities", "admin_all_address_canon_localities"],
  ["address_canon_postal_localities", "admin_all_address_canon_postal_localities"],
  ["address_canon_streets", "admin_all_address_canon_streets"],
  ["addresses", "admin_all_addresses"],
  ["clients", "admin_all_clients"],
  ["customer_account_events", "admin_all_customer_account_events"],
  ["customer_orderer_profiles", "admin_all_customer_orderer_profiles"],
  ["pets", "admin_all_pets"],
]);
export const runtimeExecutions = new Set([
  "public.record_admin_audit_event(uuid,text,text,text,text,jsonb,jsonb,text,text,uuid,text)",
  "public.subscription_current_template_snapshot(uuid)",
  "public.commerce_oms_normalize_search_text(text)",
  "public.commerce_oms_normalize_search_digits(text)",
]);
// These column sets are fixed by the reviewed runtime consumers, never supplied by the registry.
export const runtimeColumns: Record<string, ReadonlySet<string>> = {
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
export const runtimeUpdateColumns: Record<string, ReadonlySet<string>> = {
  subscriptions: new Set(["updated_at"]),
  clients: new Set(["email", "identity_kind", "marketing_contact_id", "metadata", "updated_at"]),
  client_consents: new Set(["client_id"]),
  client_source_links: new Set(["client_id"]),
  customer_personalization: new Set(["client_id"]),
};
export const runtimeBrowserColumns: Record<string, ReadonlySet<string>> = {
  clients: new Set(["id", "auth_user_id", "email", "first_name", "last_name", "phone", "lifecycle_stage"]),
  admin_users: new Set(["id", "role", "membership_state", "email", "is_machine_actor", "created_at"]),
};
export const runtimeBrowserExecutions = new Set([
  "public.commerce_oms_normalize_search_text(text)",
  "public.commerce_oms_normalize_search_digits(text)",
]);
export function runtimePrivilegeKeys(statement: string): string[] {
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
export const identityColumns: Record<string, Record<string, ReadonlySet<string>>> = {
  clients: { INSERT: new Set(["email", "auth_user_id", "acquisition_source", "lifecycle_stage"]), UPDATE: new Set(["auth_user_id"]) },
  admin_users: { INSERT: new Set(["id", "email", "role", "membership_state", "membership_provenance", "membership_accepted_at"]), SELECT: new Set(["email"]) },
};
export function identityPrivilegeKeys(statement: string): string[] {
  const grant = /^GRANT (INSERT|UPDATE|SELECT) \(([a-z_, ]+)\) ON public\.(clients|admin_users) TO service_role;$/u.exec(statement);
  if (grant) {
    const columns = grant[2]!.split(",").map((column) => column.trim());
    const allowed = identityColumns[grant[3]!]?.[grant[1]!];
    if (allowed && columns.length > 0 && new Set(columns).size === columns.length && columns.every((column) => allowed.has(column))) return columns.map((column) => `service_role ${grant[1]} ${grant[3]}.${column}`);
  }
  throw new Error("reviewed replacement identity privilege is outside the fixed capability allowlist");
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
export function functionSignature(name: string, argumentsText: string): string {
  const types = argumentsText.trim() === "" ? [] : argumentsText.split(",").map((argument) => {
    const match = /^(?:[a-z_][a-z0-9_]* )?(uuid|text|jsonb|integer|boolean|timestamp with time zone|timestamptz)(?: DEFAULT [\s\S]+)?$/iu.exec(argument.trim());
    if (!match) throw new Error("reviewed replacement has an unsupported argument identity");
    return match[1]!.toLowerCase();
  });
  const signature = `${name.toLowerCase()}(${types.join(",")})`;
  if (types.includes("boolean") && signature !== accountWithdrawalSignature) throw new Error("reviewed replacement has an unsupported boolean identity");
  if (types.includes("timestamp with time zone") && !runtimeReplacements.has(signature)) throw new Error("reviewed replacement has an unsupported timestamp identity");
  if (types.includes("timestamptz") && !portableReplacements.has(signature) && signature !== paymentTerminalSignature && signature !== accountWithdrawalSignature) throw new Error("reviewed replacement has an unsupported portable timestamp identity");
  return signature;
}

// Mask only the two fixed now() defaults for identity; definition hashes retain raw SQL.
export const identityHeaderSql = (statement: string) => statement.replace(/(public\.subscription_list_due_for_renewal\([^;]*timestamp with time zone DEFAULT )now\(\)/iu, "$1now")
  .replace(/(public\.customer_communication_preferences_set_as_actor\(\s*(?:[a-z_][a-z0-9_]*\s+)?boolean\s*,\s*(?:[a-z_][a-z0-9_]*\s+)?timestamptz DEFAULT )now\(\)/iu, "$1now");

export function reviewedFunctionDefinitions(bytes: Buffer, names?: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  const statements = names !== undefined
    ? [...names].flatMap(name => cachedCreateFunctionIndex(bytes).byName.get(name.toLowerCase()) ?? [])
    : sqlStatements(bytes.toString("utf8"), false);
  for (const statement of statements) {
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
export function assertFunctionStatements(bytes: Buffer, definitions: Map<string, string>): void {
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

/** A pinned creation file may add invoker objects, never redefine earlier objects.
 * Trigger attachments to existing public tables are intentional: both the trigger
 * name and its zero-argument trigger function must be new in this file.
 * This is a bounded statement classifier, not a general SQL/body safety analyser;
 * the separately approved whole-file hash binds every body and expression.
 */
export function assertPortableCreationStatements(bytes: Buffer, preceding: Buffer[]): void {
  const relations = new Set<string>(), functions = new Set<string>(), triggers = new Set<string>(), priorTables = new Set<string>();
  for (const source of preceding) {
    for (const statement of cachedDumpSqlStatements(source)) {
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

/** Pin the actual policy statement, not a registry-supplied predicate. */
export function reviewedPolicyDefinitions(bytes: Buffer): Map<string, string> {
  const policies = new Map<string, string>();
  updatePolicyDefinitions(policies, bytes);
  return policies;
}
export function updatePolicyDefinitions(policies: Map<string, string>, bytes: Buffer): void {
  for (const statement of cachedDumpSqlStatements(bytes)) {
    const create = /^CREATE POLICY ([a-z_]+) ON public\.([a-z_]+) /u.exec(statement);
    if (create) policies.set(`${create[2]}.${create[1]}`, sqlSha256(statement));
    const changed = /^(?:ALTER|DROP) POLICY ([a-z_]+) ON public\.([a-z_]+)(?: |;)/u.exec(statement);
    if (changed) policies.delete(`${changed[2]}.${changed[1]}`);
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

function batchedFunctionDefinitionFromStatement(statement: string, names?: Set<string>): [string, string] | null {
  const prefix = /^CREATE(?: OR REPLACE)? FUNCTION ((?:public|private)\.[a-z_][a-z0-9_]*)\s*\(/iu.exec(statement);
  if (names && (!prefix || !names.has(prefix[1]!.toLowerCase()))) return null;
  const header = /^CREATE(?: OR REPLACE)? FUNCTION ((?:public|private)\.[a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*RETURNS\s/iu.exec(statement);
  if (!header) {
    if (/^CREATE(?: OR REPLACE)? FUNCTION /iu.test(statement)) throw new Error("reviewed batch refuses unsupported function header");
    return null;
  }
  return [batchIdentity(header[1]!, header[2]!), sqlSha256(statement)];
}

/** Separate identity reader; raw CREATE bytes, including defaults, stay hashed. */
export function batchedFunctionDefinitions(bytes: Buffer, names?: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  const index = cachedCreateFunctionIndex(bytes);
  const statements = names !== undefined
    ? [...names].flatMap(name => index.byName.get(name.toLowerCase()) ?? [])
    : index.allCreateFunctions;
  for (const statement of statements) {
    const definition = batchedFunctionDefinitionFromStatement(statement, names);
    if (!definition) continue;
    const [signature, digest] = definition;
    if (result.has(signature)) throw new Error(`reviewed batch duplicate signature: ${signature}`);
    result.set(signature, digest);
  }
  return result;
}

export function validateBatchedForwards(forwards: BatchedForwardBinding[], paths: Set<string>, historical: boolean): void {
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
    const targetName = name.split("(")[0]!.toLowerCase();
    let previous: string | undefined;
    for (const source of preceding) for (const sql of cachedCreateFunctionIndex(source).byName.get(targetName) ?? []) {
      if (batchedFunctionDefinitionFromStatement(sql, names)?.[0] === name) previous = sql;
    }
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
export function validateManagedCommerceForwards(forwards: ManagedCommerceForwardBinding[], paths: Set<string>, historical = false): void {
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
    if (source.path === MANAGED_BASELINE) {
      const idx = cachedCreateFunctionIndex(source.bytes);
      for (const name of names) for (const statement of idx.byName.get(name.toLowerCase()) ?? []) {
        const definition = batchedFunctionDefinitionFromStatement(statement, names);
        if (definition) prior.set(definition[0], definition[1]);
      }
      continue;
    }
    for (const statement of cachedDumpSqlStatements(source.bytes)) {
      // The immutable dump is bound by its hash. Later function DDL must use the
      // existing reader's supported spelling, rather than silently hiding a
      // replacement behind comments, quoted names or keyword whitespace.
      if (/^(?:CREATE|ALTER|DROP)\b/iu.test(statement) && /\bFUNCTION\b/iu.test(statement) && !/^CREATE(?: OR REPLACE)? FUNCTION (?:public|private)\.[a-z_][a-z0-9_]*\s*\(/iu.test(statement)) throw new Error("reviewed M11 commerce refuses unsupported preceding function DDL");
      const definition = batchedFunctionDefinitionFromStatement(statement, names);
      if (definition) prior.set(definition[0], definition[1]);
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
    for (const source of preceding) for (const statement of cachedDumpSqlStatements(source.bytes)) {
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

export function validateSupportAuthorityForwards(forwards: SupportAuthorityForwardBinding[], paths: Set<string>): void {
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
  for (const source of preceding) {
    if (source.path === baseline) {
      const idx = cachedCreateFunctionIndex(source.bytes);
      for (const name of names) for (const statement of idx.byName.get(name.toLowerCase()) ?? []) {
        const definition = batchedFunctionDefinitionFromStatement(statement, names);
        if (definition) prior.set(definition[0], definition[1]);
      }
      if (!portable) for (const binding of forward.constraints!) {
        if (idx.exactStatements.has(binding.beforeSql)) checks.set(binding.name, binding.beforeSql);
      }
      continue;
    }
    for (const statement of cachedDumpSqlStatements(source.bytes)) {
      if ([...names].some(name => statement.includes(name.split(".")[1]!)) && /^(?:CREATE|ALTER|DROP)\b/iu.test(statement) && /\bFUNCTION\b/iu.test(statement) && !/^CREATE(?: CONSTRAINT)? TRIGGER /iu.test(statement) && !/^CREATE(?: OR REPLACE)? FUNCTION (?:public|private)\.[a-z_][a-z0-9_]*\s*\(/iu.test(statement)) throw new Error("reviewed M12 support refuses unsupported preceding function DDL");
      const definition = batchedFunctionDefinitionFromStatement(statement, names);
      if (definition) prior.set(definition[0], definition[1]);
      if (!portable) for (const binding of forward.constraints!) {
        if (statement === binding.beforeSql) checks.set(binding.name, statement);
        // The baseline is immutable. Outside it, only M11's exact audit pair
        // may mutate these tables before M12. Comments/quoted syntax refuse too.
        if (/^(?:ALTER|DROP)\b/iu.test(statement) && statement.includes(binding.table.split(".")[1]!)) {
          const m11 = registry.managedCommerceForwards![2]!;
          if (source.path !== m11.path || !m11.statements.slice(1, 3).some(pin => pin.sql === statement)) throw new Error("reviewed M12 support CHECK preimage changed in the preceding rail");
        }
      }
    }
  }
  for (const fn of forward.functions) if ((prior.get(fn.signature) ?? null) !== fn.beforeSha256) throw new Error("reviewed M12 support actual function preimage drifted");
  for (const binding of forward.constraints ?? []) if (checks.get(binding.name) !== binding.beforeSql) throw new Error("reviewed M12 support actual CHECK preimage drifted");
}

// M17 fixes only these four paths; registry body pins cannot enlarge the class.
export const channelIngestShapes = [
  {
    path: "db/platform/migrations/20261030121000_channel_retained_basis.sql",
    functions: [
      {"signature": "public.channel_control_keys(jsonb,jsonb)", "position": 10, "creation": true, "before": null, "header": "bc9fa6b5dccca7431c8f7ef779b42cfcb4ddec4207acb5ddc948654bc2a82c56"},
      {"signature": "public.channel_control_ref(text)", "position": 11, "creation": true, "before": null, "header": "00660e72a0600bc9d924ed8075f77c5774f7baef5537d67fdea48a74dd58492c"},
      {"signature": "public.catalog_bundle_composition_digest(uuid)", "position": 12, "creation": true, "before": null, "header": "68193c75ce1af9e12589a758a7df1baeaadea046865845adcd5681726ced181f"},
      {"signature": "public.channel_control_actor(uuid,boolean)", "position": 13, "creation": true, "before": null, "header": "eaa4ea06eb55d59ac35b698a9a4e882ea17eab6baffc4fa98efe9abd3ea51f9f"},
      {"signature": "public.channel_control_scope(uuid)", "position": 14, "creation": true, "before": null, "header": "120479df7cf6f1a3fc96e7cd4aeb1e457eb74de1d2b244dc10acc7a60da1cd92"},
      {"signature": "public.channel_listing_read(uuid,uuid)", "position": 15, "creation": true, "before": null, "header": "3e765cf5de9b028df032ddc76c96e44f4951b97c368b615b602cf3e3d2be3845"},
      {"signature": "public.channel_retained_bundle_guard()", "position": 16, "creation": true, "before": null, "header": "dc5dfd1134e133cf2dd9f0fe0ce337c1eb1b8704ca8e09c5708b3eccbc2b261e"},
      {"signature": "public.channel_retained_fact_guard()", "position": 25, "creation": true, "before": null, "header": "8ecc2da4619ee5a16d0dbe57879960c585bead5a0dcf1773749b4fd028553c4d"},
      {"signature": "public.channel_retained_listing_guard()", "position": 32, "creation": true, "before": null, "header": "1454d7ae8975b651168e0077f71b532e6b30c6fcc363bac7c393a08e4169b890"},
    ],
    statements: [
      "23c5051398cb5318e65fa5b53e830900fa5630f09d8ecd7f5ed730a6c7ec642f",
      "979cc1b26fbbcd5f92580afc4146893a7a488276e10cf20a60d1f2910439451d",
      "1257d8ab5177165673e4278b4fe5cf4430e4613358c8802920a2bfc2ee17bd92",
      "c7f932ee2ffde3cdb32ff4c7d0668fac313aae4c7658148794452c2183b641ea",
      "c30fc4072408a9efac838d007cd45958564f74ef3f89512473755f99d7d7e21a",
      "d02e91e6aaa2250402301b6b5ee9f687badc447c0ccfaf4bf9d202a173a14d0b",
      "d0ff9aa50c6c5fbe05cf3510b0e1aead52a717533b8baa5890435ce94bcf123e",
      "4f43b195bd0b080d612b792d2556f3fcc8ad108ca803d38fb3bb51e0a64ff5c7",
      "d5c0039a23ac65b630449165c41686329f10767dd857c4eb8fdef63eb07250ee",
      "f36f5a79ec11e790a92395808bbc549cc98373c63bbe57ac56b70dc08de3f7ee",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "338eca6c610f317c0a2999552482da7c59ecc5fba65bc13d6ebba4015006cbeb",
      "7f10692a1750ee5db52c55e71a60e8cd0d58bf00a96cf4e0e762242cddad706e",
      "861dcc689d2eed6db8d54fab67ed626d3088cbbd62275f2bacfa0347abec0eb5",
      "3ffad443dbce8f4f5c1c0a3f3ee87ae79771045f83568b8849832a0ca5bb6516",
      "38dbcae7bb984f2c5e2e9f1872cb233d5b498462b49ddebf436a171907a61067",
      "e88b9c04f0c9ccd20439fa9befbc44e74fd940d7e8185b9cf376519265fc2e55",
      "762fa8ffea395ebb1420747db267312f8d75ced5f00e3aca5c7d2217089c5800",
      "c6bd85d6c2e7c7f734939104d2280650bc7afcffe190cc45d49037bd49112d32",
      null,
      "540d65889a497db91b08d00a90fd18529f89edd01bb91fe811e200b696c8c5e8",
      "d31297c82514b6eff91c7499a10aa05ecab9d2faef2e3b11070fc9b2c67c3c91",
      "4ecaee830a3263472f480fc6ecac7db4d0c3f062fdc34113f351f49baf46c811",
      "119427b95756cccd51423c758616d9763229c77413005bb35bd490dc83751c1a",
      "b01ef47f10b7e7fe52a315dc3dfb0f61ab2682c7711fa0a5104c5c28300a0087",
      "f18312f82a96e562ac7b17e34b9348b517c2a8c36716ed1a6d0936ac233d803c",
      null,
      "f46a2dfe797055ebd7368ebd69ff1028fd71685dcb1a9bacaa41e87a937f0cc5",
      "36dfcb6155889be4e337299049004b80db06360629e160da290aa66961e1a900",
      "d807fd660a14c02393111ab952d87d37d98ff087d81d2e970f245c39c1ef2563",
      "87531c19105520418015d9c5fbd070558fe492057a0d256b7ac85c26452c9f4c",
    ],
  },
  {
    path: "db/platform/migrations/20261030122000_channel_purchased_source.sql",
    functions: [
      {"signature": "public.channel_purchase_json(jsonb)", "position": 3, "creation": true, "before": null, "header": "64c206aea6c62e032b85c5e74c745875ce9f8a0ef6ce6deb10a49bf46cc4c8cf"},
      {"signature": "public.channel_purchase_packet(text,text,text)", "position": 4, "creation": true, "before": null, "header": "275fcfac77db7c4087eb6db5058885bc9b834f52666221ba1ad510e46980ac53"},
      {"signature": "public.channel_purchase_scope(jsonb,uuid,uuid,boolean,uuid)", "position": 5, "creation": true, "before": null, "header": "4a5cadb86ad2b231fce4d1734a4bc81c5f19929cd4c432301926a9f67a8061af"},
      {"signature": "public.channel_purchase_guard()", "position": 6, "creation": true, "before": null, "header": "f4aab5e896442940d6cad182e59b6d6c80fb09f6095530fa3e6f7ae282cc9afd"},
      {"signature": "public.channel_pull_page_record(uuid,uuid,uuid,uuid,text,text)", "position": 13, "creation": true, "before": null, "header": "77945535af98699f96a41e4aee2dbf74561aa5c8e0bd444be6a7f3714fd6a34b"},
      {"signature": "public.channel_pull_page_read(uuid,uuid,uuid,text)", "position": 14, "creation": true, "before": null, "header": "02d3b9260f17a51c6c2f7e6f585410c5007ae7e78d84b490fb33c7ec57d7c622"},
      {"signature": "public.channel_pull_progress_commit(uuid,uuid,uuid,uuid,text,timestamptz,bigint,text,timestamptz)", "position": 15, "creation": true, "before": null, "header": "434d676878ed5e38c359d3fa503b7936ae0466163a2c80dc39291faed48cdc8a"},
      {"signature": "public.channel_ingest_record_inbound_event(uuid,text,text,text,jsonb,text,text)", "position": 16, "creation": true, "before": null, "header": "d44edb0ebc8bfc5901a7a0bd86fcdd16dab21dfcfc3d2e0285f70506bc30b82b"},
      {"signature": "public.channel_ingest_capture_read(uuid,text,uuid)", "position": 17, "creation": true, "before": null, "header": "3fee9eb17c66e851324806205552606a2eb2e05d669bf22242247cf0e92441f5"},
      {"signature": "public.channel_purchase_conversion_command(uuid,text,uuid,uuid,text)", "position": 18, "creation": true, "before": null, "header": "eec0f45da30bc07744a48bf1e40d415b49c8dbf94c600f6556b0ff1e5b739252"},
    ],
    statements: [
      "98142a842e2940d9662fc8aa0ee38f8034d7f9e3c2280a4360b3e82e4dd550e6",
      "7f93aae572e6ca13fa436659f9edebbb8178183254596a35b2c27358df545916",
      "620ee098dcdcea06ef44c64ffe11b62521996daca89d1b5bad689debab3eefc8",
      null,
      null,
      null,
      null,
      "002597309e10272df8532546fea6a782a9c4239505b23793f7cd09a145b34353",
      "6e05be99701bc622b1f185d724b56f13dcc64a6b8f1b5efa2db247bf5f7ba9d1",
      "aaedb2e9737c9e2379e88b6a7f9f37109ccd2ecaa327bc11f8fa4f6285ef34af",
      "4cd79d2e3c07968adc637247985a46ea00aad20b2ec666b067d42840b9112f97",
      "ce6a0e5f229adebbd133340173c5255c29682e33b5cb6a413626175097db22cd",
      "f9660bd7b945d1bde432db41ecf4ec6731af71cbfc2cdc95ea9e34a54beaf008",
      null,
      null,
      null,
      null,
      null,
      null,
      "bed7b683fd8a8c0c91338d8b3a02ee5aae895862205b92b1569f2f1e40aa4d5a",
      "02c7948396e76331543a2b09565036e250d95415df7f6bcbab652709790f09ea",
      "9e7f6e84332d12906d923a9f8ffccd7e69d9794842fb6ee7899bbaf4f1648682",
      "6dca795beeec1080d8a1d8a99b094e10606d129ad6be034a44e6fffccb6ea2c5",
      "855bb751df7644ca4f08757c7fd9230380d1af4147855a3bedc3dcec2a02e837",
    ],
  },
  {
    path: "supabase/migrations/20261030121000_channel_retained_basis.sql",
    functions: [
      {"signature": "public.channel_control_keys(jsonb,jsonb)", "position": 10, "creation": true, "before": null, "header": "bc9fa6b5dccca7431c8f7ef779b42cfcb4ddec4207acb5ddc948654bc2a82c56"},
      {"signature": "public.channel_control_ref(text)", "position": 11, "creation": true, "before": null, "header": "00660e72a0600bc9d924ed8075f77c5774f7baef5537d67fdea48a74dd58492c"},
      {"signature": "public.catalog_bundle_composition_digest(uuid)", "position": 12, "creation": true, "before": null, "header": "68193c75ce1af9e12589a758a7df1baeaadea046865845adcd5681726ced181f"},
      {"signature": "public.channel_control_actor(uuid,boolean)", "position": 13, "creation": true, "before": null, "header": "2e79bb32d6360e89af58d2f67a24dce0c238cff578e294ff395f472fbb7430d8"},
      {"signature": "public.channel_control_scope(uuid)", "position": 14, "creation": true, "before": null, "header": "120479df7cf6f1a3fc96e7cd4aeb1e457eb74de1d2b244dc10acc7a60da1cd92"},
      {"signature": "public.channel_listing_read(uuid,uuid)", "position": 15, "creation": true, "before": null, "header": "3e765cf5de9b028df032ddc76c96e44f4951b97c368b615b602cf3e3d2be3845"},
      {"signature": "public.channel_retained_bundle_guard()", "position": 16, "creation": true, "before": null, "header": "dc5dfd1134e133cf2dd9f0fe0ce337c1eb1b8704ca8e09c5708b3eccbc2b261e"},
      {"signature": "public.channel_retained_fact_guard()", "position": 29, "creation": true, "before": null, "header": "8ecc2da4619ee5a16d0dbe57879960c585bead5a0dcf1773749b4fd028553c4d"},
      {"signature": "public.channel_retained_listing_guard()", "position": 35, "creation": true, "before": null, "header": "1454d7ae8975b651168e0077f71b532e6b30c6fcc363bac7c393a08e4169b890"},
    ],
    statements: [
      "23c5051398cb5318e65fa5b53e830900fa5630f09d8ecd7f5ed730a6c7ec642f",
      "979cc1b26fbbcd5f92580afc4146893a7a488276e10cf20a60d1f2910439451d",
      "1257d8ab5177165673e4278b4fe5cf4430e4613358c8802920a2bfc2ee17bd92",
      "c7f932ee2ffde3cdb32ff4c7d0668fac313aae4c7658148794452c2183b641ea",
      "c30fc4072408a9efac838d007cd45958564f74ef3f89512473755f99d7d7e21a",
      "d02e91e6aaa2250402301b6b5ee9f687badc447c0ccfaf4bf9d202a173a14d0b",
      "d0ff9aa50c6c5fbe05cf3510b0e1aead52a717533b8baa5890435ce94bcf123e",
      "4f43b195bd0b080d612b792d2556f3fcc8ad108ca803d38fb3bb51e0a64ff5c7",
      "d5c0039a23ac65b630449165c41686329f10767dd857c4eb8fdef63eb07250ee",
      "f36f5a79ec11e790a92395808bbc549cc98373c63bbe57ac56b70dc08de3f7ee",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "338eca6c610f317c0a2999552482da7c59ecc5fba65bc13d6ebba4015006cbeb",
      "7f10692a1750ee5db52c55e71a60e8cd0d58bf00a96cf4e0e762242cddad706e",
      "861dcc689d2eed6db8d54fab67ed626d3088cbbd62275f2bacfa0347abec0eb5",
      "3ffad443dbce8f4f5c1c0a3f3ee87ae79771045f83568b8849832a0ca5bb6516",
      "ae4694e41367e2842cda27f7aa1a0943feedf68da675738783ed9d8cb261f742",
      "a089933a8bfa754cac8f6d09ac4762973537b3c6bc476a9d322b1cb8f26493f1",
      "5bed4086eede97750b22dd30f80598daeccef2e3ee6d3555544a93e1f66db06d",
      "9f61b125301dae7f84b68d5997a7f22378309c0cb85ed40f9b8b1e2fbf1e986b",
      "87a7b1ab5f5bf75b53f63e997170b78de875b1b565dd0d1251bbd83b502a9e1b",
      "0d838c6277573657d2a5d3f0c87d5120572155d9a7478b2eaffbd8b31df5aa1f",
      "446ec339ef9f84aad5fff7ac629ebb781628bbd01188895974b6fed120522a43",
      "bf9f4f092dbc3b77c0c02993bf7e680f972d5ef03e473ca738bf82052a226680",
      null,
      "540d65889a497db91b08d00a90fd18529f89edd01bb91fe811e200b696c8c5e8",
      "d31297c82514b6eff91c7499a10aa05ecab9d2faef2e3b11070fc9b2c67c3c91",
      "4ecaee830a3263472f480fc6ecac7db4d0c3f062fdc34113f351f49baf46c811",
      "119427b95756cccd51423c758616d9763229c77413005bb35bd490dc83751c1a",
      "6132d013dba916ab961651fbcd57e4af18c12925ccae5e967f4b5e59822df302",
      null,
      "f46a2dfe797055ebd7368ebd69ff1028fd71685dcb1a9bacaa41e87a937f0cc5",
      "36dfcb6155889be4e337299049004b80db06360629e160da290aa66961e1a900",
      "163c10f8c94f6ac8e2501844b7f76eb9b5816c2efc51fb62920b01e7ef76b4a0",
    ],
  },
  {
    path: "supabase/migrations/20261030122000_channel_purchased_source.sql",
    functions: [
      {"signature": "public.channel_purchase_json(jsonb)", "position": 6, "creation": true, "before": null, "header": "64c206aea6c62e032b85c5e74c745875ce9f8a0ef6ce6deb10a49bf46cc4c8cf"},
      {"signature": "public.channel_purchase_packet(text,text,text)", "position": 7, "creation": true, "before": null, "header": "275fcfac77db7c4087eb6db5058885bc9b834f52666221ba1ad510e46980ac53"},
      {"signature": "public.channel_purchase_scope(jsonb,uuid,uuid,boolean,uuid)", "position": 8, "creation": true, "before": null, "header": "4a5cadb86ad2b231fce4d1734a4bc81c5f19929cd4c432301926a9f67a8061af"},
      {"signature": "public.channel_purchase_guard()", "position": 9, "creation": true, "before": null, "header": "f4aab5e896442940d6cad182e59b6d6c80fb09f6095530fa3e6f7ae282cc9afd"},
      {"signature": "public.channel_pull_page_record(uuid,uuid,uuid,uuid,text,text)", "position": 16, "creation": true, "before": null, "header": "77945535af98699f96a41e4aee2dbf74561aa5c8e0bd444be6a7f3714fd6a34b"},
      {"signature": "public.channel_pull_page_read(uuid,uuid,uuid,text)", "position": 17, "creation": true, "before": null, "header": "02d3b9260f17a51c6c2f7e6f585410c5007ae7e78d84b490fb33c7ec57d7c622"},
      {"signature": "public.channel_pull_progress_commit(uuid,uuid,uuid,uuid,text,timestamptz,bigint,text,timestamptz)", "position": 18, "creation": true, "before": null, "header": "434d676878ed5e38c359d3fa503b7936ae0466163a2c80dc39291faed48cdc8a"},
      {"signature": "public.channel_ingest_record_inbound_event(uuid,text,text,text,jsonb,text,text)", "position": 19, "creation": true, "before": null, "header": "d44edb0ebc8bfc5901a7a0bd86fcdd16dab21dfcfc3d2e0285f70506bc30b82b"},
      {"signature": "public.channel_ingest_capture_read(uuid,text,uuid)", "position": 20, "creation": true, "before": null, "header": "3fee9eb17c66e851324806205552606a2eb2e05d669bf22242247cf0e92441f5"},
      {"signature": "public.channel_purchase_retained_lines(uuid,jsonb)", "position": 21, "creation": true, "before": null, "header": "fef645c97e5834a3c73e4555d7b62e42f0ee430470964524dd72c606807e7c1d"},
      {"signature": "public.commerce_create_channel_order(text,uuid,jsonb)", "position": 22, "creation": false, "before": "0b31361c2a8ff731a128d5632a4f182edacc21853dae145e0432c96071840546", "header": "22a7b51164a0a1ebfb5767e8f758179274a23ac1a147035336282ca45b9ba95f"},
      {"signature": "public.inventory_channel_exposure_quantity(uuid)", "position": 23, "creation": false, "before": "1aeb7d89182ad987f049eec6eb752c8d7ec32d5b238e584c4d3771ffd5cd1867", "header": "ff2a6dae811c50922234e3186dafa6868e77a38ccef071f294d1571710814f6f"},
      {"signature": "public.channel_purchase_stock_enter(uuid,jsonb,text)", "position": 26, "creation": true, "before": null, "header": "cc3bb924ef2229715531db036c94933d5cbbe94ba9952b24ac97d835d0799886"},
      {"signature": "public.channel_reserve_order_items(text,uuid,jsonb,jsonb,text)", "position": 28, "creation": true, "before": null, "header": "c99b68564f8d31e128dac426ba4ed51dc39eabd699dda537f085bace1be59779"},
      {"signature": "public.channel_purchase_paid_source(uuid,jsonb)", "position": 31, "creation": true, "before": null, "header": "4d4aa04e5a707e4fc859fa558d6cc205a7e1ad80b78dc14a8b8bd26695b8c900"},
      {"signature": "public.channel_exposure_apply(uuid,text,uuid,uuid,bigint,text,text)", "position": 33, "creation": true, "before": null, "header": "3b741df173105bb7eaa630d152861cec81dabf6a3e01c2ff418c063498170629"},
      {"signature": "public.channel_purchase_conversion_command(uuid,text,uuid,uuid,text)", "position": 35, "creation": true, "before": null, "header": "eec0f45da30bc07744a48bf1e40d415b49c8dbf94c600f6556b0ff1e5b739252"},
    ],
    statements: [
      "94bca48d075ac9416d14a46d648beed480d1554acd6770082683220752822748",
      "4f75085a273600d4593c88d4b9417cb9de20806ce9cd16622d732d709392888a",
      "98142a842e2940d9662fc8aa0ee38f8034d7f9e3c2280a4360b3e82e4dd550e6",
      "7f93aae572e6ca13fa436659f9edebbb8178183254596a35b2c27358df545916",
      "620ee098dcdcea06ef44c64ffe11b62521996daca89d1b5bad689debab3eefc8",
      "316d2f88c44ccd58eb5e0325201ed182bdaad734fc9db1df832f302717181901",
      null,
      null,
      null,
      null,
      "002597309e10272df8532546fea6a782a9c4239505b23793f7cd09a145b34353",
      "6e05be99701bc622b1f185d724b56f13dcc64a6b8f1b5efa2db247bf5f7ba9d1",
      "aaedb2e9737c9e2379e88b6a7f9f37109ccd2ecaa327bc11f8fa4f6285ef34af",
      "4cd79d2e3c07968adc637247985a46ea00aad20b2ec666b067d42840b9112f97",
      "ce6a0e5f229adebbd133340173c5255c29682e33b5cb6a413626175097db22cd",
      "f9660bd7b945d1bde432db41ecf4ec6731af71cbfc2cdc95ea9e34a54beaf008",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "a6f8b93aaba5b9372207e273930ca34c42858dd9329c6bff7c026a3e893d3a9b",
      "01f2efccca3dcdc0f7447b2e60ba9aa35b2c4bc878370a22ee7a0b603c3c5b44",
      null,
      "b6dc29e70e3d98e361d16dd3a38af8ff954008acfbb2fbdf6ca1c9b5ba5b7d86",
      null,
      "c6694bb90fcbbae4743fd0c0ef6bbf5ca5628f9da085641757fc228539a5dd31",
      "e79eb5b6aca35004d6830bcd2148962440bc09e2ff9d06025ac9c44006d19f47",
      null,
      "0de3f2a892fc0e1c0228f0f9e69b25330f44a773e842c719be8c092fa5cd7a5b",
      null,
      "4b14702638286c8f1b1cd074e0466ca99768f89823eebe7a535ff5f1adf98d52",
      null,
      "ebc769e2da2cc2958ae53f6509458428034542ce6ea9cb140e5ebe7bb451c689",
      "b50f700cc8da6257c4877a74db987b2e72ccfceb42248c8f0b88afc0b24e72b0",
      "56a70a0b4769181404d479b61f75d99d0ced6f0c1b169f2a9507a846a7cfa781",
      "a33d8a31f979252e68d5a8cb365b6e2d2934ec240d1dace790f93572c6b9fa25",
      "e1ff172ec5e4140ca79f62320e03b6c7a0bb054e28439b65082c82a109966ff6",
      "345f79363dddbd9cf24f43aadb798298a98b2ad388c69782c995b9f82e06dfca",
      "a0801092feedd319b37efbbf3e8ffad5bb082ef797b3b39f6637e752b0b5af49",
      "77809bd087d61660da001b1a3a11aa91fe346e40ad27f414835ea1b5b0b1ee23",
      "afe14763ebe33e0bef1f3c0658a730db860182298037bf79b30799b6921d8799",
      "1a59c58d12fbee4c2f8a1b06016d1c38f2ad459b4fdfa96792192910be032df9",
      "6bf68f47fa093fc147cf307fb436b0e8380d9b476b75271320d9acab69d13224",
      "9ab01af030ad85baf031754cad9e326b1b709e550903f1bce202eebedda79b94",
      "468241f122016dfb0dd61bdd8f11e2e19f8c2fb2b7553bd06006ba3a582f8aa3",
      "cabde93eee8a834368cd1afc06e20a160463e7fcb215897ba05819143b3d58a8",
      "e08b08db75fcf20cfae3f66829884fb84dbd64dcdbd18b59030ffd146259c725",
      "86381ebf52f1ef23a0be8008f7ba0388914326fcf84269ab1d005027239c09e5",
      "d07642096ec90cdb23dccbe2877ae246adc17e935250ef93369dd2bf528e60b0",
      "14f357e0a28fbbe84205e1146b4c150ebc87e4032908d1d10832ae87becc33af",
      "6766d2184505c28d94a9c1f9a43212f0c928ea7f42b43e03d4a15be6ee1cfc5d",
      "645fa5c358e57234a236b622eacbfbe3008d80ebcb0e45a75d799f52c5eb3a33",
      "eed3023ee1a6e03e6fb4832448a3318577d8ec4e0d15ac2eddca833cb6a82045",
      "744ba8459e535a8c137179d5fa5e6fe5c08a42e91602d9a470915d2ea37e98fc",
      "304e497cbd2e2bfa4887b00a455f18145a924f12473d0eaa9101bfa7e295cf64",
      "5e94bcd7119e4de238fadf59b710ca4780f2e49d4c9b66a2d928c98dfbbcc493",
      "98c72134ba3567430a6fcda4e77380f987d4b0f15598463ef189e8c81291c4ab",
      "14017920007ae8dc7894fce5380fcc0e6c2d25d23ddc2cdb991a83bfc88a0627",
      "2db03779a41e77adba872a89911ad5db70a6530065bbee4564bd19a9a0188156",
      "edbcd61eb377e2df54b9c38024c0cd06acad953f0c3a7a30445aa88550451f6b",
      "b1c2d692510c8f5692cdc3bce2f6e497476db9f9fa8143652deb5e7f9c141958",
      "558867974925b0ec65a4dd4d3b4769bd6f0e368377d892dca6b2b44d3cae7561",
      "cd4c6ae775f2354bef7fd6b4b15adc55d04638f3733141dee380f042038ae9e0",
      "5658382dc2385d4ffac6797a4fb80943dcbc9b139928cda4114d5da4b06fda65",
      "0297ed5272d5eafefb695b13ba590211d7646a8e5d52888cc36137cd06570e51",
      "55cfe63d4f3746cb16bef353b9c17e377a6577781536d22bafbe098f9dac1b42",
      "0c6bd61fd61c9bdddec0bd39a24d03d8ec3ed8cf868b87129f06a20a936bf1b9",
      "9c218bb630d6e1eeea307b9e25846fbfbabebd509089ef64e92cd653450d6005",
      "37e9508c8cf08102a6acc2c218b605763da6381a6fc4747243dd434d8354ec05",
      "b1803f3e3826e8040998ce439c603f2fa656ab45c9d39ce420599a2ecbf74b49",
      "4194e8b9fc478a163b8647f57c8611b2bfd083489fbcfb1b213d1fb72fd4cb76",
    ],
  },
] as const;
export function validateChannelIngestForwards(forwards: BatchedForwardBinding[], paths: Set<string>): void {
  if (!Array.isArray(forwards) || ![0, channelIngestShapes.length].includes(forwards.length)) throw new Error("reviewed M17 channel requires an empty class marker or exactly four forwards");
  for (const [index, forward] of forwards.entries()) {
    const shape = channelIngestShapes[index]!;
    if (!forward || Object.keys(forward).sort().join(",") !== "functions,path,sha256,statements" || forward.path !== shape.path || paths.has(forward.path) || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== shape.functions.length) throw new Error("reviewed M17 channel path, order or function inventory drifted");
    paths.add(forward.path);
    for (const [position, fn] of forward.functions.entries()) {
      const fixed = shape.functions[position]!;
      if (!fn || Object.keys(fn).sort().join(",") !== "afterSha256,beforeSha256,signature" || fn.signature !== fixed.signature || fn.beforeSha256 !== fixed.before || !hash(fn.afterSha256)) throw new Error("reviewed M17 channel signature, creation class or preimage binding drifted");
    }
    if (!Array.isArray(forward.statements) || forward.statements.length !== shape.statements.length) throw new Error("reviewed M17 channel statement inventory drifted");
    for (const [position, pin] of forward.statements.entries()) {
      const fixed = shape.statements[position];
      if (!pin || Object.keys(pin).sort().join(",") !== (fixed === null ? "sha256" : "sha256,sql") || !hash(pin.sha256) || (fixed !== null && (pin.sha256 !== fixed || typeof pin.sql !== "string" || sqlSha256(pin.sql) !== fixed))) throw new Error("reviewed M17 channel companion statement drifted");
    }
  }
}

/** Bounded lexical admission; the SQL introduction owns exact body pins and PostgreSQL proof. */
export function assertChannelIngestForward(registry: ReviewedForwardRegistry, path: string, bytes: Buffer, preceding: { path: string; bytes: Buffer }[]): void {
  if (!registry.channelIngestForwards) throw new Error("reviewed M17 channel has no class approval");
  validateChannelIngestForwards(registry.channelIngestForwards, new Set());
  const index = registry.channelIngestForwards.findIndex(pin => pin.path === path);
  const forward = registry.channelIngestForwards[index], shape = channelIngestShapes[index];
  if (!forward || !shape || sqlSha256(bytes) !== forward.sha256) throw new Error("reviewed M17 channel path or bytes drifted");
  if (bytes.some(byte => (byte < 0x20 && byte !== 9 && byte !== 10) || byte === 0x7f)) throw new Error("reviewed M17 channel refuses control characters");
  const portable = path.startsWith("db/");
  const directory = portable ? "db/platform/migrations/" : "supabase/migrations/";
  const baseline = portable ? PLATFORM_BASELINE_FILE : MANAGED_BASELINE;
  if (preceding[0]?.path !== baseline || (!portable && sqlSha256(preceding[0].bytes) !== registry.baselineSha256) || preceding.some((source, position) => !source.path.startsWith(directory) || !/^\d{14}_[A-Za-z0-9_-]+\.sql$/u.test(source.path.slice(directory.length)) || source.path >= path || (position > 0 && source.path <= preceding[position - 1]!.path))) throw new Error("reviewed M17 channel requires the ordered complete same-rail prefix and baseline");
  for (const pin of [...registry.batchedForwards ?? [], ...registry.managedCommerceForwards ?? [], ...registry.supportAuthorityForwards ?? [], ...registry.channelIngestForwards].filter(pin => pin.path.startsWith(directory) && pin.path < path)) {
    const source = preceding.find(source => source.path === pin.path);
    if (!source || sqlSha256(source.bytes) !== pin.sha256) throw new Error("reviewed M17 channel requires every earlier same-rail pin landed first");
  }
  const statements = sqlStatements(bytes.toString("utf8"));
  const definitions = batchedFunctionDefinitions(bytes);
  if (statements.length !== shape.statements.length || definitions.size !== shape.functions.length) throw new Error("reviewed M17 channel statement or definition inventory drifted");
  for (const [position, statement] of statements.entries()) {
    const pin = forward.statements[position]!;
    if (sqlSha256(statement) !== pin.sha256 || (pin.sql !== undefined && pin.sql !== statement)) throw new Error("reviewed M17 channel ordered statement pin drifted");
  }
  for (const [position, fn] of forward.functions.entries()) {
    const fixed = shape.functions[position]!;
    const statement = statements[fixed.position]!;
    if (sqlSha256(headerAttributes(statement).replace(/\s+/gu, " ").trim()) !== fixed.header || statement.startsWith("CREATE OR REPLACE FUNCTION ") !== !fixed.creation || definitions.get(fn.signature) !== fn.afterSha256 || batchedFunctionDefinitions(Buffer.from(statement)).get(fn.signature) !== fn.afterSha256) throw new Error("reviewed M17 channel function header, definition or order drifted");
  }
  const names = new Set(forward.functions.map(fn => fn.signature.split("(")[0]!));
  const prior = new Map<string, string>();
  for (const source of preceding) {
    if (source.path === baseline) {
      const idx = cachedCreateFunctionIndex(source.bytes);
      for (const name of names) for (const statement of idx.byName.get(name.toLowerCase()) ?? []) {
        const definition = batchedFunctionDefinitionFromStatement(statement, names);
        if (definition) prior.set(definition[0], definition[1]);
      }
      continue;
    }
    for (const statement of cachedDumpSqlStatements(source.bytes)) {
      if ([...names].some(name => statement.includes(name.split(".")[1]!)) && /^(?:CREATE|ALTER|DROP)\b/iu.test(statement) && /\bFUNCTION\b/iu.test(statement) && !/^CREATE(?: CONSTRAINT)? TRIGGER /iu.test(statement) && !/^CREATE(?: OR REPLACE)? FUNCTION (?:public|private)\.[a-z_][a-z0-9_]*\s*\(/iu.test(statement)) throw new Error("reviewed M17 channel refuses unsupported preceding function DDL");
      const definition = batchedFunctionDefinitionFromStatement(statement, names);
      if (definition) prior.set(definition[0], definition[1]);
    }
  }
  for (const fn of forward.functions) if ((prior.get(fn.signature) ?? null) !== fn.beforeSha256) throw new Error("reviewed M17 channel actual function preimage drifted");
}

