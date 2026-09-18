export interface CommunicationPermissionAdminReadResult {
  email: string;
  contact: unknown | null;
  permissions: unknown[];
  links: unknown[];
  events: unknown[];
}

export interface CommunicationPermissionAdminWriteRequest {
  email: string;
  purpose: string;
  state: string;
  reason: string;
  firstName: string | null;
  lastName: string | null;
  metadata: Record<string, unknown>;
}

export interface CommunicationPermissionAdminWriteResult {
  updated: true;
  contactId: string;
  event: unknown;
}

export interface CommunicationPermissionAdminSupabaseClient {
  from(table: string): CommunicationTableQuery;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error?: unknown }>;
}

type CommunicationTableQuery = {
  select: (columns: string) => {
    eq: (field: string, value: string) => CommunicationTableQueryResult;
  };
};
type CommunicationTableQueryResult = Promise<{ data?: unknown; error?: unknown }> & {
  maybeSingle: () => Promise<{ data?: unknown; error?: unknown }>;
  order: (field: string, options: { ascending: boolean }) => {
    limit: (count: number) => Promise<{ data?: unknown; error?: unknown }>;
  };
};

export function createSupabaseAdminPermissionsPort(
  client: CommunicationPermissionAdminSupabaseClient,
) {
  return {
    async readByEmail(email: string): Promise<CommunicationPermissionAdminReadResult> {
      const { data: contact, error: contactError } = await table(client, "communication_contacts")
        .select("id,created_at,updated_at,normalized_email,display_email,first_name,last_name,status,metadata")
        .eq("normalized_email", email)
        .maybeSingle();
      if (contactError) throw new Error("Communication contact read failed");

      if (!contact) {
        return { email, contact: null, permissions: [], links: [], events: [] };
      }

      const contactId = (contact as { id: string }).id;
      const [permissions, links, events] = await Promise.all([
        table(client, "communication_permissions")
          .select("purpose,state,source,source_ref,reason,captured_at,metadata,updated_at")
          .eq("contact_id", contactId),
        table(client, "communication_contact_links")
          .select("source_system,source_table,source_id,source_key,metadata,created_at")
          .eq("contact_id", contactId),
        table(client, "communication_permission_events")
          .select("purpose,state,source,source_ref,reason,captured_at,metadata,created_at")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

      if (permissions.error || links.error || events.error) {
        throw new Error("Communication permission read failed");
      }

      return {
        email,
        contact,
        permissions: Array.isArray(permissions.data) ? permissions.data : [],
        links: Array.isArray(links.data) ? links.data : [],
        events: Array.isArray(events.data) ? events.data : [],
      };
    },

    async writePermission(request: CommunicationPermissionAdminWriteRequest): Promise<CommunicationPermissionAdminWriteResult> {
      const contact = await client.rpc("communication_touch_contact", {
        p_email: request.email,
        p_first_name: request.firstName,
        p_last_name: request.lastName,
        p_status: "active",
        p_metadata: { source: "admin_bff_permissions" },
      });
      if (contact.error || typeof contact.data !== "string") {
        throw new Error("Communication contact write failed");
      }

      const event = await client.rpc("communication_record_permission_event", {
        p_contact_id: contact.data,
        p_purpose: request.purpose,
        p_state: request.state,
        p_source: "admin_bff_permissions",
        p_source_ref: {
          route: "/api/bff/admin/communications/permissions",
          email: request.email,
        },
        p_reason: request.reason,
        p_metadata: {
          ...request.metadata,
          actorType: "admin_override",
          captureMethod: "admin_bff",
        },
        p_captured_at: new Date().toISOString(),
        p_create_sync_event: true,
      });
      if (event.error) throw new Error("Communication permission write failed");

      return {
        updated: true,
        contactId: contact.data,
        event: event.data,
      };
    },
  };
}

function table(
  client: CommunicationPermissionAdminSupabaseClient,
  name: string,
): CommunicationTableQuery {
  return client.from(name);
}
