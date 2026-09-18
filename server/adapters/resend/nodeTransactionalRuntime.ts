// Node-bundle fallback for the generic TransactionalRuntimePort (Platform Portability, W8).
//
// The default vercel-supabase bundle owns delivery in direct application
// composition and does not bind this port. Node bundles use this narrow
// request/response normalizer for their captured in-process action.
//
// The only Node action is `send-email`. This adapter deliberately does not carry
// queue, service-role, or provider credentials; the captured binding owns no
// provider egress.

import type { TransactionalRuntimePort } from "../../../src/domains/platform-runtime/ports.js";

/** A runtime-agnostic Fetch handler: maps a Request to a Response. */
export type EdgeFunctionHandler = (req: Request) => Promise<Response>;

/** The one complete direct action a Node bundle may invoke in-process. */
export const NODE_TRANSACTIONAL_FUNCTIONS = ["send-email"] as const;
export type NodeTransactionalFunction = (typeof NODE_TRANSACTIONAL_FUNCTIONS)[number];

export interface NodeTransactionalRuntimeOptions {
  /**
   * Resolve the in-process handler for a function name. The default resolver is
   * deliberately unbound; node-postgres supplies its captured binding at
   * composition time.
   */
  resolveHandler?: (functionName: string) => Promise<EdgeFunctionHandler | null>;
  /** Base origin for the synthesized Request URL (cosmetic; handlers ignore host). */
  baseUrl?: string;
}

function isKnownFunction(functionName: string): functionName is NodeTransactionalFunction {
  return (NODE_TRANSACTIONAL_FUNCTIONS as readonly string[]).includes(functionName);
}

function buildRequest(
  functionName: string,
  payload: unknown,
  options: NodeTransactionalRuntimeOptions,
): Request {
  const base = (options.baseUrl ?? "http://localhost").replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  return new Request(`${base}/internal/transactional/${functionName}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload ?? {}),
  });
}

/**
 * Build a Node TransactionalRuntimePort. Unknown function names resolve to a 404
 * (never a silent success), and a missing/throwing handler resolves to a 5xx —
 * so a misconfigured node-* bundle fails loudly rather than dropping mail.
 */
export function createNodeTransactionalRuntime(
  options: NodeTransactionalRuntimeOptions = {},
): TransactionalRuntimePort {
  const resolveHandler = options.resolveHandler ?? defaultResolveHandler;
  return {
    async invoke(functionName: string, payload: unknown): Promise<{ ok: boolean; status: number }> {
      if (!isKnownFunction(functionName)) {
        return { ok: false, status: 404 };
      }
      let handler: EdgeFunctionHandler | null;
      try {
        handler = await resolveHandler(functionName);
      } catch {
        return { ok: false, status: 500 };
      }
      if (!handler) {
        return { ok: false, status: 501 };
      }
      try {
        const response = await handler(buildRequest(functionName, payload, options));
        const status = response.status;
        return { ok: status >= 200 && status < 400, status };
      } catch {
        return { ok: false, status: 500 };
      }
    },
  };
}

// The default resolver is intentionally a no-op stub. node-supabase remains
// outside the B2a persistence pair and returns 501 for the sole advertised
// action; node-postgres supplies its captured binding at composition time.
async function defaultResolveHandler(_functionName: string): Promise<EdgeFunctionHandler | null> {
  return null;
}
