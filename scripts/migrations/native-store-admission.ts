import { readFileSync } from "node:fs";
import { PLATFORM_BASELINE_FILE, checkoutOwnerDefinitionPath, checkoutOwnerGrantPath, checkoutOwnerLogin, checkoutOwnerRoutines, renderCheckoutOwnerGrant } from "../platform-migration-manifest.ts";
import { assertSecurityDefinerSearchPath, isGrandfatheredSecurityDefinerForward, tokenizeSecurityDefinerStatements, type SecurityDefinerToken } from "./security-definer.ts";
import { cachedDumpSqlStatements, expandOnlyPlatformForward, git, headerAttributes, isExpandOnlyPlatformForward, MAX_SQL_STATEMENT_CACHE_ENTRIES, nativeCatalogSuccessorsCreation, nativeStoreArguments, nativeStoreAscii, nativeStoreIdentity, nativeStoreTrim, NATIVE_SUCCESSOR_TABLE_SQL, nativeSuccessorStorageCreation, platformSqlTokens, readPrecedingBlobs, sqlStatements } from "./sql-tokenizer.ts";
import { canonical, cataloguePublicationAuthorityPath, deferredEvents, deferredKeyword, hash, keysAre, sqlSha256, type ForwardBinding, type NativeCreatedTrigger, type NativeDeferredTrigger, type NativeStoreCheck, type NativeStoreCheckToFunctionGuard, type NativeStoreFunction, type NativeStoreFunctionSetting, type NativeStoreGrantOnly, type NativeStoreSlot, type NativeStoreUnique, type PlatformSqlToken, type ReviewedForwardRegistry } from "./types.ts";

const deferredTriggerMessages = {
  unregistered: (name: PlatformSqlToken | undefined, supported: boolean) => `deferred trigger ${name?.value ?? "<missing name>"} is not registered; ${!supported ? "remove it" : name?.kind !== "word" || deferredNameRule(name.value)
    ? "rename it to a lowercase, unquoted, non-keyword identifier of at most 63 bytes and add it to createdTriggers"
    : "remove it, or register it and use the statement the registry renders"}`,
  hash: (name: string, digest: string) => `deferred trigger ${name}: update sha256 in its createdTriggers entry to ${digest}`,
  duplicateEntry: (name: string) => `createdTriggers entry ${name} is listed twice; delete the duplicate entry`,
  pinned: (pin: NativeDeferredTrigger, name: string, creation?: string) =>
    `deferred trigger ${pin.name} is pinned; only these statements may name ${name}: ${renderNativeDeferredTrigger(pin)}${creation ? ` ${creation} REVOKE ALL ON FUNCTION ${pin.function} FROM PUBLIC;` : ""} remove it, or rewrite it to exactly one of these`,
  field: (name: unknown, field: string, rule: string) => `createdTriggers entry ${typeof name === "string" ? name : "<unnamed>"}: ${field} ${rule}`,
};

const nativeStoreRoles = ["anon", "authenticated", "service_role"];
const cataloguePublicationRole = "openlup_catalog_publication";
export const qualifiedCatalogueReadTargets = [
  ["db/platform/migrations/20261124120000_catalog_publication_reads.sql", "public.catalog_offer_memberships_page(text,jsonb,integer,text)"],
  ["db/platform/migrations/20261124140000_catalog_publication_readiness.sql", "public.catalog_publication_activation_readiness(text[],text)"],
] as const;
const cataloguePublicationAuthoritySha256 = "baf0999ba0d8dce9734282c71e4c796514e974f0e42b1fb9089e5c381c742bd8";
const cataloguePublicationAuthorityLedgerCondition = `EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations
    WHERE catalog_path OPERATOR(pg_catalog.=) '${cataloguePublicationAuthorityPath}'::pg_catalog.text
      AND sha256 OPERATOR(pg_catalog.=) '${cataloguePublicationAuthoritySha256}'::pg_catalog.text)`;
const qualifiedCatalogueReadSql = `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${cataloguePublicationRole}')
    AND ${cataloguePublicationAuthorityLedgerCondition.replaceAll("\n", "\n  ")}
  THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION ${qualifiedCatalogueReadTargets[0][1]},
      ${qualifiedCatalogueReadTargets[1][1]} TO ${cataloguePublicationRole};';
  END IF;
END; $$;
`;
export const qualifiedCatalogueStorageSelectSql = qualifiedCatalogueReadSql.replace(
  /GRANT EXECUTE ON FUNCTION [^;]+;/u,
  "GRANT SELECT (net_content_storage) ON TABLE public.catalog_sku_revisions TO openlup_catalog_publication;",
).trimEnd();

// The shape admits exactly one statement: the authority-ledger-guarded GRANT SELECT (amount_basis) ON TABLE public.price_lists TO openlup_catalog_publication, at most once per registry, inside one declared native-store slot.
// No table-level SELECT, no other column or table, no write privilege, no grant option, no other role.
// The grant-only file is exact through its final LF. The column must already be issued in an earlier native-store slot.
// This admission change adds no SQL.
const qualifiedPriceListBasisSelectSql = qualifiedCatalogueReadSql.replace(
  /GRANT EXECUTE ON FUNCTION [^;]+;/u,
  "GRANT SELECT (amount_basis) ON TABLE public.price_lists TO openlup_catalog_publication;",
);

// Each entry admits one exact guarded EXECUTE file after the target definitions are issued.
const qualifiedExecuteGrants = {
  "price-setup-execute": [
    "public.catalog_price_setup_apply_v2(text,text,uuid)",
    "public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid)",
  ],
  "catalog-publication-subscription-profile-identity-execute": ["public.catalog_publication_subscription_profile_identity(text,integer,text)"],
} as const;
const qualifiedExecuteEntry = (row: string) => Object.hasOwn(qualifiedExecuteGrants, row)
  ? row as keyof typeof qualifiedExecuteGrants : "price-setup-execute";

const checkoutOwnerRow = "catalog-checkout-owner-execute";
export const checkoutOwnerControls = [
  "scripts/reviewed-platform-forward.ts",
  "scripts/migrations/",
  "packages/platform/src/migrations/catalog.ts",
  "packages/platform/src/migrations/qualifiedInstall.ts",
];
const isCheckoutOwnerSlot = (slot: NativeStoreSlot) => slot.row === checkoutOwnerRow || checkoutOwnerGrantPath.test(slot.path)
  || Array.isArray(slot.grantOnlyFunctions) && slot.grantOnlyFunctions.some(entry =>
    [entry?.grantTo, entry?.revokeFrom].some(roles => Array.isArray(roles) && roles.includes(checkoutOwnerLogin)));
export const checkoutSlotRefusal = (path: string) => new Error(`checkout_owner_slot_invalid: ${path}. Use the single reviewed checkout-owner grant-only slot and pin.`);
export const checkoutForwardRefusal = (path: string) => new Error(`checkout_owner_forward_unverified: ${path}. Replay the reviewed grant bytes after landing the rule and its definitions.`);
export const checkoutPredecessorRefusal = (subject: string) => new Error(`checkout_owner_predecessor_unverified: ${subject}. Recover the original issued definition and its approval binding.`);
export const checkoutReplacementRefusal = (path: string) => new Error(`checkout_owner_predecessor_unverified: ${path}. Issue the checkout grant unit before replacing a checkout routine.`);

export const isQualifiedCatalogueReadGrant = (slot: NativeStoreSlot) => slot.grantOnlyFunctions.some(fn => Array.isArray(fn?.grantTo) && fn.grantTo.includes(cataloguePublicationRole));

export const previewAcceptanceSource = "db/platform/migrations/20261109120000_subscription_package_editor.sql";
export const previewAcceptanceSourceSha256 = "00291b733c89d9fe7e7d8785f90c6a8fe3c2e1d2b7dca4fc66abbc33de748fce";
// This issued successor references previews in routines and leaves the table and CHECK intact.
const previewAcceptanceReadSource = "db/platform/migrations/20261109140000_subscription_sized_editor.sql";
const previewAcceptanceReadSha256 = "13129ea49660b1b8ffb95fdaf99be2676e2f43f36086d99895c4a797bb842b1d";
// The new nullable column is NULL for every existing row. The first two branches
// then reduce to the entire old CHECK, and the third branch adds accepted rows
// with a receipt and no event. The existing NOT NULL status and vocabulary stay fixed.
export const previewNoopAcceptanceSql = `ALTER TABLE public.subscription_quote_previews ADD COLUMN accepted_noop_receipt_id uuid REFERENCES public.subscription_command_receipts(id);
ALTER TABLE public.subscription_quote_previews DROP CONSTRAINT subscription_quote_previews_acceptance_check;
ALTER TABLE public.subscription_quote_previews ADD CONSTRAINT subscription_quote_previews_acceptance_check CHECK (
  (status = 'previewed' AND accepted_at IS NULL AND accepted_idempotency_key IS NULL AND accepted_event_id IS NULL AND accepted_noop_receipt_id IS NULL)
  OR (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_idempotency_key IS NOT NULL AND accepted_event_id IS NOT NULL AND accepted_noop_receipt_id IS NULL)
  OR (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_idempotency_key IS NOT NULL AND accepted_event_id IS NULL AND accepted_noop_receipt_id IS NOT NULL)
);
`;
const previewAcceptanceColumn = previewNoopAcceptanceSql.split("\n", 1)[0]!;

const previewHistoryMention = /subscription_quote_previews/iu;

function allowsPreviewHistoryStatement(statement: string, tokens: readonly PlatformSqlToken[]): boolean {
  const word = (at: number, value: string) => nativeWord(tokens, at, value);
  const symbol = (at: number, value: string) => nativeSymbol(tokens, at, value);
  const identifier = (at: number) => nativeIdentifier(tokens[at]);
  const end = tokens.length - 1;
  if (!symbol(end, ";")) return false;
  const targetEnd = (at: number) => {
    const qualified = nativeQualified(tokens, at);
    if (qualified?.name === "public.subscription_quote_previews") return qualified.next;
    return identifier(at) === "subscription_quote_previews" && !symbol(at + 1, ".") ? at + 1 : -1;
  };
  const triggerTargetEnd = (at: number) => identifier(at) !== null && word(at + 1, "ON") ? targetEnd(at + 2) : -1;

  if (word(0, "CREATE")) {
    const kind = word(1, "OR") && word(2, "REPLACE") ? 3 : 1;
    if (word(kind, "FUNCTION") || word(kind, "PROCEDURE")) {
      const bodies = tokens.filter(token => token.kind === "string" && statement[token.start] === "$");
      const [body] = bodies;
      return bodies.length === 1 && body !== undefined && word(tokens.indexOf(body) - 1, "AS")
        && !previewHistoryMention.test(statement.slice(0, body.start))
        && !previewHistoryMention.test(statement.slice(body.end))
        && !/\b(?:ALTER|DROP|CREATE|TRUNCATE|RENAME)\b/iu.test(body.value);
    }
    const trigger = kind + (word(kind, "CONSTRAINT") ? 1 : 0);
    const name = trigger + 1;
    if (!word(trigger, "TRIGGER") || identifier(name) === null
      || !["BEFORE", "AFTER", "INSTEAD"].some(timing => word(name + 1, timing))) return false;
    const on = tokens.findIndex((_, at) => at > name + 1 && word(at, "ON"));
    const afterTarget = on < 0 ? -1 : targetEnd(on + 1);
    if (afterTarget < 0 || !["FROM", "NOT", "DEFERRABLE", "INITIALLY", "REFERENCING", "FOR", "WHEN", "EXECUTE"]
      .some(clause => word(afterTarget, clause))) return false;
    let execute = afterTarget, depth = 0;
    for (; execute < end; execute++) {
      if (symbol(execute, "(")) depth++;
      else if (symbol(execute, ")")) depth--;
      else if (depth === 0 && word(execute, "EXECUTE")) break;
    }
    if (!word(execute + 1, "FUNCTION") && !word(execute + 1, "PROCEDURE")) return false;
    const routine = nativeQualified(tokens, execute + 2);
    if (!routine || !symbol(routine.next, "(") || !symbol(end - 1, ")")) return false;
    return !tokens.slice(routine.next + 1, end - 1)
      .some(token => token.kind === "symbol" && ["(", ")", ";"].includes(token.value));
  }
  if (word(0, "DROP") && word(1, "TRIGGER")) {
    const name = word(2, "IF") && word(3, "EXISTS") ? 4 : 2;
    return triggerTargetEnd(name) === end;
  }
  if (word(0, "COMMENT") && word(1, "ON") && word(2, "TRIGGER")) {
    const is = triggerTargetEnd(3);
    const literal = tokens[is + 1];
    return is >= 0 && word(is, "IS") && is + 2 === end
      && literal?.kind === "string" && statement[literal.start] === "'";
  }
  const grant = word(0, "GRANT");
  if (grant || word(0, "REVOKE")) {
    const on = tokens.findIndex((_, at) => word(at, "ON"));
    if (on < 2) return false;
    const roles = targetEnd(on + (word(on + 1, "TABLE") ? 2 : 1));
    return roles >= 0 && word(roles, grant ? "TO" : "FROM") && identifier(roles + 1) !== null;
  }
  return false;
}

function previewHistoryRefusal(sql: string, bytes: Buffer): string | undefined {
  if (bytes.some(byte => (byte < 0x20 && byte !== 9 && byte !== 10) || byte === 0x7f)) {
    return "unsupported control characters; use LF line endings";
  }
  // Use the existing lexer that groups parenthesized clauses and BEGIN ATOMIC bodies.
  let statements: SecurityDefinerToken[][];
  try {
    statements = tokenizeSecurityDefinerStatements(sql, undefined, { requireComplete: true });
  } catch (error) {
    return `cannot split SQL: ${(error as Error).message}`;
  }
  let offset = 0;
  for (const statementTokens of statements) {
    const start = statementTokens[0]!.start, end = statementTokens.at(-1)!.end;
    if (previewHistoryMention.test(sql.slice(offset, start))) return "preview name outside a SQL statement";
    const statement = sql.slice(start, end);
    offset = end;
    const { tokens, complete } = platformSqlTokens(statement, false, true);
    if (!complete) return "cannot tokenize the full statement; use plain SQL identifiers and literals";
    if (previewHistoryMention.test(statement) && !allowsPreviewHistoryStatement(statement, tokens)) {
      return "preview reference outside the trigger, table privilege and routine-body allowlist";
    }
  }
  if (previewHistoryMention.test(sql.slice(offset))) return "preview name outside a SQL statement";
}

function assertPreviewNoopAcceptance(bytes: Buffer, preceding: { path: string; bytes: Buffer }[]): void {
  if (!bytes.equals(Buffer.from(previewNoopAcceptanceSql))) throw new Error("reviewed native store preview acceptance forward requires exactly the receipt column and adjacent validated CHECK replacement");
  const source = preceding.find(unit => unit.path === previewAcceptanceSource);
  if (!source || sqlSha256(source.bytes) !== previewAcceptanceSourceSha256) throw new Error("reviewed native store preview acceptance CHECK preimage file or hash drifted");
  // Earlier files that mention previews must split and tokenize completely. Only
  // trigger creation, removal and comments, table grants and revokes, and
  // dollar-quoted routine bodies without DDL keywords may mention the table.
  // A mentioning file with a standard string ending in a literal backslash is refused conservatively.
  // The PostgreSQL preimage proof compares the table's
  // full pg_depend closure, including triggers, with its expected snapshot
  // before the forward. Database-wide state is out of scope.
  for (const unit of preceding) {
    if (unit.path === previewAcceptanceSource) continue;
    const sql = unit.bytes.toString("utf8");
    if (!previewHistoryMention.test(sql)) continue;
    if (unit.path === previewAcceptanceReadSource && sqlSha256(unit.bytes) === previewAcceptanceReadSha256) continue;
    const reason = unit.path === previewAcceptanceReadSource ? "pinned read-source hash drifted" : previewHistoryRefusal(sql, unit.bytes);
    if (reason) {
      throw new Error(`reviewed native store preview acceptance CHECK refuses other preview history: ${unit.path}: ${reason}`);
    }
  }
}

export function renderQualifiedSecurityDefiner(signature: string): string {
  return `DO $qualified_security_definer$
BEGIN
  IF ${cataloguePublicationAuthorityLedgerCondition}
  THEN
    ALTER FUNCTION ${signature} SECURITY DEFINER;
  END IF;
END
$qualified_security_definer$;`;
}

const qualifiedSecurityDefinerAlter = /^ALTER FUNCTION (.+) SECURITY DEFINER;$/u;
let qualifiedSecurityDefiners: ReadonlySet<string> | undefined;
function cataloguePublicationAuthorityDefiners(): ReadonlySet<string> {
  if (!qualifiedSecurityDefiners) {
    const authority = readFileSync(new URL(`../../${cataloguePublicationAuthorityPath}`, import.meta.url));
    if (sqlSha256(authority) !== cataloguePublicationAuthoritySha256) throw new Error(`reviewed native store: restore the issued bytes of ${cataloguePublicationAuthorityPath}`);
    qualifiedSecurityDefiners = new Set(sqlStatements(authority.toString("utf8")).flatMap(statement => {
      const signature = qualifiedSecurityDefinerAlter.exec(statement)?.[1];
      return signature ? [signature] : [];
    }));
  }
  return qualifiedSecurityDefiners;
}

const nativeStoreSignature = (signature: string): string | null => {
  const match = /^(public\.[a-z_][a-z0-9_]*)[ \t\n]*\((.*)\)$/iu.exec(signature);
  if (!match) return null;
  try { return nativeStoreIdentity(match[1]!, match[2]!); } catch { return null; }
};

const nativeStoreSettingsSignature = (signature: string): string | null => {
  if (signature === "auth.uid()") return signature;
  const match = /^(acquisition_private\.[a-z_][a-z0-9_]*)[ \t\n]*\((.*)\)$/u.exec(signature);
  if (!match) return nativeStoreSignature(signature);
  try { return nativeStoreIdentity(match[1]!, match[2]!); } catch { return null; }
};

const nativeStoreFunctions = (slot: NativeStoreSlot): NativeStoreFunction[] => [...slot.replacedFunctions, ...slot.createdFunctions.map(fn => ({ ...fn, beforeSha256: null }))];

const nativePrefixStatementsCache = new WeakMap<Buffer, readonly { statement: string; tokens: PlatformSqlToken[]; complete: boolean }[]>();
const nativePrefixStatementsByHash = new Map<string, readonly { statement: string; tokens: PlatformSqlToken[]; complete: boolean }[]>();
function scanNativeStoreSql<T>(path: string, scan: () => T): T {
  try {
    return scan();
  } catch (error) {
    throw new Error(`reviewed native store cannot scan ${path}: ${(error as Error).message}`, { cause: error });
  }
}

function cachedNativePrefixStatements(bytes: Buffer): readonly { statement: string; tokens: PlatformSqlToken[]; complete: boolean }[] {
  let parsed = nativePrefixStatementsCache.get(bytes);
  if (!parsed) {
    const key = sqlSha256(bytes);
    parsed = nativePrefixStatementsByHash.get(key);
    if (!parsed) {
      parsed = cachedDumpSqlStatements(bytes, true).map(statement => {
        const { tokens, complete } = platformSqlTokens(statement, false, true);
        return { statement, tokens, complete };
      });
      if (nativePrefixStatementsByHash.size >= MAX_SQL_STATEMENT_CACHE_ENTRIES) nativePrefixStatementsByHash.clear();
      nativePrefixStatementsByHash.set(key, parsed);
    }
    nativePrefixStatementsCache.set(bytes, parsed);
  }
  return parsed;
}

function nativeStoreFunctionDefinitionFromTokens(
  statement: string,
  tokens: readonly PlatformSqlToken[],
  complete: boolean,
  allowed: ReadonlySet<string>,
  names: ReadonlySet<string>,
  preceding: boolean,
  sourcePath?: string,
): [string, string] | null {
  const functionIndex = nativeWord(tokens, 1, "OR") && nativeWord(tokens, 2, "REPLACE") ? 3 : 1;
  if (!nativeWord(tokens, 0, "CREATE") || !nativeWord(tokens, functionIndex, "FUNCTION")) return null;
  const name = nativeQualified(tokens, functionIndex + 1);
  if (preceding && name && !names.has(name.name)) return null;
  const context = sourcePath ? ` in ${sourcePath} for ${name?.name ?? tokens[functionIndex + 1]?.value ?? "<missing function name>"}` : "";
  if (!complete || !name || tokens[functionIndex + 1]?.kind === "quoted" || tokens[functionIndex + 3]?.kind === "quoted" || !nativeSymbol(tokens, name.next, "(")) throw new Error(preceding ? `reviewed native store unsupported preceding function DDL${context}` : "reviewed native store unsupported function header");
  let close = name.next, depth = 0;
  for (; close < tokens.length; close++) {
    if (nativeSymbol(tokens, close, "(")) depth++;
    if (nativeSymbol(tokens, close, ")") && --depth === 0) break;
  }
  if (close >= tokens.length || !nativeWord(tokens, close + 1, "RETURNS")) throw new Error(`reviewed native store unsupported function header${context}`);
  const signature = nativeStoreIdentity(name.name, statement.slice(tokens[name.next]!.end, tokens[close]!.start));
  if (!allowed.has(signature)) {
    if (preceding) return null;
    throw new Error(`reviewed native store unlisted signature: ${signature}`);
  }
  return [signature, sqlSha256(statement)];
}

/** Raw statement hashes, with normalized types and exact class-list membership. */
export function nativeStoreFunctionDefinitions(bytes: Buffer, signatures: readonly string[], preceding = false): Map<string, string> {
  const allowed = new Set(signatures), names = new Set(signatures.map(signature => signature.split("(")[0]!)), result = new Map<string, string>();
  if (preceding) {
    for (const { statement, tokens, complete } of cachedNativePrefixStatements(bytes)) {
      const definition = nativeStoreFunctionDefinitionFromTokens(statement, tokens, complete, allowed, names, true);
      if (definition) result.set(definition[0], definition[1]);
    }
    return result;
  }
  for (const statement of sqlStatements(bytes.toString("utf8"), false, false, true)) {
    const { tokens, complete } = platformSqlTokens(statement, false, true);
    const definition = nativeStoreFunctionDefinitionFromTokens(statement, tokens, complete, allowed, names, false);
    if (!definition) continue;
    const [signature, digest] = definition;
    if (result.has(signature)) throw new Error("reviewed native store duplicate function definition");
    result.set(signature, digest);
  }
  return result;
}
const nativeStoreInsertSelectTables = ["public.subscription_notice_refusals"];
const baselineTable = "public.commerce_offer_policy_rollout_baselines";
const baselinePrivileges = [
  `GRANT SELECT, INSERT ON TABLE ${baselineTable} TO service_role;`,
  `CREATE POLICY commerce_offer_policy_baselines_service_select ON ${baselineTable} FOR SELECT TO service_role USING (true);`,
  `CREATE POLICY commerce_offer_policy_baselines_service_insert ON ${baselineTable} FOR INSERT TO service_role WITH CHECK (true);`,
];
const assignmentDefaultSwitch = "ALTER TABLE public.subscriptions ALTER COLUMN offer_policy_assignment_state SET DEFAULT 'pending_acquisition';";
const assignmentLegacyColumn = "ADD COLUMN offer_policy_assignment_state text NOT NULL DEFAULT 'legacy_frozen'";
const nativeStoreInsertSelectGrant = "GRANT SELECT, INSERT ON public.subscription_notice_refusals TO service_role;";
const nativeStoreInsertSelectPolicy = "CREATE POLICY subscription_notice_refusals_runtime ON public.subscription_notice_refusals FOR ALL TO service_role USING (true) WITH CHECK (true);";
const absorptionCensusPolicy = (table: string) => `${table.slice("public.".length)}_absorption_census`;
const absorptionCensusGrant = (table: string) => `GRANT SELECT (client_id) ON TABLE ${table} TO service_role;`;
const absorptionCensusSelect = (table: string) => `CREATE POLICY ${absorptionCensusPolicy(table)} ON ${table} FOR SELECT TO service_role USING (true);`;
function absorptionCensusClassified(slot: NativeStoreSlot, table: string): boolean {
  const insert = new RegExp(`^INSERT INTO public\\.client_absorption_policy \\(table_name, disposition, note\\) VALUES \\('${table.slice("public.".length)}', 'block', '(?:[^']|'')*'\\);$`, "u");
  return slot.dataStatements.filter(statement => insert.test(statement)).length === 1;
}
const purposeTable = "public.communication_native_sync_state";
const purposeConstraint = "communication_native_sync_state_purpose_check";
// Route every later native migration through trusted admission, including SQL
// whose slot and pin were prepared in an earlier change. Explicit slots stay exact.
const firstNativeStoreTime = "20261101222000";
const nativeStoreTime = (path: string): string => /^db\/platform\/migrations\/(\d{14})_[a-z][a-z0-9_]*\.sql$/u.exec(path)?.[1] ?? "";
export const isNativeStoreMigrationPath = (path: string, slots?: readonly Pick<NativeStoreSlot, "path">[]): boolean => {
  if (checkoutOwnerGrantPath.test(path)) return true;
  if (slots) return slots.some(slot => Boolean(nativeStoreTime(slot.path)) && path.startsWith(`db/platform/migrations/${nativeStoreTime(slot.path)}_`));
  const time = /^db\/platform\/migrations\/(\d{14})_[^/]*\.sql$/u.exec(path)?.[1];
  return time !== undefined && time >= firstNativeStoreTime;
};

const nativeStoreName = (name: unknown): name is string => typeof name === "string" && /^[a-z_][a-z0-9_]*$/u.test(name);
const deferredNameRule = (name: unknown) => !nativeStoreName(name) || name.length > 63 ? "must be an unquoted identifier of at most 63 bytes"
  : deferredKeyword.has(name) ? "is a PostgreSQL keyword. Rename the trigger (for example, add a prefix) and register the new name." : undefined;
const nativeStoreTable = (name: unknown): name is string => typeof name === "string" && /^public\.[a-z_][a-z0-9_]*$/u.test(name);
const nativeStoreList = (values: unknown): values is string[] => Array.isArray(values) && values.length > 0 && values.every(nativeStoreName) && new Set(values).size === values.length;
const nativeStoreInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
const nativeWord = (tokens: readonly PlatformSqlToken[], index: number, word: string): boolean => tokens[index]?.kind === "word" && tokens[index]!.value.toUpperCase() === word;
const nativeSymbol = (tokens: readonly PlatformSqlToken[], index: number, value: string): boolean => tokens[index]?.kind === "symbol" && tokens[index]!.value === value;
const nativeIdentifier = (token: PlatformSqlToken | undefined): string | null => token?.kind === "word" ? token.value.toLowerCase() : token?.kind === "quoted" ? token.value : null;
function nativeQualified(tokens: readonly PlatformSqlToken[], start: number): { name: string; next: number } | null {
  const schema = nativeIdentifier(tokens[start]), name = nativeIdentifier(tokens[start + 2]);
  return schema !== null && name !== null && nativeSymbol(tokens, start + 1, ".") && !nativeSymbol(tokens, start + 3, ".") ? { name: `${schema}.${name}`, next: start + 3 } : null;
}
function nativeTableHead(tokens: readonly PlatformSqlToken[]): { verb: string; kind: string; table: string | null; next: number } | null {
  const verb = tokens[0]?.kind === "word" ? tokens[0].value.toUpperCase() : "";
  const kind = tokens[1]?.kind === "word" ? tokens[1].value.toUpperCase() : "";
  if (!["CREATE", "ALTER", "DROP"].includes(verb) || !["TABLE", "VIEW"].includes(kind)) return null;
  const target = nativeQualified(tokens, 2);
  return { verb, kind, table: target?.name ?? null, next: target?.next ?? 2 };
}
function nativeStoreAlter(statement: string): { table: string; actions: string[] } | null {
  const { tokens, complete } = platformSqlTokens(statement, false, true), head = nativeTableHead(tokens);
  if (!complete || head?.verb !== "ALTER" || head.kind !== "TABLE" || !head.table || !nativeSymbol(tokens, tokens.length - 1, ";") || head.next >= tokens.length - 1) return null;
  return { table: head.table, actions: nativeStoreArguments(statement.slice(tokens[head.next]!.start, tokens.at(-1)!.start)).map(nativeStoreTrim) };
}
const sameSkuConstraint = "subscription_lines_catalog_sku_revision_fkey";
// Keep the single-column grammar; the composite exception is one closed token shape.
function nativeStoreForeignKey(table: string, action: string) {
  const { tokens, complete } = platformSqlTokens(action, false, true);
  const name = nativeIdentifier(tokens[2]), column = nativeIdentifier(tokens[6]);
  if (name === sameSkuConstraint) {
    const shape = tokens.map(token => token.kind === "word" ? token.value.toUpperCase() : token.kind === "symbol" ? token.value : "").join(" ");
    if (!complete || table !== "public.subscription_lines" || shape !== "ADD CONSTRAINT SUBSCRIPTION_LINES_CATALOG_SKU_REVISION_FKEY FOREIGN KEY ( VARIANT_ID , CATALOG_SKU_REVISION_ID ) REFERENCES PUBLIC . CATALOG_SKU_REVISIONS ( SKU_ID , ID ) ON DELETE RESTRICT NOT VALID") return null;
    return { table, name, column: "catalog_sku_revision_id", reference: "public.catalog_sku_revisions", key: "id",
      columns: ["variant_id", "catalog_sku_revision_id"], keys: ["sku_id", "id"], deletion: "r", validated: false,
      start: tokens[19]!.start, end: tokens[21]!.end };
  }
  if (!complete || !nativeWord(tokens, 0, "ADD") || !nativeWord(tokens, 1, "CONSTRAINT") || !name || !nativeWord(tokens, 3, "FOREIGN") || !nativeWord(tokens, 4, "KEY") || !nativeSymbol(tokens, 5, "(") || !column || !nativeSymbol(tokens, 7, ")") || !nativeWord(tokens, 8, "REFERENCES")) return null;
  const reference = nativeQualified(tokens, 9), key = reference ? nativeIdentifier(tokens[reference.next + 1]) : null;
  if (!reference || !key || !nativeSymbol(tokens, reference.next, "(") || !nativeSymbol(tokens, reference.next + 2, ")") || !nativeWord(tokens, reference.next + 3, "ON") || !nativeWord(tokens, reference.next + 4, "DELETE")) return null;
  const start = reference.next + 3, deletion = nativeWord(tokens, start + 2, "RESTRICT") ? "r" : nativeWord(tokens, start + 2, "CASCADE") ? "c" : nativeWord(tokens, start + 2, "SET") && nativeWord(tokens, start + 3, "NULL") ? "n" : null;
  if (!deletion || (deletion !== "r" && (!nativeStoreTable(table) || !nativeStoreTable(reference.name) || ![name, column, key].every(nativeStoreName)))) return null;
  const end = start + (deletion === "n" ? 4 : 3);
  const notValid = nativeWord(tokens, end, "NOT") && nativeWord(tokens, end + 1, "VALID") && tokens.length === end + 2;
  if ((!notValid && tokens.length !== end) || (deletion === "r" && !notValid)) return null;
  return { table, name, column, reference: reference.name, key, columns: [column], keys: [key], deletion, validated: !notValid, start: tokens[start]!.start, end: tokens[end - 1]!.end };
}
/** Slot-local declarations only. Installed column freshness remains a catalogue obligation. */
export function nativeStoreAddedForeignKeys(statements: readonly string[]) {
  const columns = new Set<string>(), keys: NonNullable<ReturnType<typeof nativeStoreForeignKey>>[] = [];
  for (const statement of statements) {
    const alter = nativeStoreAlter(statement);
    if (!alter) continue;
    for (const action of alter.actions) {
      const { tokens } = platformSqlTokens(action, false, true);
      if (nativeWord(tokens, 0, "ADD") && nativeWord(tokens, 1, "COLUMN") && nativeIdentifier(tokens[2])) columns.add(`${alter.table}.${nativeIdentifier(tokens[2])}`);
      const key = nativeStoreForeignKey(alter.table, action);
      if (nativeWord(tokens, 0, "VALIDATE") && nativeWord(tokens, 1, "CONSTRAINT") && tokens.length === 3) {
        const added = keys.find(key => key.table === alter.table && key.name === nativeIdentifier(tokens[2]) && key.columns.length === 2);
        if (added) added.validated = true;
      }
      if (!key || (key.deletion === "r" && key.columns.length === 1)) continue;
      if (!columns.has(`${key.table}.${key.column}`)) throw new Error("reviewed native store FK delete action requires an earlier same-slot ADD COLUMN");
      keys.push(key);
    }
  }
  return keys;
}
/** Resolve a plain CREATE TABLE with the same token reader used by admission. */
export function nativeStoreCreatedTable(statement: string): string | null {
  const { tokens, complete } = platformSqlTokens(statement, false, true), head = nativeTableHead(tokens);
  return complete && head?.verb === "CREATE" && head.kind === "TABLE" && nativeSymbol(tokens, head.next, "(") ? head.table : null;
}
function nativeStoreAddAction(table: string, action: string): boolean {
  const { tokens, complete } = platformSqlTokens(action, false, true);
  if (!complete || !nativeWord(tokens, 0, "ADD") || !["COLUMN", "CONSTRAINT"].some(word => nativeWord(tokens, 1, word)) || nativeIdentifier(tokens[2]) === null) return false;
  const key = nativeStoreForeignKey(table, action);
  if (nativeIdentifier(tokens[2]) === sameSkuConstraint && !key) return false;
  const checked = key ? action.slice(0, key.start) + action.slice(key.end) : action;
  return isExpandOnlyPlatformForward(`ALTER TABLE ${table} ${checked};`);
}
function nativeStoreExistingStatement(statement: string, earlier: readonly string[]): { table: string; actions: string[] } {
  const alter = nativeStoreAlter(statement);
  // This changes future inserts only. The non-conditional ADD must first mark all
  // existing rows in this same slot; PostgreSQL independently proves freshness.
  if (statement === assignmentDefaultSwitch && earlier.some(sql => {
    const prior = nativeStoreAlter(sql);
    return prior?.table === "public.subscriptions" && prior.actions.includes(assignmentLegacyColumn);
  })) return alter!;
  if (!alter || alter.actions.some(action => {
    const { tokens, complete } = platformSqlTokens(action, false, true);
    if (nativeIdentifier(tokens[2]) === sameSkuConstraint && alter.actions.length !== 1) return true;
    const nullable = complete && tokens.length === 6 && nativeWord(tokens, 0, "ALTER") && nativeWord(tokens, 1, "COLUMN") && nativeIdentifier(tokens[2]) !== null && nativeWord(tokens, 3, "DROP") && nativeWord(tokens, 4, "NOT") && nativeWord(tokens, 5, "NULL");
    const validate = complete && tokens.length === 3 && nativeWord(tokens, 0, "VALIDATE") && nativeWord(tokens, 1, "CONSTRAINT") && nativeIdentifier(tokens[2]) !== null;
    return !nullable && !validate && !nativeStoreAddAction(alter.table, action);
  })) throw new Error("reviewed native store existing-table statement is not expand-only");
  return alter;
}
export function nativeStoreNewSlotTimes(root: string, base: string, before: ReviewedForwardRegistry, after: ReviewedForwardRegistry): void {
  const added = after.nativeStoreForwardClass?.slots.filter(slot => !before.nativeStoreForwardClass?.slots.some(prior => prior.path === slot.path)) ?? [];
  if (!added.length) return;
  const paths = git(root, ["ls-tree", "-r", "--name-only", base, "--", "db/platform/migrations/", "supabase/migrations/"]).toString("utf8").split("\n");
  const latest = paths.map(path => /\/(?:q2_|qa_|qb_)?(\d{14})_[^/]+\.sql$/u.exec(path)?.[1] ?? "").sort().at(-1) ?? "";
  if (added.some(slot => nativeStoreTime(slot.path) <= latest)) throw new Error("reviewed native store new slot time must be later than every base migration");
  for (const slot of added) if (slot.settingsOnlyFunctions) {
    assertNativeStoreSettingsTargets(slot.settingsOnlyFunctions, readPrecedingBlobs(root, base, "db/platform/migrations/", slot.path, true));
  }
}

export function assertNativeStoreSettingsTargets(settings: readonly NativeStoreFunctionSetting[], preceding: readonly { bytes: Buffer }[]): void {
  const signatures = settings.map(fn => fn.signature);
  const found = new Set(preceding.flatMap(source => [...nativeStoreFunctionDefinitions(source.bytes, signatures, true).keys()]));
  for (const signature of signatures) if (!found.has(signature)) throw new Error(`reviewed native store settings-only function absent from base migrations: ${signature}`);
}

const renderNativeStoreSetting = ({ signature, searchPath }: NativeStoreFunctionSetting) =>
  `ALTER FUNCTION ${signature} SET search_path = ${searchPath};`;

export function renderNativeStoreSettingsOwnerWindow(settings: readonly NativeStoreFunctionSetting[], role: string): string {
  return `DO $settings_owner_window$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles AS r WHERE r.rolname OPERATOR(pg_catalog.=) current_user) THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS a
      WHERE a.roleid OPERATOR(pg_catalog.=) (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname OPERATOR(pg_catalog.=) '${role}')
        AND a.member OPERATOR(pg_catalog.=) (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname OPERATOR(pg_catalog.=) current_user)
        AND a.grantor OPERATOR(pg_catalog.=) a.member) THEN
      RAISE EXCEPTION 'installer already holds a self-granted membership in ${role}' USING ERRCODE = '42501',
        HINT = 'Revoke that membership with REVOKE ${role} FROM the installer GRANTED BY the installer, then rerun the migration.';
    END IF;
    EXECUTE pg_catalog.format('GRANT ${role} TO %I WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY %I', current_user, current_user);
  END IF;
END
$settings_owner_window$;
${settings.map(renderNativeStoreSetting).join("\n")}
DO $settings_owner_window$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles AS r WHERE r.rolname OPERATOR(pg_catalog.=) current_user) THEN
    EXECUTE pg_catalog.format('REVOKE ${role} FROM %I GRANTED BY %I', current_user, current_user);
  END IF;
END
$settings_owner_window$;
`;
}

function nativeStoreOwnerWindowFields(slot: NativeStoreSlot, settingsOnly: boolean): string[] {
  if (!Object.hasOwn(slot, "ownerWindowRole")) return [];
  if (!settingsOnly) throw new Error("reviewed native store ownerWindowRole is allowed only on a settings-only slot. Remove ownerWindowRole from this slot.");
  const role = slot.ownerWindowRole;
  if (typeof role !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(role) || role.startsWith("pg_")) {
    throw new Error("reviewed native store ownerWindowRole must be an unquoted lowercase role name of at most 63 ASCII characters matching ^[a-z_][a-z0-9_]{0,62}$ and must not start with pg_.");
  }
  return ["ownerWindowRole"];
}

function assertNativeStoreSettingsOwnerWindow(settings: readonly NativeStoreFunctionSetting[], role: string, bytes: Buffer): void {
  const rendered = renderNativeStoreSettingsOwnerWindow(settings, role);
  if (bytes.equals(Buffer.from(rendered))) return;
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const expected = lines(rendered), actual = lines(bytes.toString("utf8"));
  const first = expected.findIndex((line, index) => line !== actual[index]);
  const index = first === -1 ? expected.length : first;
  const show = (line: string | undefined) => JSON.stringify(line) ?? "<end of file>";
  throw new Error(`reviewed native store settings-only owner window must match the rendered file exactly. Line ${index + 1}: expected ${show(expected[index])}; actual ${show(actual[index])}.`);
}

export const nativeStoreRevokePublicMessages = {
  placement: "native_store_revoke_public_placement: The flag is outside grantOnlyFunctions. Remove it from that field.",
  slot: "native_store_revoke_public_slot: The slot is outside the closed ACL-only shape. Use the documented revokePublic entry and companions.",
  base: "native_store_revoke_public_base: The target is absent from the pre-class chain. Use an existing base-chain function.",
  target: "native_store_revoke_public_target: An ACL statement names an unlisted function. Use one PUBLIC revoke per registered signature in registry order, then grant to the complete ordered list in the guarded block.",
  missing: "native_store_revoke_public_missing: A listed target lacks its direct PUBLIC revoke. Add it before the guarded grant.",
  order: "native_store_revoke_public_order: The ACL statements are out of order. Put the PUBLIC revokes in registry order before the guarded grant.",
  grant: "native_store_revoke_public_grant: The slot requires one guarded service_role EXECUTE grant. Use the documented block without grant option.",
  security: "native_store_revoke_public_security: The target is a SECURITY DEFINER. Use an existing SECURITY INVOKER target.",
  aclOnly: "native_store_revoke_public_acl_only: The slot contains a change outside its ACL statements. Move that change to a separate reviewed forward.",
} as const;

export function assertRevokePublicPlacement(value: unknown, path: (string | number)[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRevokePublicPlacement(entry, [...path, index]));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "revokePublic" && !(path.length === 5 && path[0] === "nativeStoreForwardClass"
        && path[1] === "slots" && typeof path[2] === "number" && path[3] === "grantOnlyFunctions"
        && typeof path[4] === "number")) throw new Error(nativeStoreRevokePublicMessages.placement);
      if (entry && typeof entry === "object") assertRevokePublicPlacement(entry, [...path, key]);
    }
  }
}

const hasRevokePublic = (slot: NativeStoreSlot) =>
  Array.isArray(slot.grantOnlyFunctions) && slot.grantOnlyFunctions.some(fn => fn && Object.hasOwn(fn, "revokePublic"));

export function validateNativeStoreClass(registry: ReviewedForwardRegistry, paths: Set<string>): void {
  const control = registry.nativeStoreForwardClass;
  if (control === undefined) {
    if (registry.nativeStoreForwards !== undefined) throw new Error("reviewed native store bindings require prior class approval");
    return;
  }
  if (!keysAre(control, "sealed,slots") || typeof control.sealed !== "boolean" || !Array.isArray(control.slots)) throw new Error("reviewed native store requires a closed slots list");
  for (const slot of control.slots.filter(hasRevokePublic)) {
    const binding = Array.isArray(registry.nativeStoreForwards) ? registry.nativeStoreForwards.find(pin => pin.path === slot.path) : undefined;
    if (!keysAre(slot, "createdFunctions,dataStatements,grantOnlyFunctions,path,replacedFunctions,row")
      || [slot.createdFunctions, slot.replacedFunctions, slot.dataStatements, ...(binding ? [binding.functions] : [])].some(list => !Array.isArray(list) || list.length)
      || slot.grantOnlyFunctions.some(fn => !fn || !keysAre(fn, "grantTo,revokeFrom,revokePublic,signature") || fn.revokePublic !== true
        || canonical(fn.grantTo) !== '["service_role"]' || canonical(fn.revokeFrom) !== "[]"
        || typeof fn.signature !== "string" || nativeStoreSignature(fn.signature) !== fn.signature)
      || new Set(slot.grantOnlyFunctions.map(fn => fn.signature)).size !== slot.grantOnlyFunctions.length) {
      throw new Error(nativeStoreRevokePublicMessages.slot);
    }
  }
  let previous = "";
  let previewNoopAcceptance = false;
  const rows = new Set<string>();
  for (const slot of control.slots) {
    const time = nativeStoreTime(slot.path);
    if (isCheckoutOwnerSlot(slot)) {
      const expected = {
        path: slot.path, row: checkoutOwnerRow, createdFunctions: [], replacedFunctions: [], dataStatements: [],
        grantOnlyFunctions: checkoutOwnerRoutines.map(signature => ({ signature, grantTo: [checkoutOwnerLogin], revokeFrom: [] })),
      };
      if (!checkoutOwnerGrantPath.test(slot.path) || time <= previous || rows.has(slot.row) || paths.has(slot.path)
        || canonical(slot) !== canonical(expected)) throw checkoutSlotRefusal(slot.path);
      previous = time;
      rows.add(slot.row);
      paths.add(slot.path);
      continue;
    }
    const settingsOnly = Object.hasOwn(slot, "settingsOnlyFunctions");
    const fields = ["createdFunctions", "dataStatements", "grantOnlyFunctions", "path", "replacedFunctions", "row", ...nativeStoreOwnerWindowFields(slot, settingsOnly)];
    if (settingsOnly) fields.push("settingsOnlyFunctions");
    else {
      fields.push(...["purposeCheck", "checkSupersets", "checkToFunctionGuard", "uniqueSupersets", "droppedIndexes", "createdViews", "createdTriggers", "absorptionCensusTables", "qualifiedCatalogueStorageSelect", "qualifiedPriceListBasisSelect", "qualifiedPriceSetupExecute", "previewNoopAcceptance"].filter(key => Object.hasOwn(slot, key)));
      if (slot.existingTableStatements !== undefined) fields.push("existingTableStatements");
      if (slot.insertSelectTables !== undefined) fields.push("insertSelectTables");
    }
    const keys = fields.sort().join(",");
    if (!keysAre(slot, keys) || typeof slot.row !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(slot.row) || rows.has(slot.row) || !time || time <= previous || paths.has(slot.path)) throw new Error("reviewed native store slot path, row or order drifted");
    previous = time; rows.add(slot.row);
    paths.add(slot.path);
    if (hasRevokePublic(slot)) continue;
    if (!Array.isArray(slot.replacedFunctions) || !Array.isArray(slot.createdFunctions) || !Array.isArray(slot.grantOnlyFunctions)) throw new Error("reviewed native store requires three closed function lists");
    if (settingsOnly) {
      const settings = slot.settingsOnlyFunctions;
      if (slot.replacedFunctions.length || slot.createdFunctions.length || slot.grantOnlyFunctions.length || !Array.isArray(slot.dataStatements) || slot.dataStatements.length) throw new Error("reviewed native store settings-only slot requires empty function definition, grant and data lists");
      if (!Array.isArray(settings) || !settings.length || settings.some(fn =>
        !fn || !keysAre(fn, "searchPath,signature")
        || typeof fn.signature !== "string" || nativeStoreSettingsSignature(fn.signature) !== fn.signature
        || typeof fn.searchPath !== "string" || !/^(?:(?!pg_temp, )[a-z_][a-z0-9_]*, )*pg_temp$/u.test(fn.searchPath))) {
        throw new Error("reviewed native store settings-only slot requires canonical qualified signatures and search_path ending in pg_temp. Use public.<name>(<types>), acquisition_private.<name>(<types>) or exactly auth.uid().");
      }
      if (new Set(settings.map(fn => fn.signature)).size !== settings.length) throw new Error("reviewed native store settings-only slot has duplicate signatures");
      continue;
    }
    if (Object.hasOwn(slot, "qualifiedCatalogueStorageSelect")
      && (slot.qualifiedCatalogueStorageSelect !== true || control.slots.some(other => other !== slot && other.qualifiedCatalogueStorageSelect))) {
      throw new Error("reviewed native store allows one qualifiedCatalogueStorageSelect slot");
    }
    const grantOnlyFlag = (["qualifiedPriceListBasisSelect", "qualifiedPriceSetupExecute"] as const).find(key => Object.hasOwn(slot, key));
    if (grantOnlyFlag) {
      const expected = {
        path: slot.path, row: slot.row, createdFunctions: [], replacedFunctions: [], grantOnlyFunctions: [], dataStatements: [],
        [grantOnlyFlag]: true,
      };
      if (control.slots.some(other => other !== slot && other[grantOnlyFlag]
        && (grantOnlyFlag !== "qualifiedPriceSetupExecute" || qualifiedExecuteEntry(other.row) === qualifiedExecuteEntry(slot.row)))) {
        throw new Error(`reviewed native store allows one ${grantOnlyFlag} slot`);
      }
      const grant = grantOnlyFlag === "qualifiedPriceListBasisSelect" ? "qualified price list basis SELECT" : "qualified price setup EXECUTE";
      if (canonical(slot) !== canonical(expected)) throw new Error(`reviewed native store ${grant} slot must be grant-only`);
      continue;
    }
    if (isQualifiedCatalogueReadGrant(slot)) {
      const expected = {
        path: slot.path, row: slot.row, createdFunctions: [], replacedFunctions: [], dataStatements: [],
        grantOnlyFunctions: qualifiedCatalogueReadTargets.map(([, signature]) => ({ signature, grantTo: [cataloguePublicationRole], revokeFrom: [] })),
      };
      if (canonical(slot) !== canonical(expected)) throw new Error("reviewed native store qualified catalogue read slot must list exactly the two grants and no other capabilities");
      continue;
    }
    const functions = nativeStoreFunctions(slot);
    for (const fn of slot.replacedFunctions) {
      const marked = Object.hasOwn(fn, "qualifiedSecurityDefiner");
      if (marked && fn.qualifiedSecurityDefiner !== true) throw new Error(`reviewed native store ${fn.signature}: qualifiedSecurityDefiner must be true when present`);
      if (!keysAre(fn, marked ? "beforeSha256,qualifiedSecurityDefiner,searchPath,signature" : "beforeSha256,searchPath,signature") || !hash(fn.beforeSha256)) throw new Error("reviewed native store closed signature, preimage or search_path drifted");
      const required = cataloguePublicationAuthorityDefiners().has(fn.signature);
      if (required && !marked) throw new Error(`reviewed native store ${fn.signature}: set qualifiedSecurityDefiner: true and put this statement immediately after its CREATE OR REPLACE FUNCTION:\n${renderQualifiedSecurityDefiner(fn.signature)}`);
      if (marked && !required) throw new Error(`reviewed native store ${fn.signature}: the qualified authority migration leaves its SECURITY mode unchanged. Remove qualifiedSecurityDefiner and omit this statement:\n${renderQualifiedSecurityDefiner(fn.signature)}`);
      if (marked) {
        const schemas = typeof fn.searchPath === "string" ? parseAsciiSearchPath(fn.searchPath) : null;
        if (schemas?.at(-1) !== "pg_temp" || hasPgTempSchema(schemas.slice(0, -1).join(", "))) {
          const expected = schemas?.filter(schema => !hasPgTempSchema(schema)).join(", ") || "pg_catalog";
          throw new Error(`reviewed native store ${fn.signature}: qualifiedSecurityDefiner must pin SET search_path = ${expected}, pg_temp`);
        }
      }
    }
    for (const fn of slot.createdFunctions) {
      if (Object.hasOwn(fn, "qualifiedSecurityDefiner")) throw new Error(`reviewed native store ${fn.signature}: remove qualifiedSecurityDefiner from createdFunctions; it applies only to replacements`);
      if (!keysAre(fn, "searchPath,signature")) throw new Error("reviewed native store closed signature, preimage or search_path drifted");
    }
    if (functions.some(fn => nativeStoreSignature(fn.signature) !== fn.signature || (fn.searchPath !== null && !/^[a-z_][a-z0-9_]*(?:, [a-z_][a-z0-9_]*)*$/u.test(fn.searchPath)))) throw new Error("reviewed native store closed signature, preimage or search_path drifted");
    for (const fn of slot.grantOnlyFunctions) {
      if (!keysAre(fn, "grantTo,revokeFrom,signature") || nativeStoreSignature(fn.signature) !== fn.signature || !Array.isArray(fn.grantTo) || !Array.isArray(fn.revokeFrom) || fn.grantTo.length + fn.revokeFrom.length === 0 || fn.grantTo.includes("anon") || [...fn.grantTo, ...fn.revokeFrom].some(role => !nativeStoreRoles.includes(role)) || new Set(fn.grantTo).size !== fn.grantTo.length || new Set(fn.revokeFrom).size !== fn.revokeFrom.length) throw new Error("reviewed native store invalid grant-only signature or role capability");
    }
    const signatures = [...functions, ...slot.grantOnlyFunctions].map(fn => fn.signature);
    if (new Set(signatures).size !== signatures.length) throw new Error("reviewed native store function lists must be disjoint and unique");
    if (!Array.isArray(slot.dataStatements) || slot.dataStatements.some(sql => typeof sql !== "string" || !/^(?:INSERT|UPDATE|DELETE) /u.test(sql) || sqlStatements(sql).length !== 1) || new Set(slot.dataStatements).size !== slot.dataStatements.length) throw new Error("reviewed native store data statements must be exact named statements");
    if (slot.absorptionCensusTables !== undefined && (!Array.isArray(slot.absorptionCensusTables)
      || new Set(slot.absorptionCensusTables).size !== slot.absorptionCensusTables.length
      || slot.absorptionCensusTables.some(table => !nativeStoreTable(table) || absorptionCensusPolicy(table).length > 63
        || slot.insertSelectTables?.includes(table) || !absorptionCensusClassified(slot, table)))) {
      throw new Error("reviewed native store absorption census requires unique qualified tables and exact block classifications");
    }
    if (slot.insertSelectTables !== undefined && JSON.stringify(slot.insertSelectTables) !== JSON.stringify([baselineTable])) {
      if (slot.row !== "G8") throw new Error("reviewed native store insertSelectTables is G8-only");
      if (JSON.stringify(slot.insertSelectTables) !== JSON.stringify(nativeStoreInsertSelectTables)) throw new Error("reviewed native store insertSelectTables is pinned by the checker");
    }
    if (slot.existingTableStatements !== undefined) {
      if (!Array.isArray(slot.existingTableStatements) || new Set(slot.existingTableStatements).size !== slot.existingTableStatements.length) throw new Error("reviewed native store existing-table statements must be unique exact texts");
      for (const [index, statement] of slot.existingTableStatements.entries()) {
        if (typeof statement !== "string" || sqlStatements(statement, false, false, true).length !== 1) throw new Error("reviewed native store existing-table statement is not expand-only");
        nativeStoreExistingStatement(statement, slot.existingTableStatements.slice(0, index));
      }
      nativeStoreAddedForeignKeys(slot.existingTableStatements);
    }
    if (Object.hasOwn(slot, "previewNoopAcceptance")) {
      const expected = {
        path: slot.path, row: slot.row, replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [],
        previewNoopAcceptance: true, existingTableStatements: [previewAcceptanceColumn],
      };
      if (previewNoopAcceptance || canonical(slot) !== canonical(expected)) throw new Error("reviewed native store preview acceptance requires one slot listing only the receipt column");
      previewNoopAcceptance = true;
    }
    if (slot.checkSupersets !== undefined && (!Array.isArray(slot.checkSupersets) || slot.checkSupersets.some(check => {
      if (!nativeStoreTable(check.table) || !nativeStoreName(check.constraint) || !nativeStoreName(check.column)) return true;
      if ("values" in check) return !keysAre(check, "column,constraint,table,values") || !nativeStoreList(check.values);
      return !keysAre(check, "beforeSha256,column,constraint,range,table") || !hash(check.beforeSha256)
        || !check.range || !keysAre(check.range, "lower,upper") || !nativeStoreInteger(check.range.lower)
        || !nativeStoreInteger(check.range.upper) || check.range.lower > check.range.upper;
    }))) throw new Error("reviewed native store invalid CHECK superset entry");
    if (slot.uniqueSupersets !== undefined && (!Array.isArray(slot.uniqueSupersets) || slot.uniqueSupersets.some(unique => !keysAre(unique, "columns,constraint,nullsNotDistinct,table") || !nativeStoreTable(unique.table) || !nativeStoreName(unique.constraint) || !nativeStoreList(unique.columns) || typeof unique.nullsNotDistinct !== "boolean"))) throw new Error("reviewed native store invalid UNIQUE superset entry");
    if (slot.checkToFunctionGuard !== undefined) {
      if (!Array.isArray(slot.checkToFunctionGuard) || slot.checkToFunctionGuard.length === 0) {
        throw new Error("reviewed native store checkToFunctionGuard requires a non-empty array");
      }
      const replacedSignatures = new Set(slot.replacedFunctions.map(fn => fn.signature));
      for (const entry of slot.checkToFunctionGuard) {
        if (!entry || typeof entry !== "object"
          || !keysAre(entry, "afterSha256,beforeSha256,column,guardFunctions,name,table")
          || !nativeStoreTable(entry.table) || !nativeStoreName(entry.name) || !nativeStoreName(entry.column)
          || !hash(entry.beforeSha256) || !hash(entry.afterSha256) || entry.beforeSha256 === entry.afterSha256) {
          throw new Error("reviewed native store invalid checkToFunctionGuard entry");
        }
        if (!Array.isArray(entry.guardFunctions) || entry.guardFunctions.length === 0) {
          throw new Error(`reviewed native store checkToFunctionGuard requires at least one guardFunctions entry: ${entry.table}.${entry.name}`);
        }
        if (new Set(entry.guardFunctions).size !== entry.guardFunctions.length
          || entry.guardFunctions.some(sig => typeof sig !== "string" || nativeStoreSignature(sig) !== sig)) {
          throw new Error(`reviewed native store checkToFunctionGuard guardFunctions must be unique canonical signatures: ${entry.table}.${entry.name}`);
        }
        for (const sig of entry.guardFunctions) {
          if (!replacedSignatures.has(sig)) {
            throw new Error(`reviewed native store checkToFunctionGuard guardFunction must be listed in slot.replacedFunctions: ${sig}`);
          }
        }
      }
    }
    const constraints = [
      ...slot.checkSupersets ?? [],
      ...slot.purposeCheck ? [{ table: purposeTable, constraint: purposeConstraint }] : [],
      ...slot.uniqueSupersets ?? [],
      ...(slot.checkToFunctionGuard ?? []).map(entry => ({ table: entry.table, constraint: entry.name })),
    ].map(entry => `${entry.table}.${entry.constraint}`);
    if (new Set(constraints).size !== constraints.length) throw new Error("reviewed native store duplicate constraint entry");
    if (slot.droppedIndexes !== undefined && (!Array.isArray(slot.droppedIndexes) || slot.droppedIndexes.some(index => !keysAre(index, "beforeSha256,name,table") || !nativeStoreTable(index.table) || !nativeStoreName(index.name) || !hash(index.beforeSha256)) || new Set(slot.droppedIndexes.map(index => index.name)).size !== slot.droppedIndexes.length)) throw new Error("reviewed native store invalid dropped index inventory");
    if (slot.createdViews !== undefined && (!Array.isArray(slot.createdViews) || slot.createdViews.some(view => !keysAre(view, "name,sha256") || !nativeStoreTable(view.name) || !hash(view.sha256)) || new Set(slot.createdViews.map(view => view.name)).size !== slot.createdViews.length)) throw new Error("reviewed native store invalid created view inventory");
    if (slot.createdTriggers !== undefined && (!Array.isArray(slot.createdTriggers) || slot.createdTriggers.some((trigger, index, entries) => {
      if (!trigger || typeof trigger !== "object") throw new Error(deferredTriggerMessages.field(null, "entry", "must be an object"));
      const prior = entries.find((entry, position) => position < index && entry.name === trigger.name);
      if (prior && (trigger.deferred === true || prior.deferred === true)) throw new Error(deferredTriggerMessages.duplicateEntry(trigger.name));
      if (trigger.deferred !== true && !("deferred" in trigger || "relation" in trigger)) return Boolean(prior)
        || !nativeStoreName(trigger.name) || !hash(trigger.sha256) || !keysAre(trigger, "name,sha256,table") || !nativeStoreTable(trigger.table);
      const invalid = (field: string, rule: string): never => { throw new Error(deferredTriggerMessages.field(trigger.name, field, `must be ${rule}`)); };
      if (trigger.deferred !== true) return invalid("deferred", "true");
      const rule = deferredNameRule(trigger.name);
      if (rule) throw new Error(deferredTriggerMessages.field(trigger.name, "name", rule));
      if (!nativeStoreTable(trigger.relation) || trigger.relation.length > 70) invalid("relation", "a public relation with an identifier of at most 63 bytes");
      if (typeof trigger.function !== "string" || !/^public\.[a-z_][a-z0-9_]{0,62}\(\)$/u.test(trigger.function)) invalid("function", "a zero-argument public function of at most 63 bytes");
      if (deferredKeyword.has(trigger.function.slice(7, -2))) throw new Error(deferredTriggerMessages.field(trigger.name, "function", "name is a PostgreSQL keyword. Rename the function (for example, add a prefix) and register the new name."));
      if (!Array.isArray(trigger.events) || !trigger.events.length || canonical(trigger.events) !== canonical(deferredEvents.filter(event => trigger.events.includes(event)))) invalid("events", "a nonempty ordered subset of INSERT, UPDATE, DELETE");
      if (!hash(trigger.sha256)) invalid("sha256", "the 64-character SHA-256 digest of the statement");
      return !keysAre(trigger, "deferred,events,function,name,relation,sha256") && invalid("fields", "name, relation, events, function, deferred and sha256");
    }))) throw new Error("reviewed native store invalid created trigger inventory");
    if (slot.purposeCheck && (slot.row !== "G11-c" || !keysAre(slot.purposeCheck, "beforeSha256,values") || !hash(slot.purposeCheck.beforeSha256) || !Array.isArray(slot.purposeCheck.values) || slot.purposeCheck.values.length === 0 || slot.purposeCheck.values.some(value => !/^[a-z][a-z0-9_]*$/u.test(value)) || new Set(slot.purposeCheck.values).size !== slot.purposeCheck.values.length)) throw new Error("reviewed native store permits only the account-consent purpose CHECK");
  }
  const forwards = registry.nativeStoreForwards;
  if (!Array.isArray(forwards) || forwards.length > control.slots.length) throw new Error("reviewed native store requires feature bindings within its slots");
  let priorIndex = -1;
  for (const forward of forwards) {
    const index = control.slots.findIndex(slot => slot.path === forward.path), slot = control.slots[index];
    const functions = slot ? nativeStoreFunctions(slot) : [];
    if (!slot || index <= priorIndex || !keysAre(forward, "functions,path,sha256") || !hash(forward.sha256) || !Array.isArray(forward.functions) || forward.functions.length !== functions.length) {
      if (checkoutOwnerGrantPath.test(forward.path)) throw checkoutSlotRefusal(forward.path);
      throw new Error("reviewed native store feature path, order or inventory drifted");
    }
    priorIndex = index;
    for (const [position, fn] of forward.functions.entries()) {
      const fixed = functions[position]!;
      if (!keysAre(fn, "afterSha256,beforeSha256,signature") || fn.signature !== fixed.signature || fn.beforeSha256 !== fixed.beforeSha256 || !hash(fn.afterSha256)) throw new Error("reviewed native store feature signature or before-hash drifted");
    }
  }
  const predecessors = new Map<string, string | undefined>();
  for (const slot of control.slots) for (const fn of nativeStoreFunctions(slot)) {
    if (fn.beforeSha256 !== null && predecessors.has(fn.signature)) {
      const predecessor = predecessors.get(fn.signature);
      if (!predecessor) throw new Error("reviewed native store chained replacement requires a bound predecessor");
      if (fn.beforeSha256 !== predecessor) throw new Error("reviewed native store chained replacement before-hash differs from preceding after-hash");
    }
    predecessors.set(fn.signature, forwards.find(pin => pin.path === slot.path)?.functions.find(pin => pin.signature === fn.signature)?.afterSha256);
  }
}

export function assertNativeStoreClassTransition(before: ReviewedForwardRegistry, after: ReviewedForwardRegistry): void {
  const prior = before.nativeStoreForwardClass, current = after.nativeStoreForwardClass;
  if (prior && !current) throw new Error("reviewed native store class cannot be removed");
  if (prior?.sealed && (!current?.sealed || canonical(prior.slots) !== canonical(current?.slots.slice(0, prior.slots.length)))) throw new Error("reviewed native store sealed slot prefix is immutable and cannot be unsealed");
  for (const [index, pin] of (before.nativeStoreForwards ?? []).entries()) {
    const slotIndex = prior!.slots.findIndex(slot => slot.path === pin.path);
    if (canonical(after.nativeStoreForwards?.[index]) !== canonical(pin)
      || canonical(prior!.slots[slotIndex]) !== canonical(current?.slots[slotIndex])) throw new Error("reviewed native store issued bindings and slots are immutable");
  }
}

// CD-M19-47: narrowing only, on qualified tables created earlier in this file.
// Keep this beside the DO rule; neither exception changes expand-only admission.
function nativeTableTargets(tokens: readonly PlatformSqlToken[], start: number): { targets: string[]; next: number } | null {
  const targets: string[] = []; let index = start;
  for (;;) {
    const target = nativeQualified(tokens, index);
    if (!target) return null;
    targets.push(target.name); index = target.next;
    if (!nativeSymbol(tokens, index, ",")) return { targets, next: index };
    index++;
  }
}
function nativeStoreTableNarrowing(statement: string, tables: Set<string>): { kind: "RLS" } | { kind: "TABLE"; targets: string[]; role: string; grant: false } | null {
  const { tokens, complete } = platformSqlTokens(statement, false, true), head = nativeTableHead(tokens);
  const rls = complete && head?.verb === "ALTER" && head.kind === "TABLE" && head.table && ["ENABLE", "ROW", "LEVEL", "SECURITY"].every((word, offset) => nativeWord(tokens, head.next + offset, word)) && nativeSymbol(tokens, head.next + 4, ";") && head.next + 5 === tokens.length;
  const revoke = complete && ["REVOKE", "ALL", "ON", "TABLE"].every((word, index) => nativeWord(tokens, index, word)) ? nativeTableTargets(tokens, 4) : null;
  if (!rls && !revoke) return null;
  const targets = rls ? [head!.table!] : revoke!.targets;
  const role = revoke && tokens[revoke.next + 1]?.kind === "word" ? tokens[revoke.next + 1]!.value.toLowerCase() : "";
  if (revoke && (!nativeWord(tokens, revoke.next, "FROM") || ![...nativeStoreRoles, "public"].includes(role) || !nativeSymbol(tokens, revoke.next + 2, ";") || revoke.next + 3 !== tokens.length)) return null;
  if (targets.some(table => !tables.has(table)) || new Set(targets).size !== targets.length) throw new Error("reviewed native store table narrowing requires tables created earlier in the same slot file");
  return rls ? { kind: "RLS" } : { kind: "TABLE", targets, role, grant: false };
}

const nativeStoreRolePrivilege = /^DO \$\$[ \t\n]*BEGIN[ \t\n]+IF EXISTS[ \t\n]*\(SELECT 1 FROM pg_roles WHERE rolname[ \t\n]*=[ \t\n]*'(anon|authenticated|service_role)'\) THEN[ \t\n]+EXECUTE '([^']+)';[ \t\n]*END IF;[ \t\n]*END;[ \t\n]*\$\$;$/i;

// The generic DO exception. Keep its grammar and role policy together so a later
// control can tighten or remove it without changing the generic SQL splitter.
function nativeStorePrivilege(statement: string, tables: Set<string>, insertSelectTables: string[], views = new Set<string>(), triggerFunctions = new Set<string>(), censusTables: string[] = [], block: RegExpExecArray | null = null): { kind: "RLS" } | { kind: "POLICY" } | { kind: "BASELINE"; action: number } | { kind: "CENSUS"; table: string; action: "grant" | "policy" } | { kind: "FUNCTION" | "TABLE"; targets: string[]; role: string; grant: boolean; conditional: boolean } | null {
  let sql = statement, exactSql = statement, roleGuard: string | undefined;
  const conditional = /^DO\b/iu.test(statement);
  if (conditional) {
    if (!block || !nativeStoreRoles.includes(block[1]!)) throw new Error("reviewed native store refuses DO outside the single constant role privilege shape");
    if (!nativeStoreAscii(block[2]!)) throw new Error("reviewed native store conditional privilege requires ASCII identifiers and verbs");
    exactSql = block[2]!;
    roleGuard = block[1]!.toLowerCase(); sql = block[2]!.replace(/;?$/u, ";");
  }
  for (const table of censusTables) {
    const action = exactSql === absorptionCensusGrant(table) ? "grant" : exactSql === absorptionCensusSelect(table) ? "policy" : null;
    if (!action) continue;
    if (!conditional || roleGuard !== "service_role") throw new Error("reviewed native store absorption census requires the service_role conditional shell");
    return { kind: "CENSUS", table, action };
  }
  const baselineAction = baselinePrivileges.indexOf(exactSql);
  if (baselineAction >= 0) {
    if (JSON.stringify(insertSelectTables) !== JSON.stringify([baselineTable]) || !tables.has(baselineTable)
      || !conditional || roleGuard !== "service_role") throw new Error("reviewed native store baseline requires its pinned same-slot table and service_role conditional shell");
    return { kind: "BASELINE", action: baselineAction };
  }
  if (exactSql === nativeStoreInsertSelectGrant || exactSql === nativeStoreInsertSelectPolicy) {
    if (!insertSelectTables.includes(nativeStoreInsertSelectTables[0]!)) throw new Error("reviewed native store INSERT/SELECT requires the pinned G8 table");
    if (!tables.has(nativeStoreInsertSelectTables[0]!)) throw new Error("reviewed native store INSERT/SELECT requires its table created earlier in the same slot file");
    if (!conditional || roleGuard !== "service_role") throw new Error("reviewed native store INSERT/SELECT requires the service_role conditional shell");
    return exactSql === nativeStoreInsertSelectPolicy ? { kind: "POLICY" } : { kind: "TABLE", targets: nativeStoreInsertSelectTables, role: "service_role", grant: true, conditional };
  }
  const privilegeTokens = platformSqlTokens(sql, false, true).tokens;
  if (nativeWord(privilegeTokens, 0, "GRANT")) {
    const on = privilegeTokens.findIndex((_token, index) => nativeWord(privilegeTokens, index, "ON"));
    if (on >= 0 && !nativeWord(privilegeTokens, on + 1, "FUNCTION")) {
      const targets = nativeTableTargets(privilegeTokens, on + (nativeWord(privilegeTokens, on + 1, "TABLE") ? 2 : 1));
      if ((targets?.targets.some(target => views.has(target))) || (!targets && views.size)) throw new Error("reviewed native store created view GRANT refused");
    }
  }
  const table = nativeStoreTableNarrowing(sql, nativeWord(privilegeTokens, 0, "REVOKE") ? new Set([...tables, ...views]) : tables);
  if (table) {
    if (table.kind === "RLS") {
      if (conditional) throw new Error("reviewed native store conditional RLS refused");
      return table;
    }
    if (conditional ? table.role !== roleGuard : table.role !== "public" || table.targets.length !== 1) throw new Error("reviewed native store table revoke requires PUBLIC or the same conditional role");
    return { ...table, conditional };
  }
  const match = /^(GRANT EXECUTE|REVOKE (?:ALL(?: PRIVILEGES)?|EXECUTE)) ON FUNCTION (.+) (TO|FROM) (PUBLIC|anon|authenticated|service_role);$/iu.exec(nativeStoreTrim(sql.replace(/[ \t\n]+/gu, " ")));
  if (!match) {
    if (conditional) throw new Error("reviewed native store conditional privilege target or role refused");
    return null;
  }
  const grant = match[1]!.toUpperCase() === "GRANT EXECUTE", role = match[4]!.toLowerCase();
  const signatures = match[2]!.split(/\)[ \t\n]*,[ \t\n]*/u).map((part, index, parts) => nativeStoreSignature(`${nativeStoreTrim(part)}${index < parts.length - 1 ? ")" : ""}`));
  if (grant && signatures.some(signature => signature !== null && triggerFunctions.has(signature))) throw new Error("reviewed native store trigger function GRANT EXECUTE refused");
  if (!nativeStoreAscii(match[1]!) || ![...nativeStoreRoles, "public"].includes(role) || signatures.some(signature => signature === null) || new Set(signatures).size !== signatures.length || (grant ? match[3]!.toUpperCase() !== "TO" || role === "public" || role === "anon" : match[3]!.toUpperCase() !== "FROM") || (role === "public" && !/^REVOKE ALL(?: PRIVILEGES)? /iu.test(match[1]! + " ")) || (conditional && role !== roleGuard)) throw new Error("reviewed native store privilege role, verb or function shape refused");
  return { kind: "FUNCTION", targets: signatures as string[], role, grant, conditional };
}

function nativeCheckValues(tokens: readonly PlatformSqlToken[], start: number, column: string): { values: string[]; next: number } | null {
  if (!nativeWord(tokens, start, "CHECK") || !nativeSymbol(tokens, start + 1, "(") || nativeIdentifier(tokens[start + 2]) !== column || !nativeWord(tokens, start + 3, "IN") || !nativeSymbol(tokens, start + 4, "(")) return null;
  const values: string[] = []; let index = start + 5;
  while (tokens[index]?.kind === "string" && /^[a-z][a-z0-9_]*$/u.test(tokens[index]!.value)) {
    values.push(tokens[index++]!.value);
    if (!nativeSymbol(tokens, index, ",")) break;
    index++;
  }
  return values.length && nativeSymbol(tokens, index, ")") && nativeSymbol(tokens, index + 1, ")") ? { values, next: index + 2 } : null;
}
// Only literal int4 endpoints, one column and one inclusive interval. The catalog
// control separately proves the pinned installed preimage and strict widening.
function nativeCheckRange(tokens: readonly PlatformSqlToken[], column: string): { lower: number; upper: number; next: number } | null {
  let index = 3;
  const integer = () => {
    const sign = nativeSymbol(tokens, index, "-") ? (index++, -1) : 1;
    const token = tokens[index++];
    const value = token?.kind === "number" && /^[0-9]+$/u.test(token.value) ? sign * Number(token.value) : NaN;
    return nativeStoreInteger(value) ? value : null;
  };
  if (!nativeWord(tokens, 0, "CHECK") || !nativeSymbol(tokens, 1, "(") || nativeIdentifier(tokens[2]) !== column) return null;
  const between = nativeWord(tokens, index, "BETWEEN");
  if (between) index++;
  else if (nativeSymbol(tokens, index, ">") && nativeSymbol(tokens, index + 1, "=")) index += 2;
  else return null;
  const lower = integer();
  if (!nativeWord(tokens, index++, "AND")) return null;
  if (!between) {
    if (nativeIdentifier(tokens[index++]) !== column || !nativeSymbol(tokens, index++, "<") || !nativeSymbol(tokens, index++, "=")) return null;
  }
  const upper = integer();
  return lower !== null && upper !== null && lower <= upper && nativeSymbol(tokens, index, ")") ? { lower, upper, next: index + 1 } : null;
}
function normalizeCheckTokens(tokens: readonly PlatformSqlToken[]): string {
  return tokens.map(token => {
    if (token.kind === "word") return token.value.toLowerCase();
    if (token.kind === "string") return `'${token.value.replaceAll("'", "''")}'`;
    return token.value;
  }).join(" ");
}
export function checkConstraintSha256(checkSql: string): string {
  const { tokens, complete } = platformSqlTokens(checkSql, false, true);
  if (!complete || !tokens.length || !nativeWord(tokens, 0, "CHECK")) {
    throw new Error("checkConstraintSha256 requires a complete CHECK (...) SQL fragment");
  }
  return sqlSha256(normalizeCheckTokens(tokens));
}
export type BoundedFormatAtom = { chars: ReadonlySet<string>; min: number; max: number };
const MAX_BOUNDED_FORMAT_LENGTH = 256;

function parseBoundedCharClass(pattern: string, start: number): { chars: Set<string>; next: number } | null {
  if (pattern[start] !== "[" || pattern[start + 1] === "^") return null;
  const chars = new Set<string>();
  let index = start + 1;
  while (index < pattern.length && pattern[index] !== "]") {
    const ch = pattern[index]!;
    if (ch === "\\" || ch === "[" || ch < "!" || ch > "~") return null;
    if (pattern[index + 1] === "-" && index + 2 < pattern.length && pattern[index + 2] !== "]") {
      const end = pattern[index + 2]!;
      const validRange = (ch >= "a" && end <= "z" && ch <= end)
        || (ch >= "A" && end <= "Z" && ch <= end)
        || (ch >= "0" && end <= "9" && ch <= end);
      if (!validRange) return null;
      for (let code = ch.charCodeAt(0); code <= end.charCodeAt(0); code++) chars.add(String.fromCharCode(code));
      index += 3;
      continue;
    }
    chars.add(ch);
    index++;
  }
  return pattern[index] === "]" && chars.size > 0 ? { chars, next: index + 1 } : null;
}

function parseBoundedQuantifier(pattern: string, start: number): { min: number; max: number; next: number } | null {
  if (pattern[start] !== "{") return { min: 1, max: 1, next: start };
  const close = pattern.indexOf("}", start + 1);
  if (close < 0) return null;
  const match = /^([0-9]+)(?:,([0-9]+))?$/u.exec(pattern.slice(start + 1, close));
  if (!match) return null;
  const min = Number(match[1]), max = match[2] === undefined ? min : Number(match[2]);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max === 0 || max > MAX_BOUNDED_FORMAT_LENGTH) return null;
  return { min, max, next: close + 1 };
}

export function parseBoundedFormatPattern(pattern: string): BoundedFormatAtom[] | null {
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.length < 4 || pattern.length > 128) return null;
  const atoms: BoundedFormatAtom[] = [];
  let index = 1, totalMin = 0, totalMax = 0;
  const end = pattern.length - 1;
  while (index < end) {
    const cls = parseBoundedCharClass(pattern, index);
    if (!cls) return null;
    const quant = parseBoundedQuantifier(pattern, cls.next);
    if (!quant) return null;
    atoms.push({ chars: cls.chars, min: quant.min, max: quant.max });
    totalMin += quant.min;
    totalMax += quant.max;
    index = quant.next;
  }
  return atoms.length > 0 && totalMin >= 1 && totalMax <= MAX_BOUNDED_FORMAT_LENGTH ? atoms : null;
}

export function matchesBoundedFormatPattern(atoms: readonly BoundedFormatAtom[], value: string): boolean {
  let reachable = new Set<number>([0]);
  for (const atom of atoms) {
    const next = new Set<number>();
    for (const pos of reachable) {
      for (let count = 0; count <= atom.max; count++) {
        if (count >= atom.min) next.add(pos + count);
        if (count === atom.max || pos + count >= value.length || !atom.chars.has(value[pos + count]!)) break;
      }
    }
    if (!next.size) return false;
    reachable = next;
  }
  return reachable.has(value.length);
}

function nativeCheckFormat(tokens: readonly PlatformSqlToken[], column: string): { atoms: BoundedFormatAtom[]; next: number } | null {
  if (!nativeWord(tokens, 0, "CHECK") || !nativeSymbol(tokens, 1, "(") || nativeIdentifier(tokens[2]) !== column
    || !nativeSymbol(tokens, 3, "~") || tokens[4]?.kind !== "string" || !nativeSymbol(tokens, 5, ")")) return null;
  const atoms = parseBoundedFormatPattern(tokens[4]!.value);
  return atoms ? { atoms, next: 6 } : null;
}

function findMatchingParen(tokens: readonly PlatformSqlToken[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (nativeSymbol(tokens, index, "(")) depth++;
    else if (nativeSymbol(tokens, index, ")") && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevelCommaItems(tokens: readonly PlatformSqlToken[], start: number, end: number): PlatformSqlToken[][] {
  const items: PlatformSqlToken[][] = [];
  let itemStart = start, depth = 0;
  for (let index = start; index < end; index++) {
    if (nativeSymbol(tokens, index, "(")) depth++;
    else if (nativeSymbol(tokens, index, ")")) depth--;
    else if (depth === 0 && nativeSymbol(tokens, index, ",")) {
      items.push(tokens.slice(itemStart, index));
      itemStart = index + 1;
    }
  }
  if (itemStart < end) items.push(tokens.slice(itemStart, end));
  return items;
}

function resolvePrefixTableHead(tokens: readonly PlatformSqlToken[]): { verb: string; table: string; next: number } | null {
  const verb = tokens[0]?.kind === "word" ? tokens[0].value.toUpperCase() : "";
  if (!["CREATE", "ALTER", "DROP"].includes(verb) || !nativeWord(tokens, 1, "TABLE")) return null;
  let index = 2;
  if (verb === "CREATE" && nativeWord(tokens, index, "IF") && nativeWord(tokens, index + 1, "NOT") && nativeWord(tokens, index + 2, "EXISTS")) index += 3;
  else if (verb !== "CREATE" && nativeWord(tokens, index, "IF") && nativeWord(tokens, index + 1, "EXISTS")) index += 2;
  if (verb === "ALTER" && nativeWord(tokens, index, "ONLY")) index++;
  const target = nativeQualified(tokens, index);
  return target ? { verb, table: target.name, next: target.next } : null;
}

function extractColumnChecks(table: string, item: readonly PlatformSqlToken[], priorChecks: Map<string, PlatformSqlToken[]>): void {
  const column = nativeIdentifier(item[0]);
  if (!column || ["CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK"].some(word => nativeWord(item, 0, word))) return;
  const tableBare = table.slice("public.".length);
  for (let index = 1; index < item.length; index++) {
    if (nativeSymbol(item, index, "(")) {
      const end = findMatchingParen(item, index);
      if (end < 0) return;
      index = end;
      continue;
    }
    const named = nativeWord(item, index, "CONSTRAINT") && nativeIdentifier(item[index + 1]) !== null
      && nativeWord(item, index + 2, "CHECK") && nativeSymbol(item, index + 3, "(");
    const unnamed = !named && nativeWord(item, index, "CHECK") && nativeSymbol(item, index + 1, "(");
    if (!named && !unnamed) continue;
    const checkStart = named ? index + 2 : index;
    const end = findMatchingParen(item, checkStart + 1);
    if (end < 0) return;
    const name = named ? nativeIdentifier(item[index + 1])! : `${tableBare}_${column}_check`;
    priorChecks.set(`${table}.${name}`, item.slice(checkStart, end + 1));
    index = end;
  }
}

function trackCreateTableChecks(table: string, tokens: readonly PlatformSqlToken[], open: number, priorChecks: Map<string, PlatformSqlToken[]>): void {
  const close = findMatchingParen(tokens, open);
  if (close < 0) return;
  for (const item of splitTopLevelCommaItems(tokens, open + 1, close)) {
    if (nativeWord(item, 0, "CONSTRAINT") && nativeIdentifier(item[1]) !== null && nativeWord(item, 2, "CHECK") && nativeSymbol(item, 3, "(")) {
      const end = findMatchingParen(item, 3);
      if (end >= 0) priorChecks.set(`${table}.${nativeIdentifier(item[1])!}`, item.slice(2, end + 1));
    } else {
      extractColumnChecks(table, item, priorChecks);
    }
  }
}

function trackAlterTableChecks(table: string, statement: string, tokens: readonly PlatformSqlToken[], actionStart: number, priorChecks: Map<string, PlatformSqlToken[]>): void {
  const last = tokens.at(-1);
  if (!last || !nativeSymbol(tokens, tokens.length - 1, ";") || actionStart >= tokens.length - 1) return;
  const actions = nativeStoreArguments(statement.slice(tokens[actionStart]!.start, last.start)).map(nativeStoreTrim);
  for (const action of actions) {
    const { tokens: sub, complete } = platformSqlTokens(action, false, true);
    if (!complete) continue;
    if (nativeWord(sub, 0, "DROP") && nativeWord(sub, 1, "CONSTRAINT")) {
      const nameIndex = nativeWord(sub, 2, "IF") && nativeWord(sub, 3, "EXISTS") ? 4 : 2;
      const name = nativeIdentifier(sub[nameIndex]);
      if (name) priorChecks.delete(`${table}.${name}`);
    } else if (nativeWord(sub, 0, "ADD") && nativeWord(sub, 1, "CONSTRAINT") && nativeIdentifier(sub[2]) !== null && nativeWord(sub, 3, "CHECK") && nativeSymbol(sub, 4, "(")) {
      const end = findMatchingParen(sub, 4);
      if (end >= 0) priorChecks.set(`${table}.${nativeIdentifier(sub[2])!}`, sub.slice(3, end + 1));
    } else if (nativeWord(sub, 0, "ADD")) {
      let colIndex = nativeWord(sub, 1, "COLUMN") ? 2 : 1;
      if (nativeWord(sub, colIndex, "IF") && nativeWord(sub, colIndex + 1, "NOT") && nativeWord(sub, colIndex + 2, "EXISTS")) colIndex += 3;
      extractColumnChecks(table, sub.slice(colIndex), priorChecks);
    }
  }
}

function trackPriorCheckConstraints(
  statement: string,
  tokens: readonly PlatformSqlToken[],
  complete: boolean,
  trackedTables: ReadonlySet<string>,
  priorChecks: Map<string, PlatformSqlToken[]>,
): void {
  if (!complete) return;
  const head = resolvePrefixTableHead(tokens);
  if (!head || !trackedTables.has(head.table)) return;
  if (head.verb === "DROP") {
    const prefix = `${head.table}.`;
    for (const key of priorChecks.keys()) if (key.startsWith(prefix)) priorChecks.delete(key);
  } else if (head.verb === "CREATE" && nativeSymbol(tokens, head.next, "(")) {
    trackCreateTableChecks(head.table, tokens, head.next, priorChecks);
  } else if (head.verb === "ALTER") {
    trackAlterTableChecks(head.table, statement, tokens, head.next, priorChecks);
  }
}
function nativeUniqueValues(tokens: readonly PlatformSqlToken[], start: number): { columns: string[]; nullsNotDistinct: boolean; next: number } | null {
  if (!nativeWord(tokens, start, "UNIQUE")) return null;
  let index = start + 1, nullsNotDistinct = false;
  if (nativeWord(tokens, index, "NULLS") && nativeWord(tokens, index + 1, "NOT") && nativeWord(tokens, index + 2, "DISTINCT")) { index += 3; nullsNotDistinct = true; }
  if (!nativeSymbol(tokens, index++, "(")) return null;
  const columns: string[] = [];
  while (nativeIdentifier(tokens[index]) !== null) {
    columns.push(nativeIdentifier(tokens[index++])!);
    if (!nativeSymbol(tokens, index, ",")) break;
    index++;
  }
  return columns.length && nativeSymbol(tokens, index, ")") ? { columns, nullsNotDistinct, next: index + 1 } : null;
}
/** One ordinary row-trigger shape; the exact source hash owns the listed events. */
export function nativeStoreTriggerDefinition(statement: string): { name: string; table: string; signature: string; timing: string; events: { event: string; columns: string[] }[] } | null {
  const { tokens, complete } = platformSqlTokens(statement, false, true), name = nativeIdentifier(tokens[2]);
  if (!complete || !nativeWord(tokens, 0, "CREATE") || !nativeWord(tokens, 1, "TRIGGER") || name === null || !["BEFORE", "AFTER"].some(word => nativeWord(tokens, 3, word))) return null;
  const timing = tokens[3]!.value.toUpperCase(), events: { event: string; columns: string[] }[] = []; let index = 4;
  for (;;) {
    const event = ["INSERT", "DELETE", "UPDATE"].find(word => nativeWord(tokens, index, word));
    if (!event) return null;
    index++; const columns: string[] = [];
    if (nativeWord(tokens, index, "OF")) {
      if (event !== "UPDATE") return null;
      index++;
      for (;;) {
        const column = nativeIdentifier(tokens[index++]);
        if (column === null) return null;
        columns.push(column);
        if (!nativeSymbol(tokens, index, ",")) break;
        index++;
      }
    }
    if (new Set(columns).size !== columns.length) return null;
    events.push({ event, columns });
    if (!nativeWord(tokens, index, "OR")) break;
    index++;
  }
  if (new Set(events.map(entry => entry.event)).size !== events.length || !nativeWord(tokens, index++, "ON")) return null;
  const table = nativeQualified(tokens, index);
  if (!table || !table.name.startsWith("public.")) return null;
  index = table.next;
  if (!["FOR", "EACH", "ROW", "EXECUTE", "FUNCTION"].every((word, offset) => nativeWord(tokens, index + offset, word))) return null;
  const fn = nativeQualified(tokens, index + 5);
  if (!fn || !fn.name.startsWith("public.") || !nativeSymbol(tokens, fn.next, "(") || !nativeSymbol(tokens, fn.next + 1, ")") || !nativeSymbol(tokens, fn.next + 2, ";") || fn.next + 3 !== tokens.length) return null;
  return { name, table: table.name, signature: `${fn.name}()`, timing, events };
}

const deferredTriggerSql = (name: string, events: string, relation: string, fn: string) =>
  `CREATE CONSTRAINT TRIGGER ${name} AFTER ${events} ON ${relation} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn};`;
export const renderNativeDeferredTrigger = (entry: Omit<NativeDeferredTrigger, "sha256">) =>
  deferredTriggerSql(entry.name, entry.events.join(" OR "), entry.relation, entry.function);
const deferredTarget = String.raw`public\.[a-z_][a-z0-9_]{0,62}`;
const deferredEventPattern = "(?:INSERT(?: OR UPDATE)?(?: OR DELETE)?|UPDATE(?: OR DELETE)?|DELETE)";
const deferredTriggerForm = new RegExp(`^${deferredTriggerSql("<name>", deferredEventPattern, deferredTarget, String.raw`${deferredTarget}\(\)`)}$`, "iu");

const isAsciiSearchPathList = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*(?:, [A-Za-z_][A-Za-z0-9_]*)*$/u.test(value);
const hasPgTempSchema = (schemaList: string): boolean => schemaList.toLowerCase().split(", ").some(schema => schema === "pg_temp" || /^pg_temp_\d+$/u.test(schema));

function parseAsciiSearchPath(value: string): string[] | null {
  const schemas = value.split(",").map(nativeStoreTrim);
  return isAsciiSearchPathList(schemas.join(", ")) ? schemas : null;
}

function appendsPgTemp(prior: readonly string[], next: readonly string[]): boolean {
  return next.length === prior.length + 1 && next.at(-1) === "pg_temp"
    && prior.every((schema, index) => schema === next[index]) && !hasPgTempSchema(prior.join(", "));
}

const normalizeNativeStoreHeader = (value: string): string => nativeStoreTrim(value.replace(/[ \t\n]+/gu, " "));

function nativeStoreSearchPathClause(header: string) {
  const { tokens, complete } = platformSqlTokens(header, false, true);
  // The lexer skips comments, which must not disappear from a header comparison.
  if (!complete || /--|\/\*/u.test(header)) return null;
  const rawToken = (token: PlatformSqlToken) => header.slice(token.start, token.end);
  let depth = 0;
  let clause: { before: string; after: string; schemas: string[] } | null = null;
  for (const [index, token] of tokens.entries()) {
    if (nativeSymbol(tokens, index, "(")) depth++;
    if (nativeSymbol(tokens, index, ")")) depth--;
    if (depth !== 0) continue;
    const searchPath = nativeWord(tokens, index + 1, "SEARCH_PATH");
    if (nativeWord(tokens, index, "RESET") && (searchPath || nativeWord(tokens, index + 1, "ALL"))) return null;
    if (!nativeWord(tokens, index, "SET") || !searchPath) continue;
    // Read the raw clause so skipped comments and partial identifiers cannot join the list.
    const match = /^SET[ \t\n]+search_path(?:[ \t\n]*=[ \t\n]*|[ \t\n]+TO[ \t\n]+)([A-Za-z_][A-Za-z0-9_]*(?:[ \t\n]*,[ \t\n]*[A-Za-z_][A-Za-z0-9_]*)*)(?=$|[ \t\n]+[^, \t\n])/iu.exec(header.slice(token.start));
    const schemas = match && parseAsciiSearchPath(match[1]!);
    if (clause || !match || !schemas) return null;
    const clauseEnd = token.start + match[0].length;
    clause = {
      before: tokens.slice(0, index).map(rawToken).join(" "),
      after: tokens.filter(entry => entry.start >= clauseEnd).map(rawToken).join(" "),
      schemas,
    };
  }
  return depth === 0 ? clause : null;
}

/**
 * A native-store replacement keeps its header or appends a final `pg_temp` to
 * its single ASCII search_path list while preserving the surrounding clauses.
 */
function isAllowedNativeStoreReplacementHeader(priorHeader: string, nextHeader: string, nextPath: ReturnType<typeof nativeStoreSearchPathClause>): boolean {
  if (nextHeader === priorHeader) return true;
  const priorPath = nativeStoreSearchPathClause(priorHeader);
  return Boolean(priorPath && nextPath && priorPath.before === nextPath.before && priorPath.after === nextPath.after
    && appendsPgTemp(priorPath.schemas, nextPath.schemas));
}

/**
 * A replaced function's catalog attributes must remain unchanged, except its
 * single `search_path=` proconfig entry may strictly append trailing `, pg_temp`
 * when the slot pins that exact tightened search_path and the prior search_path
 * did not already name `pg_temp` or `pg_temp_<N>`.
 */
export function expectedReplacedFunctionAttrs(oldAttrs: Record<string, unknown>, searchPath: string | null): Record<string, unknown> {
  if (searchPath === null) return oldAttrs;
  const oldConfig = oldAttrs.proconfig;
  if (!Array.isArray(oldConfig)) return oldAttrs;
  const searchPathEntries = oldConfig.filter((item): item is string => typeof item === "string" && item.startsWith("search_path="));
  if (searchPathEntries.length !== 1) return oldAttrs;
  const oldEntry = searchPathEntries[0]!;
  const prior = parseAsciiSearchPath(oldEntry.slice("search_path=".length));
  const next = parseAsciiSearchPath(searchPath);
  if (!prior || !next || !appendsPgTemp(prior, next)) return oldAttrs;
  const target = `search_path=${next.join(", ")}`;
  return { ...oldAttrs, proconfig: oldConfig.map(item => item === oldEntry ? target : item) };
}

const priceListMention = /price_lists|u&"/iu;
function isPriceListRowMutation(tokens: readonly PlatformSqlToken[]): boolean {
  const word = (index: number, value: string) => nativeWord(tokens, index, value);
  const update = word(0, "UPDATE");
  if (!update && !(word(0, "INSERT") && word(1, "INTO")) && !(word(0, "DELETE") && word(1, "FROM"))) return false;
  const start = update ? 1 : 2;
  const target = start + Number(word(start, "ONLY"));
  const first = nativeIdentifier(tokens[target]);
  if (!nativeSymbol(tokens, target + 1, ".")) return first === "price_lists";
  if (first === null) return false;
  const schema = nativeSymbol(tokens, target + 3, ".") ? target + 2 : target;
  return nativeQualified(tokens, schema)?.name === "public.price_lists";
}

function assertPriceListBasisFile(path: string, bytes: Buffer, predecessorStatements?: ReadonlySet<string>): void {
  const sql = bytes.toString("utf8");
  if (!predecessorStatements && !priceListMention.test(sql)) return;

  const drift = (reason: string) => new Error(`reviewed native store qualified price list basis SELECT predecessor definition drifted: ${path}. ${reason}`);
  const incomplete = predecessorStatements
    ? "Cannot completely tokenize the price list basis predecessor file."
    : "Cannot completely tokenize an intervening file that may reference public.price_lists.";
  // Check raw control characters before splitting. For example, a CR can end
  // a PostgreSQL line comment earlier than the splitter would end it.
  if (!Buffer.from(sql, "utf8").equals(bytes) || bytes.some(byte => (byte < 0x20 && byte !== 9 && byte !== 10) || byte === 0x7f)) {
    throw drift(incomplete);
  }
  let statements: string[];
  try {
    statements = sqlStatements(sql, false, false, true);
  } catch (error) {
    throw drift((error as Error).message);
  }
  for (const statement of statements) {
    const { tokens, complete } = platformSqlTokens(statement, false, true);
    if (!complete) throw drift(incomplete);
    if (!priceListMention.test(statement)) continue;
    // A raw mention catches qualified, quoted and opaque references without
    // resolving a relation name. An escaped identifier may hide the name.
    if (/u&"/iu.test(statement)) throw drift("An escaped identifier prevents checking the price-list reference.");
    if (predecessorStatements) {
      if (!predecessorStatements.has(statement)) throw drift("Only the pinned column and its optional CHECK may reference price_lists in the predecessor file.");
      continue;
    }
    const word = (index: number, value: string) => nativeWord(tokens, index, value);
    const privilegesOrComment = word(0, "GRANT") || word(0, "REVOKE") || (word(0, "COMMENT") && word(1, "ON"));
    if (!privilegesOrComment && !isPriceListRowMutation(tokens)) {
      throw drift("Only direct price_lists row DML, privilege changes and comments may reference price_lists between the column and its grant.");
    }
  }
}

// Only the approved nullable text column and its optional two-value CHECK can be the grant preimage.
const priceListBasisCheck = /^add constraint ([a-z_][a-z_0-9]{0,62}) check \( (?:amount_basis is null or )?amount_basis in \( (?:"tax_inclusive" , "tax_exclusive"|"tax_exclusive" , "tax_inclusive") \) \)(?: not valid)?$/u;
function assertPriceListBasisPredecessor(registry: ReviewedForwardRegistry, earlierSlots: NativeStoreSlot[], preceding: { path: string; bytes: Buffer }[]): ForwardBinding {
  const slots = new Map(earlierSlots.map(slot => [slot.path, slot]));
  const predecessorStatements = new Set<string>();
  let predecessor: { path: string; bytes: Buffer } | undefined, checkName: string | undefined;
  for (const source of preceding) {
    if (predecessor) {
      assertPriceListBasisFile(source.path, source.bytes);
      continue;
    }
    for (const { statement, tokens, complete } of scanNativeStoreSql(source.path, () => cachedNativePrefixStatements(source.bytes))) {
      if (!nativeWord(tokens, 1, "TABLE")) continue;
      const publicPriceLists = (index: number) => nativeQualified(tokens, index)?.name === "public.price_lists"
        || (nativeIdentifier(tokens[index]) === "price_lists" && !nativeSymbol(tokens, index + 1, ".") && !nativeSymbol(tokens, index - 1, "."));
      const drift = (reason = "") => new Error(`reviewed native store qualified price list basis SELECT predecessor definition drifted: ${source.path}${reason}`);
      if (nativeWord(tokens, 0, "DROP") && tokens.some((_token, index) => index >= 2 && publicPriceLists(index))) throw drift();
      if (!nativeWord(tokens, 0, "ALTER")) continue;
      const targetStart = nativeWord(tokens, 2, "IF") && nativeWord(tokens, 3, "EXISTS") ? 4 : 2;
      const target = targetStart + Number(nativeWord(tokens, targetStart, "ONLY"));
      if (!publicPriceLists(target)) continue;
      const actionStart = nativeQualified(tokens, target)?.next ?? target + 1;
      if (!complete) throw drift(". Cannot completely tokenize the preceding file.");
      if ((nativeWord(tokens, actionStart, "SET") && nativeWord(tokens, actionStart + 1, "SCHEMA"))
        || (nativeWord(tokens, actionStart, "RENAME") && nativeWord(tokens, actionStart + 1, "TO"))) throw drift();
      // The native-store inventory only accepts plain qualified ALTER TABLE statements.
      const listed = slots.get(source.path)?.existingTableStatements?.includes(statement);
      const alter = scanNativeStoreSql(source.path, () => nativeStoreAlter(statement));
      const actions = alter?.actions ?? [statement.slice(tokens[actionStart]?.start, tokens.at(-1)?.start)];
      let allActionsApproved = true;
      for (const action of actions) {
        const parsed = platformSqlTokens(action, false, true);
        const identifiers = parsed.tokens.map(nativeIdentifier);
        if (!identifiers.includes("amount_basis") && (!checkName || !identifiers.includes(checkName))) {
          allActionsApproved = false;
          continue;
        }
        if (!parsed.complete) throw drift(". Cannot completely tokenize the preceding ALTER action.");
        if (!listed) throw drift();
        const shape = parsed.tokens.map(token => {
          if (token.kind === "string") return JSON.stringify(token.value);
          if (token.kind === "word") return token.value.toLowerCase();
          return token.kind === "symbol" ? token.value : "";
        }).join(" ");
        if (!predecessor && /^add column amount_basis (?:pg_catalog \. )?text(?: null)?$/u.test(shape)) {
          predecessor = source;
          continue;
        }
        if (source === predecessor) {
          const check = priceListBasisCheck.exec(shape);
          if (!checkName && check) { checkName = check[1]!; continue; }
          if (checkName && shape === `validate constraint ${checkName}`) continue;
        }
        throw drift();
      }
      // An exact ALTER pin can list several actions. Only a statement whose
      // every action belongs to the approved column or CHECK may name the table.
      if (source === predecessor && allActionsApproved) predecessorStatements.add(statement);
    }
  }
  if (!predecessor) throw new Error("reviewed native store qualified price list basis SELECT requires an earlier slot introducing public.price_lists.amount_basis");
  assertPriceListBasisFile(predecessor.path, predecessor.bytes, predecessorStatements);
  const pin = registry.nativeStoreForwards!.find(entry => entry.path === predecessor.path)!;
  assertNativeStoreForward(registry, pin.path, predecessor.bytes, preceding.filter(source => source.path < pin.path));
  return pin;
}

const routinePrivilegeOn = (tokens: readonly PlatformSqlToken[]) =>
  tokens.findIndex((_token, index) => nativeWord(tokens, index, "ON"));
const publicRoutineAclPattern = /\bon\s+all\s+(?:functions|routines)\s+in\s+schema\s+"?public\b/iu;

function checkoutRoutinePrivilege(tokens: PlatformSqlToken[], names: readonly string[]): boolean {
  const targetsCheckout = (list: PlatformSqlToken[]) => {
    const on = routinePrivilegeOn(list);
    if (on < 0) return false;
    const kind = nativeIdentifier(list[on + 1]);
    if (kind === "all" && ["functions", "routines"].includes(nativeIdentifier(list[on + 2]) ?? "")) {
      return list.slice(on + 3).some(token => nativeIdentifier(token) === "public");
    }
    return ["function", "routine", "procedure"].includes(kind ?? "")
      && list.slice(on + 2).some(token => names.includes(nativeIdentifier(token) ?? ""));
  };
  if (nativeWord(tokens, 0, "GRANT") || nativeWord(tokens, 0, "REVOKE")) return targetsCheckout(tokens);
  if (!nativeWord(tokens, 0, "DO")) return false;
  const body = tokens.find(token => token.kind === "string")?.value ?? "";
  // Inspect the routine DDL/ACL discriminator in a migration DO block. This does
  // not relax the existing admission rules for procedural SQL.
  return /\b(?:grant|revoke)\b/iu.test(body)
    && (names.some(name => body.toLowerCase().includes(name)) || publicRoutineAclPattern.test(body));
}

function routineAclTargets(sql: string, tokens: PlatformSqlToken[]): (string | null)[] {
  if (!nativeWord(tokens, 0, "GRANT") && !nativeWord(tokens, 0, "REVOKE")) return [];
  const on = routinePrivilegeOn(tokens), kind = nativeIdentifier(tokens[on + 1]);
  if (on === -1 || !["function", "routine", "procedure"].includes(kind ?? "")) return [];
  let depth = 0;
  const role = tokens.findIndex((_token, index) => {
    if (index < on + 2) return false;
    if (nativeSymbol(tokens, index, "(")) depth++;
    if (nativeSymbol(tokens, index, ")")) depth--;
    // A role delimiter follows the closing parenthesis of the final signature.
    return depth === 0 && nativeSymbol(tokens, index - 1, ")")
      && (nativeWord(tokens, index, "TO") || nativeWord(tokens, index, "FROM"));
  });
  const start = tokens[on + 2]?.start;
  if (start === undefined || role === -1) return [null];
  let targets: string[];
  try { targets = nativeStoreArguments(sql.slice(start, tokens[role]!.start)); }
  catch { return [null]; }
  return targets.map(target => {
    const { tokens, complete } = platformSqlTokens(target, false, true);
    const routine = nativeQualified(tokens, 0);
    if (!complete || !routine || routine.name !== routine.name.toLowerCase()
      || !nativeSymbol(tokens, routine.next, "(") || !nativeSymbol(tokens, tokens.length - 1, ")")) return null;
    const args = tokens.slice(routine.next + 1, -1).map(token => target.slice(token.start, token.end)).join(" ");
    return nativeStoreSignature(`${routine.name}(${args})`);
  });
}

function nativeStoreAclTargets(statement: string, tokens: PlatformSqlToken[]): (string | null)[] {
  if (!nativeWord(tokens, 0, "DO")) return routineAclTargets(statement, tokens);
  const body = tokens.find(token => token.kind === "string")?.value ?? "";
  const parsed = platformSqlTokens(body, false, true).tokens;
  return parsed.flatMap((_token, index) => {
    const payload = parsed[index + 1];
    if (nativeWord(parsed, index, "EXECUTE") && payload?.kind === "string" && nativeSymbol(parsed, index + 2, ";")) {
      return routineAclTargets(payload.value, platformSqlTokens(payload.value, false, true).tokens);
    }
    return nativeWord(parsed, index, "GRANT") || nativeWord(parsed, index, "REVOKE")
      ? routineAclTargets(body, parsed.slice(index)) : [];
  });
}

function assertRevokePublicSql(sql: string, signatures: string[]): void {
  const messages = nativeStoreRevokePublicMessages;
  let statements: string[];
  try { statements = sqlStatements(sql, false, false, true); }
  catch { throw new Error(messages.aclOnly); }
  const expected = new Set(signatures);
  const revokes: string[] = [], blocks: number[] = [];
  for (const [index, statement] of statements.entries()) {
    const { tokens } = platformSqlTokens(statement, false, true);
    if (nativeStoreAclTargets(statement, tokens).some(target => target === null || !expected.has(target))) throw new Error(messages.target);
    const revoke = /^REVOKE ALL ON FUNCTION (.+) FROM PUBLIC;$/i.exec(normalizeNativeStoreHeader(statement));
    if (revoke && expected.has(revoke[1]!)) revokes.push(revoke[1]!);
    if (nativeWord(tokens, 0, "DO")) blocks.push(index);
  }
  if (signatures.some(signature => !revokes.includes(signature))) throw new Error(messages.missing);
  const grantIndex = blocks.find(index => {
    const block = nativeStoreRolePrivilege.exec(statements[index]!);
    const grant = block?.[1] === "service_role" && /^GRANT EXECUTE ON FUNCTION (.+) TO service_role;?$/i.exec(normalizeNativeStoreHeader(block[2]!));
    return grant && canonical(grant[1]!.split(/(?<=\)) *, */u)) === canonical(signatures);
  });
  if (grantIndex === undefined) throw new Error(messages.grant);
  if (statements.length !== signatures.length + 1 || revokes.length !== signatures.length) throw new Error(messages.aclOnly);
  if (grantIndex !== signatures.length || revokes.some((signature, index) => signature !== signatures[index])) throw new Error(messages.order);
}

export function assertExecutePredecessors(registry: ReviewedForwardRegistry, earlierSlots: NativeStoreSlot[],
  preceding: { path: string; bytes: Buffer }[], signatures: readonly string[], checkout = false, legacyPrefix = preceding): ForwardBinding[] {
  const allowed = new Set<string>(signatures);
  const targets = signatures.map(signature => {
    const slot = earlierSlots.find(entry => entry.createdFunctions.some(fn => fn.signature === signature));
    const file = registry.nativeStoreForwards!.find(pin => pin.path === slot?.path);
    const definition = file?.functions.find(fn => fn.signature === signature);
    if (!file || !definition) throw new Error(`reviewed native store qualified price setup EXECUTE requires an earlier native slot creating ${signature}`);
    return { signature, name: signature.slice(0, signature.indexOf("(")), file, definition };
  });
  const names = new Set(targets.map(target => target.name));
  const bareNames = [...names].map(name => name.slice("public.".length));
  const files = [...new Set(targets.map(target => target.file))];
  const firstPath = files.map(file => file.path).sort()[0]!;
  const seen = new Set<string>();
  const introduction = preceding.findIndex(source => source.path === firstPath);
  if (checkout && introduction === -1) throw checkoutPredecessorRefusal(firstPath);
  for (const [position, source] of preceding.entries()) {
    const sql = source.bytes.toString("utf8"), lower = sql.toLowerCase();
    const afterIntroduction = checkout ? position >= introduction : source.path >= firstPath;
    if (!afterIntroduction && !lower.includes('u&"') && !bareNames.some(name => lower.includes(name))) continue;
    const drift = (reason: string) => checkout ? checkoutPredecessorRefusal(source.path)
      : new Error(`reviewed native store qualified price setup EXECUTE predecessor definition drifted: ${source.path}. ${reason}`);
    const scan = <T>(parse: () => T): T => {
      try { return scanNativeStoreSql(source.path, parse); }
      catch (error) {
        if (checkout) throw drift("Cannot completely tokenize the preceding file.");
        throw error;
      }
    };
    if (!Buffer.from(sql, "utf8").equals(source.bytes) || source.bytes.some(byte => (byte < 0x20 && byte !== 9 && byte !== 10) || byte === 0x7f)) {
      throw drift("Cannot completely tokenize the preceding file.");
    }
    for (const { statement, tokens, complete } of scan(() => cachedNativePrefixStatements(source.bytes))) {
      if (!complete) throw drift("Cannot completely tokenize the preceding file.");
      const word = (index: number, value: string) => nativeWord(tokens, index, value);
      const create = word(0, "CREATE"), alter = word(0, "ALTER"), drop = word(0, "DROP");
      const reassign = checkout && word(0, "REASSIGN") && word(1, "OWNED");
      if (checkout && afterIntroduction && checkoutRoutinePrivilege(tokens, bareNames)) {
        const introductionRevoke = source.path === firstPath && signatures.some(signature =>
          statement.replace(/[ \t\n]+/gu, "").toLowerCase() === `revokeallonfunction${signature}frompublic;`);
        if (!introductionRevoke) throw drift("Only the issued introduction may change the checkout routine privileges.");
      }
      if (!create && !alter && !drop && !reassign) continue;
      const hasWord = (value: string) => tokens.some((_, index) => word(index, value));
      const escapedIdentifier = tokens.some((token, index) => token.kind === "quoted" && word(index - 2, "U")
        && nativeSymbol(tokens, index - 1, "&") && tokens[index - 2]!.end === tokens[index - 1]!.start && tokens[index - 1]!.end === token.start);
      // Refuse indirect static removals and changes to the target schema as well as routine DDL.
    if (afterIntroduction && ((drop && (word(1, "OWNED") || word(1, "EXTENSION"))) || (alter && word(1, "EXTENSION"))
        || reassign
        || ((drop || (alter && hasWord("DROP"))) && hasWord("CASCADE"))
        || ((alter || drop) && word(1, "SCHEMA") && (escapedIdentifier || tokens.some(token => nativeIdentifier(token) === "public"))))) {
        throw drift("Remove DDL that can change or remove the issued functions indirectly.");
      }
      const kind = create && word(1, "OR") && word(2, "REPLACE") ? 3 : 1;
      if (!["FUNCTION", "ROUTINE", "PROCEDURE", "AGGREGATE"].some(value => word(kind, value))) continue;
      if (escapedIdentifier) throw drift("An escaped identifier prevents checking routine DDL.");
      if (!tokens.some(token => bareNames.some(name => nativeIdentifier(token) === name))) continue;
      const definition = create && kind === 1
        && scan(() => nativeStoreFunctionDefinitionFromTokens(statement, tokens, complete, allowed, names, true, source.path));
      const target = definition && targets.find(target => target.signature === definition[0]);
      if (!definition || !target || seen.has(target.signature) || target.file.path !== source.path || target.definition.afterSha256 !== definition[1]) {
        throw drift("Only the pinned CREATE of each target is allowed before the grant.");
      }
      if (checkout) {
        const header = headerAttributes(statement);
        const parsed = platformSqlTokens(header, false, true);
        const security = parsed.tokens.flatMap((_, index) => nativeWord(parsed.tokens, index, "SECURITY")
          && (nativeWord(parsed.tokens, index + 1, "DEFINER") || nativeWord(parsed.tokens, index + 1, "INVOKER"))
          ? [nativeWord(parsed.tokens, index + 1, "DEFINER")] : []);
        if (!parsed.complete || canonical(security) !== "[true]"
          || nativeStoreSearchPathClause(nativeStoreTrim(header))?.schemas.join(", ") !== "pg_catalog, pg_temp") {
          throw drift("The issued checkout routine must be a definer with the fixed search path.");
        }
      }
      seen.add(target.signature);
    }
  }
  if (seen.size !== targets.length) throw new Error("reviewed native store qualified price setup EXECUTE is missing a pinned predecessor CREATE");
  for (const file of files) {
    const source = preceding.find(source => source.path === file.path)!;
    assertNativeStoreForward(registry, file.path, source.bytes, legacyPrefix.filter(source => source.path < file.path));
  }
  return files;
}

function checkoutDefinition(earlierSlots: readonly NativeStoreSlot[], path: string): NativeStoreSlot {
  const definitions = earlierSlots.filter(slot => checkoutOwnerDefinitionPath.test(slot.path));
  const [definition] = definitions;
  if (definitions.length !== 1 || !definition || !checkoutOwnerRoutines.every(signature =>
    definition.createdFunctions.some(fn => fn.signature === signature && fn.searchPath === "pg_catalog, pg_temp"))) {
    throw checkoutPredecessorRefusal(path);
  }
  return definition;
}

const checkoutSignatures = new Set<string>(checkoutOwnerRoutines);
const checkoutRoutineNames = new Set(checkoutOwnerRoutines.map(signature => signature.split("(")[0]!));
export function replacesCheckoutRoutine(bytes: Buffer, slot?: NativeStoreSlot): boolean {
  if (slot?.replacedFunctions.some(fn => checkoutSignatures.has(fn.signature))) return true;
  const sql = bytes.toString("utf8").toLowerCase();
  if (![...checkoutRoutineNames].some(name => sql.includes(name.slice("public.".length)))) return false;
  return cachedNativePrefixStatements(bytes).some(({ statement, tokens, complete }) =>
    nativeWord(tokens, 0, "CREATE") && nativeWord(tokens, 1, "OR") && nativeWord(tokens, 2, "REPLACE")
    && nativeWord(tokens, 3, "FUNCTION") && checkoutRoutineNames.has(nativeQualified(tokens, 4)?.name ?? "")
    && nativeStoreFunctionDefinitionFromTokens(statement, tokens, complete, checkoutSignatures, checkoutRoutineNames, true) !== null);
}

/** Exact inventory with lexical shape checks; feature SQL still owns behavior proof. */
export function assertNativeStoreForward(registry: ReviewedForwardRegistry, path: string, bytes: Buffer, preceding: { path: string; bytes: Buffer }[]) {
  assertRevokePublicPlacement(registry);
  validateNativeStoreClass(registry, new Set());
  const control = registry.nativeStoreForwardClass, slot = control?.slots.find(slot => slot.path === path);
  const forward = registry.nativeStoreForwards?.find(pin => pin.path === path);
  const checkout = checkoutOwnerGrantPath.test(path);
  if (checkout && (!slot || !forward)) throw checkoutSlotRefusal(path);
  if (checkout && forward?.sha256 !== sqlSha256(bytes)) throw checkoutForwardRefusal(path);
  if (slot?.ownerWindowRole !== undefined) assertNativeStoreSettingsOwnerWindow(slot.settingsOnlyFunctions!, slot.ownerWindowRole, bytes);
  if (!slot || !forward || sqlSha256(bytes) !== forward.sha256) throw new Error("reviewed native store path or file hash drifted");
  if (bytes.some(byte => (byte < 0x20 && byte !== 9 && byte !== 10) || byte === 0x7f)) throw new Error("reviewed native store refuses control characters");
  if (preceding[0]?.path !== PLATFORM_BASELINE_FILE || preceding.some((source, index) => !/^db\/platform\/migrations\/\d{14}_[a-zA-Z0-9_-]+\.sql$/u.test(source.path) || source.path >= path || (index > 0 && source.path <= preceding[index - 1]!.path))) throw new Error("reviewed native store requires an ordered same-rail prefix and baseline");
  if (slot.qualifiedPriceListBasisSelect && !bytes.equals(Buffer.from(qualifiedPriceListBasisSelectSql))) {
    throw new Error("reviewed native store qualified price list basis SELECT forward must contain only the exact guarded grant with final LF");
  }
  const executeTargets = qualifiedExecuteGrants[qualifiedExecuteEntry(slot.row)];
  if (slot.qualifiedPriceSetupExecute) {
    const sql = qualifiedCatalogueReadSql.replace(/GRANT EXECUTE ON FUNCTION [^;]+;/u,
      `GRANT EXECUTE ON FUNCTION ${executeTargets.join(",\n      ")} TO ${cataloguePublicationRole};`);
    if (!bytes.equals(Buffer.from(sql))) throw new Error("reviewed native store qualified price setup EXECUTE forward must contain only the exact guarded grant with final LF");
  }
  const earlierSlots = control!.slots.slice(0, control!.slots.indexOf(slot));
  const revokePublic = hasRevokePublic(slot);
  if (!revokePublic && replacesCheckoutRoutine(bytes, slot) && !earlierSlots.some(earlier => checkoutOwnerGrantPath.test(earlier.path)
    && preceding.some(source => source.path === earlier.path
      && registry.nativeStoreForwards!.find(pin => pin.path === earlier.path)?.sha256 === sqlSha256(source.bytes)))) {
    throw checkoutReplacementRefusal(path);
  }
  const checkoutPredecessor = checkout ? checkoutDefinition(earlierSlots, path) : undefined;
  if (checkoutPredecessor) {
    const pin = registry.nativeStoreForwards!.find(entry => entry.path === checkoutPredecessor.path);
    const source = preceding.find(entry => entry.path === checkoutPredecessor.path);
    if (!pin || !source || sqlSha256(source.bytes) !== pin.sha256) throw checkoutPredecessorRefusal(checkoutPredecessor.path);
    if (!bytes.equals(Buffer.from(renderCheckoutOwnerGrant(pin.path, pin.sha256)))) throw checkoutForwardRefusal(path);
  }
  const landedSettings = new Map<string, Set<string>>();
  for (const earlier of earlierSlots) {
    const pin = registry.nativeStoreForwards!.find(pin => pin.path === earlier?.path), source = preceding.find(source => source.path === earlier?.path);
    if (!pin || !source || sqlSha256(source.bytes) !== pin.sha256) {
      if (checkout) throw checkoutPredecessorRefusal(earlier.path);
      if (slot.qualifiedPriceListBasisSelect) throw new Error(`reviewed native store qualified price list basis SELECT earlier slot is unbound, missing or drifted: ${earlier.path}`);
      throw new Error("reviewed native store requires every earlier slot landed first");
    }
    if (earlier.settingsOnlyFunctions) landedSettings.set(earlier.path, new Set(earlier.settingsOnlyFunctions.map(renderNativeStoreSetting)));
  }
  for (const pin of [...registry.batchedForwards ?? [], ...registry.portableReplacementForwards ?? [], ...registry.portableCreationForwards ?? [], ...registry.channelIngestForwards ?? []].filter(pin => pin.path.startsWith("db/") && pin.path < path)) {
    const source = preceding.find(source => source.path === pin.path);
    if (!source || sqlSha256(source.bytes) !== pin.sha256) {
      if (checkout) throw checkoutPredecessorRefusal(pin.path);
      throw new Error("reviewed native store prior issued file drifted");
    }
  }
  const ordinaryProof = new Map<string, { definition: NonNullable<ReturnType<typeof nativeStoreTriggerDefinition>>; localTable: boolean }>();
  if (revokePublic) {
    const signatures = slot.grantOnlyFunctions.map(fn => fn.signature);
    const missing = new Set(signatures);
    const classStart = `db/platform/migrations/${nativeStoreTime(control!.slots[0]!.path)}_`;
    for (const source of preceding) {
      if (source.path >= classStart) break;
      const definitions = scanNativeStoreSql(source.path, () => nativeStoreFunctionDefinitions(source.bytes, signatures, true));
      for (const signature of definitions.keys()) missing.delete(signature);
    }
    if (missing.size) throw new Error(nativeStoreRevokePublicMessages.base);
    assertRevokePublicSql(bytes.toString("utf8"), signatures);
    return { slot, ordinaryProof };
  }
  const grandfatheredSecurityDefiner = isGrandfatheredSecurityDefinerForward(path, bytes);
  const pins = (slot.createdTriggers ?? []).filter((entry): entry is NativeDeferredTrigger => entry.deferred === true);
  const created = new Set(slot.createdFunctions.map(fn => fn.signature));
  const statements = scanNativeStoreSql(path, () => sqlStatements(bytes.toString("utf8"), false, false, true));
  const pinnedMessage = (pin: NativeDeferredTrigger, name = pin.name) => {
    const digest = created.has(pin.function) && forward.functions.find(binding => binding.signature === pin.function)?.afterSha256;
    const creation = digest ? statements.find(sql => sqlSha256(sql) === digest) : undefined;
    return new Error(deferredTriggerMessages.pinned(pin, name, creation));
  };
  if (checkoutPredecessor) {
    try {
      const [predecessor, ...other] = assertExecutePredecessors(registry, earlierSlots, preceding, checkoutOwnerRoutines, true);
      if (!predecessor || other.length || predecessor.path !== checkoutPredecessor.path) throw checkoutPredecessorRefusal(checkoutPredecessor.path);
      return { slot, ordinaryProof, checkoutPredecessor: { slot: checkoutPredecessor, pin: predecessor } };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("checkout_owner_predecessor_unverified:")) throw error;
      throw checkoutPredecessorRefusal(checkoutPredecessor.path);
    }
  }
  if (slot.qualifiedPriceListBasisSelect) {
    return { slot, ordinaryProof, priceListBasisPredecessor: assertPriceListBasisPredecessor(registry, earlierSlots, preceding) };
  }
  if (slot.qualifiedPriceSetupExecute) {
    return { slot, ordinaryProof, priceSetupPredecessors: assertExecutePredecessors(registry, earlierSlots, preceding, executeTargets) };
  }
  if (slot.previewNoopAcceptance) {
    assertPreviewNoopAcceptance(bytes, preceding);
    return { slot, ordinaryProof };
  }
  if (slot.settingsOnlyFunctions) {
    const expected = slot.settingsOnlyFunctions.map(renderNativeStoreSetting);
    const settingsStatements = slot.ownerWindowRole === undefined ? statements : statements.slice(1, -1);
    const refusal = "reviewed native store settings-only forward must contain exactly its ordered ALTER FUNCTION search_path statements";
    if (settingsStatements.length !== expected.length) throw new Error(`${refusal}. Expected ${expected.length} statements, found ${settingsStatements.length}.`);
    const difference = expected.findIndex((statement, index) => statement !== settingsStatements[index]);
    if (difference !== -1) throw new Error(`${refusal}. At index ${difference} (zero-based), expected: ${expected[difference]}`);
    assertNativeStoreSettingsTargets(slot.settingsOnlyFunctions, preceding);
    return { slot, ordinaryProof };
  }
  const qualifiedCatalogueReadGrant = isQualifiedCatalogueReadGrant(slot);
  if (qualifiedCatalogueReadGrant && !bytes.equals(Buffer.from(qualifiedCatalogueReadSql))) throw new Error("reviewed native store qualified catalogue read forward must contain exactly the EXECUTE grant guarded by role existence and the authority ledger path and hash");
  const qualifiedSecurityStatements = new Map(slot.replacedFunctions.filter(fn => fn.qualifiedSecurityDefiner)
    .map(fn => [fn.signature, renderQualifiedSecurityDefiner(fn.signature)]));
  const definitionSources = qualifiedCatalogueReadGrant ? new Map<string, string>() : undefined;
  const triggerFunctions = new Set<string>(), granted = new Set<string>();
  const functions = nativeStoreFunctions(slot), signatures = [...functions, ...slot.grantOnlyFunctions].map(fn => fn.signature);
  const names = new Set(signatures.map(signature => signature.split("(")[0]!)), prior = new Map<string, string>(), baseDefinitions = new Map<string, string>(), priorStatements = new Map<string, string>();
  const replacements = [...slot.checkSupersets ?? [], ...slot.uniqueSupersets ?? []], droppedIndexes = slot.droppedIndexes ?? [];
  const guardedChecks: NativeStoreCheckToFunctionGuard[] = slot.checkToFunctionGuard ?? [];
  const guardedTables = new Set(guardedChecks.map(entry => entry.table));
  const priorChecks = new Map<string, PlatformSqlToken[]>();
  const indexCreates = new Set<string>();
  let checkSource: string | undefined;
  const allowedSignatures = new Set(signatures);
  for (const source of preceding) for (const { statement, tokens, complete } of scanNativeStoreSql(source.path, () => cachedNativePrefixStatements(source.bytes))) {
    if (landedSettings.get(source.path)?.has(statement)) continue;
    const functionIndex = nativeWord(tokens, 1, "OR") && nativeWord(tokens, 2, "REPLACE") ? 3 : 1;
    if (source.path !== PLATFORM_BASELINE_FILE && ["CREATE", "ALTER", "DROP"].some(word => nativeWord(tokens, 0, word)) && nativeWord(tokens, functionIndex, "FUNCTION")) {
      const target = functionIndex + 1, name = nativeQualified(tokens, target);
      if (!name || (names.has(name.name) && !nativeWord(tokens, 0, "CREATE"))) {
        const start = nativeWord(tokens, target, "IF") && nativeWord(tokens, target + 1, "EXISTS") ? target + 2 : target;
        const args = tokens.find((_, index) => index > start && nativeSymbol(tokens, index, "("));
        let functionName = name?.name ?? nativeStoreTrim(statement.slice(tokens[start]?.start ?? statement.length, args?.start ?? tokens.at(-1)?.start));
        for (let index = start; !name && index < tokens.length; index++) {
          const listed = nativeQualified(tokens, index);
          if (listed && names.has(listed.name) && nativeSymbol(tokens, listed.next, "(")) {
            functionName = listed.name;
            break;
          }
        }
        throw new Error(`reviewed native store unsupported preceding function DDL in ${source.path} for ${functionName || "<missing function name>"}`);
      }
    }
    const definition = nativeStoreFunctionDefinitionFromTokens(statement, tokens, complete, allowedSignatures, names, true, source.path);
    if (definition) {
      const [signature, digest] = definition;
      prior.set(signature, digest); priorStatements.set(signature, statement);
      definitionSources?.set(signature, source.path);
      if (source.path < `db/platform/migrations/${nativeStoreTime(control!.slots[0]!.path)}_`) baseDefinitions.set(signature, digest);
    }
    // The pinned hash binds a plain CREATE of the listed index. Reading history lexically cannot
    // follow what PostgreSQL executes, so the catalog proof decides what the dropped index is.
    for (const index of droppedIndexes) {
      if (sqlSha256(statement) !== index.beforeSha256) continue;
      const at = nativeWord(tokens, 1, "UNIQUE") ? 2 : 1, table = nativeQualified(tokens, at + 3);
      if (!complete || !nativeWord(tokens, 0, "CREATE") || !nativeWord(tokens, at, "INDEX") || tokens[at + 1]?.kind !== "word" || nativeIdentifier(tokens[at + 1]) !== index.name || !nativeWord(tokens, at + 2, "ON") || tokens[at + 3]?.kind !== "word" || tokens[at + 5]?.kind !== "word" || table?.name !== index.table || (!nativeSymbol(tokens, table.next, "(") && !nativeWord(tokens, table.next, "USING")) || !nativeSymbol(tokens, tokens.length - 1, ";")) throw new Error("reviewed native store dropped index preimage is not a plain CREATE INDEX of its table");
      indexCreates.add(index.name);
    }
    if (slot.purposeCheck && statement.startsWith(`CREATE TABLE ${purposeTable} (`)) checkSource = statement;
    if (slot.purposeCheck && /^(?:ALTER|DROP)\b/iu.test(statement) && /\bTABLE\b/iu.test(statement) && statement.toLowerCase().includes("communication_native_sync_state")) throw new Error("reviewed native store purpose CHECK intervening DDL refused");
    if (guardedTables.size) trackPriorCheckConstraints(statement, tokens, complete, guardedTables, priorChecks);
  }
  if (definitionSources) {
    for (const [sourcePath, signature] of qualifiedCatalogueReadTargets) {
      const pin = registry.nativeStoreForwards!.find(entry => entry.path === sourcePath)?.functions.find(fn => fn.signature === signature);
      if (!pin || definitionSources.get(signature) !== sourcePath || prior.get(signature) !== pin.afterSha256) throw new Error(`reviewed native store qualified catalogue read target must resolve to its pinned predecessor: ${signature}`);
    }
    return { slot, ordinaryProof };
  }
  if (indexCreates.size !== droppedIndexes.length) throw new Error("reviewed native store dropped index plain CREATE missing from prefix");
  const priorEnumValues = new Map<string, string[]>();
  for (const entry of guardedChecks) {
    const key = `${entry.table}.${entry.name}`;
    const priorTokens = priorChecks.get(key);
    if (!priorTokens) throw new Error(`reviewed native store checkToFunctionGuard prior CHECK missing from prefix: ${key}`);
    const parsed = nativeCheckValues(priorTokens, 0, entry.column);
    if (!parsed || parsed.next !== priorTokens.length) throw new Error(`reviewed native store checkToFunctionGuard prior CHECK must be a closed enum on ${entry.column}: ${key}`);
    if (sqlSha256(normalizeCheckTokens(priorTokens)) !== entry.beforeSha256) throw new Error(`reviewed native store checkToFunctionGuard beforeSha256 mismatch for ${key}`);
    priorEnumValues.set(key, parsed.values);
  }
  const chained = new Set(earlierSlots.flatMap(slot => nativeStoreFunctions(slot).map(fn => fn.signature)));
  for (const fn of functions) if ((!chained.has(fn.signature) && (baseDefinitions.get(fn.signature) ?? null) !== fn.beforeSha256) || (prior.get(fn.signature) ?? null) !== fn.beforeSha256) throw new Error("reviewed native store actual base function before-hash drifted");
  for (const fn of slot.grantOnlyFunctions) if (!baseDefinitions.has(fn.signature)) throw new Error("reviewed native store grant-only function absent from base chain");
  const existingTableStatements = slot.existingTableStatements ?? [];
  const revoked = new Set<string>(), defined = new Map<string, boolean>(), blocks = new Set<string>(), data = new Set<string>(), tables = new Set<string>();
  const dropped = new Set<string>(), triggers = new Set<string>(), views = new Set<string>(), revokedViews = new Set<string>(), completedConstraints = new Set<string>();
  const censusTables = slot.absorptionCensusTables ?? [], censusGrants = new Set<string>(), censusPolicies = new Set<string>();
  let pending: string | undefined;
  const baselineActions = new Set<number>();
  let storageSelect = false;
  let droppedCheck = false, addedCheck = false, existingTablePosition = 0, insertSelectPolicy = false;
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index]!;
    const parsed = platformSqlTokens(statement, false, true), { tokens } = parsed, head = nativeTableHead(tokens);
    const word = (i: number, value: string) => nativeWord(tokens, i, value);
    const create = word(0, "CREATE"), drop = word(0, "DROP"), changing = word(0, "ALTER");
    const replacement = create && word(1, "OR") && word(2, "REPLACE"), kind = replacement ? 3 : word(0, "COMMENT") ? 2 : 1;
    const constraint = create && word(kind, "CONSTRAINT"), triggerAt = kind + Number(constraint);
    const nameIndex = triggerAt + (word(triggerAt + 1, "IF") && word(triggerAt + 2, "NOT") && word(triggerAt + 3, "EXISTS") ? 4 : 1);
    const id = (i: number) => nativeIdentifier(tokens[i])?.slice(0, 63);
    const next = (i: number) => i + (nativeSymbol(tokens, i + 1, ".") ? 3 : 1);
    const relation = (i: number) => next(i) === i + 3 ? `${id(i)}.${id(i + 2)}` : `public.${id(i)}`;
    const entry = create && word(triggerAt, "TRIGGER") && pins.find(pin => pin.name === id(nameIndex));
    const block = nativeStoreRolePrivilege.exec(statement), pinScan = pins.length && block ? platformSqlTokens(block[2]!, false, true) : parsed;
    // The pin scan reads unquoted and double-quoted identifiers in full. Exact statement pins cover text inside string literals and function bodies.
    const unicodeEscape = pins.length && pinScan.tokens.some((token, i, scan) => nativeWord(scan, i, "UESCAPE")
      || (nativeWord(scan, i, "U") && nativeSymbol(scan, i + 1, "&") && token.end === scan[i + 1]!.start
        && scan[i + 1]!.end === scan[i + 2]?.start && (scan[i + 2]?.kind === "quoted" || scan[i + 2]?.kind === "string")));
    if (pins.length && (!parsed.complete || !pinScan.complete || unicodeEscape)) throw new Error(`The statement cannot be checked for pinned objects. ${pinnedMessage(pins[0]!).message}`);
    if (entry) {
      if (statement !== renderNativeDeferredTrigger(entry) || triggers.has(entry.name)) throw pinnedMessage(entry);
      const digest = sqlSha256(statement);
      if (digest !== entry.sha256) throw new Error(deferredTriggerMessages.hash(entry.name, digest));
    } else if (pins.length) {
      const revoke = word(0, "REVOKE") && tokens.filter((_, i) => i !== 2 || !word(i, "PRIVILEGES")).map(token => nativeIdentifier(token) ?? token.value).join(" ");
      const own = pins.find(pin => created.has(pin.function) && (create && word(1, "FUNCTION")
        ? nativeQualified(tokens, 2)?.name === pin.function.slice(0, -2) && nativeSymbol(tokens, 5, "(") && nativeSymbol(tokens, 6, ")")
        : revoke === `revoke all on function public . ${pin.function.slice(7, -2)} ( ) from public ;`))?.function.slice(7, -2);
      for (const token of pinScan.tokens) {
        const name = nativeIdentifier(token)?.slice(0, 63);
        if (!name || name === own) continue;
        const pin = pins.find(pin => pin.name === name || pin.function === `public.${name}()`);
        if (pin) throw pinnedMessage(pin, name);
      }
    }
    const alter = nativeStoreAlter(statement), start = word(2, "IF") ? 4 : 2, table = start + Number(word(start, "ONLY"));
    const actions = alter?.actions ?? (pins.length && changing && word(1, "TABLE") ? nativeStoreArguments(statement.slice(tokens[next(table)]?.start ?? -1, -1)) : []);
    const parts = actions.map(part => platformSqlTokens(part, false, true));
    const named = parts.length === 1 && parts[0]!.complete ? parts[0]!.tokens : [];
    const name = nativeIdentifier(named[2]), verb = named[0]?.value.toUpperCase();
    const action = alter && name !== null && nativeWord(named, 1, "CONSTRAINT") && (nativeWord(named, 0, "ADD") || nativeWord(named, 0, "DROP"))
      ? { table: alter.table, name, verb, tail: named.slice(3) } : null;
    if (pending && (!action || action.verb !== "ADD" || `${action.table}.${action.name}` !== pending)) throw new Error("reviewed native store requires the adjacent named constraint replacement");
    if (droppedCheck && !addedCheck && !statement.startsWith(`ALTER TABLE ${purposeTable} ADD CONSTRAINT ${purposeConstraint} `)) throw new Error("reviewed native store requires the adjacent purpose CHECK replacement");
    if (entry) { triggers.add(entry.name); continue; }
    const triggerDdl = word(triggerAt, "TRIGGER") && (create || drop || changing || kind === 2);
    const toggle = parts.some(({ tokens: sub }) => (nativeWord(sub, 0, "ENABLE") || nativeWord(sub, 0, "DISABLE"))
      && nativeWord(sub, ["ALWAYS", "REPLICA"].some(word => nativeWord(sub, 1, word)) ? 2 : 1, "TRIGGER"));
    const target = triggerDdl ? tokens.findIndex((_, i) => i > triggerAt && word(i, "ON")) + 1 : table;
    const relationPin = (triggerDdl || toggle) && pins.find(pin => pin.relation === relation(target));
    if (relationPin) throw pinnedMessage(relationPin);
    if (triggerDdl && constraint) {
      const shape = tokens.map((token, i) => i === nameIndex ? "<name>" : statement.slice(token.start, token.end)).join(" ").replace(/ *([.();]) */gu, "$1");
      throw new Error(deferredTriggerMessages.unregistered(tokens[nameIndex], deferredTriggerForm.test(shape)));
    }
    if ((triggerDdl && (drop || changing)) || (toggle && alter)) throw new Error("reviewed native store trigger mutation refused");
    if (triggerDdl && create && !replacement) {
      const trigger = nativeStoreTriggerDefinition(statement);
      if (!trigger) throw new Error("reviewed native store created trigger shape refused");
      const listed = slot.createdTriggers?.find(entry => entry.deferred !== true && entry.name === trigger.name && entry.table === trigger.table);
      if (!listed || triggers.has(trigger.name) || sqlSha256(statement) !== listed.sha256) throw new Error("reviewed native store unlisted, duplicate or drifted trigger statement");
      if (!created.has(trigger.signature) || !defined.has(trigger.signature)) throw new Error("reviewed native store created trigger requires a same-slot created function");
      if (!defined.get(trigger.signature)) throw new Error("reviewed native store trigger function requires RETURNS trigger, SECURITY INVOKER and pinned search_path");
      if (granted.has(trigger.signature)) throw new Error("reviewed native store trigger function GRANT EXECUTE refused");
      triggerFunctions.add(trigger.signature); triggers.add(trigger.name);
      ordinaryProof.set(trigger.name, { definition: trigger, localTable: tables.has(trigger.table) });
      continue;
    }
    if (drop && word(1, "INDEX")) {
      const index = droppedIndexes.find(index => statement === `DROP INDEX public.${index.name};`);
      if (!index || dropped.has(index.name)) throw new Error("reviewed native store unlisted, duplicate or non-plain index drop");
      dropped.add(index.name); continue;
    }
    const constraintPin = action && replacements.find(entry => entry.table === action.table && entry.constraint === action.name);
    if (action && constraintPin) {
      const key = `${action.table}.${action.name}`;
      if (action.verb === "DROP" && action.tail.length === 0) {
        if (pending || completedConstraints.has(key)) throw new Error(`reviewed native store duplicate ${"columns" in constraintPin ? "UNIQUE" : "CHECK"} replacement`);
        pending = key; continue;
      }
      if (action.verb === "ADD") {
        if ("columns" in constraintPin) {
          const parsed = nativeUniqueValues(action.tail, 0);
          if (pending !== key || !parsed || parsed.next !== action.tail.length || canonical(parsed.columns) !== canonical(constraintPin.columns) || parsed.nullsNotDistinct !== constraintPin.nullsNotDistinct) throw new Error("reviewed native store UNIQUE must match its listed key");
        } else {
          const check = constraintPin, parsed = "values" in check ? nativeCheckValues(action.tail, 0, check.column) : nativeCheckRange(action.tail, check.column);
          const next = parsed && nativeWord(action.tail, parsed.next, "NOT") && nativeWord(action.tail, parsed.next + 1, "VALID") ? parsed.next + 2 : parsed?.next;
          const listed = parsed && ("values" in check ? "values" in parsed && canonical(parsed.values) === canonical(check.values)
            : "lower" in parsed && parsed.lower === check.range.lower && parsed.upper === check.range.upper);
          if (pending !== key || !listed || next !== action.tail.length) throw new Error(`reviewed native store CHECK must match its listed ${"values" in check ? "values" : "range"}`);
        }
        pending = undefined; completedConstraints.add(key); continue;
      }
    }
    const guardedPin = action && guardedChecks.find(entry => entry.table === action.table && entry.name === action.name);
    if (action && guardedPin) {
      const key = `${action.table}.${action.name}`;
      if (action.verb === "DROP" && action.tail.length === 0) {
        if (pending || completedConstraints.has(key)) throw new Error("reviewed native store duplicate CHECK replacement");
        pending = key; continue;
      }
      if (action.verb === "ADD") {
        if (pending !== key) throw new Error("reviewed native store requires the adjacent named constraint replacement");
        const parsed = nativeCheckFormat(action.tail, guardedPin.column);
        const next = parsed && nativeWord(action.tail, parsed.next, "NOT") && nativeWord(action.tail, parsed.next + 1, "VALID") ? parsed.next + 2 : parsed?.next;
        if (!parsed || next !== action.tail.length) throw new Error(`reviewed native store checkToFunctionGuard replacement must be a non-trivial anchored format CHECK on ${guardedPin.column}: ${key}`);
        if (sqlSha256(normalizeCheckTokens(action.tail.slice(0, parsed.next))) !== guardedPin.afterSha256) throw new Error(`reviewed native store checkToFunctionGuard afterSha256 mismatch for ${key}`);
        if (priorEnumValues.get(key)!.some(value => !matchesBoundedFormatPattern(parsed.atoms, value))) throw new Error(`reviewed native store checkToFunctionGuard replacement format CHECK must accept all prior enum values for ${key}`);
        pending = undefined; completedConstraints.add(key); continue;
      }
    }
    if (head?.verb === "CREATE" && head.kind === "VIEW" && head.table && nativeWord(tokens, head.next, "AS")) {
      const view = head.table, entry = slot.createdViews?.find(entry => entry.name === view);
      if (!entry || views.has(view) || sqlSha256(statement) !== entry.sha256) throw new Error("reviewed native store unlisted, duplicate or drifted view definition");
      views.add(view); continue;
    }
    if (create && word(kind, "FUNCTION")) {
      const signature = [...nativeStoreFunctionDefinitions(Buffer.from(statement), functions.map(fn => fn.signature)).keys()][0]!, fixed = functions.find(fn => fn.signature === signature);
      if (defined.has(signature)) throw new Error("reviewed native store duplicate function definition");
      if (sqlSha256(statement) !== forward.functions.find(pin => pin.signature === signature)?.afterSha256) throw new Error("reviewed native store unlisted, missing or drifted function definition");
      if (!fixed || replacement !== (fixed.beforeSha256 !== null)) throw new Error("reviewed native store function creation/replacement class drifted");
      const nextHeader = nativeStoreTrim(headerAttributes(statement));
      const header = normalizeNativeStoreHeader(nextHeader);
      const priorHeader = fixed.beforeSha256 === null ? null : nativeStoreTrim(headerAttributes(priorStatements.get(signature)!));
      const nextPath = priorHeader !== null && nextHeader !== priorHeader ? nativeStoreSearchPathClause(nextHeader) : null;
      const qualifiedSecurity = qualifiedSecurityStatements.get(signature);
      if (qualifiedSecurity && /\bSECURITY DEFINER\b/iu.test(header)) throw new Error(`reviewed native store ${signature}: keep the native SECURITY INVOKER header and put this statement immediately after its CREATE OR REPLACE FUNCTION:\n${qualifiedSecurity}`);
      if (priorHeader !== null && !isAllowedNativeStoreReplacementHeader(priorHeader, nextHeader, nextPath)) throw new Error("reviewed native store replacement header drifted");
      const pathHeader = priorHeader !== null ? header.replace(/ SET search_path=/iu, " SET search_path = ") : header;
      const rawSearchPath = nextPath?.schemas.join(", ") ?? / SET search_path = ([a-z_][a-z0-9_]*(?:, [a-z_][a-z0-9_]*)*)$/iu.exec(pathHeader)?.[1] ?? null;
      if (rawSearchPath && !nativeStoreAscii(rawSearchPath)) throw new Error("reviewed native store non-ASCII search_path refused");
      const searchPath = rawSearchPath?.toLowerCase() ?? null;
      if (/--|\/\*|["\\]/u.test(header) || searchPath !== fixed.searchPath || (!nextPath && (header.match(/\bSET search_path\b/giu)?.length ?? 0) > 1)) throw new Error("reviewed native store unpinned SECURITY DEFINER or search_path");
      if (!grandfatheredSecurityDefiner) assertSecurityDefinerSearchPath(statement, path);
      if (/\bSECURITY DEFINER\b/iu.test(header) && !searchPath) throw new Error("reviewed native store unpinned SECURITY DEFINER or search_path");
      defined.set(signature, /^CREATE FUNCTION public\.[a-z_][a-z0-9_]* *\( *\) RETURNS trigger /iu.test(header)
        && /\bSECURITY INVOKER\b/iu.test(header) && !/\bSECURITY DEFINER\b/iu.test(header) && Boolean(fixed.searchPath));
      if (qualifiedSecurity) {
        if (statements[index + 1] !== qualifiedSecurity) throw new Error(`reviewed native store ${signature}: expected this exact statement immediately after its CREATE OR REPLACE FUNCTION:\n${qualifiedSecurity}`);
        index++;
      }
      continue;
    }
    if (/^DO[ \t\n]+\$qualified_security_definer\$/iu.test(statement)) {
      const signature = statement.split("\n").map(line => qualifiedSecurityDefinerAlter.exec(nativeStoreTrim(line))?.[1]).find(Boolean);
      const expected = signature && qualifiedSecurityStatements.get(signature);
      if (expected) throw new Error(`reviewed native store ${signature}: put this exact statement only immediately after its CREATE OR REPLACE FUNCTION:\n${expected}`);
      throw new Error(`reviewed native store ${signature ?? "<unknown function>"}: remove this statement. It is allowed only immediately after a replacement marked qualifiedSecurityDefiner:\n${statement}`);
    }
    if (statement === qualifiedCatalogueStorageSelectSql) {
      if (!slot.qualifiedCatalogueStorageSelect || storageSelect) throw new Error("reviewed native store requires one declared qualified catalogue storage SELECT");
      storageSelect = true;
      continue;
    }
    const privilege = nativeStorePrivilege(statement, tables, slot.insertSelectTables ?? [], views, triggerFunctions, censusTables, block);
    if (privilege) {
      if (privilege.kind === "BASELINE") {
        if (baselineActions.has(privilege.action)) throw new Error("reviewed native store duplicate baseline privilege");
        baselineActions.add(privilege.action); continue;
      }
      if (privilege.kind === "CENSUS") {
        if (!tables.has(privilege.table)) throw new Error("reviewed native store absorption census requires a table created earlier in the same slot");
        const seen = privilege.action === "grant" ? censusGrants : censusPolicies;
        if (seen.has(privilege.table)) throw new Error("reviewed native store duplicate absorption census privilege");
        seen.add(privilege.table); continue;
      }
      if (privilege.kind === "POLICY") {
        if (insertSelectPolicy) throw new Error("reviewed native store INSERT/SELECT permits at most one policy");
        insertSelectPolicy = true; continue;
      }
      if (privilege.kind === "RLS") continue;
      if (privilege.kind === "TABLE" && privilege.role === "public") for (const target of privilege.targets) if (views.has(target)) revokedViews.add(target);
      if (privilege.kind === "FUNCTION") {
        for (const signature of privilege.targets) {
          if (privilege.grant) granted.add(signature);
          const grantOnly = slot.grantOnlyFunctions.find(fn => fn.signature === signature);
          if (grantOnly) {
            if (!privilege.conditional || !(privilege.grant ? grantOnly.grantTo : grantOnly.revokeFrom).includes(privilege.role)) throw new Error("reviewed native store grant-only privilege must use its closed conditional role/verb");
          } else if (!defined.has(signature)) throw new Error("reviewed native store privilege names an unlisted or not-yet-defined function");
        }
        if (privilege.role === "public") for (const signature of privilege.targets) revoked.add(signature);
        else if ((privilege.grant || privilege.conditional) && privilege.targets.some(signature => created.has(signature)) && [...created].some(signature => !revoked.has(signature))) throw new Error("reviewed native store requires PUBLIC revoke before every created-function grant or conditional block");
      }
      if (privilege.conditional) {
        const key = `${privilege.role}:${privilege.grant ? "GRANT" : "REVOKE"}:${privilege.kind}`;
        if (blocks.has(key)) throw new Error("reviewed native store permits one conditional block per role, verb and object kind");
        blocks.add(key);
      }
      continue;
    }
    if (statement === `ALTER TABLE ${purposeTable} DROP CONSTRAINT ${purposeConstraint};`) {
      if (!slot.purposeCheck || droppedCheck || !checkSource || sqlSha256(checkSource) !== slot.purposeCheck.beforeSha256) throw new Error("reviewed native store purpose CHECK preimage drifted");
      const values = /purpose text NOT NULL CHECK \(purpose IN \(([^)]+)\)\)/u.exec(checkSource)?.[1]?.match(/'[a-z][a-z0-9_]*'/gu)?.map(value => value.slice(1, -1));
      if (canonical(values) !== canonical(slot.purposeCheck.values)) throw new Error("reviewed native store purpose CHECK values drifted");
      droppedCheck = true; continue;
    }
    if (statement.startsWith(`ALTER TABLE ${purposeTable} ADD CONSTRAINT ${purposeConstraint} `)) {
      const values = /^ALTER TABLE public\.communication_native_sync_state ADD CONSTRAINT communication_native_sync_state_purpose_check CHECK \(purpose IN \(('[a-z][a-z0-9_]*'(?:,[ \t\n]*'[a-z][a-z0-9_]*')*)\)\);$/u.exec(statement)?.[1]?.match(/'[a-z][a-z0-9_]*'/gu)?.map(value => value.slice(1, -1));
      if (!slot.purposeCheck || !droppedCheck || addedCheck || !values || slot.purposeCheck.values.some(value => !values.includes(value))) throw new Error("reviewed native store purpose CHECK must only widen");
      addedCheck = true; continue;
    }
    // Intercept existing-table ALTERs before generic ADD admission: otherwise a
    // changed or extra additive companion could bypass the exact ordered list.
    if (existingTableStatements.length && head?.verb === "ALTER" && head.kind === "TABLE" && !tables.has(head.table ?? "")) {
      if (statement !== existingTableStatements[existingTablePosition]) throw new Error("reviewed native store existing-table statement unlisted, duplicate or out of order");
      existingTablePosition++; continue;
    }
    if (slot.dataStatements.includes(statement)) { data.add(statement); continue; }
    const indexCreation = nativeWord(tokens, 0, "CREATE") && nativeWord(tokens, nativeWord(tokens, 1, "UNIQUE") ? 2 : 1, "INDEX");
    const newTable = head?.verb === "CREATE" && head.kind === "TABLE" && head.table !== null && !tables.has(head.table) && nativeSymbol(tokens, head.next, "(") && Boolean(nativeQualified(tokens, 2));
    if (head?.verb === "CREATE" && head.table === "public.catalog_sku_successors" && (!newTable || !nativeCatalogSuccessorsCreation(statement))) throw new Error("reviewed native store successor table differs from its closed RESTRICT shape");
    if (head?.verb === "CREATE" && head.table && Object.hasOwn(NATIVE_SUCCESSOR_TABLE_SQL, head.table) && (!newTable || !nativeSuccessorStorageCreation(statement))) throw new Error("reviewed native store successor storage table differs from its closed RESTRICT shape");
    if ((indexCreation || head?.kind === "TABLE") && expandOnlyPlatformForward(statement, false, newTable)) {
      if (head?.verb === "CREATE" && head.table && nativeSymbol(tokens, head.next, "(") && nativeQualified(tokens, 2)) tables.add(head.table);
      continue;
    }
    throw new Error("reviewed native store refuses statement outside its closed shapes");
  }
  if (Boolean(slot.qualifiedCatalogueStorageSelect) !== storageSelect) throw new Error("reviewed native store missing exact qualified catalogue storage SELECT");
  if (defined.size !== functions.length) throw new Error("reviewed native store unlisted, missing or drifted function definition");
  if ([...created].some(signature => !revoked.has(signature))) throw new Error("reviewed native store created function missing PUBLIC revoke");
  if (droppedCheck !== addedCheck || Boolean(slot.purposeCheck) !== addedCheck) throw new Error("reviewed native store requires the complete named CHECK replacement");
  if (pending || completedConstraints.size !== replacements.length + guardedChecks.length) throw new Error("reviewed native store requires the complete named CHECK replacement");
  if (dropped.size !== droppedIndexes.length) throw new Error("reviewed native store listed index drop missing");
  if (triggers.size !== (slot.createdTriggers?.length ?? 0)) throw new Error(["reviewed native store created trigger statement missing", pins.find(pin => !triggers.has(pin.name))?.name].filter(Boolean).join(": "));
  if (views.size !== (slot.createdViews?.length ?? 0)) throw new Error("reviewed native store created view missing");
  if ([...views].some(view => !revokedViews.has(view))) throw new Error("reviewed native store created view missing PUBLIC revoke");
  if (data.size !== slot.dataStatements.length) throw new Error("reviewed native store named data statement missing");
  if (censusTables.some(table => !censusGrants.has(table) || !censusPolicies.has(table))) throw new Error("reviewed native store absorption census requires exactly one grant and policy per listed table");
  if (slot.insertSelectTables?.includes(baselineTable) && baselineActions.size !== baselinePrivileges.length) throw new Error("reviewed native store baseline requires its grant and both policies");
  if (existingTablePosition !== existingTableStatements.length) throw new Error("reviewed native store existing-table statement missing");
  return { slot, ordinaryProof };
}
