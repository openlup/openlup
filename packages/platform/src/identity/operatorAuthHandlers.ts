import { operatorChallengeRequestSchema, operatorChallengeVerificationSchema, operatorSessionSchema } from "./contracts/operatorAuth.js";
import { createMagicLinkOriginResolver } from "./authVerifyUrl.js";
import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { createOperatorSessionService } from "./operatorSession.js";
export interface OperatorAuthMessages { invalidRequest: string; forbidden: string; unauthorized: string; unavailable: string }
export function createOperatorAuthHandlers(options: IdentityResponseOptions & {
  sessions: ReturnType<typeof createOperatorSessionService>; origin: string; messages: OperatorAuthMessages;
  padResponseTime(startedAt: number, minimumMs: number): Promise<void>;
}) {
  const responder = createIdentityResponder(options);
  const origin = createMagicLinkOriginResolver([options.origin]);
  function admitted(req: HttpRequest, res: HttpResponse): boolean {
    if (req.method !== "POST") { responder.sendMethodNotAllowed(res, ["POST"]); return false; }
    const configured = origin(req);
    if (!configured) { responder.sendBffError(res, "UPSTREAM_UNAVAILABLE", options.messages.unavailable); return false; }
    const supplied = req.headers.origin;
    const contentType = req.headers["content-type"];
    if (supplied !== configured || typeof contentType !== "string" || !/^application\/json(?:;|$)/i.test(contentType)) {
      responder.sendBffError(res, "FORBIDDEN", options.messages.forbidden); return false;
    }
    return true;
  }
  return {
    async requestChallenge(req: HttpRequest, res: HttpResponse): Promise<void> {
      if (!admitted(req, res)) return;
      const parsed = operatorChallengeRequestSchema.safeParse(req.body);
      if (!parsed.success) { responder.sendBffError(res, "BAD_REQUEST", options.messages.invalidRequest); return; }
      const started = Date.now();
      try {
        await options.sessions.requestChallenge(parsed.data.email, async () => {
          await options.padResponseTime(started, 400);
          responder.sendBffSuccess(res, { accepted: true });
        });
      } catch { responder.sendBffError(res, "UPSTREAM_UNAVAILABLE", options.messages.unavailable); }
    },
    async verifyChallenge(req: HttpRequest, res: HttpResponse): Promise<void> {
      if (!admitted(req, res)) return;
      // A token-shaped refusal is authentication failure; an invalid envelope is a bad request.
      if (!req.body || typeof req.body !== "object" || Object.keys(req.body).length !== 1 || typeof (req.body as { token?: unknown }).token !== "string") {
        responder.sendBffError(res, "BAD_REQUEST", options.messages.invalidRequest); return;
      }
      const parsed = operatorChallengeVerificationSchema.safeParse(req.body);
      if (!parsed.success) { responder.sendBffError(res, "UNAUTHORIZED", options.messages.unauthorized); return; }
      try {
        const session = await options.sessions.verifyChallenge(parsed.data.token);
        if (!session) { responder.sendBffError(res, "UNAUTHORIZED", options.messages.unauthorized); return; }
        responder.sendBffSuccess(res, operatorSessionSchema.parse(session));
      } catch { responder.sendBffError(res, "UPSTREAM_UNAVAILABLE", options.messages.unavailable); }
    },
  };
}
