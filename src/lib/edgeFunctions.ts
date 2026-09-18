/**
 * Browser-facing Supabase Edge Function registry.
 *
 * It is empty, and there is nothing left for it to name: `supabase/functions/`
 * was deleted on 2026-09-04 and both hosted projects read back empty. The
 * explicit annotation keeps the registry typed while it has no members - an
 * `as const` empty object makes `Object.values` return `unknown[]` - so the
 * guard in `backendContracts.test.ts` still refuses a name added back here,
 * which is now the point: it is the seam a reintroduced Edge call would come
 * through.
 */
export const EDGE_FUNCTIONS: Readonly<Record<string, string>> = {};

export type EdgeFunctionName = (typeof EDGE_FUNCTIONS)[keyof typeof EDGE_FUNCTIONS];
