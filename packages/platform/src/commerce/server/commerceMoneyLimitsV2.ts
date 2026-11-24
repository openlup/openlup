import { z } from "zod";

/** @experimental Host query interface for installed payment limits. */
export interface CommerceMoneyLimitsQueryExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** @experimental Coordinates of one installed payment rail. */
export interface LimitsTuple {
  installationRef: string;
  channelKey: string;
  methodKey: string;
  providerKey: string;
  accountRef: string;
  mode: string;
  currency: string;
}

/** @experimental Installation-owned terms in currency minor units. */
export interface CommerceMoneyLimitsV2 extends LimitsTuple {
  schemaVersion: 2;
  profileRef: string;
  minMinor: number;
  maxMinor: number;
  active: boolean;
}

/** @experimental Use null for the initial insert or the inspected revision to update. */
export interface InstallLimitsInput { value: CommerceMoneyLimitsV2; expectedRevision: number | null }

const invalid = "money_limits_invalid_input";
const conflict = "money_limits_revision_conflict";
const exhausted = "money_limits_revision_exhausted";
const unavailable = "money_limits_operation_unavailable";
const remedies = {
  [invalid]: "Correct the indicated field using the documented payment limits input.",
  [conflict]: "Inspect the tuple with the owner binding. Retry the initial insert if absent, or deliberately resubmit the intended change with the observed revision.",
  [exhausted]: "Have the installation owner qualify a replacement rail.",
} as const;
const checklist = "Check the native app binding, driver setup, database connection and TLS, operation-role privileges, and installed migrations. Then retry the same operation.";
type InstallLimitsRefusal = {
  kind: "refused";
  code: keyof typeof remedies;
  field: string;
  remedy: (typeof remedies)[keyof typeof remedies];
};
const refused = (code: InstallLimitsRefusal["code"], field: string): InstallLimitsRefusal =>
  ({ kind: "refused", code, field, remedy: remedies[code] });

/** @experimental An installed revision or a refusal without a repair value. */
export type InstallLimitsResult = { kind: "installed"; value: CommerceMoneyLimitsV2; revision: number }
  | InstallLimitsRefusal;

/** @experimental Runtime observation of active terms for the bound rail. */
export type LimitsReadResult = { present: false }
  | { present: true; value: CommerceMoneyLimitsV2 & { active: true }; revision: number };

/** @experimental Owner observation, including inactive terms and their revision. */
export type LimitsInspectionResult = { present: false; active: null; revision: null; value: null }
  | { present: true; active: boolean; revision: number; value: CommerceMoneyLimitsV2 };

const maxRevision = 2_147_483_647;
const revisionSchema = z.int().min(1).max(maxRevision);
const ref = z.string().min(1).regex(/^[^\uD800-\uDFFF]+$/u)
  .refine(text => !text.includes("\u0000") && Buffer.byteLength(text, "utf8") <= 200)
  .describe("Opaque reference of 1 to 200 UTF-8 bytes.");
const tuple = {
  installationRef: ref, channelKey: ref, methodKey: ref, providerKey: ref, accountRef: ref,
  mode: z.enum(["test", "live"]), currency: z.string().length(3).regex(/^[A-Z]{3}$/u),
};
const scopeSchema = z.strictObject(tuple);
const minor = z.int().min(0);
const valueSchema = z.strictObject({
  schemaVersion: z.literal(2), ...tuple, profileRef: ref,
  minMinor: minor, maxMinor: minor.min(1), active: z.boolean(),
}).refine(value => value.minMinor <= value.maxMinor, { path: ["maxMinor"] });
// The five 200-byte references, four ASCII mode bytes and three currency bytes total at most 1,007.
function plain(input: unknown): unknown {
  if (input === null || typeof input !== "object") return undefined;
  const prototype: unknown = Object.getPrototypeOf(input);
  return prototype === null || prototype === Object.prototype ? input : undefined;
}
const installSchema = z.preprocess(plain, z.strictObject({
  value: z.preprocess(plain, valueSchema), expectedRevision: revisionSchema.nullable(),
}));
const fieldOf = (error: z.ZodError) => "/" + (error.issues[0]?.path ?? []).join("/");
function scopeSnapshot(scope: LimitsTuple) {
  const parsed = scopeSchema.safeParse(plain(scope));
  if (!parsed.success) throw Object.assign(new Error(invalid), { code: invalid, field: fieldOf(parsed.error), remedy: remedies[invalid] });
  const { installationRef, channelKey, methodKey, providerKey, accountRef, mode, currency } = parsed.data;
  return [installationRef, channelKey, methodKey, providerKey, accountRef, mode, currency];
}
function failure(cause: unknown, field: string) {
  return Object.assign(new Error(unavailable, { cause }), { code: unavailable, field, remedy: checklist });
}

const relation = "public.commerce_money_limits_v2";
const keys = "installation_ref,channel_key,method_key,provider_key,account_ref,mode,currency";
const identity = "(l.installation_ref,l.channel_key,l.method_key,l.provider_key,l.account_ref,l.mode,l.currency)";
const matches = `${identity}=(p.installation_ref,p.channel_key,p.method_key,p.provider_key,p.account_ref,p.mode,p.currency)`;
const scopeParameters = "$1,$2,$3,$4,$5,$6,$7";
const document = `pg_catalog.jsonb_build_object(
  'schemaVersion',2,'installationRef',l.installation_ref,'channelKey',l.channel_key,
  'methodKey',l.method_key,'providerKey',l.provider_key,'accountRef',l.account_ref,
  'mode',l.mode,'currency',l.currency,'profileRef',l.profile_ref,
  'minMinor',l.min_minor,'maxMinor',l.max_minor,'active',l.active)`;
const cas = `WITH input AS MATERIALIZED (
  SELECT public.commerce_money_limits_v2_validate($1::jsonb) AS value
  WHERE pg_catalog.current_setting('transaction_isolation')='read committed'
), proposal AS MATERIALIZED (
  SELECT value->>'installationRef' AS installation_ref,value->>'channelKey' AS channel_key,
    value->>'methodKey' AS method_key,value->>'providerKey' AS provider_key,value->>'accountRef' AS account_ref,
    value->>'mode' AS mode,value->>'currency' AS currency,value->>'profileRef' AS profile_ref,
    (value->>'minMinor')::bigint AS min_minor,(value->>'maxMinor')::bigint AS max_minor,
    (value->>'active')::boolean AS active FROM input
), locked AS MATERIALIZED (
  SELECT l.revision,l.profile_ref FROM ${relation} l,proposal p
  WHERE $2::integer IS NOT NULL AND ${matches} FOR UPDATE OF l
), inserted AS (
  INSERT INTO ${relation} (${keys},profile_ref,revision,min_minor,max_minor,active)
  SELECT ${keys},profile_ref,1,min_minor,max_minor,active FROM proposal WHERE $2::integer IS NULL
  ON CONFLICT (${keys}) DO NOTHING RETURNING revision
), updated AS (
  UPDATE ${relation} l SET revision=l.revision+1,min_minor=p.min_minor,max_minor=p.max_minor,active=p.active
  FROM proposal p,locked WHERE ${matches} AND locked.revision=$2::integer
    AND locked.revision<${maxRevision} AND locked.profile_ref=p.profile_ref
  RETURNING l.revision
)
SELECT coalesce((SELECT revision FROM inserted),(SELECT revision FROM updated)) AS revision,
  CASE WHEN EXISTS (SELECT FROM inserted) OR EXISTS (SELECT FROM updated) THEN NULL
    WHEN NOT EXISTS (SELECT FROM input) THEN 'isolation'
    WHEN $2::integer IS NULL OR (SELECT revision FROM locked) IS DISTINCT FROM $2::integer THEN 'conflict'
    WHEN (SELECT revision FROM locked)=${maxRevision} THEN 'exhausted'
    ELSE 'profile' END AS outcome`;

/** @experimental Install one set of payment limits with the migration-owner executor. */
export async function installCommerceMoneyLimitsV2(owner: CommerceMoneyLimitsQueryExecutor, input: InstallLimitsInput): Promise<InstallLimitsResult> {
  const parsed = installSchema.safeParse(input);
  if (!parsed.success) return refused(invalid, fieldOf(parsed.error));
  const { value, expectedRevision } = parsed.data;
  try {
    const row = (await owner.query(cas, [JSON.stringify(value), expectedRevision])).rows[0];
    if (row?.outcome === null) {
      const revision = typeof row.revision === "string" && /^[1-9][0-9]{0,9}$/u.test(row.revision)
        ? Number(row.revision) : row.revision;
      return { kind: "installed", value, revision: revisionSchema.parse(revision) };
    }
    if (row?.outcome === "conflict") return refused(conflict, "/expectedRevision");
    if (row?.outcome === "exhausted") return refused(exhausted, "/expectedRevision");
    if (row?.outcome === "profile") return refused(invalid, "/value/profileRef");
    throw new Error(row?.outcome === "isolation" ? "Payment limits installation requires READ COMMITTED." : "Missing installation result.");
  } catch (cause) { throw failure(cause, "/installation"); }
}

/** @experimental Inspect the active or inactive revision using the migration owner. */
export async function inspectCommerceMoneyLimitsV2(owner: CommerceMoneyLimitsQueryExecutor, scope: LimitsTuple): Promise<LimitsInspectionResult> {
  const parameters = scopeSnapshot(scope);
  try {
    const { rows } = await owner.query(`SELECT l.revision,public.commerce_money_limits_v2_validate(${document}) AS value
      FROM ${relation} l WHERE ${identity}=(${scopeParameters})`, parameters);
    if (!rows.length) return { present: false, active: null, revision: null, value: null };
    const value = valueSchema.parse(rows[0]!.value);
    return { present: true, active: value.active, revision: revisionSchema.parse(rows[0]!.revision), value };
  } catch (cause) { throw failure(cause, "/inspection"); }
}

/** @experimental Bind a restricted reader to the intended installation and rail. */
export function bindCommerceMoneyLimitsV2Reader(db: CommerceMoneyLimitsQueryExecutor, scope: LimitsTuple): () => Promise<LimitsReadResult> {
  const parameters = scopeSnapshot(scope);
  return async () => {
    try {
      const { rows } = await db.query(`SELECT l.revision,${document} AS value
        FROM public.commerce_money_limits_read_v2(${scopeParameters}) l`, parameters);
      if (!rows.length) return { present: false };
      const value = valueSchema.parse(rows[0]!.value);
      if (!value.active) throw new Error("The payment limits reader returned an inactive revision.");
      return { present: true, revision: revisionSchema.parse(rows[0]!.revision), value: { ...value, active: true } };
    } catch (cause) { throw failure(cause, "/read"); }
  };
}

const example = {
  schemaVersion: 2, installationRef: "store-a", channelKey: "online", methodKey: "card",
  providerKey: "processor-a", accountRef: "merchant-a", mode: "test", currency: "EUR",
  profileRef: "standard", minMinor: 1, maxMinor: 10000, active: true,
} as const;

/** @experimental Describe the installed limits for settings discovery. */
export function describeCommerceMoneyLimitsV2Setting() {
  return {
    schemaVersion: 1, key: "commerce.money_limits.v2", domain: "pricing", kind: "installed",
    goal: "Install and inspect payment amount limits for a qualified rail.",
    schema: z.toJSONSchema(valueSchema) as Record<string, unknown>,
    rules: [{ code: invalid, path: [], description: remedies[invalid] }],
    examples: [{ value: example }, { value: { ...example, maxMinor: 0 }, code: invalid }],
    fallback: null, defaultBasis: { kind: "neutral" },
    whyThisDefault: "The installation owner supplies the allowed interval for an opted-in rail.",
    absentMeans: { description: "No payment limits are installed for the selected rail.", source: "Native owner inspection", value: null },
    runtime: { level: "read-only", reason: "Connected show requires a native owner inspection binding." },
    change: { reference: "OpenLup guide, Quote prices, Install and inspect payment limits" },
    effect: { appliesTo: "Fresh opted-in quotes for the selected rail", frozenOn: ["Sealed quotes retain their terms."], impact: "money" },
  } as const;
}
