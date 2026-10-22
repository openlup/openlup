import type { Pool } from "pg";
import { expect } from "vitest";
import { batchedFunctionDefinitions, sqlStatements, type BatchedForwardBinding } from "../../scripts/reviewed-platform-forward.js";

// Preserve every structural pg_proc attribute. Normalize only parse locations,
// which PostgreSQL records from the file offset rather than function semantics.
export async function batchSnapshot(db: Pool) {
  const functions = (await db.query(`SELECT p.oid, n.nspname||'.'||p.proname AS name,
    p.prosrc, (to_jsonb(p)-'prosrc'-'proargdefaults')||jsonb_build_object(
      'proargdefaults',regexp_replace(p.proargdefaults::text,':location -?[0-9]+',':location -1','g')) AS attributes
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace ORDER BY p.oid`)).rows;
  const relations = (await db.query(`SELECT c.oid, n.nspname||'.'||c.relname AS name, c.relkind,
    to_jsonb(c)-'relpages'-'reltuples'-'relallvisible'-'relallfrozen' AS attributes,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%' ORDER BY c.oid`)).rows;
  const catalogs: Record<string, unknown[]> = {};
  for (const table of ["pg_namespace", "pg_type", "pg_trigger", "pg_policy", "pg_default_acl", "pg_roles", "pg_auth_members", "pg_constraint", "pg_index", "pg_rewrite", "pg_foreign_server", "pg_event_trigger", "pg_extension", "pg_description"]) {
    catalogs[table] = (await db.query(`SELECT to_jsonb(c) AS value FROM pg_catalog.${table} c ORDER BY to_jsonb(c)::text`)).rows.map(row => row.value);
  }
  const tables = relations.filter(row => row.relkind === "r" && /^(?:public|private)\./u.test(row.name));
  const data: Record<string, unknown[]> = {};
  for (const table of tables) data[table.name] = (await db.query(`SELECT to_jsonb(t) AS value FROM ${table.name} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.value);
  return { functions, relations, catalogs, data };
}
export type BatchSnapshot = Awaited<ReturnType<typeof batchSnapshot>>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const additions = (before: unknown[], after: unknown[]) => {
  const old = new Set(before.map(row => JSON.stringify(row)));
  return after.filter(row => !old.has(JSON.stringify(row)));
};
const removed = (before: unknown[], after: unknown[]) => additions(after, before);

/** Independent catalog observer: expected identities come from reviewed pins,
 * actual statement effects come exclusively from PostgreSQL catalogs and rows. */
export async function assertBatchCatalog(db: Pool, pin: BatchedForwardBinding, source: Buffer, before: BatchSnapshot, after: BatchSnapshot) {
  const statements = sqlStatements(source.toString());
  const creates = pin.functions.filter(fn => fn.beforeSha256 === null);
  const replaces = pin.functions.filter(fn => fn.beforeSha256 !== null);
  const ids = new Map<string, number>();
  for (const fn of pin.functions) ids.set(fn.signature, (await db.query("SELECT $1::regprocedure::oid AS oid", [fn.signature])).rows[0].oid);
  const replacedIds = new Set(replaces.map(fn => ids.get(fn.signature)));
  const createdIds = new Set(creates.map(fn => ids.get(fn.signature)));
  const currentFunctions = new Map(after.functions.map(row => [row.oid, row]));
  for (const row of before.functions) {
    const current = currentFunctions.get(row.oid);
    if (replacedIds.has(row.oid)) {
      expect(current?.attributes, `${pin.path}: replacement metadata/ACL ${row.name}`).toEqual(row.attributes);
      expect(current?.prosrc).not.toBe(row.prosrc);
    } else expect(current, `${pin.path}: existing function ${row.name}`).toEqual(row);
  }
  const oldFunctionIds = new Set(before.functions.map(row => row.oid));
  expect(after.functions.filter(row => !oldFunctionIds.has(row.oid)).map(row => row.oid).sort()).toEqual([...createdIds].sort());
  for (const fn of pin.functions) {
    const row = currentFunctions.get(ids.get(fn.signature)!)!;
    const statement = statements.find(sql => batchedFunctionDefinitions(Buffer.from(sql)).has(fn.signature))!;
    const body = /\bAS (\$[a-z_0-9]*\$)([\s\S]*)\1;$/iu.exec(statement);
    expect(body, `${fn.signature} raw body`).not.toBeNull();
    expect(row.prosrc).toBe(body![2]);
    if (fn.beforeSha256 === null) {
      expect(row.attributes.prosecdef).toBe(/\bSECURITY DEFINER\b/u.test(statement.slice(0, body!.index)));
      const config = /SET search_path\s*=\s*([a-z_, ]+)\s+AS/u.exec(statement)?.[1]?.split(",").map(value => value.trim()).join(", ");
      expect(row.attributes.proconfig).toEqual([`search_path=${config}`]);
    }
  }
  const newTables = statements.flatMap(sql => /^CREATE TABLE (public\.[a-z_][a-z0-9_]*)\s*\(/u.exec(sql)?.[1] ?? []);
  const oldRelations = new Set(before.relations.map(row => row.oid));
  const newRelations = after.relations.filter(row => !oldRelations.has(row.oid));
  expect(newRelations.filter(row => row.relkind === "r").map(row => row.name).sort()).toEqual([...newTables].sort());
  const tableIds = new Set(newRelations.filter(row => row.relkind === "r").map(row => row.oid));
  const toastIds = new Set(newRelations.filter(row => row.relkind === "r").map(row => Number(row.attributes.reltoastrelid)));
  const explicitIndexes = new Set(statements.flatMap(sql => /^CREATE INDEX ([a-z_][a-z0-9_]*)/u.exec(sql)?.[1] ?? []));
  const constraintIndexes = new Set((after.catalogs.pg_constraint! as Record<string, unknown>[]).filter(row => tableIds.has(Number(row.conrelid))).map(row => Number(row.conindid)));
  for (const row of newRelations) {
    expect(["r", "i", "t"]).toContain(row.relkind);
    if (row.relkind === "t") expect(toastIds.has(row.oid)).toBe(true);
    if (row.relkind === "i") {
      const index = (after.catalogs.pg_index! as { indexrelid: number; indrelid: number }[]).find(item => Number(item.indexrelid) === row.oid)!;
      expect(tableIds.has(Number(index.indrelid)) || toastIds.has(Number(index.indrelid))).toBe(true);
      expect(toastIds.has(Number(index.indrelid)) || explicitIndexes.has(row.name.split(".")[1]) || constraintIndexes.has(row.oid)).toBe(true);
    }
  }
  const currentRelations = new Map(after.relations.map(row => [row.oid, row]));
  for (const row of before.relations) {
    const current = structuredClone(currentRelations.get(row.oid));
    if (pin.path.endsWith("20261022160000_subscription_dunning_continuity.sql") && row.name === "public.subscription_cycles") {
      for (const column of current.columns) {
        const old = row.columns.find((item: { attnum: number }) => item.attnum === column.attnum);
        if (["id", "retry_attempt"].includes(column.attname)) {
          const delta = (await db.query(`SELECT a.attname,x.privilege_type,x.is_grantable,r.rolname
            FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x JOIN pg_roles r ON r.oid=x.grantee
            WHERE a.attrelid=$1 AND a.attname=$2`, [row.oid, column.attname])).rows;
          expect(delta).toEqual([{ attname: column.attname, privilege_type: "SELECT", is_grantable: false, rolname: "service_role" }]);
          column.attacl = old.attacl;
        }
      }
    }
    expect(current, `${pin.path}: existing relation ${row.name}`).toEqual(row);
  }
  // New ACLs are measured including implicit PUBLIC EXECUTE; grants on existing
  // functions (notably the native allocator) were compared above byte-for-byte.
  for (const fn of creates) {
    const acl = (await db.query(`SELECT x.privilege_type,x.is_grantable,
      CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE r.rolname END AS grantee
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
      LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE p.oid=$1 AND x.grantee<>p.proowner ORDER BY grantee`, [ids.get(fn.signature)])).rows;
    const granted = statements.some(sql => sql.startsWith("GRANT EXECUTE ON FUNCTION ") && batchedFunctionDefinitions(Buffer.from(sql.replace(/^GRANT EXECUTE ON FUNCTION /u, "CREATE FUNCTION ").replace(/ TO service_role;$/u, " RETURNS text LANGUAGE sql AS $$ SELECT ''; $$;"))).has(fn.signature));
    expect(acl).toEqual(granted ? [{ privilege_type: "EXECUTE", is_grantable: false, grantee: "service_role" }] : []);
  }
  for (const table of newTables) {
    const acl = (await db.query(`SELECT x.privilege_type,r.rolname,x.is_grantable FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) x LEFT JOIN pg_roles r ON r.oid=x.grantee
      WHERE c.oid=$1::regclass AND x.grantee<>c.relowner ORDER BY x.privilege_type`, [table])).rows;
    const managed = pin.path.startsWith("supabase/");
    expect(acl).toEqual(managed ? ["DELETE", "INSERT", "SELECT", "UPDATE"].map(privilege_type => ({ privilege_type, rolname: "service_role", is_grantable: false })) : []);
    const row = newRelations.find(item => item.name === table)!;
    expect(row.attributes.relrowsecurity).toBe(managed);
    expect(row.columns.filter((column: { attacl: unknown }) => column.attacl !== null)).toEqual([]);
  }
  const changedTables = Object.keys(before.data).filter(name => !same(before.data[name], after.data[name]));
  const expectedChanged = pin.path.endsWith("20261022180000_subscription_stock_wait.sql") && pin.path.startsWith("supabase/") ? ["public.client_absorption_policy"] : pin.path.endsWith("20261022182000_subscription_lifecycle_message_scan.sql") ? ["public.comms_notification_controls"] : [];
  expect(changedTables.sort()).toEqual(expectedChanged.sort());
  for (const name of expectedChanged) {
    expect(removed(before.data[name]!, after.data[name]!)).toEqual([]);
    const added = additions(before.data[name]!, after.data[name]!) as Record<string, unknown>[];
    if (name === "public.client_absorption_policy") expect(added).toEqual([{ table_name: "subscription_stock_wait_cases", disposition: "block", note: "A frozen subscription delivery is a commercial obligation bound to its original client; never carry or rebind it when absorbing a lead." }]);
    else expect(added.map(({ slug, enabled }) => ({ slug, enabled })).sort((a,b) => String(a.slug).localeCompare(String(b.slug)))).toEqual([{ slug: "subscription-stock-wait-resumed", enabled: true }, { slug: "subscription-stock-wait-started", enabled: true }]);
  }
  for (const table of newTables) expect(after.data[table]).toEqual([]);
  // Catalogs outside approved new-table dependencies and the one pinned function
  // comment must stay exact. No schema, policy, role, default grant or event hook.
  for (const [name, beforeRows] of Object.entries(before.catalogs)) {
    const afterRows = after.catalogs[name]!;
    if (name === "pg_description") {
      const expectedComment = statements.find(sql => sql.startsWith("COMMENT ON FUNCTION "));
      if (expectedComment) {
        const id = ids.get("public.commerce_emit_order_refunded_outbox()");
        expect(removed(beforeRows, afterRows).filter((row: unknown) => Number((row as { objoid: number }).objoid) !== id)).toEqual([]);
        expect(additions(beforeRows, afterRows).filter((row: unknown) => Number((row as { objoid: number }).objoid) !== id)).toEqual([]);
      } else expect(afterRows).toEqual(beforeRows);
      continue;
    }
    expect(removed(beforeRows, afterRows), `${pin.path}: removed ${name}`).toEqual([]);
    const added = additions(beforeRows, afterRows) as Record<string, unknown>[];
    if (name === "pg_type") for (const row of added) {
      expect(newTables.some(table => row.typname === table.split(".")[1] || row.typname === `_${table.split(".")[1]}`), `unexpected type ${JSON.stringify(row)}`).toBe(true);
      expect(row.typacl).toBeNull();
    }
    else if (name === "pg_constraint") for (const row of added) expect(tableIds.has(Number(row.conrelid)), `unexpected constraint ${JSON.stringify(row)}`).toBe(true);
    else if (name === "pg_index") for (const row of added) expect(tableIds.has(Number(row.indrelid)) || toastIds.has(Number(row.indrelid))).toBe(true);
    else if (name === "pg_trigger") for (const row of added) expect(row.tgisinternal && (after.catalogs.pg_constraint! as Record<string, unknown>[]).some(item => item.oid === row.tgconstraint && tableIds.has(Number(item.conrelid))), `unexpected trigger ${JSON.stringify(row)}`).toBe(true);
    else expect(added, `${pin.path}: unexpected ${name}`).toEqual([]);
  }
}


export function assertSameSnapshot(before: BatchSnapshot, after: BatchSnapshot): void {
  const deltas: Record<string, unknown> = {};
  for (const kind of ["functions", "relations"] as const) {
    const old = new Map(before[kind].map(row => [row.oid,row]));
    const changed = after[kind].filter(row => !same(old.get(row.oid),row));
    if (changed.length) deltas[kind] = changed.map(row => ({ before:old.get(row.oid), after:row }));
    if (before[kind].length!==after[kind].length) deltas[`${kind}Count`] = [before[kind].length,after[kind].length];
  }
  for (const kind of ["catalogs", "data"] as const) for (const key of new Set([...Object.keys(before[kind]),...Object.keys(after[kind])])) {
    if (!same(before[kind][key],after[kind][key])) deltas[`${kind}:${key}`] = { removed:removed(before[kind][key]??[],after[kind][key]??[]),added:additions(before[kind][key]??[],after[kind][key]??[]) };
  }
  expect(deltas).toEqual({});
}
