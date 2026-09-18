import type { createClient } from "@supabase/supabase-js";

import type {
  AdminPipelineEmailEvent,
  AdminPipelineEmailTemplate,
  AdminPipelineTester,
} from "../../../../src/domains/platform/contracts.js";
import type { AdminPipelinePort } from "../../../../src/domains/platform/ports.js";
import type { Database } from "../../../../src/integrations/supabase/types.js";

type SupabaseClient = ReturnType<typeof createClient<Database>>;

export function createSupabaseAdminPipelinePort(
  client: SupabaseClient,
): Pick<AdminPipelinePort, "readPipeline"> {
  return {
    async readPipeline() {
      const [testers, templates, emailSends, emailEvents] = await Promise.all([
        client
          .from("testers")
          .select("id, status, email_sequence_step, email_sequence_paused"),
        client
          .from("email_templates")
          .select("id, name, sequence_order")
          .not("sequence_order", "is", null)
          .order("sequence_order", { ascending: true }),
        client
          .from("email_sends")
          .select("*", { count: "exact", head: true }),
        client
          .from("email_events")
          .select("event_type"),
      ]);

      if (testers.error) throw testers.error;
      if (templates.error) throw templates.error;
      if (emailSends.error) throw emailSends.error;
      if (emailEvents.error) throw emailEvents.error;

      return {
        testers: (testers.data ?? []) as unknown as AdminPipelineTester[],
        templates: (templates.data ?? []) as unknown as AdminPipelineEmailTemplate[],
        emailSendCount: emailSends.count ?? 0,
        emailEvents: (emailEvents.data ?? []) as unknown as AdminPipelineEmailEvent[],
      };
    },
  };
}
