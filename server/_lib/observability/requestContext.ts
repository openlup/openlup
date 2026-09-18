import type { VercelRequest, VercelResponse } from "../types/vercel.js";
import { readHostedRequestId } from "../../adapters/vercel/runtimeProvenance.js";
import { readObservedRequestId } from "./requestId.js";

export interface ObservedRequestContext {
  readonly requestId: string;
}

const requestContexts = new WeakMap<VercelRequest, ObservedRequestContext>();
const responseContexts = new WeakMap<VercelResponse, ObservedRequestContext>();

export function installObservedRequestContext(
  req: VercelRequest,
  res: VercelResponse,
): ObservedRequestContext {
  const context = readOrCreateObservedRequestContext(req);
  responseContexts.set(res, context);
  return context;
}

export function readOrCreateObservedRequestContext(
  req: VercelRequest,
): ObservedRequestContext {
  const existing = requestContexts.get(req);
  if (existing) return existing;

  const context = {
    requestId: readObservedRequestId(req.headers ?? {}, readHostedRequestId(req.headers ?? {})),
  };
  requestContexts.set(req, context);
  return context;
}

export function readObservedResponseContext(
  res: VercelResponse,
): ObservedRequestContext | undefined {
  return responseContexts.get(res);
}
