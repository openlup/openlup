// Host-neutral request and response shapes for every HTTP entrypoint.
//
// They are defined over node:http so that a handler runs unchanged on a hosted
// serverless function, the Node runtime of this package, or a test double.
// No host SDK is required to name them.

import type { IncomingMessage, ServerResponse } from "node:http";

/** A Node request decorated with the parsed query, cookies and body. */
export interface HttpRequest extends IncomingMessage {
  query: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
  body?: unknown;
  /** Cooperative cancellation owned by the portable host adapter. */
  abortSignal?: AbortSignal;
}

/** A Node response decorated with the helper methods hosted functions provide. */
export interface HttpResponse extends ServerResponse {
  status(code: number): this;
  json(body: unknown): this;
  send(body: string | Buffer | object): this;
  redirect(url: string): this;
  redirect(status: number, url: string): this;
}

/** A default-export handler shared by every physical API entrypoint. */
export type HttpHandler = (req: HttpRequest, res: HttpResponse) => Promise<unknown> | unknown;

/** A lazily loaded module exposing one default-export handler. */
export type EntrypointLoader = () => Promise<{ default: HttpHandler }>;
