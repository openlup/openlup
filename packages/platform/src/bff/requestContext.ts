// Observed request context.
//
// One context per request, created on first use and shared by everything that observes the same
// request or its response. The deployment decides how a request reference is chosen (for example,
// a host-assigned request ID or a generated one); the context only keeps the answer stable.

import type { HttpRequest, HttpResponse } from "../http/index.js";

export interface ObservedRequestContext {
  readonly requestId: string;
}

export interface RequestContextOptions {
  /** Chooses this request's reference. Called once per request. */
  readRequestId: (req: HttpRequest) => string;
}

export interface RequestContextStore {
  /** Create (or reuse) the request's context and attach it to the response. */
  install(req: HttpRequest, res: HttpResponse): ObservedRequestContext;
  /** The request's context, created on first use. */
  readOrCreate(req: HttpRequest): ObservedRequestContext;
  /** The context attached to a response by `install`, if any. */
  readResponse(res: HttpResponse): ObservedRequestContext | undefined;
}

export function createRequestContextStore(options: RequestContextOptions): RequestContextStore {
  const requestContexts = new WeakMap<HttpRequest, ObservedRequestContext>();
  const responseContexts = new WeakMap<HttpResponse, ObservedRequestContext>();

  function readOrCreate(req: HttpRequest): ObservedRequestContext {
    const existing = requestContexts.get(req);
    if (existing) return existing;
    const context = { requestId: options.readRequestId(req) };
    requestContexts.set(req, context);
    return context;
  }

  return {
    install(req, res) {
      const context = readOrCreate(req);
      responseContexts.set(res, context);
      return context;
    },
    readOrCreate,
    readResponse: (res) => responseContexts.get(res),
  };
}
