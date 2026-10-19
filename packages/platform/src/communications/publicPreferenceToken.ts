import type { CommunicationPurposeRegistry, CommunicationPurposeDefinition } from "./contracts/consent.js";
import type { CommunicationPreferenceTokenPayload } from "./preferencesToken.js";

export interface PublicPreferenceTokenSupabaseClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error?: unknown }>;
}

export type PublicPreferenceState = "denied" | "suppressed";

export function createSupabasePublicPreferenceTokenPort(
  client: PublicPreferenceTokenSupabaseClient,
) {
  return {
    async updatePreference(payload: CommunicationPreferenceTokenPayload, state: PublicPreferenceState) {
      const contact = await client.rpc("communication_touch_contact", {
        p_email: payload.email,
        p_first_name: null,
        p_last_name: null,
        p_status: "active",
        p_metadata: { source: "public_communication_preferences" },
      });
      if (contact.error || typeof contact.data !== "string") {
        throw new Error("Communication contact write failed");
      }

      const event = await client.rpc("communication_record_permission_event", {
        p_contact_id: contact.data,
        p_purpose: payload.purpose,
        p_state: state,
        p_source: "public_communication_preferences",
        p_source_ref: { route: "/api/bff/communications/preferences", purpose: payload.purpose },
        p_reason: "user_preference_update",
        p_metadata: {
          actorType: "contact_self_service",
          captureMethod: "preference_token",
        },
        p_captured_at: new Date().toISOString(),
        p_create_sync_event: payload.purpose !== "tester_program",
      });
      if (event.error) throw new Error("Communication preference write failed");

      return {
        updated: true,
        email: payload.email,
        // Keep the legacy adapter declaration expanded when the token default names a type alias.
        purpose: payload.purpose as "marketing_launch_offer" | "marketing_newsletter" | "tester_program",
        state,
      };
    },
  };
}

/** The host owns persistence and any synchronization policy for registered purposes. */
export function createRegisteredPublicPreferenceTokenPort<Purpose extends string>(input: {
  registry: CommunicationPurposeRegistry<Purpose>;
  persist: (payload: CommunicationPreferenceTokenPayload<Purpose>, state: PublicPreferenceState,
    definition: CommunicationPurposeDefinition<Purpose>) => Promise<unknown>;
}) {
  const { registry, persist } = input;
  return {
    async updatePreference(payload: CommunicationPreferenceTokenPayload<Purpose>, state: PublicPreferenceState) {
      if (!registry.has(payload.purpose)) throw new Error("unregistered_communication_purpose");
      if (state !== "denied" && state !== "suppressed") throw new Error("communication_preference_state_invalid");
      const definition = registry.purposes.find(item => item.id === payload.purpose)!;
      return persist(payload, state, definition);
    },
  };
}
