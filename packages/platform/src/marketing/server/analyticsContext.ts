import { z } from "../validation.js";
import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { AnalyticsContextHandlerDeps } from "./analyticsContextPorts.js";

const requestSchema = z.object({
  granted: z.boolean(),
  gaClientId: z.string().regex(/^\d+\.\d+$/).max(64).optional(),
  explicitGrant: z.boolean().default(false),
}).strict();

export function createAnalyticsContextHandler(deps: AnalyticsContextHandlerDeps) {
  const { respond, isEnabled, resolveStore, readAccessToken, resolveTrustedSubject, capabilityCrypto, cookieName } = deps;
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!isEnabled()) return sendBffError(res, "NOT_FOUND", "Analytics context unavailable");
    // No URL, IP, contact, session, form or account data is accepted or logged.
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (!origin || origin !== `https://${req.headers.host}`) return sendBffError(res, "FORBIDDEN", "Same-origin request required");
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success || (parsed.data.granted && !parsed.data.gaClientId)) return sendBffError(res, "BAD_REQUEST", "Invalid analytics context");
    const store = resolveStore();
    if (!store) return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Analytics context unavailable");
    const data = parsed.data;
    let hash = contextHash(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined, cookieName, (value) => capabilityCrypto.hashToken(value));
    // Explicit user re-consent gets a new capability; withdrawn old bindings stay withdrawn.
    let token: string | null = null;
    if (data.granted && !hash) {
      token = capabilityCrypto.mintToken();
      hash = capabilityCrypto.hashToken(token);
    }
    if (!hash) { sendBffSuccess(res, { active: false }); return; }
    try {
      const accessToken = readAccessToken(req);
      const subject = data.granted && accessToken ? await resolveTrustedSubject(accessToken) : null;
      if (accessToken && data.granted && !subject) return sendBffError(res, "UNAUTHORIZED", "Customer session required");
      let active = await store.syncContext({ tokenHash: hash, granted: data.granted, clientId: data.gaClientId ?? null });
      if (active !== true && data.granted && data.explicitGrant && !token) {
        token = capabilityCrypto.mintToken();
        hash = capabilityCrypto.hashToken(token);
        active = await store.syncContext({ tokenHash: hash, granted: true, clientId: data.gaClientId! });
      }
      if (active === true && subject) await store.enrollSubscriptions({ subject, contextHash: hash });
      if (token && active === true) res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
      res.setHeader("Cache-Control", "no-store");
      sendBffSuccess(res, { active: active === true });
    } catch { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Analytics context unavailable"); }
  };
}

function contextHash(cookie: string | undefined, cookieName: string, hashToken: (token: string) => string): string | null {
  const token = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.split("=")[1];
  return token && /^[a-f0-9]{64}$/.test(token) ? hashToken(token) : null;
}
