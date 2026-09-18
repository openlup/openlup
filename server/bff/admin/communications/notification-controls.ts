import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess } from "../../../_lib/bff/response.js";
import {
  authorizeAdminBooleanWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAuthEnv,
} from "../../../_lib/admin-domain/auth.js";
import {
  createSupabaseCommunicationsActorGateway,
  type SupabaseCommunicationsActorGateway,
} from "../../../adapters/supabase/communicationsGateway.js";
import { EMAIL_NOTIFICATION_CONTROL_FAMILY_KEYS } from "../../../shared/emailNotificationControlKeys.js";
import { EMAIL_CANON_STATIC_NOTIFICATION_CONTROL_SLUGS } from "../../../../src/domains/communications/emailCanon.js";

// Admin read/write for comms_notification_controls — the per-slug/family
// operational on/off for openlup-controlled outbound emails surfaced in the
// admin templates page. GET lists the controls; POST { slug, enabled } sets one.
// Auth + RLS mirror the email-template active toggle (admin user JWT).

export const STATIC_NOTIFICATION_CONTROL_SLUGS = new Set(EMAIL_CANON_STATIC_NOTIFICATION_CONTROL_SLUGS);

function isKnownNotificationControlSlug(slug: string): boolean {
  return STATIC_NOTIFICATION_CONTROL_SLUGS.has(slug) ||
    (EMAIL_NOTIFICATION_CONTROL_FAMILY_KEYS as readonly string[]).includes(slug);
}

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseAdminAuthEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const client = createAdminAuthClient(env, accessToken);

  const isAdmin = await authorizeAdminBooleanWithUser(client, accessToken, { allowedRoles: ["admin"] });
  if (!isAdmin) {
    sendBffError(res, "FORBIDDEN", "Admin access required");
    return;
  }

  const port = createSupabaseCommunicationsActorGateway(client).notificationControlsPort();
  if (req.method === "GET") {
    await handleList(port, res);
    return;
  }
  if (req.method === "POST") {
    await handleSet(port, req, res);
    return;
  }
  sendBffError(res, "BAD_REQUEST", "Unsupported method");
}

async function handleList(
  port: ReturnType<SupabaseCommunicationsActorGateway["notificationControlsPort"]>,
  res: VercelResponse,
): Promise<void> {
  try {
    sendBffSuccess(res, { controls: await port.listControls() });
  } catch (error) {
    sendBffError(res, "INTERNAL", error instanceof Error ? error.message : "Failed to read notification controls");
    return;
  }
}

async function handleSet(
  port: ReturnType<SupabaseCommunicationsActorGateway["notificationControlsPort"]>,
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const body = (typeof req.body === "string" ? safeParse(req.body) : req.body) as
    | { slug?: unknown; enabled?: unknown }
    | null;
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const enabled = body?.enabled;
  if (!slug || slug.length > 120 || typeof enabled !== "boolean") {
    sendBffError(res, "BAD_REQUEST", "slug (string) and enabled (boolean) are required");
    return;
  }
  if (!isKnownNotificationControlSlug(slug)) {
    sendBffError(res, "BAD_REQUEST", "Unknown email notification slug");
    return;
  }

  try {
    sendBffSuccess(res, await port.setControl(slug, enabled));
  } catch (error) {
    sendBffError(res, "INTERNAL", error instanceof Error ? error.message : "Failed to update notification control");
    return;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default withObservedRoute({
  route: "/api/bff/admin/communications/notification-controls",
  domain: "communications",
  surface: "admin",
  risk: "mutation",
}, handler);
