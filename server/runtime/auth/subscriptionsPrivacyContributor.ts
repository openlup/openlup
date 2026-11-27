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

async function readOccurrences(db: PgQueryExecutor, subject: Pick<ResolvedPrivacySubject, "contactId" | "principalId">, missing = false) {
  const unavailable = () => { throw new Error("renewal_occurrence_privacy_unavailable"); };
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
      p.proowner = c.relowner AND p.prosecdef AND p.provolatile = 's' AND p.prorettype = 'jsonb'::regtype
        AND p.proconfig = ARRAY['row_security=off', 'search_path=pg_catalog, pg_temp']
        AND NOT EXISTS (SELECT FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE a.grantee <> p.proowner AND (r.rolname IS DISTINCT FROM 'service_role' OR a.is_grantable)) AS safe
      FROM (VALUES (1)) AS lane(id)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid)')
      LEFT JOIN pg_class c ON c.oid = to_regclass('public.subscription_cycle_occurrences')`)).rows[0];
    if (pairing?.isolation !== "read committed") unavailable();
    if (pairing?.helper === false && pairing.carrier === false && pairing.registered === false
      && pairing.occurrence_catalogue === false && pairing.incumbent_catalogue === true) return [];
    if (pairing?.safe !== true || pairing.registered !== true) unavailable();
    // One snapshot compares the owner's evidence with the original executor's visibility.
    const { rows: [visible] } = await db.query(`SELECT
      public.subscriptions__read_renewal_occurrences_for_privacy($1, $2) AS evidence,
      ($1::uuid IS NULL OR EXISTS (SELECT FROM public.clients WHERE id = $1)) AS contact,
      ($1::uuid IS NOT NULL OR EXISTS (SELECT FROM public.platform_human_principals WHERE principal_id = $2)) AS principal,
      EXISTS (SELECT FROM public.identity_privacy_erasures WHERE client_id = $1 OR principal_id = $2) AS receipt,
      ARRAY(SELECT id FROM public.subscriptions WHERE client_id = $1) AS parents,
      (SELECT count(*)::text FROM public.subscription_cycle_occurrences WHERE client_id = $1) AS count`,
    [subject.contactId, subject.principalId]);
    const evidence = visible?.evidence as { occurrences?: unknown; hasReceipt?: unknown; parentCount?: unknown; missing?: unknown } | null;
    if (missing && evidence?.missing === true && Object.keys(evidence).length === 1) return [];
    if (missing || !visible || !evidence || typeof evidence !== "object" || Object.keys(evidence).length !== 3
      || typeof evidence.hasReceipt !== "boolean" || evidence.hasReceipt !== visible.receipt
      || visible.contact !== true || visible.principal !== true || !Array.isArray(visible.parents)) return unavailable();
    const occurrences = renewalOccurrencePrivacyEvidenceSchema.parse(evidence.occurrences);
    const parents = new Set(visible.parents);
    if (evidence.parentCount !== String(parents.size) || visible.count !== String(occurrences.length)
      || occurrences.some(row => !parents.has(row.subscriptionId))) unavailable();
    return occurrences;
  } catch (cause) {
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
  if (scope?.absent !== true) await readOccurrences(db, { contactId, principalId }, true);
}

/** Reference-owned veto: identity never queries subscriptions or cancels them. */
export function createSubscriptionsPrivacyContributor(): PersonalDataContributor<PgQueryExecutor> {
  return {
    id: "subscriptions", version: "subscriptions.privacy-veto.v1", ownedResources: ["subscriptions.lifecycle", retention.resource],
    async prepareErasure(db) { await db.query("LOCK TABLE public.subscriptions IN SHARE MODE"); },
    async export(db, subject) {
      const rows = subject.contactId ? (await db.query("SELECT id, status FROM public.subscriptions WHERE client_id = $1 ORDER BY id", [subject.contactId])).rows : [];
      const renewalOccurrences = await readOccurrences(db, subject);
      return { contributorId: "subscriptions", version: "subscriptions.privacy-veto.v1",
        data: rows.map(row => ({ id: String(row.id), status: String(row.status) })),
        ...(renewalOccurrences.length ? { renewalOccurrences } : {}),
        coverage: { complete: false, included: ["subscription IDs and statuses",
          ...(renewalOccurrences.length ? ["renewal occurrence evidence"] : [])], unavailable: ["full subscription export", "processor obligations"] },
        obligations: renewalOccurrences.length ? [...obligations, retention] : obligations };
    },
    async assessErasure(db, subject) {
      if (subject.contactId) {
        const rows = (await db.query("SELECT status FROM public.subscriptions WHERE client_id = $1", [subject.contactId])).rows;
        if (rows.some(row => row.status === "active")) throw new PrivacyRefusal("PRIVACY_ACTIVE_SUBSCRIPTION");
        if (rows.some(row => row.status === "paused")) throw new PrivacyRefusal("PRIVACY_RESUMABLE_SUBSCRIPTION");
        if (rows.some(row => row.status !== "cancelled")) throw new PrivacyRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE");
      }
      return { obligations: (await readOccurrences(db, subject)).length ? [...obligations, retention] : obligations };
    },
    async eraseOrRetain(_db, _subject, assessment) { return { contributorId: "subscriptions", version: "subscriptions.privacy-veto.v1", obligations: assessment.obligations }; },
  };
}
