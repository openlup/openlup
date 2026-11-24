import type { DestinationQueryExecutor } from "./index.js";

/** Shared lock order for the claim writer and the admission fence's order writer. */
export function destinationV2Prelock(ctx: { clientId: string; scopeRef: string; owner: object }, snapshotRef: string) {
  const { clientId, scopeRef } = ctx;
  const ownerScope = JSON.stringify(ctx);
  return async (writer: DestinationQueryExecutor): Promise<void> => {
    await writer.query("LOCK TABLE public.identity_privacy_erasures IN SHARE MODE");
    await writer.query("SELECT id FROM public.clients WHERE id = $1 FOR KEY SHARE", [clientId]);
    await writer.query("SELECT public.commerce_lock_destination_v2_selection($1, $2)", [ownerScope, scopeRef]);
    await writer.query("SELECT public.commerce_lock_destination_v2_document($1, $2, $3)", [ownerScope, scopeRef, snapshotRef]);
  };
}
