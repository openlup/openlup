// Canonical `selected-catalog-v2` object projection for the public-platform
// migration runner.
//
// WHERE THIS CAME FROM: it was the one live fragment of the parked
// `scripts/oss-phase2-schema-*` receipt axis. The projection format is retained;
// lookup names are bound to pg_catalog. `config/platform-migration-manifest.json` stores sha256 of the
// payload this file emits, and `migrationRunner.assertObjectInventory` refuses to
// serve a database whose live projection serializes to anything else. The exact
// format is pinned in server/adapters/postgres/migrationRunner.test.ts.
//
// WHAT DID NOT COME WITH IT: the optional `SchemaExecutionGuard` parameter and its
// abort/drain wrapper. Neither live caller passed one, and it existed for the
// 45-minute replay runs that axis no longer performs. It never touched a payload byte.
//
// The prepared-statement name still carries the `oss-phase2` prefix on purpose: it
// travels to PostgreSQL on a live connection, and renaming it would be a behavior
// change with nothing to gain.
import { createHash } from "node:crypto";
import type { ClientBase } from "pg";

type R<T> = Readonly<T>;
type Sha256 = string & { readonly __sha256: unique symbol };

export type CatalogKind = "function" | "relation" | "column" | "index" | "constraint" | "trigger" | "policy"
  | "acl-grant" | "default-privilege" | "role-membership" | "type" | "schema" | "extension" | "role";
export type ObjectIdentity = R<{ kind: CatalogKind; schema: string | null; name: string; arguments: readonly string[] }>;
export type AclTargetClass = "schema" | "routine" | "relation" | "sequence" | "column" | "type";
export type AclGrant = R<{ identity: ObjectIdentity; targetClass: AclTargetClass; targetIdentity: ObjectIdentity;
  grantor: string; grantee: string; privilege: string; isGrantable: boolean; aclOrigin: "stored" | "built-in-default" }>;
export type DefaultPrivilege = R<{ identity: ObjectIdentity; ownerRole: string; schema: string | null;
  objectClass: "schema" | "routine" | "relation" | "sequence" | "type"; grantor: string; grantee: string;
  privilege: string; isGrantable: boolean }>;
export type RoleMembership = R<{ identity: ObjectIdentity; grantedRole: string; memberRole: string; grantorRole: string;
  adminOption: boolean; inheritOption: boolean; setOption: boolean }>;
export type RoleRecord = R<{ identity: ObjectIdentity; canLogin: boolean; inherits: boolean; superuser: boolean;
  createRole: boolean; createDb: boolean; replication: boolean; bypassRls: boolean; connectionLimit: number;
  validUntil: string | null }>;
export type ObjectOwnership = R<{ object: ObjectIdentity; ownerRole: string }>;
export type ProjectedObject = R<{ identity: ObjectIdentity; definitionDigest: Sha256 | null; attributesDigest: Sha256 }>;
const validatedProjection: unique symbol = Symbol("validatedProjection");
export type ValidatedProjection = R<{ objects: readonly ProjectedObject[]; aclGrants: readonly AclGrant[];
  defaultPrivileges: readonly DefaultPrivilege[]; roleMemberships: readonly RoleMembership[]; roles: readonly RoleRecord[];
  ownerships: readonly ObjectOwnership[]; digest: Sha256; readonly [validatedProjection]: "selected-catalog-v2" }>;

type CatalogRow = { kind: CatalogKind; schema: string | null; name: string; arguments: string[];
  definition: string | null; attributes: string };
const compareCodeUnits = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
const ROUTINE_IDENTITY_ARGUMENTS_SQL = "ARRAY(SELECT pg_catalog.format_type(input_type,NULL) FROM pg_catalog.unnest(p.proargtypes::pg_catalog.oid[]) WITH ORDINALITY AS input_arguments(input_type,ordinal) ORDER BY ordinal)";
const USER_TYPE_SELECTION_SQL = "(t.typtype OPERATOR(pg_catalog.=) ANY(ARRAY['d','e','r','m','b']::pg_catalog.\"char\"[]) AND t.typrelid OPERATOR(pg_catalog.=) 0 OR t.typtype OPERATOR(pg_catalog.=) 'c' AND EXISTS (SELECT 1 FROM pg_catalog.pg_class type_relation WHERE type_relation.oid OPERATOR(pg_catalog.=) t.typrelid AND type_relation.relkind OPERATOR(pg_catalog.=) 'c'))";
const userSchemaPredicate = (column: string): string =>
  `pg_catalog.left(${column},3) OPERATOR(pg_catalog.<>) 'pg_' AND ${column} OPERATOR(pg_catalog.<>) 'information_schema'`;
const CATALOG_SQL = String.raw`
WITH ns AS (
 SELECT oid,nspname FROM pg_catalog.pg_namespace WHERE ${userSchemaPredicate("nspname")}
), objects AS (
 SELECT 'schema' kind,NULL::pg_catalog.text schema,n.nspname name,ARRAY[]::pg_catalog.text[] arguments,NULL::pg_catalog.text definition,
   pg_catalog.jsonb_build_object('owner',pg_catalog.pg_get_userbyid(x.nspowner),'aclStored',x.nspacl IS NOT NULL,
     'description',pg_catalog.obj_description(n.oid,'pg_namespace'))::pg_catalog.text attributes
 FROM ns n JOIN pg_catalog.pg_namespace x ON x.oid OPERATOR(pg_catalog.=) n.oid
 UNION ALL SELECT 'function',n.nspname,p.proname,${ROUTINE_IDENTITY_ARGUMENTS_SQL},pg_catalog.pg_get_functiondef(p.oid),
   pg_catalog.jsonb_build_object('kind',p.prokind,'owner',pg_catalog.pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,
     'volatility',p.provolatile,'aclStored',p.proacl IS NOT NULL,'description',pg_catalog.obj_description(p.oid,'pg_proc'))::pg_catalog.text
 FROM pg_catalog.pg_proc p JOIN ns n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace
 UNION ALL SELECT 'relation',n.nspname,c.relname,ARRAY[]::pg_catalog.text[],CASE WHEN c.relkind OPERATOR(pg_catalog.=) ANY(ARRAY['v','m']::pg_catalog."char"[]) THEN pg_catalog.pg_get_viewdef(c.oid,true) ELSE NULL END,
   pg_catalog.jsonb_build_object('kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,
     'forceRls',c.relforcerowsecurity,'aclStored',c.relacl IS NOT NULL,'description',pg_catalog.obj_description(c.oid,'pg_class'))::pg_catalog.text
 FROM pg_catalog.pg_class c JOIN ns n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE c.relkind OPERATOR(pg_catalog.=) ANY(ARRAY['r','p','v','m','S','f']::pg_catalog."char"[])
 UNION ALL SELECT 'column',n.nspname,a.attname,ARRAY[c.relname],pg_catalog.pg_get_expr(d.adbin,d.adrelid),
   pg_catalog.jsonb_build_object('ordinal',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
     'identity',a.attidentity,'generated',a.attgenerated,'aclStored',a.attacl IS NOT NULL,
     'description',pg_catalog.col_description(a.attrelid,a.attnum))::pg_catalog.text
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) a.attrelid JOIN ns n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
 LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid OPERATOR(pg_catalog.=) a.attrelid AND d.adnum OPERATOR(pg_catalog.=) a.attnum
 WHERE a.attnum OPERATOR(pg_catalog.>) 0 AND NOT a.attisdropped AND c.relkind OPERATOR(pg_catalog.=) ANY(ARRAY['r','p','v','m','f']::pg_catalog."char"[])
 UNION ALL SELECT 'index',n.nspname,i.relname,ARRAY[t.relname],pg_catalog.pg_get_indexdef(i.oid),
   pg_catalog.jsonb_build_object('valid',x.indisvalid,'unique',x.indisunique,'primary',x.indisprimary,
     'description',pg_catalog.obj_description(i.oid,'pg_class'))::pg_catalog.text
 FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid OPERATOR(pg_catalog.=) x.indexrelid JOIN pg_catalog.pg_class t ON t.oid OPERATOR(pg_catalog.=) x.indrelid JOIN ns n ON n.oid OPERATOR(pg_catalog.=) i.relnamespace
 UNION ALL SELECT 'constraint',n.nspname,k.conname,ARRAY[c.relname],pg_catalog.pg_get_constraintdef(k.oid,true),
   pg_catalog.jsonb_build_object('type',k.contype,'validated',k.convalidated,'deferrable',k.condeferrable,
     'deferred',k.condeferred,'description',pg_catalog.obj_description(k.oid,'pg_constraint'))::pg_catalog.text
 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) k.conrelid JOIN ns n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
 UNION ALL SELECT 'trigger',n.nspname,t.tgname,ARRAY[c.relname],pg_catalog.pg_get_triggerdef(t.oid,true),
   pg_catalog.jsonb_build_object('enabled',t.tgenabled,'function',t.tgfoid::pg_catalog.regprocedure::pg_catalog.text,
     'description',pg_catalog.obj_description(t.oid,'pg_trigger'))::pg_catalog.text
 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) t.tgrelid JOIN ns n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE NOT t.tgisinternal
 UNION ALL SELECT 'policy',n.nspname,p.polname,ARRAY[c.relname],pg_catalog.concat_ws('|',p.polcmd,pg_catalog.pg_get_expr(p.polqual,p.polrelid),pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)),
   pg_catalog.jsonb_build_object('permissive',p.polpermissive,'roles',ARRAY(SELECT principal FROM (SELECT CASE WHEN policy_role.role_oid OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE policy_role_name.rolname END principal FROM pg_catalog.unnest(p.polroles) policy_role(role_oid) LEFT JOIN pg_catalog.pg_roles policy_role_name ON policy_role_name.oid OPERATOR(pg_catalog.=) policy_role.role_oid) normalized_policy_roles ORDER BY principal COLLATE pg_catalog."C"),'description',pg_catalog.obj_description(p.oid,'pg_policy'))::pg_catalog.text
 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) p.polrelid JOIN ns n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
 UNION ALL SELECT 'type',n.nspname,t.typname,ARRAY[]::pg_catalog.text[],CASE WHEN t.typtype OPERATOR(pg_catalog.=) 'c' THEN (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'collation',CASE WHEN a.attcollation OPERATOR(pg_catalog.=) 0 THEN NULL ELSE a.attcollation::pg_catalog.regcollation::pg_catalog.text END) ORDER BY a.attnum)::pg_catalog.text FROM pg_catalog.pg_attribute a WHERE a.attrelid OPERATOR(pg_catalog.=) t.typrelid AND a.attnum OPERATOR(pg_catalog.>) 0 AND NOT a.attisdropped) ELSE pg_catalog.pg_get_expr(t.typdefaultbin,0) END,
   pg_catalog.jsonb_build_object('kind',t.typtype,'category',t.typcategory,'notNull',t.typnotnull,'base',t.typbasetype::pg_catalog.regtype::pg_catalog.text,'owner',pg_catalog.pg_get_userbyid(t.typowner),'input',t.typinput::pg_catalog.regprocedure::pg_catalog.text,'output',t.typoutput::pg_catalog.regprocedure::pg_catalog.text,'receive',t.typreceive::pg_catalog.regprocedure::pg_catalog.text,'send',t.typsend::pg_catalog.regprocedure::pg_catalog.text,'typmodIn',t.typmodin::pg_catalog.regprocedure::pg_catalog.text,'typmodOut',t.typmodout::pg_catalog.regprocedure::pg_catalog.text,'analyze',t.typanalyze::pg_catalog.regprocedure::pg_catalog.text,'subscript',t.typsubscript::pg_catalog.regprocedure::pg_catalog.text,'collation',CASE WHEN t.typcollation OPERATOR(pg_catalog.=) 0 THEN NULL ELSE t.typcollation::pg_catalog.regcollation::pg_catalog.text END,'element',t.typelem::pg_catalog.regtype::pg_catalog.text,'array',t.typarray::pg_catalog.regtype::pg_catalog.text,'aclStored',t.typacl IS NOT NULL,'description',pg_catalog.obj_description(t.oid,'pg_type'))::pg_catalog.text
 FROM pg_catalog.pg_type t JOIN ns n ON n.oid OPERATOR(pg_catalog.=) t.typnamespace WHERE ${USER_TYPE_SELECTION_SQL}
 UNION ALL SELECT 'extension',NULL::pg_catalog.text,e.extname,ARRAY[]::pg_catalog.text[],NULL::pg_catalog.text,
   pg_catalog.jsonb_build_object('version',e.extversion,'schema',n.nspname,'owner',pg_catalog.pg_get_userbyid(e.extowner),
     'description',pg_catalog.obj_description(e.oid,'pg_extension'))::pg_catalog.text
 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) e.extnamespace
 UNION ALL SELECT 'role',NULL::pg_catalog.text,r.rolname,ARRAY[]::pg_catalog.text[],NULL::pg_catalog.text,
   pg_catalog.jsonb_build_object('login',r.rolcanlogin,'inherit',r.rolinherit,'superuser',r.rolsuper,
     'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,'replication',r.rolreplication,
     'bypassRls',r.rolbypassrls,'connectionLimit',r.rolconnlimit,'validUntil',CASE WHEN r.rolvaliduntil IS NULL THEN NULL WHEN r.rolvaliduntil OPERATOR(pg_catalog.=) 'infinity'::pg_catalog.timestamptz THEN 'infinity' ELSE pg_catalog.to_char(pg_catalog.timezone('UTC',r.rolvaliduntil),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,'description',pg_catalog.shobj_description(r.oid,'pg_authid'))::pg_catalog.text
 FROM pg_catalog.pg_roles r
), acl_sources AS (
 SELECT 'schema'::pg_catalog.text target_class,pg_catalog.jsonb_build_object('kind','schema','schema',NULL,'name',n.nspname,'arguments','[]'::pg_catalog.jsonb) target,NULL::pg_catalog.text target_schema,n.nspname target_name,ARRAY[]::pg_catalog.text[] target_arguments,n.nspowner owner_oid,n.nspacl acl,'n'::pg_catalog."char" default_code FROM pg_catalog.pg_namespace n JOIN ns ON ns.oid OPERATOR(pg_catalog.=) n.oid
 UNION ALL SELECT 'routine',pg_catalog.jsonb_build_object('kind','function','schema',n.nspname,'name',p.proname,'arguments',pg_catalog.to_jsonb(${ROUTINE_IDENTITY_ARGUMENTS_SQL})),n.nspname,p.proname,${ROUTINE_IDENTITY_ARGUMENTS_SQL},p.proowner,p.proacl,'f'::pg_catalog."char" FROM pg_catalog.pg_proc p JOIN ns n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace
 UNION ALL SELECT CASE WHEN c.relkind OPERATOR(pg_catalog.=) 'S' THEN 'sequence' ELSE 'relation' END,pg_catalog.jsonb_build_object('kind','relation','schema',n.nspname,'name',c.relname,'arguments','[]'::pg_catalog.jsonb),n.nspname,c.relname,ARRAY[]::pg_catalog.text[],c.relowner,c.relacl,CASE WHEN c.relkind OPERATOR(pg_catalog.=) 'S' THEN 's'::pg_catalog."char" ELSE 'r'::pg_catalog."char" END FROM pg_catalog.pg_class c JOIN ns n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE c.relkind OPERATOR(pg_catalog.=) ANY(ARRAY['r','p','v','m','S','f']::pg_catalog."char"[])
 UNION ALL SELECT 'column',pg_catalog.jsonb_build_object('kind','column','schema',n.nspname,'name',a.attname,'arguments',pg_catalog.jsonb_build_array(c.relname)),n.nspname,a.attname,ARRAY[c.relname],c.relowner,a.attacl,NULL::pg_catalog."char" FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) a.attrelid JOIN ns n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE a.attnum OPERATOR(pg_catalog.>) 0 AND NOT a.attisdropped AND c.relkind OPERATOR(pg_catalog.=) ANY(ARRAY['r','p','v','m','f']::pg_catalog."char"[]) AND a.attacl IS NOT NULL
 UNION ALL SELECT 'type',pg_catalog.jsonb_build_object('kind','type','schema',n.nspname,'name',t.typname,'arguments','[]'::pg_catalog.jsonb),n.nspname,t.typname,ARRAY[]::pg_catalog.text[],t.typowner,t.typacl,'T'::pg_catalog."char" FROM pg_catalog.pg_type t JOIN ns n ON n.oid OPERATOR(pg_catalog.=) t.typnamespace WHERE ${USER_TYPE_SELECTION_SQL}
), acl_rows AS (
 SELECT 'acl-grant'::pg_catalog.text kind,s.target_schema schema,s.target_name name,ARRAY[s.target_class] OPERATOR(pg_catalog.||) s.target_arguments OPERATOR(pg_catalog.||) ARRAY[CASE WHEN x.grantor OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE grantor.rolname END,CASE WHEN x.grantee OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE grantee.rolname END,pg_catalog.lower(x.privilege_type),x.is_grantable::pg_catalog.text,CASE WHEN s.acl IS NULL THEN 'built-in-default' ELSE 'stored' END] arguments,NULL::pg_catalog.text definition,pg_catalog.jsonb_build_object('targetClass',s.target_class,'targetIdentity',s.target,'grantor',CASE WHEN x.grantor OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE grantor.rolname END,'grantee',CASE WHEN x.grantee OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE grantee.rolname END,'privilege',pg_catalog.lower(x.privilege_type),'isGrantable',x.is_grantable,'aclOrigin',CASE WHEN s.acl IS NULL THEN 'built-in-default' ELSE 'stored' END)::pg_catalog.text attributes
 FROM acl_sources s CROSS JOIN LATERAL pg_catalog.aclexplode(CASE WHEN s.acl IS NULL THEN pg_catalog.acldefault(s.default_code,s.owner_oid) ELSE s.acl END) x LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid OPERATOR(pg_catalog.=) x.grantor LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid OPERATOR(pg_catalog.=) x.grantee WHERE s.acl IS NOT NULL OR x.grantee OPERATOR(pg_catalog.<>) s.owner_oid
), default_rows AS (
 SELECT 'default-privilege'::pg_catalog.text kind,n.nspname schema,owner_role.rolname name,ARRAY[CASE WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'n' THEN 'schema' WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'f' THEN 'routine' WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'r' THEN 'relation' WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'S' THEN 'sequence' WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'T' THEN 'type' END,CASE WHEN x.grantor OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE grantor.rolname END,CASE WHEN x.grantee OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE grantee.rolname END,pg_catalog.lower(x.privilege_type),x.is_grantable::pg_catalog.text] arguments,NULL::pg_catalog.text definition,pg_catalog.jsonb_build_object('ownerRole',owner_role.rolname,'schema',n.nspname,'objectClass',CASE WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'n' THEN 'schema' WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'f' THEN 'routine' WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'r' THEN 'relation' WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'S' THEN 'sequence' WHEN d.defaclobjtype OPERATOR(pg_catalog.=) 'T' THEN 'type' END,'grantor',CASE WHEN x.grantor OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE grantor.rolname END,'grantee',CASE WHEN x.grantee OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE grantee.rolname END,'privilege',pg_catalog.lower(x.privilege_type),'isGrantable',x.is_grantable)::pg_catalog.text attributes
 FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles owner_role ON owner_role.oid OPERATOR(pg_catalog.=) d.defaclrole LEFT JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) d.defaclnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) x LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid OPERATOR(pg_catalog.=) x.grantor LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid OPERATOR(pg_catalog.=) x.grantee WHERE d.defaclnamespace OPERATOR(pg_catalog.=) 0 OR n.oid OPERATOR(pg_catalog.=) ANY (SELECT oid FROM ns)
), membership_rows AS (
 SELECT 'role-membership'::pg_catalog.text kind,NULL::pg_catalog.text schema,granted.rolname name,ARRAY[member.rolname,grantor.rolname,m.admin_option::pg_catalog.text,COALESCE((pg_catalog.to_jsonb(m) OPERATOR(pg_catalog.->>) 'inherit_option')::pg_catalog.bool,true)::pg_catalog.text,COALESCE((pg_catalog.to_jsonb(m) OPERATOR(pg_catalog.->>) 'set_option')::pg_catalog.bool,true)::pg_catalog.text] arguments,NULL::pg_catalog.text definition,pg_catalog.jsonb_build_object('grantedRole',granted.rolname,'memberRole',member.rolname,'grantorRole',grantor.rolname,'adminOption',m.admin_option,'inheritOption',COALESCE((pg_catalog.to_jsonb(m) OPERATOR(pg_catalog.->>) 'inherit_option')::pg_catalog.bool,true),'setOption',COALESCE((pg_catalog.to_jsonb(m) OPERATOR(pg_catalog.->>) 'set_option')::pg_catalog.bool,true))::pg_catalog.text attributes
 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles granted ON granted.oid OPERATOR(pg_catalog.=) m.roleid JOIN pg_catalog.pg_roles member ON member.oid OPERATOR(pg_catalog.=) m.member JOIN pg_catalog.pg_roles grantor ON grantor.oid OPERATOR(pg_catalog.=) m.grantor
) SELECT kind,schema,name,arguments,definition,attributes FROM (SELECT * FROM objects UNION ALL SELECT * FROM acl_rows UNION ALL SELECT * FROM default_rows UNION ALL SELECT * FROM membership_rows) catalog ORDER BY kind,schema NULLS FIRST,name,arguments`;
const CATALOG_QUERY_NAME = "oss-phase2-selected-catalog-v2";
const sha = (value: string): Sha256 => createHash("sha256").update(value).digest("hex") as Sha256;
function freezeDeep<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) freezeDeep(item); Object.freeze(value); } return value; }
type UnknownRecord = Record<string | symbol, unknown>;
const projectionProducts = new WeakSet<object>();
const record = (value: unknown): UnknownRecord | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return true; if (!Object.isFrozen(value)) return false; seen.add(value);
  return Reflect.ownKeys(value).every((key) => deeplyFrozen((value as UnknownRecord)[key], seen));
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compareCodeUnits(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const identityKey = (identity: ObjectIdentity): string => stable([identity.kind, identity.schema, identity.name, identity.arguments]);
const identityOrder = (a: ObjectIdentity, b: ObjectIdentity): number => compareCodeUnits(identityKey(a), identityKey(b));
const sameIdentity = (left: ObjectIdentity, right: ObjectIdentity): boolean => identityKey(left) === identityKey(right);
const isSha = (value: unknown): value is Sha256 => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function identityFrom(value: unknown): ObjectIdentity | null {
  const item = record(value);
  if (!item || typeof item.kind !== "string" || !(item.schema === null || typeof item.schema === "string")
    || typeof item.name !== "string" || !Array.isArray(item.arguments)
    || !item.arguments.every((argument) => typeof argument === "string")) return null;
  return { kind: item.kind as CatalogKind, schema: item.schema as string | null, name: item.name,
    arguments: [...item.arguments] as string[] };
}
function attributesFrom(row: CatalogRow): UnknownRecord {
  const parsed = JSON.parse(row.attributes) as unknown, attributes = record(parsed);
  if (!attributes) throw new TypeError("catalog attributes are not an object");
  return attributes;
}
const booleanField = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") throw new TypeError(`catalog ${field} is not boolean`); return value;
};
const stringField = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`catalog ${field} is not text`); return value;
};
function projectionDetails(rows: readonly CatalogRow[]) {
  const aclGrants: AclGrant[] = [], defaultPrivileges: DefaultPrivilege[] = [], roleMemberships: RoleMembership[] = [];
  const roles: RoleRecord[] = [], ownerships: ObjectOwnership[] = [];
  for (const row of rows) {
    const identity: ObjectIdentity = { kind: row.kind, schema: row.schema, name: row.name, arguments: [...row.arguments] };
    const attributes = attributesFrom(row);
    if (row.kind === "acl-grant") {
      const targetIdentity = identityFrom(attributes.targetIdentity), targetClass = attributes.targetClass;
      if (!targetIdentity || !["schema", "routine", "relation", "sequence", "column", "type"].includes(String(targetClass)))
        throw new TypeError("catalog ACL target is invalid");
      const aclOrigin = attributes.aclOrigin;
      if (aclOrigin !== "stored" && aclOrigin !== "built-in-default") throw new TypeError("catalog ACL origin is invalid");
      const grantor = stringField(attributes.grantor, "ACL grantor"), grantee = stringField(attributes.grantee, "ACL grantee"),
        privilege = stringField(attributes.privilege, "ACL privilege"), isGrantable = booleanField(attributes.isGrantable, "ACL grant option");
      const targetKind = { schema: "schema", routine: "function", relation: "relation", sequence: "relation",
        column: "column", type: "type" }[targetClass as AclTargetClass];
      const expected: ObjectIdentity = { kind: "acl-grant", schema: targetIdentity.schema, name: targetIdentity.name,
        arguments: [String(targetClass), ...targetIdentity.arguments, grantor, grantee, privilege, String(isGrantable), aclOrigin] };
      if (targetIdentity.kind !== targetKind || !sameIdentity(identity, expected)) throw new TypeError("catalog ACL identity is inconsistent");
      aclGrants.push({ identity, targetClass: targetClass as AclTargetClass, targetIdentity,
        grantor, grantee, privilege, isGrantable, aclOrigin });
    } else if (row.kind === "default-privilege") {
      const objectClass = attributes.objectClass;
      if (!["schema", "routine", "relation", "sequence", "type"].includes(String(objectClass))
        || !(attributes.schema === null || typeof attributes.schema === "string")) throw new TypeError("default privilege target is invalid");
      const ownerRole = stringField(attributes.ownerRole, "default privilege owner"),
        grantor = stringField(attributes.grantor, "default privilege grantor"),
        grantee = stringField(attributes.grantee, "default privilege grantee"),
        privilege = stringField(attributes.privilege, "default privilege"),
        isGrantable = booleanField(attributes.isGrantable, "default privilege grant option"), schema = attributes.schema as string | null;
      const expected: ObjectIdentity = { kind: "default-privilege", schema, name: ownerRole,
        arguments: [String(objectClass), grantor, grantee, privilege, String(isGrantable)] };
      if (!sameIdentity(identity, expected)) throw new TypeError("default privilege identity is inconsistent");
      defaultPrivileges.push({ identity, ownerRole,
        schema, objectClass: objectClass as DefaultPrivilege["objectClass"], grantor, grantee, privilege, isGrantable });
    } else if (row.kind === "role-membership") {
      const grantedRole = stringField(attributes.grantedRole, "granted role"), memberRole = stringField(attributes.memberRole, "member role"),
        grantorRole = stringField(attributes.grantorRole, "membership grantor"), adminOption = booleanField(attributes.adminOption, "admin option"),
        inheritOption = booleanField(attributes.inheritOption, "inherit option"), setOption = booleanField(attributes.setOption, "set option");
      const expected: ObjectIdentity = { kind: "role-membership", schema: null, name: grantedRole,
        arguments: [memberRole, grantorRole, String(adminOption), String(inheritOption), String(setOption)] };
      if (!sameIdentity(identity, expected)) throw new TypeError("role membership identity is inconsistent");
      roleMemberships.push({ identity, grantedRole, memberRole, grantorRole, adminOption, inheritOption, setOption });
    } else {
      if (typeof attributes.owner === "string" && attributes.owner.length) ownerships.push({ object: identity, ownerRole: attributes.owner });
      if (row.kind === "role") {
        if (identity.schema !== null || identity.arguments.length) throw new TypeError("role identity is invalid");
        if (!(attributes.validUntil === null || typeof attributes.validUntil === "string")
          || !Number.isInteger(attributes.connectionLimit)) throw new TypeError("role access attributes are invalid");
        roles.push({ identity, canLogin: booleanField(attributes.login, "role login"),
          inherits: booleanField(attributes.inherit, "role inherit"), superuser: booleanField(attributes.superuser, "role superuser"),
          createRole: booleanField(attributes.createRole, "role create-role"), createDb: booleanField(attributes.createDb, "role create-db"),
          replication: booleanField(attributes.replication, "role replication"), bypassRls: booleanField(attributes.bypassRls, "role bypass-RLS"),
          connectionLimit: attributes.connectionLimit as number, validUntil: attributes.validUntil as string | null });
      }
    }
  }
  const order = <T>(items: T[]): T[] => items.sort((left, right) => compareCodeUnits(stable(left), stable(right)));
  return { aclGrants: order(aclGrants), defaultPrivileges: order(defaultPrivileges), roleMemberships: order(roleMemberships),
    roles: order(roles), ownerships: order(ownerships) };
}
function projectionFromRows(rows: readonly CatalogRow[]): ValidatedProjection {
  const objects = rows.map((row) => ({ identity: { kind: row.kind, schema: row.schema, name: row.name, arguments: [...row.arguments] }, definitionDigest: row.definition === null ? null : sha(row.definition), attributesDigest: sha(row.attributes) })).sort((a, b) => identityOrder(a.identity, b.identity));
  if (new Set(objects.map((item) => identityKey(item.identity))).size !== objects.length) throw new Error("duplicate catalog identity");
  const details = projectionDetails(rows), payload = { objects, ...details };
  const projection = { ...payload, digest: sha(stable(payload)) } as UnknownRecord;
  Object.defineProperty(projection, validatedProjection, { value: "selected-catalog-v2" });
  const product = freezeDeep(projection) as ValidatedProjection; projectionProducts.add(product); if (!isSelectedCatalogProjection(product)) { projectionProducts.delete(product); throw new Error("invalid selected catalog projection"); } return product;
}

/** Reads the canonical selected-catalog-v2 projection of a live database. */
export async function readSelectedCatalogProjection(client: ClientBase): Promise<ValidatedProjection> {
  const result = await client.query<CatalogRow>({ name: CATALOG_QUERY_NAME, text: CATALOG_SQL });
  return projectionFromRows(result.rows);
}
function isSelectedCatalogProjection(value: unknown): value is ValidatedProjection {
  const item = record(value); if (!item || !projectionProducts.has(item) || item[validatedProjection] !== "selected-catalog-v2"
    || !deeplyFrozen(item) || !Array.isArray(item.objects) || !Array.isArray(item.aclGrants)
    || !Array.isArray(item.defaultPrivileges) || !Array.isArray(item.roleMemberships) || !Array.isArray(item.roles)
    || !Array.isArray(item.ownerships) || !isSha(item.digest)) return false;
  const kinds = new Set<CatalogKind>(["function", "relation", "column", "index", "constraint", "trigger", "policy",
    "acl-grant", "default-privilege", "role-membership", "type", "schema", "extension", "role"]), keys: string[] = [];
  for (const raw of item.objects) {
    const object = record(raw), identity = identityFrom(object?.identity);
    if (!object || !identity || !kinds.has(identity.kind) || !(object.definitionDigest === null || isSha(object.definitionDigest))
      || !isSha(object.attributesDigest)) return false; keys.push(identityKey(identity));
  }
  if (new Set(keys).size !== keys.length || !keys.every((key, index) => index === 0 || compareCodeUnits(keys[index - 1], key) < 0)) return false;
  const known = new Set(keys), roleNames = new Set((item.roles as RoleRecord[]).map((role) => role.identity.name));
  const principal = (name: string): boolean => name === "PUBLIC" || roleNames.has(name);
  if ((item.aclGrants as AclGrant[]).some((grant) => !known.has(identityKey(grant.identity))
      || !known.has(identityKey(grant.targetIdentity)) || !principal(grant.grantor) || !principal(grant.grantee))) return false;
  if ((item.defaultPrivileges as DefaultPrivilege[]).some((grant) => !known.has(identityKey(grant.identity))
      || !roleNames.has(grant.ownerRole) || !principal(grant.grantor) || !principal(grant.grantee))) return false;
  if ((item.roleMemberships as RoleMembership[]).some((membership) => !known.has(identityKey(membership.identity))
      || !roleNames.has(membership.grantedRole) || !roleNames.has(membership.memberRole) || !roleNames.has(membership.grantorRole))) return false;
  if ((item.ownerships as ObjectOwnership[]).some((ownership) => !known.has(identityKey(ownership.object))
      || !roleNames.has(ownership.ownerRole))) return false;
  const payload = { objects: item.objects, aclGrants: item.aclGrants, defaultPrivileges: item.defaultPrivileges,
    roleMemberships: item.roleMemberships, roles: item.roles, ownerships: item.ownerships };
  return item.digest === sha(stable(payload));
}
export function selectedCatalogProjectionPayload(value: ValidatedProjection): string {
  if (!isSelectedCatalogProjection(value)) throw new TypeError("selected catalog projection is not validated");
  return stable({ objects: value.objects, aclGrants: value.aclGrants,
    defaultPrivileges: value.defaultPrivileges, roleMemberships: value.roleMemberships,
    roles: value.roles, ownerships: value.ownerships });
}

/** Qualified installation retains these raw fields until declared principals are validated. */
export async function readSelectedCatalogRowsForQualifiedInstall(client: ClientBase): Promise<readonly CatalogRow[]> {
  const result = await client.query<CatalogRow>({ name: "openlup-qualified-catalog-rows-v1", text: CATALOG_SQL });
  return result.rows;
}

/** Reuse the existing row consistency checks after the qualified field-only transformation. */
export function selectedCatalogRowsPayloadForQualifiedInstall(rows: readonly CatalogRow[]): string {
  return selectedCatalogProjectionPayload(projectionFromRows(rows));
}
