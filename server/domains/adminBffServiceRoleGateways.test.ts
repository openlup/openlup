import { describe, expect, it, vi } from "vitest";
import { createSupabaseAdminAccountingGateway } from "../adapters/supabase/adminAccountingGateway.js";
import { createClientsAgentReadGovernance } from "../adapters/supabase/clients/agentReadGovernance.js";
import { createSupabaseAdminReturnsGateway } from "../adapters/supabase/adminReturnsGateway.js";
import {
  createSupabaseAdminCommunicationsGateway,
  createSupabaseCommunicationsActorGateway,
} from "../adapters/supabase/communicationsGateway.js";
import { createSupabasePublicCommunicationPreferencesGateway } from "../adapters/supabase/communications/gateway.js";
import { createManagedAdminInventoryGateway } from "../adapters/managed/inventory/adminInventoryGateway.js";
import { createSupabaseAdminRiskGateway } from "../adapters/supabase/adminRiskGateway.js";

const env = { url: "https://example.supabase.co", serviceRoleKey: "service-role" };

describe("admin BFF service-role gateway factories", () => {
  it("memoizes service-role clients behind non-commerce domain gateways", () => {
    const client = fakeSupabaseClient();
    const clientFactory = vi.fn(() => client);

    createSupabaseAdminAccountingGateway(env, { clientFactory }).controlPort();
    createManagedAdminInventoryGateway(env, { clientFactory }).readPort();
    createSupabaseAdminReturnsGateway(env, { clientFactory }).returnsPort();
    createSupabaseAdminRiskGateway(env, { clientFactory }).writePort();

    expect(clientFactory).toHaveBeenCalledTimes(4);
    expect(clientFactory).toHaveBeenNthCalledWith(1, env);
  });

  it("keeps communications service-role ports behind one lazy gateway client", () => {
    const client = fakeSupabaseClient();
    const clientFactory = vi.fn(() => client);
    const gateway = createSupabaseAdminCommunicationsGateway(env, { clientFactory });

    expect(gateway.emailSendsReadPort().getAdminEmailSends).toBeTypeOf("function");
    expect(gateway.permissionsPort().readByEmail).toBeTypeOf("function");
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });

  it("builds public communications preferences through its gateway", () => {
    const client = fakeSupabaseClient();
    const clientFactory = vi.fn(() => client);
    const gateway = createSupabasePublicCommunicationPreferencesGateway(env, { clientFactory });

    expect(gateway.preferenceTokenPort().updatePreference).toBeTypeOf("function");
    expect(gateway.preferenceTokenPort()).toBe(gateway.preferenceTokenPort());
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });

  it("keeps actor-scoped communications ports on caller-provided actor clients", () => {
    const actorGateway = createSupabaseCommunicationsActorGateway(fakeSupabaseClient());

    expect(actorGateway.activeTemplatesReadPort().getActiveEmailTemplates).toBeTypeOf("function");
    expect(actorGateway.notificationControlsPort().listControls).toBeTypeOf("function");
    expect(actorGateway.notificationRecipientsPort().listNotificationRecipients).toBeTypeOf("function");
    expect(actorGateway.templatesPort().getAdminEmailTemplates).toBeTypeOf("function");
    expect(actorGateway.testerDetailReadPort().getTesterEmailSends).toBeTypeOf("function");
  });

  it("uses service-role audit client and current feature flag for clients governance", () => {
    const previousFlag = process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED;
    process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED = "true";
    try {
      const client = fakeSupabaseClient();
      const clientFactory = vi.fn(() => client);
      const governance = createClientsAgentReadGovernance(env, { clientFactory });

      expect(governance.flagEnabled).toBe(true);
      expect(governance.auditClient).toBe(client);
      expect(clientFactory).toHaveBeenCalledWith(env);
    } finally {
      process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED = previousFlag;
    }
  });
});

function fakeSupabaseClient() {
  return {
    from: vi.fn(() => fakeQueryBuilder()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

function fakeQueryBuilder() {
  const builder = {
    delete: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    order: vi.fn(() => builder),
    select: vi.fn(() => builder),
    single: vi.fn(async () => ({ data: null, error: null })),
    update: vi.fn(() => builder),
    upsert: vi.fn(() => builder),
  };
  return builder;
}
