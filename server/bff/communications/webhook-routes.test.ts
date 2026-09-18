import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import integrationEventsHandler from "./integrations/events.js";
import noopNewsletterHandler from "./webhooks/noop-newsletter.js";

const webhookRoutes = [
  {
    path: "server/bff/communications/integrations/events.ts",
    handler: integrationEventsHandler,
    route: "/api/bff/communications/integrations/events",
  },
  {
    path: "server/bff/communications/webhooks/noop-newsletter.ts",
    handler: noopNewsletterHandler,
    route: "/api/bff/communications/webhooks/noop-newsletter",
  },
] as const;

describe("communications webhook BFF routes", () => {
  it.each(webhookRoutes)("$route loads through the observed route wrapper", (route) => {
    expect(route.handler).toBeTypeOf("function");
  });

  it.each(webhookRoutes)(
    "$route keeps service-role DB access behind the data gateway and communications port",
    (route) => {
      const source = readFileSync(join(process.cwd(), route.path), "utf8");

      expect(source).not.toContain("@supabase/supabase-js");
      expect(source).not.toMatch(/\bcreateClient(?:\s*<[^>]+>)?\s*\(/);
      expect(source).toContain("createSupabaseDataGateway");
      expect(source).toContain("readSupabaseDataGatewayEnv");
      expect(source).toContain("gateway.asService");
      expect(source).toContain("createSupabaseNewsletterWebhookPort");
      expect(source).toContain('risk: "provider"');
    },
  );
});
