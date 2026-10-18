import type { ManagedIdentityClient } from "./managedClient.js";
import { PrivacyRefusal, type PrivacyStore } from "./privacyPorts.js";
import type { PrivacyJson } from "./contracts/privacy.js";

/** Reads only committed service projections. No managed write or provider delete is composed. */
export function createManagedPrivacyStore(): PrivacyStore<ManagedIdentityClient> {
  const refuse = async (): Promise<never> => { throw new PrivacyRefusal("MANAGED_PRIVACY_ERASURE_UNAVAILABLE"); };
  return {
    erasureSupported: false, prepareErasure: refuse, authorizeErasure: refuse, eraseIdentity: refuse, saveReceipt: refuse,
    async findReceipt() { return null; },
    async resolve(client, ref) {
      const query = client.from("clients").select("id, email, auth_user_id, first_name, last_name, phone");
      const { data: contact, error } = await query.eq(ref.kind === "contact" ? "id" : "auth_user_id", ref.kind === "contact" ? ref.contactId : ref.principalId).maybeSingle();
      if (error) throw new PrivacyRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE");
      const principalId = ref.kind === "principal" ? ref.principalId : contact?.auth_user_id ?? null;
      let principal: PrivacyJson = null;
      let membership: PrivacyJson = null;
      if (principalId) {
        const result = await client.auth.admin.getUserById(principalId);
        if (result.error) {
          const failure = result.error as { status?: unknown; code?: unknown };
          if (!contact && (failure.status === 404 || failure.code === "user_not_found")) return null;
          throw new PrivacyRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE");
        }
        if (result.data.user) principal = { principal_id: result.data.user.id, email: result.data.user.email ?? null, email_confirmed_at: result.data.user.email_confirmed_at ?? null };
        const read = await client.from("admin_users").select("id, membership_state, role, is_machine_actor").eq("id", principalId).maybeSingle();
        if (read.error) throw new PrivacyRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE");
        membership = read.data ? JSON.parse(JSON.stringify(read.data)) as PrivacyJson : null;
      }
      if (!contact && !principal) return null;
      return { contactId: contact?.id ?? null, principalId, identity: {
        contact: contact ? JSON.parse(JSON.stringify(contact)) as PrivacyJson : null, principal, membership,
        unavailable: ["contact.country", "identity.audit-history", "identity.invitation-history", "identity.erasure-receipts"],
      } };
    },
  };
}
