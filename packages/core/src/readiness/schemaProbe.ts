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
