import { createAuthSendEmailHookCandidate as createHook, type AuthSendEmailHookDeps as HookDeps } from "@openlup/platform/communications";
import { readHiddenPreviewEnabled, readObservedEnvironment } from "../../_lib/observability/environment.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
export type AuthSendEmailHookDeps = HookDeps;
export function createAuthSendEmailHookCandidate(deps: AuthSendEmailHookDeps) {
  return createHook(deps, { renderEmail, readObservedEnvironment, readHiddenPreviewEnabled });
}
