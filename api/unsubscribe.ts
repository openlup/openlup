import { readProcessEnvironment } from "../server/_lib/observability/runtimeProvenance.js";
/**
 * Public one-click unsubscribe, served by the application runtime.
 *
 * This is the only unsubscribe implementation. It began as a faithful port of
 * the `unsubscribe` Edge function — the same two request shapes (a signed
 * marketing token, and the legacy tester `id`+`email` link), the same
 * `communication_apply_unsubscribe` RPC contract with the same durability
 * preconditions, and the original rendered copy — and that Edge function was retired
 * in source on 2026-08-30 with no redirect shim.
 *
 * Which host a delivered link points at is a per-environment configuration fact
 * (`UNSUBSCRIBE_FUNCTIONS_BASE_URL`), not a property of this file. Links minted
 * before that value named an application origin still address the Supabase host
 * and stop working once its bundle is undeployed — a measured, owner-accepted
 * cost, mitigated by the account-settings and contact opt-out channels.
 *
 * Tokens minted from now on carry a signed 548-day `exp`; older tokens carry
 * none and stay verifiable, so this route must keep accepting both.
 *
 * M04 B2 delegates only localized display and escaping to neutral content.
 *
 * Privacy: the token rides in the query string, so the response suppresses the
 * referrer and forbids caching; the structured log records the outcome only,
 * never the address or the token.
 */
import type { VercelRequest, VercelResponse } from "../server/_lib/types/vercel.js";
import { resolveCommunicationPreferenceBinding } from "../server/runtime/communications/preferenceBinding.js";
import { createServiceRoleClient } from "../server/_lib/admin-domain/auth.js";
import { verifyUnsubscribeToken } from "../src/domains/communications/unsubscribeToken.js";
import type { CommunicationPurpose } from "../src/domains/communications/types.js";
import { emailPresentation } from "#email-presentation";
import type { Locale } from "@openlup/platform/communications/contracts";
import { renderOptOutPage, renderReferenceOptOut } from "../src/domains/communications/email/referenceContentBinding.js";

/** Purposes a recipient may switch off through an unsubscribe link. */
const UNSUBSCRIBE_PURPOSES = new Set<CommunicationPurpose>([
  "tester_program",
  "marketing_launch_offer",
  "marketing_newsletter",
]);

export function htmlPage(title: string, message: string, locale: Locale = "pl"): string {
  return renderOptOutPage(title, message, locale);
}

export type UnsubscribeClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (field: string, value: string) => {
        eq: (field: string, value: string) => {
          maybeSingle: () => Promise<{
            data: { id: string; email: string } | null;
            error?: unknown;
          }>;
        };
      };
    };
  };
  rpc?: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error?: unknown }>;
};

export interface UnsubscribeRouteDeps {
  createClient: () => UnsubscribeClient;
  tokenSecret?: string;
}

type UnsubscribeResult = { status: "applied" | "already_suppressed" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Suppress the requested purposes and refuse to confirm anything the database
 * did not durably record. A write that did not stick must render an error, never
 * a false "you are unsubscribed".
 */
async function applyUnsubscribe(
  client: UnsubscribeClient,
  input: {
    email: string;
    purposes: CommunicationPurpose[];
    sourceTable?: "testers";
    sourceId?: string;
    metadata: Record<string, unknown>;
  },
): Promise<UnsubscribeResult> {
  if (!client.rpc) throw new Error("unsubscribe_rpc_unavailable");

  const { data, error } = await client.rpc("communication_apply_unsubscribe", {
    p_email: input.email,
    p_purposes: input.purposes,
    p_source_table: input.sourceTable ?? null,
    p_source_id: input.sourceId ?? null,
    p_metadata: input.metadata,
  });
  if (error) throw new Error("unsubscribe_rpc_failed");
  if (!isRecord(data)) throw new Error("unsubscribe_rpc_unreadable");

  const status = data.status;
  const expectedCount = input.purposes.length;
  if (
    (status !== "applied" && status !== "already_suppressed")
    || data.durablySuppressed !== true
    || data.requestedPurposeCount !== expectedCount
    || data.suppressedPurposeCount !== expectedCount
  ) {
    throw new Error("unsubscribe_rpc_unconfirmed");
  }

  return { status };
}

function singleParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

/**
 * The platform parses the query string for us, but the self-hosted runtime and
 * unit tests may hand over only `req.url`. Read whichever is populated.
 */
function readSearchParams(req: VercelRequest): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query ?? {})) {
    const single = singleParam(value);
    if (single !== null) params.set(key, single);
  }
  if (Array.from(params.keys()).length > 0) return params;
  try {
    return new URL(req.url ?? "/", "https://unsubscribe.invalid").searchParams;
  } catch {
    return params;
  }
}

function sendPage(res: VercelResponse, status: number, body: string): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // The token travels in the query string; never leak it to a third party.
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("x-email-presentation", emailPresentation.id);
  res.status(status).send(body);
}

function logOutcome(outcome: string, detail: Record<string, unknown> = {}): void {
  console.log("[unsubscribe]", JSON.stringify({ type: "unsubscribe_request", outcome, ...detail }));
}

/**
 * The route logic, with its collaborators injected so the contract can be proved
 * without a database or a configured environment.
 */
export function createUnsubscribeRouteHandler(deps: UnsubscribeRouteDeps) {
  return async function handleUnsubscribe(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).json({ error: "method not allowed" });
      return;
    }

    let lang: Locale = "pl";
    try {
      const params = readSearchParams(req);
      lang = params.get("lang") === "en" ? "en" : "pl";

      // Commerce/marketing path: a signed token carrying {email, purpose}. No
      // testers row required (commerce customers are not testers). The token is
      // HMAC-signed by us; we still refuse anything but `marketing_*` purposes.
      const token = params.get("token");
      if (token) {
        const payload = deps.tokenSecret
          ? await verifyUnsubscribeToken(token, deps.tokenSecret)
          : null;
        if (
          !payload
          || !payload.purpose.startsWith("marketing_")
          || !UNSUBSCRIBE_PURPOSES.has(payload.purpose as CommunicationPurpose)
        ) {
          logOutcome("token_rejected", { secretConfigured: Boolean(deps.tokenSecret) });
          sendPage(res, 400, renderReferenceOptOut(lang, "invalid_link"));
          return;
        }

        const result = await applyUnsubscribe(deps.createClient(), {
          email: payload.email,
          purposes: [payload.purpose as CommunicationPurpose],
          metadata: { linkPurpose: payload.purpose, channel: "token" },
        });
        logOutcome("token_applied", { rpcStatus: result.status, purpose: payload.purpose });
        sendPage(res, 200, renderReferenceOptOut(lang, "marketing_applied"));
        return;
      }

      const testerId = params.get("id");
      const email = params.get("email");
      const rawPurpose = params.get("purpose") as CommunicationPurpose | null;

      if (!testerId || !email) {
        logOutcome("missing_params");
        sendPage(res, 400, renderReferenceOptOut(lang, "missing_information"));
        return;
      }

      const client = deps.createClient();
      const { data: tester, error: testerError } = await client
        .from("testers")
        .select("id, email")
        .eq("id", testerId)
        .eq("email", email)
        .maybeSingle();

      if (testerError) throw new Error("unsubscribe_tester_lookup_failed");

      if (!tester) {
        logOutcome("tester_not_found");
        sendPage(res, 404, renderReferenceOptOut(lang, "not_found"));
        return;
      }

      const purposes = rawPurpose && UNSUBSCRIBE_PURPOSES.has(rawPurpose)
        ? [rawPurpose]
        : Array.from(UNSUBSCRIBE_PURPOSES);
      const shouldPauseLegacySequence = purposes.includes("tester_program");

      const result = await applyUnsubscribe(client, {
        email: tester.email,
        sourceTable: "testers",
        sourceId: tester.id,
        purposes,
        metadata: { linkPurpose: rawPurpose ?? "all_legacy_tester_unsubscribe" },
      });
      logOutcome("tester_applied", { rpcStatus: result.status, purposeCount: purposes.length });

      if (result.status === "already_suppressed" && shouldPauseLegacySequence) {
        sendPage(res, 200, renderReferenceOptOut(lang, "legacy_replay"));
        return;
      }

      sendPage(res, 200, renderReferenceOptOut(lang, "legacy_applied"));
    } catch (error) {
      logOutcome("error", { reason: error instanceof Error ? error.message : "unknown" });
      sendPage(res, 500, renderReferenceOptOut(lang, "error"));
    }
  };
}

function createRuntimeClient(): UnsubscribeClient {
  const env=readProcessEnvironment();
  if (env.PLATFORM_BUNDLE === "node-postgres") return resolveCommunicationPreferenceBinding(env).unsubscribeClient();
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("unsubscribe_datastore_not_configured");
  return createServiceRoleClient({ url, serviceRoleKey }) as unknown as UnsubscribeClient;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Read the environment per request rather than at module load: the secret is
  // what makes the signed-token path work at all, and a cold module captured
  // before the runtime bound it would disable every marketing opt-out silently.
  const route = createUnsubscribeRouteHandler({
    createClient: createRuntimeClient,
    tokenSecret: process.env.UNSUBSCRIBE_TOKEN_SECRET || "",
  });
  await route(req, res);
}
