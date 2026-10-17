// Reference-application binding of the observed request context from @openlup/platform: a request
// reference is the deliberately-shaped canary the caller sent, else the host's own request ID,
// else a fresh one (see ./requestId.ts).
import type { VercelRequest, VercelResponse } from "../types/vercel.js";
import { createRequestContextStore, type ObservedRequestContext } from "@openlup/platform/bff";
import { readHostedRequestId } from "../../adapters/vercel/runtimeProvenance.js";
import { readObservedRequestId } from "./requestId.js";

export type { ObservedRequestContext } from "@openlup/platform/bff";

const store = createRequestContextStore({
  readRequestId: (req) => readObservedRequestId(req.headers ?? {}, readHostedRequestId(req.headers ?? {})),
});

export function installObservedRequestContext(
  req: VercelRequest,
  res: VercelResponse,
): ObservedRequestContext {
  return store.install(req, res);
}

export function readOrCreateObservedRequestContext(
  req: VercelRequest,
): ObservedRequestContext {
  return store.readOrCreate(req);
}

export function readObservedResponseContext(
  res: VercelResponse,
): ObservedRequestContext | undefined {
  return store.readResponse(res);
}
