import type { SchemaObject, SqlExecutor, SchemaProbePort, RequiredSchema } from "./contracts.js";
/** @beta Identity distinguishes overloads and qualified columns. */
export function schemaObjectKey(object: SchemaObject): string {
  return `${object.kind}:${object.name}${object.kind === "function" ? `(${object.signature ?? ""})` : ""}`;
}
/** @beta Parameterized catalog queries; this builder performs no I/O. */
export function buildSchemaObjectProbe(object: SchemaObject): { text: string; values: readonly unknown[] } {
  if (object.kind === "function") return { text: "select to_regprocedure($1)::oid is not null as present", values: [`${object.name}(${object.signature ?? ""})`] };
  if (object.kind === "table") return { text: "select exists (select 1 from pg_catalog.pg_class c where c.oid = to_regclass($1) and c.relkind in ('r','p')) as present", values: [object.name] };
  const parts = object.name.split(".");
  return { text: "select exists (select 1 from pg_catalog.pg_attribute where attrelid = to_regclass($1) and attname = $2 and attnum > 0 and not attisdropped) as present", values: [parts.slice(0, -1).join("."), parts.at(-1)] };
}
/** @beta Explicit adapter. Host supplies independently observed database and migration identity. */
export function createSchemaProbe(executor: SqlExecutor, identity: (requirement: RequiredSchema) => Promise<{ database: string; version: string | null }>): SchemaProbePort {
  return { async observe(requirement) {
    const observed = await identity(requirement);
    const objects = await Promise.all(requirement.objects.map(async (object) => {
      const query = buildSchemaObjectProbe(object);
      const { rows } = await executor.query(query.text, query.values);
      return { object, present: rows.length === 1 && typeof rows[0]?.present === "boolean" ? rows[0].present : null };
    }));
    return { ...observed, objects };
  } };
}

/** @beta An ordered catalog observation, not proof of behavior or authorization. */
export type PostgresSchemaCatalogEntry = {
  object: SchemaObject;
  present: boolean;
  shape: Readonly<Record<string, unknown>> | null;
};

/** @beta One parameterized PostgreSQL catalog read; the host owns execution and snapshot. */
export function buildGroupedPostgresSchemaProbe(objects: readonly SchemaObject[]): { text: string; values: readonly unknown[] } {
  const scalarValues = objects.map(object => buildSchemaObjectProbe(object).values);
  return {
    values: [objects.map(object => object.kind), scalarValues.map(values => values[0]), scalarValues.map(values => values[1] ?? null)],
    text: `with requested as (
  select kind, name, column_name, ordinal::integer as ordinal
  from unnest($1::text[], $2::text[], $3::text[]) with ordinality as r(kind, name, column_name, ordinal)
), resolved as (
  select r.*, c.oid as relation_oid, c.relkind, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity,
    a.attnum, a.atttypid, a.atttypmod, a.attnotnull, a.attidentity, a.attgenerated, a.attacl,
    p.oid as function_oid, p.proowner, p.proacl, p.proconfig, p.prosecdef, p.provolatile
  from requested r
  left join pg_catalog.pg_class c on c.oid = case when r.kind <> 'function' then pg_catalog.to_regclass(r.name) end
  left join pg_catalog.pg_attribute a on r.kind = 'column' and a.attrelid = c.oid
    and a.attname = r.column_name and a.attnum > 0 and not a.attisdropped
  left join pg_catalog.pg_proc p on p.oid = case when r.kind = 'function' then pg_catalog.to_regprocedure(r.name) end
)
select ordinal,
  case kind when 'table' then coalesce(relkind in ('r','p'), false)
    when 'column' then attnum is not null when 'function' then function_oid is not null end as present,
  case
    when kind = 'function' and function_oid is not null then pg_catalog.jsonb_build_object(
      'definition', pg_catalog.pg_get_functiondef(function_oid), 'owner', pg_catalog.pg_get_userbyid(proowner),
      'acl', proacl, 'config', proconfig, 'securityDefiner', prosecdef, 'volatility', provolatile)::text
    when kind = 'table' and relkind in ('r','p') then pg_catalog.jsonb_build_object(
      'kind', relkind, 'owner', pg_catalog.pg_get_userbyid(relowner), 'acl', relacl,
      'rls', relrowsecurity, 'forceRls', relforcerowsecurity,
      'constraints', (select pg_catalog.jsonb_agg(pg_catalog.pg_get_constraintdef(x.oid) order by x.conname)
        from pg_catalog.pg_constraint x where x.conrelid = relation_oid),
      'indexes', (select pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(x.indexrelid) order by x.indexrelid::regclass::text)
        from pg_catalog.pg_index x where x.indrelid = relation_oid),
      'triggers', (select pg_catalog.jsonb_agg(pg_catalog.pg_get_triggerdef(x.oid) order by x.tgname)
        from pg_catalog.pg_trigger x where x.tgrelid = relation_oid and not x.tgisinternal),
      'policies', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name', x.polname, 'roles', x.polroles, 'cmd', x.polcmd, 'permissive', x.polpermissive,
        'qual', pg_catalog.pg_get_expr(x.polqual, x.polrelid), 'check', pg_catalog.pg_get_expr(x.polwithcheck, x.polrelid)) order by x.polname)
        from pg_catalog.pg_policy x where x.polrelid = relation_oid))::text
    when kind = 'column' and attnum is not null then pg_catalog.jsonb_build_object(
      'type', pg_catalog.format_type(atttypid, atttypmod), 'notNull', attnotnull, 'identity', attidentity,
      'generated', attgenerated, 'default', (select pg_catalog.pg_get_expr(d.adbin, d.adrelid)
        from pg_catalog.pg_attrdef d where d.adrelid = relation_oid and d.adnum = attnum), 'acl', attacl)::text
    else null
  end as shape
from resolved order by ordinal`,
  };
}

/** @beta Refuses incomplete or malformed observations without exposing catalog bodies. */
export function decodeGroupedPostgresSchemaRows(objects: readonly SchemaObject[], rows: readonly Record<string, unknown>[]): readonly PostgresSchemaCatalogEntry[] {
  function invalid(): never { throw new Error("Invalid grouped PostgreSQL schema rows"); }
  if (rows.length !== objects.length) invalid();
  return objects.map((object, index) => {
    const row = rows[index];
    if (!row || !Number.isInteger(row.ordinal) || row.ordinal !== index + 1 || typeof row.present !== "boolean") invalid();
    let shape: unknown = row.shape;
    if (!row.present) {
      if (shape !== null) invalid();
    } else {
      if (typeof shape !== "string" || shape.length === 0) invalid();
      try { shape = JSON.parse(shape); } catch { invalid(); }
      if (shape === null || typeof shape !== "object" || Array.isArray(shape)) invalid();
    }
    return { object, present: row.present, shape: shape as PostgresSchemaCatalogEntry["shape"] };
  });
}
