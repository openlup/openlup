// Platform-neutral HTTP request/response types (Platform Portability, W1).
//
// Aliases over the existing local Vercel shapes in ./vercel.ts (which are already defined over
// node:http, deliberately WITHOUT @vercel/node). This lets runtime code and host adapters depend on
// a host-agnostic name (HttpRequest/HttpResponse) without renaming vercel.ts or churning the 53
// handlers that import VercelRequest/VercelResponse. The types are identical — zero behavior change.

import type * as HostedHttp from "./vercel.js";

export interface HttpRequest extends HostedHttp.VercelRequest {
  /** Cooperative cancellation owned by the portable host adapter. */
  abortSignal?: AbortSignal;
}

export type HttpResponse = HostedHttp.VercelResponse;
