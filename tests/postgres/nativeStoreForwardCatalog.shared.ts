import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PLATFORM_BASELINE_FILE, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { qualifiedCatalogueStorageSelectSql, renderNativeStoreSettingsOwnerWindow, NATIVE_SUCCESSOR_TABLE_SQL, assertNativeStoreForward, expectedReplacedFunctionAttrs, previewNoopAcceptanceSql, readReviewedForwardRegistry, renderNativeDeferredTrigger, renderQualifiedSecurityDefiner, nativeStoreFunctionDefinitions, nativeStoreAddedForeignKeys, nativeStoreCreatedTable, nativeStoreTriggerDefinition, sqlSha256, sqlStatements, type NativeDeferredTrigger, type NativeStoreSlot, type ReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { definitionPath, definitionSql, grantPath, grantSql, NATIVE_STORE_GUARD_CATALOGS } from "../helpers/issuedPlatformCatalog.js";
import { readSelectedCatalogProjection } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

// The static native-store class is a first gate for ordinary mistakes. This test is the
// truth for function identity, attributes and ACLs: it applies a forward to a real
// database and compares what PostgreSQL itself reports with the slot's lists.
type CatalogSlot = Pick<NativeStoreSlot, "createdFunctions" | "replacedFunctions" | "grantOnlyFunctions" | "qualifiedCatalogueStorageSelect" | "settingsOnlyFunctions" | "ownerWindowRole" | "purposeCheck" | "insertSelectTables" | "absorptionCensusTables" | "checkSupersets" | "uniqueSupersets" | "droppedIndexes" | "createdViews" | "createdTriggers" | "existingTableStatements" | "previewNoopAcceptance">;
// PostgreSQL creates its own objects below this OID; every object a forward adds is at or above it.
const FIRST_USER_OID = 16384;
const catalogueAuthorityPath = "db/platform/migrations/q2_20261123192500_catalog_publication_authority.sql";
// The floor is typed as oid, so every comparison with it resolves to pg_catalog's own oid >= oid and oid < oid. A bare integer
// would resolve to an operator for (oid, integer), which a forward can create in pg_catalog to hide the objects it adds.
const OID_FLOOR = `${FIRST_USER_OID}::pg_catalog.oid`;
const PURPOSE_CONSTRAINT = "public.communication_native_sync_state.communication_native_sync_state_purpose_check";
const PREVIEW_TABLE = "public.subscription_quote_previews";
const PREVIEW_CHECK = "subscription_quote_previews_acceptance_check";
const PREVIEW_NEW_DEFINITION = "CHECK ((((status = 'previewed'::text) AND (accepted_at IS NULL) AND (accepted_idempotency_key IS NULL) AND (accepted_event_id IS NULL) AND (accepted_noop_receipt_id IS NULL)) OR ((status = 'accepted'::text) AND (accepted_at IS NOT NULL) AND (accepted_idempotency_key IS NOT NULL) AND (accepted_event_id IS NOT NULL) AND (accepted_noop_receipt_id IS NULL)) OR ((status = 'accepted'::text) AND (accepted_at IS NOT NULL) AND (accepted_idempotency_key IS NOT NULL) AND (accepted_event_id IS NULL) AND (accepted_noop_receipt_id IS NOT NULL))))";
const GRANT_OPTION = " WITH GRANT OPTION";
// Node trees (default arguments, rules, policies, trigger conditions) store where the parser read them in the file, which
// moves when the same statement sits at another offset. That is compared as nothing; everything else in a tree is compared.
const POSITIONS = String.raw`':(?:stmt_)?location -?[0-9]+|:stmt_len [0-9]+', ':position'`;

type FunctionRow = { oid: number; name: string; owner: string; returnsTrigger: boolean; attrs: Record<string, unknown>; acl: string[]; rawMetadata: [string | null, string | null]; src: string };
type RelationRow = { oid: number; name: string; schema: string; relation: string; kind: string; owner: string; rls: boolean; forceRls: boolean; options: string | null; acl: string[]; columnAcls: unknown };
type Snapshot = {
  indexes: { oid: number; name: string; table: string; definition: string; attrs: unknown }[];
  functions: FunctionRow[]; relations: RelationRow[]; columns: { rel: string; name: string; attrs: Record<string, unknown>; default: string | null }[]; system: { functions: string; relations: string }; systemRules: string;
  relationOids: number[]; constraintOids: number[]; constraints: { oid: number; relationOid: number; kind: string; rel: string; name: string; def: string; validated: boolean; deferrable: boolean; deferred: boolean; indexOid: number }[]; guards: Record<string, Record<string, unknown>[]>;
};
// Every guard catalog is read whole through to_jsonb, with its OID and volatile columns left out and parser positions in
// node trees normalized, so a new guard is one entry here. `relation` names the column that ties a row to a relation:
// those rows are compared for existing relations only. The documentation lists exactly these catalogs.
// `added` admits a row that appears after the forward and was not there before: only the enforcement trigger PostgreSQL creates
// for a constraint the forward itself adds. A relation is existing when any relation of that OID was there before, PostgreSQL's own included.
const GUARDS: { id: string; catalog: string; where?: string; drop?: string[]; relation?: string; added?: (row: Record<string, unknown>, newConstraints: Set<number>) => boolean }[] = [
  { id: "schemas", catalog: "pg_namespace", where: "t.nspname !~ '^pg_(toast_)?temp_'" },
  { id: "roles", catalog: "pg_authid" }, { id: "memberships", catalog: "pg_auth_members" }, { id: "dbSettings", catalog: "pg_db_role_setting" },
  { id: "databases", catalog: "pg_database", drop: ["datfrozenxid", "datminmxid"] }, { id: "defaultAcls", catalog: "pg_default_acl" },
  { id: "eventTriggers", catalog: "pg_event_trigger" }, { id: "extensions", catalog: "pg_extension" },
  { id: "casts", catalog: "pg_cast" }, { id: "parameterAcls", catalog: "pg_parameter_acl" },
  { id: "triggers", catalog: "pg_trigger", relation: "tgrelid", added: (row, newConstraints) => row.tgisinternal === true && newConstraints.has(Number(row.tgconstraint)) }, { id: "policies", catalog: "pg_policy", relation: "polrelid" },
  { id: "rules", catalog: "pg_rewrite", where: `t.ev_class >= ${OID_FLOOR}`, relation: "ev_class" },
];
const GUARDS_SNAPSHOT_EXPR = `jsonb_build_object(${GUARDS.map(guard =>
  `'${guard.id}', (SELECT COALESCE(jsonb_agg(r ORDER BY r),'[]'::jsonb) FROM (
    SELECT regexp_replace((to_jsonb(t)${["oid", ...guard.drop ?? []].map(key => ` - '${key}'`).join("")})::text, ${POSITIONS}, 'g')::jsonb AS r
    FROM ${guard.catalog} t WHERE ${guard.where ?? "true"}) s)`
).join(", ")})`;
const aclOf = (expr: string, kind: string, owner: string) => `ARRAY(SELECT (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)||':'||a.privilege_type||(CASE WHEN a.is_grantable THEN '${GRANT_OPTION}' ELSE '' END)
  FROM aclexplode(COALESCE(${expr}, acldefault(${kind}, ${owner}))) a ORDER BY 1)`;

const SNAPSHOT_SQL = `SELECT
  COALESCE((SELECT json_agg(t) FROM (
    SELECT p.oid::int AS oid, p.oid::regprocedure::text AS name, p.proowner::regrole::text AS owner, p.prorettype = 'pg_catalog.trigger'::regtype AS "returnsTrigger",
      (to_jsonb(p)-'prosrc'-'proacl'-'proargdefaults')||jsonb_build_object('proargdefaults',regexp_replace(COALESCE(p.proargdefaults::text,''),${POSITIONS},'g')) AS attrs,
      ${aclOf("p.proacl", "'f'", "p.proowner")} AS acl, ARRAY[p.proacl::text, p.proargdefaults::text] AS "rawMetadata", p.prosrc AS src
    FROM pg_proc p WHERE p.oid >= ${OID_FLOOR} ORDER BY p.oid
  ) t), '[]'::json) AS functions,
  COALESCE((SELECT json_agg(t) FROM (
    SELECT c.oid::int AS oid, c.oid::regclass::text AS name, n.nspname::text AS schema, c.relname::text AS relation,
      c.relkind::text AS kind, c.relowner::regrole::text AS owner,
      c.relrowsecurity AS rls, c.relforcerowsecurity AS "forceRls", c.reloptions::text AS options,
      ${aclOf("c.relacl", "(CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::\"char\"", "c.relowner")} AS acl,
      (SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl::text) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL) AS "columnAcls"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid >= ${OID_FLOOR} ORDER BY c.oid
  ) t), '[]'::json) AS relations,
  md5(COALESCE((SELECT string_agg(p::text, E'\\n' ORDER BY p.oid) FROM pg_proc p WHERE p.oid < ${OID_FLOOR}),'')) AS "systemFunctions",
  md5(COALESCE((SELECT string_agg(jsonb_build_array(c.oid,c.relname,c.relnamespace,c.relowner,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relacl::text)::text, E'\\n' ORDER BY c.oid) FROM pg_class c WHERE c.oid < ${OID_FLOOR}),'')
    || COALESCE((SELECT string_agg(a.attrelid||'.'||a.attname||'='||a.attacl::text, E'\\n' ORDER BY a.attrelid,a.attnum) FROM pg_attribute a WHERE a.attrelid < ${OID_FLOOR} AND a.attacl IS NOT NULL),'')) AS "systemRelations",
  md5(COALESCE((SELECT string_agg(t::text, E'\\n' ORDER BY t.oid) FROM pg_rewrite t WHERE t.ev_class < ${OID_FLOOR}),'')) AS "systemRules",
  COALESCE((SELECT array_agg(oid::int ORDER BY oid) FROM pg_class), ARRAY[]::int[]) AS "relationOids",
  COALESCE((SELECT array_agg(oid::int ORDER BY oid) FROM pg_constraint), ARRAY[]::int[]) AS "constraintOids",
  COALESCE((SELECT json_agg(t) FROM (
    SELECT con.oid::int AS oid, con.conrelid::int AS "relationOid", con.contype AS kind, con.condeferrable AS deferrable, con.condeferred AS deferred,
      COALESCE(n.nspname||'.'||c.relname, 'type:'||con.contypid::regtype::text) AS rel, con.conname AS name, pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated, con.conindid::int AS "indexOid"
    FROM pg_constraint con LEFT JOIN pg_class c ON c.oid=con.conrelid LEFT JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE con.contype <> 'n' ORDER BY 1,2
  ) t), '[]'::json) AS constraints,
  COALESCE((SELECT json_agg(t) FROM (
    SELECT n.nspname||'.'||c.relname AS rel, a.attname AS name,
      to_jsonb(a)-'attrelid' AS attrs, pg_get_expr(d.adbin,d.adrelid) AS default
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relkind IN ('r','p') AND a.attnum>0 ORDER BY 1,a.attnum
  ) t), '[]'::json) AS columns,
  COALESCE((SELECT json_agg(t) FROM (
    SELECT c.oid::int AS oid, n.nspname||'.'||c.relname AS name,
      tn.nspname||'.'||t.relname AS table, pg_get_indexdef(c.oid) AS definition,
      regexp_replace(to_jsonb(i)::text, ${POSITIONS}, 'g')::jsonb AS attrs
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace ORDER BY c.oid
  ) t), '[]'::json) AS indexes,
  ${GUARDS_SNAPSHOT_EXPR} AS guards`;

// Preserve every structural attribute in one MVCC snapshot; normalize only parse positions.
// Objects PostgreSQL ships are compared as one digest of the facts that carry privileges; statistics columns are left out
// because autovacuum changes them between two snapshots. The relation is schema-qualified explicitly: regclass text omits
// a schema that is on the search path.
async function snapshot(db: PoolClient): Promise<Snapshot> {
  const row = (await db.query(SNAPSHOT_SQL)).rows[0]!;
  return {
    functions: row.functions as FunctionRow[],
    relations: row.relations as RelationRow[],
    columns: row.columns as Snapshot["columns"],
    indexes: row.indexes as Snapshot["indexes"],
    system: { functions: row.systemFunctions as string, relations: row.systemRelations as string },
    systemRules: row.systemRules as string,
    relationOids: row.relationOids as number[],
    constraintOids: row.constraintOids as number[],
    constraints: row.constraints as Snapshot["constraints"],
    guards: row.guards as Snapshot["guards"],
  };
}

const norm = (path: string) => `search_path=${path.replace(/\s+/gu, " ").trim()}`;
const quotedValues = (list: string) => (list.match(/'((?:[^']|'')*)'/gu) ?? []).map(value => value.slice(1, -1).replaceAll("''", "'"));
// Only the positive IN shape PostgreSQL deparses reads as a value list. The superset guard
// strips NOT VALID only after proving equal validation states; other clauses remain refused.
const checkValues = (def: string, column: string) => {
  const shape = new RegExp(`^CHECK \\(\\(${column} = ANY \\(ARRAY\\[((?:'(?:[^']|'')*'::text)(?:, '(?:[^']|'')*'::text)*)\\]\\)\\)\\)$`, "u");
  const match = shape.exec(def); return match ? quotedValues(match[1]!) : null;
};
// PostgreSQL deparses BETWEEN into these two comparisons. Negative int4
// constants are emitted as quoted literals with an explicit integer cast.
const checkRange = (def: string, column: string) => {
  const literal = "([0-9]+|'-[0-9]+'::integer)";
  const match = new RegExp(`^CHECK \\(\\(\\(${column} >= ${literal}\\) AND \\(${column} <= ${literal}\\)\\)\\)$`, "u").exec(def);
  if (!match) return null;
  const bounds = [match[1]!, match[2]!].map(value => Number(value.replace(/'|::integer/gu, "")));
  return bounds.every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) && bounds[0]! <= bounds[1]!
    ? { lower: bounds[0]!, upper: bounds[1]! } : null;
};
const PURPOSE_SHAPE = /^CHECK \(\(purpose = ANY \(ARRAY\[((?:'(?:[^']|'')*'::text)(?:, '(?:[^']|'')*'::text)*)\]\)\)\)$/u;
const purposeValues = (def: string) => { const match = PURPOSE_SHAPE.exec(def); return match ? quotedValues(match[1]!) : null; };
const uniqueDefinition = (def: string) => {
  const match = /^UNIQUE( NULLS NOT DISTINCT)? \(([a-z_][a-z0-9_]*(?:, [a-z_][a-z0-9_]*)*)\)$/u.exec(def);
  return match ? { columns: match[2]!.split(", "), nullsNotDistinct: Boolean(match[1]) } : null;
};
// Independent installed-catalogue expectations; never derive these from candidate SQL.
const SUCCESSOR_STORAGE_SHAPES: Record<string, {
  columns: [string, string, boolean, string | null][];
  constraints: string[];
  references: [string, string][];
}> = {
  "public.subscription_successor_proposals": {
    columns: [
      ["id", "2950", true, null],
      ["subscription_id", "2950", true, null],
      ["client_id", "2950", true, null],
      ["predecessor_sku_id", "2950", true, null],
      ["successor_sku_id", "2950", true, null],
      ["publication_id", "2950", true, null],
      ["source_binding", "3802", true, null],
      ["template_version", "23", true, null],
      ["lane", "25", true, null],
      ["action", "25", true, null],
      ["request", "3802", true, null],
      ["preview", "3802", true, null],
      ["quote_hash", "25", true, null],
      ["expires_at", "1184", true, null],
      ["original_case_id", "2950", false, null],
      ["original_operation_id", "2950", false, null],
      ["state", "25", true, "'offered'::text"],
      ["consent", "3802", false, null],
      ["accepted_receipt", "3802", false, null],
      ["terminal_at", "1184", false, null],
      ["created_at", "1184", true, "now()"],
    ],
    constraints: [
      "CHECK ((jsonb_typeof(preview) = 'object'::text))",
      "CHECK ((jsonb_typeof(request) = 'object'::text))",
      "CHECK ((jsonb_typeof(source_binding) = 'object'::text))",
      "CHECK (((length(btrim(action)) >= 1) AND (length(btrim(action)) <= 80)))",
      "CHECK (((length(btrim(lane)) >= 1) AND (length(btrim(lane)) <= 80)))",
      "CHECK (((length(quote_hash) = 64) AND (translate(quote_hash, 'abcdef0123456789'::text, ''::text) = ''::text)))",
      "CHECK ((state = ANY (ARRAY['offered'::text, 'accepted'::text, 'declined'::text, 'expired'::text])))",
      "CHECK (((template_version >= 1) AND (template_version <= 2147483647)))",
      "PRIMARY KEY (id)",
    ],
    references: [
      ["subscription_id", "public.subscriptions"],
      ["client_id", "public.clients"],
      ["predecessor_sku_id", "public.catalog_skus"],
      ["successor_sku_id", "public.catalog_skus"],
      ["publication_id", "public.catalog_publications"],
      ["original_case_id", "public.subscription_stock_wait_cases"],
      ["original_operation_id", "public.subscription_renewal_operations"],
    ],
  },
  "public.subscription_successor_operations_v2": {
    columns: [
      ["id", "2950", true, null],
      ["root_operation_id", "2950", true, null],
      ["proposal_id", "2950", true, null],
      ["predecessor_generation_id", "2950", false, null],
      ["subscription_id", "2950", true, null],
      ["scheduled_at", "1184", true, null],
      ["cycle_number", "23", true, null],
      ["identity_key", "25", true, null],
      ["operation_fingerprint", "25", true, null],
      ["due_snapshot", "3802", true, null],
      ["cycle_snapshot", "3802", true, null],
      ["state", "25", true, null],
      ["claim_token", "2950", true, null],
      ["claim_generation", "20", true, "1"],
      ["claimed_by", "25", true, null],
      ["claimed_at", "1184", true, null],
      ["lease_expires_at", "1184", true, null],
      ["attempt_prepared_at", "1184", false, null],
      ["external_attempt_ref", "25", false, null],
      ["external_attempt_acknowledged_at", "1184", false, null],
      ["terminal_outcome", "25", false, null],
      ["terminal_reason", "25", false, null],
      ["terminal_at", "1184", false, null],
      ["outcomes", "3802", true, "'[]'::jsonb"],
      ["superseded_by_proposal_id", "2950", false, null],
      ["cycle_id", "2950", false, null],
      ["order_id", "2950", false, null],
      ["settlement_intent_id", "2950", false, null],
      ["fulfillment_id", "2950", false, null],
      ["created_at", "1184", true, "now()"],
      ["updated_at", "1184", true, "now()"],
    ],
    constraints: [
      "CHECK (((claim_generation >= 1) AND (claim_generation <= '9223372036854775807'::bigint)))",
      "CHECK (((cycle_number >= 1) AND (cycle_number <= 2147483647)))",
      "CHECK ((jsonb_typeof(cycle_snapshot) = 'object'::text))",
      "CHECK ((jsonb_typeof(due_snapshot) = 'object'::text))",
      "CHECK ((jsonb_typeof(outcomes) = 'array'::text))",
      "CHECK (((length(btrim(claimed_by)) >= 1) AND (length(btrim(claimed_by)) <= 240)))",
      "CHECK (((length(identity_key) >= 48) AND (length(identity_key) <= 240)))",
      "CHECK (((length(operation_fingerprint) = 64) AND (translate(operation_fingerprint, 'abcdef0123456789'::text, ''::text) = ''::text)))",
      "CHECK ((state = ANY (ARRAY['claimed'::text, 'reserved'::text, 'attempt_prepared'::text, 'succeeded'::text, 'refused'::text])))",
      "PRIMARY KEY (id)",
      "UNIQUE (cycle_id)",
      "UNIQUE (fulfillment_id)",
      "UNIQUE (identity_key)",
      "UNIQUE (order_id)",
      "UNIQUE (proposal_id)",
      "UNIQUE (settlement_intent_id)",
    ],
    references: [
      ["root_operation_id", "public.subscription_renewal_operations"],
      ["proposal_id", "public.subscription_successor_proposals"],
      ["predecessor_generation_id", "public.subscription_successor_operations_v2"],
      ["subscription_id", "public.subscriptions"],
      ["superseded_by_proposal_id", "public.subscription_successor_proposals"],
      ["cycle_id", "public.subscription_cycles"],
      ["order_id", "public.commerce_orders"],
      ["settlement_intent_id", "public.commerce_settlement_intents"],
      ["fulfillment_id", "public.fulfillment_shipments"],
    ],
  },
  "public.subscription_successor_wait_cases_v2": {
    columns: [
      ["id", "2950", true, null],
      ["root_case_id", "2950", true, null],
      ["operation_id", "2950", true, null],
      ["subscription_id", "2950", true, null],
      ["client_id", "2950", true, null],
      ["scheduled_at", "1184", true, null],
      ["cycle_number", "23", true, null],
      ["state", "25", true, null],
      ["due_snapshot", "3802", true, null],
      ["cycle_snapshot", "3802", true, null],
      ["fingerprint", "25", true, null],
      ["identity_key", "25", true, null],
      ["deficits", "3802", true, null],
      ["notice_messages", "3802", true, "'{}'::jsonb"],
      ["refusal_observations", "3802", true, "'[]'::jsonb"],
      ["cycle_id", "2950", false, null],
      ["order_id", "2950", false, null],
      ["fulfillment_id", "2950", false, null],
      ["opened_at", "1184", true, "now()"],
      ["last_checked_at", "1184", true, "now()"],
      ["last_selected_at", "1184", false, null],
      ["stock_secured_at", "1184", false, null],
      ["resumed_at", "1184", false, null],
      ["closed_at", "1184", false, null],
      ["block_reason", "25", false, null],
      ["superseded_by_proposal_id", "2950", false, null],
    ],
    constraints: [
      "CHECK (((cycle_number >= 1) AND (cycle_number <= 2147483647)))",
      "CHECK ((jsonb_typeof(cycle_snapshot) = 'object'::text))",
      "CHECK ((jsonb_typeof(deficits) = 'array'::text))",
      "CHECK ((jsonb_typeof(due_snapshot) = 'object'::text))",
      "CHECK (((length(fingerprint) = 64) AND (translate(fingerprint, 'abcdef0123456789'::text, ''::text) = ''::text)))",
      "CHECK ((state = ANY (ARRAY['waiting'::text, 'stock_secured'::text, 'resumed'::text, 'closed'::text])))",
      "PRIMARY KEY (id)",
      "UNIQUE (operation_id)",
    ],
    references: [
      ["root_case_id", "public.subscription_stock_wait_cases"],
      ["operation_id", "public.subscription_successor_operations_v2"],
      ["subscription_id", "public.subscriptions"],
      ["client_id", "public.clients"],
      ["cycle_id", "public.subscription_cycles"],
      ["order_id", "public.commerce_orders"],
      ["fulfillment_id", "public.fulfillment_shipments"],
      ["superseded_by_proposal_id", "public.subscription_successor_proposals"],
    ],
  },
  "public.subscription_successor_reservations_v2": {
    columns: [
      ["id", "2950", true, null],
      ["operation_id", "2950", true, null],
      ["operation_fingerprint", "25", true, null],
      ["source_key", "25", true, null],
      ["lines", "3802", true, null],
      ["status", "25", true, null],
      ["expires_at", "1184", false, null],
      ["terminal_reason", "25", false, null],
      ["created_at", "1184", true, "now()"],
      ["updated_at", "1184", true, "now()"],
    ],
    constraints: [
      "CHECK ((jsonb_typeof(lines) = 'array'::text))",
      "CHECK (((length(btrim(source_key)) >= 1) AND (length(btrim(source_key)) <= 120)))",
      "CHECK (((length(operation_fingerprint) = 64) AND (translate(operation_fingerprint, 'abcdef0123456789'::text, ''::text) = ''::text)))",
      "CHECK ((status = ANY (ARRAY['held'::text, 'committed'::text, 'consumed'::text, 'released'::text, 'expired'::text])))",
      "PRIMARY KEY (id)",
      "UNIQUE (operation_id)",
    ],
    references: [
      ["operation_id", "public.subscription_successor_operations_v2"],
    ],
  },
};

const fail = (message: string): never => { throw new Error(`catalog: ${message}`); };

type NativeAdmission = ReturnType<typeof assertNativeStoreForward>;

/** Compare PostgreSQL's own before/after catalogs with one slot's closed lists. Throws on any difference. */
async function assertSlotCatalog(db: PoolClient, slot: CatalogSlot, before: Snapshot, after: Snapshot, migrationRole: string, forward = "", admission?: NativeAdmission) {
  const resolve = async (signature: string) => Number((await db.query("SELECT $1::regprocedure::oid::int AS oid", [signature])).rows[0].oid);
  const created = new Map<number, CatalogSlot["createdFunctions"][number]>();
  for (const fn of slot.createdFunctions) created.set(await resolve(fn.signature), fn);
  const replaced = new Map<number, CatalogSlot["replacedFunctions"][number]>();
  for (const fn of slot.replacedFunctions) replaced.set(await resolve(fn.signature), fn);
  const grantOnly = new Map<number, CatalogSlot["grantOnlyFunctions"][number]>();
  for (const fn of slot.grantOnlyFunctions) grantOnly.set(await resolve(fn.signature), fn);
  const settings = new Map<number, string>();
  for (const fn of slot.settingsOnlyFunctions ?? []) settings.set(await resolve(fn.signature), norm(fn.searchPath));

  // 0. Nothing PostgreSQL ships changes: not a function, a relation privilege or a column privilege.
  if (JSON.stringify(before.system) !== JSON.stringify(after.system)) fail("a system catalog function, relation or column privilege changed");

  // 1. New functions are exactly the created list, wherever they were created.
  const knownFunctions = new Set(before.functions.map(row => row.oid));
  for (const oid of settings.keys()) if (!knownFunctions.has(oid)) fail(`settings-only function OID ${oid} was absent before the forward`);
  const added = after.functions.filter(row => !knownFunctions.has(row.oid));
  const byOid = (x: number, y: number) => x - y;
  if (JSON.stringify(added.map(row => row.oid).sort(byOid)) !== JSON.stringify([...created.keys()].sort(byOid))) fail(`created functions differ from the slot list: ${added.map(row => row.name).join(", ")}`);

  // 2. Existing functions change only as allowed by their slot lists.
  const current = new Map(after.functions.map(row => [row.oid, row]));
  for (const old of before.functions) {
    const now = current.get(old.oid);
    if (!now) return fail(`function ${old.name} was dropped`);
    const searchPath = settings.get(old.oid);
    if (searchPath !== undefined) {
      const config = (old.attrs.proconfig as string[] | null) ?? [];
      const isSearchPath = (entry: string) => entry.startsWith("search_path=");
      const proconfig = config.some(isSearchPath)
        ? config.map(entry => isSearchPath(entry) ? searchPath : entry)
        : [...config, searchPath];
      const expected = { ...old, attrs: { ...old.attrs, proconfig } };
      if (JSON.stringify(now) !== JSON.stringify(expected)) fail(`settings-only function ${old.name} must change only to the pinned ${searchPath}`);
    } else if (replaced.has(old.oid)) {
      const replacement = replaced.get(old.oid)!;
      const expectedAttrs = expectedReplacedFunctionAttrs(old.attrs, replacement.searchPath);
      if (replacement.qualifiedSecurityDefiner && now.attrs.prosecdef !== expectedAttrs.prosecdef) {
        fail(`replaced function ${old.name} must preserve its installed SECURITY ${expectedAttrs.prosecdef ? "DEFINER" : "INVOKER"} mode; use the rendered qualifiedSecurityDefiner statement immediately after its replacement`);
      }
      if (JSON.stringify(now.attrs) !== JSON.stringify(expectedAttrs) || JSON.stringify(now.acl) !== JSON.stringify(old.acl)) fail(`replaced function ${old.name} changed attributes or ACL`);
    } else if (grantOnly.has(old.oid)) {
      const entry = grantOnly.get(old.oid)!;
      if (JSON.stringify(now.attrs) !== JSON.stringify(old.attrs) || now.src !== old.src) fail(`grant-only function ${old.name} was redefined`);
      const gained = now.acl.filter(item => !old.acl.includes(item)); const lost = old.acl.filter(item => !now.acl.includes(item));
      const ok = (item: string, roles: string[]) => roles.some(role => item.startsWith(`${role}:`));
      if (gained.some(item => !item.endsWith(":EXECUTE") || !ok(item, entry.grantTo))) fail(`grant-only function ${old.name} gained ${gained.join(", ")} outside its grant list`);
      if (lost.some(item => !ok(item, [...entry.revokeFrom, ...entry.grantTo]))) fail(`grant-only function ${old.name} lost ${lost.join(", ")} outside its role lists`);
    } else if (JSON.stringify({ ...now, rawMetadata: old.rawMetadata }) !== JSON.stringify(old)) fail(`function ${old.name} changed but is on no slot list`);
  }

  // 3. Created functions: owned by the migration role, pinned search_path for every definer, no PUBLIC or anon execute, closed grantees only.
  for (const row of added) {
    const entry = created.get(row.oid)!;
    if (row.owner !== migrationRole) fail(`created function ${row.name} is owned by ${row.owner}, not the migration role`);
    const config = row.attrs.proconfig as string[] | null;
    if (entry.searchPath !== null) { if (JSON.stringify(config) !== JSON.stringify([norm(entry.searchPath)])) fail(`created function ${row.name} has proconfig ${JSON.stringify(config)}, not the pinned search_path`); }
    else if (row.attrs.prosecdef) fail(`created definer ${row.name} has no pinned search_path in its slot`);
    else if (config !== null) fail(`created function ${row.name} has proconfig ${JSON.stringify(config)} but its slot pins none`);
    if (row.acl.some(item => item.startsWith("PUBLIC:"))) fail(`created function ${row.name} keeps PUBLIC execute`);
    for (const item of row.acl) {
      const grantee = item.slice(0, item.indexOf(":"));
      if (grantee !== migrationRole && !["authenticated", "service_role"].includes(grantee)) fail(`created function ${row.name} grants ${item}`);
      if (grantee !== migrationRole && item.endsWith(GRANT_OPTION)) fail(`created function ${row.name} grants ${item}, which can pass the privilege on`);
    }
  }

  // 4. Relations: no privilege or row-security change on an existing one; a new one is owned by the migration role and carries only its privileges.
  const oldRelations = new Map(before.relations.map(row => [row.oid, row]));
  const currentRelations = new Map(after.relations.map(row => [row.oid, row]));
  const replacedUniqueIndexes = new Set(before.constraints.filter(old => slot.uniqueSupersets?.some(entry => entry.table === old.rel && entry.constraint === old.name)).map(old => old.indexOid));
  const droppedIndexes = new Set<number>(), listedIndexes = new Set((slot.droppedIndexes ?? []).map(entry => `public.${entry.name}`));
  for (const entry of slot.droppedIndexes ?? []) {
    const name = `public.${entry.name}`, index = before.indexes.find(index => index.name === name);
    if (!index || index.table !== entry.table || before.constraints.some(constraint => constraint.indexOid === index.oid) || after.indexes.some(now => now.oid === index.oid || now.name === name)) fail(`listed index ${name} must be a removed standalone index on ${entry.table}`);
    droppedIndexes.add(index!.oid);
    for (const facts of ["columns", "constraints"] as const) if (JSON.stringify(before[facts].filter(row => row.rel === entry.table)) !== JSON.stringify(after[facts].filter(row => row.rel === entry.table))) fail(`dropped index table ${entry.table} changed ${facts}`);
    for (const old of before.indexes.filter(old => old.table === entry.table && !listedIndexes.has(old.name))) if (JSON.stringify(after.indexes.find(now => now.oid === old.oid)) !== JSON.stringify(old)) fail(`other index ${old.name} changed beside a listed drop`);
    // History can reach the index without naming it (escaped identifiers, built SQL), so PostgreSQL
    // proves that the dropped index is exactly what its pinned CREATE builds.
    const create = indexStatements.get(entry.beforeSha256) ?? fail(`listed index ${name} has no pinned CREATE`);
    await db.query("SAVEPOINT pinned_index");
    try {
      await db.query(create);
      if ((await db.query("SELECT pg_get_indexdef($1::regclass) AS definition", [name])).rows[0].definition !== index!.definition) fail(`listed index ${name} differs from its pinned CREATE`);
    } finally { await db.query("ROLLBACK TO SAVEPOINT pinned_index"); }
  }
  const storageAcl = slot.qualifiedCatalogueStorageSelect && (await db.query(`SELECT
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname='openlup_catalog_publication')
    AND EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations WHERE catalog_path=$1 AND sha256=$2) AS present`,
  [catalogueAuthorityPath, sqlSha256(readFileSync(catalogueAuthorityPath))])).rows[0]?.present === true;
  for (const old of before.relations) {
    if (replacedUniqueIndexes.has(old.oid) || droppedIndexes.has(old.oid)) continue;
    const prior = old.columnAcls as [string, string][] | null;
    const expected = storageAcl && old.name === "public.catalog_sku_revisions"
      ? { ...old, columnAcls: [...prior ?? [], ["net_content_storage", `{openlup_catalog_publication=r/${old.owner}}`]] }
      : old;
    if (JSON.stringify(currentRelations.get(old.oid)) !== JSON.stringify(expected)) fail(`existing relation ${old.name} changed its owner, ACL, row security, options or column ACLs`);
  }
  const clientReferences = new Set((await db.query(`SELECT DISTINCT conrelid::int AS oid FROM pg_constraint
    WHERE contype='f' AND confrelid=to_regclass('public.clients')`)).rows.map(row => Number(row.oid)));
  const censusSeen = new Set<string>();
  for (const row of after.relations) if (!oldRelations.has(row.oid)) {
    if (row.owner !== migrationRole) fail(`new relation ${row.name} is owned by ${row.owner}, not the migration role`);
    // The absorber joins the raw relname, never regclass's quoted display text.
    const censusIdentity = row.schema === "public" ? `public.${row.relation}` : undefined;
    const classification = clientReferences.has(row.oid)
      ? (await db.query("SELECT disposition FROM public.client_absorption_policy WHERE table_name=$1", [row.relation])).rows : [];
    if (clientReferences.has(row.oid) && classification.length === 0) fail(`new relation ${row.name} has no absorption classification`);
    if (Object.hasOwn(SUCCESSOR_STORAGE_SHAPES, row.name) && SUCCESSOR_STORAGE_SHAPES[row.name]!.columns.some(([column]) => column === "client_id") && classification[0]?.disposition !== "block") fail("successor storage absorption must block");
    if (censusIdentity && slot.absorptionCensusTables?.includes(censusIdentity)) {
      const role = (await db.query("SELECT oid::int AS oid FROM pg_roles WHERE rolname='service_role'")).rows[0]?.oid as number | undefined;
      const policies = after.guards.policies!.filter(policy => Number(policy.polrelid) === row.oid);
      const expressions = (await db.query("SELECT pg_get_expr(polqual,polrelid) AS qual, pg_get_expr(polwithcheck,polrelid) AS check_expr FROM pg_policy WHERE polrelid=$1::oid", [row.oid])).rows;
      const columns = (await db.query(`SELECT a.attname AS column, x.grantee::regrole::text AS role, x.privilege_type AS privilege, x.is_grantable AS grantable
        FROM pg_attribute a, LATERAL aclexplode(a.attacl) x WHERE a.attrelid=$1::oid ORDER BY 1,2,3`, [row.oid])).rows;
      const reference = (await db.query(`SELECT 1 FROM pg_constraint f JOIN pg_attribute a ON a.attrelid=f.conrelid AND f.conkey=ARRAY[a.attnum]
        JOIN pg_attribute target ON target.attrelid=f.confrelid AND f.confkey=ARRAY[target.attnum]
        WHERE f.contype='f' AND f.conrelid=$1::oid AND f.confrelid='public.clients'::regclass AND a.attname='client_id' AND target.attname='id'`, [row.oid])).rows;
      if (row.kind !== "r" || !row.rls || row.forceRls || row.acl.some(item => !item.startsWith(`${row.owner}:`)) || reference.length !== 1
        || JSON.stringify(columns) !== JSON.stringify(role ? [{ column: "client_id", role: "service_role", privilege: "SELECT", grantable: false }] : [])
        || JSON.stringify(classification) !== JSON.stringify([{ disposition: "block" }]) || policies.length !== (role ? 1 : 0)
        || (role && (policies[0]!.polname !== `${row.relation}_absorption_census` || policies[0]!.polcmd !== "r"
          || policies[0]!.polpermissive !== true || JSON.stringify(policies[0]!.polroles) !== JSON.stringify([String(role)])
          || expressions[0]?.qual !== "true" || expressions[0]?.check_expr !== null))) fail(`new relation ${row.name} exceeds its absorption census shape`);
      censusSeen.add(censusIdentity); continue;
    }
    if (row.name === "public.commerce_offer_policy_rollout_baselines" && JSON.stringify(slot.insertSelectTables) === JSON.stringify([row.name])) {
      const role = (await db.query("SELECT oid::int AS oid FROM pg_roles WHERE rolname='service_role'")).rows[0]?.oid as number | undefined;
      const acl = row.acl.filter(item => !item.startsWith(`${row.owner}:`));
      const policies = (await db.query(`SELECT polname, polcmd::text, polpermissive, polroles::text[],
        pg_get_expr(polqual,polrelid) AS qual, pg_get_expr(polwithcheck,polrelid) AS check_expr
        FROM pg_policy WHERE polrelid=$1::oid ORDER BY polcmd`, [row.oid])).rows;
      const expected = role ? [
        { polname: "commerce_offer_policy_baselines_service_insert", polcmd: "a", polpermissive: true, polroles: [String(role)], qual: null, check_expr: "true" },
        { polname: "commerce_offer_policy_baselines_service_select", polcmd: "r", polpermissive: true, polroles: [String(role)], qual: "true", check_expr: null },
      ] : [];
      if (row.kind !== "r" || !row.rls || row.forceRls
        || JSON.stringify(acl) !== JSON.stringify(role ? ["service_role:INSERT", "service_role:SELECT"] : [])
        || JSON.stringify(policies) !== JSON.stringify(expected)) fail("baseline exceeds its pinned service SELECT/INSERT shape");
    } else if (row.name === "public.subscription_notice_refusals" && JSON.stringify(slot.insertSelectTables) === JSON.stringify([row.name])) {
      const role = (await db.query("SELECT oid::int AS oid FROM pg_roles WHERE rolname='service_role'")).rows[0]?.oid as number | undefined;
      const acl = row.acl.filter(item => !item.startsWith(`${row.owner}:`));
      const policies = after.guards.policies!.filter(policy => Number(policy.polrelid) === row.oid);
      const expressions = (await db.query("SELECT pg_get_expr(polqual,polrelid) AS qual, pg_get_expr(polwithcheck,polrelid) AS check_expr FROM pg_policy WHERE polrelid=$1::oid", [row.oid])).rows;
      if (row.kind !== "r" || !row.rls || row.forceRls || JSON.stringify(acl) !== JSON.stringify(role ? ["service_role:INSERT", "service_role:SELECT"] : [])
        || policies.length !== (role ? 1 : 0) || (role && (policies[0]!.polname !== "subscription_notice_refusals_runtime" || policies[0]!.polcmd !== "*" || policies[0]!.polpermissive !== true
          || JSON.stringify(policies[0]!.polroles) !== JSON.stringify([String(role)]) || expressions[0]?.qual !== "true" || expressions[0]?.check_expr !== "true"))) fail(`new relation ${row.name} exceeds its pinned INSERT/SELECT shape`);
    } else for (const item of row.acl) if (!item.startsWith(`${row.owner}:`)) fail(`new relation ${row.name} grants ${item}`);
    if (row.columnAcls !== null) fail(`new relation ${row.name} has column privileges ${JSON.stringify(row.columnAcls)}`);
  }
  if (slot.absorptionCensusTables?.some(table => !censusSeen.has(table))) fail("absorption census requires a new relation in this slot");

  if (slot.insertSelectTables?.includes("public.commerce_offer_policy_rollout_baselines")
    && !after.relations.some(row => row.name === "public.commerce_offer_policy_rollout_baselines" && !oldRelations.has(row.oid))) fail("baseline requires a new relation in this slot");
  if (slot.existingTableStatements?.includes(ASSIGNMENT_SWITCH)) {
    const field = (column: Snapshot["columns"][number]) => column.rel === "public.subscriptions" && column.name === "offer_policy_assignment_state";
    const column = after.columns.find(field);
    if (before.columns.some(field) || !column || column.default !== "'pending_acquisition'::text"
      || column.attrs.attnotnull !== true || column.attrs.atttypid !== "25") fail("assignment default switch requires a fresh non-null text column and its exact future default");
  }

  const newViews = after.relations.filter(row => !oldRelations.has(row.oid) && row.kind === "v").map(row => row.name).sort();
  if (JSON.stringify(newViews) !== JSON.stringify((slot.createdViews ?? []).map(view => view.name).sort())) fail("created views differ from the slot list");

  // New entries compare the installed definitions, independently of historical SQL text.
  const constraintKey = (row: { rel: string; name: string }) => `${row.rel}.${row.name}`;
  const nowConstraints = new Map(after.constraints.map(row => [constraintKey(row), row.def]));
  const checks = slot.checkSupersets ?? [], uniques = slot.uniqueSupersets ?? [];
  const sorted = (values: string[]) => JSON.stringify([...new Set(values)].sort());
  for (const entry of checks) {
    const old = before.constraints.find(old => old.rel === entry.table && old.name === entry.constraint);
    const current = after.constraints.find(row => row.rel === entry.table && row.name === entry.constraint);
    if (old && current && old.validated !== current.validated) fail(`CHECK changed its validation state: ${entry.table}.${entry.constraint}`);
    if ("range" in entry) {
      if (!old || sqlSha256(old.def) !== entry.beforeSha256) fail(`range CHECK preimage mismatch: ${entry.table}.${entry.constraint}`);
      const column = before.columns.find(row => row.rel === entry.table && row.name === entry.column);
      if (column?.attrs.atttypid !== "23" || !before.relations.some(row => row.name === entry.table && row.kind === "r")) fail("range CHECK requires an existing integer column on an ordinary table");
      const range = (row: Snapshot["constraints"][number] | undefined) => row ? checkRange(row.validated ? row.def : row.def.replace(/ NOT VALID$/u, ""), entry.column) : null;
      const oldRange = range(old), newRange = range(current);
      if (!oldRange || !newRange || newRange.lower !== entry.range.lower || newRange.upper !== entry.range.upper
        || newRange.lower > oldRange.lower || newRange.upper < oldRange.upper
        || (newRange.lower === oldRange.lower && newRange.upper === oldRange.upper)) fail(`range CHECK changed beyond its listed strict widening: ${current?.def}`);
      continue;
    }
    const values = (row: Snapshot["constraints"][number] | undefined) => row ? checkValues(row.validated ? row.def : row.def.replace(/ NOT VALID$/u, ""), entry.column) : null;
    const oldValues = values(old), newValues = values(current);
    if (!oldValues || !newValues || oldValues.some(value => !newValues.includes(value)) || sorted(entry.values) !== sorted(newValues)) fail(`CHECK changed beyond its listed widening: ${current?.def}`);
  }
  for (const entry of uniques) {
    const old = before.constraints.find(old => old.rel === entry.table && old.name === entry.constraint);
    const oldDef = old ? uniqueDefinition(old.def) : null;
    const def = nowConstraints.get(`${entry.table}.${entry.constraint}`), newDef = def ? uniqueDefinition(def) : null;
    if (!oldDef || !newDef || oldDef.columns.some(column => !entry.columns.includes(column)) || (oldDef.nullsNotDistinct && !entry.nullsNotDistinct) || JSON.stringify(newDef) !== JSON.stringify({ columns: entry.columns, nullsNotDistinct: entry.nullsNotDistinct })) fail(`UNIQUE changed beyond its listed superset: ${def}`);
  }
  const protectedTables = new Set([...checks, ...uniques].map(entry => entry.table));
  if (slot.previewNoopAcceptance) {
    const current = after.constraints.find(row => row.rel === PREVIEW_TABLE && row.name === PREVIEW_CHECK);
    if (current?.kind !== "c" || !current.validated || current.def !== PREVIEW_NEW_DEFINITION) fail("preview acceptance CHECK must match the three validated branches");
  }
  for (const old of before.columns.filter(column => protectedTables.has(column.rel))) {
    const now = after.columns.find(column => column.rel === old.rel && column.name === old.name);
    // DROP NOT NULL is the existing-table weakening; all other stored column facts stay fixed.
    const expected = now?.attrs.attnotnull === false && old.attrs.attnotnull === true ? { ...old, attrs: { ...old.attrs, attnotnull: false } } : old;
    if (JSON.stringify(now) !== JSON.stringify(expected)) fail(`column ${old.rel}.${old.name} changed outside its constraint replacement`);
  }
  for (const old of before.constraints) {
    if (checks.some(entry => entry.table === old.rel && entry.constraint === old.name) || uniques.some(entry => entry.table === old.rel && entry.constraint === old.name)) continue;
    if (slot.previewNoopAcceptance && old.rel === PREVIEW_TABLE && old.name === PREVIEW_CHECK) continue;
    const def = nowConstraints.get(constraintKey(old));
    if (constraintKey(old) === PURPOSE_CONSTRAINT && def !== undefined && def !== old.def) {
      const oldValues = purposeValues(old.def), newValues = purposeValues(def);
      const sorted = (values: string[]) => JSON.stringify([...new Set(values)].sort());
      if (!slot.purposeCheck || !oldValues || !newValues || sorted(slot.purposeCheck.values) !== sorted(oldValues) || oldValues.some(value => !newValues.includes(value))) fail(`purpose CHECK changed beyond a widening of its listed values: ${def}`);
    } else if (def !== old.def) fail(`constraint ${constraintKey(old)} was dropped or rewritten`);
  }

  // Declared fresh-column FK actions and the closed same-SKU pair extend an existing table. Read the
  // actual target, key, action and validation state from PostgreSQL, not SQL history.
  const foreignKeys = nativeStoreAddedForeignKeys(slot.existingTableStatements ?? []);
  const installedKeys = (await db.query(`SELECT c.conrelid::int AS relation, c.conname AS name,
    c.confrelid::int AS target, c.confdeltype::text AS deletion, c.confupdtype::text AS update,
    c.confmatchtype::text AS match, c.convalidated AS validated, c.condeferrable AS deferrable,
    c.condeferred AS deferred, c.conkey::int[] AS columns, c.confkey::int[] AS keys
    FROM pg_constraint c WHERE c.contype='f'`)).rows;
  // This is additive to every generic owner/ACL/catalogue guard above and below.
  // Read the installed keys independently of the statement classifier.
  const admittedTriggers = new Set<string>(), deferredLinks = new Set<number>();
  for (const entry of slot.createdTriggers ?? []) {
    const deferred = entry.deferred === true, relation = deferred ? entry.relation : entry.table;
    const accepted = admission?.ordinaryProof.get(entry.name);
    const expected = deferred ? null : admission ? accepted?.definition : nativeStoreTriggerDefinition(triggerStatements.get(entry.sha256) ?? "");
    if (!deferred && (!expected || expected.name !== entry.name || expected.table !== relation)) return fail("created trigger source differs from its listed hash and identity");
    const prefixTable = before.relations.find(row => row.name === relation && row.kind === "r");
    if (before.guards.triggers!.some(row => row.tgname === entry.name && (!deferred || Number(row.tgrelid) === prefixTable?.oid))) fail("created trigger name existed in the prefix");
    const localTable = deferred || accepted?.localTable || (!admission && !prefixTable && hasEarlierTriggerTable(forward, relation, entry.sha256));
    const table = after.relations.find(row => row.name === relation && row.kind === "r" && (prefixTable
      ? row.oid === prefixTable.oid : localTable && !before.relationOids.includes(row.oid) && row.owner === migrationRole));
    const signature = deferred ? entry.function : expected!.signature;
    if (!table || (!deferred && !slot.createdFunctions.some(fn => fn.signature === signature && fn.searchPath))) return fail("created trigger requires a prefix or earlier same-slot owned table and same-slot created function");
    const functionOid = await resolve(signature), fn = current.get(functionOid);
    const prefixFunction = deferred && before.functions.some(row => row.oid === functionOid);
    if (!fn?.returnsTrigger || fn.attrs.prosecdef || (deferred && fn.attrs.proretset)) fail("created trigger function must be an owner-only invoker returning trigger");
    if (prefixFunction ? replaced.has(functionOid) || grantOnly.has(functionOid) : !created.has(functionOid) || fn?.acl.some(item => !item.startsWith(`${migrationRole}:`))) fail("created trigger function must be an owner-only invoker returning trigger");
    const rows = after.guards.triggers!.filter(row => row.tgname === entry.name && Number(row.tgrelid) === table.oid), row = rows[0];
    if (!row || rows.length !== 1 || row.tgenabled !== "O" || row.tgisinternal !== false || Number(row.tgfoid) !== functionOid || Number(row.tgnargs) !== 0) return fail("created trigger binding or enabled state differs from its entry");
    const constraint = Number(row.tgconstraint);
    if (deferred) {
      const bits = { INSERT: 4, DELETE: 8, UPDATE: 16 };
      if (Number(row.tgtype) !== 1 + entry.events.reduce((mask, event) => mask + bits[event], 0) || !Array.isArray(row.tgattr) || row.tgattr.length || row.tgqual !== null
        || Number(row.tgconstrrelid) !== 0 || row.tgoldtable !== null || row.tgnewtable !== null) fail("deferred trigger events or row shape differ from its entry");
      const link = after.constraints.find(candidate => candidate.oid === constraint);
      if (!link || before.constraintOids.includes(constraint) || link.kind !== "t" || link.relationOid !== table.oid || link.name !== entry.name || !link.validated) fail("created deferred trigger requires its own new validated constraint");
      if (row.tgdeferrable !== true || row.tginitdeferred !== true || !link?.deferrable || !link.deferred) fail("created trigger deferral differs from its entry");
      deferredLinks.add(constraint);
    } else {
      if (constraint !== 0) fail("created trigger binding or enabled state differs from its entry");
      const installed = (await db.query("SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname=$1 AND tgrelid=$2::oid", [entry.name, table.oid])).rows[0];
      const actual = nativeStoreTriggerDefinition(`${installed?.definition};`);
      const eventKey = (events: NonNullable<typeof actual>["events"]) => JSON.stringify(events.map(event => ({ ...event, columns: [...event.columns].sort() })).sort((a, b) => a.event.localeCompare(b.event)));
      if (!actual || actual.name !== expected!.name || actual.table !== expected!.table || actual.signature !== signature || actual.timing !== expected!.timing
        || eventKey(actual.events) !== eventKey(expected!.events)) fail("created trigger events or row shape differ from its entry");
    }
    admittedTriggers.add(JSON.stringify(row));
  }

  const storage = after.relations.filter(row => Object.hasOwn(SUCCESSOR_STORAGE_SHAPES, row.name) && !oldRelations.has(row.oid));
  for (const row of storage) {
    const shape = SUCCESSOR_STORAGE_SHAPES[row.name]!;
    if (row.kind !== "r") fail("successor storage relation kind differs");
    if (!row.rls || row.forceRls) fail("successor storage RLS differs");
    if (!slot.absorptionCensusTables?.includes(row.name) && after.guards.policies!.some(policy => Number(policy.polrelid) === row.oid)) fail("successor storage policy is unlisted");
    const columns = after.columns.filter(column => column.rel === row.name);
    const actualColumns = columns.map(column => [column.name, column.attrs.atttypid, column.attrs.attnotnull, column.default, column.attrs.attisdropped, column.attrs.atttypmod, column.attrs.attndims, column.attrs.attidentity, column.attrs.attgenerated, column.attrs.attcollation]);
    const expectedColumns = shape.columns.map(column => [...column, false, -1, 0, "", "", column[1] === "25" ? "100" : "0"]);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) fail("successor storage columns differ");
    const actualConstraints = after.constraints.filter(constraint => constraint.rel === row.name && !deferredLinks.has(constraint.oid) && !constraint.def.startsWith("FOREIGN KEY")).map(constraint => constraint.def).sort();
    if (JSON.stringify(actualConstraints) !== JSON.stringify([...shape.constraints].sort())) fail("successor storage PK, UNIQUE or CHECK differs");
    const actualKeys = installedKeys.filter(key => key.relation === row.oid).map(key => [key.columns, key.target, key.keys, key.deletion, key.update, key.match, key.validated, key.deferrable, key.deferred]);
    const expectedKeys = shape.references.map(([column, reference]) => {
      // Only the four bounded shapes may target one another in the same slot.
      // Every other target and its key must already exist in the prefix.
      const prefix = Object.hasOwn(SUCCESSOR_STORAGE_SHAPES, reference) ? after : before;
      const target = prefix.relations.find(relation => relation.name === reference && relation.kind === "r");
      const id = prefix.columns.find(column => column.rel === reference && column.name === "id");
      return [[shape.columns.findIndex(entry => entry[0] === column) + 1], target?.oid ?? -1, [id?.attrs.attnum ?? -1], "r", "a", "s", true, false, false];
    });
    const ordered = (values: unknown[]) => JSON.stringify(values.map(value => JSON.stringify(value)).sort());
    if (ordered(actualKeys) !== ordered(expectedKeys)) fail("successor storage FK differs");
  }
  const successors = after.relations.find(row => row.name === "public.catalog_sku_successors" && !oldRelations.has(row.oid));
  for (const key of installedKeys) if (!oldRelations.has(key.relation) && key.deletion === "r" && key.relation !== successors?.oid && !storage.some(row => row.oid === key.relation)) fail("new-table RESTRICT FK is outside the successor shape");
  if (successors) {
    const columns = after.columns.filter(row => row.rel === successors.name);
    const names = ["predecessor_sku_id", "successor_sku_id", "publication_id"];
    if (successors.kind !== "r" || JSON.stringify(columns.map(row => row.name)) !== JSON.stringify(names)
      || columns.some(row => row.attrs.atttypid !== "2950" || row.attrs.attnotnull !== true || row.default !== null || row.attrs.attisdropped !== false)) fail("successor columns differ from the closed UUID NOT NULL shape");
    const keys = installedKeys.filter(key => key.relation === successors.oid);
    // Three named single-column FKs, the PK and CHECK exhaust the five constraints below.
    for (const [index, name] of names.entries()) {
      const reference = index === 2 ? "public.catalog_publications" : "public.catalog_skus";
      const target = before.relations.find(row => row.name === reference && row.kind === "r");
      const id = before.columns.find(row => row.rel === reference && row.name === "id");
      const key = keys.find(key => JSON.stringify(key.columns) === JSON.stringify([columns[index]!.attrs.attnum]));
      if (!key || !target || !id || key.target !== target.oid || JSON.stringify(key.keys) !== JSON.stringify([id.attrs.attnum])
        || key.deletion !== "r" || key.update !== "a" || key.match !== "s" || !key.validated || key.deferrable || key.deferred) fail(`successor FK ${name} differs from its exact target, arity or RESTRICT action`);
    }
    const constraints = after.constraints.filter(row => row.rel === successors.name && !deferredLinks.has(row.oid));
    const primary = constraints.filter(row => row.def.startsWith("PRIMARY KEY"));
    const check = constraints.filter(row => row.def.startsWith("CHECK"));
    // The exact CHECK definition also excludes PostgreSQL's NOT VALID suffix.
    if (constraints.length !== 5 || primary.length !== 1 || primary[0]!.def !== "PRIMARY KEY (predecessor_sku_id, successor_sku_id)"
      || check.length !== 1 || check[0]!.def !== "CHECK ((predecessor_sku_id <> successor_sku_id))") fail("successor primary key or self-link CHECK differs from its closed shape");
  }
  const freshKeys = installedKeys.filter(key => oldRelations.has(key.relation) && !before.constraints.some(old => old.rel === oldRelations.get(key.relation)!.name && old.name === key.name) && (["c", "n"].includes(key.deletion) || key.name === "subscription_lines_catalog_sku_revision_fkey"));
  if (freshKeys.length !== foreignKeys.length) fail("FK delete actions differ from the slot's existing-table list");
  for (const key of foreignKeys) {
    const table = before.relations.find(row => row.name === key.table && row.kind === "r");
    const installed = freshKeys.find(row => row.relation === table?.oid && row.name === key.name);
    const column = after.columns.find(row => row.rel === key.table && row.name === key.column);
    const target = after.relations.find(row => row.name === key.reference && row.kind === "r");
    const sourceColumns = key.columns.map(name => after.columns.find(row => row.rel === key.table && row.name === name)?.attrs.attnum);
    const targetColumns = key.keys.map(name => after.columns.find(row => row.rel === key.reference && row.name === name)?.attrs.attnum);
    if (!table || !column || before.columns.some(row => row.rel === key.table && row.name === key.column)) fail("FK delete action requires a fresh column on an existing table");
    if (!installed || !target || sourceColumns.includes(undefined) || targetColumns.includes(undefined) || installed.target !== target.oid || installed.deletion !== key.deletion || installed.validated !== key.validated
      || installed.update !== "a" || installed.match !== "s" || installed.deferrable || installed.deferred
      || JSON.stringify(installed.columns) !== JSON.stringify(sourceColumns) || JSON.stringify(installed.keys) !== JSON.stringify(targetColumns)) fail("FK target, key, delete action or validation state differs from its entry");
    for (const old of before.columns.filter(row => row.rel === key.table)) if (JSON.stringify(after.columns.find(row => row.rel === old.rel && row.name === old.name)) !== JSON.stringify(old)) fail(`FK table column ${old.rel}.${old.name} changed`);
  }


  for (const row of after.guards.triggers!) if (row.tgisinternal === false && !before.relationOids.includes(Number(row.tgrelid)) && !admittedTriggers.has(JSON.stringify(row))) fail("unlisted trigger on a new relation");

  // 6. Guard catalogs: every row that existed stays as it was, and nothing attaches behaviour (a trigger, a policy, a
  // rewrite rule, a view's own included) to an existing relation. A new row is a change unless the guard admits it.
  const existing = new Set(before.relationOids), knownConstraints = new Set(before.constraintOids);
  const newConstraints = new Set(after.constraintOids.filter(oid => !knownConstraints.has(oid)));
  for (const guard of GUARDS) {
    if (guard.id === "rules" && before.systemRules !== after.systemRules) fail("rules on existing relations changed");
    const rows = (snap: Snapshot) => snap.guards[guard.id]!.filter(row => !guard.relation || existing.has(Number(row[guard.relation])));
    const was = new Set(rows(before).map(row => JSON.stringify(row))), now = rows(after);
    const kept = new Set(now.map(row => JSON.stringify(row)));
    if ([...was].some(row => !kept.has(row)) || now.some(row => !was.has(JSON.stringify(row)) && !guard.added?.(row, newConstraints) && !(guard.id === "triggers" && admittedTriggers.has(JSON.stringify(row))))) fail(`${guard.id} ${guard.relation ? "on existing relations " : ""}changed`);
  }
}

// Names in the catalog reads and the signature lookup resolve through the catalog first, so neither the forward's own
// search_path nor a temporary object named like a catalog can capture them.
async function pinned<T>(db: PoolClient, run: () => Promise<T>): Promise<T> {
  await db.query("SET search_path = pg_catalog, pg_temp");
  try { return await run(); } finally { await db.query("RESET search_path").catch(() => undefined); }
}

// Object OIDs and file IDs are allocated per install. Page estimates and vacuum
// horizons reflect data and maintenance. No other catalog field is discarded.
const PREVIEW_CATALOG_DENY_LIST = {
  row: ["oid"],
  pg_class: ["relfilenode", "relpages", "reltuples", "relallvisible", "relfrozenxid", "relminmxid"],
} as const;

// A relid/subid-zero address owns its columns. Match dependencies of all subids
// of a whole object, and match an individual subobject only by its own subid.
// The preimage proof compares the preview table's pg_depend closure with its expected
// snapshot, excluding only non-internal triggers on the table (pg_trigger NOT tgisinternal),
// their constraint-trigger pg_constraint rows (contype = 't') and the pg_depend rows those bring.
// Every column, every other constraint kind (c, f, p, u, x) including the acceptance CHECK,
// and internal RI triggers stay compared. User triggers cannot change which rows the CHECK
// accepts or what the byte-exact forward does; the static history scan allows exactly trigger
// DDL, so both layers follow one rule.
const PREVIEW_GRAPH_SQL = `
  WITH RECURSIVE root AS (SELECT to_regclass($1)::oid AS oid),
  user_triggers AS (
    SELECT t.oid, t.tgconstraint FROM pg_trigger t JOIN root r ON r.oid=t.tgrelid
    WHERE NOT t.tgisinternal
  ),
  excluded(classid, objid) AS (
    SELECT 'pg_trigger'::regclass::oid, oid FROM user_triggers
    UNION ALL
    SELECT 'pg_constraint'::regclass::oid, c.oid
    FROM pg_constraint c JOIN user_triggers t ON t.tgconstraint=c.oid WHERE c.contype='t'
  ),
  dependents(classid, objid, objsubid) AS (
    SELECT 'pg_class'::regclass::oid, root.oid, 0 FROM root WHERE oid IS NOT NULL
    UNION
    SELECT d.classid, d.objid, d.objsubid
    FROM dependents AS parent JOIN pg_depend d
      ON d.refclassid=parent.classid AND d.refobjid=parent.objid
      AND (parent.objsubid=0 OR d.refobjsubid=parent.objsubid)
    WHERE NOT EXISTS (SELECT FROM excluded e WHERE e.classid=d.classid AND e.objid=d.objid AND d.objsubid=0)
  ),
  addresses(classid, objid, objsubid, owned) AS (
    SELECT classid, objid, objsubid, true FROM dependents
    WHERE classid<>'pg_class'::regclass OR objsubid=0
    UNION ALL
    -- These three catalogs store components of relation objects without their
    -- own dependency addresses. Columns include system and dropped rows.
    SELECT 'pg_attribute'::regclass::oid, m.objid, a.attnum, true
    FROM dependents m JOIN pg_attribute a ON a.attrelid=m.objid AND (m.objsubid=0 OR a.attnum=m.objsubid)
    WHERE m.classid='pg_class'::regclass
    UNION ALL
    SELECT 'pg_index'::regclass::oid, m.objid, 0, true FROM dependents m JOIN pg_index i ON i.indexrelid=m.objid
    WHERE m.classid='pg_class'::regclass AND m.objsubid=0
    UNION ALL
    SELECT 'pg_sequence'::regclass::oid, m.objid, 0, true FROM dependents m JOIN pg_sequence s ON s.seqrelid=m.objid
    WHERE m.classid='pg_class'::regclass AND m.objsubid=0
    UNION ALL
    -- Shared column prerequisites contribute definitions without expanding
    -- their unrelated dependents. Built-in types need not have pg_depend rows.
    SELECT 'pg_type'::regclass::oid, a.atttypid, 0, false FROM root r JOIN pg_attribute a ON a.attrelid=r.oid
    WHERE a.atttypid<>0
    UNION ALL
    SELECT 'pg_collation'::regclass::oid, a.attcollation, 0, false FROM root r JOIN pg_attribute a ON a.attrelid=r.oid
    WHERE a.attcollation<>0
  )
  SELECT c.relname AS catalog, c.relnamespace::regnamespace::text AS schema, c.relisshared AS shared,
    a.objid::text AS id, a.objsubid AS subid, bool_or(a.owned) AS owned
  FROM addresses a JOIN pg_class c ON c.oid=a.classid
  GROUP BY c.relname, c.relnamespace, c.relisshared, a.objid, a.objsubid`;

type PreviewAddress = { catalog: string; schema: string; shared: boolean; id: string; subid: number; owned: boolean };
type PreviewCatalogField = { catalog: string; field: string; type: string; target: string | null; array: boolean | null };
type PreviewCatalogRow = { kind: string; name: string; facts: Record<string, unknown> };
// Constraint references use a column ordinal within their named relation.
// OID references use the server's catalog FK descriptors instead of a list of
// fields chosen by the snapshot. A new field without a descriptor stays raw.
const PREVIEW_CATALOG_FIELDS_SQL = `
  SELECT c.relname AS catalog, a.attname AS field, a.atttypid::regtype::text AS type,
    f.pktable::text AS target, f.is_array AS array
  FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
  LEFT JOIN pg_get_catalog_foreign_keys() f ON f.fktable=c.oid AND f.fkcols=ARRAY[a.attname::text] AND f.pkcols=ARRAY['oid']
  WHERE c.relnamespace='pg_catalog'::regnamespace AND c.relname=ANY($1::text[])
  ORDER BY c.relname,a.attnum`;

const previewRole = (id: string) =>
  `CASE WHEN ${id}=0 THEN 'PUBLIC' WHEN a.owned AND ${id}=$2::regrole THEN '<migration owner>' ELSE ${id}::regrole::text END`;
const previewAcl = (value: string) => `CASE WHEN ${value} IS NOT NULL THEN ARRAY(
  SELECT jsonb_build_array(${previewRole("g.grantee")}, ${previewRole("g.grantor")}, g.privilege_type, g.is_grantable) AS entry
  FROM aclexplode(${value}) g ORDER BY entry) END`;

// Only PostgreSQL's generated names are substituted. A changed name remains
// visible. The replacement keeps the object attached to its owning relation.
const previewToastName = (id: string) => `(SELECT storage_owner.oid::regclass::text ||
    CASE WHEN storage_relation.oid=storage_heap.oid THEN ' (TOAST)' ELSE ' (TOAST index)' END
  FROM pg_class storage_relation
  LEFT JOIN pg_index storage_index ON storage_index.indexrelid=storage_relation.oid
  JOIN pg_class storage_heap ON storage_heap.oid=COALESCE(storage_index.indrelid,storage_relation.oid)
  JOIN pg_class storage_owner ON storage_owner.reltoastrelid=storage_heap.oid
  WHERE storage_relation.oid=${id} AND storage_heap.relnamespace='pg_toast'::regnamespace
    AND storage_heap.relname='pg_toast_' || storage_owner.oid
    AND (storage_relation.oid=storage_heap.oid OR
      (storage_relation.relnamespace=storage_heap.relnamespace AND storage_relation.relname=storage_heap.relname || '_index')))`;
const previewRelation = (id: string) => `COALESCE(${previewToastName(id)}, NULLIF(${id},0)::regclass::text)`;
const previewRiName = (id: string) => `(SELECT ri_constraint.conname || '/' || ri_trigger.tgfoid::regprocedure::text
  FROM pg_trigger ri_trigger JOIN pg_constraint ri_constraint ON ri_constraint.oid=ri_trigger.tgconstraint
  WHERE ri_trigger.oid=${id} AND ri_trigger.tgisinternal
    AND ri_trigger.tgname IN ('RI_ConstraintTrigger_c_' || ri_trigger.oid, 'RI_ConstraintTrigger_a_' || ri_trigger.oid))`;
const previewTrigger = (id: string) => `(SELECT COALESCE(${previewRelation("named_trigger.tgrelid")} || '/' || ${previewRiName("named_trigger.oid")},
    (pg_identify_object('pg_trigger'::regclass,named_trigger.oid,0)).identity)
  FROM pg_trigger named_trigger WHERE named_trigger.oid=${id})`;
function previewReference(catalog: string, id: string): string {
  if (catalog === "pg_class") return previewRelation(id);
  if (catalog === "pg_authid") return previewRole(id);
  const casts: Record<string, string> = {
    pg_type: "regtype", pg_collation: "regcollation", pg_proc: "regprocedure", pg_operator: "regoperator", pg_namespace: "regnamespace",
  };
  if (Object.hasOwn(casts, catalog)) return `NULLIF(${id},0)::${casts[catalog]}::text`;
  const identity = catalog === "pg_trigger" ? previewTrigger(id)
    : `(pg_identify_object('${catalog}'::regclass, ${id}, 0)).identity`;
  return `CASE WHEN ${id}<>0 THEN COALESCE(${identity}, ${id}::text) END`;
}

const previewComponentKeys: Record<string, string> = {
  pg_attribute: "x.attrelid=a.id AND x.attnum=a.subid",
  pg_index: "x.indexrelid=a.id",
  pg_sequence: "x.seqrelid=a.id",
};
function previewCatalogQuery(catalog: string, fields: PreviewCatalogField[]): string {
  if (!/^pg_[a-z0-9_]+$/u.test(catalog)) fail(`unsupported preview catalog ${catalog}`);
  const denied = [...PREVIEW_CATALOG_DENY_LIST.row, ...catalog === "pg_class" ? PREVIEW_CATALOG_DENY_LIST.pg_class : []];
  const identities: Record<string, string> = {
    pg_attribute: `${previewRelation("a.id")} || '.' || quote_ident(x.attname)`,
    pg_class: previewRelation("a.id"),
    pg_index: previewRelation("a.id"),
    pg_sequence: previewRelation("a.id"),
  };
  const name = Object.hasOwn(identities, catalog) ? identities[catalog] : previewReference(catalog, "a.id");
  const overlays = fields.flatMap(({ field, type, target, array }) => {
    if (!/^[a-z][a-z0-9_]*$/u.test(field) || target && !/^pg_[a-z0-9_]+$/u.test(target)) fail(`unsupported preview catalog field ${catalog}.${field}`);
    const value = `x.${field}`;
    if (type === "aclitem[]") return [`'${field}', ${previewAcl(value)}`];
    if (!target) return [];
    const converted = array ? `CASE WHEN ${value} IS NOT NULL THEN ARRAY(
      SELECT ${previewReference(target, "item.id")} FROM unnest(${value}) WITH ORDINALITY AS item(id, position) ORDER BY position) END`
      : previewReference(target, `${value}::oid`);
    return [`'${field}', ${converted}`];
  });
  if (catalog === "pg_class") overlays.push(`'relname', COALESCE(${previewToastName("a.id")}, x.relname::text)`);
  if (catalog === "pg_trigger") overlays.push(`'tgname', COALESCE(${previewRiName("a.id")}, x.tgname::text)`);
  // Keep $2 typed even for catalogs with no owner or ACL references.
  return `SELECT '${catalog}' AS kind, ${name} AS name,
    (to_jsonb(x) - ARRAY[${denied.map(key => `'${key}'`).join(", ")}])
    ${overlays.length ? `|| jsonb_build_object(${overlays.join(", ")})` : ""} AS facts
    FROM unnest($1::oid[], $3::integer[], $4::boolean[]) AS a(id, subid, owned)
    JOIN pg_catalog.${catalog} x ON ${previewComponentKeys[catalog] ?? "x.oid=a.id"}
    WHERE $2::text IS NOT NULL`;
}

// Keep the raw node trees so deparsing cannot erase implicit casts or
// collations. Normalize typed references, parser positions and signed bytes.
const PREVIEW_EXPRESSION_DENY_LIST = / :location -?\d+/gu;
const exprReferenceTypes = {
  type: ["array_typeid", "casetype", "consttype", "element_typeid", "funcresulttype", "opresulttype", "paramtype", "resulttype", "vartype"],
  collation: ["array_collid", "casecollid", "collOid", "constcollid", "funccollid", "inputcollid", "opcollid", "paramcollid", "resultcollid", "varcollid"],
  operator: ["opno"],
  function: ["funcid", "hashfuncid", "negfuncid", "opfuncid"],
  relation: ["relid", "resorigtbl"],
  role: ["checkAsUser"],
} as const;
const exprReferences = new Map<string, string>(
  Object.entries(exprReferenceTypes).flatMap(([kind, fields]) => fields.map(field => [field, kind] as const)));
const exprOid = new RegExp(`:(${[...exprReferences.keys()].join("|")}) (\\d+)(?=[ }])`, "gu");
async function readPreviewCatalog(db: PoolClient, owner: string): Promise<PreviewCatalogRow[]> {
  const { rows: addresses } = await db.query<PreviewAddress>(PREVIEW_GRAPH_SQL, [PREVIEW_TABLE]);
  const catalogs = new Map<string, PreviewAddress[]>();
  for (const address of addresses) {
    if (address.schema !== "pg_catalog" || address.shared) fail(`preview dependency uses unsupported catalog ${address.schema}.${address.catalog}`);
    const entries = catalogs.get(address.catalog) ?? [];
    entries.push(address);
    catalogs.set(address.catalog, entries);
  }
  const { rows: fields } = await db.query<PreviewCatalogField>(PREVIEW_CATALOG_FIELDS_SQL, [[...catalogs.keys()]]);
  const rows: PreviewCatalogRow[] = [];
  const expressionFields = new Map<string, string[]>();
  for (const [catalog, entries] of catalogs) {
    const columns = fields.filter(field => field.catalog === catalog);
    expressionFields.set(catalog, columns.filter(field => field.type === "pg_node_tree").map(field => field.field));
    const { rows: objects } = await db.query<PreviewCatalogRow>(previewCatalogQuery(catalog, columns),
      [entries.map(entry => entry.id), owner, entries.map(entry => entry.subid), entries.map(entry => entry.owned)]);
    if (objects.length !== entries.length) fail(`preview dependency snapshot could not resolve every ${catalog} row`);
    rows.push(...objects);
  }
  const expressions = rows.flatMap(({ kind, facts }) => expressionFields.get(kind)!.flatMap(field =>
    typeof facts[field] === "string" ? [{ facts, field, tree: facts[field] }] : []));
  const refs = new Map<string, { kind: string; id: string }>();
  for (const { tree } of expressions) for (const [, field, id] of tree.matchAll(exprOid)) {
    if (id === "0") continue;
    const kind = exprReferences.get(field!)!;
    refs.set(`${kind}:${id}`, { kind, id: id! });
  }
  const ids = [...refs.values()];
  const resolved = await db.query<{ kind: string; id: string; name: string }>(`SELECT kind, id::text,
    CASE kind WHEN 'type' THEN id::regtype::text WHEN 'collation' THEN id::regcollation::text
      WHEN 'operator' THEN id::regoperator::text WHEN 'function' THEN id::regprocedure::text
      WHEN 'relation' THEN id::regclass::text WHEN 'role' THEN id::regrole::text END AS name
    FROM unnest($1::text[], $2::oid[]) AS r(kind, id)`, [ids.map(ref => ref.kind), ids.map(ref => ref.id)]);
  const names = new Map(resolved.rows.map(row => [`${row.kind}:${row.id}`, row.name]));
  for (const { facts, field, tree } of expressions) {
    facts[field] = tree.replace(PREVIEW_EXPRESSION_DENY_LIST, "")
      .replace(/(:constvalue \d+ \[)([^\]]*)(\])/gu, (_whole, start: string, bytes: string, end: string) =>
        start + bytes.replace(/-\d+/gu, byte => String(Number(byte) + 256)) + end)
      .replace(exprOid, (whole, tag: string, id: string) => id === "0" ? whole : `:${tag} ${JSON.stringify(names.get(`${exprReferences.get(tag)}:${id}`))}`);
  }
  return rows;
}

const previewExpectedRows = (kind: string, common: Record<string, unknown>, rows: Record<string, Record<string, unknown>>): PreviewCatalogRow[] =>
  Object.entries(rows).map(([name, facts]) => ({ kind, name, facts: { ...common, ...facts } }));

// Frozen dependency snapshot of the issued preview table. Group equal fields
// for readability without supplying defaults to observed rows.
const PREVIEW_EXPECTED_ROWS: readonly PreviewCatalogRow[] = [
  ...previewExpectedRows("pg_class", {
    "relforcerowsecurity": false,
    "relhasrules": false,
    "relhassubclass": false,
    "relispartition": false,
    "relispopulated": true,
    "relisshared": false,
    "reloftype": null,
    "reloptions": null,
    "relowner": "<migration owner>",
    "relpartbound": null,
    "relpersistence": "p",
    "relrewrite": null,
    "reltablespace": null,
  }, {
    "public.subscription_quote_previews": {"relacl": [["<migration owner>", "<migration owner>", "DELETE", false], ["<migration owner>", "<migration owner>", "INSERT", false], ["<migration owner>", "<migration owner>", "REFERENCES", false], ["<migration owner>", "<migration owner>", "SELECT", false], ["<migration owner>", "<migration owner>", "TRIGGER", false], ["<migration owner>", "<migration owner>", "TRUNCATE", false], ["<migration owner>", "<migration owner>", "UPDATE", false]], "relam": "heap", "relchecks": 3, "relhasindex": true, "relhastriggers": true, "relkind": "r", "relname": "subscription_quote_previews", "relnamespace": "public", "relnatts": 17, "relreplident": "d", "relrowsecurity": true, "reltoastrelid": "public.subscription_quote_previews (TOAST)", "reltype": "public.subscription_quote_previews"},
    "public.subscription_quote_previews (TOAST index)": {"relacl": null, "relam": "btree", "relchecks": 0, "relhasindex": false, "relhastriggers": false, "relkind": "i", "relname": "public.subscription_quote_previews (TOAST index)", "relnamespace": "pg_toast", "relnatts": 2, "relreplident": "n", "relrowsecurity": false, "reltoastrelid": null, "reltype": null},
    "public.subscription_quote_previews (TOAST)": {"relacl": null, "relam": "heap", "relchecks": 0, "relhasindex": true, "relhastriggers": false, "relkind": "t", "relname": "public.subscription_quote_previews (TOAST)", "relnamespace": "pg_toast", "relnatts": 3, "relreplident": "n", "relrowsecurity": false, "reltoastrelid": null, "reltype": null},
    "public.subscription_quote_previews_expiry": {"relacl": null, "relam": "btree", "relchecks": 0, "relhasindex": false, "relhastriggers": false, "relkind": "i", "relname": "subscription_quote_previews_expiry", "relnamespace": "public", "relnatts": 2, "relreplident": "n", "relrowsecurity": false, "reltoastrelid": null, "reltype": null},
    "public.subscription_quote_previews_lookup": {"relacl": null, "relam": "btree", "relchecks": 0, "relhasindex": false, "relhastriggers": false, "relkind": "i", "relname": "subscription_quote_previews_lookup", "relnamespace": "public", "relnatts": 5, "relreplident": "n", "relrowsecurity": false, "reltoastrelid": null, "reltype": null},
    "public.subscription_quote_previews_open": {"relacl": null, "relam": "btree", "relchecks": 0, "relhasindex": false, "relhastriggers": false, "relkind": "i", "relname": "subscription_quote_previews_open", "relnamespace": "public", "relnatts": 5, "relreplident": "n", "relrowsecurity": false, "reltoastrelid": null, "reltype": null},
    "public.subscription_quote_previews_pkey": {"relacl": null, "relam": "btree", "relchecks": 0, "relhasindex": false, "relhastriggers": false, "relkind": "i", "relname": "subscription_quote_previews_pkey", "relnamespace": "public", "relnatts": 1, "relreplident": "n", "relrowsecurity": false, "reltoastrelid": null, "reltype": null},
  }),
  ...previewExpectedRows("pg_attribute", {
    "attacl": null,
    "attcacheoff": -1,
    "attcompression": "",
    "attfdwoptions": null,
    "attgenerated": "",
    "atthasmissing": false,
    "attidentity": "",
    "attinhcount": 0,
    "attisdropped": false,
    "attislocal": true,
    "attmissingval": null,
    "attndims": 0,
    "attoptions": null,
    "atttypmod": -1,
  }, {
    "public.subscription_quote_previews (TOAST index).chunk_id": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "chunk_id", "attnotnull": false, "attnum": 1, "attrelid": "public.subscription_quote_previews (TOAST index)", "attstattarget": -1, "attstorage": "p", "atttypid": "oid"},
    "public.subscription_quote_previews (TOAST index).chunk_seq": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "chunk_seq", "attnotnull": false, "attnum": 2, "attrelid": "public.subscription_quote_previews (TOAST index)", "attstattarget": -1, "attstorage": "p", "atttypid": "integer"},
    "public.subscription_quote_previews (TOAST).chunk_data": {"attalign": "i", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": -1, "attname": "chunk_data", "attnotnull": false, "attnum": 3, "attrelid": "public.subscription_quote_previews (TOAST)", "attstattarget": -1, "attstorage": "p", "atttypid": "bytea"},
    "public.subscription_quote_previews (TOAST).chunk_id": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "chunk_id", "attnotnull": false, "attnum": 1, "attrelid": "public.subscription_quote_previews (TOAST)", "attstattarget": -1, "attstorage": "p", "atttypid": "oid"},
    "public.subscription_quote_previews (TOAST).chunk_seq": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "chunk_seq", "attnotnull": false, "attnum": 2, "attrelid": "public.subscription_quote_previews (TOAST)", "attstattarget": -1, "attstorage": "p", "atttypid": "integer"},
    "public.subscription_quote_previews (TOAST).cmax": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "cmax", "attnotnull": true, "attnum": -5, "attrelid": "public.subscription_quote_previews (TOAST)", "attstattarget": 0, "attstorage": "p", "atttypid": "cid"},
    "public.subscription_quote_previews (TOAST).cmin": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "cmin", "attnotnull": true, "attnum": -3, "attrelid": "public.subscription_quote_previews (TOAST)", "attstattarget": 0, "attstorage": "p", "atttypid": "cid"},
    "public.subscription_quote_previews (TOAST).ctid": {"attalign": "s", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 6, "attname": "ctid", "attnotnull": true, "attnum": -1, "attrelid": "public.subscription_quote_previews (TOAST)", "attstattarget": 0, "attstorage": "p", "atttypid": "tid"},
    "public.subscription_quote_previews (TOAST).tableoid": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "tableoid", "attnotnull": true, "attnum": -6, "attrelid": "public.subscription_quote_previews (TOAST)", "attstattarget": 0, "attstorage": "p", "atttypid": "oid"},
    "public.subscription_quote_previews (TOAST).xmax": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "xmax", "attnotnull": true, "attnum": -4, "attrelid": "public.subscription_quote_previews (TOAST)", "attstattarget": 0, "attstorage": "p", "atttypid": "xid"},
    "public.subscription_quote_previews (TOAST).xmin": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "xmin", "attnotnull": true, "attnum": -2, "attrelid": "public.subscription_quote_previews (TOAST)", "attstattarget": 0, "attstorage": "p", "atttypid": "xid"},
    "public.subscription_quote_previews.accepted_at": {"attalign": "d", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 8, "attname": "accepted_at", "attnotnull": false, "attnum": 13, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "timestamp with time zone"},
    "public.subscription_quote_previews.accepted_event_id": {"attalign": "c", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 16, "attname": "accepted_event_id", "attnotnull": false, "attnum": 15, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "uuid"},
    "public.subscription_quote_previews.accepted_idempotency_key": {"attalign": "i", "attbyval": false, "attcollation": "\"default\"", "atthasdef": false, "attlen": -1, "attname": "accepted_idempotency_key", "attnotnull": false, "attnum": 14, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "x", "atttypid": "text"},
    "public.subscription_quote_previews.action": {"attalign": "i", "attbyval": false, "attcollation": "\"default\"", "atthasdef": false, "attlen": -1, "attname": "action", "attnotnull": true, "attnum": 5, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "x", "atttypid": "text"},
    "public.subscription_quote_previews.actor_id": {"attalign": "c", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 16, "attname": "actor_id", "attnotnull": true, "attnum": 4, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "uuid"},
    "public.subscription_quote_previews.client_id": {"attalign": "c", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 16, "attname": "client_id", "attnotnull": true, "attnum": 3, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "uuid"},
    "public.subscription_quote_previews.cmax": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "cmax", "attnotnull": true, "attnum": -5, "attrelid": "public.subscription_quote_previews", "attstattarget": 0, "attstorage": "p", "atttypid": "cid"},
    "public.subscription_quote_previews.cmin": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "cmin", "attnotnull": true, "attnum": -3, "attrelid": "public.subscription_quote_previews", "attstattarget": 0, "attstorage": "p", "atttypid": "cid"},
    "public.subscription_quote_previews.created_at": {"attalign": "d", "attbyval": true, "attcollation": null, "atthasdef": true, "attlen": 8, "attname": "created_at", "attnotnull": true, "attnum": 16, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "timestamp with time zone"},
    "public.subscription_quote_previews.ctid": {"attalign": "s", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 6, "attname": "ctid", "attnotnull": true, "attnum": -1, "attrelid": "public.subscription_quote_previews", "attstattarget": 0, "attstorage": "p", "atttypid": "tid"},
    "public.subscription_quote_previews.expires_at": {"attalign": "d", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 8, "attname": "expires_at", "attnotnull": true, "attnum": 8, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "timestamp with time zone"},
    "public.subscription_quote_previews.id": {"attalign": "c", "attbyval": false, "attcollation": null, "atthasdef": true, "attlen": 16, "attname": "id", "attnotnull": true, "attnum": 1, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "uuid"},
    "public.subscription_quote_previews.quote_hash": {"attalign": "i", "attbyval": false, "attcollation": "\"default\"", "atthasdef": false, "attlen": -1, "attname": "quote_hash", "attnotnull": true, "attnum": 6, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "x", "atttypid": "text"},
    "public.subscription_quote_previews.quote_snapshot": {"attalign": "i", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": -1, "attname": "quote_snapshot", "attnotnull": true, "attnum": 11, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "x", "atttypid": "jsonb"},
    "public.subscription_quote_previews.request_payload": {"attalign": "i", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": -1, "attname": "request_payload", "attnotnull": true, "attnum": 10, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "x", "atttypid": "jsonb"},
    "public.subscription_quote_previews.status": {"attalign": "i", "attbyval": false, "attcollation": "\"default\"", "atthasdef": true, "attlen": -1, "attname": "status", "attnotnull": true, "attnum": 9, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "x", "atttypid": "text"},
    "public.subscription_quote_previews.subscription_id": {"attalign": "c", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 16, "attname": "subscription_id", "attnotnull": true, "attnum": 2, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "uuid"},
    "public.subscription_quote_previews.tableoid": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "tableoid", "attnotnull": true, "attnum": -6, "attrelid": "public.subscription_quote_previews", "attstattarget": 0, "attstorage": "p", "atttypid": "oid"},
    "public.subscription_quote_previews.template_version": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "template_version", "attnotnull": true, "attnum": 7, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "integer"},
    "public.subscription_quote_previews.totals": {"attalign": "i", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": -1, "attname": "totals", "attnotnull": true, "attnum": 12, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "x", "atttypid": "jsonb"},
    "public.subscription_quote_previews.updated_at": {"attalign": "d", "attbyval": true, "attcollation": null, "atthasdef": true, "attlen": 8, "attname": "updated_at", "attnotnull": true, "attnum": 17, "attrelid": "public.subscription_quote_previews", "attstattarget": -1, "attstorage": "p", "atttypid": "timestamp with time zone"},
    "public.subscription_quote_previews.xmax": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "xmax", "attnotnull": true, "attnum": -4, "attrelid": "public.subscription_quote_previews", "attstattarget": 0, "attstorage": "p", "atttypid": "xid"},
    "public.subscription_quote_previews.xmin": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "xmin", "attnotnull": true, "attnum": -2, "attrelid": "public.subscription_quote_previews", "attstattarget": 0, "attstorage": "p", "atttypid": "xid"},
    "public.subscription_quote_previews_expiry.expires_at": {"attalign": "d", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 8, "attname": "expires_at", "attnotnull": false, "attnum": 2, "attrelid": "public.subscription_quote_previews_expiry", "attstattarget": -1, "attstorage": "p", "atttypid": "timestamp with time zone"},
    "public.subscription_quote_previews_expiry.status": {"attalign": "i", "attbyval": false, "attcollation": "\"default\"", "atthasdef": false, "attlen": -1, "attname": "status", "attnotnull": false, "attnum": 1, "attrelid": "public.subscription_quote_previews_expiry", "attstattarget": -1, "attstorage": "x", "atttypid": "text"},
    "public.subscription_quote_previews_lookup.action": {"attalign": "i", "attbyval": false, "attcollation": "\"default\"", "atthasdef": false, "attlen": -1, "attname": "action", "attnotnull": false, "attnum": 2, "attrelid": "public.subscription_quote_previews_lookup", "attstattarget": -1, "attstorage": "x", "atttypid": "text"},
    "public.subscription_quote_previews_lookup.created_at": {"attalign": "d", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 8, "attname": "created_at", "attnotnull": false, "attnum": 5, "attrelid": "public.subscription_quote_previews_lookup", "attstattarget": -1, "attstorage": "p", "atttypid": "timestamp with time zone"},
    "public.subscription_quote_previews_lookup.quote_hash": {"attalign": "i", "attbyval": false, "attcollation": "\"default\"", "atthasdef": false, "attlen": -1, "attname": "quote_hash", "attnotnull": false, "attnum": 3, "attrelid": "public.subscription_quote_previews_lookup", "attstattarget": -1, "attstorage": "x", "atttypid": "text"},
    "public.subscription_quote_previews_lookup.subscription_id": {"attalign": "c", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 16, "attname": "subscription_id", "attnotnull": false, "attnum": 1, "attrelid": "public.subscription_quote_previews_lookup", "attstattarget": -1, "attstorage": "p", "atttypid": "uuid"},
    "public.subscription_quote_previews_lookup.template_version": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "template_version", "attnotnull": false, "attnum": 4, "attrelid": "public.subscription_quote_previews_lookup", "attstattarget": -1, "attstorage": "p", "atttypid": "integer"},
    "public.subscription_quote_previews_open.action": {"attalign": "i", "attbyval": false, "attcollation": "\"default\"", "atthasdef": false, "attlen": -1, "attname": "action", "attnotnull": false, "attnum": 3, "attrelid": "public.subscription_quote_previews_open", "attstattarget": -1, "attstorage": "x", "atttypid": "text"},
    "public.subscription_quote_previews_open.client_id": {"attalign": "c", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 16, "attname": "client_id", "attnotnull": false, "attnum": 2, "attrelid": "public.subscription_quote_previews_open", "attstattarget": -1, "attstorage": "p", "atttypid": "uuid"},
    "public.subscription_quote_previews_open.quote_hash": {"attalign": "i", "attbyval": false, "attcollation": "\"default\"", "atthasdef": false, "attlen": -1, "attname": "quote_hash", "attnotnull": false, "attnum": 4, "attrelid": "public.subscription_quote_previews_open", "attstattarget": -1, "attstorage": "x", "atttypid": "text"},
    "public.subscription_quote_previews_open.subscription_id": {"attalign": "c", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 16, "attname": "subscription_id", "attnotnull": false, "attnum": 1, "attrelid": "public.subscription_quote_previews_open", "attstattarget": -1, "attstorage": "p", "atttypid": "uuid"},
    "public.subscription_quote_previews_open.template_version": {"attalign": "i", "attbyval": true, "attcollation": null, "atthasdef": false, "attlen": 4, "attname": "template_version", "attnotnull": false, "attnum": 5, "attrelid": "public.subscription_quote_previews_open", "attstattarget": -1, "attstorage": "p", "atttypid": "integer"},
    "public.subscription_quote_previews_pkey.id": {"attalign": "c", "attbyval": false, "attcollation": null, "atthasdef": false, "attlen": 16, "attname": "id", "attnotnull": false, "attnum": 1, "attrelid": "public.subscription_quote_previews_pkey", "attstattarget": -1, "attstorage": "p", "atttypid": "uuid"},
  }),
  ...previewExpectedRows("pg_attrdef", {
    "adrelid": "public.subscription_quote_previews",
  }, {
    "for public.subscription_quote_previews.created_at": {"adbin": "{FUNCEXPR :funcid \"now()\" :funcresulttype \"timestamp with time zone\" :funcretset false :funcvariadic false :funcformat 0 :funccollid 0 :inputcollid 0 :args <>}", "adnum": 16},
    "for public.subscription_quote_previews.id": {"adbin": "{FUNCEXPR :funcid \"gen_random_uuid()\" :funcresulttype \"uuid\" :funcretset false :funcvariadic false :funcformat 0 :funccollid 0 :inputcollid 0 :args <>}", "adnum": 1},
    "for public.subscription_quote_previews.status": {"adbin": "{CONST :consttype \"text\" :consttypmod -1 :constcollid \"\\\"default\\\"\" :constlen -1 :constbyval false :constisnull false :constvalue 13 [ 52 0 0 0 112 114 101 118 105 101 119 101 100 ]}", "adnum": 9},
    "for public.subscription_quote_previews.updated_at": {"adbin": "{FUNCEXPR :funcid \"now()\" :funcresulttype \"timestamp with time zone\" :funcretset false :funcvariadic false :funcformat 0 :funccollid 0 :inputcollid 0 :args <>}", "adnum": 17},
  }),
  ...previewExpectedRows("pg_constraint", {
    "condeferrable": false,
    "condeferred": false,
    "conexclop": null,
    "confdelsetcols": null,
    "coninhcount": 0,
    "conislocal": true,
    "connamespace": "public",
    "conparentid": null,
    "conrelid": "public.subscription_quote_previews",
    "contypid": null,
    "convalidated": true,
  }, {
    "subscription_quote_previews_acceptance_check on public.subscription_quote_previews": {"conbin": "{BOOLEXPR :boolop or :args ({BOOLEXPR :boolop and :args ({OPEXPR :opno \"=(text,text)\" :opfuncid \"texteq(text,text)\" :opresulttype \"boolean\" :opretset false :opcollid 0 :inputcollid \"\\\"default\\\"\" :args ({VAR :varno 1 :varattno 9 :vartype \"text\" :vartypmod -1 :varcollid \"\\\"default\\\"\" :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 9} {CONST :consttype \"text\" :consttypmod -1 :constcollid \"\\\"default\\\"\" :constlen -1 :constbyval false :constisnull false :constvalue 13 [ 52 0 0 0 112 114 101 118 105 101 119 101 100 ]})} {NULLTEST :arg {VAR :varno 1 :varattno 13 :vartype \"timestamp with time zone\" :vartypmod -1 :varcollid 0 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 13} :nulltesttype 0 :argisrow false} {NULLTEST :arg {VAR :varno 1 :varattno 14 :vartype \"text\" :vartypmod -1 :varcollid \"\\\"default\\\"\" :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 14} :nulltesttype 0 :argisrow false} {NULLTEST :arg {VAR :varno 1 :varattno 15 :vartype \"uuid\" :vartypmod -1 :varcollid 0 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 15} :nulltesttype 0 :argisrow false})} {BOOLEXPR :boolop and :args ({OPEXPR :opno \"=(text,text)\" :opfuncid \"texteq(text,text)\" :opresulttype \"boolean\" :opretset false :opcollid 0 :inputcollid \"\\\"default\\\"\" :args ({VAR :varno 1 :varattno 9 :vartype \"text\" :vartypmod -1 :varcollid \"\\\"default\\\"\" :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 9} {CONST :consttype \"text\" :consttypmod -1 :constcollid \"\\\"default\\\"\" :constlen -1 :constbyval false :constisnull false :constvalue 12 [ 48 0 0 0 97 99 99 101 112 116 101 100 ]})} {NULLTEST :arg {VAR :varno 1 :varattno 13 :vartype \"timestamp with time zone\" :vartypmod -1 :varcollid 0 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 13} :nulltesttype 1 :argisrow false} {NULLTEST :arg {VAR :varno 1 :varattno 14 :vartype \"text\" :vartypmod -1 :varcollid \"\\\"default\\\"\" :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 14} :nulltesttype 1 :argisrow false} {NULLTEST :arg {VAR :varno 1 :varattno 15 :vartype \"uuid\" :vartypmod -1 :varcollid 0 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 15} :nulltesttype 1 :argisrow false})})}", "confdeltype": " ", "conffeqop": null, "confkey": null, "confmatchtype": " ", "confrelid": null, "confupdtype": " ", "conindid": null, "conkey": [9, 13, 14, 15], "conname": "subscription_quote_previews_acceptance_check", "connoinherit": false, "conpfeqop": null, "conppeqop": null, "contype": "c"},
    "subscription_quote_previews_accepted_event_id_fkey on public.subscription_quote_previews": {"conbin": null, "confdeltype": "a", "conffeqop": ["=(uuid,uuid)"], "confkey": [1], "confmatchtype": "s", "confrelid": "public.subscription_events", "confupdtype": "a", "conindid": "public.subscription_events_pkey", "conkey": [15], "conname": "subscription_quote_previews_accepted_event_id_fkey", "connoinherit": true, "conpfeqop": ["=(uuid,uuid)"], "conppeqop": ["=(uuid,uuid)"], "contype": "f"},
    "subscription_quote_previews_client_id_fkey on public.subscription_quote_previews": {"conbin": null, "confdeltype": "a", "conffeqop": ["=(uuid,uuid)"], "confkey": [1], "confmatchtype": "s", "confrelid": "public.clients", "confupdtype": "a", "conindid": "public.clients_pkey", "conkey": [3], "conname": "subscription_quote_previews_client_id_fkey", "connoinherit": true, "conpfeqop": ["=(uuid,uuid)"], "conppeqop": ["=(uuid,uuid)"], "contype": "f"},
    "subscription_quote_previews_pkey on public.subscription_quote_previews": {"conbin": null, "confdeltype": " ", "conffeqop": null, "confkey": null, "confmatchtype": " ", "confrelid": null, "confupdtype": " ", "conindid": "public.subscription_quote_previews_pkey", "conkey": [1], "conname": "subscription_quote_previews_pkey", "connoinherit": true, "conpfeqop": null, "conppeqop": null, "contype": "p"},
    "subscription_quote_previews_quote_hash_check on public.subscription_quote_previews": {"conbin": "{OPEXPR :opno \"=(integer,integer)\" :opfuncid \"int4eq(integer,integer)\" :opresulttype \"boolean\" :opretset false :opcollid 0 :inputcollid 0 :args ({FUNCEXPR :funcid \"char_length(text)\" :funcresulttype \"integer\" :funcretset false :funcvariadic false :funcformat 0 :funccollid 0 :inputcollid \"\\\"default\\\"\" :args ({VAR :varno 1 :varattno 6 :vartype \"text\" :vartypmod -1 :varcollid \"\\\"default\\\"\" :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 6})} {CONST :consttype \"integer\" :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :constvalue 4 [ 64 0 0 0 0 0 0 0 ]})}", "confdeltype": " ", "conffeqop": null, "confkey": null, "confmatchtype": " ", "confrelid": null, "confupdtype": " ", "conindid": null, "conkey": [6], "conname": "subscription_quote_previews_quote_hash_check", "connoinherit": false, "conpfeqop": null, "conppeqop": null, "contype": "c"},
    "subscription_quote_previews_status_check on public.subscription_quote_previews": {"conbin": "{SCALARARRAYOPEXPR :opno \"=(text,text)\" :opfuncid \"texteq(text,text)\" :hashfuncid 0 :negfuncid 0 :useOr true :inputcollid \"\\\"default\\\"\" :args ({VAR :varno 1 :varattno 9 :vartype \"text\" :vartypmod -1 :varcollid \"\\\"default\\\"\" :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 9} {ARRAYEXPR :array_typeid \"text[]\" :array_collid \"\\\"default\\\"\" :element_typeid \"text\" :elements ({CONST :consttype \"text\" :consttypmod -1 :constcollid \"\\\"default\\\"\" :constlen -1 :constbyval false :constisnull false :constvalue 13 [ 52 0 0 0 112 114 101 118 105 101 119 101 100 ]} {CONST :consttype \"text\" :consttypmod -1 :constcollid \"\\\"default\\\"\" :constlen -1 :constbyval false :constisnull false :constvalue 12 [ 48 0 0 0 97 99 99 101 112 116 101 100 ]}) :multidims false})}", "confdeltype": " ", "conffeqop": null, "confkey": null, "confmatchtype": " ", "confrelid": null, "confupdtype": " ", "conindid": null, "conkey": [9], "conname": "subscription_quote_previews_status_check", "connoinherit": false, "conpfeqop": null, "conppeqop": null, "contype": "c"},
    "subscription_quote_previews_subscription_id_fkey on public.subscription_quote_previews": {"conbin": null, "confdeltype": "a", "conffeqop": ["=(uuid,uuid)"], "confkey": [1], "confmatchtype": "s", "confrelid": "public.subscriptions", "confupdtype": "a", "conindid": "public.subscriptions_pkey", "conkey": [2], "conname": "subscription_quote_previews_subscription_id_fkey", "connoinherit": true, "conpfeqop": ["=(uuid,uuid)"], "conppeqop": ["=(uuid,uuid)"], "contype": "f"},
  }),
  ...previewExpectedRows("pg_index", {
    "indcheckxmin": false,
    "indexprs": null,
    "indimmediate": true,
    "indisclustered": false,
    "indisexclusion": false,
    "indislive": true,
    "indisready": true,
    "indisreplident": false,
    "indisvalid": true,
    "indnullsnotdistinct": false,
  }, {
    "public.subscription_quote_previews (TOAST index)": {"indclass": ["pg_catalog.oid_ops USING btree", "pg_catalog.int4_ops USING btree"], "indcollation": [null, null], "indexrelid": "public.subscription_quote_previews (TOAST index)", "indisprimary": true, "indisunique": true, "indkey": [1, 2], "indnatts": 2, "indnkeyatts": 2, "indoption": [0, 0], "indpred": null, "indrelid": "public.subscription_quote_previews (TOAST)"},
    "public.subscription_quote_previews_expiry": {"indclass": ["pg_catalog.text_ops USING btree", "pg_catalog.timestamptz_ops USING btree"], "indcollation": ["\"default\"", null], "indexrelid": "public.subscription_quote_previews_expiry", "indisprimary": false, "indisunique": false, "indkey": [9, 8], "indnatts": 2, "indnkeyatts": 2, "indoption": [0, 0], "indpred": null, "indrelid": "public.subscription_quote_previews"},
    "public.subscription_quote_previews_lookup": {"indclass": ["pg_catalog.uuid_ops USING btree", "pg_catalog.text_ops USING btree", "pg_catalog.text_ops USING btree", "pg_catalog.int4_ops USING btree", "pg_catalog.timestamptz_ops USING btree"], "indcollation": [null, "\"default\"", "\"default\"", null, null], "indexrelid": "public.subscription_quote_previews_lookup", "indisprimary": false, "indisunique": false, "indkey": [2, 5, 6, 7, 16], "indnatts": 5, "indnkeyatts": 5, "indoption": [0, 0, 0, 0, 3], "indpred": null, "indrelid": "public.subscription_quote_previews"},
    "public.subscription_quote_previews_open": {"indclass": ["pg_catalog.uuid_ops USING btree", "pg_catalog.uuid_ops USING btree", "pg_catalog.text_ops USING btree", "pg_catalog.text_ops USING btree", "pg_catalog.int4_ops USING btree"], "indcollation": [null, null, "\"default\"", "\"default\"", null], "indexrelid": "public.subscription_quote_previews_open", "indisprimary": false, "indisunique": true, "indkey": [2, 3, 5, 6, 7], "indnatts": 5, "indnkeyatts": 5, "indoption": [0, 0, 0, 0, 0], "indpred": "{OPEXPR :opno \"=(text,text)\" :opfuncid \"texteq(text,text)\" :opresulttype \"boolean\" :opretset false :opcollid 0 :inputcollid \"\\\"default\\\"\" :args ({VAR :varno 1 :varattno 9 :vartype \"text\" :vartypmod -1 :varcollid \"\\\"default\\\"\" :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 9} {CONST :consttype \"text\" :consttypmod -1 :constcollid \"\\\"default\\\"\" :constlen -1 :constbyval false :constisnull false :constvalue 13 [ 52 0 0 0 112 114 101 118 105 101 119 101 100 ]})}", "indrelid": "public.subscription_quote_previews"},
    "public.subscription_quote_previews_pkey": {"indclass": ["pg_catalog.uuid_ops USING btree"], "indcollation": [null], "indexrelid": "public.subscription_quote_previews_pkey", "indisprimary": true, "indisunique": true, "indkey": [1], "indnatts": 1, "indnkeyatts": 1, "indoption": [0], "indpred": null, "indrelid": "public.subscription_quote_previews"},
  }),
  ...previewExpectedRows("pg_trigger", {
    "tgargs": "\\x",
    "tgattr": [],
    "tgdeferrable": false,
    "tgenabled": "O",
    "tginitdeferred": false,
    "tgisinternal": true,
    "tgnargs": 0,
    "tgnewtable": null,
    "tgoldtable": null,
    "tgparentid": null,
    "tgqual": null,
  }, {
    "public.clients/subscription_quote_previews_client_id_fkey/\"RI_FKey_noaction_del\"()": {"tgconstraint": "subscription_quote_previews_client_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.clients_pkey", "tgconstrrelid": "public.subscription_quote_previews", "tgfoid": "\"RI_FKey_noaction_del\"()", "tgname": "subscription_quote_previews_client_id_fkey/\"RI_FKey_noaction_del\"()", "tgrelid": "public.clients", "tgtype": 9},
    "public.clients/subscription_quote_previews_client_id_fkey/\"RI_FKey_noaction_upd\"()": {"tgconstraint": "subscription_quote_previews_client_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.clients_pkey", "tgconstrrelid": "public.subscription_quote_previews", "tgfoid": "\"RI_FKey_noaction_upd\"()", "tgname": "subscription_quote_previews_client_id_fkey/\"RI_FKey_noaction_upd\"()", "tgrelid": "public.clients", "tgtype": 17},
    "public.subscription_events/subscription_quote_previews_accepted_event_id_fkey/\"RI_FKey_noaction_del\"()": {"tgconstraint": "subscription_quote_previews_accepted_event_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.subscription_events_pkey", "tgconstrrelid": "public.subscription_quote_previews", "tgfoid": "\"RI_FKey_noaction_del\"()", "tgname": "subscription_quote_previews_accepted_event_id_fkey/\"RI_FKey_noaction_del\"()", "tgrelid": "public.subscription_events", "tgtype": 9},
    "public.subscription_events/subscription_quote_previews_accepted_event_id_fkey/\"RI_FKey_noaction_upd\"()": {"tgconstraint": "subscription_quote_previews_accepted_event_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.subscription_events_pkey", "tgconstrrelid": "public.subscription_quote_previews", "tgfoid": "\"RI_FKey_noaction_upd\"()", "tgname": "subscription_quote_previews_accepted_event_id_fkey/\"RI_FKey_noaction_upd\"()", "tgrelid": "public.subscription_events", "tgtype": 17},
    "public.subscription_quote_previews/subscription_quote_previews_accepted_event_id_fkey/\"RI_FKey_check_ins\"()": {"tgconstraint": "subscription_quote_previews_accepted_event_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.subscription_events_pkey", "tgconstrrelid": "public.subscription_events", "tgfoid": "\"RI_FKey_check_ins\"()", "tgname": "subscription_quote_previews_accepted_event_id_fkey/\"RI_FKey_check_ins\"()", "tgrelid": "public.subscription_quote_previews", "tgtype": 5},
    "public.subscription_quote_previews/subscription_quote_previews_accepted_event_id_fkey/\"RI_FKey_check_upd\"()": {"tgconstraint": "subscription_quote_previews_accepted_event_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.subscription_events_pkey", "tgconstrrelid": "public.subscription_events", "tgfoid": "\"RI_FKey_check_upd\"()", "tgname": "subscription_quote_previews_accepted_event_id_fkey/\"RI_FKey_check_upd\"()", "tgrelid": "public.subscription_quote_previews", "tgtype": 17},
    "public.subscription_quote_previews/subscription_quote_previews_client_id_fkey/\"RI_FKey_check_ins\"()": {"tgconstraint": "subscription_quote_previews_client_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.clients_pkey", "tgconstrrelid": "public.clients", "tgfoid": "\"RI_FKey_check_ins\"()", "tgname": "subscription_quote_previews_client_id_fkey/\"RI_FKey_check_ins\"()", "tgrelid": "public.subscription_quote_previews", "tgtype": 5},
    "public.subscription_quote_previews/subscription_quote_previews_client_id_fkey/\"RI_FKey_check_upd\"()": {"tgconstraint": "subscription_quote_previews_client_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.clients_pkey", "tgconstrrelid": "public.clients", "tgfoid": "\"RI_FKey_check_upd\"()", "tgname": "subscription_quote_previews_client_id_fkey/\"RI_FKey_check_upd\"()", "tgrelid": "public.subscription_quote_previews", "tgtype": 17},
    "public.subscription_quote_previews/subscription_quote_previews_subscription_id_fkey/\"RI_FKey_check_ins\"()": {"tgconstraint": "subscription_quote_previews_subscription_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.subscriptions_pkey", "tgconstrrelid": "public.subscriptions", "tgfoid": "\"RI_FKey_check_ins\"()", "tgname": "subscription_quote_previews_subscription_id_fkey/\"RI_FKey_check_ins\"()", "tgrelid": "public.subscription_quote_previews", "tgtype": 5},
    "public.subscription_quote_previews/subscription_quote_previews_subscription_id_fkey/\"RI_FKey_check_upd\"()": {"tgconstraint": "subscription_quote_previews_subscription_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.subscriptions_pkey", "tgconstrrelid": "public.subscriptions", "tgfoid": "\"RI_FKey_check_upd\"()", "tgname": "subscription_quote_previews_subscription_id_fkey/\"RI_FKey_check_upd\"()", "tgrelid": "public.subscription_quote_previews", "tgtype": 17},
    "public.subscriptions/subscription_quote_previews_subscription_id_fkey/\"RI_FKey_noaction_del\"()": {"tgconstraint": "subscription_quote_previews_subscription_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.subscriptions_pkey", "tgconstrrelid": "public.subscription_quote_previews", "tgfoid": "\"RI_FKey_noaction_del\"()", "tgname": "subscription_quote_previews_subscription_id_fkey/\"RI_FKey_noaction_del\"()", "tgrelid": "public.subscriptions", "tgtype": 9},
    "public.subscriptions/subscription_quote_previews_subscription_id_fkey/\"RI_FKey_noaction_upd\"()": {"tgconstraint": "subscription_quote_previews_subscription_id_fkey on public.subscription_quote_previews", "tgconstrindid": "public.subscriptions_pkey", "tgconstrrelid": "public.subscription_quote_previews", "tgfoid": "\"RI_FKey_noaction_upd\"()", "tgname": "subscription_quote_previews_subscription_id_fkey/\"RI_FKey_noaction_upd\"()", "tgrelid": "public.subscriptions", "tgtype": 17},
  }),
  ...previewExpectedRows("pg_type", {
    "typacl": null,
    "typbasetype": null,
    "typdefault": null,
    "typdefaultbin": null,
    "typdelim": ",",
    "typisdefined": true,
    "typndims": 0,
    "typnotnull": false,
    "typtypmod": -1,
  }, {
    "cid": {"typalign": "i", "typanalyze": null, "typarray": "cid[]", "typbyval": true, "typcategory": "U", "typcollation": null, "typelem": null, "typinput": "cidin(cstring)", "typispreferred": false, "typlen": 4, "typmodin": null, "typmodout": null, "typname": "cid", "typnamespace": "pg_catalog", "typoutput": "cidout(cid)", "typowner": "postgres", "typreceive": "cidrecv(internal)", "typrelid": null, "typsend": "cidsend(cid)", "typstorage": "p", "typsubscript": null, "typtype": "b"},
    "integer": {"typalign": "i", "typanalyze": null, "typarray": "integer[]", "typbyval": true, "typcategory": "N", "typcollation": null, "typelem": null, "typinput": "int4in(cstring)", "typispreferred": false, "typlen": 4, "typmodin": null, "typmodout": null, "typname": "int4", "typnamespace": "pg_catalog", "typoutput": "int4out(integer)", "typowner": "postgres", "typreceive": "int4recv(internal)", "typrelid": null, "typsend": "int4send(integer)", "typstorage": "p", "typsubscript": null, "typtype": "b"},
    "jsonb": {"typalign": "i", "typanalyze": null, "typarray": "jsonb[]", "typbyval": false, "typcategory": "U", "typcollation": null, "typelem": null, "typinput": "jsonb_in(cstring)", "typispreferred": false, "typlen": -1, "typmodin": null, "typmodout": null, "typname": "jsonb", "typnamespace": "pg_catalog", "typoutput": "jsonb_out(jsonb)", "typowner": "postgres", "typreceive": "jsonb_recv(internal)", "typrelid": null, "typsend": "jsonb_send(jsonb)", "typstorage": "x", "typsubscript": "jsonb_subscript_handler(internal)", "typtype": "b"},
    "oid": {"typalign": "i", "typanalyze": null, "typarray": "oid[]", "typbyval": true, "typcategory": "N", "typcollation": null, "typelem": null, "typinput": "oidin(cstring)", "typispreferred": true, "typlen": 4, "typmodin": null, "typmodout": null, "typname": "oid", "typnamespace": "pg_catalog", "typoutput": "oidout(oid)", "typowner": "postgres", "typreceive": "oidrecv(internal)", "typrelid": null, "typsend": "oidsend(oid)", "typstorage": "p", "typsubscript": null, "typtype": "b"},
    "public.subscription_quote_previews": {"typalign": "d", "typanalyze": null, "typarray": "public.subscription_quote_previews[]", "typbyval": false, "typcategory": "C", "typcollation": null, "typelem": null, "typinput": "record_in(cstring,oid,integer)", "typispreferred": false, "typlen": -1, "typmodin": null, "typmodout": null, "typname": "subscription_quote_previews", "typnamespace": "public", "typoutput": "record_out(record)", "typowner": "<migration owner>", "typreceive": "record_recv(internal,oid,integer)", "typrelid": "public.subscription_quote_previews", "typsend": "record_send(record)", "typstorage": "x", "typsubscript": null, "typtype": "c"},
    "public.subscription_quote_previews[]": {"typalign": "d", "typanalyze": "array_typanalyze(internal)", "typarray": null, "typbyval": false, "typcategory": "A", "typcollation": null, "typelem": "public.subscription_quote_previews", "typinput": "array_in(cstring,oid,integer)", "typispreferred": false, "typlen": -1, "typmodin": null, "typmodout": null, "typname": "_subscription_quote_previews", "typnamespace": "public", "typoutput": "array_out(anyarray)", "typowner": "<migration owner>", "typreceive": "array_recv(internal,oid,integer)", "typrelid": null, "typsend": "array_send(anyarray)", "typstorage": "x", "typsubscript": "array_subscript_handler(internal)", "typtype": "b"},
    "text": {"typalign": "i", "typanalyze": null, "typarray": "text[]", "typbyval": false, "typcategory": "S", "typcollation": "\"default\"", "typelem": null, "typinput": "textin(cstring)", "typispreferred": true, "typlen": -1, "typmodin": null, "typmodout": null, "typname": "text", "typnamespace": "pg_catalog", "typoutput": "textout(text)", "typowner": "postgres", "typreceive": "textrecv(internal)", "typrelid": null, "typsend": "textsend(text)", "typstorage": "x", "typsubscript": null, "typtype": "b"},
    "tid": {"typalign": "s", "typanalyze": null, "typarray": "tid[]", "typbyval": false, "typcategory": "U", "typcollation": null, "typelem": null, "typinput": "tidin(cstring)", "typispreferred": false, "typlen": 6, "typmodin": null, "typmodout": null, "typname": "tid", "typnamespace": "pg_catalog", "typoutput": "tidout(tid)", "typowner": "postgres", "typreceive": "tidrecv(internal)", "typrelid": null, "typsend": "tidsend(tid)", "typstorage": "p", "typsubscript": null, "typtype": "b"},
    "timestamp with time zone": {"typalign": "d", "typanalyze": null, "typarray": "timestamp with time zone[]", "typbyval": true, "typcategory": "D", "typcollation": null, "typelem": null, "typinput": "timestamptz_in(cstring,oid,integer)", "typispreferred": true, "typlen": 8, "typmodin": "timestamptztypmodin(cstring[])", "typmodout": "timestamptztypmodout(integer)", "typname": "timestamptz", "typnamespace": "pg_catalog", "typoutput": "timestamptz_out(timestamp with time zone)", "typowner": "postgres", "typreceive": "timestamptz_recv(internal,oid,integer)", "typrelid": null, "typsend": "timestamptz_send(timestamp with time zone)", "typstorage": "p", "typsubscript": null, "typtype": "b"},
    "uuid": {"typalign": "c", "typanalyze": null, "typarray": "uuid[]", "typbyval": false, "typcategory": "U", "typcollation": null, "typelem": null, "typinput": "uuid_in(cstring)", "typispreferred": false, "typlen": 16, "typmodin": null, "typmodout": null, "typname": "uuid", "typnamespace": "pg_catalog", "typoutput": "uuid_out(uuid)", "typowner": "postgres", "typreceive": "uuid_recv(internal)", "typrelid": null, "typsend": "uuid_send(uuid)", "typstorage": "p", "typsubscript": null, "typtype": "b"},
    "xid": {"typalign": "i", "typanalyze": null, "typarray": "xid[]", "typbyval": true, "typcategory": "U", "typcollation": null, "typelem": null, "typinput": "xidin(cstring)", "typispreferred": false, "typlen": 4, "typmodin": null, "typmodout": null, "typname": "xid", "typnamespace": "pg_catalog", "typoutput": "xidout(xid)", "typowner": "postgres", "typreceive": "xidrecv(internal)", "typrelid": null, "typsend": "xidsend(xid)", "typstorage": "p", "typsubscript": null, "typtype": "b"},
  }),
  { kind: "pg_collation", name: "\"default\"", facts: {
    "collcollate": null,
    "collctype": null,
    "collencoding": -1,
    "colliculocale": null,
    "collicurules": null,
    "collisdeterministic": true,
    "collname": "default",
    "collnamespace": "pg_catalog",
    "collowner": "postgres",
    "collprovider": "d",
    "collversion": null,
  } },
];

export async function assertPreviewAcceptancePreimage(db: PoolClient, owner: string): Promise<void> {
  const { searchPath } = (await db.query<{ searchPath: string }>(
    `SELECT pg_catalog.current_setting('search_path') AS "searchPath"`)).rows[0]!;
  const rows = await pinned(db, () => readPreviewCatalog(db, owner));
  await db.query("SELECT pg_catalog.set_config('search_path', $1, false)", [searchPath]);
  const keyFor = ({ kind, name }: PreviewCatalogRow) => `${kind} ${name}`;
  const expected = new Map(PREVIEW_EXPECTED_ROWS.map(row => [keyFor(row), row.facts]));
  const drift: string[] = [];
  for (const row of rows) {
    const key = keyFor(row);
    const wanted = expected.get(key);
    if (!wanted) {
      drift.push(`unexpected ${key}`);
      continue;
    }
    const fields = new Set([...Object.keys(wanted), ...Object.keys(row.facts)]);
    const changed = [...fields].filter(field => !isDeepStrictEqual(row.facts[field], wanted[field])).sort();
    if (changed.length) drift.push(`changed ${key} (${changed.join(", ")})`);
    expected.delete(key);
  }
  for (const key of expected.keys()) drift.push(`missing ${key}`);
  if (drift.length) fail(`${PREVIEW_TABLE} preimage drift before the acceptance forward. Restore the issued table shape. ${drift.sort().join(". ")}.`);
}

// Raw ordinary-trigger fixtures can supply intentionally mismatched SQL.
function hasEarlierTriggerTable(forward: string, relation: string, hash: string) {
  const statements = sqlStatements(forward, false, false, true);
  const position = statements.findIndex(statement => sqlSha256(statement) === hash);
  return position >= 0 && statements.slice(0, position).some(statement => nativeStoreCreatedTable(statement) === relation);
}

async function verifyForward(pool: Pool, registry: ReviewedForwardRegistry, path: string, bytes: Buffer, prefix: Parameters<typeof assertNativeStoreForward>[3], keep = false, setup = "", cachedBefore?: Snapshot) {
  const admission = assertNativeStoreForward(registry, path, bytes, prefix);
  return checkForward(pool, admission.slot, bytes.toString("utf8"), keep, setup, admission, cachedBefore);
}

const pristineSnapshots = new WeakMap<Pool, Snapshot>();

// Run a forward in a transaction on a real database and check it against the slot. It is rolled
// back, except that `keep` commits a forward that passed so the next slot sees the cumulative chain.
async function checkForward(pool: Pool, slot: CatalogSlot, forward: string, keep = false, setup = "", admission?: NativeAdmission, cachedBefore?: Snapshot): Promise<Snapshot> {
  if (!admission && (keep || slot.createdTriggers?.some(entry => entry.deferred))) fail("deferred verification and commit require static admission");
  const db = await pool.connect();
  let passed = false;
  try {
    const migrationRole = String((await db.query("SELECT current_user::text::regrole::text AS role")).rows[0].role);
    await db.query("BEGIN");
    try {
      if (setup) await db.query(setup);
      if (slot.previewNoopAcceptance) await assertPreviewAcceptancePreimage(db, migrationRole);
      const reusableBefore = !setup ? (cachedBefore ?? (!keep ? pristineSnapshots.get(pool) : undefined)) : undefined;
      const before = reusableBefore ?? await pinned(db, () => snapshot(db));
      const memberships = async () => (await db.query("SELECT * FROM pg_catalog.pg_auth_members ORDER BY oid")).rows;
      const membersBefore = slot.ownerWindowRole === undefined ? undefined : await memberships();
      await db.query(forward);
      if (membersBefore && JSON.stringify(await memberships()) !== JSON.stringify(membersBefore)) fail("pg_auth_members changed during the settings-only forward");
      const after = await pinned(db, () => snapshot(db));
      await pinned(db, () => assertSlotCatalog(db, slot, before, after, migrationRole, forward, admission));
      passed = true;
      return after;
    } finally {
      await db.query(keep && passed ? "COMMIT" : "ROLLBACK");
      if (keep && passed) pristineSnapshots.delete(pool);
    }
  } finally { db.release(); }
}

// ---- Synthetic cases: the comparator itself, on real PostgreSQL ---------------------------------
const SYNTHETIC_BASE = `
CREATE TABLE public.subscriptions (id int PRIMARY KEY);
CREATE TABLE public.clients (id uuid PRIMARY KEY);
CREATE TABLE public.client_absorption_policy (table_name text PRIMARY KEY, disposition text NOT NULL, note text);
CREATE TABLE public.cat_existing_table (id int PRIMARY KEY, owner_ref uuid NOT NULL);
CREATE TABLE public.cat_parameters (id uuid, extra uuid, owner_ref uuid, status text, kind text, CONSTRAINT cat_status CHECK (status IN ('open','closed')), CONSTRAINT cat_kind CHECK (kind IN ('first','second')), CONSTRAINT cat_key UNIQUE (id));
CREATE TABLE public.communication_native_sync_state (purpose text NOT NULL CONSTRAINT communication_native_sync_state_purpose_check CHECK (purpose IN ('a','b')));
CREATE FUNCTION public.cat_replaced(p text, q boolean DEFAULT false) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'before' $$;
REVOKE ALL ON FUNCTION public.cat_replaced(text,boolean) FROM PUBLIC;
CREATE FUNCTION public.cat_grant_only(p text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'x' $$;
REVOKE ALL ON FUNCTION public.cat_grant_only(text) FROM PUBLIC;
CREATE FUNCTION public.cat_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER cat_base_trigger BEFORE INSERT ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();
CREATE VIEW public.cat_view AS SELECT id FROM public.cat_existing_table;
CREATE TABLE public.cat_child (parent_id int REFERENCES public.cat_existing_table(id));
CREATE UNIQUE INDEX cat_active_idx ON public.cat_parameters (id) WHERE id IS NOT NULL;
CREATE INDEX cat_other_idx ON public.cat_parameters (extra);`;
// A default argument stores parser locations, which move when the replacement sits at another file offset.
const SYNTHETIC_SLOT: CatalogSlot = {
  replacedFunctions: [{ signature: "public.cat_replaced(text,boolean)", beforeSha256: null, searchPath: "pg_catalog, pg_temp" }],
  createdFunctions: [{ signature: "public.cat_created(text)", searchPath: "pg_catalog, pg_temp" }],
  grantOnlyFunctions: [{ signature: "public.cat_grant_only(text)", grantTo: ["service_role"], revokeFrom: ["anon", "authenticated"] }],
};
// The slot lists the purposes the CHECK holds before the forward, as the registry does.
const PURPOSE_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, purposeCheck: { beforeSha256: sqlSha256(sqlStatements(SYNTHETIC_BASE).find(statement => statement.startsWith("CREATE TABLE public.communication_native_sync_state"))!), values: ["a", "b"] } };
const purposeCheck = (definition: string) => `ALTER TABLE public.communication_native_sync_state DROP CONSTRAINT communication_native_sync_state_purpose_check;
ALTER TABLE public.communication_native_sync_state ADD CONSTRAINT communication_native_sync_state_purpose_check ${definition};`;
// An invoker function pins no search_path, so the slot lists none and the catalog must show none.
const INVOKER_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, createdFunctions: [{ signature: "public.cat_created(text)", searchPath: null }] };
const invoker = (attributes: string) => `CREATE FUNCTION public.cat_created(p text) RETURNS text LANGUAGE sql${attributes} AS $$ SELECT p $$;\nREVOKE ALL ON FUNCTION public.cat_created(text) FROM PUBLIC;`;
const guarded = (role: string, privilege: string, target: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN EXECUTE '${privilege} ${target}'; END IF; END; $$;`;
const REPLACE_PART = "-- the replacement sits later in the file than the original\nCREATE OR REPLACE FUNCTION public.cat_replaced(p text, q boolean DEFAULT false) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'after' $$;";
const GRANT_PART = guarded("service_role", "GRANT EXECUTE ON FUNCTION", "public.cat_grant_only(text) TO service_role;");
const TABLE_PART = `CREATE TABLE public.cat_created_table (id int);
REVOKE ALL ON TABLE public.cat_created_table FROM PUBLIC;
ALTER TABLE public.cat_created_table ENABLE ROW LEVEL SECURITY;`;
// The shapes of a row that changes an existing table: a dropped NOT NULL, an added column and constraint.
const EXISTING_PART = `ALTER TABLE public.cat_existing_table ALTER COLUMN owner_ref DROP NOT NULL, ADD COLUMN purchase_ref uuid;
ALTER TABLE public.cat_existing_table ADD CONSTRAINT cat_owner_check CHECK ((owner_ref IS NULL) = (purchase_ref IS NOT NULL)) NOT VALID;
ALTER TABLE public.cat_existing_table VALIDATE CONSTRAINT cat_owner_check;`;
const CREATE_PINNED = "CREATE FUNCTION public.cat_created(p text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT p $$;";
const REVOKE_CREATED = "REVOKE ALL ON FUNCTION public.cat_created(text) FROM PUBLIC;";
const CREATED_OK = `${CREATE_PINNED}\n${REVOKE_CREATED}\n${guarded("service_role", "GRANT EXECUTE ON FUNCTION", "public.cat_created(text) TO service_role;")}`;
const forward = (created: string, extra = "") => [REPLACE_PART, created, GRANT_PART, TABLE_PART, EXISTING_PART, extra].filter(Boolean).join("\n");
const CONFORMING = forward(CREATED_OK);
const TRIGGER_FUNCTION = "CREATE FUNCTION public.cat_created_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END; $$;";
const TRIGGER_REVOKE = "REVOKE ALL ON FUNCTION public.cat_created_guard() FROM PUBLIC;";
const TRIGGER_BEFORE = "CREATE TRIGGER cat_created_guard BEFORE INSERT OR DELETE OR UPDATE OF owner_ref, id ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_created_guard();";
const TRIGGER_AFTER = "CREATE TRIGGER cat_created_event AFTER INSERT ON public.cat_parameters FOR EACH ROW EXECUTE FUNCTION public.cat_created_guard();";
const TRIGGER_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT,
  createdFunctions: [...SYNTHETIC_SLOT.createdFunctions, { signature: "public.cat_created_guard()", searchPath: "pg_catalog, pg_temp" }],
  createdTriggers: [{ name: "cat_created_guard", table: "public.cat_existing_table", sha256: sqlSha256(TRIGGER_BEFORE) }, { name: "cat_created_event", table: "public.cat_parameters", sha256: sqlSha256(TRIGGER_AFTER) }],
};
const TRIGGER_SQL = `${TRIGGER_FUNCTION}\n${TRIGGER_REVOKE}\n${TRIGGER_BEFORE}\n${TRIGGER_AFTER}`;
const DEFERRED_SLOT: NativeStoreSlot = {
  row: "DeferredTrigger", path: "db/platform/migrations/20271106100000_deferred_trigger_fixture.sql", dataStatements: [],
  createdFunctions: [{ signature: "public.cat_created_guard()", searchPath: null }], replacedFunctions: [], grantOnlyFunctions: [],
};
const deferredFunction = TRIGGER_FUNCTION.replace(" SET search_path = pg_catalog, pg_temp", "") + TRIGGER_REVOKE;
function deferredPin(overrides: Partial<Omit<NativeDeferredTrigger, "sha256">> = {}, statement?: string): NativeDeferredTrigger {
  const entry = { name: "cat_deferred_guard", relation: "public.cat_existing_table", events: ["INSERT", "UPDATE", "DELETE"],
    function: "public.cat_created_guard()", deferred: true, ...overrides } satisfies Omit<NativeDeferredTrigger, "sha256">;
  return { ...entry, sha256: sqlSha256(statement ?? renderNativeDeferredTrigger(entry)) };
}
function deferredFixture(slot: NativeStoreSlot, forward: string, setup = ""): Parameters<typeof assertNativeStoreForward> {
  const bytes = Buffer.from(forward), definitions = nativeStoreFunctionDefinitions(Buffer.from(deferredFunction), slot.createdFunctions.map(fn => fn.signature), true);
  return [{
    schemaVersion: 1, baselineSha256: sqlSha256(SYNTHETIC_BASE), replacementForwards: [], creationForwards: [],
    nativeStoreForwardClass: { sealed: true, slots: [slot] },
    nativeStoreForwards: [{ path: slot.path, sha256: sqlSha256(bytes), functions: slot.createdFunctions.map(({ signature }) => ({ signature, beforeSha256: null, afterSha256: definitions.get(signature)! })) }],
  }, slot.path, bytes, [{ path: PLATFORM_BASELINE_FILE, bytes: Buffer.from(SYNTHETIC_BASE) },
    ...(setup ? [{ path: "db/platform/migrations/20261031120000_trigger_history.sql", bytes: Buffer.from(setup) }] : [])]];
}

const ASSIGNMENT_ADD = "ALTER TABLE public.subscriptions ADD COLUMN offer_policy_assignment_state text NOT NULL DEFAULT 'legacy_frozen';";
const ASSIGNMENT_SWITCH = "ALTER TABLE public.subscriptions ALTER COLUMN offer_policy_assignment_state SET DEFAULT 'pending_acquisition';";
const ASSIGNMENT_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, existingTableStatements: [ASSIGNMENT_ADD, ASSIGNMENT_SWITCH] };
const BASELINE_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, insertSelectTables: ["public.commerce_offer_policy_rollout_baselines"] };
const BASELINE_TABLE = "CREATE TABLE public.commerce_offer_policy_rollout_baselines (id int);";
const BASELINE_SQL = `${BASELINE_TABLE}
ALTER TABLE public.commerce_offer_policy_rollout_baselines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_offer_policy_rollout_baselines FROM PUBLIC;
${guarded("service_role", "GRANT SELECT, INSERT ON TABLE", "public.commerce_offer_policy_rollout_baselines TO service_role;")}
${guarded("service_role", "CREATE POLICY commerce_offer_policy_baselines_service_select ON", "public.commerce_offer_policy_rollout_baselines FOR SELECT TO service_role USING (true);")}
${guarded("service_role", "CREATE POLICY commerce_offer_policy_baselines_service_insert ON", "public.commerce_offer_policy_rollout_baselines FOR INSERT TO service_role WITH CHECK (true);")}`;
const NOTICE_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, insertSelectTables: ["public.subscription_notice_refusals"] };
const NOTICE_TABLE = "CREATE TABLE public.subscription_notice_refusals (id int); ALTER TABLE public.subscription_notice_refusals ENABLE ROW LEVEL SECURITY; REVOKE ALL ON TABLE public.subscription_notice_refusals FROM PUBLIC;";
const NOTICE_GRANT = guarded("service_role", "GRANT SELECT, INSERT ON", "public.subscription_notice_refusals TO service_role;");
const NOTICE_POLICY = guarded("service_role", "CREATE POLICY subscription_notice_refusals_runtime ON", "public.subscription_notice_refusals FOR ALL TO service_role USING (true) WITH CHECK (true);");
const NOTICE_SQL = [NOTICE_TABLE, NOTICE_GRANT, NOTICE_POLICY].join("\n");
const CENSUS_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, absorptionCensusTables: ["public.cat_census"] };
const CENSUS_CLASSIFICATION = "INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('cat_census', 'block', 'Subject history prevents absorption.');";
const CENSUS_SQL = `CREATE TABLE public.cat_census (id uuid PRIMARY KEY, client_id uuid REFERENCES public.clients(id), payload jsonb);
ALTER TABLE public.cat_census ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cat_census FROM PUBLIC;
${CENSUS_CLASSIFICATION}
${guarded("service_role", "GRANT SELECT (client_id) ON TABLE", "public.cat_census TO service_role;")}
${guarded("service_role", "CREATE POLICY cat_census_absorption_census ON", "public.cat_census FOR SELECT TO service_role USING (true);")}`;
const CLIENT_TABLE = `CREATE TABLE public.cat_client_history (id uuid PRIMARY KEY, subject_id uuid REFERENCES public.clients(id));
ALTER TABLE public.cat_client_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cat_client_history FROM PUBLIC;`;
const classifiedClientTable = (disposition: string) => `${CLIENT_TABLE}
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('cat_client_history', '${disposition}', 'Subject history has an explicit disposition.');`;
const classifiedQuotedClientTable = (disposition: string, key = "CensusHistory") => `${CLIENT_TABLE.replaceAll("public.cat_client_history", 'public."CensusHistory"')}
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('${key}', '${disposition}', 'Subject history has an explicit disposition.');`;
// The statement reported as FC-R1B-001, unchanged: a quoted default hides an `AS $q$` so a static
// header reader takes a fake search_path attribute list for the real one.
const HIDDEN_HEADER = "CREATE FUNCTION public.cat_created(p text DEFAULT ' SET search_path = pg_catalog, pg_temp AS $q$') RETURNS text LANGUAGE sql SECURITY DEFINER AS 'select p' SET application_name = x$q$;";
// The statement reported as FC-R5B-001, unchanged and run here without the static class: a backslash ends a standard literal
// early in PostgreSQL, so after the listed function the database also creates an operator for (oid, integer) in pg_catalog
// and a second definer. Read with a bare integer floor, the operator hid that definer from this comparison.
const OPERATOR_CAPTURE = String.raw`CREATE FUNCTION public.cat_created(p text DEFAULT ' SET search_path = pg_catalog, pg_temp AS $q$') RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'select 1 --\';
CREATE FUNCTION pg_catalog.cat_ge(oid, integer) RETURNS boolean LANGUAGE sql STABLE AS $b$ SELECT $1::bigint >= $2 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = $1 AND proname IN ($n$cat_ge$n$, $n$cat_evil$n$)) $b$;
CREATE OPERATOR pg_catalog.>= (LEFTARG = oid, RIGHTARG = integer, FUNCTION = pg_catalog.cat_ge);
CREATE FUNCTION public.cat_evil(c text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $b$ BEGIN EXECUTE c; END $b$;
SELECT ' $a$ ';
SELECT 1 AS x$a$, 2 AS y$q$;
REVOKE ALL ON FUNCTION public.cat_created(text) FROM PUBLIC;`;
const UNLISTED = "CREATE FUNCTION public.cat_unlisted(p text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT p $$;\nREVOKE ALL ON FUNCTION public.cat_unlisted(text) FROM PUBLIC;";
const REFUSALS: [string, string, RegExp, boolean, CatalogSlot][] = [
  ["a quoted client table with a quoted retain classification key", forward(CREATED_OK, classifiedQuotedClientTable("retain", '"CensusHistory"')), /no absorption classification/u, false, SYNTHETIC_SLOT],
  ["a quoted client table with a quoted block classification key", forward(CREATED_OK, classifiedQuotedClientTable("block", '"CensusHistory"')), /no absorption classification/u, false, SYNTHETIC_SLOT],
  ["an unlisted, unclassified client-referencing table", forward(CREATED_OK, CLIENT_TABLE), /no absorption classification/u, false, SYNTHETIC_SLOT],
  ["a listed census table without its client foreign key", forward(CREATED_OK, CENSUS_SQL.replace(" REFERENCES public.clients(id)", "")), /absorption census shape/u, false, CENSUS_SLOT],
  ["a listed census table referencing another relation", forward(CREATED_OK, CENSUS_SQL.replace("REFERENCES public.clients(id)", "REFERENCES public.cat_parameters(id)")), /absorption census shape/u, false, CENSUS_SLOT],
  ["a retained table with an unlisted column grant", forward(CREATED_OK, classifiedClientTable("retain") + "\nGRANT SELECT (subject_id) ON TABLE public.cat_client_history TO service_role;"), /column privileges/u, true, SYNTHETIC_SLOT],
  ["an unlisted block table with a table grant", forward(CREATED_OK, classifiedClientTable("block") + "\nGRANT SELECT ON TABLE public.cat_client_history TO service_role;"), /new relation .* grants/u, true, SYNTHETIC_SLOT],
  ["a census table with an extra column grant", forward(CREATED_OK, CENSUS_SQL + "\nGRANT SELECT (payload) ON TABLE public.cat_census TO service_role;"), /absorption census shape/u, true, CENSUS_SLOT],
  ["a census table with a table grant", forward(CREATED_OK, CENSUS_SQL + "\nGRANT SELECT ON TABLE public.cat_census TO service_role;"), /absorption census shape/u, true, CENSUS_SLOT],
  ["a census table with a second policy", forward(CREATED_OK, CENSUS_SQL + "\nCREATE POLICY census_extra ON public.cat_census FOR SELECT TO service_role USING (true);"), /absorption census shape/u, true, CENSUS_SLOT],
  ["a census table without block classification", forward(CREATED_OK, CENSUS_SQL.replace(CENSUS_CLASSIFICATION, "")), /no absorption classification/u, false, CENSUS_SLOT],
  ["a census table with retain classification", forward(CREATED_OK, CENSUS_SQL.replace("'block'", "'retain'")), /absorption census shape/u, false, CENSUS_SLOT],
  ["another new relation with the named table's runtime ACL", forward(CREATED_OK, guarded("service_role", "GRANT SELECT, INSERT ON", "public.cat_created_table TO service_role;")), /new relation public\.cat_created_table grants service_role:/u, true, NOTICE_SLOT],
  ["the named runtime table without RLS", forward(CREATED_OK, NOTICE_SQL.replace("ENABLE ROW LEVEL SECURITY", "DISABLE ROW LEVEL SECURITY")), /pinned INSERT\/SELECT shape/u, true, NOTICE_SLOT],
  ["the named runtime table with an extra privilege", forward(CREATED_OK, NOTICE_SQL.replace("GRANT SELECT, INSERT", "GRANT SELECT, INSERT, UPDATE")), /pinned INSERT\/SELECT shape/u, true, NOTICE_SLOT],
  ["the named runtime table with a second policy", forward(CREATED_OK, NOTICE_SQL + "\nCREATE POLICY notice_extra ON public.subscription_notice_refusals TO service_role USING (true);"), /pinned INSERT\/SELECT shape/u, true, NOTICE_SLOT],
  ["the named runtime table with a PUBLIC policy", forward(CREATED_OK, NOTICE_SQL.replace("FOR ALL TO service_role", "FOR ALL TO PUBLIC")), /pinned INSERT\/SELECT shape/u, true, NOTICE_SLOT],
  ["the FC-R1B-001 header under a listed signature", forward(`${HIDDEN_HEADER}\n${REVOKE_CREATED}`), /pinned search_path/u, false, SYNTHETIC_SLOT],
  ["an unlisted function", forward(CREATED_OK, UNLISTED), /created functions differ/u, false, SYNTHETIC_SLOT],
  ["a function created in pg_catalog", forward(CREATED_OK, "CREATE FUNCTION pg_catalog.cat_shadow(p text) RETURNS text LANGUAGE sql AS $$ SELECT p $$;"), /created functions differ/u, false, SYNTHETIC_SLOT],
  ["a definer without the pinned search_path", forward(`${CREATE_PINNED.replace(" SET search_path = pg_catalog, pg_temp", "")}\n${REVOKE_CREATED}`), /pinned search_path/u, false, SYNTHETIC_SLOT],
  ["an invoker function that carries a SET its slot does not pin", forward(invoker(" SET application_name = x")), /slot pins none/u, false, INVOKER_SLOT],
  ["a created function owned by another role", forward(CREATED_OK, "ALTER FUNCTION public.cat_created(text) OWNER TO anon;"), /not the migration role/u, false, SYNTHETIC_SLOT],
  ["retained PUBLIC execute", forward(CREATE_PINNED), /PUBLIC execute/u, false, SYNTHETIC_SLOT],
  ["a grant to PUBLIC on a created function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION public.cat_created(text) TO PUBLIC;"), /PUBLIC execute/u, false, SYNTHETIC_SLOT],
  ["a grant option on a created function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION public.cat_created(text) TO authenticated WITH GRANT OPTION;"), /pass the privilege on/u, false, SYNTHETIC_SLOT],
  ["a grant option on a grant-only function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION public.cat_grant_only(text) TO service_role WITH GRANT OPTION;"), /outside its grant list/u, true, SYNTHETIC_SLOT],
  ["a grant on an existing table", forward(CREATED_OK, "GRANT SELECT ON public.cat_existing_table TO service_role;"), /existing relation/u, true, SYNTHETIC_SLOT],
  ["a grant on a new table", forward(CREATED_OK, "GRANT SELECT ON public.cat_created_table TO authenticated;"), /new relation .* grants/u, false, SYNTHETIC_SLOT],
  ["a column privilege on a new table", forward(CREATED_OK, "GRANT SELECT (id) ON public.cat_created_table TO authenticated;"), /column privileges/u, false, SYNTHETIC_SLOT],
  ["a new table owned by another role", forward(CREATED_OK, "ALTER TABLE public.cat_created_table OWNER TO authenticated;"), /not the migration role/u, false, SYNTHETIC_SLOT],
  ["a grant on a system function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO authenticated;"), /system catalog/u, false, SYNTHETIC_SLOT],
  ["a grant on a system table", forward(CREATED_OK, "GRANT SELECT ON pg_catalog.pg_authid TO authenticated;"), /system catalog/u, false, SYNTHETIC_SLOT],
  ["a column privilege on a system table", forward(CREATED_OK, "GRANT SELECT (rolpassword) ON pg_catalog.pg_authid TO authenticated;"), /system catalog/u, false, SYNTHETIC_SLOT],
  ["a role membership",forward(CREATED_OK, "GRANT authenticated TO anon;"), /memberships changed/u, false, SYNTHETIC_SLOT],
  ["a schema privilege", forward(CREATED_OK, "GRANT CREATE ON SCHEMA public TO authenticated;"), /schemas changed/u, false, SYNTHETIC_SLOT],
  ["a database privilege", forward(CREATED_OK, "GRANT CONNECT ON DATABASE synthetic TO anon;"), /databases changed/u, false, SYNTHETIC_SLOT],
  ["a per-database role setting", forward(CREATED_OK, "ALTER ROLE authenticated IN DATABASE synthetic SET search_path = public;"), /dbSettings changed/u, false, SYNTHETIC_SLOT],
  ["a new trigger on an existing table", forward(CREATED_OK, "CREATE TRIGGER cat_trigger BEFORE INSERT ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();"), /triggers on existing relations/u, false, SYNTHETIC_SLOT],
  ["a trigger dropped from an existing table", forward(CREATED_OK, "DROP TRIGGER cat_base_trigger ON public.cat_existing_table;"), /triggers on existing relations/u, false, SYNTHETIC_SLOT],
  ["a trigger redefined with other events", forward(CREATED_OK, "CREATE OR REPLACE TRIGGER cat_base_trigger BEFORE INSERT OR UPDATE ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();"), /triggers on existing relations/u, false, SYNTHETIC_SLOT],
  ["the internal foreign-key triggers of an existing table disabled", forward(CREATED_OK, "ALTER TABLE public.cat_child DISABLE TRIGGER ALL;"), /triggers on existing relations/u, false, SYNTHETIC_SLOT],
  ["a rule on a view PostgreSQL ships", forward(CREATED_OK, "CREATE OR REPLACE VIEW information_schema.enabled_roles AS SELECT a.rolname::information_schema.sql_identifier AS role_name, a.rolpassword AS leaked FROM pg_catalog.pg_authid a;"), /rules on existing relations/u, false, SYNTHETIC_SLOT],
  ["a constraint PostgreSQL ships dropped", forward(CREATED_OK, "ALTER DOMAIN information_schema.cardinal_number DROP CONSTRAINT cardinal_number_domain_check;"), /dropped or rewritten/u, false, SYNTHETIC_SLOT],
  ["options of an existing index", forward(CREATED_OK, "ALTER INDEX public.cat_existing_table_pkey SET (fillfactor = 70);"), /existing relation/u, false, SYNTHETIC_SLOT],
  ["a temporary view that hides a catalog", forward(CREATED_OK, "CREATE TEMP VIEW pg_proc AS SELECT * FROM pg_catalog.pg_proc WHERE proname <> 'cat_evil';\nCREATE FUNCTION public.cat_evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;"), /created functions differ/u, false, SYNTHETIC_SLOT],
  ["an operator that hides what the statement after a backslash creates", OPERATOR_CAPTURE, /created functions differ/u, false, SYNTHETIC_SLOT],
  ["a privilege on a server parameter", forward(CREATED_OK, "GRANT SET ON PARAMETER session_replication_role TO anon;"), /parameterAcls changed/u, false, SYNTHETIC_SLOT],
  ["a policy on an existing table",forward(CREATED_OK, "CREATE POLICY cat_policy ON public.cat_existing_table USING (true);"), /policies on existing relations/u, false, SYNTHETIC_SLOT],
  ["a rewrite rule on an existing table", forward(CREATED_OK, "CREATE RULE cat_rule AS ON INSERT TO public.cat_existing_table DO INSTEAD NOTHING;"), /rules on existing relations/u, false, SYNTHETIC_SLOT],
  ["a redefined view", forward(CREATED_OK, "CREATE OR REPLACE VIEW public.cat_view AS SELECT id, owner_ref FROM public.cat_existing_table;"), /rules on existing relations/u, false, SYNTHETIC_SLOT],
  ["a purpose CHECK that drops a value", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('b','c'))")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK inverted by NOT IN", forward(CREATED_OK, purposeCheck("CHECK (purpose NOT IN ('a','b'))")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK voided by OR true", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c') OR true)")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK added NOT VALID", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c')) NOT VALID")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK whose slot lists other preimage values", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c'))")), /purpose CHECK/u, false, { ...SYNTHETIC_SLOT, purposeCheck: { beforeSha256: PURPOSE_SLOT.purposeCheck!.beforeSha256, values: ["a"] } }],
  ["a purpose CHECK rewritten by a slot that lists none", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c'))")), /purpose CHECK/u, false, SYNTHETIC_SLOT],
];

// ---- Real forwards: every bound native slot, replayed on the cumulative native chain -----------
const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const manifest: PlatformMigrationManifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const bound = (registry.nativeStoreForwards ?? []).map(pin => ({ pin, slot: registry.nativeStoreForwardClass!.slots.find(slot => slot.path === pin.path)! }))
  .sort((x, y) => x.pin.path.localeCompare(y.pin.path));
export const previewAcceptanceForwardPath = bound.find(({ slot }) => slot.previewNoopAcceptance)?.pin.path;
const reminderSignature = "public.dunning_lifecycle_pause_reminder_dispatch(integer,integer)";
const reminderCreation = bound.find(entry => entry.slot.createdFunctions.some(fn => fn.signature === reminderSignature))!;
const reminderCreationPin = reminderCreation.pin.functions.find(fn => fn.signature === reminderSignature)!;
const reminderOriginal = sqlStatements(readFileSync(reminderCreation.pin.path, "utf8")).find(statement =>
  nativeStoreFunctionDefinitions(Buffer.from(statement), [reminderSignature], true).has(reminderSignature))!;
const reminderReplacement = reminderOriginal.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
  .replace("'ok',true,", "'ok',true,'capabilityWitness',true,");
const reminderReplacementSlot: CatalogSlot = { createdFunctions: [],
  replacedFunctions: [{ signature: reminderSignature, beforeSha256: reminderCreationPin.afterSha256, searchPath: "pg_catalog" }], grantOnlyFunctions: [] };
const boundPaths = new Set(bound.map(entry => entry.pin.path));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// Manifest units that are not bound forwards (a landed bound forward is also in the manifest).
const chain = [manifest.baseline, ...manifest.forward].filter(unit => !boundPaths.has(unit.file)).map(unit => {
  const bytes = readFileSync(unit.file);
  if (sha(bytes) !== unit.sha256) throw new Error(`native chain unit differs from the manifest: ${unit.file}`);
  return { path: unit.file, bytes };
});
const triggerStatements = new Map(sqlStatements(TRIGGER_SQL).map(statement => [sqlSha256(statement), statement] as const));
const indexStatements = new Map([SYNTHETIC_BASE, ...chain.map(unit => unit.bytes.toString("utf8")), ...bound.map(entry => readFileSync(entry.pin.path, "utf8"))].flatMap(sql => sqlStatements(sql, true, false, true).map(statement => [sqlSha256(statement), statement] as const)));
const PARAMETER_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, checkSupersets: [
  { table: "public.cat_parameters", constraint: "cat_status", column: "status", values: ["open", "closed", "paused"] },
  { table: "public.cat_parameters", constraint: "cat_kind", column: "kind", values: ["first", "second", "third"] },
] };
const PARAMETER_CHECKS = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_status CHECK (status IN ('open','closed','paused')); ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_kind; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_kind CHECK (kind IN ('first','second','third'));";
const UNVALIDATED_PARAMETER_SETUP = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_status CHECK (status IN ('open','closed')) NOT VALID;";
const UNVALIDATED_PARAMETER_CHECKS = PARAMETER_CHECKS.replace("('open','closed','paused'));", "('open','closed','paused')) NOT VALID;");
const RANGE_DEFINITION = "CHECK (((days >= 1) AND (days <= 90)))";
const RANGE_SETUP = "CREATE TABLE public.cat_range (days integer, other_days integer, CONSTRAINT cat_days CHECK (days BETWEEN 1 AND 90)); GRANT SELECT(days) ON public.cat_range TO authenticated;";
const rangeReplacement = (expression = "days BETWEEN 1 AND 3660", tail = "") => `ALTER TABLE public.cat_range DROP CONSTRAINT cat_days;
ALTER TABLE public.cat_range ADD CONSTRAINT cat_days CHECK (${expression})${tail};`;
const rangeSlot = (lower = 1, upper = 3660, preimage = RANGE_DEFINITION): CatalogSlot => ({ createdFunctions: [], replacedFunctions: [], grantOnlyFunctions: [],
  checkSupersets: [{ table: "public.cat_range", constraint: "cat_days", column: "days", range: { lower, upper }, beforeSha256: sqlSha256(preimage) }] });
const UNIQUE_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, uniqueSupersets: [{ table: "public.cat_parameters", constraint: "cat_key", columns: ["id", "extra"], nullsNotDistinct: true }] };
const UNIQUE_SQL = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_key UNIQUE NULLS NOT DISTINCT (id,extra);";
const DROP_INDEX_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, droppedIndexes: [{ table: "public.cat_parameters", name: "cat_active_idx", beforeSha256: sqlSha256("CREATE UNIQUE INDEX cat_active_idx ON public.cat_parameters (id) WHERE id IS NOT NULL;") }] };
const DROP_INDEX_SQL = "DROP INDEX public.cat_active_idx; CREATE INDEX cat_replacement_idx ON public.cat_parameters (id, extra DESC);";
const DROP_TWO_INDEXES_SLOT: CatalogSlot = { ...DROP_INDEX_SLOT, droppedIndexes: [...DROP_INDEX_SLOT.droppedIndexes!, { table: "public.cat_parameters", name: "cat_other_idx", beforeSha256: sqlSha256("CREATE INDEX cat_other_idx ON public.cat_parameters (extra);") }] };

// The chain creates anon and authenticated itself; service_role comes from the host bootstrap, so it is
// the one role these two modes toggle for the whole run. With no bound forward this is a plain replay of
// the chain, so the replay is proved before the first feature change relies on it.
async function reminderCreationProbes(pool: Pool) {
  const outcomes = new Map<string, Error | null>(), db = await pool.connect();
  const record = async (name: string, work: () => Promise<unknown>) => outcomes.set(name, await work().then(() => null, (error: Error) => error));
  try {
    const before = await pinned(db, () => snapshot(db));
    const migrationRole = String((await db.query("SELECT current_user::text AS role")).rows[0].role);
    await record("positive", async () => {
      expect(reminderCreationPin.beforeSha256).toBeNull();
      const installed = (await db.query("SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure", [reminderSignature])).rows[0].prosrc as string;
      const start = reminderOriginal.indexOf("AS $$") + 5, end = reminderOriginal.lastIndexOf("$$");
      expect(sqlSha256(reminderOriginal.slice(0, start) + installed + reminderOriginal.slice(end))).toBe(reminderCreationPin.afterSha256);
      expect(reminderReplacement).toContain("'capabilityWitness',true");
      await checkForward(pool, reminderReplacementSlot, reminderReplacement);
    });
    for (const change of ["unlisted", "header", "signature", "owner", "ACL"]) {
      const slot = structuredClone(reminderReplacementSlot);
      let statement = reminderReplacement;
      if (change === "unlisted") slot.replacedFunctions = [];
      if (change === "header") statement = statement.replace("LANGUAGE plpgsql", "LANGUAGE plpgsql SECURITY DEFINER");
      if (change === "signature") statement = statement.replace("p_pause_window_seconds integer", "p_pause_window_seconds bigint");
      if (change === "owner") statement += ` ALTER FUNCTION ${reminderSignature} OWNER TO authenticated;`;
      if (change === "ACL") statement += ` GRANT EXECUTE ON FUNCTION ${reminderSignature} TO authenticated;`;
      await record(change, () => checkForward(pool, slot, statement));
    }
    await record("rollback", () => pinned(db, async () => assertSlotCatalog(db,
      { createdFunctions: [], replacedFunctions: [], grantOnlyFunctions: [] }, before, await snapshot(db), migrationRole)));
  } finally { db.release(); }
  return outcomes;
}

async function provePreviewAcceptance(pool: Pool, setup = "") {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    if (setup) await db.query(setup);
    const client = (await db.query("INSERT INTO public.clients(email) VALUES ('preview-proof@example.invalid') RETURNING id")).rows[0].id;
    const subscription = (await db.query(`INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at)
      VALUES ($1,28,now()) RETURNING id`, [client])).rows[0].id;
    const event = (await db.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key)
      VALUES ($1,'fixture.preview.native','preview-event') RETURNING id`, [subscription])).rows[0].id;
    const actor = (await db.query("SELECT gen_random_uuid() AS id")).rows[0].id;
    const receipt = (await db.query(`INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,result,status)
      VALUES ($1,'preview-noop',$2,$3,repeat('a',64),'{}','{}','noop') RETURNING id`, [actor, subscription, client])).rows[0].id;
    const quote = `INSERT INTO public.subscription_quote_previews(subscription_id,client_id,actor_id,action,quote_hash,template_version,
      expires_at,request_payload,quote_snapshot,totals,status,accepted_at,accepted_idempotency_key,accepted_event_id`;
    const values = `VALUES ($1,$2,$3,'fixture.edit',encode(sha256(gen_random_uuid()::text::bytea),'hex'),1,
      now(),'{}','{}','{}',$4,CASE WHEN $5::boolean THEN now() END,$6,$7`;
    const statuses = ["previewed", "accepted", "Accepted", "other", null];
    for (const withReceipt of [false, true]) {
      if (withReceipt) {
        const role = (await db.query("SELECT current_user::text AS role")).rows[0].role as string;
        await assertPreviewAcceptancePreimage(db, role);
        // Clear deferred events queued by the pre-forward inserts before ALTER TABLE.
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        const before = await pinned(db, () => snapshot(db));
        await db.query(previewNoopAcceptanceSql);
        const slot: CatalogSlot = { createdFunctions: [], replacedFunctions: [], grantOnlyFunctions: [], previewNoopAcceptance: true,
          existingTableStatements: [previewNoopAcceptanceSql.split("\n", 1)[0]!] };
        await pinned(db, async () => assertSlotCatalog(db, slot, before, await snapshot(db), role, previewNoopAcceptanceSql));
        expect((await db.query(`SELECT status, accepted_noop_receipt_id FROM ${PREVIEW_TABLE} ORDER BY status`)).rows)
          .toEqual([{ status: "accepted", accepted_noop_receipt_id: null }, { status: "previewed", accepted_noop_receipt_id: null }]);
      }
      for (const status of statuses) for (let mask = 0; mask < (withReceipt ? 16 : 8); mask++) {
        const params = [subscription, client, actor, status, Boolean(mask & 1), mask & 2 ? "preview-key" : null, mask & 4 ? event : null];
        if (withReceipt) params.push(mask & 8 ? receipt : null);
        const insert = () => db.query(withReceipt ? `${quote},accepted_noop_receipt_id) ${values},$8)` : `${quote}) ${values})`, params);
        const allowed = (status === "previewed" && mask === 0) || (status === "accepted" && (mask === 7 || (withReceipt && mask === 11)));
        const label = `status=${status}, mask=${mask}, receipt column=${withReceipt}`;
        if (allowed) {
          expect((await insert()).rowCount, label).toBe(1);
        } else {
          await db.query("SAVEPOINT invalid_preview");
          const error = status === null ? { code: "23502", column: "status" }
            : status === "previewed" || status === "accepted" ? { code: "23514", constraint: PREVIEW_CHECK } : { code: "23514" };
          await expect(insert(), label).rejects.toMatchObject(error);
          await db.query("ROLLBACK TO SAVEPOINT invalid_preview");
          await db.query("RELEASE SAVEPOINT invalid_preview");
        }
      }
    }
    await expect(db.query(`${quote},accepted_noop_receipt_id) ${values},gen_random_uuid())`,
      [subscription, client, actor, "accepted", true, "missing-receipt", null])).rejects
      .toMatchObject({ code: "23503", constraint: "subscription_quote_previews_accepted_noop_receipt_id_fkey" });
  } finally { await db.query("ROLLBACK"); db.release(); }
}

const previewTriggerFunction = `CREATE FUNCTION public.preview_preimage_fixture() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN RETURN NULL; END; $$;`;
const previewPreimageProbes = [
  { label: "a deferred constraint trigger", setup: `${previewTriggerFunction}
    CREATE CONSTRAINT TRIGGER preview_preimage_fixture_deferred AFTER INSERT OR UPDATE OR DELETE ON ${PREVIEW_TABLE}
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.preview_preimage_fixture();` },
  { label: "an ordinary trigger", setup: `${previewTriggerFunction}
    CREATE TRIGGER preview_preimage_fixture_ordinary AFTER INSERT ON ${PREVIEW_TABLE}
    FOR EACH ROW EXECUTE FUNCTION public.preview_preimage_fixture();` },
  { label: "an extra column", setup: `ALTER TABLE ${PREVIEW_TABLE} ADD COLUMN preimage_probe_column text;`,
    drift: `unexpected pg_attribute ${PREVIEW_TABLE}.preimage_probe_column` },
  { label: "an extra CHECK", setup: `ALTER TABLE ${PREVIEW_TABLE} ADD CONSTRAINT preimage_probe_check CHECK (id IS NOT NULL);`,
    drift: `unexpected pg_constraint preimage_probe_check on ${PREVIEW_TABLE}` },
  { label: "an extra foreign key", setup: `ALTER TABLE ${PREVIEW_TABLE} ADD CONSTRAINT preimage_probe_fk FOREIGN KEY (client_id) REFERENCES public.clients(id);`,
    drift: `unexpected pg_constraint preimage_probe_fk on ${PREVIEW_TABLE}` },
  { label: "disabled internal RI triggers", setup: `ALTER TABLE ${PREVIEW_TABLE} DISABLE TRIGGER ALL;`,
    drift: `changed pg_trigger ${PREVIEW_TABLE}/subscription_quote_previews_client_id_fkey/"RI_FKey_check_ins"() (tgenabled)` },
];

async function replayChain(connectionString: string, probePreimage: boolean) {
  const outcomes = new Map<string, Error | null>();
  let creationOutcomes = new Map<string, Error | null>();
  let applied = 0;
  let previewAcceptanceError: Error | null | undefined;
  const chainDb = new Pool({ connectionString });
  const preimageProbeErrors = new Map<string, Error | null>();
  const provePreview = async () => {
    previewAcceptanceError = await provePreviewAcceptance(chainDb).then(() => null, (error: Error) => error);
    if (probePreimage) for (const { label, setup } of previewPreimageProbes) {
      preimageProbeErrors.set(label, await provePreviewAcceptance(chainDb, setup).then(() => null, (error: Error) => error));
    }
  };
  const prefix: Parameters<typeof assertNativeStoreForward>[3] = [];
  const steps = [...chain.map(unit => ({ path: unit.path, unit })), ...bound.map(entry => ({ path: entry.pin.path, entry }))].sort((x, y) => x.path.localeCompare(y.path));
  try {
    let lastSnapshot: Snapshot | undefined;
    for (const step of steps) {
      const { path } = step, bytes = "unit" in step ? step.unit.bytes : readFileSync(path);
      if ("unit" in step) {
        await chainDb.query(bytes.toString("utf8"));
        applied += 1;
        lastSnapshot = undefined;
      } else {
        if (step.entry.slot.previewNoopAcceptance) {
          await provePreview();
          lastSnapshot = undefined;
        }
        let nextSnapshot: Snapshot | undefined;
        const error = await verifyForward(chainDb, registry, path, bytes, prefix, true, "", lastSnapshot)
          .then(after => { nextSnapshot = after; return null; }, (error: Error) => error);
        outcomes.set(path, error);
        if (error) { lastSnapshot = undefined; continue; }
        lastSnapshot = nextSnapshot;
        // Probe the first replacement at creation and roll each probe back.
        if (path === reminderCreation.pin.path) {
          creationOutcomes = await reminderCreationProbes(chainDb);
          lastSnapshot = undefined;
        }
      }
      prefix.push({ path, bytes });
    }
    if (previewAcceptanceError === undefined) await provePreview();
  } finally { await chainDb.end(); }
  return { outcomes, creationOutcomes, applied, previewAcceptanceError, preimageProbeErrors };
}

export function registerNativeStoreForwardCatalog({ serviceRole }: { serviceRole: boolean }) {
  let container: PostgresContainer | undefined;
  let pool: Pool;
  let replay: Awaited<ReturnType<typeof replayChain>>;
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error("The native store catalog proof requires real PostgreSQL");
    container = await runPostgresContainer({ name: `native-catalog-${serviceRole ? "role" : "bare"}-${process.pid}`, password: "synthetic-conformance" });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native store catalog PostgreSQL unavailable");
    const admin = new Pool({ connectionString: container.connectionString });
    try {
      if (serviceRole) await admin.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
      await admin.query("CREATE DATABASE native_chain");
      await admin.query("CREATE DATABASE synthetic");
      replay = await replayChain(container.connectionStringFor("native_chain"), serviceRole);
      // The closed roles exist after the chain; the synthetic database needs them either way.
      for (const role of ["anon", "authenticated"]) await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END; $$`);
    } finally { await admin.end(); }
    const synthetic = new Pool({ connectionString: container.connectionStringFor("synthetic") });
    await synthetic.query(SYNTHETIC_BASE); await synthetic.end();
    pool = new Pool({ connectionString: container.connectionStringFor("synthetic") });
    // Every test on `pool` runs inside a rolled-back transaction, so the pristine
    // SYNTHETIC_BASE snapshot is invariant whenever `checkForward` runs with !keep && !setup.
    const baseClient = await pool.connect();
    try {
      pristineSnapshots.set(pool, await pinned(baseClient, () => snapshot(baseClient)));
    } finally { baseClient.release(); }
  }, postgresSetupTimeoutMs);
  afterAll(async () => {
    if (pool) pristineSnapshots.delete(pool);
    await closePostgres(container, pool);
  }, postgresTeardownTimeoutMs);

  // The full real-forward replay chain (all bound nativeStoreForwards + reminderCreationProbes)
  // and every service_role-sensitive synthetic test (CONFORMING, BASELINE_SQL, CENSUS_SQL,
  // NOTICE_SQL, successor storage absorption census) run in BOTH serviceRole modes.
  // Purely service_role-independent synthetic DDL comparator matrices run once under serviceRole: true.
  if (serviceRole) {
  it("admits the fresh assignment default switch and preserves historical rows", async () => {
    await checkForward(pool, ASSIGNMENT_SLOT, forward(CREATED_OK, ASSIGNMENT_ADD + ASSIGNMENT_SWITCH));
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("INSERT INTO public.subscriptions(id) VALUES (1)");
      await db.query(ASSIGNMENT_ADD + ASSIGNMENT_SWITCH);
      await db.query("INSERT INTO public.subscriptions(id) VALUES (2)");
      expect((await db.query("SELECT id, offer_policy_assignment_state AS state FROM public.subscriptions ORDER BY id")).rows)
        .toEqual([{ id: 1, state: "legacy_frozen" }, { id: 2, state: "pending_acquisition" }]);
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each([
    ["other default", ASSIGNMENT_ADD + ASSIGNMENT_SWITCH.replace("pending_acquisition", "assigned_acquisition"), ""],
    ["other column", ASSIGNMENT_ADD.replace("offer_policy_assignment_state", "other_state") + ASSIGNMENT_SWITCH.replace("offer_policy_assignment_state", "other_state"), ""],
    ["other table", (ASSIGNMENT_ADD + ASSIGNMENT_SWITCH).replaceAll("public.subscriptions", "public.cat_parameters"), ""],
    ["nullable column", ASSIGNMENT_ADD.replace(" NOT NULL", "") + ASSIGNMENT_SWITCH, ""],
    ["dropped default", ASSIGNMENT_ADD + ASSIGNMENT_SWITCH.replace("SET DEFAULT 'pending_acquisition'", "DROP DEFAULT"), ""],
    ["pre-existing column", ASSIGNMENT_SWITCH, ASSIGNMENT_ADD],
  ])("refuses assignment switch with %s in PostgreSQL", async (_label, sql, setup) => {
    await expect(checkForward(pool, ASSIGNMENT_SLOT, forward(CREATED_OK, sql), false, setup)).rejects.toThrow(/assignment default switch/u);
  });
  }
  it("admits only the pinned baseline service grant and SELECT/INSERT policies", async () => {
    await checkForward(pool, BASELINE_SLOT, forward(CREATED_OK, BASELINE_SQL));
  });
  it.skipIf(!serviceRole)("enforces baseline SELECT/INSERT and UPDATE/DELETE denial with NOBYPASSRLS", async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("ALTER ROLE service_role NOBYPASSRLS");
      await db.query(BASELINE_SQL);
      await db.query("SET LOCAL ROLE service_role");
      await db.query("INSERT INTO public.commerce_offer_policy_rollout_baselines VALUES (1)");
      expect((await db.query("SELECT id FROM public.commerce_offer_policy_rollout_baselines")).rows).toEqual([{ id: 1 }]);
      expect((await db.query("SELECT row_security_active('public.commerce_offer_policy_rollout_baselines') AS active")).rows[0].active).toBe(true);
      for (const sql of ["UPDATE public.commerce_offer_policy_rollout_baselines SET id=2", "DELETE FROM public.commerce_offer_policy_rollout_baselines"]) {
        await db.query("SAVEPOINT denied");
        await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
        await db.query("ROLLBACK TO SAVEPOINT denied");
      }
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each([
    ["UPDATE grant", BASELINE_SQL.replace("SELECT, INSERT ON TABLE", "SELECT, INSERT, UPDATE ON TABLE")],
    ["DELETE grant", BASELINE_SQL.replace("SELECT, INSERT ON TABLE", "SELECT, INSERT, DELETE ON TABLE")],
    ["grant option", BASELINE_SQL.replace("TO service_role;", "TO service_role WITH GRANT OPTION;")],
    ["browser grant", BASELINE_SQL + "GRANT SELECT ON TABLE public.commerce_offer_policy_rollout_baselines TO authenticated;"],
    ["broader policy", BASELINE_SQL.replace("FOR SELECT TO service_role USING (true)", "FOR ALL TO service_role USING (true)")],
    ["other policy role", BASELINE_SQL.replace("FOR INSERT TO service_role", "FOR INSERT TO authenticated")],
    ["other table", BASELINE_SQL.replaceAll("public.commerce_offer_policy_rollout_baselines", "public.cat_other_baseline")],
    ["RLS disabled", BASELINE_SQL.replace("ENABLE ROW", "DISABLE ROW")],
  ].filter(([label]) => serviceRole || ["other table", "browser grant", "RLS disabled"].includes(label!)))("refuses baseline %s in PostgreSQL", async (_label, sql) => {
    await expect(checkForward(pool, BASELINE_SLOT, forward(CREATED_OK, sql))).rejects.toThrow(/baseline|grants/u);
  });
  it.each((serviceRole ? ["UPDATE", "DELETE", "REFERENCES", "TRIGGER"] : []))("refuses appended baseline %s table privileges in PostgreSQL", async privilege => {
    const grant = `GRANT ${privilege} ON TABLE public.commerce_offer_policy_rollout_baselines TO service_role;`;
    await expect(checkForward(pool, BASELINE_SLOT, forward(CREATED_OK, BASELINE_SQL + grant))).rejects.toThrow(/baseline exceeds its pinned/u);
  });
  it.each((serviceRole ? ["SELECT", "INSERT", "UPDATE", "REFERENCES"] : []))("refuses baseline %s column privileges through the generic catalog guard", async privilege => {
    const grant = `GRANT ${privilege} (id) ON TABLE public.commerce_offer_policy_rollout_baselines TO service_role;`;
    await expect(checkForward(pool, BASELINE_SLOT, forward(CREATED_OK, BASELINE_SQL + grant))).rejects.toThrow(/new relation public\.commerce_offer_policy_rollout_baselines has column privileges/u);
  });
  it.each((serviceRole ? ["DELETE", "TRIGGER"] : []))("refuses invalid baseline %s column GRANT syntax in PostgreSQL", async privilege => {
    const grant = `GRANT ${privilege} (id) ON TABLE public.commerce_offer_policy_rollout_baselines TO service_role;`;
    await expect(checkForward(pool, BASELINE_SLOT, forward(CREATED_OK, BASELINE_SQL + grant))).rejects.toThrow(/invalid privilege type .* for column/u);
  });
  it("replays every unbound native chain unit", () => { expect(replay.applied).toBe(chain.length); });
  it("records the legacy grant fixture with zero grants and preserves inventory with the login absent", async () => {
    const db = await pool.connect();
    try {
      const before = await readSelectedCatalogProjection(db);
      expect(before.roles.some(role => role.identity.name === "openlup_checkout_owner")).toBe(false);
      await db.query("BEGIN");
      await db.query(`CREATE TABLE public.platform_schema_migrations (catalog_path text, sha256 text, position integer);
        CREATE ROLE openlup_checkout_owner LOGIN NOINHERIT`);
      const bind = (path: string, bytes: string, position: number) => db.query("INSERT INTO public.platform_schema_migrations VALUES($1,$2,$3)", [path, sqlSha256(bytes), position]);
      await bind(PLATFORM_BASELINE_FILE, readFileSync(PLATFORM_BASELINE_FILE, "utf8"), 0);
      await db.query(definitionSql);
      await db.query("SAVEPOINT legacy_grant");
      await db.query(grantSql);
      await bind(grantPath, grantSql, 1);
      expect((await db.query("SELECT catalog_path FROM public.platform_schema_migrations WHERE position=1")).rows).toEqual([{ catalog_path: grantPath }]);
      const access = async () => (await db.query(`SELECT count(*)::int AS grants FROM pg_catalog.pg_proc
        WHERE proname LIKE 'catalog_admission_%' AND pg_catalog.has_function_privilege('openlup_checkout_owner',oid,'EXECUTE')`)).rows;
      expect(await access()).toEqual([{ grants: 0 }]);
      await db.query("ROLLBACK TO SAVEPOINT legacy_grant");
      if (manifest.schemaVersion === 1) throw new Error("Qualified fixture requires a qualified baseline");
      const qualified = manifest.qualified.baseline;
      await db.query("UPDATE public.platform_schema_migrations SET catalog_path=$1,sha256=$2 WHERE position=0", [qualified.file, qualified.sha256]);
      await bind(definitionPath, definitionSql, 1);
      await db.query("ALTER ROLE openlup_checkout_owner NOLOGIN");
      await db.query("SAVEPOINT unready_grant");
      await expect(db.query(grantSql)).rejects.toThrow("checkout_owner_login_unready");
      await db.query("ROLLBACK TO SAVEPOINT unready_grant");
      expect(await access()).toEqual([{ grants: 0 }]);
      expect((await db.query("SELECT count(*)::int AS count FROM public.platform_schema_migrations")).rows).toEqual([{ count: 2 }]);
      await db.query("ROLLBACK");
      expect((await readSelectedCatalogProjection(db)).digest).toBe(before.digest);
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it("proves every receipt-backed preview acceptance combination on the installed chain", () => {
    if (replay.previewAcceptanceError) throw replay.previewAcceptanceError;
    expect(replay.previewAcceptanceError).toBeNull();
  });
  it.each(serviceRole ? previewPreimageProbes : [])("checks the preview preimage with $label", ({ label, drift }) => {
    const error = replay.preimageProbeErrors.get(label);
    if (drift) expect(error?.message).toContain(drift);
    else {
      if (error) throw error;
      expect(error).toBeNull();
    }
  });
  it("allows only the pinned function setting and requires identical membership rows for an owner window", async () => {
    const signature = "public.cat_replaced(text,boolean)", role = "authenticated";
    const settings = [{ signature, searchPath: "pg_catalog, pg_temp" }];
    const slot: CatalogSlot = {
      createdFunctions: [], replacedFunctions: [], grantOnlyFunctions: [], ownerWindowRole: role, settingsOnlyFunctions: settings,
    };
    const sql = renderNativeStoreSettingsOwnerWindow(settings, role);
    const membership = "GRANT authenticated TO anon";
    const setup = `ALTER FUNCTION ${signature} SET search_path = pg_catalog; ${membership};`;
    await checkForward(pool, slot, sql, false, setup);
    await expect(checkForward(pool, slot, `${sql}REVOKE authenticated FROM anon; ${membership};`, false, setup))
      .rejects.toThrow("pg_auth_members changed during the settings-only forward");
  });
  it("admits only the client census column and SELECT policy on a new block-classified table", async () => {
    await checkForward(pool, CENSUS_SLOT, forward(CREATED_OK, CENSUS_SQL));
  });
  it.each(["retain", "block"])("admits an unlisted %s client table with owner-only privileges", async disposition => {
    await checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, classifiedClientTable(disposition)));
  });
  it.each(["retain", "block"])("uses raw relname for a quoted client table's %s classification", async disposition => {
    await checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, classifiedQuotedClientTable(disposition)));
  });
  it("admits the earlier class-created reminder at creation and rolls the probes back before continuing", () => {
    expect(replay.outcomes.get(reminderCreation.pin.path)).toBeNull();
    expect(replay.creationOutcomes.get("positive")).toBeNull();
    expect(replay.creationOutcomes.get("rollback")).toBeNull();
  });
  it.each(["unlisted", "header", "signature", "owner", "ACL"])("refuses a class-created reminder replacement with changed %s at creation", change => {
    expect(replay.creationOutcomes.get(change)).toBeInstanceOf(Error);
    expect(replay.creationOutcomes.get(change)?.message).toMatch(/catalog:/u);
  });
  const storageSlot: CatalogSlot = { createdFunctions: [], replacedFunctions: [], grantOnlyFunctions: [] };
  const storageEntries = Object.entries(NATIVE_SUCCESSOR_TABLE_SQL);
  const storageBase = `ALTER TABLE public.subscriptions ALTER COLUMN id TYPE uuid USING NULL::uuid;
    ${["catalog_skus", "catalog_publications", "subscription_stock_wait_cases", "subscription_renewal_operations", "subscription_cycles", "commerce_orders", "commerce_settlement_intents", "fulfillment_shipments"].map(name => `CREATE TABLE public.${name}(id uuid PRIMARY KEY, other_id uuid UNIQUE, UNIQUE(id,other_id));`).join("\n")}
    INSERT INTO public.client_absorption_policy VALUES ('subscription_successor_proposals','block',NULL),('subscription_successor_wait_cases_v2','block',NULL);`;
  const storageCreate = storageEntries.map(([name, statement]) => `${statement}\nALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;\nREVOKE ALL ON TABLE ${name} FROM PUBLIC;`).join("\n");
  it("admits a conforming forward", async () => { await checkForward(pool, SYNTHETIC_SLOT, CONFORMING); });

  const qualifiedSignature = "public.catalog_price_setup_region_code()";
  const qualifiedSearchPath = "pg_catalog, pg_temp";
  const authorityPath = catalogueAuthorityPath;
  const authorityHash = sqlSha256(readFileSync(authorityPath));
  const authorityLedger = "CREATE TABLE public.platform_schema_migrations (catalog_path text PRIMARY KEY, sha256 text NOT NULL, position integer NOT NULL UNIQUE);";
  const authorityRow = `INSERT INTO public.platform_schema_migrations (catalog_path, sha256, position) VALUES ('${authorityPath}', '${authorityHash}', 0);`;
  const securityPreimage = `CREATE FUNCTION ${qualifiedSignature} RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path = ${qualifiedSearchPath} AS $$ SELECT 'before' $$;`;
  const securityReplacement = securityPreimage.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("'before'", "'after'");
  const securityForward = `${securityReplacement}\n${renderQualifiedSecurityDefiner(qualifiedSignature)}`;
  const nativeSecuritySetup = `${authorityLedger}
    ${securityPreimage}`;
  const qualifiedSecuritySetup = `${nativeSecuritySetup}
    ${authorityRow}
    ALTER FUNCTION ${qualifiedSignature} SECURITY DEFINER;`;
  const securitySlot: CatalogSlot = {
    ...storageSlot,
    replacedFunctions: [{ signature: qualifiedSignature, beforeSha256: sqlSha256(securityPreimage), searchPath: qualifiedSearchPath, qualifiedSecurityDefiner: true }],
  };
  const storageSelectSlot: CatalogSlot = { replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], qualifiedCatalogueStorageSelect: true };
  const storageSelectTable = "CREATE TABLE public.catalog_sku_revisions (digest text);";
  const storageSelectForward = `ALTER TABLE public.catalog_sku_revisions ADD COLUMN net_content_storage text;
${qualifiedCatalogueStorageSelectSql}`;
  it.each(["qualified", "unpinned", "role absent", "wrong hash"])("admits only the qualified storage ACL (%s)", async mode => {
    await checkForward(pool, storageSelectSlot, storageSelectForward, false, `${authorityLedger}
      ${storageSelectTable}
      ${mode === "role absent" ? "" : "CREATE ROLE openlup_catalog_publication;"}
      ${mode === "qualified" || mode === "role absent" ? authorityRow : mode === "wrong hash" ? authorityRow.replace(authorityHash, "0".repeat(64)) : ""}`);
  });
  it.each(["GRANT SELECT ON public.catalog_sku_revisions TO openlup_catalog_publication;",
    "GRANT UPDATE(net_content_storage) ON public.catalog_sku_revisions TO openlup_catalog_publication;",
    "GRANT SELECT(net_content_storage) ON public.catalog_sku_revisions TO openlup_catalog_publication WITH GRANT OPTION;",
    "GRANT SELECT(digest) ON public.catalog_sku_revisions TO openlup_catalog_publication;"])("rejects extra storage ACL %s", async extra => {
    await expect(checkForward(pool, storageSelectSlot, `${storageSelectForward}
${extra}`, false,
      `${authorityLedger}${authorityRow}${storageSelectTable}CREATE ROLE openlup_catalog_publication;`)).rejects.toThrow(/column ACLs/u);
  });
  it("preserves installed SECURITY INVOKER without the qualified authority row", async () => {
    await checkForward(pool, securitySlot, securityForward, false, nativeSecuritySetup);
  });
  it("preserves installed SECURITY DEFINER with the exact qualified authority row", async () => {
    await checkForward(pool, securitySlot, securityForward, false, qualifiedSecuritySetup);
  });
  it("preserves SECURITY DEFINER and the search_path rewritten by the qualified authority", async () => {
    const signature = "public.catalog_publication_record_command(jsonb)";
    const nativeSearchPath = "pg_catalog, public";
    const searchPath = `${nativeSearchPath}, pg_temp`;
    const preimage = `CREATE FUNCTION ${signature} RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path = ${nativeSearchPath} AS $$ SELECT 'before' $$;`;
    const setup = `${authorityLedger}
      ${preimage}
      ALTER FUNCTION ${signature} SET search_path = ${searchPath};
      ALTER FUNCTION ${signature} SECURITY DEFINER;
      ${authorityRow}`;
    const replacement = preimage.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace(nativeSearchPath, searchPath).replace("'before'", "'after'");
    const slot: CatalogSlot = {
      ...storageSlot,
      replacedFunctions: [{ signature, beforeSha256: sqlSha256(preimage), searchPath, qualifiedSecurityDefiner: true }],
    };
    await checkForward(pool, slot, `${replacement}\n${renderQualifiedSecurityDefiner(signature)}`, false, setup);
  });
  it("detects loss of SECURITY DEFINER if the qualified statement is omitted", async () => {
    await expect(checkForward(pool, securitySlot, securityReplacement, false, qualifiedSecuritySetup))
      .rejects.toThrow(`replaced function ${qualifiedSignature} must preserve its installed SECURITY DEFINER mode`);
  });

  it("admits only the named new table runtime ACL and policy", async () => { await checkForward(pool, NOTICE_SLOT, forward(CREATED_OK, NOTICE_SQL)); });
  it("proves successor storage keeps the listed absorption census exception", async () => {
    const tables = ["public.subscription_successor_proposals", "public.subscription_successor_wait_cases_v2"];
    const census = serviceRole ? tables.map(name => `GRANT SELECT(client_id) ON ${name} TO service_role; CREATE POLICY ${name.slice(7)}_absorption_census ON ${name} FOR SELECT TO service_role USING (true);`).join("\n") : "";
    await checkForward(pool, { ...storageSlot, absorptionCensusTables: tables }, storageCreate + census, false, storageBase);
  });
  it.each(REFUSALS.filter(([label, , , needsServiceRole]) => serviceRole || (!needsServiceRole && label.includes("census"))))("refuses %s", async (_name, sql, message, _needsServiceRole, slot) => {
    await expect(checkForward(pool, slot, sql)).rejects.toThrow(message);
  });
  it.each(bound)("holds the catalog boundary of $pin.path", ({ pin }) => {
    expect(replay.outcomes.get(pin.path), pin.path).toBeNull();
  });

  if (serviceRole) {
  it("installs two replacement slots with pinned bodies and unchanged function attributes and ACL", async () => {
    const db = await pool.connect(), signature = "public.cat_replaced(text,boolean)";
    const definition = (body: string) => `CREATE OR REPLACE FUNCTION public.cat_replaced(p text, q boolean DEFAULT false) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$${body}$$;`;
    const original = sqlStatements(SYNTHETIC_BASE).find(statement => statement.startsWith("CREATE FUNCTION public.cat_replaced("))!;
    let beforeSha256 = sqlSha256(original);
    try {
      await db.query("BEGIN");
      let before = await pinned(db, () => snapshot(db));
      const migrationRole = String((await db.query("SELECT current_user::text AS role")).rows[0].role);
      for (const body of [" SELECT 'first replacement' ", " SELECT 'second replacement' "]) {
        const statement = definition(body), afterSha256 = sqlSha256(statement);
        const slot: CatalogSlot = { createdFunctions: [], replacedFunctions: [{ signature, beforeSha256, searchPath: "pg_catalog, pg_temp" }], grantOnlyFunctions: [] };
        await db.query(statement);
        const after = await pinned(db, () => snapshot(db));
        await pinned(db, async () => assertSlotCatalog(db, slot, before, after, migrationRole));
        const installed = after.functions.find(fn => fn.oid === before.functions.find(fn => fn.name === "public.cat_replaced(text,boolean)")!.oid)!;
        expect(installed.src).toBe(body);
        // afterSha256 binds a split statement; combine its fixed header with PostgreSQL's exact installed body.
        expect(sqlSha256(definition(installed.src))).toBe(afterSha256);
        before = after; beforeSha256 = afterSha256;
      }
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each(["header", "ACL"])("refuses a second replacement that changes its %s", async change => {
    const statement = REPLACE_PART.replace("'after'", "'second replacement'");
    const sql = change === "header" ? statement.replace("LANGUAGE sql", "LANGUAGE sql STABLE") : `${statement} GRANT EXECUTE ON FUNCTION public.cat_replaced(text,boolean) TO authenticated;`;
    const slot: CatalogSlot = { createdFunctions: [], replacedFunctions: SYNTHETIC_SLOT.replacedFunctions, grantOnlyFunctions: [] };
    await expect(checkForward(pool, slot, sql, false, REPLACE_PART)).rejects.toThrow(/changed attributes or ACL/u);
  });
  it("drops a listed standalone index, preserving its table, constraints, other indexes and ACL", async () => {
    await checkForward(pool, DROP_INDEX_SLOT, forward(CREATED_OK, DROP_INDEX_SQL));
  });
  it("drops two listed standalone indexes of one table", async () => {
    await checkForward(pool, DROP_TWO_INDEXES_SLOT, forward(CREATED_OK, `${DROP_INDEX_SQL} DROP INDEX public.cat_other_idx;`));
  });
  it("refuses a listed index that history rebuilt without naming it", async () => {
    const rebuilt = "DO $$ BEGIN EXECUTE 'DROP INDEX public.cat_' || 'active_idx'; EXECUTE 'CREATE UNIQUE INDEX cat_' || 'active_idx ON public.cat_parameters (extra)'; END $$;";
    await expect(checkForward(pool, DROP_INDEX_SLOT, forward(CREATED_OK, DROP_INDEX_SQL), false, rebuilt)).rejects.toThrow(/differs from its pinned CREATE/u);
  });
  it.each([
    ["missing drop", "", /must be a removed standalone index/u],
    ["recreated listed name", `${DROP_INDEX_SQL} CREATE INDEX cat_active_idx ON public.cat_parameters (id);`, /must be a removed standalone index/u],
    ["renamed instead of dropped", "ALTER INDEX public.cat_active_idx RENAME TO cat_renamed_idx;", /must be a removed standalone index/u],
    ["added column", `${DROP_INDEX_SQL} ALTER TABLE public.cat_parameters ADD COLUMN unexpected text;`, /changed columns/u],
    ["column default", `${DROP_INDEX_SQL} ALTER TABLE public.cat_parameters ALTER COLUMN status SET DEFAULT 'open';`, /changed columns/u],
    ["dropped constraint", `${DROP_INDEX_SQL} ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status;`, /changed constraints/u],
    ["added constraint", `${DROP_INDEX_SQL} ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_unlisted CHECK (kind IS NOT NULL);`, /changed constraints/u],
    ["other index dropped", `${DROP_INDEX_SQL} DROP INDEX public.cat_other_idx;`, /other index .* changed/u],
    ["other index altered", `${DROP_INDEX_SQL} ALTER INDEX public.cat_other_idx SET (fillfactor=80);`, /other index .* changed/u],
    ["table ACL", `${DROP_INDEX_SQL} GRANT SELECT ON public.cat_parameters TO authenticated;`, /existing relation .* changed/u],
  ] as const)("refuses a listed index drop with %s", async (_label, sql, error) => {
    await expect(checkForward(pool, DROP_INDEX_SLOT, forward(CREATED_OK, sql))).rejects.toThrow(error);
  });
  it.each(["missing index", "different table", "unlisted"])("refuses a catalog drop with %s inventory", async attack => {
    const slot = structuredClone(DROP_INDEX_SLOT);
    if (attack === "missing index") slot.droppedIndexes![0]!.name = "cat_missing_idx";
    if (attack === "different table") slot.droppedIndexes![0]!.table = "public.cat_existing_table";
    if (attack === "unlisted") delete slot.droppedIndexes;
    await expect(checkForward(pool, slot, forward(CREATED_OK, DROP_INDEX_SQL))).rejects.toThrow(/must be a removed standalone index|existing relation .* changed/u);
  });
  it.each([
    ["cat_existing_table", "cat_existing_table_pkey", ""],
    ["cat_parameters", "cat_key", ""],
    ["cat_exclusion", "cat_exclusion_key", "CREATE TABLE public.cat_exclusion (span int4range, CONSTRAINT cat_exclusion_key EXCLUDE USING gist (span WITH &&));"],
    ["cat_parameters", "cat_adopted_idx", "CREATE UNIQUE INDEX cat_adopted_idx ON public.cat_parameters (status); ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_adopted_idx UNIQUE USING INDEX cat_adopted_idx;"],
  ] as const)("refuses a constraint-backed index (%s %s)", async (table, name, setup) => {
    const slot = { ...SYNTHETIC_SLOT, droppedIndexes: [{ table: `public.${table}`, name, beforeSha256: "0".repeat(64) }] };
    await expect(checkForward(pool, slot, forward(CREATED_OK, `ALTER TABLE public.${table} DROP CONSTRAINT ${name} CASCADE;`), false, setup)).rejects.toThrow(/must be a removed standalone index/u);
  });
  it("admits a widened purpose CHECK that its slot lists", async () => { await checkForward(pool, PURPOSE_SLOT, forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c'))"))); });
  it("admits multiple named CHECK widenings after unrelated additive DDL", async () => {
    await checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, PARAMETER_CHECKS), false, "ALTER TABLE public.cat_parameters ADD COLUMN unrelated uuid; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_unrelated CHECK (unrelated IS NULL) NOT VALID;");
  });
  it.each(["days BETWEEN 1 AND 3660", "days >= 1 AND days <= 3660"])("proves a strict integer range superset and its installed catalog: %s", async expression => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(RANGE_SETUP + "INSERT INTO public.cat_range(days) VALUES (1), (90)");
      const before = await pinned(db, () => snapshot(db));
      expect(before.constraints.find(row => row.rel === "public.cat_range")?.def).toBe(RANGE_DEFINITION);
      const migrationRole = String((await db.query("SELECT current_user::text AS role")).rows[0].role);
      await db.query(rangeReplacement(expression));
      const after = await pinned(db, () => snapshot(db));
      await pinned(db, () => assertSlotCatalog(db, rangeSlot(), before, after, migrationRole));
      expect(after.constraints.find(row => row.rel === "public.cat_range")).toMatchObject({ name: "cat_days", validated: true, def: "CHECK (((days >= 1) AND (days <= 3660)))" });
      expect(after.relations.find(row => row.name === "public.cat_range")).toEqual(before.relations.find(row => row.name === "public.cat_range"));
      await db.query("INSERT INTO public.cat_range(days) VALUES (91), (3660), (NULL)");
      for (const days of [0, 3661]) {
        await db.query("SAVEPOINT denied");
        await expect(db.query("INSERT INTO public.cat_range(days) VALUES ($1)", [days])).rejects.toMatchObject({ code: "23514", constraint: "cat_days" });
        await db.query("ROLLBACK TO SAVEPOINT denied");
      }
      expect((await db.query("SELECT days FROM public.cat_range ORDER BY days NULLS LAST")).rows.map(row => row.days)).toEqual([1, 90, 91, 3660, null]);
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each([[0, 90], [1, 91], [-2147483648, 2147483647]])("admits widening either endpoint to %i..%i", async (lower, upper) => {
    await checkForward(pool, rangeSlot(lower, upper), rangeReplacement(`days BETWEEN ${lower} AND ${upper}`), false, RANGE_SETUP);
  });
  it("compares a signed installed preimage", async () => {
    await checkForward(pool, rangeSlot(-2, 91, "CHECK (((days >= '-1'::integer) AND (days <= 90)))"), rangeReplacement("days >= -2 AND days <= 91"), false, RANGE_SETUP.replace("BETWEEN 1", "BETWEEN -1"));
  });
  it("preserves NOT VALID and historical rows outside the widened range", async () => {
    const setup = "CREATE TABLE public.cat_range(days integer, other_days integer); INSERT INTO public.cat_range(days) VALUES (4000); ALTER TABLE public.cat_range ADD CONSTRAINT cat_days CHECK (days BETWEEN 1 AND 90) NOT VALID;";
    await checkForward(pool, rangeSlot(1, 3660, RANGE_DEFINITION + " NOT VALID"), rangeReplacement(undefined, " NOT VALID"), false, setup);
  });
  it.each([[2, 3660], [1, 89], [0, 89], [2, 4000], [1, 90]])("refuses a declared range that is not a strict superset: %i..%i", async (lower, upper) => {
    await expect(checkForward(pool, rangeSlot(lower, upper), rangeReplacement(`days BETWEEN ${lower} AND ${upper}`), false, RANGE_SETUP)).rejects.toThrow(/strict widening/u);
  });
  it.each([false, true])("refuses range validation state changes from %s", async validated => {
    const setup = validated ? RANGE_SETUP : RANGE_SETUP + "ALTER TABLE public.cat_range DROP CONSTRAINT cat_days; ALTER TABLE public.cat_range ADD CONSTRAINT cat_days CHECK (days BETWEEN 1 AND 90) NOT VALID;";
    await expect(checkForward(pool, rangeSlot(1, 3660, RANGE_DEFINITION + (validated ? "" : " NOT VALID")), rangeReplacement(undefined, validated ? " NOT VALID" : ""), false, setup)).rejects.toThrow(/validation state/u);
  });
  it.each([
    "days BETWEEN 1 AND 3661", "other_days BETWEEN 1 AND 3660", "days BETWEEN 1.5 AND 3660",
    "days BETWEEN 1 AND 3660 OR true", "days BETWEEN 1 AND 3660 AND other_days > 0",
  ])("refuses installed range drift: %s", async expression => {
    await expect(checkForward(pool, rangeSlot(), rangeReplacement(expression), false, RANGE_SETUP)).rejects.toThrow(/strict widening/u);
  });
  it("refuses a missing or mismatched installed preimage", async () => {
    await expect(checkForward(pool, rangeSlot(), rangeReplacement(), false, RANGE_SETUP.replace("AND 90", "AND 89"))).rejects.toThrow(/preimage mismatch/u);
    await expect(checkForward(pool, rangeSlot(), rangeReplacement().split("\n")[1]!, false, "CREATE TABLE public.cat_range(days integer, other_days integer)")).rejects.toThrow(/preimage mismatch/u);
  });
  it.each(["numeric", "bigint", "text"])("refuses a non-int4 column: %s", async type => {
    const setup = RANGE_SETUP.replaceAll("integer", type).replace("days BETWEEN 1 AND 90", "days BETWEEN '1' AND '90'");
    const db = await pool.connect();
    try {
      await db.query("BEGIN"); await db.query(setup);
      const before = await pinned(db, () => snapshot(db));
      const def = before.constraints.find(row => row.rel === "public.cat_range")!.def;
      const migrationRole = String((await db.query("SELECT current_user::text AS role")).rows[0].role);
      await db.query(rangeReplacement("days BETWEEN '1' AND '3660'"));
      await expect(pinned(db, async () => assertSlotCatalog(db, rangeSlot(1, 3660, def), before, await snapshot(db), migrationRole))).rejects.toThrow(/existing integer column/u);
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each(["ALTER TABLE public.cat_range OWNER TO authenticated;", "GRANT SELECT ON public.cat_range TO PUBLIC;", "GRANT UPDATE(days) ON public.cat_range TO authenticated;"])("preserves range table owner and ACLs: %s", async mutation => {
    await expect(checkForward(pool, rangeSlot(), rangeReplacement() + mutation, false, RANGE_SETUP)).rejects.toThrow(/catalog:/u);
  });
  it("preserves an unvalidated CHECK while widening without rechecking historical rows", async () => {
    const setup = UNVALIDATED_PARAMETER_SETUP.replace("ALTER TABLE public.cat_parameters ADD", "INSERT INTO public.cat_parameters(status) VALUES ('historical'); ALTER TABLE public.cat_parameters ADD");
    await checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, UNVALIDATED_PARAMETER_CHECKS), false, setup);
  });
  it.each([
    { beforeValidated: false, afterValidated: true },
    { beforeValidated: true, afterValidated: false },
  ])("refuses CHECK validation state $beforeValidated -> $afterValidated", async ({ beforeValidated, afterValidated }) => {
    await expect(checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, afterValidated ? PARAMETER_CHECKS : UNVALIDATED_PARAMETER_CHECKS), false,
      beforeValidated ? "" : UNVALIDATED_PARAMETER_SETUP)).rejects.toThrow(/CHECK changed its validation state/u);
  });
  it("refuses a narrowed unvalidated CHECK even when its ADD exactly matches its slot", async () => {
    const slot = { ...PARAMETER_SLOT, checkSupersets: [{ ...PARAMETER_SLOT.checkSupersets![0]!, values: ["open", "paused"] }, PARAMETER_SLOT.checkSupersets![1]!] };
    await expect(checkForward(pool, slot, forward(CREATED_OK, UNVALIDATED_PARAMETER_CHECKS.replace("'open','closed','paused'", "'open','paused'")), false,
      UNVALIDATED_PARAMETER_SETUP)).rejects.toThrow(/CHECK changed beyond its listed widening/u);
  });
  it.each(["before", "after"])("refuses a non-list unvalidated CHECK %s the slot", async side => {
    const setup = side === "before" ? UNVALIDATED_PARAMETER_SETUP.replace("status IN ('open','closed')", "status <> 'blocked'") : UNVALIDATED_PARAMETER_SETUP;
    const sql = side === "after" ? UNVALIDATED_PARAMETER_CHECKS.replace("status IN ('open','closed','paused')", "status <> 'blocked'") : UNVALIDATED_PARAMETER_CHECKS;
    await expect(checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, sql), false, setup)).rejects.toThrow(/CHECK changed beyond its listed widening/u);
  });
  it("refuses a narrowed CHECK even when its ADD exactly matches its slot", async () => {
    const slot = { ...SYNTHETIC_SLOT, checkSupersets: [{ ...PARAMETER_SLOT.checkSupersets![0]!, values: ["open", "paused"] }] };
    const sql = PARAMETER_CHECKS.split(" ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_kind")[0]!.replace("'open','closed','paused'", "'open','paused'");
    await expect(checkForward(pool, slot, forward(CREATED_OK, sql))).rejects.toThrow(/CHECK changed/u);
  });
  it.each(["missing", "non-closed"])("refuses an installed CHECK that is %s before the slot", async shape => {
    const setup = `ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ${shape === "non-closed" ? "ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_status CHECK (status <> 'blocked');" : ""}`;
    const sql = shape === "missing" ? PARAMETER_CHECKS.replace("ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ", "") : PARAMETER_CHECKS;
    await expect(checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, sql), false, setup)).rejects.toThrow(/CHECK changed/u);
  });
  it("proves a UNIQUE superset and its exact NULLS mode in the installed catalog", async () => {
    await checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, UNIQUE_SQL));
    await expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, UNIQUE_SQL.replace(" NULLS NOT DISTINCT", "")))).rejects.toThrow(/UNIQUE changed/u);
  });
  it("refuses a dropped UNIQUE column even when its ADD exactly matches its slot", async () => {
    const slot = { ...UNIQUE_SLOT, uniqueSupersets: [{ ...UNIQUE_SLOT.uniqueSupersets![0]!, columns: ["extra"] }] };
    await expect(checkForward(pool, slot, forward(CREATED_OK, UNIQUE_SQL.replace("(id,extra)", "(extra)")))).rejects.toThrow(/UNIQUE changed/u);
  });
  it.each(["missing", "non-closed"])("refuses an installed UNIQUE that is %s before the slot", async shape => {
    const setup = `ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ${shape === "non-closed" ? "ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_key UNIQUE (id) DEFERRABLE;" : ""}`;
    await expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, shape === "missing" ? UNIQUE_SQL.replace("ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ", "") : UNIQUE_SQL), false, setup)).rejects.toThrow(/UNIQUE changed/u);
  });
  it("refuses removing NULLS NOT DISTINCT while admitting its addition", async () => {
    const slot = { ...UNIQUE_SLOT, uniqueSupersets: [{ ...UNIQUE_SLOT.uniqueSupersets![0]!, nullsNotDistinct: false }] };
    const setup = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_key UNIQUE NULLS NOT DISTINCT (id);";
    await expect(checkForward(pool, slot, forward(CREATED_OK, UNIQUE_SQL.replace(" NULLS NOT DISTINCT", "")), false, setup)).rejects.toThrow(/UNIQUE changed/u);
  });
  it("retains the existing DROP NOT NULL weakening beside a UNIQUE replacement", async () => {
    await checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, `${UNIQUE_SQL} ALTER TABLE public.cat_parameters ALTER COLUMN id DROP NOT NULL;`), false, "ALTER TABLE public.cat_parameters ALTER COLUMN id SET NOT NULL;");
  });
  it.each(["ALTER COLUMN status TYPE varchar", "ALTER COLUMN status SET DEFAULT 'closed'", "DROP COLUMN kind CASCADE"])("preserves other installed column facts during a listed widening: %s", change => {
    return expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, `${UNIQUE_SQL} ALTER TABLE public.cat_parameters ${change};`))).rejects.toThrow(/column .* changed/u);
  });
  it("preserves other installed constraints during a listed widening", async () => {
    await expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, `${UNIQUE_SQL} ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status;`))).rejects.toThrow(/constraint .* dropped or rewritten/u);
  });
  it("admits only a listed fresh view with owner-only privileges", async () => {
    const view = "CREATE VIEW public.cat_created_view AS SELECT id FROM public.cat_existing_table;";
    const slot = { ...SYNTHETIC_SLOT, createdViews: [{ name: "public.cat_created_view", sha256: sqlSha256(view) }] };
    await checkForward(pool, slot, forward(CREATED_OK, `${view} REVOKE ALL ON TABLE public.cat_created_view FROM PUBLIC;`));
    await expect(checkForward(pool, slot, forward(CREATED_OK, `${view} GRANT SELECT ON public.cat_created_view TO authenticated;`))).rejects.toThrow(/new relation .* grants/u);
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, view))).rejects.toThrow(/created views differ/u);
  });
  it("lets plain PostgreSQL DDL refuse duplicate views, duplicate triggers and missing targets", async () => {
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "CREATE VIEW public.cat_view AS SELECT id FROM public.cat_existing_table;"))).rejects.toThrow('relation "cat_view" already exists');
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "CREATE TRIGGER cat_base_trigger BEFORE INSERT ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();"))).rejects.toThrow('trigger "cat_base_trigger" for relation "cat_existing_table" already exists');
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "CREATE TRIGGER missing BEFORE INSERT ON public.cat_missing FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();"))).rejects.toThrow('relation "public.cat_missing" does not exist');
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "ALTER TABLE public.cat_missing ADD COLUMN extra text;"))).rejects.toThrow('relation "public.cat_missing" does not exist');
  });
  it("proves listed enabled row triggers and their owner-only invoker binding on existing tables", async () => {
    await checkForward(pool, TRIGGER_SLOT, forward(CREATED_OK, TRIGGER_SQL));
  });
  const successorCreate = `CREATE TABLE public.catalog_sku_successors (
    predecessor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
    successor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
    publication_id uuid NOT NULL REFERENCES public.catalog_publications(id) ON DELETE RESTRICT,
    PRIMARY KEY (predecessor_sku_id, successor_sku_id), CHECK (predecessor_sku_id <> successor_sku_id));`;
  const successorBase = `CREATE TABLE public.catalog_skus (id uuid PRIMARY KEY, other_id uuid UNIQUE, UNIQUE(id, other_id));
    CREATE TABLE public.catalog_publications (id uuid PRIMARY KEY);
    CREATE TABLE public.cat_other_skus (id uuid PRIMARY KEY);
    CREATE TABLE public.cat_other_publications (id uuid PRIMARY KEY);`;
  const pin = deferredPin(), statement = renderNativeDeferredTrigger(pin), long = "a".repeat(63);
  const forbidden = (entry = pin, name = entry.name, created = true) =>
    `deferred trigger ${entry.name} is pinned; only these statements may name ${name}: ${renderNativeDeferredTrigger(entry)}${created ? " " + deferredFunction.replace(";REVOKE", "; REVOKE") : ""} remove it, or rewrite it to exactly one of these`;
  const unterminated = `reviewed native store cannot scan ${DEFERRED_SLOT.path}: reviewed replacement SQL requires terminated statements`;
  const unregistered = `deferred trigger ${pin.name} is not registered; remove it`;
  const successor = deferredPin({ relation: "public.catalog_sku_successors" });
  const renamed = deferredPin({ relation: "public.cat_renamed", function: "public.cat_trigger_fn()" });
  const subset: NativeDeferredTrigger["events"][] = [["INSERT"], ["UPDATE"], ["DELETE"], ["INSERT", "UPDATE"], ["INSERT", "DELETE"], ["UPDATE", "DELETE"], pin.events];
  const inlineColumn = `ALTER TABLE public.cat_existing_table ADD COLUMN cohort integer CONSTRAINT ${pin.name} CHECK (true);`;
  const prefixPin = deferredPin({ function: "public.cat_trigger_fn()" }), freshPin = deferredPin({ relation: "public.cat_fresh" });
  const functionRule = `createdTriggers entry ${pin.name}: function must be a zero-argument public function of at most 63 bytes`;
  const triggerKeyword = (name: string) => `createdTriggers entry ${name}: name is a PostgreSQL keyword. Rename the trigger (for example, add a prefix) and register the new name.`;
  const quotedView = 'CREATE VIEW public.cat_quoted_view AS SELECT id AS ";" FROM public.cat_existing_table;';
  const viewUsingPinnedFunction = quotedView.replace(/;$/u, " WHERE public.cat_created_guard() IS NOT NULL;");
  const unreadable = `The statement cannot be checked for pinned objects. ${forbidden()}`;
  const quotedInsert = 'INSERT INTO public.fixture_data (";") VALUES (1);';
  type Fixture = { label: string; pins: NativeDeferredTrigger[]; sql?: string; setup?: string; prefixFunction?: boolean; functionSql?: string; refusal?: string; companions?: Partial<NativeStoreSlot> };
  const cases: Fixture[] = [
    ...subset.map(events => ({ label: events.join(" OR "), pins: [deferredPin({ events })] })),
    { label: "quoted semicolon view alias without a pin", pins: [], prefixFunction: true,
      sql: quotedView + "REVOKE ALL ON TABLE public.cat_quoted_view FROM PUBLIC;",
      companions: { createdViews: [{ name: "public.cat_quoted_view", sha256: sqlSha256(quotedView) }] } },
    { label: "quoted semicolon INSERT column without a pin", pins: [], prefixFunction: true, sql: quotedInsert,
      setup: 'CREATE TABLE public.fixture_data (";" integer);', companions: { dataStatements: [quotedInsert] } },
    ...[viewUsingPinnedFunction, quotedView].map(view => ({
      label: view === quotedView ? "unrelated quoted semicolon view with a pin" : "quoted semicolon view referencing the pinned function",
      pins: [pin], sql: statement + view + "REVOKE ALL ON TABLE public.cat_quoted_view FROM PUBLIC;", refusal: unreadable,
      companions: { createdViews: [{ name: "public.cat_quoted_view", sha256: sqlSha256(view) }] },
    })),
    ...[
      ["Unicode-escaped pinned function in a view", quotedView.replace('AS ";"', "AS item_id")
        .replace(/;$/u, ` WHERE public.U&"!0063at_created_guard" UESCAPE '!'() IS NOT NULL;`)],
      ["Unicode-escaped unrelated alias in a view", quotedView.replace('AS ";"', `AS u&"!0069tem_id" UESCAPE '!'`)],
      ["Unicode-escaped string in a view", quotedView.replace('id AS ";"', "U&'sample' AS label")],
    ].map(([label, view]) => ({
      label: label!, pins: [pin], sql: statement + view + "REVOKE ALL ON TABLE public.cat_quoted_view FROM PUBLIC;", refusal: unreadable,
      companions: { createdViews: [{ name: "public.cat_quoted_view", sha256: sqlSha256(view!) }] },
    })),
    { label: "quoted semicolon inside a role privilege block", pins: [pin],
      sql: statement + guarded("authenticated", "REVOKE ALL ON FUNCTION", 'public.";"() FROM authenticated;'), refusal: unreadable },
    { label: "quoted semicolon in a companion CHECK", pins: [pin], setup: 'ALTER TABLE public.cat_existing_table ADD COLUMN ";" integer;',
      sql: statement + `ALTER TABLE public.cat_existing_table ADD CONSTRAINT ${pin.name} CHECK (";" > 0);`, refusal: unreadable },
    { label: "drifted function body with the pinned signature", pins: [pin], functionSql: deferredFunction.replace("RETURN NEW", "RETURN NULL"),
      refusal: "reviewed native store unlisted, missing or drifted function definition" },
    { label: "restored function body with the pinned signature", pins: [pin] },
    { label: "63-byte name", pins: [deferredPin({ name: long })] },
    ...["select", "between"].map(name => ({ label: `keyword trigger name ${name}`, pins: [deferredPin({ name })],
      refusal: triggerKeyword(name) })),
    ...["replace", "between"].map(name => ({ label: `keyword function name ${name}`, pins: [deferredPin({ function: `public.${name}()` })], prefixFunction: true,
      setup: `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;`,
      refusal: `createdTriggers entry ${pin.name}: function name is a PostgreSQL keyword. Rename the function (for example, add a prefix) and register the new name.` })),
    { label: "64-byte name", pins: [deferredPin({ name: long + "a" })], refusal: `createdTriggers entry ${long}a: name must be an unquoted identifier of at most 63 bytes` },
    { label: "64-byte relation", pins: [deferredPin({ relation: "public." + long + "a" })], refusal: `createdTriggers entry ${pin.name}: relation must be a public relation with an identifier of at most 63 bytes` },
    { label: "64-byte function", pins: [deferredPin({ function: "public." + long + "a()" })], refusal: functionRule },
    { label: "array function", pins: [{ ...pin, function: [pin.function] as unknown as string }], sql: statement, refusal: functionRule },
    { label: "unregistered", pins: [], sql: statement, refusal: `${unregistered}, or register it and use the statement the registry renders` },
    { label: "unregistered initially immediate", pins: [], sql: statement.replace("INITIALLY DEFERRED", "INITIALLY IMMEDIATE"), refusal: unregistered },
    { label: "unregistered with WHEN", pins: [], sql: statement.replace("EXECUTE FUNCTION", "WHEN (true) EXECUTE FUNCTION"), refusal: unregistered },
    ...['"cat space"', "CatUpper", "select", long + "a"].map(name => ({ label: `unregistered invalid name ${name}`, pins: [], sql: statement.replace(pin.name, name),
      refusal: `deferred trigger ${name.replaceAll('"', "")} is not registered; rename it to a lowercase, unquoted, non-keyword identifier of at most 63 bytes and add it to createdTriggers` })),
    { label: "missing statement", pins: [pin], sql: "", refusal: `reviewed native store created trigger statement missing: ${pin.name}` },
    { label: "stale statement hash", pins: [{ ...pin, sha256: "0".repeat(64) }], refusal: `deferred trigger ${pin.name}: update sha256 in its createdTriggers entry to ${pin.sha256}` },
    { label: "duplicate statement", pins: [pin], sql: statement + statement, refusal: forbidden() },
    ...[inlineColumn, inlineColumn.replace(" CONSTRAINT", ", ADD CONSTRAINT")].map(sql => ({ label: sql === inlineColumn ? "inline column CHECK" : "second ALTER action",
      pins: [pin], sql: statement + sql, companions: { existingTableStatements: [sql] }, refusal: forbidden() })),
    ...["CHECK (true)", "UNIQUE (id)"].map(clause => ({ label: `inline table ${clause}`, pins: [freshPin],
      sql: `CREATE TABLE public.cat_fresh (id integer, CONSTRAINT ${pin.name} ${clause});` + renderNativeDeferredTrigger(freshPin), refusal: forbidden(freshPin) })),
    { label: "duplicate registry entry", pins: [pin, pin], sql: statement, refusal: `createdTriggers entry ${pin.name} is listed twice; delete the duplicate entry` },
    { label: "missing deferred flag", pins: [Object.fromEntries(Object.entries(pin).filter(([key]) => key !== "deferred")) as NativeDeferredTrigger], sql: statement, refusal: `createdTriggers entry ${pin.name}: deferred must be true` },
    ...["AFTER", "CREATE"].map(word => ({ label: `unfinished lowercase ${word}`, pins: [pin],
      sql: statement.slice(0, -1).replace(word, word.toLowerCase()) + (word === "AFTER" ? " -- unfinished declaration" : ""), refusal: unterminated })),
    { label: "extra terminator", pins: [pin], sql: statement + ";", refusal: "reviewed native store refuses statement outside its closed shapes" },
    ...[pin.relation, "public.cat_parameters"].map(relation => ({ label: `second pinned trigger on ${relation}`, pins: [pin, deferredPin({ name: "cat_deferred_other", relation })] })),
    { label: "renamed prefix table", pins: [renamed], setup: "ALTER TABLE public.cat_existing_table RENAME TO cat_renamed;", prefixFunction: true },
    { label: "successor table with its own linked constraint", pins: [successor], setup: successorBase, sql: successorCreate + renderNativeDeferredTrigger(successor) },
    ...[
      ["event separator", "INSERT OR UPDATE", "INSERT, UPDATE"], ["byte spacing", " TRIGGER ", "  TRIGGER "], ["lowercase AFTER", "AFTER", "after"],
      ["OR REPLACE", "CREATE", "CREATE OR REPLACE"], ["IF NOT EXISTS", "TRIGGER ", "TRIGGER IF NOT EXISTS "], ["ordinary CREATE spelling", "CONSTRAINT TRIGGER", "TRIGGER"],
    ].map(([label, from, to]) => ({ label: label!, pins: [pin], sql: statement.replace(from!, to!), refusal: forbidden() })),
    { label: "case drift beside exact declaration", pins: [pin], sql: statement + statement.replace("AFTER", "after"), refusal: forbidden() },
    { label: "unfinished ordinary CREATE beside exact declaration", pins: [pin],
      sql: statement + statement.replace("CONSTRAINT TRIGGER", "TRIGGER").slice(0, -1), refusal: unterminated },
    ...[
      ["DROP TRIGGER", "DROP TRIGGER IF EXISTS cat_deferred_guard ON public.cat_existing_table;"],
      ["terminated ALTER TABLE on pinned relation", "ALTER TABLE ONLY public.cat_existing_table DISABLE TRIGGER ALL;"],
      ...["cat_existing_table_pkey", "unrelated"].map(name => [`rename constraint ${name}`, `ALTER TABLE public.cat_existing_table RENAME CONSTRAINT ${name} TO cat_deferred_guard;`]),
      ["COMMENT ON FUNCTION", "COMMENT ON FUNCTION public.cat_created_guard IS 'note';", "cat_created_guard"],
      ["DROP FUNCTION", "DROP FUNCTION public.cat_created_guard;", "cat_created_guard"],
      ...["GRANT EXECUTE", "GRANT ALL", "REVOKE ALL"].map(clause => [clause, guarded("authenticated", `${clause} ON FUNCTION`,
        `public.cat_created_guard() ${clause.startsWith("GRANT") ? "TO" : "FROM"} authenticated;`), "cat_created_guard"]),
      ["CREATE OR REPLACE FUNCTION", TRIGGER_FUNCTION.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"), "cat_created_guard"],
    ].map(([label, ddl, name]) => ({ label: label!, pins: [pin], sql: statement + ddl, refusal: forbidden(pin, name) })),
    ...[
      ["unfinished DROP TRIGGER", "DROP TRIGGER IF EXISTS cat_deferred_guard ON public.cat_existing_table"],
      ["unfinished COMMENT ON TRIGGER", "COMMENT ON TRIGGER cat_deferred_guard ON public.cat_existing_table IS 'note'"],
      ["unfinished ALTER TABLE", "ALTER TABLE ONLY public.cat_existing_table DISABLE TRIGGER ALL"],
    ].map(([label, ddl]) => ({ label: label!, pins: [pin], sql: statement + ddl, refusal: unterminated })),
    { label: "unregistered second declaration on pinned relation", pins: [pin], sql: statement + renderNativeDeferredTrigger({ ...prefixPin, name: "cat_companion" }),
      refusal: forbidden() },
    { label: "linked constraint truncation", pins: [deferredPin({ name: long })], sql: renderNativeDeferredTrigger(deferredPin({ name: long }))
      + `ALTER TABLE public.cat_existing_table DROP CONSTRAINT "${long}a";`, refusal: forbidden(deferredPin({ name: long })) },
    { label: "PUBLIC revoke on prefix invoker", pins: [prefixPin], prefixFunction: true, sql: renderNativeDeferredTrigger(prefixPin) + "REVOKE ALL ON FUNCTION public.cat_trigger_fn() FROM PUBLIC;",
      refusal: forbidden(prefixPin, "cat_trigger_fn", false) },
    { label: "grant-only revoke on prefix invoker", pins: [prefixPin], prefixFunction: true, setup: "GRANT EXECUTE ON FUNCTION public.cat_trigger_fn() TO authenticated;",
      sql: renderNativeDeferredTrigger(prefixPin) + guarded("authenticated", "REVOKE ALL ON FUNCTION", "public.cat_trigger_fn() FROM authenticated;"),
      companions: { grantOnlyFunctions: [{ signature: prefixPin.function, grantTo: [], revokeFrom: ["authenticated"] }] }, refusal: forbidden(prefixPin, "cat_trigger_fn", false) },
    { label: "drop with keyword pin", pins: [deferredPin({ name: "if" })], sql: statement.replace(pin.name, "if") + "DROP TRIGGER if ON public.cat_existing_table;",
      refusal: triggerKeyword("if") },
  ];
  it.each(cases)("admits and verifies the same deferred forward for $label", async ({ pins, sql, setup, prefixFunction, functionSql = deferredFunction, refusal, companions }) => {
    const slot = { ...DEFERRED_SLOT, createdTriggers: pins, createdFunctions: prefixFunction ? [] : DEFERRED_SLOT.createdFunctions, ...companions };
    const fixture = deferredFixture(slot, (prefixFunction ? "" : functionSql) + (sql ?? pins.map(renderNativeDeferredTrigger).join("\n")), setup);
    if (refusal) {
      const error = new Error(refusal);
      const unopened = { connect: () => { throw new Error("opened a connection before admission"); } } as unknown as Pool;
      expect(() => assertNativeStoreForward(...fixture)).toThrow(error);
      return expect(verifyForward(unopened, ...fixture, true, setup)).rejects.toThrow(error);
    }
    expect(() => assertNativeStoreForward(...fixture)).not.toThrow();
    await verifyForward(pool, ...fixture, false, setup);
  });
  it("counts every successor constraint except the verified trigger link", async () => {
    const sql = successorCreate + deferredFunction + renderNativeDeferredTrigger(successor)
      + "ALTER TABLE public.catalog_sku_successors ADD CONSTRAINT cat_extra CHECK (true);";
    const fixture = deferredFixture({ ...DEFERRED_SLOT, createdTriggers: [successor] }, sql, successorBase);
    await expect(verifyForward(pool, ...fixture, true, successorBase)).rejects.toThrow(/successor primary key or self-link CHECK/u);
    const result = await pool.query("SELECT to_regclass('public.catalog_sku_successors') AS rolled_back");
    expect(result.rows[0].rolled_back).toBeNull();
  });
  it.each([
    ["tgname", "different"], ["tgrelid", 0], ["tgfoid", 0], ["tgenabled", "D"], ["tgisinternal", true], ["tgnargs", 1],
    ["tgattr", [1]], ["tgqual", "condition"], ["tgconstrrelid", 1], ["tgoldtable", "old"], ["tgnewtable", "new"],
    ["tgtype", 28], ["tgtype", 31], ["tgtype", 5],
    ["tgconstraint", 0], ["tgdeferrable", false], ["tginitdeferred", false],
    ["link.kind", "c"], ["link.relationOid", 0], ["link.name", "different"], ["link.validated", false], ["link.fresh", false], ["link.deferrable", false], ["link.deferred", false],
    ["function.returnsTrigger", false], ["attrs.prosecdef", true], ["attrs.proretset", true],
  ] as const)("refuses installed fact drift in %s (%s)", async (field, value) => {
    const db = await pool.connect(), slot = { ...DEFERRED_SLOT, createdTriggers: [pin] };
    const pinnedPath = field === "attrs.prosecdef";
    if (pinnedPath) slot.createdFunctions = [{ signature: pin.function, searchPath: "pg_catalog, pg_temp" }];
    try {
      await db.query("BEGIN");
      const role = (await db.query("SELECT current_user::text AS role")).rows[0].role as string;
      const before = await pinned(db, () => snapshot(db));
      await db.query((pinnedPath ? TRIGGER_FUNCTION + TRIGGER_REVOKE : deferredFunction) + statement);
      const after = await pinned(db, () => snapshot(db)), row = after.guards.triggers!.find(row => row.tgname === pin.name)!;
      const link = after.constraints.find(link => link.oid === Number(row.tgconstraint))!, fn = after.functions.find(fn => fn.oid === Number(row.tgfoid))!;
      const [owner, key] = field.split("."), subjects = { link, function: fn, attrs: fn.attrs };
      if (field === "link.fresh") before.constraintOids.push(link.oid);
      else Object.assign(key ? subjects[owner as keyof typeof subjects] : row, { [key ?? field]: value });
      await expect(pinned(db, () => assertSlotCatalog(db, slot, before, after, role))).rejects.toThrow(/catalog: (?:created(?: deferred)?|deferred) trigger/u);
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each([
    ["disabled trigger", `${TRIGGER_SQL} ALTER TABLE public.cat_existing_table DISABLE TRIGGER cat_created_guard;`, /binding or enabled state/u],
    ["changed events", TRIGGER_SQL.replace("BEFORE INSERT OR DELETE OR UPDATE OF owner_ref, id", "AFTER INSERT"), /events or row shape/u],
    ["different table", TRIGGER_SQL.replace("ON public.cat_existing_table FOR EACH", "ON public.cat_parameters FOR EACH"), /binding or enabled state/u],
    ["different function", TRIGGER_SQL.replaceAll("EXECUTE FUNCTION public.cat_created_guard()", "EXECUTE FUNCTION public.cat_trigger_fn()"), /binding or enabled state/u],
    ["function grant", `${TRIGGER_SQL} GRANT EXECUTE ON FUNCTION public.cat_created_guard() TO authenticated;`, /owner-only invoker/u],
    ["definer function", TRIGGER_SQL.replace("SECURITY INVOKER", "SECURITY DEFINER"), /owner-only invoker/u],
    ["WHEN clause", TRIGGER_SQL.replace("FOR EACH ROW EXECUTE FUNCTION", "FOR EACH ROW WHEN (true) EXECUTE FUNCTION"), /events or row shape/u],
  ] as const)("refuses a listed trigger with %s", async (_label, sql, message) => {
    await expect(checkForward(pool, TRIGGER_SLOT, forward(CREATED_OK, sql))).rejects.toThrow(message);
  });
  it("refuses a listed trigger name already present on a different prefix table", async () => {
    const statement = TRIGGER_AFTER.replace("cat_created_event", "cat_base_trigger");
    triggerStatements.set(sqlSha256(statement), statement);
    const slot = { ...TRIGGER_SLOT, createdTriggers: [TRIGGER_SLOT.createdTriggers![0]!, { name: "cat_base_trigger", table: "public.cat_parameters", sha256: sqlSha256(statement) }] };
    await expect(checkForward(pool, slot, forward(CREATED_OK, TRIGGER_SQL.replace(TRIGGER_AFTER, statement)))).rejects.toThrow("catalog: created trigger name existed in the prefix");
  });
  it("preserves an installed compact legacy search_path and refuses a changed path", async () => {
    const setup="CREATE FUNCTION public.cat_compact(p text) RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT p $$; REVOKE ALL ON FUNCTION public.cat_compact(text) FROM PUBLIC;";
    const replacement="CREATE OR REPLACE FUNCTION public.cat_compact(p text) RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT 'after' $$;";
    const slot={...SYNTHETIC_SLOT,replacedFunctions:[...SYNTHETIC_SLOT.replacedFunctions,{signature:"public.cat_compact(text)",beforeSha256:null,searchPath:"pg_catalog"}]};
    await checkForward(pool,slot,forward(CREATED_OK,replacement),false,setup);
    await expect(checkForward(pool,slot,forward(CREATED_OK,replacement.replace("search_path=pg_catalog","search_path=public")),false,setup)).rejects.toThrow(/changed attributes or ACL/u);
  });
  it("matches PostgreSQL's proconfig when tightening a compact search_path list", async () => {
    const signature = "public.cat_compact(text)";
    const beforePath = "SET search_path=pg_catalog,public";
    const searchPath = "pg_catalog, public, pg_temp";
    const definition = `CREATE FUNCTION public.cat_compact(p text) RETURNS text LANGUAGE sql SECURITY INVOKER ${beforePath} AS $$ SELECT p $$;`;
    const setup = `${definition} REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`;
    const replacement = definition.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
      .replace(beforePath, `SET search_path = ${searchPath}`);
    const slot = { ...SYNTHETIC_SLOT, replacedFunctions: [...SYNTHETIC_SLOT.replacedFunctions, { signature, beforeSha256: null, searchPath }] };
    await checkForward(pool, slot, forward(CREATED_OK, replacement), false, setup);
  });
  const addedColumn="ALTER TABLE public.cat_parameters ADD COLUMN parent_id int;";
  const addedFk="ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_parent_fk FOREIGN KEY (parent_id) REFERENCES public.cat_existing_table(id) ON DELETE SET NULL NOT VALID;";
  const fkSlot={...SYNTHETIC_SLOT,existingTableStatements:[addedColumn,addedFk]};
  it.each(["CASCADE","SET NULL"])("proves fresh-column %s FK actions and both validation states", async action=>{
    for(const suffix of [""," NOT VALID"]) {
      const statement=addedFk.replace("SET NULL NOT VALID",action+suffix);
      await checkForward(pool,{...SYNTHETIC_SLOT,existingTableStatements:[addedColumn,statement]},forward(CREATED_OK,addedColumn+statement));
    }
  });
  it.each([
    ["a pre-existing column",addedColumn+addedFk,addedColumn,/fresh column/u],
    ["a different action",addedColumn+addedFk.replace("SET NULL","CASCADE"),"",/FK target, key, delete action or validation/u],
    ["a wrong target",addedColumn+addedFk.replace("cat_existing_table(id)","cat_other_parent(id)"),"CREATE TABLE public.cat_other_parent(id int PRIMARY KEY);",/FK target, key, delete action or validation/u],
    ["a wrong referenced key",addedColumn+addedFk.replace("cat_existing_table(id)","cat_existing_table(other_id)"),"ALTER TABLE public.cat_existing_table ADD COLUMN other_id int UNIQUE;",/FK target, key, delete action or validation/u],
    ["a changed validation state",addedColumn+addedFk+"ALTER TABLE public.cat_parameters VALIDATE CONSTRAINT cat_parent_fk;","",/FK target, key, delete action or validation/u],
    ["an unlisted action",addedColumn+addedFk,"",/FK delete actions differ/u],
    ["a changed prior column",addedColumn+addedFk+"ALTER TABLE public.cat_parameters ALTER COLUMN status SET DEFAULT 'closed';","",/FK table column/u],
    ["a dropped FK",addedColumn+addedFk+"ALTER TABLE public.cat_child DROP CONSTRAINT cat_child_parent_id_fkey;","",/dropped or rewritten/u],
    ["a rewritten FK",addedColumn+addedFk+"ALTER TABLE public.cat_child DROP CONSTRAINT cat_child_parent_id_fkey; ALTER TABLE public.cat_child ADD CONSTRAINT cat_child_parent_id_fkey FOREIGN KEY(parent_id) REFERENCES public.cat_existing_table(id) ON DELETE CASCADE;","",/dropped or rewritten/u],
  ] as const)("refuses fresh-column FK drift: %s",async(label,sql,setup,message)=>{
    // The pre-existing-column case installs it before the snapshot, then only adds the FK.
    const actual=label==="a pre-existing column"?addedFk:sql;
    await expect(checkForward(pool,label==="an unlisted action"?SYNTHETIC_SLOT:fkSlot,forward(CREATED_OK,actual),false,setup)).rejects.toThrow(message);
  });
  it("proves successor exact targets, arity, PK order, NOT NULLs and RESTRICT with owner-only ACLs", async () => {
    await checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, successorCreate), false, successorBase);
    const db = await pool.connect();
    try {
      await db.query("BEGIN"); await db.query(successorBase + successorCreate);
      const ids = [1, 2, 3].map(value => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`);
      await db.query("INSERT INTO public.catalog_skus(id) VALUES ($1),($2)", ids.slice(0, 2));
      await db.query("INSERT INTO public.catalog_publications(id) VALUES ($1)", [ids[2]]);
      await db.query("INSERT INTO public.catalog_sku_successors VALUES ($1,$2,$3)", ids);
      expect((await db.query("SELECT confdeltype FROM pg_constraint WHERE conrelid='public.catalog_sku_successors'::regclass AND contype='f'")).rows).toEqual([{ confdeltype: "r" }, { confdeltype: "r" }, { confdeltype: "r" }]);
      for (const [statement, values, code] of [
        ["DELETE FROM public.catalog_skus WHERE id=$1", [ids[0]], "23503"],
        ["DELETE FROM public.catalog_skus WHERE id=$1", [ids[1]], "23503"],
        ["DELETE FROM public.catalog_publications WHERE id=$1", [ids[2]], "23503"],
        ["INSERT INTO public.catalog_sku_successors VALUES ($1,$1,$2)", [ids[0], ids[2]], "23514"],
        ["INSERT INTO public.catalog_sku_successors VALUES ($1,$2,NULL)", ids.slice(0, 2), "23502"],
        ["INSERT INTO public.catalog_sku_successors VALUES ($1,$2,$3)", ids, "23505"],
      ] as const) {
        await db.query("SAVEPOINT denied");
        await expect(db.query(statement, [...values])).rejects.toMatchObject({ code });
        await db.query("ROLLBACK TO SAVEPOINT denied");
      }
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each([
    ["TEXT source and reference keys", successorCreate.replaceAll("uuid", "text"), successorBase.replaceAll("uuid", "text")],
    ["UUID default", successorCreate.replace("publication_id uuid NOT NULL", "publication_id uuid NOT NULL DEFAULT gen_random_uuid()")],
    ["partitioned relation", successorCreate.replace(");", ") PARTITION BY HASH (predecessor_sku_id);")],
    ["column order", successorCreate.replace("predecessor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,\n    successor_sku_id", "successor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,\n    predecessor_sku_id")],
    ["extra UUID column", successorCreate.replace("PRIMARY KEY", "extra uuid NOT NULL, PRIMARY KEY")],
    ["dropped catalogue flag", successorCreate + "UPDATE pg_catalog.pg_attribute SET attisdropped=true WHERE attrelid='public.catalog_sku_successors'::regclass AND attname='publication_id';"],
    ["deferred catalogue flag", successorCreate + "UPDATE pg_catalog.pg_constraint SET condeferred=true WHERE conrelid='public.catalog_sku_successors'::regclass AND conname='catalog_sku_successors_publication_id_fkey';"],
    ["dropped column", successorCreate + "ALTER TABLE public.catalog_sku_successors ADD COLUMN extra uuid; ALTER TABLE public.catalog_sku_successors DROP COLUMN extra;"],
    ["wrong source column", successorCreate.replace("predecessor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT", "predecessor_sku_id uuid NOT NULL, FOREIGN KEY (successor_sku_id) REFERENCES public.catalog_skus(id) ON DELETE RESTRICT")],
    ["extra UNIQUE", successorCreate.replace("PRIMARY KEY", "UNIQUE (predecessor_sku_id, publication_id), PRIMARY KEY")],
    ["unvalidated FK", successorCreate.replace("publication_id uuid NOT NULL REFERENCES public.catalog_publications(id) ON DELETE RESTRICT", "publication_id uuid NOT NULL") + "ALTER TABLE public.catalog_sku_successors ADD CONSTRAINT cat_successor_publication_fk FOREIGN KEY (publication_id) REFERENCES public.catalog_publications(id) ON DELETE RESTRICT NOT VALID;"],
    ["unvalidated CHECK", successorCreate.replace(", CHECK (predecessor_sku_id <> successor_sku_id)", "") + "ALTER TABLE public.catalog_sku_successors ADD CONSTRAINT cat_successor_check CHECK (predecessor_sku_id <> successor_sku_id) NOT VALID;"],
    ["initially deferred", successorCreate.replace("DELETE RESTRICT", "DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED")],
    ["extra FK", successorCreate + "ALTER TABLE public.catalog_sku_successors ADD CONSTRAINT cat_successor_extra_fk FOREIGN KEY (publication_id) REFERENCES public.catalog_publications(id) ON DELETE RESTRICT;"],
    ["CHECK replaced by UNIQUE", successorCreate.replace("CHECK (predecessor_sku_id <> successor_sku_id)", "UNIQUE (publication_id)")],
    ["same-slot publication target", "CREATE TABLE public.catalog_publications (id uuid PRIMARY KEY);" + successorCreate, successorBase.replace("CREATE TABLE public.catalog_publications (id uuid PRIMARY KEY);", "")],
    ["partitioned reference target", successorCreate, successorBase.replace("CREATE TABLE public.catalog_publications (id uuid PRIMARY KEY);", "CREATE TABLE public.catalog_publications (id uuid PRIMARY KEY) PARTITION BY HASH (id);")],
    ["same-slot target key", "ALTER TABLE public.catalog_publications ADD COLUMN id uuid UNIQUE;" + successorCreate, successorBase.replace("catalog_publications (id uuid PRIMARY KEY)", "catalog_publications (other_id uuid PRIMARY KEY)")],
    ...["CASCADE", "SET NULL", "SET DEFAULT", "NO ACTION"].map(action => [`delete ${action}`, successorCreate.replace("DELETE RESTRICT", `DELETE ${action}`)]),
    ["implicit action", successorCreate.replace(" ON DELETE RESTRICT", "")],
    ["update action", successorCreate.replace("DELETE RESTRICT", "DELETE RESTRICT ON UPDATE CASCADE")],
    ["deferrable", successorCreate.replace("DELETE RESTRICT", "DELETE RESTRICT DEFERRABLE")],
    ["match full", successorCreate.replace(" ON DELETE", " MATCH FULL ON DELETE")],
    ["other table", successorCreate.replace("public.catalog_sku_successors", "public.cat_other_successors")],
    ["other SKU target", successorCreate.replace("public.catalog_skus", "public.cat_other_skus")],
    ["other publication target", successorCreate.replace("public.catalog_publications", "public.cat_other_publications")],
    ["target key", successorCreate.replace("catalog_skus(id)", "catalog_skus(other_id)")],
    ["source and target arity", successorCreate.replace("predecessor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT", "predecessor_sku_id uuid NOT NULL, FOREIGN KEY(predecessor_sku_id,successor_sku_id) REFERENCES public.catalog_skus(id,other_id) ON DELETE RESTRICT")],
    ["PK replaced by UNIQUE", successorCreate.replace("PRIMARY KEY", "UNIQUE")],
    ["PK order", successorCreate.replace("PRIMARY KEY (predecessor_sku_id, successor_sku_id)", "PRIMARY KEY (successor_sku_id, predecessor_sku_id)")],
    ["PK arity", successorCreate.replace("PRIMARY KEY (predecessor_sku_id, successor_sku_id)", "PRIMARY KEY (predecessor_sku_id)")],
    ["publication nullable", successorCreate.replace("publication_id uuid NOT NULL", "publication_id uuid")],
    ["missing FK", successorCreate.replace(" REFERENCES public.catalog_publications(id) ON DELETE RESTRICT", "")],
    ["missing check", successorCreate.replace(", CHECK (predecessor_sku_id <> successor_sku_id)", "")],
    ["broader check", successorCreate.replace("<>", "=")],
    ["extra column", successorCreate.replace("PRIMARY KEY", "extra text, PRIMARY KEY")],
    ["appended owner change", successorCreate + "ALTER TABLE public.catalog_sku_successors OWNER TO authenticated;"],
    ["appended table ACL", successorCreate + "GRANT SELECT ON public.catalog_sku_successors TO PUBLIC;"],
    ["appended column ACL", successorCreate + "GRANT SELECT(publication_id) ON public.catalog_sku_successors TO authenticated;"],
    ["appended role smuggling", successorCreate + "CREATE ROLE cat_smuggled NOLOGIN;"],
  ])("refuses installed successor shape: %s", async (_label, statement, setup = successorBase) => {
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, statement), false, setup)).rejects.toThrow(/catalog:/u);
  });
  it("preserves generic admission for a temporary relation named __proto__", async () => {
    await checkForward(pool, storageSlot, "CREATE TABLE pg_temp.__proto__ (id uuid);");
  });
  it("proves the four successor storage shapes, owner ACLs and every RESTRICT target", async () => {
    await checkForward(pool, storageSlot, storageCreate, false, storageBase);
    const db = await pool.connect();
    try {
      await db.query("BEGIN"); await db.query(storageBase + storageCreate);
      const id = "00000000-0000-0000-0000-000000000001";
      const targets = new Set(Object.values(SUCCESSOR_STORAGE_SHAPES).flatMap(shape => shape.references.map(([, target]) => target)));
      for (const target of targets) if (!Object.hasOwn(SUCCESSOR_STORAGE_SHAPES, target)) await db.query(`INSERT INTO ${target}(id) VALUES ($1)`, [id]);
      for (const [name, shape] of Object.entries(SUCCESSOR_STORAGE_SHAPES)) {
        const columns = shape.columns.filter(([column, , required, defaultValue]) => (required && defaultValue === null) || shape.references.some(([source]) => source === column));
        const expressions = columns.map(([column, type]) => {
          if (type === "2950") return "$1";
          if (type === "1184") return "now()";
          if (["23", "20"].includes(type)) return "1";
          if (type === "3802") return ["lines", "deficits"].includes(column) ? "'[]'::jsonb" : "'{}'::jsonb";
          if (column === "state") return name.endsWith("operations_v2") ? "'claimed'" : "'waiting'";
          if (column === "status") return "'held'";
          return "'" + (column.includes("fingerprint") || column === "quote_hash" || column === "identity_key" ? "a".repeat(64) : "update") + "'";
        });
        await db.query(`INSERT INTO ${name}(${columns.map(([column]) => column).join(",")}) VALUES (${expressions.join(",")})`, [id]);
      }
      for (const target of targets) {
        await db.query("SAVEPOINT restricted");
        await expect(db.query(`DELETE FROM ${target} WHERE id=$1`, [id])).rejects.toMatchObject({ code: "23503" });
        await db.query("ROLLBACK TO SAVEPOINT restricted");
      }
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  const storageRefusals: [string, string, string?][] = [];
  for (const [name, create] of storageEntries) {
    const shape = SUCCESSOR_STORAGE_SHAPES[name]!;
    const timeColumn = name.endsWith("wait_cases_v2") ? "opened_at" : "created_at";
    const alter = (suffix: string) => storageCreate + `\nALTER TABLE ${name} ${suffix};`;
    storageRefusals.push(
      [`${name}: relation kind`, storageCreate + `UPDATE pg_catalog.pg_class SET relkind='p' WHERE oid='${name}'::regclass;`],
      [`${name}: RLS disabled`, alter("DISABLE ROW LEVEL SECURITY")],
      [`${name}: RLS forced`, alter("FORCE ROW LEVEL SECURITY")],
      [`${name}: policy`, storageCreate + `CREATE POLICY unlisted ON ${name} USING (true);`],
      [`${name}: extra column`, alter("ADD COLUMN unlisted text")],
      [`${name}: extra CHECK`, alter("ADD CHECK (true)")],
      [`${name}: extra UNIQUE`, alter(`ADD UNIQUE (${timeColumn},id)`)],
      [`${name}: owner`, alter("OWNER TO authenticated")],
      [`${name}: table ACL`, storageCreate + `GRANT SELECT ON ${name} TO PUBLIC;`],
      [`${name}: column ACL`, storageCreate + `GRANT SELECT(id) ON ${name} TO authenticated;`],
      [`${name}: dropped column flag`, storageCreate + `UPDATE pg_catalog.pg_attribute SET attisdropped=true WHERE attrelid='${name}'::regclass AND attname='${timeColumn}';`],
      [`${name}: type modifier`, storageCreate + `UPDATE pg_catalog.pg_attribute SET atttypmod=2 WHERE attrelid='${name}'::regclass AND attname='${timeColumn}';`],
      [`${name}: array dimensions`, storageCreate + `UPDATE pg_catalog.pg_attribute SET attndims=1 WHERE attrelid='${name}'::regclass AND attname='${timeColumn}';`],
      [`${name}: identity flag`, storageCreate + `UPDATE pg_catalog.pg_attribute SET attidentity='a' WHERE attrelid='${name}'::regclass AND attname='${timeColumn}';`],
      [`${name}: generated flag`, storageCreate + `UPDATE pg_catalog.pg_attribute SET attgenerated='s' WHERE attrelid='${name}'::regclass AND attname='${timeColumn}';`],
    );
    for (const [column, type, required, defaultValue] of shape.columns) {
      if (column !== "id") storageRefusals.push([`${name}: ${column} nullability`, alter(`ALTER COLUMN ${column} ${required ? "DROP" : "SET"} NOT NULL`)]);
      const defaultExpression = type === "2950" ? "gen_random_uuid()" : type === "1184" ? "now()" : type === "3802" ? "'{}'::jsonb" : type === "25" ? "'unexpected'" : "1";
      storageRefusals.push([`${name}: ${column} default`, alter(`ALTER COLUMN ${column} ${defaultValue === null ? "SET DEFAULT " + defaultExpression : "DROP DEFAULT"}`)]);
      if (!shape.references.some(([source]) => source === column) && column !== "id") {
        const line = create.split("\n").find(line => line.trim().startsWith(column + " "))!;
        if (type === "1184") storageRefusals.push([`${name}: ${column} type`, storageCreate.replace(line, line.replace("timestamptz", "timestamp"))]);
        if (["23", "20"].includes(type)) storageRefusals.push([`${name}: ${column} type`, storageCreate.replace(line, line.replace(type === "23" ? "integer" : "bigint", "numeric"))]);
        if (line.includes("CHECK")) {
          storageRefusals.push([`${name}: ${column} missing CHECK`, storageCreate.replace(line, line.replace(/ CHECK \(.*\)(,?)$/u, "$1"))]);
          storageRefusals.push([`${name}: ${column} changed CHECK`, storageCreate.replace(line, line.replace(/ CHECK \(.*\)(,?)$/u, " CHECK (true)$1"))]);
        }
      }
    }
    for (const [column] of shape.references) {
      const sourcePosition = shape.columns.findIndex(entry => entry[0] === column) + 1;
      const line = create.split("\n").find(line => line.trim().startsWith(column + " "))!;
      storageRefusals.push(
        [`${name}: ${column} missing FK`, storageCreate.replace(line, line.replace(/ REFERENCES .*?(,?)$/u, "$1"))],
        [`${name}: ${column} duplicate FK`, alter(`ADD FOREIGN KEY (${column}) REFERENCES ${shape.references.find(([source]) => source === column)![1]}(id) ON DELETE RESTRICT`)],
        ...["CASCADE", "SET NULL", "SET DEFAULT", "NO ACTION"].map(action => [`${name}: ${column} delete ${action}`, storageCreate.replace(line, line.replace("DELETE RESTRICT", `DELETE ${action}`))] as [string, string]),
        [`${name}: ${column} implicit delete`, storageCreate.replace(line, line.replace(" ON DELETE RESTRICT", ""))],
        [`${name}: ${column} update`, storageCreate.replace(line, line.replace("DELETE RESTRICT", "DELETE RESTRICT ON UPDATE CASCADE"))],
        [`${name}: ${column} match`, storageCreate.replace(line, line.replace(" ON DELETE", " MATCH FULL ON DELETE"))],
        [`${name}: ${column} deferrable`, storageCreate.replace(line, line.replace("DELETE RESTRICT", "DELETE RESTRICT DEFERRABLE"))],
        [`${name}: ${column} deferred flag`, storageCreate + `UPDATE pg_catalog.pg_constraint SET condeferred=true WHERE conrelid='${name}'::regclass AND contype='f' AND conkey=ARRAY[${sourcePosition}]::smallint[];`],
        [`${name}: ${column} validation flag`, storageCreate + `UPDATE pg_catalog.pg_constraint SET convalidated=false WHERE conrelid='${name}'::regclass AND contype='f' AND conkey=ARRAY[${sourcePosition}]::smallint[];`],
      );
    }
  }
  const reservation = "public.subscription_successor_reservations_v2";
  const reservationCreate = NATIVE_SUCCESSOR_TABLE_SQL[reservation]!;
  const reservationStart = storageCreate.indexOf(reservationCreate);
  const reservationPrefix = storageBase + storageCreate.slice(0, reservationStart) + "ALTER TABLE public.subscription_successor_operations_v2 ADD UNIQUE(id,proposal_id);";
  storageRefusals.push(
    ["storage collation", storageCreate + `ALTER TABLE ${reservation} ALTER COLUMN terminal_reason TYPE text COLLATE "C";`],
    ["storage absorption proposals", storageCreate, storageBase.replace("'subscription_successor_proposals','block'", "'subscription_successor_proposals','retain'")],
    ["storage absorption waits", storageCreate, storageBase.replace("'subscription_successor_wait_cases_v2','block'", "'subscription_successor_wait_cases_v2','retain'")],
    ["storage UNIQUE order", storageCreate.replace(reservationCreate, reservationCreate.replace("operation_id uuid NOT NULL UNIQUE", "operation_id uuid NOT NULL").replace(/\);$/u, ", UNIQUE(id,operation_id));"))],
    ["storage CHECK validation", storageCreate + `ALTER TABLE ${reservation} DROP CONSTRAINT subscription_successor_reservations_v2_lines_check; ALTER TABLE ${reservation} ADD CHECK (jsonb_typeof(lines) = 'array') NOT VALID;`],
    ["storage table identity", storageCreate.replaceAll(reservation, "public.other_successor_reservations")],
    ["storage column order", storageCreate.replace(reservationCreate, reservationCreate.replace("created_at", "swap_at").replace("updated_at", "created_at").replace("swap_at", "updated_at"))],
    ["storage text and UUID types", storageCreate.replaceAll("uuid", "text"), "ALTER TABLE public.clients ALTER COLUMN id TYPE text USING NULL::text;" + storageBase.replaceAll("uuid", "text")],
    ["storage PK missing", storageCreate.replace(/(CREATE TABLE public\.subscription_successor_reservations_v2 \(\n id uuid) PRIMARY KEY/u, "$1 NOT NULL")],
    ["storage PK order", storageCreate.replace(/(CREATE TABLE public\.subscription_successor_reservations_v2 \(\n id uuid) PRIMARY KEY/u, "$1 NOT NULL").replace(/(CREATE TABLE public\.subscription_successor_reservations_v2[\s\S]*?)\n\);/u, "$1, PRIMARY KEY (source_key,id)\n);")],
    ["storage UNIQUE missing", storageCreate.replace("proposal_id uuid NOT NULL UNIQUE", "proposal_id uuid NOT NULL")],
    ["storage FK target", storageCreate.replace("root_operation_id uuid NOT NULL REFERENCES public.subscription_renewal_operations", "root_operation_id uuid NOT NULL REFERENCES public.subscription_stock_wait_cases")],
    ["storage FK target key", storageCreate.replace("root_operation_id uuid NOT NULL REFERENCES public.subscription_renewal_operations(id)", "root_operation_id uuid NOT NULL REFERENCES public.subscription_renewal_operations(other_id)")],
    ["storage FK source column", storageCreate + `UPDATE pg_catalog.pg_constraint SET conkey=ARRAY[1]::smallint[] WHERE conrelid='${reservation}'::regclass AND contype='f';`],
    ["storage FK source and target arity", storageCreate.slice(reservationStart).replace("operation_id uuid NOT NULL UNIQUE REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT", "operation_id uuid NOT NULL UNIQUE, FOREIGN KEY(operation_id,id) REFERENCES public.subscription_successor_operations_v2(id,proposal_id) ON DELETE RESTRICT"), reservationPrefix],
    ["storage external target in same slot", "CREATE TABLE public.subscription_renewal_operations(id uuid PRIMARY KEY, other_id uuid UNIQUE, UNIQUE(id,other_id));" + storageCreate, storageBase.replace("CREATE TABLE public.subscription_renewal_operations(id uuid PRIMARY KEY, other_id uuid UNIQUE, UNIQUE(id,other_id));", "")],
    ["storage external target key in same slot", "ALTER TABLE public.subscription_renewal_operations ADD COLUMN id uuid UNIQUE;" + storageCreate, storageBase.replace("public.subscription_renewal_operations(id uuid PRIMARY KEY, other_id uuid UNIQUE, UNIQUE(id,other_id))", "public.subscription_renewal_operations(other_id uuid PRIMARY KEY)")],
    ["storage external target kind", storageCreate, storageBase.replace("public.subscription_renewal_operations(id uuid PRIMARY KEY, other_id uuid UNIQUE, UNIQUE(id,other_id))", "public.subscription_renewal_operations(id uuid PRIMARY KEY, other_id uuid, UNIQUE(id,other_id)) PARTITION BY HASH (id)")],
    ["storage appended role", storageCreate + "CREATE ROLE cat_storage_smuggled NOLOGIN;"],
  );
  it.each(storageRefusals)("refuses installed successor storage: %s", async (_label, statement, setup = storageBase) => {
    expect(statement !== storageCreate || setup !== storageBase).toBe(true);
    await expect(checkForward(pool, storageSlot, statement, false, setup)).rejects.toThrow(/catalog:/u);
  });
  const sameSkuColumn = "ALTER TABLE public.subscription_lines ADD COLUMN catalog_sku_revision_id uuid;";
  const sameSkuFk = "ALTER TABLE public.subscription_lines ADD CONSTRAINT subscription_lines_catalog_sku_revision_fkey FOREIGN KEY (variant_id, catalog_sku_revision_id) REFERENCES public.catalog_sku_revisions (sku_id, id) ON DELETE RESTRICT NOT VALID;";
  const sameSkuValidate = "ALTER TABLE public.subscription_lines VALIDATE CONSTRAINT subscription_lines_catalog_sku_revision_fkey;";
  const sameSkuSlot: CatalogSlot = { createdFunctions: [], replacedFunctions: [], grantOnlyFunctions: [], existingTableStatements: [sameSkuColumn, sameSkuFk] };
  const sameSkuBase = `CREATE TABLE public.subscription_lines (id int PRIMARY KEY, variant_id uuid NOT NULL, other_id uuid);
    CREATE TABLE public.catalog_sku_revisions (sku_id uuid NOT NULL, id uuid PRIMARY KEY, other_id uuid, UNIQUE (sku_id, id), UNIQUE (id, sku_id), UNIQUE (other_id, id));
    CREATE TABLE public.cat_other_lines (LIKE public.subscription_lines);
    ALTER TABLE public.cat_other_lines ADD COLUMN catalog_sku_revision_id uuid;
    CREATE TABLE public.cat_other_revisions (sku_id uuid, id uuid, UNIQUE (sku_id, id));
    INSERT INTO public.subscription_lines (id, variant_id) VALUES (1, '00000000-0000-0000-0000-000000000001');
    INSERT INTO public.catalog_sku_revisions (sku_id, id) VALUES
      ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011'),
      ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000012');`;
  it("proves ordered same-SKU keys, RESTRICT, validation and historical NULL preservation", async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(sameSkuBase);
      const historical = (await db.query("SELECT * FROM public.subscription_lines ORDER BY id")).rows;
      const before = await pinned(db, () => snapshot(db));
      const migrationRole = String((await db.query("SELECT current_user::text AS role")).rows[0].role);
      await db.query(sameSkuColumn + sameSkuFk);
      await pinned(db, async () => assertSlotCatalog(db, sameSkuSlot, before, await snapshot(db), migrationRole));
      expect((await db.query("SELECT convalidated, confdeltype FROM pg_constraint WHERE conname='subscription_lines_catalog_sku_revision_fkey'")).rows)
        .toEqual([{ convalidated: false, confdeltype: "r" }]);
      await db.query(sameSkuValidate);
      const validatedSlot = { ...sameSkuSlot, existingTableStatements: [sameSkuColumn, sameSkuFk, sameSkuValidate] };
      await pinned(db, async () => assertSlotCatalog(db, validatedSlot, before, await snapshot(db), migrationRole));
      expect((await db.query("SELECT convalidated FROM pg_constraint WHERE conname='subscription_lines_catalog_sku_revision_fkey'")).rows[0].convalidated).toBe(true);
      expect((await db.query("SELECT * FROM public.subscription_lines ORDER BY id")).rows)
        .toEqual(historical.map(row => ({ ...row, catalog_sku_revision_id: null })));
      await db.query("UPDATE public.subscription_lines SET catalog_sku_revision_id='00000000-0000-0000-0000-000000000011' WHERE id=1");
      for (const denied of [
        "UPDATE public.subscription_lines SET catalog_sku_revision_id='00000000-0000-0000-0000-000000000012' WHERE id=1",
        "UPDATE public.subscription_lines SET variant_id='00000000-0000-0000-0000-000000000002' WHERE id=1",
        "DELETE FROM public.catalog_sku_revisions WHERE id='00000000-0000-0000-0000-000000000011'",
        "UPDATE public.catalog_sku_revisions SET sku_id='00000000-0000-0000-0000-000000000002' WHERE id='00000000-0000-0000-0000-000000000011'",
      ]) {
        await db.query("SAVEPOINT denied");
        await expect(db.query(denied)).rejects.toMatchObject({ code: "23503", constraint: "subscription_lines_catalog_sku_revision_fkey" });
        await db.query("ROLLBACK TO SAVEPOINT denied");
      }
      await db.query("INSERT INTO public.subscription_lines (id, variant_id) VALUES (2, '00000000-0000-0000-0000-000000000002')");
      expect((await db.query("SELECT catalog_sku_revision_id FROM public.subscription_lines WHERE id=2")).rows[0].catalog_sku_revision_id).toBeNull();
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each([
    ["source arity", sameSkuFk.replace("variant_id, ", "")],
    ["target arity", sameSkuFk.replace("sku_id, ", "")],
    ["both arities", sameSkuFk.replace("variant_id, ", "").replace("sku_id, ", "")],
    ["source order", sameSkuFk.replace("variant_id, catalog_sku_revision_id", "catalog_sku_revision_id, variant_id")],
    ["target order", sameSkuFk.replace("sku_id, id", "id, sku_id")],
    ["both orders", sameSkuFk.replace("variant_id, catalog_sku_revision_id", "catalog_sku_revision_id, variant_id").replace("sku_id, id", "id, sku_id")],
    ["other source column", sameSkuFk.replace("(variant_id,", "(other_id,")],
    ["other target column", sameSkuFk.replace("(sku_id,", "(other_id,")],
    ["other source relation", sameSkuFk.replace("public.subscription_lines", "public.cat_other_lines")],
    ["other target relation", sameSkuFk.replace("public.catalog_sku_revisions", "public.cat_other_revisions")],
    ["other constraint", sameSkuFk.replace("subscription_lines_catalog_sku_revision_fkey", "other_fkey")],
    ["VALID on add", sameSkuFk.replace(" NOT VALID", "")],
    ["implicit NO ACTION", sameSkuFk.replace(" ON DELETE RESTRICT", "")],
    ...["CASCADE", "SET NULL", "SET DEFAULT", "NO ACTION"].map(action => [`ON DELETE ${action}`, sameSkuFk.replace("DELETE RESTRICT", `DELETE ${action}`)]),
    ...["RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].map(action => [`ON UPDATE ${action}`, sameSkuFk.replace(" NOT VALID", ` ON UPDATE ${action} NOT VALID`)]),
    ["deferrable", sameSkuFk.replace(" NOT VALID", " DEFERRABLE NOT VALID")],
    ["MATCH FULL", sameSkuFk.replace(" ON DELETE", " MATCH FULL ON DELETE")],
    ["unlisted validation", sameSkuFk + sameSkuValidate],
    ["appended column mutation", sameSkuFk + "ALTER TABLE public.subscription_lines ALTER COLUMN variant_id SET DEFAULT gen_random_uuid();"],
    ["appended grant", sameSkuFk + "GRANT SELECT ON TABLE public.subscription_lines TO authenticated;"],
  ])("refuses installed same-SKU FK drift: %s", async (_label, statement) => {
    await expect(checkForward(pool, sameSkuSlot, sameSkuColumn + statement, false, sameSkuBase))
      .rejects.toThrow(/catalog:|number of referencing and referenced columns/u);
  });
  it("refuses a missing, unlisted or pre-existing same-SKU binding and missing validation", async () => {
    await expect(checkForward(pool, sameSkuSlot, sameSkuColumn, false, sameSkuBase)).rejects.toThrow(/FK delete actions differ/u);
    await expect(checkForward(pool, { ...sameSkuSlot, existingTableStatements: [] }, sameSkuColumn + sameSkuFk, false, sameSkuBase)).rejects.toThrow(/FK delete actions differ/u);
    await expect(checkForward(pool, sameSkuSlot, sameSkuFk, false, sameSkuBase + sameSkuColumn)).rejects.toThrow(/fresh column/u);
    await expect(checkForward(pool, { ...sameSkuSlot, existingTableStatements: [sameSkuColumn, sameSkuFk, sameSkuValidate] }, sameSkuColumn + sameSkuFk, false, sameSkuBase)).rejects.toThrow(/validation state/u);
  });
  const freshTrigger=TRIGGER_BEFORE.replace("public.cat_existing_table","public.cat_trigger_table");
  const freshCreate="CREATE TABLE public.cat_trigger_table(id int,owner_ref uuid); REVOKE ALL ON TABLE public.cat_trigger_table FROM PUBLIC;";
  const freshSlot={...SYNTHETIC_SLOT,createdFunctions:[...SYNTHETIC_SLOT.createdFunctions,{signature:"public.cat_created_guard()",searchPath:"pg_catalog, pg_temp"}],createdTriggers:[{name:"cat_created_guard",table:"public.cat_trigger_table",sha256:sqlSha256(freshTrigger)}]};
  triggerStatements.set(sqlSha256(freshTrigger),freshTrigger);
  it("proves a row trigger on a table created earlier in the same slot",async()=>{
    await checkForward(pool,freshSlot,forward(CREATED_OK,freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger));
  });
  it.each([
    ["an unlisted trigger",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger,/unlisted trigger on a new relation/u],
    ["an unrelated prefix target",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+TRIGGER_BEFORE,/source differs/u],
    ["an undeclared table creation",`DO $$ BEGIN CREATE TABLE public.cat_trigger_table(id int,owner_ref uuid); END; $$;`+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger,/earlier same-slot owned table/u],
    ["a DEFINER function",freshCreate+TRIGGER_FUNCTION.replace("SECURITY INVOKER","SECURITY DEFINER")+TRIGGER_REVOKE+freshTrigger,/owner-only invoker/u],
    ["a WHEN clause",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger.replace("FOR EACH ROW EXECUTE","FOR EACH ROW WHEN (true) EXECUTE"),/source differs/u],
    ["a statement trigger",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger.replace("FOR EACH ROW","FOR EACH STATEMENT").replace(" OR UPDATE OF owner_ref, id",""),/source differs/u],
    ["a constraint trigger",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger.replace("CREATE TRIGGER","CREATE CONSTRAINT TRIGGER").replace("BEFORE INSERT OR DELETE OR UPDATE OF owner_ref, id","AFTER INSERT"),/source differs/u],
  ] as const)("refuses a same-slot trigger with %s",async(label,sql,message)=>{
    const statement=sqlStatements(sql).find(statement=>/^CREATE (?:CONSTRAINT )?TRIGGER /u.test(statement))!;
    triggerStatements.set(sqlSha256(statement),statement);
    const slot={...freshSlot,createdTriggers:label==="an unlisted trigger"?[]:[{...freshSlot.createdTriggers[0]!,sha256:sqlSha256(statement)}]};
    await expect(checkForward(pool,slot,forward(CREATED_OK,sql))).rejects.toThrow(message);
  });
  it("keeps static preimages distinct from a DO-patched installed body", async () => {
    const patch = "DO $$ BEGIN EXECUTE $patch$CREATE OR REPLACE FUNCTION public.cat_replaced(p text, q boolean DEFAULT false) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$ SELECT 'patched' $body$;$patch$; END; $$;";
    await checkForward(pool, SYNTHETIC_SLOT, CONFORMING, false, patch);
  });
  // A view recreated byte-for-byte but for spacing differs only in stored parser positions.
  it("admits a view redefinition that changes only parser positions", async () => { await checkForward(pool, SYNTHETIC_SLOT, [REPLACE_PART, CREATED_OK, GRANT_PART, TABLE_PART, "CREATE OR REPLACE VIEW public.cat_view AS SELECT    id   FROM   public.cat_existing_table;"].join("\n")); });
  // The new table's foreign key adds internal triggers to the existing table it references; PostgreSQL creates them, not the forward.
  it("admits a new table with a foreign key to an existing table", async () => { await checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "CREATE TABLE public.cat_created_child (parent_id int REFERENCES public.cat_existing_table(id));")); });
  // The deferrable unique constraint brings its own internal recheck trigger to the existing table; the forward added the constraint.
  it("admits a deferrable unique constraint on an existing table", async () => { await checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "ALTER TABLE public.cat_existing_table ADD CONSTRAINT cat_unique UNIQUE (owner_ref) DEFERRABLE;")); });
  it("admits an invoker function that carries no SET", async () => { await checkForward(pool, INVOKER_SLOT, forward(invoker(""))); });
  // Every read that compares an OID with the floor, the three system digests included, must resolve to pg_catalog's own
  // operators: operators a forward creates for (oid, integer) in pg_catalog hide nothing from the snapshot.
  it("reads the OID floor through pg_catalog's own operators", async () => {
    const db = await pool.connect();
    try {
      const before = await pinned(db, () => snapshot(db));
      await db.query("BEGIN");
      try {
        await db.query(`CREATE FUNCTION pg_catalog.cat_hide_ge(oid, integer) RETURNS boolean LANGUAGE sql AS 'select false';
          CREATE FUNCTION pg_catalog.cat_hide_lt(oid, integer) RETURNS boolean LANGUAGE sql AS 'select false';
          CREATE OPERATOR pg_catalog.>= (LEFTARG = oid, RIGHTARG = integer, FUNCTION = pg_catalog.cat_hide_ge);
          CREATE OPERATOR pg_catalog.< (LEFTARG = oid, RIGHTARG = integer, FUNCTION = pg_catalog.cat_hide_lt);`);
        const after = await pinned(db, () => snapshot(db));
        expect(after.functions.length).toBe(before.functions.length + 2);
        expect(after.relations).toEqual(before.relations);
        expect(after.system).toEqual(before.system);
        expect(after.systemRules).toEqual(before.systemRules);
      } finally { await db.query("ROLLBACK"); }
    } finally { db.release(); }
  });
  it("matches the shared guard catalog list checked against documentation", () => {
    expect(GUARDS.map(guard => guard.catalog).sort()).toEqual([...NATIVE_STORE_GUARD_CATALOGS].sort());
  });
  // Each guard catalog is wired into the comparison: one extra row in the after snapshot is a change.
  it.each(GUARDS)("compares every row of the guard catalog $catalog", async ({ id, relation }) => {
    const db = await pool.connect();
    try {
      const before = await snapshot(db);
      const after = structuredClone(before);
      after.guards[id]!.push({ probe: "extra row", tgisinternal: true, tgconstraint: 0, ...relation ? { [relation]: before.relations[0]!.oid } : {} });
      await expect(assertSlotCatalog(db, { createdFunctions: [], replacedFunctions: [], grantOnlyFunctions: [] }, before, after, "postgres")).rejects.toThrow(`catalog: ${id} `);
    } finally { db.release(); }
  });
  }
}
