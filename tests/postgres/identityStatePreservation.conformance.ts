import assert from "node:assert/strict";
import type { EmailTrustPolicy } from "@openlup/platform/identity";
import { reconcileAccountForPrincipal, createSupabaseAccountLinkStore } from "@openlup/platform/identity";

/** Post-replay subscriber rows and public-catalogue fingerprint survive envelope operations. */
export async function identityStatePreservation(options: {
  sql: (source: string) => string; service: unknown;
  principal: { principalId: string; email: string | null; emailVerified: boolean };
  policy: EmailTrustPolicy;
  exercise: () => Promise<void>;
}) {
  const account = "71000000-0000-4000-8000-000000000001";
  const subscription = "71000000-0000-4000-8000-000000000002";
  const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  assert.ok(options.principal.email);
  options.sql(`INSERT INTO public.clients(id,email,auth_user_id) VALUES ('${account}',${quote(options.principal.email)},${quote(options.principal.principalId)});
    INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,region_code,timezone,status)
      VALUES ('${subscription}','${account}',30,'USD','ZZ','UTC','paused');`);
  const snapshot = () => options.sql(`SELECT jsonb_build_object(
    'client',(SELECT to_jsonb(c) FROM public.clients c WHERE id='${account}'),
    'subscription',(SELECT to_jsonb(s) FROM public.subscriptions s WHERE id='${subscription}'),
    'catalogue',(SELECT md5(coalesce(string_agg(c.relname::text || ':' || c.relkind::text, ',' ORDER BY c.relname), ''))
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'));`);
  const before = snapshot();
  await options.exercise();
  for (let i = 0; i < 2; i++) assert.deepEqual(await reconcileAccountForPrincipal(
    createSupabaseAccountLinkStore(options.service), options.principal, options.policy,
  ), { ok: true, accountId: account, created: false, linked: false });
  assert.equal(snapshot(), before, "existing subscriber rows or public-catalogue fingerprint changed");
}
