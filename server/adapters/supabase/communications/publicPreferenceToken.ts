import type { CommunicationPreferenceTokenPayload } from "../../../domains/communications/preferencesToken.js";

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
        purpose: payload.purpose,
        state,
      };
    },
  };
}
