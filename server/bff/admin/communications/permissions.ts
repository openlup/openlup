import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError } from "../../../_lib/bff/response.js";
import {
  createAdminAuthClient,
  authorizeAdminBooleanWithUser,
  readBearerToken,
} from "../../../_lib/admin-domain/auth.js";
import {
  createSupabaseAdminCommunicationsGateway,
  type SupabaseAdminCommunicationsGateway,
} from "../../../adapters/supabase/communicationsGateway.js";
import {
  COMMUNICATION_PERMISSION_STATES,
  COMMUNICATION_PURPOSES,
  type CommunicationPermissionState,
  type CommunicationPurpose,
} from "../../../../src/domains/communications/types.js";

const PURPOSES = new Set<string>(COMMUNICATION_PURPOSES);
const STATES = new Set<string>(COMMUNICATION_PERMISSION_STATES);

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const env = readSupabaseEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return;
  }

  const accessToken = readBearerToken(req);
  const authClient = createAdminAuthClient(env, accessToken);

  try {
    const authorized = await authorizeAdmin(authClient, accessToken);
    if (!authorized) {
      sendBffError(res, accessToken ? "FORBIDDEN" : "UNAUTHORIZED", "Admin access required");
      return;
    }
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return;
  }

  const permissionsPort = createSupabaseAdminCommunicationsGateway(env).permissionsPort();

  if (req.method === "GET") {
    await handleRead(req, res, permissionsPort);
    return;
  }

  if (req.method === "PATCH") {
    await handlePatch(req, res, permissionsPort);
    return;
  }

  res.setHeader("Allow", "GET, PATCH");
  sendBffError(res, "METHOD_NOT_ALLOWED", "Method not allowed");
}

async function handleRead(
  req: VercelRequest,
  res: VercelResponse,
  permissionsPort: ReturnType<SupabaseAdminCommunicationsGateway["permissionsPort"]>,
) {
  const email = normalizeEmail(first(req.query.email));
  if (!email) {
    sendBffError(res, "BAD_REQUEST", "email query parameter is required");
    return;
  }

  try {
    const result = await permissionsPort.readByEmail(email);
    res.status(200).json({ ok: true, data: result });
  } catch (error) {
    sendBffError(
      res,
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error ? error.message : "Communication contact read failed",
    );
  }
}

async function handlePatch(
  req: VercelRequest,
  res: VercelResponse,
  permissionsPort: ReturnType<SupabaseAdminCommunicationsGateway["permissionsPort"]>,
) {
  const body = isRecord(req.body) ? req.body : {};
  const email = normalizeEmail(readString(body.email));
  const purpose = readString(body.purpose) as CommunicationPurpose | null;
  const state = readString(body.state) as CommunicationPermissionState | null;
  const reason = readString(body.reason);
  if (!email || !purpose || !PURPOSES.has(purpose) || !state || !STATES.has(state)) {
    sendBffError(res, "BAD_REQUEST", "email, purpose and state are required");
    return;
  }
  if (!reason || reason.length < 3) {
    sendBffError(res, "BAD_REQUEST", "reason is required for admin consent overrides");
    return;
  }

  try {
    const result = await permissionsPort.writePermission({
      email,
      purpose,
      state,
      reason,
      firstName: readString(body.firstName),
      lastName: readString(body.lastName),
      metadata: isRecord(body.metadata) ? body.metadata : {},
    });
    res.status(200).json({ ok: true, data: result });
  } catch (error) {
    sendBffError(
      res,
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error ? error.message : "Communication contact write failed",
    );
  }
}

async function authorizeAdmin(
  client: Parameters<typeof authorizeAdminBooleanWithUser>[0],
  accessToken: string | null,
): Promise<boolean> {
  return authorizeAdminBooleanWithUser(client, accessToken, { allowedRoles: ["admin"] });
}

function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email && email.includes("@") ? email : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  return url && anonKey && serviceRoleKey ? { url, anonKey, serviceRoleKey } : null;
}

export default withObservedRoute({
  route: "/api/bff/admin/communications/permissions",
  domain: "communications",
  surface: "admin",
  risk: "mutation",
}, handler);
