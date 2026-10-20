import { createHash } from "node:crypto";
import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor, type PostgresDataGatewayEnv, type PostgresDataGatewayOptions } from "../data/index.js";

export const nativeFingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");
export function nativeText(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || [...value].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)) throw new Error("native_communications_text_invalid");
  return value;
}
export function nativeEmail(value: unknown): string {
  const email = nativeText(value, 320).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("native_communications_email_invalid");
  return email;
}
export function nativeTime(value: unknown): string {
  const parts = typeof value === "string" ? /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d{1,6}))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value) : null;
  if (!parts || typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("native_communications_time_invalid");
  if (new Date(value.slice(0,10) + "T00:00:00Z").toISOString().slice(0,10) !== value.slice(0,10)) throw new Error("native_communications_time_invalid");
  // PostgreSQL stores microseconds. Never collapse two distinct immutable facts to JS milliseconds.
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, `.${(parts[1] ?? "").padEnd(6,"0")}Z`);
}
export function nativeInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("native_communications_bound_invalid");
  return value;
}
export function nativeJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("native_communications_object_invalid");
  const text = JSON.stringify(value);
  if (text.length > 4096) throw new Error("native_communications_object_too_large");
  return text;
}
export const nativeStamp = (value: unknown): string => nativeTime(value instanceof Date ? value.toISOString() : value);
/** Private capability-local helper. The host owns the connection authority; no SET ROLE or runtime DDL. */
export function nativeTransactions(env: PostgresDataGatewayEnv, options: PostgresDataGatewayOptions, tables: string[]) {
  if (!env.connectionString.trim()) throw new Error("communications_database_url_required");
  const lane = createPostgresRoleFreeTransactionLane(env, options);
  return {
    close: lane.close,
    run: <T>(work: (db: PgQueryExecutor) => Promise<T>): Promise<T> => lane.run(async gateway => {
      const db = gateway as PgQueryExecutor;
      // Effective privileges include PUBLIC, role membership and column/default grants.
      // Missing relations, malformed responses and untrusted execution roles all refuse.
      const row = (await db.query(`SELECT current_user IN ('anon','authenticated','authenticator') AS browser,
        EXISTS (SELECT 1 FROM unnest($1::text[]) t(name), pg_roles r
          WHERE r.rolname IN ('anon','authenticated','authenticator') AND
          (has_table_privilege(r.oid, t.name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(r.oid, t.name, 'SELECT,INSERT,UPDATE,REFERENCES')))
        OR EXISTS (SELECT 1 FROM unnest($1::text[]) t(name), pg_class c,
          LATERAL aclexplode(coalesce(c.relacl, acldefault('r',c.relowner))) a WHERE c.oid = t.name::regclass AND a.grantee = 0)
        OR EXISTS (SELECT 1 FROM unnest($1::text[]) t(name), pg_attribute c,
          LATERAL aclexplode(c.attacl) a WHERE c.attrelid = t.name::regclass AND a.grantee = 0) AS unsafe`, [tables])).rows[0];
      if (row?.browser !== false || row?.unsafe !== false) throw new Error("native_communications_privileges_unsafe");
      return work(db);
    }),
  };
}
