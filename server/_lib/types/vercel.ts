// Minimal shape of Vercel's req/res objects in nodejs serverless functions.
// Defined locally to avoid pulling in @vercel/node (which has unaudited transitive
// CVEs in @vercel/build-utils chain). At runtime Vercel provides these methods
// directly on the request/response objects — we just need the types here.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
  body?: unknown;
}

export interface VercelResponse extends ServerResponse {
  status(code: number): this;
  json(body: unknown): this;
  send(body: string | Buffer | object): this;
  redirect(url: string): this;
  redirect(status: number, url: string): this;
}
