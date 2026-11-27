import type { PgQueryExecutor } from "@openlup/platform/data";
import { nativePrivacyUnavailable, PrivacyRefusal, type PersonalDataContributor, type ResolvedPrivacySubject } from "@openlup/platform/identity";
import { renewalOccurrencePrivacyEvidenceSchema, type PersonalDataObligation, type PrivacySubjectRef } from "@openlup/platform/identity/contracts";
const obligations: PersonalDataObligation[] = [
  { owner: "subscriptions", resource: "subscriptions.lifecycle", disposition: "retain", reasonCode: "IDENTITY_ONLY_ERASURE", remote: false },
  ...["consent", "invoices", "orders", "marketing"].map(owner => ({ owner, resource: `${owner}.personal-data`, disposition: "retain" as const, reasonCode: "OWNER_PATH_REQUIRED", remote: true })),
];
const retention: PersonalDataObligation = {
  owner: "subscriptions", resource: "subscriptions.occurrence-evidence", disposition: "retain",
  reasonCode: "RENEWAL_OCCURRENCE_RETENTION", remote: false,
};

function vetoErasure(parents: { status: string }[]) {
  if (parents.some(row => row.status === "active")) throw new PrivacyRefusal("PRIVACY_ACTIVE_SUBSCRIPTION");
  if (parents.some(row => row.status === "paused")) throw new PrivacyRefusal("PRIVACY_RESUMABLE_SUBSCRIPTION");
  if (parents.some(row => row.status !== "cancelled")) throw new PrivacyRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE");
}

function unavailableOccurrenceScope(cause?: unknown): never {
  throw nativePrivacyUnavailable(cause, {
    observed: "Renewal occurrence evidence could not be qualified.",
    cause: "The resolved contact, parent subscriptions, receipt aliases or occurrence rows may be hidden or inconsistent.",
    fix: "Ask the installation owner to verify the catalogue and runtime pairing, carrier SELECT and policy lookup access for the helper owner and runtime role, the runtime role's row visibility, and the correlation of the retained evidence.",
    recheck: "Retry the original request after the scoped checks pass.",
  });
}

async function readOccurrences(db: PgQueryExecutor, subject: Pick<ResolvedPrivacySubject, "contactId" | "principalId">,
  lane: "export" | "erase" = "export") {
  const erase = lane === "erase";
  try {
    const pairing = (await db.query(`SELECT
      current_setting('transaction_isolation') AS isolation, p.oid IS NOT NULL AS helper, c.oid IS NOT NULL AS carrier,
      EXISTS (SELECT 1 FROM public.client_absorption_policy WHERE table_name = 'subscription_cycle_occurrences') AS registered,
      NOT row_security_active('public.platform_schema_migrations') AND EXISTS (SELECT FROM public.platform_schema_migrations
        WHERE catalog_path = 'db/platform/migrations/20261125300000_identity_privacy_required_contributors.sql') AS incumbent_catalogue,
      (to_regclass('public.subscription_cycle_generations') IS NOT NULL
        OR to_regclass('public.subscription_cycle_delivery_assignments') IS NOT NULL
        OR EXISTS (SELECT FROM public.platform_schema_migrations
          WHERE catalog_path ~ '^db/platform/migrations/[0-9]{14}_'
            AND catalog_path COLLATE "C" >= 'db/platform/migrations/20261129130001_')) AS occurrence_catalogue,
      has_column_privilege(c.oid,'client_id','SELECT') AS carrier_readable,
      has_function_privilege(p.oid,'EXECUTE') AS helper_executable,
      p.proowner = c.relowner AND p.prosecdef AND p.provolatile = 's' AND p.prorettype = 'jsonb'::regtype
        AND (NOT $1::boolean OR has_function_privilege(p.oid,'EXECUTE'))
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
        AND NOT EXISTS (SELECT FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE a.grantee <> p.proowner AND (r.rolname IS DISTINCT FROM 'service_role' OR a.is_grantable)) AS safe
      FROM (VALUES (1)) AS lane(id)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid)')
      LEFT JOIN pg_class c ON c.oid = to_regclass('public.subscription_cycle_occurrences')`, [erase])).rows[0];
    const paired = pairing?.isolation === "read committed" && pairing.safe === true && pairing.registered === true;
    if (!paired || pairing.carrier_readable !== true) {
      const parents = subject.contactId ? (await db.query(
        "SELECT id, status FROM public.subscriptions WHERE client_id = $1 ORDER BY id", [subject.contactId])).rows
        .map(row => ({ id: String(row.id), status: String(row.status) })) : [];
      if (erase) vetoErasure(parents);
      if (pairing?.isolation === "read committed" && pairing.helper === false && pairing.carrier === false
        && pairing.registered === false && pairing.occurrence_catalogue === false && pairing.incumbent_catalogue === true) {
        return { parents, occurrences: [] };
      }
      if (paired && pairing.carrier_readable === false) unavailableOccurrenceScope();
      throw new Error("renewal_occurrence_privacy_unavailable");
    }

    // Both the operation and the comparison with the owner view use these caller-visible rows.
    const { rows: [visible] } = await db.query(`WITH parents AS MATERIALIZED (
      SELECT id, status FROM public.subscriptions WHERE client_id = $1::uuid
    )
    SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status) ORDER BY id), '[]'::jsonb) FROM parents) AS parents,
      CASE WHEN NOT $3::boolean OR NOT EXISTS (SELECT FROM parents WHERE status IS DISTINCT FROM 'cancelled') THEN
        jsonb_build_object(
          'evidence', public.subscriptions__read_renewal_occurrences_for_privacy($1, $2),
          'contact', ($1::uuid IS NULL OR EXISTS (SELECT FROM public.clients WHERE id = $1)),
          'principal', ($1::uuid IS NOT NULL OR EXISTS (SELECT FROM public.platform_human_principals WHERE principal_id = $2)),
          'receipt', EXISTS (SELECT FROM public.identity_privacy_erasures WHERE client_id = $1 OR principal_id = $2),
          'count', (SELECT count(*)::text FROM public.subscription_cycle_occurrences WHERE client_id = $1)
        ) END AS proof`, [subject.contactId, subject.principalId, erase]).catch((cause: unknown) => {
      if (pairing.helper_executable === true && cause instanceof Error && "code" in cause && cause.code === "42501") {
        unavailableOccurrenceScope(cause);
      }
      throw cause;
    });
    if (!Array.isArray(visible?.parents)) unavailableOccurrenceScope();
    const parents = visible.parents as { id: string; status: string }[];
    if (erase) vetoErasure(parents);
    const proof = visible.proof as { evidence?: unknown; contact?: unknown; principal?: unknown; receipt?: unknown; count?: unknown } | null;
    const evidence = proof?.evidence as { occurrences?: unknown; hasReceipt?: unknown; parentCount?: unknown } | null;
    if (!proof || !evidence || typeof evidence !== "object" || Object.keys(evidence).length !== 3
      || typeof evidence.hasReceipt !== "boolean" || evidence.hasReceipt !== proof.receipt
      || proof.contact !== true || proof.principal !== true) unavailableOccurrenceScope();
    const parsed = renewalOccurrencePrivacyEvidenceSchema.safeParse(evidence.occurrences);
    if (!parsed.success) unavailableOccurrenceScope(parsed.error);
    const ids = new Set(parents.map(row => row.id));
    if (evidence.parentCount !== String(ids.size) || proof.count !== String(parsed.data.length)
      || parsed.data.some(row => !ids.has(row.subscriptionId))) unavailableOccurrenceScope();
    return { parents, occurrences: parsed.data };
  } catch (cause) {
    if (cause instanceof PrivacyRefusal) throw cause;
    if (cause instanceof Error && "code" in cause && cause.code === "P0001"
      && cause.message === "occurrence_privacy_scope_unavailable") unavailableOccurrenceScope(cause);
    throw nativePrivacyUnavailable(cause);
  }
}

export async function verifyMissingSubscriptionsPrivacySubject(db: PgQueryExecutor, ref: PrivacySubjectRef) {
  const contactId = ref.kind === "contact" ? ref.contactId : null;
  const principalId = ref.kind === "principal" ? ref.principalId : null;
  // An unrestricted incumbent read establishes absence even when the occurrence catalogue is unavailable.
  const { rows: [scope] } = await db.query(`WITH policies AS (
    SELECT p.polrelid, p.polpermissive, p.polqual IS NULL OR pg_get_expr(p.polqual,p.polrelid) = 'true' AS all_rows
    FROM pg_policy p WHERE p.polcmd IN ('*','r') AND EXISTS (
      SELECT FROM unnest(p.polroles) role(oid)
      WHERE CASE WHEN role.oid = 0 THEN true ELSE pg_has_role(role.oid,'USAGE') END)
  ), relations(oid) AS (
    SELECT 'public.clients'::regclass
    UNION ALL SELECT 'public.identity_privacy_erasures'::regclass WHERE $2::uuid IS NOT NULL
    UNION ALL SELECT 'public.platform_human_principals'::regclass WHERE $2::uuid IS NOT NULL
  )
  SELECT NOT EXISTS (SELECT FROM relations r WHERE row_security_active(r.oid) AND (
      NOT EXISTS (SELECT FROM policies p WHERE p.polrelid=r.oid AND p.polpermissive AND p.all_rows)
      OR EXISTS (SELECT FROM policies p WHERE p.polrelid=r.oid AND NOT p.polpermissive AND NOT p.all_rows)))
    AND NOT EXISTS (SELECT FROM public.clients WHERE id = $1 OR principal_id = $2)
    AND NOT EXISTS (SELECT FROM public.identity_privacy_erasures WHERE principal_id = $2)
    AND NOT EXISTS (SELECT FROM public.platform_human_principals WHERE principal_id = $2) AS absent`, [contactId, principalId]);
  if (scope?.absent !== true) unavailableOccurrenceScope();
}

/** Reference-owned veto: identity never queries subscriptions or cancels them. */
export function createSubscriptionsPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  return {
    id: "subscriptions", version: "subscriptions.privacy-veto.v1", ownedResources: ["subscriptions.lifecycle", retention.resource],
    async prepareErasure(db) { await db.query("LOCK TABLE public.subscriptions IN SHARE MODE"); },
    async export(db, subject) {
      const { parents, occurrences: renewalOccurrences } = await readOccurrences(db, subject);
      return { contributorId: "subscriptions", version: "subscriptions.privacy-veto.v1",
        data: parents,
        ...(renewalOccurrences.length ? { renewalOccurrences } : {}),
        coverage: { complete: false, included: ["subscription IDs and statuses",
          ...(renewalOccurrences.length ? ["renewal occurrence evidence"] : [])], unavailable: ["full subscription export", "processor obligations"] },
        obligations: renewalOccurrences.length ? [...obligations, retention] : obligations };
    },
    async assessErasure(db, subject) {
      const { occurrences } = await readOccurrences(db, subject, "erase");
      return { obligations: occurrences.length ? [...obligations, retention] : obligations };
    },
    async eraseOrRetain(_db, _subject, assessment) { return { contributorId: "subscriptions", version: "subscriptions.privacy-veto.v1", obligations: assessment.obligations }; },
  };
}
