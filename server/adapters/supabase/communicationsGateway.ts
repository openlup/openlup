import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import type { CommunicationAdminTesterDetailReadPort } from "../../../src/domains/communications/ports.js";
import { createSupabaseAdminPermissionsPort } from "../../adapters/supabase/communications/adminPermissions.js";
import { createSupabaseNotificationRecipientsPort } from "../../adapters/supabase/communications/notificationRecipients.js";
import { createSupabaseAdminActiveTemplatesPort } from "./adminActiveTemplatesPort.js";
import { createAdminEmailSendsReadPort } from "./adminEmailSendsPort.js";
import { createSupabaseAdminTemplatesPort } from "./adminTemplatesPort.js";
import { createSupabaseAdminTesterEmailSendsPort } from "./adminTesterEmailSendsPort.js";
import { createSupabaseNotificationControlsPort } from "./notificationControlsPort.js";

export interface SupabaseCommunicationsEnv {
  url: string;
  serviceRoleKey: string;
}

export interface SupabaseCommunicationsGatewayOptions {
  clientFactory?: (env: SupabaseCommunicationsEnv) => unknown;
}

type AdminEmailSendsClient = Parameters<typeof createAdminEmailSendsReadPort>[0];
type AdminPermissionsClient = Parameters<typeof createSupabaseAdminPermissionsPort>[0];
type AdminActiveTemplatesClient = Parameters<typeof createSupabaseAdminActiveTemplatesPort>[0];
type AdminTemplatesClient = Parameters<typeof createSupabaseAdminTemplatesPort>[0];
type AdminTesterEmailSendsClient = Parameters<typeof createSupabaseAdminTesterEmailSendsPort>[0];
type NotificationControlsClient = Parameters<typeof createSupabaseNotificationControlsPort>[0];
type NotificationRecipientsClient = Parameters<typeof createSupabaseNotificationRecipientsPort>[0];

export type SupabaseCommunicationsActorGateway = ReturnType<
  typeof createSupabaseCommunicationsActorGateway
>;
export type SupabaseAdminCommunicationsGateway = ReturnType<
  typeof createSupabaseAdminCommunicationsGateway
>;

export function createSupabaseAdminCommunicationsGateway(
  env: SupabaseCommunicationsEnv,
  options: SupabaseCommunicationsGatewayOptions = {},
) {
  let client: unknown | null = null;

  function getClient(): unknown {
    client ??= (options.clientFactory ?? createServiceRoleClient)(env);
    return client;
  }

  return {
    emailSendsReadPort: () => createAdminEmailSendsReadPort(getClient() as AdminEmailSendsClient),
    permissionsPort: () => createSupabaseAdminPermissionsPort(getClient() as AdminPermissionsClient),
  };
}

export function createSupabaseCommunicationsActorGateway(client: unknown) {
  return {
    activeTemplatesReadPort: (): CommunicationAdminTesterDetailReadPort => {
      const activeTemplatesPort = createSupabaseAdminActiveTemplatesPort(
        client as AdminActiveTemplatesClient,
      );
      return {
        getActiveEmailTemplates: activeTemplatesPort.getActiveEmailTemplates,
        async getTesterEmailSends() {
          return { sends: [] };
        },
      };
    },
    notificationControlsPort: () =>
      createSupabaseNotificationControlsPort(client as NotificationControlsClient),
    notificationRecipientsPort: () =>
      createSupabaseNotificationRecipientsPort(client as NotificationRecipientsClient),
    templatesPort: () => createSupabaseAdminTemplatesPort(client as AdminTemplatesClient),
    testerDetailReadPort: (): CommunicationAdminTesterDetailReadPort => {
      const activeTemplatesPort = createSupabaseAdminActiveTemplatesPort(
        client as AdminActiveTemplatesClient,
      );
      const testerEmailSendsPort = createSupabaseAdminTesterEmailSendsPort(
        client as AdminTesterEmailSendsClient,
      );
      return {
        getActiveEmailTemplates: activeTemplatesPort.getActiveEmailTemplates,
        getTesterEmailSends: testerEmailSendsPort.getTesterEmailSends,
      };
    },
  };
}
